import { Injectable, type OnModuleInit } from "@nestjs/common";
import { ApplicationsService } from "../applications/applications.service";
import { EvalRunsRepository } from "./eval-runs.repository";

/**
 * E-W2b F6（018 缺口 5）：eval-runs 向 applications 注册删除守卫——
 * 存在活跃（queued/running）run 引用该应用时，拒绝其删除（保护正在跑的评测不被釜底抽薪）。
 *
 * 依赖方向不变：eval-runs → applications（既有边）；applications 不知道 eval-runs
 * （通过注册表回调解耦，lint 边界 0）。
 */
@Injectable()
export class EvalRunDeletionGuard implements OnModuleInit {
  constructor(
    private readonly applications: ApplicationsService,
    private readonly repo: EvalRunsRepository,
  ) {}

  onModuleInit(): void {
    this.applications.registerDeletionGuard(async (applicationId) =>
      (await this.repo.existsActiveRunByApplicationId(applicationId))
        ? "有评测正在运行引用该应用的配置版本，无法删除"
        : null,
    );
  }
}
