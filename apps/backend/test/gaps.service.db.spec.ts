/**
 * `GapsService` 的状态机、拆分/合并与频次口径（021 决策 A / §9.6），跑在**真 Postgres** 上。
 *
 * 为什么不是纯内存单测：本 story 的正确性几乎全在 SQL 里——`freq_30d` 的
 * `source <> 'offline_run'` 谓词、`avg(LEAST(...))` 对 NULL 的处理、拆分后两簇 freq 重算的
 * 守恒、软删而非物理删。这些用 fake 仓库测等于测 fake 自己重写的一份 SQL 语义
 * （Task 5 的 review 已经踩过这个：fake 覆盖了分支，真事务路径零覆盖）。
 *
 * ⛔ 只连 MIGRATION_TEST_DATABASE_URL（codecrush_mig_test）——本文件会 DROP SCHEMA。
 * 开发库 codecrush 里是用户手工搭建、无备份的数据，打到那上面就是永久丢失。
 */
import { readFileSync } from "fs";
import { join } from "path";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { GapCentroidStaleError } from "../src/modules/gaps/gap-clustering";
import { GapsRepository } from "../src/modules/gaps/gaps.repository";
import { GapsService } from "../src/modules/gaps/gaps.service";
import { dbGate } from "./helpers/gated-suite";

const describeDb = dbGate();
jest.setTimeout(180_000);

const MIGRATIONS_DIR = join(__dirname, "..", "drizzle");
const EMBED_MODEL_ID = "22222222-2222-4222-8222-222222222222";

function vec(fill: (i: number) => number): string {
  return `[${Array.from({ length: 1024 }, (_, i) => fill(i)).join(",")}]`;
}
const VEC_E0 = vec((i) => (i === 0 ? 1 : 0));
const VEC_E1 = vec((i) => (i === 1 ? 1 : 0));

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

