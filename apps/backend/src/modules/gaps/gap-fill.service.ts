import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { z } from "zod";
import type { GapCluster, GapFillDraft, SubmitFillRequest } from "@codecrush/contracts";
import { DocumentsService } from "../documents/documents.service";
import { EvaluationsRepository } from "../evaluations/evaluations.repository";
import { parseJudgeOutput, structuredOutput } from "../evaluations/evaluation-judge.utils";
import { KnowledgeBasesRepository } from "../knowledge-bases/knowledge-bases.repository";
import { ModelsService } from "../models/models.service";
import { GapsService } from "./gaps.service";

/**
 * `[补知识库]` 三步向导的服务端（021 决策 I，原型 §9 `:367` / §17.5 `:633`）。
 *
 * 三步与状态一一对应：
 *  ① `startDraft` → `drafting`：LLM 草拟一条候选问答；
 *  ② 人审编辑（前端改 Q/A、选目标 KB 与验证应用）→ 状态停在 `reviewing`；
 *  ③ `submitFill` → `filled`：把人审后的内容包成一份文档交给**现有**上传/切片/embedding 管线。
 *
 * ⛔ **产品红线：无人审不入库**（原型 `:367`/§1 非目标 `:108`：「自动无人审入库」明列为不做）。
 * 本类的结构保证了这一点——`submitFill` 是唯一调用 `documentsService.upload` 的地方，
 * 而它只能从 `reviewing` 态进入（`TRANSITIONS` 裁定），`reviewing` 又只能由 `draftReady` 到达。
 * 即便用户一个字都没改，也必须**走过**人审这一态。
 * 改动本文件时不要为了「省一步」把草拟与入库串成一次调用——那就把红线拆了。
 */

/**
 * 草拟输出。Q/A 的长度上限对齐原型 §19.1（`:746-748`：Q 1–200 字、A 1–2000 字）
 * 与 `gap_clusters.fill_draft_question` 的列宽。模型多给少给都当失败重问，不做截断兜底：
 * 一个被截断的答案读起来仍然像完整答案，人审时最容易放过去。
 */
const DraftFillOutputSchema = z.strictObject({
  question: z.string().trim().min(1).max(200),
  answer: z.string().trim().min(1).max(2000),
});

const DRAFT_FILL_OUTPUT = structuredOutput("gap_fill_draft_v1", DraftFillOutputSchema);

/**
 * 草拟 prompt。**输入只有代表问题**——这是一处已知的、相对原型措辞的落差，必须如实标注：
 *
 * 原型 `:367` 写的是「A = 基于簇内 trace 已召回内容」。但 `gap_items` 根本不存原始回答，
 * 更不存召回片段正文；要拿到它们得新增 `gaps → traces` / `gaps → chunks` 两条边，
 * 都是 021 决策 A 明令禁止的。同域既有的 `draftGold`（`gap-promote.service.ts`）也是
 * 同样的约束——契约上留了可选的 `answer` 字段，实际调用方从来没传过。
 *
 * 因此草拟出的答案**必然**是模型自身知识的产物，UI 上标「来源未确认」（原型自己就要求这个标签），
 * 并由人审这一步兜底。prompt 里也**明说**「你不掌握该组织的内部资料」，
 * 免得模型用笃定的语气编出一段像是查过资料的内容——那比明显的胡说更难被人审发现。
 */
const DRAFT_FILL_SYSTEM_PROMPT = [
  "你在为一个企业知识库起草**候选**问答条目，用于补全一个已知的知识缺口。",
  "重要前提：你并不掌握该组织的内部资料，你写的内容一定会先经过人工审核与编辑才可能入库。",
  "因此：只写你有把握的通用常识与合理的行文骨架；凡是涉及具体数字、期限、金额、流程细节的地方，",
  "用「（待确认）」占位，不要编造看起来精确的事实。",
  "question 字段：把给定的问题整理成清晰、可独立检索的书面问法，不超过 200 字。",
  "answer 字段：给出结构清晰的回答草稿，不超过 2000 字。",
  "只返回 JSON，不要 markdown 代码围栏。",
].join("\n");

@Injectable()
export class GapFillService {
  private readonly logger = new Logger(GapFillService.name);

