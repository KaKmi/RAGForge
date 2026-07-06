import { Button, Card, Table } from "antd";
import type { TableProps } from "antd";
import { useNavigate } from "react-router-dom";
import type { KnowledgeBase } from "@codecrush/contracts";
import { MOCK_KNOWLEDGE_BASES } from "../../mocks/knowledge-bases";
import { StatusTag } from "../../components/StatusTag";

/** 知识库管理：列表 + 新建按钮，点击「文档」进文档页。M4 接真实 /api/knowledge-bases。 */
export default function KnowledgeBasesPage() {
  const nav = useNavigate();

  const columns: TableProps<KnowledgeBase>["columns"] = [
    { title: "名称", dataIndex: "name", key: "name" },
    { title: "简介", dataIndex: "desc", key: "desc" },
    { title: "嵌入模型", dataIndex: "embeddingModelId", key: "embeddingModelId", width: 110 },
    { title: "文档数", dataIndex: "docsCount", key: "docsCount", width: 90 },
    { title: "切片数", dataIndex: "chunksCount", key: "chunksCount", width: 100 },
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      width: 110,
      render: (s: KnowledgeBase["status"], r) => (
        <StatusTag status={s} label={s === "building" && r.progress ? `构建中 ${r.progress}%` : undefined} />
      ),
    },
    { title: "更新时间", dataIndex: "updatedAt", key: "updatedAt", width: 180 },
    {
      title: "操作",
      key: "op",
      width: 80,
      render: (_, r) => (
        <a onClick={() => nav(`/admin/knowledge-bases/${r.id}/documents`)}>文档</a>
      ),
    },
  ];

  return (
    <Card title="知识库管理">
      <Button type="primary" style={{ marginBottom: 12 }}>
        新建知识库
      </Button>
      <Table dataSource={MOCK_KNOWLEDGE_BASES} columns={columns} rowKey="id" pagination={false} />
    </Card>
  );
}
