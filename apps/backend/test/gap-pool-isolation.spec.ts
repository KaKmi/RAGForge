import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { ClickHouseEvaluationsRepository } from "../src/modules/evaluations/clickhouse-evaluations.repository";
import { EvaluationsRepository } from "../src/modules/evaluations/evaluations.repository";
import { ClickHouseGapsRepository } from "../src/modules/gaps/clickhouse-gaps.repository";
import { GAP_COLLECT_WORKER_NAME } from "../src/modules/gaps/gap.constants";
import { GapCollectorProcessor } from "../src/modules/gaps/gap-collector.processor";
import { GapsRepository } from "../src/modules/gaps/gaps.repository";
import {
  createEvaluationInfraHarness,
  E2E_EMBED_MODEL_ID,
  E2E_JUDGE_MODEL_ID,
} from "./helpers/evaluation-infra";
import { infraGate } from "./helpers/gated-suite";

/**
 * ══════════════════════════════════════════════════════════════════════════════
 *  B2a 决策 C 的守护网：**问题池是纯读侧消费者，不污染在线质量读模型**。
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * 收集器要跨两个存储读（ClickHouse 取候选、Postgres 取判官设置），写只落 `gap_*` 三张表。
 * 「只读」这件事在单测里只能靠 fake 端口的形状来保证——本文件把它放到**真 PG + 真 ClickHouse**
 * 上验证，观察的是外部可见结果而不是调用记录：
 *
 *  §1 跑一轮收集，屏1 的 `getOverview()` / `getLowSamples()` 逐字段不变，
 *     且 `otel_traces` 里 `rag.eval` 的行数不变（没有偷发评测 span）。
 *  §2 `eval_watermarks` / `eval_candidate_ledger` 两张 evaluations 域的表**一行没动**
 *     （Global Constraint 9：收集器的进度只落自己的 `gap_watermarks`）。
 *  §3 反证：这一轮**确实干了活**（池里真出现了成员），否则上面两条都是空断言。
 *
 * ⚠️ 本文件跑在 `MIGRATION_TEST_DATABASE_URL`（`codecrush_mig_test`）上，`resetAndMigrate`
 * 会 `DROP SCHEMA`。**绝不可指向开发库 `codecrush`**——见 CLAUDE.md 的数据库红线。
 */

const describeInfra = infraGate();
jest.setTimeout(180_000);

const hex32 = () => randomUUID().replaceAll("-", "");
const hex16 = () => randomUUID().replaceAll("-", "").slice(0, 16);

/** 1024 维单位向量（第 seed 维为 1），维度与 `gap_clusters.centroid` 的 DDL 一致。 */
function unitVector(seed: number): number[] {
  const v = new Array<number>(1024).fill(0);
  v[seed % 1024] = 1;
  return v;
}

