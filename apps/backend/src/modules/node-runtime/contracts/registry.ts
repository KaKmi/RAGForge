import type { PromptNode } from "@codecrush/contracts";
import { REWRITE_CONTRACT } from "./rewrite.contract";
import { INTENT_CONTRACT } from "./intent.contract";
import { REPLY_CONTRACT } from "./reply.contract";
import { FALLBACK_CONTRACT } from "./fallback.contract";
import type { NodeContract } from "./types";

// v1 版本表；未来新增 contractVersion 时按 (node, version) 加行，不覆盖旧版本
// （001/011 不变量：PromptVersion 固定 ContractVersion，旧版本行为不因新版上线而改变）。
// 类型擦除到 unknown（而非 never，review round 1）：never 是 bottom type，
// 会让 outputSchema.parse()/fallback() 的返回值静默兼容任何错误形状（协变位置
// 被吞掉编译期保护）；同时让 fallback()/extraValidate() 的参数位（逆变）连
// "客观正确"的入参都编译不过，逼消费方到处 unsafe cast。unknown 两头都更诚实：
// 传入 unknown 参数永远合法（消费方转型后传真实对象即可），取出 unknown 返回值
// 必须显式断言才能当具体类型用，不会静默通过类型检查。
const REGISTRY: Record<PromptNode, Record<number, NodeContract<unknown, unknown, unknown>>> = {
  rewrite: { 1: REWRITE_CONTRACT as NodeContract<unknown, unknown, unknown> },
  intent: { 1: INTENT_CONTRACT as NodeContract<unknown, unknown, unknown> },
  reply: { 1: REPLY_CONTRACT as NodeContract<unknown, unknown, unknown> },
  fallback: { 1: FALLBACK_CONTRACT as NodeContract<unknown, unknown, unknown> },
};

export const NodeContractRegistry = {
  resolve(node: PromptNode, contractVersion: number): NodeContract<unknown, unknown, unknown> {
    const contract = REGISTRY[node]?.[contractVersion];
    if (!contract) {
      throw new Error(
        `未知 NodeContract：node=${node} contractVersion=${contractVersion}（服务 readiness 失败，不允许用最新版本替代）`,
      );
    }
    return contract;
  },
};
