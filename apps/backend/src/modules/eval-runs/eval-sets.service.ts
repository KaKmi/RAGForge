import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import type {
  CreateEvalCaseRequest,
  CreateEvalSetRequest,
  EvalCase,
  EvalCaseRef,
  EvalCaseStatus,
  EvalSet,
  ImportEvalCasesRequest,
  ImportEvalCasesResponse,
  UpdateEvalCaseRequest,
  UpdateEvalSetRequest,
} from "@codecrush/contracts";
import { parseImportRows } from "./csv-import";
import {
  EvalSetsRepository,
  type EvalCaseVersionContent,
  type EvalCaseWithVersion,
  type EvalSetAggregate,
} from "./eval-sets.repository";
import type { EvalCaseRow, EvalSetRow } from "./schema";

function toEvalSet(row: EvalSetAggregate): EvalSet {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    kbIds: row.kbIds,
    caseCount: row.caseCount,
    reviewedCaseCount: row.reviewedCaseCount,
    // 分母 = 用例**总数**，不是已审数 —— 原型 §5「高频 Badcase 集」用例=34 且全待审，
    // gold docs 仍显示 0/34（详见 contracts eval-sets.ts:40-46 的口径说明）。
    goldDocCoverage: { withGoldDocs: row.withGoldDocs, total: row.caseCount },
    lastRunScore: row.lastRunScore,
    hasCompletedRun: row.hasCompletedRun,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toEvalCase({ case: row, version }: EvalCaseWithVersion): EvalCase {
  return {
    id: row.id,
    setId: row.setId,
    version: version.version,
    // varchar → enum 的直接断言：DB 侧 `eval_cases_status_check` 已把值域钉死在两态
    // （同 documents.service.ts:278 `row.status as Document["status"]` 的既有做法）。
    status: row.status as EvalCaseStatus,
    question: version.question,
    goldPoints: version.goldPoints,
    goldDocRefs: version.goldDocRefs,
    tags: version.tags,
    sourceTraceId: row.sourceTraceId,
    goldStale: row.goldStale,
    createdAt: row.createdAt.toISOString(),
  };
}

@Injectable()
export class EvalSetsService {
  constructor(private readonly repo: EvalSetsRepository) {}

  /** B1/F2：这条 trace 已进过哪些评测集（Trace 详情按钮两态）。未入集返回 []，不是 null。 */
  async findCaseRefsBySourceTrace(sourceTraceId: string): Promise<EvalCaseRef[]> {
    return this.repo.findCaseRefsBySourceTrace(sourceTraceId);
  }

  async list(): Promise<EvalSet[]> {
    return (await this.repo.listAggregates()).map(toEvalSet);
  }

  async create(req: CreateEvalSetRequest, actor: string): Promise<EvalSet> {
    await this.requireNameFree(req.name);
    const row = await this.repo.insertSet({
      name: req.name,
      description: req.description ?? "",
      kbIds: req.kbIds,
      createdBy: actor,
    });
    // 新建集必然 0 用例、0 run —— 直接构造零值聚合，省一次回读。
    return toEvalSet({
      ...row,
      caseCount: 0,
      reviewedCaseCount: 0,
      withGoldDocs: 0,
      lastRunScore: null,
      hasCompletedRun: false,
    });
  }

  /**
   * PATCH 语义：**只改真正传了的字段**。`UpdateEvalSetRequestSchema` 是全 optional 且无
   * default（contracts eval-sets.ts:20-30），故 `kbIds` 缺省 = 不动，**不是清空**。
   */
  async update(id: string, req: UpdateEvalSetRequest): Promise<EvalSet> {
    const existing = await this.requireSet(id);
    // 改回同名（含仅大小写变化）不该撞自己 —— 唯一索引比的是 lower(name)。
    if (req.name !== undefined && req.name.toLowerCase() !== existing.name.toLowerCase()) {
      await this.requireNameFree(req.name);
    }
    const patch: Partial<EvalSetRow> = {};
    if (req.name !== undefined) patch.name = req.name;
    if (req.description !== undefined) patch.description = req.description;
    if (req.kbIds !== undefined) patch.kbIds = req.kbIds;
    await this.repo.updateSet(id, patch);
    // 回读聚合行：用例统计/上次得分只有 DB 算得出。
    const [aggregate] = await this.repo.listAggregates(id);
    if (!aggregate) throw new NotFoundException("评测集不存在");
    return toEvalSet(aggregate);
  }

  /** 软删（原型 §19.2：「删除后列表不再显示；历史报告仍可查看。」）。 */
  async remove(id: string): Promise<void> {
    if (!(await this.repo.softDeleteSet(id))) throw new NotFoundException("评测集不存在");
  }

  async listCases(setId: string): Promise<EvalCase[]> {
    await this.requireSet(setId);
    return (await this.repo.listCases(setId)).map(toEvalCase);
  }

  /**
   * 新建即 draft（原型 §18.B：「新建/导入/坏样本生成 → draft(待审核)」，不参与 run）。
   * gold 要点可空 —— §5 的渐进式标注：先只标 gold answer，reviewed 时才要求 ≥1 条。
   * `_actor`：`eval_cases` 无 created_by 列（schema.ts 已定稿，本故事不可改）；参数保留以
   * 对齐 controller 调用面与 Story 5「从坏样本生成」的同签名调用。
   */
  async createCase(setId: string, req: CreateEvalCaseRequest, _actor: string): Promise<EvalCase> {
    await this.requireSet(setId);
    const created = await this.repo.insertCaseWithVersion({
      setId,
      sourceTraceId: req.sourceTraceId,
      content: {
        question: req.question,
        goldPoints: req.goldPoints,
        goldDocRefs: req.goldDocRefs,
        tags: req.tags,
      },
    });
    return toEvalCase(created);
  }

  /**
   * 内容字段有改动 → 追加不可变版本 v+1 并推进 currentVersion；**status 不变**
   * （原型 §18.B：`reviewed --编辑保存--> reviewed(新版本 v+1)`，不回退 draft）。
   */
  async updateCase(setId: string, caseId: string, req: UpdateEvalCaseRequest): Promise<EvalCase> {
    const found = await this.repo.findCase(setId, caseId);
    if (!found) throw new NotFoundException("用例不存在");
    const { case: row, version } = found;

    const hasContentChange =
      req.question !== undefined ||
      req.goldPoints !== undefined ||
      req.goldDocRefs !== undefined ||
      req.tags !== undefined;
    // 未传的内容字段沿用当前版本 —— 版本行是全量快照，不是增量。
    const nextContent: EvalCaseVersionContent = {
      question: req.question ?? version.question,
      goldPoints: req.goldPoints ?? version.goldPoints,
      goldDocRefs: req.goldDocRefs ?? version.goldDocRefs,
      tags: req.tags ?? version.tags,
    };

    // 守卫先于任何写入：否则「改内容 + 转 reviewed 但 gold 空」会先落一个新版本再抛 422,
    // 留下 currentVersion 没跟上的孤儿版本行。校验对象是**新内容**，不是库里的旧内容。
    //
    // `req.status ?? row.status` —— 这是**状态不变式**，不是转移守卫（peer review P1）：
    // 「`reviewed` 要求 ≥1 gold 要点」（§19.1 + schema.ts 的列注释）说的是「凡 reviewed 的
    // 用例都必须有 gold」，而不只是「转成 reviewed 的那一刻要有」。
    // 曾经写 `req.status === "reviewed"` → 只在请求**显式带 status** 时才校验 →
    // 对一条已 reviewed 的用例 `PATCH {goldPoints: []}` 可以把 gold 清空且**仍是 reviewed**，
    // 于是 listReviewedCaseVersions 会把一条**无 gold 可对照**的用例喂给 run 引擎，
    // correctness 永远评不出来。勿回退。
    const nextStatus = req.status ?? row.status;
    if (nextStatus === "reviewed" && nextContent.goldPoints.length === 0) {
      throw new UnprocessableEntityException("至少填写 1 个答案要点"); // §19.1 逐字
    }

    const patch: Partial<EvalCaseRow> = {};
    if (req.status !== undefined) patch.status = req.status;

    if (hasContentChange) {
      patch.currentVersion = row.currentVersion + 1;
      // 原型 §18.B：「编辑产生新版本自动清」gold-stale 标志。
      if (row.goldStale) patch.goldStale = false;
      // 版本行 + 身份行同事务：分两步会在中间失败时把用例永久卡死（见 repository 注释）。
      const next = await this.repo.appendCaseVersionAndPatch(
        caseId,
        row.currentVersion + 1,
        nextContent,
        patch,
      );
      return toEvalCase(next);
    }

    // 纯 status 变更（审核通过）：不产生新版本。
    const updated = Object.keys(patch).length ? await this.repo.updateCase(caseId, patch) : row;
    return toEvalCase({ case: updated, version });
  }

  async removeCase(setId: string, caseId: string): Promise<void> {
    if (!(await this.repo.softDeleteCase(setId, caseId))) throw new NotFoundException("用例不存在");
  }

  /**
   * B1/F4：文档变更 → 把引用它的用例标「gold 可能过期」。
   *
   * 由 `GoldStaleNotifier` 经 documents 侧的注册表回调进来（documents 不认识 eval 域）。
   * 返回受影响行数，仅供调用方记日志——通知失败不影响文档主流程。
   */
  async markGoldStaleByDocId(docId: string): Promise<number> {
    return await this.repo.markGoldStaleByDocId(docId);
  }

  /**
   * B1/F4：人工「确认仍有效」（原型 §18.B）。只清标志位，**不产生新版本**——
   * gold 内容一个字都没改，凭空升一个版本会污染版本史，也会让历史 run 的引用变得难读。
   */
  async confirmGold(setId: string, caseId: string): Promise<EvalCase> {
    const cleared = await this.repo.clearGoldStale(setId, caseId);
    if (!cleared) throw new NotFoundException("用例不存在");
    // 再查一次不是多余：clearGoldStale 只 returning 身份行（eval_cases），
    // 而 EvalCase 响应还需要**当前版本行**的内容（question/goldPoints/goldDocRefs/tags）。
    // 第二个 404 分支实际只在「清完标志的同一瞬间被软删」这一交错下命中——
    // 那时标志位已清但行正在消失，返回 404 是对的。
    const found = await this.repo.findCase(setId, caseId);
    if (!found) throw new NotFoundException("用例不存在");
    return toEvalCase(found);
  }

  /**
   * 逐行校验 → 合法行建 draft 用例，非法行进回执（原型 §17.2：「逐行校验：缺 question/
   * gold_answer 该行拒」—— 是**该行**拒，不是整批拒）。
   * 逐条插入（每行一事务）：≤1000 行（§19.1）下可接受，且与「错误行不阻断其余行」的
   * 行级语义天然一致 —— 批量单事务会让任一 DB 错误回滚掉所有合法行。
   */
  async importCases(
    setId: string,
    rows: ImportEvalCasesRequest["rows"],
    _actor: string,
  ): Promise<ImportEvalCasesResponse> {
    await this.requireSet(setId);
    const { valid, errors } = parseImportRows(rows);
    for (const { parsed } of valid) {
      await this.repo.insertCaseWithVersion({ setId, content: parsed });
    }
    return { imported: valid.length, errors };
  }

  private async requireSet(id: string): Promise<EvalSetRow> {
    const row = await this.repo.findSetById(id);
    if (!row) throw new NotFoundException("评测集不存在");
    return row;
  }

  private async requireNameFree(name: string): Promise<void> {
    if (await this.repo.findSetByName(name)) throw new ConflictException("名称已存在"); // §19.1 逐字
  }
}
