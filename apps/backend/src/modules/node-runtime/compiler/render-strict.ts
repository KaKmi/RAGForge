import { NODE_CONTRACTS, type PromptNode } from "@codecrush/contracts";

const VAR_RE = /\{(\w+)\}/g;

/**
 * 严格渲染：未知变量或保留字段引用直接抛错（区别于 packages/contracts 的宽松版
 * renderTemplate，其注释已明确"只适用于预览"）。保存路径的 compilePromptBody() 已经
 * 拦截了这些非法引用，本函数是防御性的第二道保险。
 */
export function renderTemplateStrict(
  body: string,
  vars: Record<string, string>,
  node: PromptNode,
): string {
  const contract = NODE_CONTRACTS[node];
  const legal = new Set(contract.templateFields);
  const reserved = new Set(
    (Object.keys(NODE_CONTRACTS) as PromptNode[]).flatMap((n) => NODE_CONTRACTS[n].reservedFields),
  );
  return body.replace(VAR_RE, (_, k: string) => {
    if (reserved.has(k)) {
      throw new Error(`renderTemplateStrict：{${k}} 是保留字段，不能出现在正文中`);
    }
    if (!legal.has(k)) {
      throw new Error(`renderTemplateStrict：{${k}} 不是节点 ${node} 的合法字段`);
    }
    return vars[k] ?? "";
  });
}
