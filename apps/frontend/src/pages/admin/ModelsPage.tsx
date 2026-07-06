import { useState } from "react";
import { Button, Card, Drawer, Form, Input, Select, Space, Table, Tag } from "antd";
import type { TableProps } from "antd";
import type { ModelProvider } from "@codecrush/contracts";
import { MOCK_MODELS } from "../../mocks/models";
import { StatusTag } from "../../components/StatusTag";

/** 模型调用管理：列表 + 测试连接 + 新接入抽屉。M3 接真实 /api/models。 */
export default function ModelsPage() {
  const [open, setOpen] = useState(false);
  const [testMsg, setTestMsg] = useState<string | null>(null);

  const columns: TableProps<ModelProvider>["columns"] = [
    { title: "模型", dataIndex: "name", key: "name" },
    { title: "厂商", dataIndex: "provider", key: "provider", width: 120 },
    {
      title: "类型",
      dataIndex: "type",
      key: "type",
      width: 110,
      render: (t: ModelProvider["type"]) => <Tag>{t}</Tag>,
    },
    { title: "角色", dataIndex: "role", key: "role", width: 90 },
    { title: "Base URL", dataIndex: "baseUrl", key: "baseUrl" },
    { title: "API Key", dataIndex: "apiKeyMasked", key: "apiKeyMasked", width: 140 },
    {
      title: "状态",
      dataIndex: "enabled",
      key: "enabled",
      width: 100,
      render: (e: boolean) => (e ? <StatusTag status="active" /> : <Tag>未启用</Tag>),
    },
    {
      title: "操作",
      key: "op",
      width: 110,
      render: (_, r) => (
        <a onClick={() => setTestMsg(`「${r.name}」测试连接：成功（mock）`)}>测试连接</a>
      ),
    },
  ];

  return (
    <Card title="模型调用管理">
      <Space style={{ marginBottom: 12 }}>
        <Button type="primary" onClick={() => setOpen(true)}>
          新接入模型
        </Button>
        {testMsg && <span style={{ color: "#52c41a" }}>{testMsg}</span>}
      </Space>
      <Table dataSource={MOCK_MODELS} columns={columns} rowKey="id" pagination={false} />
      <Drawer title="新接入模型" open={open} onClose={() => setOpen(false)} width={420}>
        <Form layout="vertical">
          <Form.Item label="类型" name="type">
            <Select
              options={[
                { value: "llm", label: "LLM" },
                { value: "embedding", label: "Embedding" },
                { value: "rerank", label: "Rerank" },
              ]}
            />
          </Form.Item>
          <Form.Item label="厂商" name="provider">
            <Input placeholder="openai / deepseek / bge" />
          </Form.Item>
          <Form.Item label="模型名" name="name">
            <Input placeholder="gpt-4o" />
          </Form.Item>
          <Form.Item label="Base URL" name="baseUrl">
            <Input placeholder="https://api.openai.com/v1" />
          </Form.Item>
          <Form.Item label="API Key" name="apiKey">
            <Input.Password placeholder="sk-..." />
          </Form.Item>
          <Form.Item label="角色" name="role">
            <Input placeholder="生成 / 轻量 / 向量 / 重排" />
          </Form.Item>
        </Form>
      </Drawer>
    </Card>
  );
}
