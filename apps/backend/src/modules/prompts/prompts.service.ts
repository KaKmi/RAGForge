import { Injectable, NotFoundException } from "@nestjs/common";
import type {
  CreatePromptVersionRequest,
  Prompt,
  PromptVersion,
} from "@codecrush/contracts";

const MOCK_PROMPTS: Prompt[] = [
  { id: "p1", name: "问题改写-通用", node: "rewrite", currentVersionId: "pv1" },
  { id: "p2", name: "意图识别-通用", node: "intent", currentVersionId: "pv2" },
  { id: "p3", name: "回复生成-通用", node: "reply", currentVersionId: "pv3" },
  { id: "p4", name: "兜底回复-通用", node: "fallback", currentVersionId: "pv4" },
];

const MOCK_VERSIONS: PromptVersion[] = [
  {
    id: "pv1",
    promptId: "p1",
    version: 7,
    body: "你是一个问题改写器，请将用户问题改写为更利于检索的形式...",
    variables: ["query"],
    note: "通用版",
    author: "admin",
    status: "prod",
  },
  {
    id: "pv1-draft",
    promptId: "p1",
    version: 8,
    body: "你是一个问题改写器（实验版）...",
    variables: ["query"],
    note: "实验：增加槽位抽取",
    author: "admin",
    status: "draft",
  },
  {
    id: "pv2",
    promptId: "p2",
    version: 3,
    body: "请识别用户意图，输出意图标签...",
    variables: ["query"],
    status: "prod",
  },
  {
    id: "pv3",
    promptId: "p3",
    version: 5,
    body: "基于以下检索结果回答用户问题...",
    variables: ["query", "context"],
    status: "prod",
  },
  {
    id: "pv4",
    promptId: "p4",
    version: 2,
    body: "抱歉，未找到相关信息，转人工...",
    variables: [],
    status: "prod",
  },
];

@Injectable()
export class PromptsService {
  list(): Prompt[] {
    return MOCK_PROMPTS;
  }

  get(id: string): Prompt {
    const prompt = MOCK_PROMPTS.find((p) => p.id === id);
    if (!prompt) throw new NotFoundException(`prompt ${id} not found`);
    return prompt;
  }

  listVersions(promptId: string): PromptVersion[] {
    this.get(promptId); // 校验 prompt 存在
    return MOCK_VERSIONS.filter((v) => v.promptId === promptId);
  }

  createVersion(promptId: string, req: CreatePromptVersionRequest): PromptVersion {
    this.get(promptId); // 校验 prompt 存在
    const existing = MOCK_VERSIONS.filter((v) => v.promptId === promptId);
    const nextVersion = existing.length + 1;
    // M2 桩：仅回显，不持久化。M6 接 Prompt 版本管理与 diff。
    // version/status 由后端分配（新建版本一律 draft），不由客户端决定。
    return {
      ...req,
      id: `pv-${promptId}-${nextVersion}`,
      promptId,
      version: nextVersion,
      status: "draft",
    };
  }
}