describeDb("GapsService（状态机 / 拆分合并 / 频次口径，RUN_DB_TESTS=1）", () => {
  let pool: Pool;
  let service: GapsService;
  let repo: GapsRepository;
  let embedVector: number[];

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.MIGRATION_TEST_DATABASE_URL });
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
    const journal = JSON.parse(
      readFileSync(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"),
    ) as { entries: { tag: string }[] };
    for (const { tag } of journal.entries) {
      const text = readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), "utf8");
      for (const raw of text.split("--> statement-breakpoint")) {
        if (raw.trim()) await pool.query(raw.trim());
      }
    }

    const db = drizzle(pool) as never;
    repo = new GapsRepository(db);
    // 只桩掉外部模型调用；settings 走真仓库（手动入池要读 embeddingModelId）。
    const evaluations = {
      getSettings: async () => ({ embeddingModelId: EMBED_MODEL_ID, judgeVersion: "online-v1" }),
    };
    const models = { embedTexts: async (_id: string, texts: string[]) => texts.map(() => embedVector) };
    service = new GapsService(repo, evaluations as never, models as never);
  });

  afterAll(async () => {
    await pool.end();
  });

  /** 建一个簇 + 若干成员。返回 id，用完由各用例按 id 精确清理（禁止裸 delete 整表）。 */
  async function seedCluster(opts: {
    question?: string;
    centroid?: string;
    status?: string;
    rootCauseAuto?: string | null;
    // B2b 向导/回验列（缺省全 NULL，既有用例一个字都不用改）。
    fillDraftQuestion?: string | null;
    fillDraftAnswer?: string | null;
    fillPreScore?: number | null;
    recurredAt?: Date | null;
    items?: Array<{
      source?: string;
      traceStartTime?: Date | null;
      followUpSuspected?: boolean;
      faithfulness?: number | null;
      answerRelevancy?: number | null;
      contextPrecision?: number | null;
      embedding?: string;
    }>;
  }): Promise<{ clusterId: string; itemIds: string[] }> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO gap_clusters
         (representative_question, centroid, status, root_cause_auto, freq,
          fill_draft_question, fill_draft_answer, fill_pre_score, recurred_at)
       VALUES ($1, $2::vector, $3, $4, 0, $5, $6, $7, $8) RETURNING id`,
      [
        opts.question ?? "能开专用发票吗",
        opts.centroid ?? VEC_E0,
        opts.status ?? "pending",
        opts.rootCauseAuto ?? null,
        opts.fillDraftQuestion ?? null,
        opts.fillDraftAnswer ?? null,
        opts.fillPreScore ?? null,
        opts.recurredAt ?? null,
      ],
    );
    const clusterId = rows[0].id;
    const itemIds: string[] = [];
    const items = opts.items ?? [];
    for (let i = 0; i < items.length; i += 1) {
      const it = items[i];
      const inserted = await pool.query<{ id: string }>(
        `INSERT INTO gap_items
           (cluster_id, source, source_trace_id, question, embedding, trace_start_time,
            follow_up_suspected, faithfulness, answer_relevancy, context_precision)
         VALUES ($1,$2,$3,$4,$5::vector,$6,$7,$8,$9,$10) RETURNING id`,
        [
          clusterId,
          it.source ?? "online",
          `${clusterId.replaceAll("-", "").slice(0, 24)}${String(i).padStart(8, "0")}`,
          `问题 ${i}`,
          it.embedding ?? VEC_E0,
          it.traceStartTime === undefined ? daysAgo(3) : it.traceStartTime,
          it.followUpSuspected ?? false,
          it.faithfulness ?? null,
          it.answerRelevancy ?? null,
          it.contextPrecision ?? null,
        ],
      );
      itemIds.push(inserted.rows[0].id);
    }
    if (items.length > 0) {
      await pool.query(`UPDATE gap_clusters SET freq = $2 WHERE id = $1`, [clusterId, items.length]);
    }
    return { clusterId, itemIds };
  }

  async function cleanup(clusterIds: string[]): Promise<void> {
    await pool.query(`DELETE FROM gap_items WHERE cluster_id = ANY($1::uuid[])`, [clusterIds]);
    await pool.query(`DELETE FROM gap_clusters WHERE id = ANY($1::uuid[])`, [clusterIds]);
  }

  async function statusOf(id: string): Promise<string> {
    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM gap_clusters WHERE id = $1`,
      [id],
    );
    return rows[0].status;
  }

  /** 复发窗口的锚点（迁移 0029）。由 `applyTransition` 在进出终态时维护。 */
  async function terminalAtOf(id: string): Promise<Date | null> {
    const { rows } = await pool.query<{ terminal_at: Date | null }>(
      `SELECT terminal_at FROM gap_clusters WHERE id = $1`,
      [id],
    );
    return rows[0].terminal_at;
  }

  async function itemCount(id: string): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM gap_items WHERE cluster_id = $1`,
      [id],
    );
    return Number(rows[0].n);
  }

  async function freqOf(id: string): Promise<number> {
    const { rows } = await pool.query<{ freq: number }>(
      `SELECT freq FROM gap_clusters WHERE id = $1`,
      [id],
    );
    return Number(rows[0].freq);
  }

  /** B2b：读向导/回验列（这些不在契约 `GapCluster` 上，只能直接查库断言）。 */
  async function fillFieldsOf(id: string): Promise<{
    fillDraftQuestion: string | null;
    fillDraftAnswer: string | null;
    fillTargetDocumentId: string | null;
    fillVerifyApplicationId: string | null;
    fillPreScore: number | null;
    verifiedScore: number | null;
    recurredAt: Date | null;
  }> {
    const { rows } = await pool.query<{
      fill_draft_question: string | null;
      fill_draft_answer: string | null;
      fill_target_document_id: string | null;
      fill_verify_application_id: string | null;
      fill_pre_score: number | null;
      verified_score: number | null;
      recurred_at: Date | null;
    }>(
      `SELECT fill_draft_question, fill_draft_answer, fill_target_document_id,
              fill_verify_application_id, fill_pre_score, verified_score, recurred_at
       FROM gap_clusters WHERE id = $1`,
      [id],
    );
    const r = rows[0];
    return {
      fillDraftQuestion: r.fill_draft_question,
      fillDraftAnswer: r.fill_draft_answer,
      fillTargetDocumentId: r.fill_target_document_id,
      fillVerifyApplicationId: r.fill_verify_application_id,
      fillPreScore: r.fill_pre_score,
      verifiedScore: r.verified_score,
      recurredAt: r.recurred_at,
    };
  }

  // ───────────────────────────── 状态机 ─────────────────────────────

  describe("状态机（021 决策 A）", () => {
    it.each([
      ["pending", "ignore", "ignored"],
      ["pending", "routeRetrieval", "routed_retrieval"],
      ["ignored", "reopen", "pending"],
      // V15：合法——没有出口的状态是死态，判错了必须还能忽略掉。
      ["routed_retrieval", "ignore", "ignored"],
    ] as const)("%s --%s--> %s", async (from, event, to) => {
      const { clusterId } = await seedCluster({ status: from, items: [{}] });
      await service.transition(clusterId, event);
      expect(await statusOf(clusterId)).toBe(to);
      await cleanup([clusterId]);
    });

    it("非法迁移抛 400 且状态一动不动", async () => {
      const { clusterId } = await seedCluster({ status: "pending", items: [{}] });
      await expect(service.transition(clusterId, "reopen")).rejects.toThrow(/illegal transition/i);
      expect(await statusOf(clusterId)).toBe("pending");
      await cleanup([clusterId]);
    });

    it("「已进评测集」是叠加标志：只写时间戳，status 保持不变", async () => {
      const { clusterId } = await seedCluster({ status: "pending", items: [{}] });
      const updated = await service.markEnteredEvalSet(clusterId);
      expect(await statusOf(clusterId)).toBe("pending");
      expect(updated.enteredEvalSetAt).not.toBeNull();
      await cleanup([clusterId]);
    });

    it("人工改判根因后，生效根因是 manual，且 auto 仍留着（worker 永不被覆盖）", async () => {
      const { clusterId } = await seedCluster({ rootCauseAuto: "missing", items: [{}] });
      const updated = await service.setRootCauseManual(clusterId, "generation");
      expect(updated.rootCause).toBe("generation");
      expect(updated.rootCauseIsManual).toBe(true);
      const { rows } = await pool.query<{ auto: string }>(
        `SELECT root_cause_auto AS auto FROM gap_clusters WHERE id = $1`,
        [clusterId],
      );
      expect(rows[0].auto).toBe("missing"); // 「worker 现在会怎么判」依然可回答
      await cleanup([clusterId]);
    });
  });

  // ───────────────── B2b：向导与回验的四态迁移（021 决策 J） ─────────────────

  describe("状态机 B2b 四态（021 决策 J / 原型 §18.C）", () => {
    /**
     * 系统事件**没有**公开的 `transition(id, event)` 入口——公开方法只收
     * `GapUserTransition` 三个用户事件。这里逐个调具名方法，正是在钉住那条约束：
     * 若哪天有人把 `transition` 的参数放宽回全量 union，这段仍然通过，
     * 但下面「载荷与状态同时落库」的断言会开始漏——所以两者都要有。
     */
    const SYSTEM_EVENTS = {
      startDraft: (id: string) => service.startDraft(id),
      cancelDraft: (id: string) => service.cancelDraft(id),
      draftReady: (id: string) => service.recordDraftReady(id, "草拟问题", "草拟答案"),
      cancelReview: (id: string) => service.cancelReview(id),
      verifyPass: (id: string) => service.recordVerifyPass(id, 89),
      verifyFail: (id: string) => service.recordVerifyFail(id, 62),
      verifyIngestFailed: (id: string) => service.recordVerifyIngestFailed(id),
      reopenRecurred: (id: string) => service.reopenRecurred(id),
    } as const;

    it.each([
      ["pending", "startDraft", "drafting"],
      ["drafting", "cancelDraft", "pending"],
      ["drafting", "draftReady", "reviewing"],
      ["reviewing", "cancelReview", "pending"],
      ["filled", "verifyPass", "verified"],
      ["filled", "verifyFail", "pending"],
      ["filled", "verifyIngestFailed", "pending"],
      ["ignored", "reopenRecurred", "pending"],
      ["verified", "reopenRecurred", "pending"],
    ] as const)("%s --%s--> %s", async (from, event, to) => {
      const { clusterId } = await seedCluster({ status: from, items: [{}] });
      try {
        await SYSTEM_EVENTS[event](clusterId);
        expect(await statusOf(clusterId)).toBe(to);
      } finally {
        await cleanup([clusterId]);
      }
    });

    it("ignore 在全部六个非 ignored 态都合法（原型 §18.C「任意非终」）", async () => {
      const ids: string[] = [];
      try {
        for (const from of [
          "pending",
          "routed_retrieval",
          "drafting",
          "reviewing",
          "filled",
          "verified",
        ] as const) {
          const { clusterId } = await seedCluster({ status: from, items: [{}] });
          ids.push(clusterId);
          await service.transition(clusterId, "ignore");
          expect(await statusOf(clusterId)).toBe("ignored");
        }
      } finally {
        await cleanup(ids);
      }
    });

    it("从 ignored 再 ignore 仍是非法——重复点击要被明确拒绝，不是静默 no-op", async () => {
      const { clusterId } = await seedCluster({ status: "ignored", items: [{}] });
      try {
        await expect(service.transition(clusterId, "ignore")).rejects.toThrow(
          /illegal transition/i,
        );
        expect(await statusOf(clusterId)).toBe("ignored");
      } finally {
        await cleanup([clusterId]);
      }
    });

    it.each([
      ["routed_retrieval", "startDraft", (id: string) => service.startDraft(id)],
      ["pending", "draftReady", (id: string) => service.recordDraftReady(id, "q", "a")],
      ["reviewing", "verifyPass", (id: string) => service.recordVerifyPass(id, 89)],
      ["drafting", "verifyFail", (id: string) => service.recordVerifyFail(id, 62)],
      ["pending", "reopenRecurred", (id: string) => service.reopenRecurred(id)],
      [
        "pending",
        "submitFill",
        (id: string) =>
          service.submitFill(id, {
            question: "人审后的问题",
            answer: "人审后的答案",
            targetKbId: "44444444-4444-4444-8444-444444444444",
            applicationId: "55555555-5555-4555-8555-555555555555",
            configVersionId: "66666666-6666-4666-8666-666666666666",
            documentId: "77777777-7777-4777-8777-777777777777",
          }),
      ],
    ] as const)("非法迁移 %s --%s--> 被拒且状态一动不动", async (from, _event, invoke) => {
      const { clusterId } = await seedCluster({ status: from, items: [{}] });
      try {
        await expect(invoke(clusterId)).rejects.toThrow(/illegal transition/i);
        expect(await statusOf(clusterId)).toBe(from);
      } finally {
        await cleanup([clusterId]);
      }
    });

    it("startDraft 把当下的 avgQuality 快照成 fill_pre_score（「41→89」的左端）", async () => {
      // avgQuality = 簇内各 item 的 min(三个非空指标) 的均值 ⇒ min(41,79,86)=41、min(45,90,90)=45 ⇒ 43。
      const { clusterId } = await seedCluster({
        status: "pending",
        items: [
          { faithfulness: 41, answerRelevancy: 79, contextPrecision: 86 },
          { faithfulness: 45, answerRelevancy: 90, contextPrecision: 90 },
        ],
      });
      try {
        await service.startDraft(clusterId);
        expect(await statusOf(clusterId)).toBe("drafting");
        expect((await fillFieldsOf(clusterId)).fillPreScore).toBe(43);
      } finally {
        await cleanup([clusterId]);
      }
    });

    it("一个分数都没有的簇 startDraft：fill_pre_score 记 NULL，不是 0", async () => {
      const { clusterId } = await seedCluster({ status: "pending", items: [{}] });
      try {
        await service.startDraft(clusterId);
        expect((await fillFieldsOf(clusterId)).fillPreScore).toBeNull();
      } finally {
        await cleanup([clusterId]);
      }
    });

    it("取消草拟/驳回人审都保留草稿，供下次直接从第②步继续（原型 `:704`）", async () => {
      const drafting = await seedCluster({
        status: "drafting",
        fillDraftQuestion: "能否开具专用发票",
        fillDraftAnswer: "可以。",
        items: [{}],
      });
      const reviewing = await seedCluster({
        status: "reviewing",
        fillDraftQuestion: "能否开具专用发票",
        fillDraftAnswer: "可以。",
        items: [{}],
      });
      try {
        await service.cancelDraft(drafting.clusterId);
        expect((await fillFieldsOf(drafting.clusterId)).fillDraftQuestion).toBe("能否开具专用发票");

        await service.cancelReview(reviewing.clusterId);
        expect((await fillFieldsOf(reviewing.clusterId)).fillDraftAnswer).toBe("可以。");
      } finally {
        await cleanup([drafting.clusterId, reviewing.clusterId]);
      }
    });

    it("recordDraftReady 写草稿 Q/A 并进入待人审", async () => {
      const { clusterId } = await seedCluster({ status: "drafting", items: [{}] });
      try {
        await service.recordDraftReady(clusterId, "能否开具专用发票", "可以，下单时选专票。");
        expect(await statusOf(clusterId)).toBe("reviewing");
        const fields = await fillFieldsOf(clusterId);
        expect(fields.fillDraftQuestion).toBe("能否开具专用发票");
        expect(fields.fillDraftAnswer).toBe("可以，下单时选专票。");
      } finally {
        await cleanup([clusterId]);
      }
    });

    it("submitFill 记下入库目标与回验参数（监听器按 documentId 反查本簇）", async () => {
      const { clusterId } = await seedCluster({ status: "reviewing", items: [{}] });
      const target = {
        question: "人审后的问题",
        answer: "人审后的答案",
        targetKbId: "44444444-4444-4444-8444-444444444444",
        applicationId: "55555555-5555-4555-8555-555555555555",
        configVersionId: "66666666-6666-4666-8666-666666666666",
        documentId: "77777777-7777-4777-8777-777777777777",
      };
      try {
        await service.submitFill(clusterId, target);
        expect(await statusOf(clusterId)).toBe("filled");
        const fields = await fillFieldsOf(clusterId);
        expect(fields.fillTargetDocumentId).toBe(target.documentId);
        expect(fields.fillVerifyApplicationId).toBe(target.applicationId);
      } finally {
        await cleanup([clusterId]);
      }
    });

    it("回验通过：转 verified、记新分数、**不**打复发标", async () => {
      const { clusterId } = await seedCluster({ status: "filled", fillPreScore: 41, items: [{}] });
      try {
        const updated = await service.recordVerifyPass(clusterId, 89);
        expect(updated.status).toBe("verified");
        expect(updated.fillPreScore).toBe(41);
        expect(updated.verifiedScore).toBe(89);
        expect(updated.recurred).toBe(false);
      } finally {
        await cleanup([clusterId]);
      }
    });

    it("回验未通过：回 pending、记分数、打复发标（原型 `:706`）", async () => {
      const { clusterId } = await seedCluster({ status: "filled", fillPreScore: 41, items: [{}] });
      try {
        const updated = await service.recordVerifyFail(clusterId, 62);
        expect(updated.status).toBe("pending");
        expect(updated.verifiedScore).toBe(62);
        expect(updated.recurred).toBe(true);
      } finally {
        await cleanup([clusterId]);
      }
    });

    it("入库失败：回 pending、清掉废文档引用、**不**打复发标（与「补库后仍低分」要能分辨）", async () => {
      const { clusterId } = await seedCluster({ status: "reviewing", items: [{}] });
      try {
        await service.submitFill(clusterId, {
          question: "人审后的问题",
          answer: "人审后的答案",
          targetKbId: "44444444-4444-4444-8444-444444444444",
          applicationId: "55555555-5555-4555-8555-555555555555",
          configVersionId: "66666666-6666-4666-8666-666666666666",
          documentId: "77777777-7777-4777-8777-777777777777",
        });
        const updated = await service.recordVerifyIngestFailed(clusterId);
        expect(updated.status).toBe("pending");
        expect(updated.recurred).toBe(false); // 工程故障 ≠ 缺口复发
        expect((await fillFieldsOf(clusterId)).fillTargetDocumentId).toBeNull();
      } finally {
        await cleanup([clusterId]);
      }
    });

    it.each([
      ["ignore", (id: string) => service.transition(id, "ignore")],
      ["routeRetrieval", (id: string) => service.transition(id, "routeRetrieval")],
      ["startDraft", (id: string) => service.startDraft(id)],
    ] as const)("复发标在人主动推进（%s）时清除", async (_event, invoke) => {
      // 三个事件都在 CLEARS_RECURRED 里，必须逐个钉——只测 ignore 的话，
      // 另外两个从集合里被删掉也不会有任何测试变红。
      const { clusterId } = await seedCluster({
        status: "pending",
        recurredAt: new Date(),
        items: [{}],
      });
      try {
        const updated = await invoke(clusterId);
        expect(updated.recurred).toBe(false);
      } finally {
        await cleanup([clusterId]);
      }
    });

    it("reopen 不清复发标——那是另一条独立迁移，与复发判定无关", async () => {
      const { clusterId } = await seedCluster({
        status: "ignored",
        recurredAt: new Date(),
        items: [{}],
      });
      try {
        const updated = await service.transition(clusterId, "reopen");
        expect(updated.recurred).toBe(true);
      } finally {
        await cleanup([clusterId]);
      }
    });

    /**
     * ⚠️ 这条**取代**了原来那个用 `Promise.allSettled` 造并发的版本。
     * 清理复审证明它是**空测**：删掉 repository 的 `WHERE status = expected` 后 60/60 全绿。
     * 原因是两个 Promise 在同一连接池上实际被**串行化**了——第二个的 `mustFind` 读到的
     * 已经是 `verified`，被 service 的内存守卫（TRANSITIONS 表）挡下抛 `BadRequestException`，
     * `ConflictException` 从头到尾没被触发过。它守住的是迁移表，不是 CAS。
     *
     * 现在直接在 repository 层造**确定性**窗口：先读到 filled，再用裸 SQL 模拟
     * 「另一个请求已经把簇推走了」，然后拿旧的 expectedStatus 去写——CAS 必须拦下。
     */
    it("CAS：expectedStatus 与库里不符时，整条 UPDATE 不生效（返回 false）", async () => {
      const { clusterId } = await seedCluster({ status: "filled", fillPreScore: 41, items: [{}] });
      try {
        // 模拟并发写者：在我们「读到 filled」之后、「写入」之前把它推到 verified。
        await pool.query(`UPDATE gap_clusters SET status = 'verified' WHERE id = $1`, [clusterId]);

        const applied = await repo.applyTransition(
          clusterId,
          "filled", // ← 我们以为的状态，已经过期
          { status: "pending", verifiedScore: 62, recurredAt: new Date() },
          new Date(),
        );

        expect(applied).toBe(false);
        // 关键：**载荷一个字段都不许落**。没有 CAS 的话这里会写成
        // 「verified 却带 recurred_at + verifiedScore=62」——021 §18.C 里没有这种组合。
        expect(await statusOf(clusterId)).toBe("verified");
        const fields = await fillFieldsOf(clusterId);
        expect(fields.verifiedScore).toBeNull();
        expect(fields.recurredAt).toBeNull();
      } finally {
        await cleanup([clusterId]);
      }
    });

    /**
     * `terminal_at` 的**写入**此前零覆盖——把 `applyTransition` 里那行改成恒 `null`，
     * 238 个测试全绿（清理复审实测）。而它是迁移 0029 存在的**全部理由**：
     * 没有锚点，`checkRecurrence` 就退回「now 往前 7 天」的滚动窗口，
     * 于是运营刚点[忽略]的热簇会被它**忽略之前**攒下的样本立刻顶回 pending——
     * 「忽略」按钮等于没有，而且没有任何报错。
     *
     * 复发窗口的**判定**逻辑在 `gap-collector.processor.spec.ts` 有覆盖，但那是内存 fake、
     * 自带一个 `terminalAt` 字段，与真实 UPDATE 是否写库毫无关系。这两条补的正是那一段。
     */
    /**
     * 021 §9b 决策 J 承诺「取消补库后**保留**草稿，下次重开向导跳过①直接到②」。
     * B2b 初版草稿确实留在库里，但**没有这条迁移**——UI 到不了它，每次取消都要
     * 重花一次 LLM 调用并把保留的那份覆盖掉。运行时 QA 抓出「文档承诺 ≠ 实现」。
     */
    it("resumeDraft：有保留草稿 ⇒ pending 直接回 reviewing，内容逐字不变", async () => {
      const { clusterId } = await seedCluster({
        status: "pending",
        fillDraftQuestion: "上次草拟的问题",
        fillDraftAnswer: "上次草拟的答案",
        items: [{}],
      });
      try {
        await service.resumeDraft(clusterId);

        expect(await statusOf(clusterId)).toBe("reviewing");
        const fields = await fillFieldsOf(clusterId);
        // 关键：**不调模型、不覆盖**。草稿必须逐字还是那一份。
        expect(fields.fillDraftQuestion).toBe("上次草拟的问题");
        expect(fields.fillDraftAnswer).toBe("上次草拟的答案");
      } finally {
        await cleanup([clusterId]);
      }
    });

    it("resumeDraft：没有草稿 ⇒ 400，绝不把空内容推进 reviewing", async () => {
      // 绝大多数 pending 簇从没草拟过。放它们进 reviewing 会让用户对着两个空输入框，
      // 而那个状态在形式上已经允许「确认入库」了。
      const { clusterId } = await seedCluster({ status: "pending", items: [{}] });
      try {
        await expect(service.resumeDraft(clusterId)).rejects.toThrow(BadRequestException);
        expect(await statusOf(clusterId)).toBe("pending");
      } finally {
        await cleanup([clusterId]);
      }
    });

    it("resumeDraft：只有问题没有答案也拒绝（半份草稿不是草稿）", async () => {
      const { clusterId } = await seedCluster({
        status: "pending",
        fillDraftQuestion: "只有问题",
        items: [{}],
      });
      try {
        await expect(service.resumeDraft(clusterId)).rejects.toThrow(BadRequestException);
        expect(await statusOf(clusterId)).toBe("pending");
      } finally {
        await cleanup([clusterId]);
      }
    });

    it("进入终态 ⇒ 写 terminal_at 锚点", async () => {
      const { clusterId } = await seedCluster({ status: "pending", items: [{}] });
      try {
        expect(await terminalAtOf(clusterId)).toBeNull();

        await service.transition(clusterId, "ignore");

        expect(await statusOf(clusterId)).toBe("ignored");
        expect(await terminalAtOf(clusterId)).not.toBeNull();
      } finally {
        await cleanup([clusterId]);
      }
    });

    it("离开终态 ⇒ 清掉 terminal_at（否则下一轮会沿用上一次的旧锚点）", async () => {
      const { clusterId } = await seedCluster({ status: "ignored", items: [{}] });
      try {
        // seed 出来的 ignored 簇锚点为空，先走一遍 reopen→ignore 把它做实。
        await service.transition(clusterId, "reopen");
        await service.transition(clusterId, "ignore");
        expect(await terminalAtOf(clusterId)).not.toBeNull();

        await service.transition(clusterId, "reopen");

        expect(await statusOf(clusterId)).toBe("pending");
        expect(await terminalAtOf(clusterId)).toBeNull();
      } finally {
        await cleanup([clusterId]);
      }
    });

    it("回验通过（filled → verified）同样是终态，也要落锚点", async () => {
      // verified 与 ignored 一样属「已终结」，7 天窗口从这一刻起算。
      const { clusterId } = await seedCluster({ status: "filled", fillPreScore: 41, items: [{}] });
      try {
        await service.recordVerifyPass(clusterId, 89);

        expect(await statusOf(clusterId)).toBe("verified");
        expect(await terminalAtOf(clusterId)).not.toBeNull();
      } finally {
        await cleanup([clusterId]);
      }
    });

    it("回验未过（filled → pending）不是终态 ⇒ 不留锚点", async () => {
      // 与上一条配对：只测「终态要写」的话，一个无条件写入的实现也能通过。
      const { clusterId } = await seedCluster({ status: "filled", fillPreScore: 41, items: [{}] });
      try {
        await service.recordVerifyFail(clusterId, 62);

        expect(await statusOf(clusterId)).toBe("pending");
        expect(await terminalAtOf(clusterId)).toBeNull();
      } finally {
        await cleanup([clusterId]);
      }
    });

    it("CAS：expectedStatus 相符时正常写入（证明上一条不是恒 false）", async () => {
      // 与上一条配对。只测「不符时拦下」的话，一个恒返回 false 的实现也能通过。
      const { clusterId } = await seedCluster({ status: "filled", fillPreScore: 41, items: [{}] });
      try {
        const applied = await repo.applyTransition(
          clusterId,
          "filled",
          { status: "verified", verifiedScore: 89 },
          new Date(),
        );

        expect(applied).toBe(true);
        expect(await statusOf(clusterId)).toBe("verified");
        expect((await fillFieldsOf(clusterId)).verifiedScore).toBe(89);
      } finally {
        await cleanup([clusterId]);
      }
    });

    it("service 层把 CAS 落空翻译成 409（不是 400）——两者对调用方含义完全不同", async () => {
      /**
       * 400「非法迁移」= 你要做的事本身不允许，重试多少次都一样；
       * 409「并发冲突」= 事情合法，只是有人抢先了，刷新后可以重来。
       * 前端据此决定「弹错误」还是「提示刷新重试」，混淆会把可恢复的操作说成非法。
       */
      const { clusterId } = await seedCluster({ status: "filled", fillPreScore: 41, items: [{}] });
      try {
        const original = repo.applyTransition.bind(repo);
        // 在 service 读到 filled 之后、写入之前插一手，制造真实的 mustFind→UPDATE 窗口。
        const spy = jest
          .spyOn(repo, "applyTransition")
          .mockImplementation(async (id, expected, patch, now) => {
            await pool.query(`UPDATE gap_clusters SET status = 'ignored' WHERE id = $1`, [id]);
            return original(id, expected, patch, now);
          });

        await expect(service.recordVerifyPass(clusterId, 89)).rejects.toThrow(ConflictException);
        spy.mockRestore();

        expect(await statusOf(clusterId)).toBe("ignored");
        expect((await fillFieldsOf(clusterId)).verifiedScore).toBeNull();
      } finally {
        await cleanup([clusterId]);
      }
    });

    it("startDraft 撞上并发软删时报 404，而不是把 fill_pre_score 记成 NULL 蒙混过去", async () => {
      const { clusterId } = await seedCluster({ status: "pending", items: [{}] });
      try {
        await pool.query(`UPDATE gap_clusters SET deleted_at = now() WHERE id = $1`, [clusterId]);
        await expect(service.startDraft(clusterId)).rejects.toThrow(/缺口不存在/);
      } finally {
        await cleanup([clusterId]);
      }
    });
  });

  // ───────────────────────── 拆分 / 合并 ─────────────────────────

  describe("拆分 / 合并", () => {
    it("拆分守恒：item 总数不变，两簇 freq 各自按实际成员重算（AC8）", async () => {
      const { clusterId, itemIds } = await seedCluster({
        items: [{}, {}, {}, { embedding: VEC_E1 }, { embedding: VEC_E1 }],
      });
      const moved = itemIds.slice(3);

      const { newClusterId } = await service.split(clusterId, moved);

      expect(await itemCount(clusterId)).toBe(3);
      expect(await itemCount(newClusterId)).toBe(2);
      expect((await freqOf(clusterId)) + (await freqOf(newClusterId))).toBe(5);
      await cleanup([clusterId, newClusterId]);
    });

    it("新簇质心 = 被移走向量的均值（不是随便挑一条）", async () => {
      const { clusterId, itemIds } = await seedCluster({
        items: [{}, { embedding: VEC_E1 }, { embedding: VEC_E1 }],
      });
      const { newClusterId } = await service.split(clusterId, itemIds.slice(1));
      const { rows } = await pool.query<{ sim: string }>(
        `SELECT 1 - (centroid <=> $1::vector) AS sim FROM gap_clusters WHERE id = $2`,
        [VEC_E1, newClusterId],
      );
      expect(Number(rows[0].sim)).toBeCloseTo(1, 5); // 两条都是 e1 ⇒ 均值仍是 e1
      await cleanup([clusterId, newClusterId]);
    });

    it("拒绝拆走全部成员——那只是身份洗牌，还会丢掉源簇上的人工判定", async () => {
      const { clusterId, itemIds } = await seedCluster({ items: [{}, {}] });
      await expect(service.split(clusterId, itemIds)).rejects.toThrow(/不能拆走全部成员/);
      expect(await itemCount(clusterId)).toBe(2);
      await cleanup([clusterId]);
    });

    it("合并清空源簇后**软删**：行还在、deleted_at 非空、列表里不再出现", async () => {
      const a = await seedCluster({ items: [{}, {}] });
      const b = await seedCluster({ question: "另一个簇", centroid: VEC_E1, items: [{}] });

      const result = await service.merge(a.clusterId, b.clusterId, a.itemIds);

      expect(result.sourceSoftDeleted).toBe(true);
      const { rows } = await pool.query<{ deleted_at: Date | null }>(
        `SELECT deleted_at FROM gap_clusters WHERE id = $1`,
        [a.clusterId],
      );
      expect(rows).toHaveLength(1); // 没有物理删——「已进评测集」的关联要留痕
      expect(rows[0].deleted_at).not.toBeNull();
      expect(await freqOf(b.clusterId)).toBe(3);
      const listed = await service.list({ limit: 200, offset: 0 });
      expect(listed.items.map((i) => i.id)).not.toContain(a.clusterId);
      await cleanup([a.clusterId, b.clusterId]);
    });

    it("拒绝搬运不属于本簇的 item（否则能悄悄改写别人的 freq）", async () => {
      const a = await seedCluster({ items: [{}, {}] });
      const b = await seedCluster({ question: "别人", centroid: VEC_E1, items: [{}] });
      await expect(service.split(a.clusterId, [b.itemIds[0]])).rejects.toThrow(/不属于本缺口/);
      expect(await itemCount(b.clusterId)).toBe(1);
      await cleanup([a.clusterId, b.clusterId]);
    });

    it("拒绝把簇合并到它自己", async () => {
      const { clusterId, itemIds } = await seedCluster({ items: [{}] });
      await expect(service.merge(clusterId, clusterId, itemIds)).rejects.toThrow(/自己/);
      await cleanup([clusterId]);
    });
  });

  // ───────────────────── 频次口径（§9.6 两个计数器） ─────────────────────

  describe("freq / freq30d 两个计数器", () => {
    async function freq30dOf(clusterId: string): Promise<number> {
      const { items } = await service.list({ limit: 200, offset: 0 });
      return items.find((c) => c.id === clusterId)!.freq30d;
    }

    it("offline_run 计入 freq，但**不**计入 freq30d（021 决策 D）", async () => {
      const { clusterId } = await seedCluster({ items: [{ source: "offline_run" }] });
      expect(await freqOf(clusterId)).toBe(1);
      expect(await freq30dOf(clusterId)).toBe(0);
      await cleanup([clusterId]);
    });

    it("online 两个都算", async () => {
      const { clusterId } = await seedCluster({ items: [{ source: "online" }] });
      expect(await freq30dOf(clusterId)).toBe(1);
      await cleanup([clusterId]);
    });

    it("manual_trace 也算进 freq30d —— 它是人工发现的**真实线上流量**", async () => {
      // 谓词必须是 `<> 'offline_run'` 而不是 `= 'online'`（drill 二轮裁定）。
      // 写成 `= 'online'` 这条会红。
      const { clusterId } = await seedCluster({ items: [{ source: "manual_trace" }] });
      expect(await freq30dOf(clusterId)).toBe(1);
      await cleanup([clusterId]);
    });

    it("超过 30 天的 online 掉出 freq30d，但 freq 不减（原型 `:377`）", async () => {
      const { clusterId } = await seedCluster({
        items: [{ source: "online", traceStartTime: daysAgo(40) }],
      });
      expect(await freqOf(clusterId)).toBe(1);
      expect(await freq30dOf(clusterId)).toBe(0);
      await cleanup([clusterId]);
    });
  });

  // ───────────────────────── 读模型的两个易错口径 ─────────────────────────

  describe("读模型", () => {
    it("一个分数都没有的簇，avgQuality 是 null 而不是 0", async () => {
      const { clusterId } = await seedCluster({ items: [{}, {}] });
      const { items } = await service.list({ limit: 200, offset: 0 });
      expect(items.find((c) => c.id === clusterId)!.avgQuality).toBeNull();
      await cleanup([clusterId]);
    });

    it("avgQuality = 各成员「非空三分里的最小值」的均值（LEAST 忽略 NULL）", async () => {
      const { clusterId } = await seedCluster({
        items: [
          { faithfulness: 80, answerRelevancy: 60, contextPrecision: null }, // min = 60
          { faithfulness: null, answerRelevancy: null, contextPrecision: 40 }, // min = 40
          {}, // 全 NULL ⇒ 不参与均值，而不是当 0
        ],
      });
      const { items } = await service.list({ limit: 200, offset: 0 });
      expect(items.find((c) => c.id === clusterId)!.avgQuality).toBeCloseTo(50, 5);
      await cleanup([clusterId]);
    });

    /**
     * 分母**只算 online**，`offline_run` 与 `manual_trace` 都不进（与 `freq30d` 的谓词故意不同）。
     *
     * 手动入池的行 `follow_up_suspected` 恒为 false（拿不到 contextPrecision，也没有改写数据），
     * 放进分母只会稀释：本例若把两条非 online 都算进去就是 1/3 = 0.33 ≤ 0.5，
     * `triageCluster` 的强制 `retrieval` 覆写失效、根因翻回 `missing`
     * ⇒ 021 §6.4 要防的「把人力引去补一篇根本不缺的文档」正好发生。
     * 这条同时守住 `gap-ingest.ts:recomputeRootCause` 与本读模型两处口径一致。
     */
    it("followUpRatio 的分母只算 online（manual_trace / offline_run 都不稀释它）", async () => {
      const { clusterId } = await seedCluster({
        items: [
          { source: "online", followUpSuspected: true },
          { source: "offline_run", followUpSuspected: false },
          { source: "manual_trace", followUpSuspected: false },
        ],
      });
      const { items } = await service.list({ limit: 200, offset: 0 });
      expect(items.find((c) => c.id === clusterId)!.followUpRatio).toBeCloseTo(1, 5);
      await cleanup([clusterId]);
    });

    it("默认排序：待处理在前，然后 freq 倒序（原型 `:631`）", async () => {
      const low = await seedCluster({ status: "pending", items: [{}] });
      const high = await seedCluster({ status: "pending", centroid: VEC_E1, items: [{}, {}, {}] });
      const routed = await seedCluster({
        status: "routed_retrieval",
        centroid: VEC_E1,
        items: Array(9).fill({}),
      });

      const { items } = await service.list({ limit: 200, offset: 0 });
      const order = items.map((i) => i.id);
      expect(order.indexOf(high.clusterId)).toBeLessThan(order.indexOf(low.clusterId));
      // freq=9 的非 pending 簇仍排在 freq=1 的 pending 之后。
      expect(order.indexOf(low.clusterId)).toBeLessThan(order.indexOf(routed.clusterId));
      await cleanup([low.clusterId, high.clusterId, routed.clusterId]);
    });

    /**
     * 原型 §18.C `:707`：「忽略 → 默认列表隐藏(筛选可见)」。
     *
     * 不隐藏的话，屏5 的忽略确认框就在撒谎——它承诺「忽略后默认列表不再显示」，
     * 而那行其实原地不动、只有状态文字变了 ⇒ 用户以为没生效、重复点 ⇒ 撞非法迁移 400。
     */
    it("默认列表隐藏已忽略，显式筛选「已忽略」仍看得到", async () => {
      const open = await seedCluster({ status: "pending", items: [{}] });
      const ignored = await seedCluster({ status: "ignored", centroid: VEC_E1, items: [{}] });

      const def = await service.list({ limit: 200, offset: 0 });
      expect(def.items.map((i) => i.id)).toEqual([open.clusterId]);
      expect(def.total).toBe(1); // total 与列表同口径，不能只筛了行却报总数 2

      const filtered = await service.list({ status: "ignored", limit: 200, offset: 0 });
      expect(filtered.items.map((i) => i.id)).toEqual([ignored.clusterId]);
      await cleanup([open.clusterId, ignored.clusterId]);
    });
  });

  // ───────────────────────── 手动入池 ─────────────────────────

  describe("手动入池（原型 `:648`）", () => {
    it("同一条 trace 再入池一次：不插新行，返回 joinedExisting 与既有簇的频次", async () => {
      embedVector = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0));
      const first = await service.addItem({
        question: "能开专用发票吗",
        source: "manual_trace",
        sourceTraceId: "f".repeat(32),
      });
      expect(first.joinedExisting).toBe(false);
      expect(first.freq).toBe(1);

      const second = await service.addItem({
        question: "能开专用发票吗",
        source: "manual_trace",
        sourceTraceId: "f".repeat(32),
      });
      expect(second.joinedExisting).toBe(true);
      expect(second.clusterId).toBe(first.clusterId);
      expect(second.freq).toBe(1); // 没有重复计频
      expect(await itemCount(first.clusterId)).toBe(1);
      await cleanup([first.clusterId]);
    });

    it("入口页透传 traceStartTime ⇒ 该样本计入 freq30d（不传则只计累计 freq）", async () => {
      embedVector = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0));
      const withTime = await service.addItem({
        question: "能开专用发票吗",
        source: "manual_trace",
        sourceTraceId: "a".repeat(32),
        traceStartTime: daysAgo(3).toISOString(),
      });
      const { items } = await service.list({ limit: 200, offset: 0 });
      expect(items.find((c) => c.id === withTime.clusterId)!.freq30d).toBe(1);
      await cleanup([withTime.clusterId]);

      const without = await service.addItem({
        question: "能开专用发票吗",
        source: "manual_trace",
        sourceTraceId: "b".repeat(32),
      });
      const after = await service.list({ limit: 200, offset: 0 });
      expect(after.items.find((c) => c.id === without.clusterId)!.freq30d).toBe(0);
      expect(after.items.find((c) => c.id === without.clusterId)!.freq).toBe(1);
      await cleanup([without.clusterId]);
    });

    it("拒绝未来时间的 traceStartTime（否则该行永远留在 30 天窗口里）", async () => {
      embedVector = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0));
      await expect(
        service.addItem({
          question: "未来的问题",
          source: "manual_trace",
          sourceTraceId: "d".repeat(32),
          traceStartTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }),
      ).rejects.toThrow(/不能是未来时间/);
    });

    it("embedding 维度不是 1024 ⇒ 400，而不是让 pgvector 的原始错误冒成 500", async () => {
      embedVector = Array.from({ length: 1536 }, () => 0.1);
      await expect(
        service.addItem({
          question: "维度不对",
          source: "manual_trace",
          sourceTraceId: "c".repeat(32),
        }),
      ).rejects.toThrow(/维度不是 1024/);
      embedVector = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0));
    });

    it("手动入池标 rewriteResolved=false —— 保守默认，入集前要人工改写", async () => {
      embedVector = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0));
      const created = await service.addItem({
        question: "那个能开吗",
        source: "manual_trace",
        sourceTraceId: "e".repeat(32),
      });
      const items = await service.listItems(created.clusterId);
      expect(items[0].rewriteResolved).toBe(false);
      expect(items[0].rewrittenQuestion).toBeNull();
      // 取不到 trace 开始时间 ⇒ 不当作已过期（置灰会误导人以为链接失效）。
      expect(items[0].traceExpired).toBe(false);
      await cleanup([created.clusterId]);
    });
  });

  // ───────────────── B2b：质心 CAS 在真 SQL 上成立（021 §12②） ─────────────────

  describe("质心乐观并发校验（真 UPDATE ... WHERE freq = ?）", () => {
    it("expectedFreq 与库里不符时抛哨兵，且**整个事务回滚**——item 不留、freq 不涨", async () => {
      const { clusterId } = await seedCluster({ status: "pending", items: [{}, {}] });
      try {
        const freqBefore = await freqOf(clusterId);
        const itemsBefore = await itemCount(clusterId);

        // 传一个**过期**的 expectedFreq，等价于「读到 freq 之后、写之前被别人并入过」。
        await expect(
          repo.attachItem(
            {
              kind: "existing",
              clusterId,
              nextCentroid: Array.from({ length: 1024 }, () => 0.5),
              expectedFreq: freqBefore + 99,
            },
            {
              source: "manual_trace",
              sourceTraceId: "f".repeat(32),
              question: "并发写入的样本",
              rewrittenQuestion: null,
              rewriteResolved: false,
              embedding: Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0)),
              traceStartTime: null,
              faithfulness: null,
              answerRelevancy: null,
              contextPrecision: null,
              confidence: null,
              fallbackUsed: false,
              noCitations: false,
              followUpSuspected: false,
            },
            new Date(),
          ),
        ).rejects.toBeInstanceOf(GapCentroidStaleError);

        // 这条断言才是重点：抛错必须连带回滚，否则会留下「item 插了但 freq 没涨」的错账。
        expect(await freqOf(clusterId)).toBe(freqBefore);
        expect(await itemCount(clusterId)).toBe(itemsBefore);
      } finally {
        await cleanup([clusterId]);
      }
    });

    it("expectedFreq 正确时照常写入，质心确实被换成新值", async () => {
      const { clusterId } = await seedCluster({ status: "pending", items: [{}] });
      try {
        const freqBefore = await freqOf(clusterId);
        const nextCentroid = Array.from({ length: 1024 }, (_, i) => (i === 1 ? 1 : 0));

        const result = await repo.attachItem(
          { kind: "existing", clusterId, nextCentroid, expectedFreq: freqBefore },
          {
            source: "manual_trace",
            sourceTraceId: "0".repeat(32),
            question: "正常并入的样本",
            rewrittenQuestion: null,
            rewriteResolved: false,
            embedding: Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0)),
            traceStartTime: null,
            faithfulness: null,
            answerRelevancy: null,
            contextPrecision: null,
            confidence: null,
            fallbackUsed: false,
            noCitations: false,
            followUpSuspected: false,
          },
          new Date(),
        );

        // 不用 toEqual 全等：`AttachItemResult` 还带 `statusBeforeAttach`（复发判定要用），
        // 那是别的 story 的关切，本用例只管「并入成功且落到预期的簇」。
        expect(result).toMatchObject({ clusterId, inserted: true });
        expect(await freqOf(clusterId)).toBe(freqBefore + 1);
        const { rows } = await pool.query<{ centroid: string }>(
          `SELECT centroid::text AS centroid FROM gap_clusters WHERE id = $1`,
          [clusterId],
        );
        // 第 2 维为 1 即新质心已落库（旧的是 e0）。
        expect(rows[0].centroid.startsWith("[0,1,")).toBe(true);
      } finally {
        await cleanup([clusterId]);
      }
    });
  });
});
