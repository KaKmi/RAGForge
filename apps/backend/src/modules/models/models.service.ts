import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  isValidProtocol,
  type CreateModelRequest,
  type ModelProtocol,
  type ModelProvider,
  type ModelType,
  type TestModelOverride,
  type TestModelRequest,
  type TestModelResponse,
  type UpdateModelRequest,
} from "@codecrush/contracts";
import { withSpan } from "@codecrush/otel";
import { CODECRUSH_SPAN_KIND, GEN_AI, OTEL_OPERATIONS } from "@codecrush/otel-conventions";
import { ENCRYPTION } from "../../platform/security/security.constants";
import { EncryptionService } from "../../platform/security/encryption";
import { ModelsRepository } from "./models.repository";
import { MODEL_PROVIDER_PORT } from "./model-provider.constants";
import type { ModelCallConfig, ModelProviderPort } from "./ports/model-provider.port";
import type { ModelProviderRow, NewModelProvider } from "./schema";

const OP_BY_TYPE: Record<ModelType, string> = {
  llm: OTEL_OPERATIONS.CHAT,
  embedding: OTEL_OPERATIONS.EMBEDDINGS,
  rerank: OTEL_OPERATIONS.RERANK,
};
const KIND_BY_TYPE: Record<ModelType, string> = {
  llm: CODECRUSH_SPAN_KIND.LLM,
  embedding: CODECRUSH_SPAN_KIND.EMBEDDINGS,
  rerank: CODECRUSH_SPAN_KIND.RERANK,
};

@Injectable()
export class ModelsService {
  constructor(
    private readonly repo: ModelsRepository,
    @Inject(ENCRYPTION) private readonly enc: EncryptionService,
    @Inject(MODEL_PROVIDER_PORT) private readonly provider: ModelProviderPort,
  ) {}

  async list(): Promise<ModelProvider[]> {
    return (await this.repo.find()).map((r) => this.toModelProvider(r));
  }

  async get(id: string): Promise<ModelProvider> {
    return this.toModelProvider(await this.mustFind(id));
  }

  async create(req: CreateModelRequest): Promise<ModelProvider> {
    const { apiKey, ...rest } = req;
    const row = await this.repo.insert({ ...rest, apiKeyEnc: this.enc.encrypt(apiKey) });
    return this.toModelProvider(row);
  }

  async update(id: string, req: UpdateModelRequest): Promise<ModelProvider> {
    const existing = await this.mustFind(id);
    // PATCH 单改 type 或 protocol 时，契约层只能校验同现的组合——合并存量行后再校验，
    // 防止落库非法 (type, protocol)（如 llm 行被 PATCH 成 protocol:dashscope）
    const mergedType = (req.type ?? existing.type) as ModelType;
    const mergedProtocol = (req.protocol ?? existing.protocol) as ModelProtocol;
    if (!isValidProtocol(mergedType, mergedProtocol)) {
      throw new BadRequestException(`protocol ${mergedProtocol} 不适用于类型 ${mergedType}`);
    }
    const { apiKey, ...rest } = req;
    const patch: Partial<NewModelProvider> = { ...rest };
    if (apiKey) patch.apiKeyEnc = this.enc.encrypt(apiKey);
    const row = await this.repo.update(id, patch);
    if (!row) throw new NotFoundException(`model ${id} not found`);
    return this.toModelProvider(row);
  }

  async remove(id: string): Promise<void> {
    await this.mustFind(id);
    try {
      await this.repo.delete(id);
    } catch (err) {
      // knowledge_bases.embedding_model_id 现有 FK RESTRICT（007 Design「存储 schema」）：
      // 模型仍被知识库绑定时删除会在 DB 层被拒（embeddingModelId 创建后锁定，语义上就不该能删）。
      // 转成可读 409，不让原始 23503 裸奔到客户端。
      if (isForeignKeyViolation(err)) {
        throw new ConflictException(`model ${id} 仍被知识库引用，无法删除`);
      }
      throw err;
    }
  }

  // override：编辑抽屉改了配置但未填新 key 时，用抽屉当前配置 + 存量 key 测试（key 不下发前端）
  async testById(id: string, override?: TestModelOverride): Promise<TestModelResponse> {
    const row = await this.mustFind(id);
    const type = (override?.type ?? row.type) as ModelType;
    const protocol = (override?.protocol ?? row.protocol) as ModelProtocol;
    if (!isValidProtocol(type, protocol)) {
      throw new BadRequestException(`protocol ${protocol} 不适用于类型 ${type}`);
    }
    return this.doTest({
      type,
      protocol,
      name: override?.name ?? row.name,
      baseUrl: override?.baseUrl ?? row.baseUrl,
      deploymentId: override?.deploymentId ?? row.deploymentId ?? undefined,
      params: override?.params ?? row.params,
      apiKey: this.enc.decrypt(row.apiKeyEnc),
    });
  }

  async testConfig(req: TestModelRequest): Promise<TestModelResponse> {
    return this.doTest({ ...req });
  }

  // 供 ingestion 域调用：按 modelId 查行、解密 key、调端口 embed()。密钥解密不出 models 域。
  async embedTexts(modelId: string, texts: string[]): Promise<number[][]> {
    const row = await this.mustFind(modelId);
    const { vectors } = await this.provider.embed(
      {
        type: row.type as ModelType,
        protocol: row.protocol as ModelProtocol,
        name: row.name,
        baseUrl: row.baseUrl,
        deploymentId: row.deploymentId ?? undefined,
        params: row.params,
        apiKey: this.enc.decrypt(row.apiKeyEnc),
      },
      texts,
    );
    return vectors;
  }

  // best-effort span：属性只含类型/协议/模型名，永不含 apiKey。
  // gen_ai.system 填协议值（provider 字段已随协议化移除，协议值比自由文本更规范）
  private async doTest(config: ModelCallConfig): Promise<TestModelResponse> {
    return await withSpan(
      "model.test_connection",
      {
        attributes: {
          [GEN_AI.OPERATION_NAME]: OP_BY_TYPE[config.type],
          [GEN_AI.SYSTEM]: config.protocol,
          [GEN_AI.REQUEST_MODEL]: config.deploymentId ?? config.name,
          "codecrush.span.kind": KIND_BY_TYPE[config.type],
        },
      },
      async () => {
        const r = await this.provider.testConnection(config);
        return { ok: r.ok, latencyMs: r.latencyMs, statusCode: r.statusCode, error: r.error };
      },
    );
  }

  private async mustFind(id: string): Promise<ModelProviderRow> {
    const row = await this.repo.findById(id);
    if (!row) throw new NotFoundException(`model ${id} not found`);
    return row;
  }

  private toModelProvider(row: ModelProviderRow): ModelProvider {
    return {
      id: row.id,
      type: row.type as ModelType,
      protocol: row.protocol as ModelProtocol,
      name: row.name,
      baseUrl: row.baseUrl,
      deploymentId: row.deploymentId ?? undefined,
      params: row.params,
      enabled: row.enabled,
      apiKeyMasked: this.enc.maskApiKey(this.enc.decrypt(row.apiKeyEnc)),
    };
  }
}

// drizzle-orm 把底层 pg 错误包在 DrizzleQueryError.cause 里（非顶层 e.code）——
// 实测验证：直接查 e.code 永远查不到，需下钻 e.cause.code 才是真正的 pg SQLSTATE。
function isForeignKeyViolation(e: unknown): boolean {
  const cause = e instanceof Error ? e.cause : undefined;
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause as { code: string }).code === "23503"
  );
}
