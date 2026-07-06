import { Button, Card, Col, Row, Statistic, Table, Tag, Typography } from "antd";
import type { TableProps } from "antd";
import { useNavigate, useParams } from "react-router-dom";
import type { EvalCaseResult, EvalRun } from "@codecrush/contracts";
import { MOCK_EVAL_RUNS } from "../../mocks/evals";

/**
 * 评测运行：列表 + 报告详情子视图。
 * /admin/evaluations → 列表；/admin/evaluations/:reportId → 报告详情。
 */
export default function EvalsPage() {
  const { reportId } = useParams<{ reportId?: string }>();
  const nav = useNavigate();

  if (reportId) {
    const run = MOCK_EVAL_RUNS.find((r) => r.id === reportId);
    if (!run) {
      return (
        <Card title="评测报告">
          <div>未找到报告 {reportId}。</div>
        </Card>
      );
    }
    const caseColumns: TableProps<EvalCaseResult>["columns"] = [
      { title: "问题", dataIndex: "q", key: "q" },
      {
        title: "召回",
        dataIndex: "recall",
        key: "recall",
        width: 90,
        render: (s: string) => <Tag color={s === "命中" ? "green" : "red"}>{s}</Tag>,
      },
      {
        title: "准确",
        dataIndex: "acc",
        key: "acc",
        width: 90,
        render: (s: string) => <Tag color={s === "正确" ? "green" : "red"}>{s}</Tag>,
      },
      { title: "引用", dataIndex: "cite", key: "cite", width: 100 },
      {
        title: "结果",
        dataIndex: "st",
        key: "st",
        width: 80,
        render: (s: string) => <Tag color={s === "通过" ? "green" : "red"}>{s}</Tag>,
      },
      { title: "标签", dataIndex: "tag", key: "tag", width: 100 },
    ];
    return (
      <Card
        title={`评测报告 · ${run.id}`}
        extra={<Button onClick={() => nav("/admin/evaluations")}>返回列表</Button>}
      >
        <Row gutter={16}>
          {run.metrics.map((m) => (
            <Col key={m.label} span={6}>
              <Card size="small">
                <Statistic title={m.label} value={m.pct ?? m.value} />
              </Card>
            </Col>
          ))}
        </Row>
        <Typography.Title level={5} style={{ marginTop: 16 }}>
          用例详情
        </Typography.Title>
        <Table dataSource={run.cases} columns={caseColumns} rowKey="q" pagination={false} size="small" />
      </Card>
    );
  }

  const columns: TableProps<EvalRun>["columns"] = [
    { title: "运行", dataIndex: "id", key: "id" },
    { title: "Agent", dataIndex: "agentId", key: "agentId" },
    { title: "用例数", dataIndex: "total", key: "total", width: 90 },
    { title: "时间", dataIndex: "time", key: "time", width: 180 },
    {
      title: "指标",
      key: "metrics",
      render: (_, r) =>
        r.metrics.map((m) => (
          <Tag key={m.label} color={m.color}>
            {m.label} {m.pct}
          </Tag>
        )),
    },
    {
      title: "操作",
      key: "op",
      width: 110,
      render: (_, r) => <a onClick={() => nav(`/admin/evaluations/${r.id}`)}>查看报告</a>,
    },
  ];

  return (
    <Card title="评测运行">
      <Table dataSource={MOCK_EVAL_RUNS} columns={columns} rowKey="id" pagination={false} />
    </Card>
  );
}
