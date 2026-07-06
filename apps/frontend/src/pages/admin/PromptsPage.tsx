import { useState } from "react";
import { Button, Card, Drawer, Space, Table, Tag, Typography } from "antd";
import type { TableProps } from "antd";
import type { Prompt, PromptVersion } from "@codecrush/contracts";
import { MOCK_PROMPTS, MOCK_PROMPT_VERSIONS } from "../../mocks/prompts";
import { StatusTag } from "../../components/StatusTag";

const NODE_LABEL: Record<Prompt["node"], string> = {
  rewrite: "查询改写",
  intent: "意图识别",
  reply: "回复生成",
  fallback: "兜底",
};

/** Prompt 管理：4 节点列表 + 版本管理抽屉（版本列表 + body 预览）。M6 接真实 /api/prompts。 */
export default function PromptsPage() {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState<Prompt | null>(null);
  const versions = current ? MOCK_PROMPT_VERSIONS.filter((v) => v.promptId === current.id) : [];

  const columns: TableProps<Prompt>["columns"] = [
    { title: "名称", dataIndex: "name", key: "name" },
    {
      title: "节点",
      dataIndex: "node",
      key: "node",
      width: 120,
      render: (n: Prompt["node"]) => <Tag>{NODE_LABEL[n]}</Tag>,
    },
    { title: "当前版本", dataIndex: "currentVersionId", key: "currentVersionId", width: 140 },
    {
      title: "操作",
      key: "op",
      width: 110,
      render: (_, r) => (
        <a
          onClick={() => {
            setCurrent(r);
            setOpen(true);
          }}
        >
          版本管理
        </a>
      ),
    },
  ];

  const versionColumns: TableProps<PromptVersion>["columns"] = [
    { title: "版本", dataIndex: "version", key: "version", width: 70, render: (v: number) => `v${v}` },
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      width: 90,
      render: (s: PromptVersion["status"]) => <StatusTag status={s} />,
    },
    { title: "作者", dataIndex: "author", key: "author", width: 100 },
    { title: "备注", dataIndex: "note", key: "note" },
  ];

  return (
    <Card title="Prompt 管理">
      <Button type="primary" style={{ marginBottom: 12 }}>
        新建 Prompt
      </Button>
      <Table dataSource={MOCK_PROMPTS} columns={columns} rowKey="id" pagination={false} />
      <Drawer
        title={current?.name ?? "版本管理"}
        open={open}
        onClose={() => setOpen(false)}
        size={640}
      >
        <Space orientation="vertical" style={{ width: "100%" }}>
          <Table
            dataSource={versions}
            columns={versionColumns}
            rowKey="id"
            pagination={false}
            size="small"
          />
          {versions.map((v) => (
            <Card key={v.id} size="small" title={`v${v.version} · ${v.status}`} extra={v.author}>
              <Typography.Paragraph style={{ whiteSpace: "pre-wrap" }}>
                {v.body}
              </Typography.Paragraph>
              <div>
                变量：
                {v.variables.map((x) => (
                  <Tag key={x}>{`{{${x}}}`}</Tag>
                ))}
              </div>
              {v.note && <div style={{ color: "#888" }}>{v.note}</div>}
            </Card>
          ))}
        </Space>
      </Drawer>
    </Card>
  );
}
