import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { visit } from "unist-util-visit";
import type { PhrasingContent, Root } from "mdast";
import type { ChatCitation } from "@codecrush/contracts";

/** remark 插件：把正文里的 `[n]` 转成 link(url="cite:n") 节点，供下方 `a` 组件渲染成可点角标。
 * `[n]` 可能被 remark 解析为 shortcut linkReference（无定义）或纯 text，两种都要处理；
 * 放在 remarkGfm 之后，只动这两类节点，不影响加粗/列表/代码等 markdown 结构。 */
function citeLink(n: string): PhrasingContent {
  return { type: "link", url: `cite:${n}`, title: null, children: [{ type: "text", value: n }] };
}

function remarkCitations() {
  return (tree: Root) => {
    // 1) `[n]` 常被解析成 shortcut/collapsed linkReference（无定义），数字标识符 → cite 链接
    visit(tree, "linkReference", (node, index, parent) => {
      if (!parent || index === undefined) return;
      if (node.referenceType === "full") return; // [text][id] 形式不碰
      if (!/^\d+$/.test(node.identifier)) return;
      parent.children.splice(index, 1, citeLink(node.identifier));
      return index + 1;
    });
    // 2) 兜底：仍以纯文本形式存在的 `[n]`
    visit(tree, "text", (node, index, parent) => {
      if (!parent || index === undefined) return;
      const value = node.value;
      const re = /\[(\d+)\]/g;
      if (!re.test(value)) return;
      re.lastIndex = 0;
      const parts: PhrasingContent[] = [];
      let last = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(value)) !== null) {
        if (m.index > last) parts.push({ type: "text", value: value.slice(last, m.index) });
        parts.push(citeLink(m[1]));
        last = re.lastIndex;
      }
      if (last < value.length) parts.push({ type: "text", value: value.slice(last) });
      parent.children.splice(index, 1, ...parts);
      return index + parts.length; // 跳过刚插入的节点，避免重复访问
    });
  };
}

export interface MessageMarkdownProps {
  text: string;
  msgKey: string;
  citations: ChatCitation[];
  /** 当前高亮角标序号（本消息被选中时的 n，否则 null）。 */
  activeN: number | null;
  onPickCite: (msgKey: string, n: number) => void;
}

/** Bot 回复正文：渲染 markdown（加粗/列表/标题/代码/引用/表格），并把 `[n]` 渲染成可点角标 ⇄ 右栏原文。 */
export function MessageMarkdown({ text, msgKey, citations, activeN, onPickCite }: MessageMarkdownProps) {
  return (
    <div className="ccb-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkCitations]}
        // 默认 urlTransform 会把自定义 cite: 协议清成空串——放行 cite:，其余仍走默认净化
        urlTransform={(url) => (url.startsWith("cite:") ? url : defaultUrlTransform(url))}
        components={{
          a({ href, children }) {
            const cm = /^cite:(\d+)$/.exec(href ?? "");
            if (!cm) {
              return (
                <a href={href} target="_blank" rel="noreferrer">
                  {children}
                </a>
              );
            }
            const n = Number(cm[1]);
            const known = citations.some((c) => c.n === n);
            const active = activeN === n;
            return (
              <span
                onClick={() => known && onPickCite(msgKey, n)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  minWidth: 17,
                  height: 17,
                  padding: "0 3px",
                  margin: "0 3px",
                  borderRadius: 4,
                  background: active ? "#1677ff" : "#e6f4ff",
                  color: active ? "#fff" : "#1677ff",
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: known ? "pointer" : "default",
                  verticalAlign: 2,
                  userSelect: "none",
                }}
              >
                {n}
              </span>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
