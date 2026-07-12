import type { PromptNode } from "@codecrush/contracts";
import type { RuntimeContext } from "../node-runtime/compiler/runtime-context";

// M7b ReleaseCheck 内置固定冒烟样例（D2）：M7b 无评测集（M11），Postgres 不存真实用户问题，
// 故用一组代表性问题做「真实节点结果」冒烟。rewrite/intent 各跑全部 10 条，reply/fallback 各 1 条。
// input/reserved 形状取自各 NodeContract（rewrite/intent {query,history}；reply +retrievalContext；
// fallback 为无字段纯文本；intent reserved.availableRoutes 由 kbIds 派生，reply reserved.citations=[]）。
const SMOKE_QUERIES = [
  "怎么退货",
  "订单多久发货",
  "支持哪些支付方式",
  "如何修改收货地址",
  "会员有什么权益",
  "发票怎么开",
  "商品质量问题怎么办",
  "运费怎么算",
  "能开企业采购吗",
  "客服电话是多少",
] as const;

export interface NodeSample {
  input: Record<string, unknown>;
  runtimeContext: RuntimeContext;
}

/**
 * @param node    四固定节点之一
 * @param availableRoutes intent 越权校验用的候选路由（由应用 kbIds 派生，每 KB 一个 routeId）
 */
export function buildSamples(node: PromptNode, availableRoutes: string[]): NodeSample[] {
  const reserved = (): RuntimeContext =>
    node === "intent" ? { availableRoutes } : node === "reply" ? { citations: [] } : {};
  const queries =
    node === "rewrite" || node === "intent" ? SMOKE_QUERIES : SMOKE_QUERIES.slice(0, 1);
  return queries.map((query) => ({
    input:
      node === "fallback"
        ? {}
        : node === "reply"
          ? { query, history: "", retrievalContext: "（冒烟预演占位检索内容）" }
          : { query, history: "" },
    runtimeContext: reserved(),
  }));
}
