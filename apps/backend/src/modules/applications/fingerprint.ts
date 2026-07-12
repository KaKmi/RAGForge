import { createHash } from "node:crypto";

// M7b ReleaseCheck fingerprint（009 §ReleaseCheck fingerprint / D9）：绑定检查通过时的全部依赖，
// 上线前重算比对——依赖变化（模型改配、KB active version 变、参数改）则 fingerprint 失配，拒绝上线。
export interface FingerprintInput {
  configVersionId: string;
  // 四节点各自 PromptVersion + ContractVersion
  prompts: Array<{ node: string; promptVersionId: string; contractVersion: number }>;
  // 四节点模型 + provider revision（用 model_providers.updated_at 的 ISO 串作代理）
  models: Array<{ node: string; modelId: string; providerRevision: string }>;
  rerankModelId: string | null;
  rerankProviderRevision: string | null;
  nodeParams: unknown;
  retrievalParams: unknown;
  fallbackParams: unknown;
  // 应用固定的 KB 集合 + 各 KB 检查时的 active version
  kbs: Array<{ kbId: string; activeVersion: number }>;
}

/** 规范化（数组按稳定键排序，键顺序固定）→ JSON → sha256 十六进制。 */
export function computeFingerprint(input: FingerprintInput): string {
  const canonical = {
    configVersionId: input.configVersionId,
    prompts: [...input.prompts].sort((a, b) => a.node.localeCompare(b.node)),
    models: [...input.models].sort((a, b) => a.node.localeCompare(b.node)),
    rerankModelId: input.rerankModelId,
    rerankProviderRevision: input.rerankProviderRevision,
    nodeParams: input.nodeParams,
    retrievalParams: input.retrievalParams,
    fallbackParams: input.fallbackParams,
    kbs: [...input.kbs].sort((a, b) => a.kbId.localeCompare(b.kbId)),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
