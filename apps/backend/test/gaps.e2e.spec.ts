import { randomUUID } from "node:crypto";
import type { ExecutionContext, INestApplication } from "@nestjs/common";
import { APP_GUARD, APP_PIPE } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { drizzle } from "drizzle-orm/node-postgres";
import { ZodValidationPipe } from "nestjs-zod";
import request from "supertest";
import { applyGlobalConfig } from "../src/app/app-bootstrap";
import { GapsController } from "../src/modules/gaps/gaps.controller";
import { GapsRepository } from "../src/modules/gaps/gaps.repository";
import { GapsService } from "../src/modules/gaps/gaps.service";
import { GapFillController } from "../src/modules/gaps/gap-fill.controller";
import { GapFillService } from "../src/modules/gaps/gap-fill.service";
import { createEvaluationInfraHarness, E2E_EMBED_MODEL_ID } from "./helpers/evaluation-infra";
import { infraGate } from "./helpers/gated-suite";

/**
 * 屏5 问题池的 **HTTP 全链路**守护网：controller → Zod → service → 真仓库 → 真 PG。
 *
 * 与 `test/gaps.service.db.spec.ts` 的分工：那边守**领域语义**（状态机迁移表、拆分守恒、
 * freq30d 谓词、avgQuality 的 NULL 处理）；本文件只守**HTTP 边界**——路由挂没挂上、
 * Zod 400 有没有生效、路径参数非 UUID 会不会漏成 500、写操作的响应形状对不对。
 * 两边刻意不重复：领域断言堆在 e2e 里跑得慢且定位差。
 *
 * ⛔ 只连 MIGRATION_TEST_DATABASE_URL（codecrush_mig_test）——`resetAndMigrate` 会 DROP SCHEMA。
 */

const describeInfra = infraGate();
jest.setTimeout(180_000);

const ACTOR = "e2e-gaps@codecrush.dev";
const hex32 = () => randomUUID().replaceAll("-", "");

