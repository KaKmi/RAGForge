import { useState } from "react";
import { Button, Card, Drawer, Space, Table } from "antd";
import type { TableProps } from "antd";
import type { Agent } from "@codecrush/contracts";
import { MOCK_AGENTS } from "../../mocks/agents";
import { StatusTag } from "../../components/StatusTag";

/** Agent 管理：列表 + 编辑抽屉壳（M7 填配置逻辑）。 */
export default function AgentsPage() {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState<Agent | null>(null);

  const columns: TableProps<Agent>["columns"] = [
    { title: "名称", dataIndex: "name", key: "name" },
    { title: "简介", dataIndex: "desc", key: "desc" },
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      render: (s: Agent["status"]) => <StatusTag status={s} />,
    },
    {
      title: "操作",
      key: "op",
      render: (_, r) => (
        <a
          onClick={() => {
            setCurrent(r);
            setOpen(true);
          }}
        >
          编辑
        </a>
      ),
    },
  ];

  return (
    <Card title="Agent 管理">
      <Button type="primary" style={{ marginBottom: 12 }}>
        新建 Agent
      </Button>
      <Table dataSource={MOCK_AGENTS} columns={columns} rowKey="id" pagination={false} />
      <Drawer
        title={current?.name ?? "编辑 Agent"}
        open={open}
        onClose={() => setOpen(false)}
        size={480}
      >
        {current && (
          <Space orientation="vertical" style={{ width: "100%" }}>
            <div>状态：{current.status}</div>
            <div>生成模型：{current.genModelId}</div>
            <div>轻量模型：{current.lightModelId ?? "—"}</div>
            <div>重排模型：{current.rerankModelId ?? "—"}</div>
            <div>绑定 KB：{current.kbs.join(", ") || "—"}</div>
            <div>
              topK：{current.topK} / topN：{current.topN} / threshold：{current.threshold}
            </div>
            <div>
              多路召回：{current.multi ? "是" : "否"} / 兜底转人工：
              {current.fallbackHuman ? "是" : "否"}
            </div>
          </Space>
        )}
      </Drawer>
    </Card>
  );
}
