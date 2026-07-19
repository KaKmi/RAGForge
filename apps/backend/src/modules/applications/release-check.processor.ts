import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import type { PromptNode, ReleaseCheckIssue } from "@codecrush/contracts";
import { AppConfigService } from "../../platform/config/config.service";
import { RELEASE_CHECK_JOB, RELEASE_CHECK_QUEUE } from "../../platform/queue/queue.constants";
import type { Queue } from "../../platform/queue/queue.port";
import { NodeRuntimeService } from "../node-runtime/executor/node-runtime.service";
import { PromptsService } from "../prompts/prompts.service";
import { ApplicationsRepository } from "./applications.repository";
import { ApplicationsService } from "./applications.service";
import { buildSamples } from "./release-check.samples";
import { hasBlockingIssue } from "./release-check.severity";
import type { ApplicationConfigVersionRow } from "./schema";

const RELEASE_CHECK_TTL_MS = 15 * 60 * 1000; // 通过后 15 分钟有效（009）
const ZOMBIE_MS = 15 * 60 * 1000; // running 超过此窗口视为僵尸，允许重跑（对齐 ingestion）

const NODES = ["rewrite", "intent", "reply", "fallback"] as const;
const NODE_COLUMNS: Record<PromptNode, { prompt: keyof ApplicationConfigVersionRow }> = {
  rewrite: { prompt: "promptRewriteVersionId" },
  intent: { prompt: "promptIntentVersionId" },
  reply: { prompt: "promptReplyVersionId" },
  fallback: { prompt: "promptFallbackVersionId" },
};
const MODEL_COLUMNS: Record<PromptNode, keyof ApplicationConfigVersionRow> = {
  rewrite: "rewriteModelId",
  intent: "intentModelId",
  reply: "replyModelId",
  fallback: "fallbackModelId",
};

// M7b ReleaseCheck 第二层：异步真实 NodeRuntime 预演（抄 ingestion.processor 的 OnModuleInit+subscribe 范式）。
@Injectable()
export class ReleaseCheckProcessor implements OnModuleInit {
  private readonly logger = new Logger(ReleaseCheckProcessor.name);

  constructor(
    @Inject(RELEASE_CHECK_QUEUE) private readonly queue: Queue,
    private readonly repo: ApplicationsRepository,
    private readonly nodeRuntime: NodeRuntimeService,
    private readonly prompts: PromptsService,
    private readonly applications: ApplicationsService,
    private readonly appConfig: AppConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.queue.subscribe(RELEASE_CHECK_JOB, async (data) => {
      await this.process((data as { checkId: string }).checkId);
    });
  }

