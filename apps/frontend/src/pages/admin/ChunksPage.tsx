import { useState } from "react";
import { Card, Switch, Table } from "antd";
import type { TableProps } from "antd";
import { Link, useParams } from "react-router-dom";
import type { Chunk } from "@codecrush/contracts";
import { MOCK_CHUNKS } from "../../mocks/knowledge-bases";

/** 文档切片：列表 + 启用/禁用开关（本地态，M4 接 PATCH /api/chunks/:id）。 */
export default function ChunksPage() {
  const { kbId = "", docId = "" } = useParams<{ kbId: string; docId: string }>();
  const [chunks, setChunks] = useState<Chunk[]>(MOCK_CHUNKS.filter((c) => c.docId === docId));

  const toggle = (id: string, enabled: boolean) => {
    setChunks((prev) => prev.map((c) => (c.id === id ? { ...c, enabled } : c)));
  };

  const columns: TableProps<Chunk>["columns"] = [
    { title: "#", dataIndex: "seq", key: "seq", width: 60 },
    { title: "章节", dataIndex: "section", key: "section", width: 200 },
    { title: "内容", dataIndex: "text", key: "text" },
    { title: "Token", dataIndex: "tokenCount", key: "tokenCount", width: 90 },
    {
      title: "启用",
      key: "enabled",
      width: 80,
      render: (_, r) => <Switch checked={r.enabled} onChange={(v) => toggle(r.id, v)} />,
    },
  ];

  return (
    <Card
      title={`文档切片（${docId}）`}
      extra={<Link to={`/admin/knowledge-bases/${kbId}/documents`}>返回文档</Link>}
    >
      {chunks.length === 0 ? (
        <div>该文档暂无切片（mock 数据为空）。</div>
      ) : (
        <Table dataSource={chunks} columns={columns} rowKey="id" pagination={false} />
      )}
    </Card>
  );
}