  constructor(
    private readonly gaps: GapsService,
    private readonly documents: DocumentsService,
    private readonly knowledgeBases: KnowledgeBasesRepository,
    private readonly evaluations: EvaluationsRepository,
    private readonly models: ModelsService,
  ) {}

  /**
   * 第①步：转 `drafting`（顺带快照当下质量分），调 LLM 草拟，成功转 `reviewing`。
   *
   * 任一失败都把簇**退回 `pending`**，而不是留在 `drafting` 里。留着的话，屏5 上那行会永远
   * 显示「草拟中」，而没有任何东西会再去推动它——用户既看不到失败原因，也不能重新发起
   * （`startDraft` 只能从 `pending` 进）。原型 `:702` 的这条迁移正是为此存在。
   */
  async draftFill(clusterId: string, now = new Date()): Promise<GapCluster> {
    const { judgeModelId } = await this.evaluations.getSettings();
    if (!judgeModelId) {
      // 在**推进状态之前**就拦掉：没有模型时连 drafting 都不该进，免得白白留一个要回滚的态。
      throw new BadRequestException("未配置判官模型，无法草拟——请先在在线评测设置里选一个");
    }

    const cluster = await this.gaps.mustFindForFill(clusterId);
    await this.gaps.startDraft(clusterId, now);

    let content: string;
    try {
      const response = await this.models.chat(
        judgeModelId,
        [
          { role: "system", content: DRAFT_FILL_SYSTEM_PROMPT },
          // 载荷只有这一个键。多一个键就是多一条内容面泄漏路径，故显式构造而非透传整行。
          { role: "user", content: JSON.stringify({ question: cluster.representativeQuestion }) },
        ],
        { temperature: 0, structuredOutput: DRAFT_FILL_OUTPUT },
      );
      content = response.content;
    } catch (error) {
      await this.rollbackDraft(clusterId, now);
      throw new BadRequestException(
        `草拟失败：判官模型调用出错（${error instanceof Error ? error.message : String(error)}）`,
      );
    }

    let draft: z.infer<typeof DraftFillOutputSchema>;
    try {
      draft = parseJudgeOutput(content, DraftFillOutputSchema);
    } catch (error) {
      await this.rollbackDraft(clusterId, now);
      // 解析不出来就说解析不出来。**绝不编造一条草稿**——它会被人当成模型的判断去审，
      // 而人审对「看起来完整」的内容最容易点通过。
      throw new BadRequestException(
        `草拟失败：判官模型未返回合法的问答对（${error instanceof Error ? error.message : String(error)}）`,
      );
    }

    return this.gaps.recordDraftReady(clusterId, draft.question, draft.answer, now);
  }

  /** 人审驳回：回 `pending`，草稿**保留**，下次打开向导可直接从第②步继续（原型 `:704`）。 */
  async cancelFill(clusterId: string, now = new Date()): Promise<GapCluster> {
    return this.gaps.cancelReview(clusterId, now);
  }

  /**
   * 向导第②步要回显的草稿。单开一个读端点、**不塞进屏5 的列表行**：
   * `fill_draft_answer` 是 2000 字的 text，一页 50 行全带上纯属浪费，而它只在向导打开时要用。
   */
  async getDraft(clusterId: string): Promise<GapFillDraft> {
    const cluster = await this.gaps.mustFindForFill(clusterId);
    return {
      clusterId: cluster.id,
      status: cluster.status,
      representativeQuestion: cluster.representativeQuestion,
      draftQuestion: cluster.fillDraftQuestion,
      draftAnswer: cluster.fillDraftAnswer,
      targetKbId: cluster.fillTargetKbId,
      targetDocumentId: cluster.fillTargetDocumentId,
    };
  }