describeInfra("B2a 污染回归：问题池收集绝不影响在线质量读模型", () => {
  let harness: Awaited<ReturnType<typeof createEvaluationInfraHarness>>;
  let onlineEval: ClickHouseEvaluationsRepository;
  let processor: GapCollectorProcessor;

  // 已评过分的在线样本：给屏1 的读模型当基线（低分，故也会被 getLowSamples 捞到）。
  const scoredTraceId = hex32();
  // 只有低可信度、没被评过分的在线样本：问题池要收的就是它。
  const poolTraceId = hex32();
  const at = "2026-07-16T02:00:00.000Z";
  const window = {
    from: "2026-07-16T01:00:00.000Z",
    to: "2026-07-16T03:00:00.000Z",
    judgeVersion: "online-v1",
  };
  const thresholds = { faithfulness: 85, answerRelevancy: 80, contextPrecision: 80 };

  /** 一条 chain 根 span —— `codecrush_traces` 认根只看 `codecrush.span.kind='chain'`。 */
  async function insertChainRoot(
    traceId: string,
    attributes: Record<string, string>,
  ): Promise<void> {
    await harness.insertSpan({
      traceId,
      spanId: hex16(),
      at,
      name: "rag.pipeline",
      attributes: {
        "codecrush.span.kind": "chain",
        "session.id": `sess-${traceId.slice(0, 8)}`,
        "gen_ai.agent.id": "agent-gap-isolation",
        "rag.preview": "false",
        ...attributes,
      },
    });
  }

  async function countRows(sql: string, params: Record<string, unknown> = {}): Promise<number> {
    const result = await harness.clickhouse.query({
      query: sql,
      query_params: params,
      format: "JSONEachRow",
    });
    const rows = await result.json<{ n: string | number }>();
    return Number(rows[0]?.n ?? 0);
  }

  async function pgCount(table: string): Promise<number> {
    const result = await harness.pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
    return Number(result.rows[0].n);
  }

  beforeAll(async () => {
    harness = await createEvaluationInfraHarness();
    await harness.resetAndMigrate();
    onlineEval = new ClickHouseEvaluationsRepository(harness.clickhouse as never);

    // ① 已评分的在线样本（基线，进屏1 的三指标卡与低分样本表）
    await insertChainRoot(scoredTraceId, {
      "codecrush.io.input": "退款要多久到账",
      "rag.quality.confidence": "0.9",
    });
    await harness.insertSpan({
      traceId: hex32(),
      spanId: hex16(),
      at,
      name: "rag.eval",
      attributes: {
        "rag.eval.target_trace_id": scoredTraceId,
        "rag.eval.faithfulness": "60",
        "rag.eval.answer_relevancy": "55",
        "rag.eval.context_precision": "50",
        "rag.eval.version": "online-v1",
        "rag.eval.status": "success",
        "gen_ai.agent.id": "agent-gap-isolation",
        "rag.preview": "false",
      },
    });
    // ② 问题池的目标：可信度 0.30（<60 分制阈值），没有任何 rag.eval span
    await insertChainRoot(poolTraceId, {
      "codecrush.io.input": "能开专用发票吗",
      "rag.quality.confidence": "0.30",
    });

    // 收集器要 embedding 模型 id 才肯开工（判官模型与它无关，一并塞好省得踩 FK）。
    await harness.pool.query(
      `INSERT INTO model_providers (id,type,protocol,name,base_url,api_key_enc,params,enabled) VALUES
        ($1,'llm','openai_compat','gap-judge','http://unused','enc','{}',true),
        ($2,'embedding','openai_compat','gap-embed','http://unused','enc','{}',true)
        ON CONFLICT (id) DO NOTHING`,
      [E2E_JUDGE_MODEL_ID, E2E_EMBED_MODEL_ID],
    );
    const db = drizzle(harness.pool) as never;
    const evaluations = new EvaluationsRepository(db);
    await evaluations.getSettings(); // 播种 default 行
    await harness.pool.query(
      `UPDATE online_eval_settings SET embedding_model_id=$1, judge_model_id=$2, judge_version='online-v1' WHERE id='default'`,
      [E2E_EMBED_MODEL_ID, E2E_JUDGE_MODEL_ID],
    );

    /**
     * 把游标播种到夹具时间前一刻。**不这样做本用例会随历史数据漂移**：
     * `resetAndMigrate` 只重建 Postgres，ClickHouse 跨套件共享且不重置；游标从 1970 起步 +
     * `ORDER BY start_time ASC LIMIT 200` ⇒ 一旦库里早于夹具的合格 trace 攒够 200 条，
     * 目标 trace 就挤不进第一页，反证用例假红。
     */
    await harness.pool.query(
      `INSERT INTO gap_watermarks (worker_name, last_ts, last_trace_id)
       VALUES ($1, '2026-07-16 01:00:00.000000000', '')`,
      [GAP_COLLECT_WORKER_NAME],
    );

    // 真收集器 + 真两个仓库；只桩掉队列与 embedding（唯一的外部模型调用）。
    const queue = { publish: jest.fn(), subscribe: jest.fn(), schedule: jest.fn() };
    const models = { embedTexts: async (_id: string, texts: string[]) => texts.map((_t, i) => unitVector(i + 1)) };
    processor = new GapCollectorProcessor(
      queue as never,
      new GapsRepository(db),
      new ClickHouseGapsRepository(harness.clickhouse as never),
      evaluations,
      models as never,
    );
  });

  afterAll(async () => {
    await harness.cleanup([scoredTraceId, poolTraceId]);
    await harness.close();
  });

  it("跑一轮收集，屏1 的总览与低分样本**逐字段不变**", async () => {
    const overviewBefore = await onlineEval.getOverview(window);
    const lowBefore = await onlineEval.getLowSamples(window, thresholds, 10);
    expect(overviewBefore.sampleCount).toBeGreaterThan(0); // 基线非空，否则断言无意义
    expect(lowBefore.length).toBeGreaterThan(0);

    // 上界要盖过夹具时间（收集器默认往回让 15 分钟，夹具是 2026-07-16，取 now 即可）。
    const result = await processor.processCycle(GAP_COLLECT_WORKER_NAME, new Date());
    expect(result.status).toBe("healthy");

    expect(await onlineEval.getOverview(window)).toEqual(overviewBefore);
    expect(await onlineEval.getLowSamples(window, thresholds, 10)).toEqual(lowBefore);
  });

  it("没有偷发任何 rag.eval span（问题池不是第二个评测器）", async () => {
    const evalSpans = await countRows(
      "SELECT count() AS n FROM otel_traces WHERE SpanName = 'rag.eval' AND SpanAttributes['gen_ai.agent.id'] = {agent:String}",
      { agent: "agent-gap-isolation" },
    );
    expect(evalSpans).toBe(1); // 只有夹具自己插的那一条
  });

  it("evaluations 域的水位线与账本一行未动（Global Constraint 9）", async () => {
    expect(await pgCount("eval_watermarks")).toBe(0);
    expect(await pgCount("eval_candidate_ledger")).toBe(0);
    // 进度落在自己的表里——这条同时证明上面两个 0 不是「收集器压根没跑」。
    const watermark = await harness.pool.query<{ last_trace_id: string }>(
      `SELECT last_trace_id FROM gap_watermarks WHERE worker_name = $1`,
      [GAP_COLLECT_WORKER_NAME],
    );
    expect(watermark.rows).toHaveLength(1);
    expect(watermark.rows[0].last_trace_id).not.toBe("");
  });

  /**
   * 重投 + 质心漂移 —— P1-3（空簇）的真实复现路径，在**真 PG** 上跑。
   *
   * 单测里同形的那条只打到内存 fake（fake 是与真实现同步手改的第二份实现，测的是它自己）。
   * 本条走的是 `GapsRepository.runAttachItem` 的真事务：质心被转到正交方向 ⇒ 相似度跌破阈值
   * ⇒ 重投时该 trace 改判「建新簇」⇒ 若建簇发生在探测之前，库里就会多出零成员簇。
   *
   * ⚠️ **覆盖边界，别当成全覆盖**：本条命中的是事务开头的**先探早返回**分支（一行不写）。
   * 探测与插入之间的并发缝隙那条（抛 `GapItemConflictError` → 回滚 → 外层回查赢家）
   * 需要两个事务真并发才走得到，**至今无自动化覆盖**——它是纵深防御的第二道，
   * 单进程 + 租约下不可达。改动那段代码时，请靠人工推演而不是靠本条变红。
   */
  it("重投时质心已漂移：真事务里也绝不留下 freq=0 的空簇", async () => {
    const before = await pgCount("gap_clusters");
    // 把全部簇的质心转到与本轮 embedding 正交的方向 ⇒ 相似度 0 ⇒ 重投必走「建新簇」分支。
    const orthogonal = `[${unitVector(900).join(",")}]`;
    await harness.pool.query(`UPDATE gap_clusters SET centroid = $1::vector`, [orthogonal]);
    // 游标退回夹具之前，让同一批候选被重新扫到（模拟「插入成功但游标没落库就崩了」）。
    await harness.pool.query(
      `UPDATE gap_watermarks SET last_ts = '2026-07-16 01:00:00.000000000', last_trace_id = '' WHERE worker_name = $1`,
      [GAP_COLLECT_WORKER_NAME],
    );

    const result = await processor.processCycle(GAP_COLLECT_WORKER_NAME, new Date());
    expect(result.status).toBe("healthy");
    expect(result.collected).toBe(0); // 全部撞唯一索引，一条都没新增

    expect(await pgCount("gap_clusters")).toBe(before); // 没有多出任何簇
    const empty = await harness.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM gap_clusters WHERE freq = 0`,
    );
    expect(Number(empty.rows[0].n)).toBe(0); // 更直接：一个零成员簇都没有
    const items = await harness.pool.query(`SELECT 1 FROM gap_items WHERE source_trace_id = $1`, [
      poolTraceId,
    ]);
    expect(items.rows).toHaveLength(1); // 成员没翻倍
  });

  it("反证：这一轮确实把低可信度样本收进了池子", async () => {
    // 断言**按自己的 trace id 收口**，不查全表：`otel_traces` 是跨套件共享的（PG 每个套件
    // resetAndMigrate 一次，ClickHouse 不会），本轮真实收到的是库里全部合格的历史 trace。
    // 断言「池里只有我这一条」等于要求一张共享表是空的——那是夹具假设错了，不是产品行为错了。
    const items = await harness.pool.query<{ confidence: number }>(
      `SELECT confidence FROM gap_items WHERE source_trace_id = $1`,
      [poolTraceId],
    );
    expect(items.rows).toHaveLength(1);
    // 0.30 的遥测值必须以百分制 30 落库（量纲接缝的端到端证据）。
    expect(Number(items.rows[0].confidence)).toBe(30);
    expect(await pgCount("gap_clusters")).toBeGreaterThan(0);
  });
});
