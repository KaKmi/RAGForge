import type { Prompt, PromptVersion } from "@codecrush/contracts";

/** M2 mock：Prompt 管理页用。M6 接真实 /api/prompts。 */

export const MOCK_PROMPTS: Prompt[] = [
  { id: "p-rw", name: "查询改写 Prompt", node: "rewrite", currentVersionId: "pw-rw-1" },
  { id: "p-it", name: "意图识别 Prompt", node: "intent", currentVersionId: "pw-it-1" },
  { id: "p-rp", name: "回复生成 Prompt", node: "reply", currentVersionId: "pw-rp-1" },
  { id: "p-fb", name: "兜底 Prompt", node: "fallback", currentVersionId: "pw-fb-1" },
];

export const MOCK_PROMPT_VERSIONS: PromptVersion[] = [
  {
    id: "pw-rw-1",
    promptId: "p-rw",
    version: 1,
    body: "你是一个查询改写器。将用户问题改写为更利于检索的形式，保留核心意图。\n变量：{{query}}",
    variables: ["query"],
    note: "初版",
    author: "admin",
    status: "prod",
  },
  {
    id: "pw-rw-2",
    promptId: "p-rw",
    version: 2,
    body: "你是一个查询改写器。结合历史对话改写用户问题，输出 3 个候选。\n变量：{{query}} {{history}}",
    variables: ["query", "history"],
    note: "多路召回改写",
    author: "admin",
    status: "draft",
  },
  {
    id: "pw-rp-1",
    promptId: "p-rp",
    version: 1,
    body: "你是售后客服。根据检索到的资料回答用户问题，引用资料用 [n] 标注。\n变量：{{query}} {{context}}",
    variables: ["query", "context"],
    note: "初版",
    author: "admin",
    status: "prod",
  },
];
