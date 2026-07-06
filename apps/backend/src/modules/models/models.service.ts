import { Injectable, NotFoundException } from "@nestjs/common";
import type { CreateModelRequest, ModelProvider } from "@codecrush/contracts";

const MOCK_MODELS: ModelProvider[] = [
  {
    id: "m1",
    type: "llm",
    provider: "DeepSeek",
    name: "deepseek-v3",
    baseUrl: "https://api.deepseek.com",
    apiKeyMasked: "sk-****1234",
    role: "回复生成（主）",
    enabled: true,
  },
  {
    id: "m2",
    type: "embedding",
    provider: "BAAI",
    name: "bge-m3",
    baseUrl: "https://api.bge.local",
    enabled: true,
  },
  {
    id: "m3",
    type: "rerank",
    provider: "BAAI",
    name: "bge-reranker-v2-m3",
    enabled: true,
  },
];

@Injectable()
export class ModelsService {
  list(): ModelProvider[] {
    return MOCK_MODELS;
  }

  get(id: string): ModelProvider {
    const model = MOCK_MODELS.find((m) => m.id === id);
    if (!model) throw new NotFoundException(`model ${id} not found`);
    return model;
  }

  create(req: CreateModelRequest): ModelProvider {
    // M2 桩：仅回显，不持久化（M3 接 models 表）
    return { id: `m${MOCK_MODELS.length + 1}`, ...req };
  }

  test(_id: string): { ok: boolean } {
    // M2 桩：永远成功（M3 接真实连通性测试）
    return { ok: true };
  }
}
