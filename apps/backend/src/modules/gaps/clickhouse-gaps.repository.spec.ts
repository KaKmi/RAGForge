import { ClickHouseGapsRepository } from "./clickhouse-gaps.repository";
import type { CodeCrushClickHouseClient } from "../../platform/clickhouse/clickhouse.types";

type Captured = {
  query: string;
  query_params: Record<string, unknown>;
  clickhouse_settings?: Record<string, unknown>;
};

/**
 * 不连真 CH——这些断言钉的是**生成出来的 SQL 文本**。
 * 理由：入池谓词漏掉任意一条（`preview = 0`、游标严格元组、`confidence IS NOT NULL` 前置）
 * 都不会报错，只会静默污染问题池；只有对 SQL 本身下断言才拦得住。
 */
function makeRepo(rows: unknown[] = []): { repo: ClickHouseGapsRepository; captured: () => Captured } {
  let last: Captured | undefined;
  const fake = {
    query: async (args: Captured & { format?: string }) => {
      // EXISTS TABLE otel_traces 探测 / view 就绪查询不算候选查询，不覆盖 last。
      if (args.query.trim().startsWith("EXISTS TABLE")) {
        return { json: async () => [{ result: 1 }] };
      }
      last = {
        query: args.query,
        query_params: args.query_params ?? {},
        clickhouse_settings: args.clickhouse_settings,
      };
      return { json: async () => rows };
    },
    command: async () => undefined,
  } as unknown as CodeCrushClickHouseClient;

  return {
    repo: new ClickHouseGapsRepository(fake),
    captured: () => {
      if (!last) throw new Error("no candidate query captured");
      return last;
    },
  };
}

describe("ClickHouseGapsRepository.listPoolCandidates", () => {
  let captured: Captured;
  let flat: string;

  beforeAll(async () => {
    const { repo, captured: get } = makeRepo();
    await repo.listPoolCandidates(
      { lastTs: "2026-07-01 00:00:00.000000000", lastTraceId: "trace-a" },
      new Date("2026-07-19T00:00:00.000Z"),
      "online-v2",
      100,
    );
    captured = get();
    flat = captured.query.replace(/\s+/g, " ");
  });

  it("always filters preview traces out", () => {
    expect(captured.query).toMatch(/preview\s*=\s*0/);
  });

  it("binds judge_version rather than interpolating", () => {
    expect(captured.query).toContain("{judgeVersion:String}");
    expect(captured.query).not.toContain("online-v2");
    expect(captured.query_params.judgeVersion).toBe("online-v2");
  });

  it("uses a strict tuple cursor on (start_time, trace_id)", () => {
    expect(flat).toMatch(
      /\(\s*t\.start_time\s*,\s*t\.trace_id\s*\)\s*>\s*\(\s*\{lastTs:DateTime64\(9\)\}\s*,\s*\{lastTraceId:String\}\s*\)/,
    );
  });

  it("bounds the scan by upperBound", () => {
    expect(captured.query).toContain("t.start_time <= {upperBound:DateTime64(9)}");
  });

  it("orders by the cursor key so the cursor can advance monotonically", () => {
    expect(flat).toMatch(/ORDER BY t\.start_time\s*(ASC)?\s*,\s*t\.trace_id/);
  });

  it("uses status='fallback' for 兜底 and never references a non-existent fallback_used column", () => {
    expect(captured.query).toContain("t.status = 'fallback'");
    expect(captured.query).not.toContain("fallback_used");
  });

  it("guards confidence with IS NOT NULL before comparing it", () => {
    expect(flat).toMatch(
      /t\.confidence IS NOT NULL AND t\.confidence\s*<\s*\{confidenceMax:Float64\}/,
    );
  });

  it("binds both entry thresholds as query params", () => {
    expect(captured.query).toContain("{evalMax:Float64}");
    expect(captured.query).toContain("{confidenceMax:Float64}");
    expect(captured.query_params.evalMax).toBe(70);
  });

  /**
   * 量纲回归：常量是百分制（<60），但 `rag.quality.confidence` 落的是 0–1
   * （`deriveConfidence` = 召回分 max）。绑成 60 会让每条埋了可信度的 trace 恒命中入池，
   * 把问题池灌满——真库 39 条里 13 条有值，全在 0.20–0.94。
   */
  it("converts the percent-scale confidence threshold to the 0-1 telemetry scale", () => {
    expect(captured.query_params.confidenceMax).toBeCloseTo(0.6, 10);
  });

  it("reads the rewritten question from the existing codecrush_trace_spans view", () => {
    expect(captured.query).toContain("codecrush_trace_spans");
    expect(captured.query).toContain("attributes['rag.node.name'] = 'rewrite'");
    // 读一等属性；曾经写的是从 codecrush.io.output 解 JSON 取 rewrittenQuery，
    // 但那个属性根本没打在 rewrite 子 span 上（实测 198 条里 0 条），恒取空。
    expect(captured.query).toContain("attributes['rag.rewrite.query']");
    // 本 story 只允许给 codecrush_traces 追加一个投影列，不得新建任何视图/表。
    expect(captured.query).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?(VIEW|TABLE)/i);
  });

  it("treats an empty session_id as a first turn", () => {
    expect(captured.query).toContain("t.session_id = ''");
  });

  it("bounds the page size with a bound limit param", () => {
    expect(captured.query).toContain("LIMIT {limit:UInt32}");
    expect(captured.query_params.limit).toBe(100);
  });
});

