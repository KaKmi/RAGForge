import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
} from "@nestjs/common";
import {
  SubmitFillRequestSchema,
  type GapCluster,
  type GapFillDraft,
} from "@codecrush/contracts";
import { GapFillService } from "./gap-fill.service";
import { GapsService } from "./gaps.service";

/**
 * 与 `GapsController` 同款的路径参数守卫。不校验的话，一个非 UUID 的 id 会一路走到
 * `uuid` 列的比较上，PG 抛 `22P02` ⇒ 本该 400 的输入变成 500（同该文件的既定做法）。
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `[补知识库]` 向导的三个端点（021 决策 I，原型 §17.5 `:633`）。
 *
 * 路由形状与 `GapsController` 的既有动词一致（`:id/<verb>`），故并入同一个 `gaps` 前缀不冲突；
 * 单独成 controller 的理由同 `GapPromoteController`：状态机与簇操作是一码事，
 * 「往知识库里写东西」是另一码事（且它是本波唯一使用 `gaps → documents` 边的地方）。
 *
 * ⛔ **没有「一步到位」的端点**。草拟与入库分成两次调用、中间隔着 `reviewing` 态，
 * 正是产品红线「无人审不入库」的结构保证——别为了少一次往返把它们合成一个。
 */
@Controller("gaps")
export class GapFillController {
  constructor(
    private readonly service: GapFillService,
    //  是纯状态迁移（无 LLM、无上传），直接走 GapsService，
    // 不必在 GapFillService 上再包一层只有转发的方法。
    private readonly gaps: GapsService,
  ) {}

  /**
   * 向导打开时回显草稿（第②步的数据源）。
   *
   * ⚠️ 路径必须是 `:id/fill-draft` 这种**两段式**，别写成一段式的 `fill-draft`——
   * `GapsController` 上已有 `@Get(":id")` 之外的一段式路由（`summary`），Nest 按声明顺序匹配，
   * 一段式新路由若声明在后会被 `:id` 抢走。两段式与既有动词同形，永不相交。
   */
  @Get(":id/fill-draft")
  async getDraft(@Param("id") id: string): Promise<GapFillDraft> {
    return this.service.getDraft(assertUuid(id));
  }

  /** 第①步：进入草拟并同步等 LLM 出结果（同 `draft-gold` 的既定形态，不建批次不轮询）。 */
  @Post(":id/draft-fill")
  @HttpCode(200)
  async draftFill(@Param("id") id: string): Promise<GapCluster> {
    return this.service.draftFill(assertUuid(id));
  }

  /**
   * 拿回上次保留的草稿，直接回第②步（021 §9b 决策 J 承诺的「跳过①直接到②」）。
   *
   * 挂在这个控制器而不是 `gaps.controller`：它是补库向导的一步，
   * 与 `draft-fill`/`cancel-fill`/`submit-fill` 同族。
   */
  @Post(":id/resume-fill")
  @HttpCode(200)
  async resumeFill(@Param("id") id: string): Promise<GapCluster> {
    return this.gaps.resumeDraft(assertUuid(id));
  }

  /** 人审驳回：回 `pending`，草稿保留（原型 `:704`）。 */
  @Post(":id/cancel-fill")
  @HttpCode(200)
  async cancelFill(@Param("id") id: string): Promise<GapCluster> {
    return this.service.cancelFill(assertUuid(id));
  }

  /** 第③步：人审通过 → 走既有上传管线入库 → 转 `filled`，等文档 ready 后自动回验。 */
  @Post(":id/submit-fill")
  @HttpCode(200)
  async submitFill(@Param("id") id: string, @Body() raw: unknown): Promise<GapCluster> {
    const parsed = SubmitFillRequestSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.service.submitFill(assertUuid(id), parsed.data);
  }
}

function assertUuid(id: string): string {
  if (!UUID.test(id)) throw new BadRequestException("id must be a UUID");
  return id;
}
