import { z } from "zod";

const isoString = z.string().datetime({ offset: true });
const uuid = z.string().uuid();

/**
 * chunk 级 gold 引用（E-W2b F3）。docName/section 为**保存时快照**，供 UI tag 显示，
 * 不回查文档表——文档删了 tag 仍可读。`chunkId=null` 表示文档级引用（0021 遗留 gold_doc_ids
 * 迁移而来 / CSV 导入），F2 检索指标按 docId 匹配；`chunkId` 非空则按 chunkId 精确匹配。
 */
export const GoldDocRefSchema = z.object({
  docId: uuid,
  chunkId: uuid.nullable(),
  docName: z.string(),
  section: z.string().nullable(),
});
export type GoldDocRef = z.infer<typeof GoldDocRefSchema>;

/** 原型 §18.B：用例只有两态；`reviewed` 编辑保存后仍是 `reviewed`（v+1），不回退 draft。 */
export const EvalCaseStatusSchema = z.enum(["draft", "reviewed"]);
export type EvalCaseStatus = z.infer<typeof EvalCaseStatusSchema>;

/** §19.1：名称 1-50 字，全局唯一（唯一性在 service 层查重，返回「名称已存在」）。 */
export const CreateEvalSetRequestSchema = z.object({
  // trim 后再校验：§19.1 的「请输入名称」意在拒绝空名，纯空白同样是空名；
  // 且空白名会在 lower(name) 唯一索引里占一个独立槽位。
  name: z.string().trim().min(1).max(50),
  description: z.string().max(500).optional(),
  kbIds: z.array(uuid).default([]),
});
export type CreateEvalSetRequest = z.infer<typeof CreateEvalSetRequestSchema>;

/**
 * PATCH 语义：**不可**用 `CreateEvalSetRequestSchema.partial()` —— `.partial()` 只让键可选，
 * 不会去掉 `kbIds` 上的 `.default([])`；于是 `parse({ name: "新名字" })` 会吐出
 * `{ name, kbIds: [] }`，一次纯改名就把关联知识库**清空**（原型 §5：kbIds 是 LLM 生成与
 * 统计口径的依据）。故显式重声明为全 optional、无 default。
 */
export const UpdateEvalSetRequestSchema = z.object({
  name: z.string().trim().min(1).max(50).optional(),
  description: z.string().max(500).optional(),
  kbIds: z.array(uuid).optional(),
});
export type UpdateEvalSetRequest = z.infer<typeof UpdateEvalSetRequestSchema>;