/** peer review 抓出的三条：入池洪水、未评分被读成 0、游标精度丢失。 */
describe("LEFT JOIN 落空不得被读成 0 分（否则整条流量灌进池子）", () => {
  let cap: Captured;
  beforeAll(async () => {
    const { repo, captured } = makeRepo();
    await repo.listPoolCandidates(
      { lastTs: "2026-07-01 00:00:00.000000000", lastTraceId: "t" },
      new Date("2026-07-19T00:00:00.000Z"),
      "online-v2",
      100,
    );
    cap = captured();
  });

  it("显式开 join_use_nulls —— CH 默认 0，落空填的是类型默认值而不是 NULL", () => {
    expect(cap.clickhouse_settings).toMatchObject({ join_use_nulls: 1 });
  });

  it("eval 分支带 has-eval 守卫，没评过分的 trace 根本进不了该分支", () => {
    expect(cap.query.replace(/\s+/g, " ")).toMatch(
      /latest\.target_trace_id\s*!=\s*''\s*AND\s*least\(/,
    );
  });

  it("三个分数各自带 ifNull 哨兵 —— 只护住 faithfulness 一个是不够的", () => {
    const sql = cap.query.replace(/\s+/g, " ");
    expect(sql).toContain("ifNull(latest.faithfulness, 101)");
    expect(sql).toContain("ifNull(latest.answer_relevancy, 101)");
    expect(sql).toContain("ifNull(latest.context_precision, 101)");
  });

  it("has_eval=0 的行，三个分数映射为 null 而不是 0", async () => {
    const { repo } = makeRepo([
      {
        trace_id: "t1",
        question: "q",
        rewritten_question: null,
        start_time: "2026-07-19 10:00:00.000000000",
        session_id: "",
        is_first_turn: 1,
        confidence: null,
        is_fallback: 1,
        no_citations: 0,
        has_eval: 0,
        faithfulness: 0,
        answer_relevancy: 0,
        context_precision: 0,
      },
    ]);
    const [c] = await repo.listPoolCandidates(
      { lastTs: "2026-07-01 00:00:00.000000000", lastTraceId: "t" },
      new Date("2026-07-19T00:00:00.000Z"),
      "online-v2",
      100,
    );
    expect(c.faithfulness).toBeNull();
    expect(c.answerRelevancy).toBeNull();
    expect(c.contextPrecision).toBeNull();
  });

  /**
   * 量纲接缝的**另一端**（Task 5 补）：只换阈值不换取值是危险的半个修复。
   * 0–1 的 confidence 流进域内后，`shouldEnterPool` / `triageItem` 拿它比 60 会**恒判低**
   * ——TS 侧的入池复判形同虚设、根因分诊整体往 `missing` 偏；而 `gap_items.confidence`
   * 的 `BETWEEN 0 AND 100` CHECK 拦不住 0.3，只会静默存下一个假低分。
   */
  it("读出来的 confidence 也换回百分制（阈值与取值必须同尺）", async () => {
    const { repo } = makeRepo([
      {
        trace_id: "t1",
        question: "q",
        rewritten_question: null,
        start_time: "2026-07-19 10:00:00.000000000",
        session_id: "",
        is_first_turn: 1,
        confidence: 0.32,
        is_fallback: 0,
        no_citations: 0,
        has_eval: 0,
        faithfulness: null,
        answer_relevancy: null,
        context_precision: null,
      },
    ]);
    const [c] = await repo.listPoolCandidates(
      { lastTs: "2026-07-01 00:00:00.000000000", lastTraceId: "t" },
      new Date("2026-07-19T00:00:00.000Z"),
      "online-v2",
      100,
    );
    expect(c.confidence).toBe(32);
  });
});

describe("游标必须保住纳秒精度（否则末行每页重复、游标永不前进）", () => {
  it("cursorTs 原样透传 DateTime64(9)，startTime 才是有损的展示值", async () => {
    const raw = "2026-07-19 10:00:00.123456789";
    const { repo } = makeRepo([
      {
        trace_id: "t1",
        question: "q",
        rewritten_question: null,
        start_time: raw,
        session_id: "",
        is_first_turn: 1,
        confidence: null,
        is_fallback: 1,
        no_citations: 0,
        has_eval: 0,
        faithfulness: null,
        answer_relevancy: null,
        context_precision: null,
      },
    ]);
    const [c] = await repo.listPoolCandidates(
      { lastTs: "2026-07-01 00:00:00.000000000", lastTraceId: "t" },
      new Date("2026-07-19T00:00:00.000Z"),
      "online-v2",
      100,
    );
    expect(c.cursorTs).toBe(raw);
    expect(c.startTime).not.toBe(raw);
  });

  it("游标串原样进 query_params，中途不经 Date 转换", async () => {
    const raw = "2026-07-19 10:00:00.123456789";
    const { repo, captured } = makeRepo();
    await repo.listPoolCandidates(
      { lastTs: raw, lastTraceId: "abc" },
      new Date("2026-07-19T00:00:00.000Z"),
      "online-v2",
      100,
    );
    expect(captured().query_params.lastTs).toBe(raw);
  });
});

describe("改写后的问题读一等属性，不解 codecrush.io.output 的 JSON", () => {
  it("取 rag.rewrite.query —— io.output 根本没打在 rewrite 子 span 上", async () => {
    const { repo, captured } = makeRepo();
    await repo.listPoolCandidates(
      { lastTs: "2026-07-01 00:00:00.000000000", lastTraceId: "t" },
      new Date("2026-07-19T00:00:00.000Z"),
      "online-v2",
      100,
    );
    const sql = captured().query;
    expect(sql).toContain("attributes['rag.rewrite.query']");
    expect(sql).not.toContain("codecrush.io.output");
    // 仍然只读既有视图，不新建任何视图。
    expect(sql).toContain("codecrush_trace_spans");
  });
});
