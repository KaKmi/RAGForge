import { Card, Col, Row, Statistic, Table, Typography } from "antd";
import type { TableProps } from "antd";
import { MOCK_AGENT_DIST, MOCK_DASHBOARD } from "../../mocks/dashboard";

/** 运行看板：stats / agentDist / hotQs（M10 接真实看板数据）。 */
export default function DashboardPage() {
  const hotColumns: TableProps<(typeof MOCK_DASHBOARD)["hotQuestions"][number]>["columns"] = [
    { title: "问题", dataIndex: "q" },
    { title: "次数", dataIndex: "count", width: 100 },
  ];
  const distColumns: TableProps<(typeof MOCK_AGENT_DIST)[number]>["columns"] = [
    { title: "Agent", dataIndex: "name" },
    { title: "问答数", dataIndex: "count", width: 120 },
  ];

  return (
    <Card title="运行看板">
      <Row gutter={16}>
        <Col span={6}>
          <Statistic title="今日问答量" value={MOCK_DASHBOARD.todayQuestions} />
        </Col>
        <Col span={6}>
          <Statistic title="平均耗时" value={MOCK_DASHBOARD.avgDurationMs} suffix="ms" />
        </Col>
        <Col span={6}>
          <Statistic
            title="兜底率"
            value={MOCK_DASHBOARD.fallbackRate * 100}
            precision={1}
            suffix="%"
          />
        </Col>
      </Row>
      <Typography.Title level={5} style={{ marginTop: 16 }}>
        热门问题
      </Typography.Title>
      <Table
        dataSource={MOCK_DASHBOARD.hotQuestions}
        columns={hotColumns}
        rowKey="q"
        pagination={false}
        size="small"
      />
      <Typography.Title level={5} style={{ marginTop: 16 }}>
        Agent 分布
      </Typography.Title>
      <Table
        dataSource={MOCK_AGENT_DIST}
        columns={distColumns}
        rowKey="name"
        pagination={false}
        size="small"
      />
    </Card>
  );
}
