import { Injectable, type OnModuleInit } from "@nestjs/common";
import { ApplicationsService } from "../applications/applications.service";
import { buildCompareResponse } from "./eval-compare";
import { buildGateIssues, type GateInput } from "./eval-gate.rules";
import { EvalRunsRepository } from "./eval-runs.repository";
import { EvalRunsService, isSameCaseSet } from "./eval-runs.service";

/**
 * B1/F5：eval-runs 向 applications 注册门禁 issue 提供方。
 *
 * 依赖方向不变：eval-runs → applications（既有边，见 eval-runs.module.ts:25）；
 * applications 不知道 eval-runs（通过注册表回调解耦，lint 边界 0）。
 * 范式同 EvalRunDeletionGuard（eval-run-deletion.guard.ts:12-26）。
 *
 * **本类不 catch**：异常一律上抛给 `ApplicationsService.collectEvalGateIssues`，
 * 由那一处统一降级成 `EVAL_GATE_UNAVAILABLE` warning。fail-open 只留一个落点，
 * 免得两层各吞一半、出问题时分不清是哪层把结论吃掉了。
 */
@Injectable()
export class EvalGateProviderRegistrar implements OnModuleInit {
  constructor(
    private readonly applications: ApplicationsService,
    private readonly repo: EvalRunsRepository,
    private readonly runs: EvalRunsService,
  ) {}

  onModuleInit(): void {
    this.applications.registerEvalGateProvider(async (applicationId, configVersionId) =>
      buildGateIssues(await this.resolve(applicationId, configVersionId), new Date()),
    );
  }

  private async resolve(applicationId: string, configVersionId: string): Promise<GateInput> {
    // B 侧（候选）：该应用该版本的最新终态 run
    const candidate = await this.repo.findLatestFinishedRun(applicationId, configVersionId);
    if (!candidate) return { kind: "no_run" };

    // A 侧（基线）：同评测集、当前 production 版本的最新终态 run
    const productionVersionId = await this.applications.getProductionConfigVersionId(applicationId);
    if (!productionVersionId) return { kind: "no_run" };
    // 候选就是当前 production 时无从「对比」——自己跟自己比恒无回退，
    // 那会给出一个看似干净、实则没有信息量的结论。
    if (productionVersionId === configVersionId) return { kind: "no_run" };
    const baseline = await this.repo.findLatestFinishedRunInSet(
      candidate.setId,
      productionVersionId,
    );
    if (!baseline) return { kind: "no_run" };

    const [aRow, bRow] = await Promise.all([
      this.repo.findAggregateById(baseline.id),
      this.repo.findAggregateById(candidate.id),
    ]);
    if (!aRow || !bRow) return { kind: "no_run" };
    // 可比性判据与对比页共用同一个函数——否则会出现「对比页说不可比、门禁却给了结论」。
    // 不可比时降级为 NO_RUN（fail-open），不抛。
    if (!isSameCaseSet(aRow, bRow)) return { kind: "no_run" };

    // 唯一回退口径：复用 buildCompareResponse（禁止另写 classifyCase）
    const [a, b] = await this.runs.loadCompareInputs(aRow, bRow);
    const compare = buildCompareResponse(a, b);
    return {
      kind: "compared",
      finishedAt: candidate.finishedAt ?? candidate.createdAt,
      regressedCount: compare.summary.regressedCount,
      overallDelta: compare.summary.overallDelta,
    };
  }
}
