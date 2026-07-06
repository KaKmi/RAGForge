import { useState } from "react";
import { Card, Input, Select, Space, Table } from "antd";
import type { TableProps } from "antd";
import { useNavigate } from "react-router-dom";
import type { TraceListItem } from "../../mocks/traces";
import { MOCK_TRACES } from "../../mocks/traces";
import { StatusTag } from "../../components/StatusTag";

/** Trace 追踪：列表 + 筛选（query/agent/status）。M9 接真实读模型。 */
export default function TracesPage() {
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const [agent, setAgent] = useState<string | undefined>();
  const [status, setStatus] = useState<string | undefined>();

  const filtered = MOCK_TRACES.filter((t) => {
    if (q && !t.query.includes(q)) return false;
    if (agent && t.agentName !== agent) return false;
    if (status && t.status !== status) return false;
    return true;
  });

  const columns: TableProps<TraceListItem>["columns"] = [
    { title: "Trace ID", dataIndex: "id", key: "id", width: 320, ellipsis: true },
    { title: "Agent", dataIndex: "agentName", key: "agentName", width: 160 },
    { title: "查询", dataIndex: "query", key: "query" },
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      width: 90,
      render: (s: TraceListItem["status"]) => <StatusTag status={s} />,
    },
    {
      title: "耗时",
      dataIndex: "durationMs",
      key: "durationMs",
      width: 100,
      render: (v: number) => `${v} ms`,
    },
    { title: "时间", dataIndex: "time", key: "time", width: 180 },
    {
      title: "操作",
      key: "op",
      width: 80,
      render: (_, r) => <a onClick={() => nav(`/admin/traces/${r.id}`)}>详情</a>,
    },
  ];

  return (
    <Card title="Trace 追踪">
      <Space style={{ marginBottom: 12 }}>
        <Input
          placeholder="搜索查询"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ width: 200 }}
        />
        <Select
          placeholder="Agent"
          allowClear
          style={{ width: 160 }}
          value={agent}
          onChange={setAgent}
          options={[...new Set(MOCK_TRACES.map((t) => t.agentName))].map((a) => ({
            value: a,
            label: a,
          }))}
        />
        <Select
          placeholder="状态"
          allowClear
          style={{ width: 120 }}
          value={status}
          onChange={setStatus}
          options={[
            { value: "ok", label: "成功" },
            { value: "error", label: "错误" },
          ]}
        />
      </Space>
      <Table dataSource={filtered} columns={columns} rowKey="id" pagination={false} />
    </Card>
  );
}