export const EvalSetSchema = z.object({
  id: uuid,
  name: z.string().min(1).max(50),
  description: z.string(),
  kbIds: z.array(uuid),
  caseCount: z.number().int().nonnegative(),
  reviewedCaseCount: z.number().int().nonnegative(),
  /**
   * gold docs 覆盖率（原型 §5「38/50」）。**分母 = 用例总数（`caseCount`），不是已审用例数**
   * ——原型该表「售后核心 50 题」行 用例=50 / gold docs=38/50，「高频 Badcase 集」行
   * 用例=34 / gold docs=0/34：两行分母都等于用例列。§5 又说从坏样本生成的用例状态是
   * 「待审核」，若分母取已审数，Badcase 集应显示 0/0 而非原型的 0/34。
   * W2a 只展示不消费（决策 E）。
   */
  goldDocCoverage: z.object({
    withGoldDocs: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
  /** 原型 §5 显示「82.0」→ 一位小数，非整数。与 `EvalRunListItem.overallScore` 同一量，口径须一致。 */
  lastRunScore: z.number().min(0).max(100).nullable(),
  /**
   * 是否存在**有结果的终态 run**（`done|partial|budget_stop`——与 `lastRunScore` 取的是
   * 同一个 run population；`failed` 不计入，见 018 §12 缺口 12）。
   *
   * **存在的唯一理由是给 `lastRunScore === null` 消歧**（018 §12 缺口 16 / QA P2）：NULL 有
   * 两种成因——「从未跑过」与「跑过但一个分都没评出来」（裁判全挂 / 全部超时）。屏2 原先
   * 对两者一律显示「未运行」，于是一个刚跑完 5 次 run 的集合被断言成「没跑过」——**词在说谎**。
   * 这正是 018 §12 缺口 2 在屏3 用 `verdict` + 覆盖率解决过、却在屏2 漏掉的同一类问题。
   * ⇒ `false` → 「未运行」；`true` + score NULL → 「未出分」。**绝不退化成 0**。
   */
  hasCompletedRun: z.boolean(),
  createdAt: isoString,
  updatedAt: isoString,
});
export type EvalSet = z.infer<typeof EvalSetSchema>;

export const EvalSetListResponseSchema = z.array(EvalSetSchema);
export type EvalSetListResponse = z.infer<typeof EvalSetListResponseSchema>;

/**
 * §19.1：问题 1-500；gold 要点每条 ≤200（draft 可空，reviewed 要求 ≥1 —— service 层校验，
 * 因两态阈值不同，DB check 表达不了）；gold 文档 ≤10；标签 ≤5 个、每个 ≤12 字。
 */
export const CreateEvalCaseRequestSchema = z.object({
  // trim 后再校验：§19.1「问题不能为空」——纯空白同样是空。
  question: z.string().trim().min(1).max(500),
  // gold 要点同样 trim：纯空白要点会**满足**「reviewed 要求 ≥1 条」这条不变式，
  // 于是一条「已审核但唯一 gold 要点是空白」的用例会进 run 候选集，correctness 实际无从判起。
  // csv-import.ts:58-63 早已在导入路径堵了同类漏洞（纯分隔符 `;;;` → 僵尸用例），
  // 直连 API 路径当初漏了。
  goldPoints: z.array(z.string().trim().min(1).max(200)).default([]),
  // §19.1：≤10 个引用（F3：chunk 级）。
  goldDocRefs: z.array(GoldDocRefSchema).max(10).default([]),
  tags: z.array(z.string().min(1).max(12)).max(5).default([]),
  sourceTraceId: z
    .string()
    .regex(/^[a-f0-9]{32}$/i)
    .optional(),
});
export type CreateEvalCaseRequest = z.infer<typeof CreateEvalCaseRequestSchema>;

/** 内容字段改动 → 新建不可变版本；status 单独走（审核通过）。 */
export const UpdateEvalCaseRequestSchema = z.object({
  question: z.string().trim().min(1).max(500).optional(),
  goldPoints: z.array(z.string().trim().min(1).max(200)).optional(),
  // Update 里必须显式 .optional() 无 default——防纯改名把 gold 清空（同 UpdateEvalSetRequest 教训 :20-31）。
  goldDocRefs: z.array(GoldDocRefSchema).max(10).optional(),
  tags: z.array(z.string().min(1).max(12)).max(5).optional(),
  status: EvalCaseStatusSchema.optional(),
});
export type UpdateEvalCaseRequest = z.infer<typeof UpdateEvalCaseRequestSchema>;

export const EvalCaseSchema = z.object({
  id: uuid,
  setId: uuid,
  version: z.number().int().positive(),
  status: EvalCaseStatusSchema,
  question: z.string(),
  goldPoints: z.array(z.string()),
  goldDocRefs: z.array(GoldDocRefSchema),
  tags: z.array(z.string()),
  sourceTraceId: z.string().nullable(),
  /** 原型 §18.B。W2a 建列不建检测器 → 恒 false，UI 不显示橙 tag（018 已知缺口 4）。 */
  goldStale: z.boolean(),
  createdAt: isoString,
});
export type EvalCase = z.infer<typeof EvalCaseSchema>;

export const EvalCaseListResponseSchema = z.array(EvalCaseSchema);
export type EvalCaseListResponse = z.infer<typeof EvalCaseListResponseSchema>;

/**
 * CSV 在前端解析（决策 D13：后端无文件上传基建，且 contracts 只依赖 zod → multipart 无法用
 * Zod DTO 表达）。§19.1：≤1000 行，必列 question/gold_answer。
 *
 * **两级校验，边界划在「该行拒 vs 整批拒」上**（原型 §17.2 逐字：
 * 「逐行校验：缺 question/gold_answer **该行拒**；>1000 行**整批拒**」）：
 *
 * - **本 DTO 只管「整批拒」与结构/体量**：`.max(1000)` 就是原型说的整批拒；
 *   各字段只留远高于业务上限的 DoS 兜底长度，**故意不写 `.min(1)`/`.max(500)`**。
 * - **业务规则（500/200/≤10/≤5/≤12 字）走 service 的 `parseImportRows`**，
 *   逐行产出「第 N 行缺少 gold_answer」式回执（原型 §5「错误行标红下载回执」）。
 *
 * ⚠️ 曾经在这里写 `goldAnswer: z.string().min(1)` —— 那会让**缺字段的行在 DTO 就 safeParse 失败
 * → 整批 400**，用户永远拿不到逐行回执，与 §17.2 的「该行拒」直接冲突。改坏过一次，勿回退。
 */
export const ImportEvalCasesRequestSchema = z.object({
  rows: z
    .array(
      z.object({
        question: z.string().max(2000),
        goldAnswer: z.string().max(5000),
        goldDocs: z.string().max(1000).optional(),
        tags: z.string().max(200).optional(),
      }),
    )
    .min(1)
    .max(1000),
});
export type ImportEvalCasesRequest = z.infer<typeof ImportEvalCasesRequestSchema>;

export const ImportEvalCasesResponseSchema = z.object({
  imported: z.number().int().nonnegative(),
  errors: z.array(z.object({ row: z.number().int().positive(), message: z.string() })),
});
export type ImportEvalCasesResponse = z.infer<typeof ImportEvalCasesResponseSchema>;

/** B1/F2：Trace 详情「加入评测集」按钮的两态判据——该 trace 已进过哪些集。 */
export const EvalCaseRefSchema = z.strictObject({
  setId: z.string().min(1),
  setName: z.string().min(1),
  caseId: z.string().min(1),
});
export type EvalCaseRef = z.infer<typeof EvalCaseRefSchema>;
export const EvalCaseRefListResponseSchema = z.array(EvalCaseRefSchema);
export type EvalCaseRefListResponse = z.infer<typeof EvalCaseRefListResponseSchema>;

export const EvalCaseRefQuerySchema = z.strictObject({
  sourceTraceId: z.string().regex(/^[a-f0-9]{32}$/i),
});
export type EvalCaseRefQuery = z.infer<typeof EvalCaseRefQuerySchema>;