  /**
   * 第③步：把人审后的 Q/A 包成一份文档，交给**现有**上传管线（021 决策 I 的 `gaps → documents` 边）。
   *
   * 合成格式对齐 `QaChunker`（`ingestion/adapters/chunkers/qa-chunker.ts`）识别的
   * `问：`/`答：` 配对；该 chunker 在未命中这个格式时会自动退化成 `GeneralChunker`，
   * 所以即便目标 KB 配的是别的 Profile 也不会失败，最坏只是切得粗一点。
   * 扩展名用 `.txt`：在 `DocumentsService` 的白名单里，且不做 magic bytes 校验。
   */
  async submitFill(
    clusterId: string,
    req: SubmitFillRequest,
    now = new Date(),
  ): Promise<GapCluster> {
    if (!req.confirmed) {
      // 原型 §19.1 `:747` 逐字：提交时强制勾选「我已核对答案与来源」。
      // 这是红线的**人审确认**那一环，后端必须自己拦，不能只靠前端禁用按钮。
      throw new BadRequestException("请先勾选「我已核对答案与来源」");
    }

    const cluster = await this.gaps.mustFindForFill(clusterId);

    /**
     * ⛔ **状态必须在 upload 之前查**（本文件的 spec 抓出来的：初版把它留给下面的
     * `gaps.submitFill` 去校验，而那句在 upload **之后**——于是一个 `pending`/`drafting`
     * 的簇，其内容根本没经过人审，照样会被写进知识库，只是随后状态迁移报错而已。
     * 文档已经落进 KB 了，报错拦不回来。红线「无人审不入库」就是这么被绕过的）。
     *
     * 下面 `gaps.submitFill` 的那次校验**仍然保留**，两道不重复：
     * 这一道防「一开始就不该进来」，那一道是带 CAS 的并发防线（读到写之间簇被别人改了）。
     */
    if (cluster.status !== "reviewing") {
      throw new BadRequestException(
        `缺口当前状态是「${cluster.status}」，只有经过人审（reviewing）的缺口才能入库`,
      );
    }

    /**
     * 入库的是**请求里带上来的人审后内容**，不是库里那份 LLM 草稿。
     * 契约已保证非空与长度。
     */
    const question = req.question.trim();
    const answer = req.answer.trim();

    /**
     * 目标 KB 必须 `ready`（原型 §19.1 `:748` 逐字文案）。
     * `DocumentsService.upload` 自己**不查**这个状态（它只读 `buildingVersion ?? activeVersion`），
     * 所以这道校验只能在这里做：蓝绿重建期间入库，文档会挂到一个即将被换掉的版本上，
     * 用户以为补好了、检索却永远看不到它。
     */
    const kb = await this.knowledgeBases.findById(req.targetKbId);
    if (!kb) throw new BadRequestException(`知识库不存在：${req.targetKbId}`);
    if (kb.status !== "ready") {
      throw new BadRequestException("知识库重建中，暂不可入库");
    }

    const content = `问：${question}\n答：${answer}\n`;
    const buffer = Buffer.from(content, "utf8");
    const [document] = await this.documents.upload(
      req.targetKbId,
      [
        {
          originalname: `gap-fill-${clusterId}.txt`,
          buffer,
          size: buffer.byteLength,
          mimetype: "text/plain",
        },
      ],
      { autoParse: true },
    );

    /**
     * 先上传、再迁移状态。顺序不能反：状态先到 `filled` 而上传失败的话，簇会挂在一个
     * 「已入库」却没有任何文档的态上，回验监听器永远等不到那份文档。
     * 反过来（上传成功但状态没写成）代价小得多——KB 里多一份未被引用的文档，
     * 用户重新走一遍向导即可，且那份文档本身是有效内容。
     *
     * 一并把人审后的 Q/A 覆盖回草稿列：**留档的必须是真正入库的那份内容**，
     * 否则事后追「这个文档是怎么来的」会翻出一份和文档对不上的 LLM 原稿。
     */
    return this.gaps.submitFill(
      clusterId,
      {
        question,
        answer,
        targetKbId: req.targetKbId,
        applicationId: req.applicationId,
        configVersionId: req.configVersionId,
        documentId: document.id,
      },
      now,
    );
  }

  /**
   * 草拟失败时把簇退回 `pending`。**本身失败只记日志、不向上抛**：
   * 调用方此刻正要抛「草拟失败」给用户，回滚再抛一个错只会把真正的原因盖掉。
   */
  private async rollbackDraft(clusterId: string, now: Date): Promise<void> {
    try {
      await this.gaps.cancelDraft(clusterId, now);
    } catch (error) {
      this.logger.error(
        `草拟失败后回滚状态也失败，簇可能卡在 drafting：cluster=${clusterId}（${
          error instanceof Error ? error.message : String(error)
        }）`,
      );
    }
  }
}
