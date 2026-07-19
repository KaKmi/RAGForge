import { Inject, Injectable } from "@nestjs/common";
import type { EvalCaseRef } from "@codecrush/contracts";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { DRIZZLE } from "../../platform/persistence/drizzle.constants";
import type { DB } from "../../platform/persistence/persistence.module";
import {
  evalCaseVersions,
  evalCases,
  evalSets,
  type EvalCaseRow,
  type EvalCaseVersionRow,
  type EvalSetRow,
  type GoldDocRefRow,
} from "./schema";

/** 用例内容的可变部分 —— 一次保存即一个不可变版本行（018 §10）。 */
export interface EvalCaseVersionContent {
  question: string;
  goldPoints: string[];
  /** F3：chunk 级 gold 引用（jsonb）。 */
  goldDocRefs: GoldDocRefRow[];
  tags: string[];
}

export interface NewEvalSetInput {
  name: string;
  description: string;
  kbIds: string[];
  createdBy: string;
}

export interface NewEvalCaseInput {
  setId: string;
  /** 来源 trace（从坏样本生成时带上；手建/CSV 导入为空）。 */
  sourceTraceId?: string;
  content: EvalCaseVersionContent;
}

/** 列表页聚合行 = 评测集 + DB 侧算好的用例统计与上次得分（原型 §5 的表格列）。 */
export type EvalSetAggregate = EvalSetRow & {
  caseCount: number;
  reviewedCaseCount: number;
  /** 当前版本标了 gold docs 的**存活**用例数（原型 §5「38/50」的分子）。 */
  withGoldDocs: number;
  lastRunScore: number | null;
  /** `lastRunScore === null` 的消歧位：跑过但没出分 vs 从未跑过（见 SET_AGG_SELECT）。 */
  hasCompletedRun: boolean;
};

/** 逻辑用例 + 其当前版本 —— DTO 组装需要两者（status 在身份行，内容在版本行）。 */
export interface EvalCaseWithVersion {
  case: EvalCaseRow;
  version: EvalCaseVersionRow;
}

/** run 发起时的候选快照条目（Story 5/6 消费；`seq` 即报告里的 # 列）。 */
export interface ReviewedCaseVersion {
  caseId: string;
  caseVersionId: string;
  question: string;
  goldPoints: string[];
  /** F2 检索指标消费的 gold 引用。 */
  goldDocRefs: GoldDocRefRow[];
  seq: number;
}

// 注意：drizzle 的 sql 模板里 `${evalSets.id}` 渲染成未限定的 `"id"`，在相关子查询中会被内层表
// 抢解析 —— 外层引用必须显式限定 "eval_sets"."id"（同 prompts.repository.ts:49-51 的坑）。
const SET_AGG_SELECT = {
  id: evalSets.id,
  name: evalSets.name,
  description: evalSets.description,
  kbIds: evalSets.kbIds,
  createdBy: evalSets.createdBy,
  createdAt: evalSets.createdAt,
  updatedAt: evalSets.updatedAt,
  deletedAt: evalSets.deletedAt,
  caseCount: sql<number>`(
    SELECT COUNT(*)::int FROM ${evalCases} c
    WHERE c.set_id = "eval_sets"."id" AND c.deleted_at IS NULL
  )`.as("case_count"),
  reviewedCaseCount: sql<number>`(
    SELECT COUNT(*)::int FROM ${evalCases} c
    WHERE c.set_id = "eval_sets"."id" AND c.deleted_at IS NULL AND c.status = 'reviewed'
  )`.as("reviewed_case_count"),
  withGoldDocs: sql<number>`(
    SELECT COUNT(*)::int FROM ${evalCases} c
    JOIN ${evalCaseVersions} v ON v.case_id = c.id AND v.version = c.current_version
    WHERE c.set_id = "eval_sets"."id" AND c.deleted_at IS NULL AND jsonb_array_length(v.gold_doc_refs) > 0
  )`.as("with_gold_docs"),
  /**
   * 原型 §5「上次得分」（`82.0` → 一位小数）。口径 = **最近一个有结果的终态 run** 的四指标
   * 非空均值：每个指标先按非 NULL 样本求 avg（AVG 天然忽略 NULL），再对**评出来的**指标求
   * 均值，最后四舍五入到一位小数 —— 与 `EvalRunListItem.overallScore` 同一量（contracts
   * eval-runs.ts:7-12 要求两处口径一致；Story 6 的报告聚合必须复用本表达式，勿另造）。
   * 四指标全 NULL（裁判全挂 / 全部超时）或无终态 run → NULL。**绝不退化成 0**。
   * `failed` 不计入：它没答出任何结果，不是「得分很低」（同 018 §12 取舍 2 的口径）。
   * ⚠️ NULL **不等于**「未运行」——两种成因的消歧信号是下面的 `hasCompletedRun`，
   * 前端据它选词（018 §12 缺口 16）。
   */
  lastRunScore: sql<number | null>`(
    SELECT ROUND(AVG(m.v)::numeric, 1)::float8
    FROM (
      SELECT AVG(res.faithfulness) AS f,
             AVG(res.answer_relevancy) AS r,
             AVG(res.context_precision) AS p,
             AVG(res.correctness) AS c
      FROM "eval_run_results" res
      WHERE res.run_id = (
        SELECT run.id FROM "eval_runs" run
        WHERE run.set_id = "eval_sets"."id"
          AND run.status IN ('done', 'partial', 'budget_stop')
        ORDER BY run.created_at DESC
        LIMIT 1
      )
    ) agg
    CROSS JOIN LATERAL unnest(ARRAY[agg.f, agg.r, agg.p, agg.c]) AS m(v)
  )`.as("last_run_score"),
  /**
   * `lastRunScore === null` 的消歧位（018 §12 缺口 16 / QA P2）：**跑过但没出分** ≠ **从未跑过**。
   * run population 必须与 `lastRunScore` **逐字一致**（`done|partial|budget_stop`，`failed` 不计）
   * ——否则会造出「hasCompletedRun=true 但 score 恒 NULL」的幻影态，把消歧位本身变成新的谎。
   */
  hasCompletedRun: sql<boolean>`EXISTS (
    SELECT 1 FROM "eval_runs" run
    WHERE run.set_id = "eval_sets"."id"
      AND run.status IN ('done', 'partial', 'budget_stop')
  )`.as("has_completed_run"),
} as const;

