import { useState } from "react";
import { Button, Card, Form, Input, InputNumber, Select, Switch, Table, Tag } from "antd";
import type { TableProps } from "antd";
import type { RetrievalHit } from "@codecrush/contracts";
import { MOCK_RETRIEVAL_HITS } from "../../mocks/retrieval";
import { MOCK_KNOWLEDGE_BASES } from "../../mocks/knowledge-bases";
import { MOCK_MODELS } from "../../mocks/models";

/** 检索测试台：查询 + 参数 + 结果表。M2 用 mock 命中；M5 接 POST /api/retrieval/test。 */
export default function RetrievalTestPage() {
  const [hits, setHits] = useState<RetrievalHit[]>([]);
  const [loading, setLoading] = useState(false);

  const onSearch = () => {
    setLoading(true);
    // M2 mock：直接返回 mock 命中。M5 接真实 /api/retrieval/test。
    setTimeout(() => {
      setHits(MOCK_RETRIEVAL_HITS);
      setLoading(false);
    }, 200);
  };

  const columns: TableProps<RetrievalHit>["columns"] = [
    { title: "切片", dataIndex: "chunkId", key: "chunkId", width: 100 },
    { title: "文档", dataIndex: "docName", key: "docName", width: 160 },
    { title: "章节", dataIndex: "section", key: "section", width: 120 },
    { title: "内容", dataIndex: "text", key: "text" },
    { title: "向量分", dataIndex: "vecScore", key: "vecScore", width: 90 },
    { title: "关键词分", dataIndex: "kwScore", key: "kwScore", width: 100 },
    { title: "重排分", dataIndex: "rerankScore", key: "rerankScore", width: 90 },
    {
      title: "综合",
      dataIndex: "finalScore",
      key: "finalScore",
      width: 80,
      render: (v: number) => <Tag color="blue">{v.toFixed(2)}</Tag>,
    },
  ];

  return (
    <Card title="检索测试">
      <Form
        layout="inline"
        initialValues={{
          kbId: "kb1",
          embedModelId: "m3",
          topK: 20,
          threshold: 0.2,
          multi: true,
          topN: 5,
          rerankModelId: "m4",
        }}
      >
        <Form.Item name="query" label="查询" style={{ minWidth: 320 }}>
          <Input.TextArea rows={1} placeholder="输入测试查询" />
        </Form.Item>
        <Form.Item name="kbId" label="知识库">
          <Select
            style={{ width: 160 }}
            options={MOCK_KNOWLEDGE_BASES.map((k) => ({ value: k.id, label: k.name }))}
          />
        </Form.Item>
        <Form.Item name="embedModelId" label="向量模型">
          <Select
            style={{ width: 140 }}
            options={MOCK_MODELS.filter((m) => m.type === "embedding").map((m) => ({
              value: m.id,
              label: m.name,
            }))}
          />
        </Form.Item>
        <Form.Item name="topK" label="topK">
          <InputNumber min={1} />
        </Form.Item>
        <Form.Item name="topN" label="topN">
          <InputNumber min={1} />
        </Form.Item>
        <Form.Item name="threshold" label="阈值">
          <InputNumber min={0} max={1} step={0.05} />
        </Form.Item>
        <Form.Item name="rerankModelId" label="重排模型">
          <Select
            style={{ width: 160 }}
            options={MOCK_MODELS.filter((m) => m.type === "rerank").map((m) => ({
              value: m.id,
              label: m.name,
            }))}
          />
        </Form.Item>
        <Form.Item name="multi" label="多路召回" valuePropName="checked">
          <Switch />
        </Form.Item>
        <Form.Item>
          <Button type="primary" loading={loading} onClick={onSearch}>
            检索
          </Button>
        </Form.Item>
      </Form>
      <Table
        style={{ marginTop: 16 }}
        dataSource={hits}
        columns={columns}
        rowKey="chunkId"
        pagination={false}
        locale={{ emptyText: "点击「检索」查看 mock 命中结果" }}
      />
    </Card>
  );
}