describeInfra("B2a 屏5 问题池（HTTP e2e，真 PG）", () => {
  let app: INestApplication;
  let harness: Awaited<ReturnType<typeof createEvaluationInfraHarness>>;
  let repo: GapsRepository;
  let embedVector: number[];
  /** 按文本指定向量（只在需要区分「聚类键用了哪段文本」的用例里填）。 */
  let embedByText: Record<string, number[]>;

  beforeAll(async () => {
    harness = await createEvaluationInfraHarness();
    await harness.resetAndMigrate();
    const db = drizzle(harness.pool) as never;
    repo = new GapsRepository(db);

    const evaluations = {
      getSettings: async () => ({ embeddingModelId: E2E_EMBED_MODEL_ID, judgeVersion: "online-v1" }),
    };
    const models = {
      /**
       * 默认对所有文本返回同一个向量（多数用例只关心「归不归簇」，不关心谁和谁近）。
       *
       * `embedByText` 是给**需要区分文本**的用例开的口子：验「聚类键到底用了哪段文本」时，
       * 同向量的桩会让断言恒真——两个键都会归进同一簇，测不出区别。
       */
      embedTexts: async (_id: string, texts: string[]) =>
        texts.map((t) => embedByText[t] ?? embedVector),
    };
    const service = new GapsService(repo, evaluations as never, models as never);

    const ref = await Test.createTestingModule({
      controllers: [GapsController],
      providers: [
        { provide: GapsService, useValue: service },
        { provide: APP_PIPE, useClass: ZodValidationPipe },
        {
          provide: APP_GUARD,
          useValue: {
            canActivate: (ctx: ExecutionContext) => {
              ctx.switchToHttp().getRequest().user = { id: "u-e2e", email: ACTOR };
              return true;
            },
          },
        },
      ],
    }).compile();
    app = ref.createNestApplication();
    applyGlobalConfig(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await harness.close();
  });

  beforeEach(() => {
    embedVector = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0));
    embedByText = {};
  });

  afterEach(async () => {
    // 按本套件自己造的行清理：问题池表在本套件开头已 DROP SCHEMA 重建，
    // 这里只是让用例之间互不干扰（最近邻会跨用例把新样本归进上一个用例的簇）。
    await harness.pool.query("DELETE FROM gap_items");
    await harness.pool.query("DELETE FROM gap_clusters");
  });

  /** 走公开端点造一个簇——e2e 里不直接写 SQL，免得绕过被测的那条路径。 */
  async function createCluster(question: string, traceId = hex32()): Promise<string> {
    const res = await request(app.getHttpServer())
      .post("/api/gaps/items")
      .send({ question, source: "manual_trace", sourceTraceId: traceId })
      .expect(201);
    return res.body.clusterId as string;
  }

  it("GET /gaps 返回契约形状（含查询期聚合的 freq30d / avgQuality）", async () => {
    await createCluster("能开专用发票吗");

    const res = await request(app.getHttpServer()).get("/api/gaps").expect(200);

    expect(res.body.total).toBe(1);
    expect(res.body.items[0]).toMatchObject({
      representativeQuestion: "能开专用发票吗",
      freq: 1,
      status: "pending",
      rootCauseIsManual: false,
    });
    // 手动入池没有 trace_start_time ⇒ 不进 30 天窗口；没有分数 ⇒ avgQuality 是 null 不是 0。
    expect(res.body.items[0].freq30d).toBe(0);
    expect(res.body.items[0].avgQuality).toBeNull();
  });

  it("GET /gaps/summary 返回四个计数", async () => {
    const id = await createCluster("退款要多久");
    await request(app.getHttpServer()).post(`/api/gaps/${id}/ignore`).expect(201);

    const res = await request(app.getHttpServer()).get("/api/gaps/summary").expect(200);
    expect(res.body).toEqual({ pending: 0, routedRetrieval: 0, ignored: 1, enteredEvalSet: 0 });
  });

  it("GET /gaps/:id/items 返回簇内成员", async () => {
    const traceId = hex32();
    const id = await createCluster("能开专用发票吗", traceId);

    const res = await request(app.getHttpServer()).get(`/api/gaps/${id}/items`).expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ sourceTraceId: traceId, source: "manual_trace" });
  });

  it("POST /gaps/items 重复入同一条 trace ⇒ joinedExisting=true，不再插一行", async () => {
    const traceId = hex32();
    await createCluster("能开专用发票吗", traceId);

    const res = await request(app.getHttpServer())
      .post("/api/gaps/items")
      .send({ question: "能开专用发票吗", source: "manual_trace", sourceTraceId: traceId })
      .expect(201);

    expect(res.body.joinedExisting).toBe(true);
    expect(res.body.freq).toBe(1);
  });

  /**
   * ⛔ 手动入池必须采纳入口页透传的改写结果（2026-07-21 真环境实测抓出的连锁 bug）。
   *
   * 初版硬编码 `rewrittenQuestion: null` / `rewriteResolved: false`，注释写
   * 「手动入池不经 rewrite 节点」——那句是错的：`manual_trace` 是人从 Trace 详情挑的
   * **一条真实线上 trace**，它当然走过 rewrite 节点，结果就在 `rag.rewrite.query` 里。
   * 丢掉它 ⇒ 误标「指代未消解」⇒ 评测臂强制重复改写 + 聚类键退回原文 + 回验拿原话重放
   * ⇒ 假的「复发」标。
   */
  it("带 rewrittenQuestion ⇒ rewriteResolved 为真，且**用它做聚类键**", async () => {
    /**
     * 构造：两条原话给**互相正交**的向量（余弦 0，绝无可能归并），
     * 改写后是同一句、给第三个向量。于是——
     *  · 聚类键用原话 ⇒ 两条各自成簇（旧行为）；
     *  · 聚类键用改写后 ⇒ 两条并进同一簇（决策 F 要的行为）。
     * 若不这么造，harness 默认对所有文本返回同一个向量，两种实现都会归并，断言恒真。
     */
    const rewritten = "如何回应下属的加薪请求";
    const rawA = "他又来提那事了";
    const rawB = "这个怎么答复比较好";
    const unit = (i: number) => Array.from({ length: 1024 }, (_, k) => (k === i ? 1 : 0));
    embedByText[rawA] = unit(10);
    embedByText[rawB] = unit(20); // 与 rawA 正交
    embedByText[rewritten] = unit(30);

    const first = await request(app.getHttpServer())
      .post("/api/gaps/items")
      .send({
        question: rawA,
        source: "manual_trace",
        sourceTraceId: hex32(),
        rewrittenQuestion: rewritten,
      })
      .expect(201);

    const second = await request(app.getHttpServer())
      .post("/api/gaps/items")
      .send({
        question: rawB,
        source: "manual_trace",
        sourceTraceId: hex32(),
        rewrittenQuestion: rewritten,
      })
      .expect(201);

    // 两句**正交**的原话并进了同一个簇——只有聚类键真的用了改写结果才可能发生。
    expect(second.body.clusterId).toBe(first.body.clusterId);

    const items = await request(app.getHttpServer())
      .get(`/api/gaps/${first.body.clusterId}/items`)
      .expect(200);
    expect(items.body).toHaveLength(2);
    // 成员保留各自的**原话**（那是真实用户问的），但都标记为已消解。
    for (const item of items.body) {
      expect(item.rewriteResolved).toBe(true);
      expect(item.rewrittenQuestion).toBe(rewritten);
    }
  });

  it("不带 rewrittenQuestion ⇒ 退回保守默认（未消解），行为与从前一致", async () => {
    // 配对：只测「带了会怎样」的话，一个无条件置 true 的实现也能通过——
    // 而那会让真正未消解的样本绕过入集守卫，把永久 0 分用例放进评测集。
    const res = await request(app.getHttpServer())
      .post("/api/gaps/items")
      .send({ question: "那个呢", source: "manual_trace", sourceTraceId: hex32() })
      .expect(201);

    const items = await request(app.getHttpServer())
      .get(`/api/gaps/${res.body.clusterId}/items`)
      .expect(200);
    expect(items.body[0].rewriteResolved).toBe(false);
    expect(items.body[0].rewrittenQuestion).toBeNull();
  });

  it("状态迁移端点走通，非法迁移 400", async () => {
    const id = await createCluster("能开专用发票吗");

    await request(app.getHttpServer()).post(`/api/gaps/${id}/route-retrieval`).expect(201);
    // pending 才能 route-retrieval，已是 routed_retrieval ⇒ 第二次非法
    await request(app.getHttpServer()).post(`/api/gaps/${id}/route-retrieval`).expect(400);
    // 但 ignore 合法（V15：没有出口的状态是死态）
    const ignored = await request(app.getHttpServer()).post(`/api/gaps/${id}/ignore`).expect(201);
    expect(ignored.body.status).toBe("ignored");
  });

  it("PATCH /gaps/:id/root-cause 写人工判定并在响应里生效", async () => {
    const id = await createCluster("能开专用发票吗");

    const res = await request(app.getHttpServer())
      .patch(`/api/gaps/${id}/root-cause`)
      .send({ rootCause: "generation" })
      .expect(200);

    expect(res.body.rootCause).toBe("generation");
    expect(res.body.rootCauseIsManual).toBe(true);
  });

  it("Zod 拦下坏 body：枚举外的 rootCause / 空 itemIds / 缺字段一律 400", async () => {
    const id = await createCluster("能开专用发票吗");

    await request(app.getHttpServer())
      .patch(`/api/gaps/${id}/root-cause`)
      .send({ rootCause: "not-a-cause" })
      .expect(400);
    await request(app.getHttpServer()).post(`/api/gaps/${id}/split`).send({ itemIds: [] }).expect(400);
    await request(app.getHttpServer())
      .post("/api/gaps/items")
      .send({ question: "", source: "manual_trace", sourceTraceId: "t" })
      .expect(400);
    await request(app.getHttpServer())
      .post("/api/gaps/items")
      .send({ question: "q", source: "online", sourceTraceId: "t" }) // online 不在手动入池的枚举里
      .expect(400);
  });

  it("非 UUID 的路径参数是 400 而不是 500（不让它一路走到 SQL）", async () => {
    await request(app.getHttpServer()).get("/api/gaps/not-a-uuid/items").expect(400);
    await request(app.getHttpServer()).post("/api/gaps/not-a-uuid/ignore").expect(400);
  });

  it("不存在的簇是 404", async () => {
    await request(app.getHttpServer()).post(`/api/gaps/${randomUUID()}/ignore`).expect(404);
  });

  it("POST /gaps/:id/merge 把成员并进目标簇并软删空掉的源簇", async () => {
    const source = await createCluster("能开专用发票吗");
    // 换一个正交向量，保证第二条不会被最近邻并进同一个簇。
    embedVector = Array.from({ length: 1024 }, (_, i) => (i === 1 ? 1 : 0));
    const target = await createCluster("怎么申请退款");
    expect(target).not.toBe(source);

    const items = await request(app.getHttpServer()).get(`/api/gaps/${source}/items`).expect(200);
    const res = await request(app.getHttpServer())
      .post(`/api/gaps/${source}/merge`)
      .send({ targetClusterId: target, itemIds: items.body.map((i: { id: string }) => i.id) })
      .expect(201);

    expect(res.body).toEqual({ targetClusterId: target, sourceSoftDeleted: true });
    const listed = await request(app.getHttpServer()).get("/api/gaps").expect(200);
    expect(listed.body.items.map((i: { id: string }) => i.id)).toEqual([target]);
    expect(listed.body.items[0].freq).toBe(2);
  });
});

