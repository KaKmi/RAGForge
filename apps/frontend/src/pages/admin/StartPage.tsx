import { Button, Card, Steps } from "antd";
import { Link } from "react-router-dom";

const STEPS = [
  { title: "接入模型", desc: "配置 LLM / Embedding / Rerank", to: "/admin/models" },
  { title: "创建知识库", desc: "选择嵌入模型，新建知识库", to: "/admin/knowledge-bases" },
  { title: "上传文档", desc: "上传 PDF/Word/Markdown，自动切片入库", to: "/admin/knowledge-bases" },
  { title: "配置 Prompt", desc: "改写/意图/回复/兜底 四节点", to: "/admin/prompts" },
  { title: "创建 Agent", desc: "绑定 KB + 模型 + Prompt", to: "/admin/agents" },
  { title: "检索测试", desc: "验证召回质量", to: "/admin/retrieval-test" },
];

/** 快速开始：6 步引导，每步「去配置」跳对应路由。 */
export default function StartPage() {
  return (
    <Card title="快速开始">
      <Steps
        current={0}
        orientation="vertical"
        items={STEPS.map((s) => ({ title: s.title, content: s.desc }))}
      />
      <div style={{ marginTop: 16 }}>
        {STEPS.map((s) => (
          // 用 title 作 key：步骤 2/3 都指向 /admin/knowledge-bases，用 to 会撞 key。
          <Link key={s.title} to={s.to}>
            <Button style={{ marginRight: 8, marginBottom: 8 }}>去配置：{s.title}</Button>
          </Link>
        ))}
      </div>
    </Card>
  );
}