  async process(checkId: string): Promise<void> {
    const check = await this.repo.findReleaseCheckById(checkId);
    if (!check) return;
    // 幂等/僵尸守卫：终态跳过；running 未超时跳过；running 超时或 queued 才跑
    if (check.status === "passed" || check.status === "failed" || check.status === "expired") return;
    if (
      check.status === "running" &&
      check.startedAt &&
      Date.now() - check.startedAt.getTime() < ZOMBIE_MS
    )
      return;

    await this.repo.markReleaseCheckRunning(checkId);
    try {
      await this.run(checkId, check.configVersionId, check.applicationId);
    } catch (err) {
      // review P2-2：基础设施异常（DB 抖动/未知错误）不能让 check 永久卡 running——
      // 标 failed 让轮询方拿到终态；mark 自身失败则异常上抛，靠 retryLimit=1 重投 + 僵尸窗口兜底。
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`release check ${checkId} 执行异常：${msg}`);
      await this.repo.markReleaseCheckResult(checkId, {
        status: "failed",
        issues: [{ code: "INTERNAL_ERROR", message: msg, severity: "error" }],
        sampleSummary: {},
        expiresAt: null,
      });
    }
  }

  private async run(
    checkId: string,
    configVersionId: string,
    applicationId: string,
  ): Promise<void> {
    const version = await this.repo.findVersionById(configVersionId);
    if (!version) {
      await this.repo.markReleaseCheckResult(checkId, {
        status: "failed",
        issues: [{ code: "VERSION_MISSING", message: "配置版本不存在", severity: "error" }],
        sampleSummary: {},
        expiresAt: null,
      });
      return;
    }
    const issues: ReleaseCheckIssue[] = [];
    const summary: Record<string, { ok: number; total: number }> = {};

    // 第二段（真实冒烟采样）默认关——用户 2026-07-19 决定，理由见 config.schema.ts
    // 的 RELEASE_CHECK_SAMPLING_ENABLED。跳过时必须留下痕迹：否则「passed」会在
    // 语义不变的外表下代表一个明显更弱的保证（少了 21 次真实节点预演），
    // 调用方与人都无从分辨。故补一条 warning——warning 不参与 hasBlockingIssue，
    // 不影响放行，只保证知情。
    const samplingEnabled = this.appConfig.releaseCheckSamplingEnabled;
    if (!samplingEnabled) {
      issues.push({
        code: "SAMPLING_SKIPPED",
        message: "已跳过真实冒烟预演（仅完成静态校验）——内置样例待重设计",
        severity: "warning",
      });
    }

    for (const node of samplingEnabled ? NODES : []) {
      const promptVersionId = version[NODE_COLUMNS[node].prompt] as string;
      const modelId = version[MODEL_COLUMNS[node]] as string;
      const exec = await this.prompts.getVersionExecutable(promptVersionId);
      if (!exec) {
        summary[node] = { ok: 0, total: 0 };
        issues.push({ code: "PROMPT_VERSION_MISSING", node, promptVersionId, message: `${node} 的 PromptVersion 不存在`, severity: "error" });
        continue;
      }
      const params = version.nodeParams[node];
      // 014 D5：intent 样例内部注入静态全表 availableIntents，不再按 kbIds 派生候选路由
      const samples = buildSamples(node);
      const result = await this.nodeRuntime.compileAndSample({
        node,
        contractVersion: exec.contractVersion,
        promptVersionId,
        promptBody: exec.body,
        modelId,
        modelParams: { temperature: params.temperature, topP: params.topP },
        samples,
      });
      const okCount = result.results.filter((r) => r.ok).length;
      summary[node] = { ok: okCount, total: result.results.length };
      if (!result.ok) {
        for (const r of result.results.filter((s) => !s.ok)) {
          issues.push({
            code: r.issues[0]?.code ?? "SAMPLE_FAILED",
            node,
            promptVersionId,
            sampleIndex: r.sampleIndex,
            traceId: r.traceId,
            action: "OPEN_PROMPT_TRY_RUN",
            message: r.issues[0]?.message ?? `${node} 样例 ${r.sampleIndex} 预演未通过`,
            severity: "error",
          });
        }
      }
    }

    // B1/F5：评测门禁——**纯附加**的 warning issue。
    // collectEvalGateIssues 恒返回 warning 级（provider 抛错也只降级成 UNAVAILABLE warning），
    // 故它无论如何都不参与阻断判定。
    //
    // ⚠️ applicationId 由 process() 透传而来，**不在这里重新查库**：
    // review P1——门禁路径上任何未被 try/catch 罩住的 I/O，一旦抖动就会冒泡到
    // process() 的 catch，把一次本已抽样成功的 check 写成 failed + INTERNAL_ERROR(error 级)，
    // 于是 publishProduction 抛 422。那正是 fail-open 明令禁止的形状：
    // 读取异常必须放行并降级成 warning，绝不能因门禁而拒发布。
    issues.push(...(await this.applications.collectEvalGateIssues(applicationId, configVersionId)));

    const blocked = hasBlockingIssue(issues);
    await this.repo.markReleaseCheckResult(checkId, {
      status: blocked ? "failed" : "passed",
      issues,
      sampleSummary: summary,
      expiresAt: blocked ? null : new Date(Date.now() + RELEASE_CHECK_TTL_MS),
    });
    this.logger.log(`release check ${checkId} → ${blocked ? "failed" : "passed"}`);
  }
}