@Injectable()
export class EvalSetsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DB) {}

  async findSetById(id: string): Promise<EvalSetRow | undefined> {
    const rows = await this.db
      .select()
      .from(evalSets)
      .where(and(eq(evalSets.id, id), isNull(evalSets.deletedAt)))
      .limit(1);
    return rows[0];
  }

  /**
   * B1/F2：这条 trace 已进过哪些评测集（Trace 详情按钮的两态判据）。
   * 软删的用例与软删的集都不算——按钮会因此显示「加入评测集」而不是「已在评测集」，
   * 用户可以重新入集，这正是期望行为。
   */
  async findCaseRefsBySourceTrace(sourceTraceId: string): Promise<EvalCaseRef[]> {
    return this.db
      .select({ setId: evalCases.setId, setName: evalSets.name, caseId: evalCases.id })
      .from(evalCases)
      .innerJoin(evalSets, eq(evalSets.id, evalCases.setId))
      .where(
        and(
          eq(evalCases.sourceTraceId, sourceTraceId),
          isNull(evalCases.deletedAt),
          isNull(evalSets.deletedAt),
        ),
      )
      // 无 ORDER BY 时 PG 不保证顺序（计划变更/VACUUM 都会让它抖），
      // 前端「已在：集A、集B」的顺序会在刷新之间乱跳。与同文件 listCases:223 同一约定。
      .orderBy(asc(evalSets.name), asc(evalCases.createdAt), asc(evalCases.id));
  }

  /** 大小写不敏感查重（走 eval_sets_name_unique 的部分索引）。 */
  async findSetByName(name: string): Promise<EvalSetRow | undefined> {
    const rows = await this.db
      .select()
      .from(evalSets)
      .where(and(sql`lower(${evalSets.name}) = lower(${name})`, isNull(evalSets.deletedAt)))
      .limit(1);
    return rows[0];
  }

  /** 传 `setId` 取单行（改后回读），不传取全量（列表页，原型 §17.2：更新时间倒序）。 */
  async listAggregates(setId?: string): Promise<EvalSetAggregate[]> {
    const where = setId
      ? and(eq(evalSets.id, setId), isNull(evalSets.deletedAt))
      : isNull(evalSets.deletedAt);
    return await this.db
      .select(SET_AGG_SELECT)
      .from(evalSets)
      .where(where)
      .orderBy(sql`${evalSets.updatedAt} DESC`);
  }

  async insertSet(input: NewEvalSetInput): Promise<EvalSetRow> {
    const rows = await this.db.insert(evalSets).values(input).returning();
    return rows[0];
  }

  /** `updatedAt` 恒刷新 → patch 为空时 SET 子句也不会空（drizzle 空 set 会抛）。 */
  async updateSet(id: string, patch: Partial<EvalSetRow>): Promise<EvalSetRow | undefined> {
    const rows = await this.db
      .update(evalSets)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(evalSets.id, id), isNull(evalSets.deletedAt)))
      .returning();
    return rows[0];
  }

  /** 软删（原型 §5：被历史 run 引用的做软删，报告仍可回看）。返回 false = 不存在/已删。 */
  async softDeleteSet(id: string): Promise<boolean> {
    const rows = await this.db
      .update(evalSets)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(evalSets.id, id), isNull(evalSets.deletedAt)))
      .returning({ id: evalSets.id });
    return rows.length > 0;
  }

  /** 存活用例 + 各自当前版本，按创建时间稳定排序（id 兜同刻并列）。 */
  async listCases(setId: string): Promise<EvalCaseWithVersion[]> {
    return await this.db
      .select({ case: evalCases, version: evalCaseVersions })
      .from(evalCases)
      .innerJoin(
        evalCaseVersions,
        and(
          eq(evalCaseVersions.caseId, evalCases.id),
          eq(evalCaseVersions.version, evalCases.currentVersion),
        ),
      )
      .where(and(eq(evalCases.setId, setId), isNull(evalCases.deletedAt)))
      .orderBy(asc(evalCases.createdAt), asc(evalCases.id));
  }

  async findCase(setId: string, caseId: string): Promise<EvalCaseWithVersion | undefined> {
    const rows = await this.db
      .select({ case: evalCases, version: evalCaseVersions })
      .from(evalCases)
      .innerJoin(
        evalCaseVersions,
        and(
          eq(evalCaseVersions.caseId, evalCases.id),
          eq(evalCaseVersions.version, evalCases.currentVersion),
        ),
      )
      .where(and(eq(evalCases.setId, setId), eq(evalCases.id, caseId), isNull(evalCases.deletedAt)))
      .limit(1);
    return rows[0];
  }

  // 身份行 + v1 同事务（两步分离会在第二步失败时留下无版本的用例 —— listCases 的
  // innerJoin 会直接把它吞掉，成为查不到也删不掉的幽灵行）。
  async insertCaseWithVersion(input: NewEvalCaseInput): Promise<EvalCaseWithVersion> {
    return await this.db.transaction(async (tx) => {
      const created = (
        await tx
          .insert(evalCases)
          .values({ setId: input.setId, sourceTraceId: input.sourceTraceId ?? null })
          .returning()
      )[0];
      const version = (
        await tx
          .insert(evalCaseVersions)
          .values({ caseId: created.id, version: 1, ...input.content })
          .returning()
      )[0];
      return { case: created, version };
    });
  }

  /**
   * 追加不可变版本 v+1（旧版本冻结供历史 run 引用 —— 原型 §18.B）**并**推进身份行，
   * 同一事务（peer review P2）。
   *
   * 两步分离会造成**永久性损坏**，不只是短暂不一致：若版本行插入成功而 `currentVersion`
   * 没跟上，`findCase` 按 `version = currentVersion`（仍是旧值）取到旧版本 →
   * 用户重试时重新算出同一个 v+1 → 撞 `eval_case_versions_case_version_unique` →
   * **此后每次编辑都必失败**，只能手工 SQL 修。
   * （`insertCaseWithVersion` 早已按此理由用事务；这条路径当初漏了。）
   */
  async appendCaseVersionAndPatch(
    caseId: string,
    version: number,
    content: EvalCaseVersionContent,
    patch: Partial<EvalCaseRow>,
  ): Promise<EvalCaseWithVersion> {
    return await this.db.transaction(async (tx) => {
      const inserted = (
        await tx
          .insert(evalCaseVersions)
          .values({ caseId, version, ...content })
          .returning()
      )[0];
      const rows = await tx
        .update(evalCases)
        .set(patch)
        .where(and(eq(evalCases.id, caseId), isNull(evalCases.deletedAt)))
        .returning();
      // 并发软删会让这里匹配 0 行 —— 抛出即回滚掉上面的版本行，不留孤儿。
      if (!rows[0]) throw new Error(`eval case ${caseId} missing`);
      return { case: rows[0], version: inserted };
    });
  }

  /**
   * B1/F4：把引用了该 docId 的**当前版本**用例标为「gold 可能过期」。
   *
   * 原型 §18.B：「态不变 + gold-stale 标志」——只动标志位，**不动** status / currentVersion，
   * 更**绝不**改 gold 内容（原型 §7：「不自动改 gold，人工确认」）。文档变了不代表 gold 就错了，
   * 自动改写会把人工审过的标准答案悄悄换掉，那比过期更糟。
   *
   * 匹配走 jsonb 包含 `@>`：`gold_doc_refs` 是 `[{docId, chunkId, docName, section}]`，
   * `@> '[{"docId": "..."}]'` 只比对 docId 一个键，chunkId/docName/section 任意。
   * 子查询钉 `v.version = c.current_version`：历史版本引用过该文档不算数——
   * 用例早就改到别的文档了，不该因为一份它已经不引用的文档变更而被标过期。
   */
  async markGoldStaleByDocId(docId: string): Promise<number> {
    const result = await this.db
      .update(evalCases)
      .set({ goldStale: true })
      .where(
        and(
          isNull(evalCases.deletedAt),
          sql`EXISTS (
            SELECT 1 FROM ${evalCaseVersions} v
             WHERE v.case_id = ${evalCases.id}
               AND v.version = ${evalCases.currentVersion}
               AND v.gold_doc_refs @> ${JSON.stringify([{ docId }])}::jsonb
          )`,
        ),
      );
    return result.rowCount ?? 0;
  }

  /** B1/F4：人工「确认仍有效」——只清标志，不产生新版本（内容根本没变）。 */
  async clearGoldStale(setId: string, caseId: string): Promise<EvalCaseRow | null> {
    const [row] = await this.db
      .update(evalCases)
      .set({ goldStale: false })
      .where(
        and(
          eq(evalCases.id, caseId),
          eq(evalCases.setId, setId),
          isNull(evalCases.deletedAt),
        ),
      )
      .returning();
    return row ?? null;
  }

  async updateCase(caseId: string, patch: Partial<EvalCaseRow>): Promise<EvalCaseRow> {
    const rows = await this.db
      .update(evalCases)
      .set(patch)
      .where(and(eq(evalCases.id, caseId), isNull(evalCases.deletedAt)))
      .returning();
    if (!rows[0]) throw new Error(`eval case ${caseId} missing`);
    return rows[0];
  }

  async softDeleteCase(setId: string, caseId: string): Promise<boolean> {
    const rows = await this.db
      .update(evalCases)
      .set({ deletedAt: new Date() })
      .where(and(eq(evalCases.setId, setId), eq(evalCases.id, caseId), isNull(evalCases.deletedAt)))
      .returning({ id: evalCases.id });
    return rows.length > 0;
  }

  /**
   * run 候选集（Story 6 消费）：只取**已审核且存活**用例的**当前版本**
   * —— 原型 §18.B「draft 不参与 run」。顺序与 `listCases` 一致，`seq` 即报告 # 列。
   *
   * 三重存活校验，缺一不可（peer review P2）：
   *  · `evalCases.deletedAt` —— 用例自身软删；
   *  · `evalSets.deletedAt` —— **集软删不级联到用例行**（`softDeleteSet` 只改 eval_sets），
   *    不 join 过滤的话，一个已删的集照样能吐出 run 候选，等于「删了还能跑」；
   *  · `status='reviewed'`。
   */
  async listReviewedCaseVersions(setId: string): Promise<ReviewedCaseVersion[]> {
    const rows = await this.db
      .select({
        caseId: evalCases.id,
        caseVersionId: evalCaseVersions.id,
        question: evalCaseVersions.question,
        goldPoints: evalCaseVersions.goldPoints,
        goldDocRefs: evalCaseVersions.goldDocRefs,
      })
      .from(evalCases)
      .innerJoin(
        evalCaseVersions,
        and(
          eq(evalCaseVersions.caseId, evalCases.id),
          eq(evalCaseVersions.version, evalCases.currentVersion),
        ),
      )
      .innerJoin(evalSets, eq(evalSets.id, evalCases.setId))
      .where(
        and(
          eq(evalCases.setId, setId),
          eq(evalCases.status, "reviewed"),
          isNull(evalCases.deletedAt),
          isNull(evalSets.deletedAt),
        ),
      )
      .orderBy(asc(evalCases.createdAt), asc(evalCases.id));
    return rows.map((row, index) => ({ ...row, seq: index + 1 }));
  }
}