/**
 * B2b「补知识库」向导的 **HTTP 全链路**守护网：controller → Zod → GapFillService →
 * 真 GapsService/GapsRepository → 真 PG。
 *
 * 与 `gap-fill.service.spec.ts` 的分工：那边用假仓库守服务内部的分支逻辑；本文件守的是
 * **端到端那条路真的接通了、而且红线在真状态机上成立**——七态 CHECK 是数据库约束，
 * 只有连真 PG 才能证明「service 认为合法的迁移，数据库也认」。
 *
 * ⛔ 只连 MIGRATION_TEST_DATABASE_URL（codecrush_mig_test），`resetAndMigrate` 会 DROP SCHEMA。
 */
describeInfra("B2b 补知识库向导（HTTP e2e，真 PG）", () => {
  let app: INestApplication;
  let harness: Awaited<ReturnType<typeof createEvaluationInfraHarness>>;
  let repo: GapsRepository;
  let gaps: GapsService;
  /** 每次 upload 调用都记一笔——红线断言靠它：**不该入库时，这个数组必须是空的**。 */
  let uploads: Array<{ kbId: string; content: string }>;
  let draftReply: string | null;
  /** 草拟调用次数——`resume-fill` 的核心断言：拿回草稿**不该**再调一次模型。 */
  let draftCalls: number;

  beforeAll(async () => {
    harness = await createEvaluationInfraHarness();
    await harness.resetAndMigrate();
    const db = drizzle(harness.pool) as never;
    repo = new GapsRepository(db);

    const evaluations = {
      getSettings: async () => ({
        embeddingModelId: E2E_EMBED_MODEL_ID,
        judgeModelId: "judge-e2e",
        judgeVersion: "online-v1",
      }),
    };
    const models = {
      embedTexts: async (_id: string, texts: string[]) =>
        texts.map(() => Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0))),
      // 草拟走的是 `models.chat(...)`，返回 `{ content }`；`draftReply=null` 模拟模型不可用。
      chat: async () => {
        draftCalls += 1;
        if (draftReply === null) throw new Error("草拟模型不可用");
        return { content: draftReply };
      },
    };
    gaps = new GapsService(repo, evaluations as never, models as never);

    const documents = {
      upload: async (kbId: string, files: Array<{ buffer: Buffer }>) => {
        uploads.push({ kbId, content: files[0].buffer.toString("utf8") });
        return [{ id: randomUUID() }];
      },
    };
    const knowledgeBases = {
      findById: async (id: string) => ({ id, name: "e2e-kb", status: "ready" }),
    };

    const fill = new GapFillService(
      gaps,
      documents as never,
      knowledgeBases as never,
      evaluations as never,
      models as never,
    );

    const ref = await Test.createTestingModule({
      controllers: [GapFillController],
      providers: [
        { provide: GapFillService, useValue: fill },
        // `resume-fill` 是纯状态迁移，控制器直接走 GapsService（不经 GapFillService）。
        { provide: GapsService, useValue: gaps },
        { provide: APP_PIPE, useClass: ZodValidationPipe },
        {
          provide: APP_GUARD,
          useValue: {
            canActivate: (ctx: ExecutionContext) => {
              ctx.switchToHttp().getRequest().user = { id: "u-e2e", email: ACTOR };
              return true;
            },
          },
        },
      ],
    }).compile();
    app = ref.createNestApplication();
    applyGlobalConfig(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await harness.close();
  });

  beforeEach(() => {
    uploads = [];
    draftCalls = 0;
    draftReply = JSON.stringify({
      question: "能开增值税专用发票吗？",
      answer: "可以。请提供开票抬头与税号，（待确认）个工作日内寄出。",
    });
  });

  afterEach(async () => {
    await harness.pool.query("DELETE FROM gap_items");
    await harness.pool.query("DELETE FROM gap_clusters");
  });

  /**
   * 走 `GapsService.addItem` 造簇——本 describe 测的是向导，不是入池，
   * 但也**不直接写 SQL**：绕过真实建簇路径造出来的行，可能带着现实中不会出现的状态组合。
   */
  async function seedCluster(): Promise<string> {
    const res = await gaps.addItem({
      question: "能开专用发票吗",
      source: "manual_trace",
      sourceTraceId: hex32(),
    } as never);
    return res.clusterId;
  }

  const KB = randomUUID();
  const APP_ID = randomUUID();
  const VERSION = randomUUID();
  const submitBody = {
    question: "能开增值税专用发票吗？",
    answer: "可以。抬头与税号发我，3 个工作日内寄出。",
    targetKbId: KB,
    applicationId: APP_ID,
    configVersionId: VERSION,
    confirmed: true,
  };

  it("三步走通：pending → draft-fill → reviewing → submit-fill → filled，且内容真的入库", async () => {
    const id = await seedCluster();

    const drafted = await request(app.getHttpServer())
      .post(`/api/gaps/${id}/draft-fill`)
      .expect(200);
    expect(drafted.body.status).toBe("reviewing");

    const submitted = await request(app.getHttpServer())
      .post(`/api/gaps/${id}/submit-fill`)
      .send(submitBody)
      .expect(200);
    expect(submitted.body.status).toBe("filled");

    // 合成文档必须是 QaChunker 认得的配对行格式，且内容是**人审后**那份、不是 LLM 原稿。
    expect(uploads).toHaveLength(1);
    expect(uploads[0].kbId).toBe(KB);
    expect(uploads[0].content).toBe(
      "问：能开增值税专用发票吗？\n答：可以。抬头与税号发我，3 个工作日内寄出。\n",
    );
  });

  it("⛔ 红线：跳过人审直接 submit-fill ⇒ 400，且**一个字节都没进知识库**", async () => {
    // 这是本波唯一的产品红线（原型 `:367`）：LLM 编错答案会污染知识库，
    // 而且它在忠实度指标上还显示满分——没人审就入库，等于给错答案盖了个可信的章。
    const id = await seedCluster();

    const res = await request(app.getHttpServer())
      .post(`/api/gaps/${id}/submit-fill`)
      .send(submitBody)
      .expect(400);
    expect(res.body.message).toContain("pending");

    // 状态码对了还不够——真正要守的是**副作用没有发生**。
    // 我在实现里就犯过这个错：upload 写在状态检查之前，400 照样返回，文档却已经进去了。
    expect(uploads).toEqual([]);
  });

  it("⛔ 红线：confirmed=false ⇒ Zod 400，同样不入库", async () => {
    const id = await seedCluster();
    await request(app.getHttpServer()).post(`/api/gaps/${id}/draft-fill`).expect(200);

    await request(app.getHttpServer())
      .post(`/api/gaps/${id}/submit-fill`)
      .send({ ...submitBody, confirmed: false })
      .expect(400);

    expect(uploads).toEqual([]);
  });

  it("取消补库回 pending 且**保留草稿**（下次打开直接回到第②步）", async () => {
    const id = await seedCluster();
    await request(app.getHttpServer()).post(`/api/gaps/${id}/draft-fill`).expect(200);

    const cancelled = await request(app.getHttpServer())
      .post(`/api/gaps/${id}/cancel-fill`)
      .expect(200);
    expect(cancelled.body.status).toBe("pending");

    const draft = await request(app.getHttpServer()).get(`/api/gaps/${id}/fill-draft`).expect(200);
    // 草稿留着才有「继续补库」这个入口；清掉的话用户得从头再草拟一次。
    expect(draft.body.draftQuestion).toBe("能开增值税专用发票吗？");
  });

  /**
   * 021 §9b 决策 J 承诺「保留草稿供下次跳过①直接到②」。B2b 初版只做了**保留**、
   * 没做**出口**——没有 `pending → reviewing` 迁移，UI 到不了那份草稿，
   * 每次取消都要重花一次 LLM 调用并把它覆盖掉。运行时 QA 抓出「文档承诺 ≠ 实现」。
   */
  it("continue：取消后可拿回草稿直接回 reviewing，**不重新调模型**", async () => {
    const id = await seedCluster();
    await request(app.getHttpServer()).post(`/api/gaps/${id}/draft-fill`).expect(200);
    await request(app.getHttpServer()).post(`/api/gaps/${id}/cancel-fill`).expect(200);

    const draftCallsBefore = draftCalls;
    const resumed = await request(app.getHttpServer())
      .post(`/api/gaps/${id}/resume-fill`)
      .expect(200);

    expect(resumed.body.status).toBe("reviewing");
    // 关键：走的是纯状态迁移。多调一次模型就等于把保留的草稿覆盖了。
    expect(draftCalls).toBe(draftCallsBefore);

    const draft = await request(app.getHttpServer()).get(`/api/gaps/${id}/fill-draft`).expect(200);
    expect(draft.body.draftQuestion).toBe("能开增值税专用发票吗？");
  });

  it("resume：从没草拟过的簇 ⇒ 400，不把空内容推进 reviewing", async () => {
    // 绝大多数 pending 簇从没草拟过。放进 reviewing 会让用户对着两个空输入框，
    // 而那个状态在形式上已经允许「确认入库」了。
    const id = await seedCluster();

    await request(app.getHttpServer()).post(`/api/gaps/${id}/resume-fill`).expect(400);

    const draft = await request(app.getHttpServer()).get(`/api/gaps/${id}/fill-draft`).expect(200);
    expect(draft.body.status).toBe("pending");
  });

  it("草拟失败 ⇒ 簇退回 pending（不能卡在 drafting，那是个没有用户出口的态）", async () => {
    const id = await seedCluster();
    draftReply = null;

    // 判官调用出错被服务包成 400（「草拟失败：判官模型调用出错」），不是 500。
    await request(app.getHttpServer()).post(`/api/gaps/${id}/draft-fill`).expect(400);

    const draft = await request(app.getHttpServer()).get(`/api/gaps/${id}/fill-draft`).expect(200);
    expect(draft.body.status).toBe("pending");
  });

  it("非 UUID 路径参数是 400 而不是 500", async () => {
    await request(app.getHttpServer()).get("/api/gaps/not-a-uuid/fill-draft").expect(400);
    await request(app.getHttpServer()).post("/api/gaps/not-a-uuid/submit-fill").send(submitBody).expect(400);
  });
});
