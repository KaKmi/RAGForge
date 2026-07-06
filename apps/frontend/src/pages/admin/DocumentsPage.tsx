import { Button, Card, Space, Table } from "antd";
import type { TableProps } from "antd";
import { Link, useParams } from "react-router-dom";
import type { Document } from "@codecrush/contracts";
import { MOCK_DOCUMENTS } from "../../mocks/knowledge-bases";
import { StatusTag } from "../../components/StatusTag";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 知识库文档：列表 + 上传按钮 + 生命周期状态 tag。M4 接真实 /api/documents。 */
export default function DocumentsPage() {
  const { kbId = "" } = useParams<{ kbId: string }>();
  const docs = MOCK_DOCUMENTS.filter((d) => d.kbId === kbId);

  const columns: TableProps<Document>["columns"] = [
    { title: "文件名", dataIndex: "name", key: "name" },
    { title: "类型", dataIndex: "type", key: "type", width: 90 },
    {
      title: "大小",
      dataIndex: "size",
      key: "size",
      width: 100,
      render: (s: number) => formatSize(s),
    },
    { title: "切片数", dataIndex: "chunksCount", key: "chunksCount", width: 90 },
    {
      title: "状态",
      key: "status",
      width: 160,
      render: (_, r) => (
        <Space direction="vertical" size={0}>
          <StatusTag status={r.status} label={r.status === "ingest" ? r.stage : undefined} />
          {r.status === "failed" && r.error && (
            <span style={{ color: "#ff4d4f", fontSize: 12 }}>{r.error}</span>
          )}
        </Space>
      ),
    },
    { title: "更新时间", dataIndex: "updatedAt", key: "updatedAt", width: 180 },
    {
      title: "操作",
      key: "op",
      width: 80,
      render: (_, r) => (
        <Link to={`/admin/knowledge-bases/${kbId}/documents/${r.id}/chunks`}>切片</Link>
      ),
    },
  ];

  return (
    <Card
      title={`知识库文档（${kbId}）`}
      extra={<Link to="/admin/knowledge-bases">返回知识库</Link>}
    >
      <Button type="primary" style={{ marginBottom: 12 }}>
        上传文档
      </Button>
      {docs.length === 0 ? (
        <div>该知识库暂无文档（mock 数据为空）。</div>
      ) : (
        <Table dataSource={docs} columns={columns} rowKey="id" pagination={false} />
      )}
    </Card>
  );
}
