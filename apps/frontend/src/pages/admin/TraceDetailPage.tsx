import { Button, Card, Space, Table, Typography } from "antd";
import type { TableProps } from "antd";
import { Link, useParams } from "react-router-dom";
import type { TraceSpan } from "@codecrush/contracts";
import { MOCK_TRACE_DETAIL } from "../../mocks/traces";

/** 计算 span 深度（按 parentSpanId 回溯）用于树形缩进。 */
function buildDepth(spans: TraceSpan[]): Map<string, number> {
  const depth = new Map<string, number>();
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  for (const s of spans) {
    let d = 0;
    let cur: TraceSpan | undefined = s;
    while (cur?.parentSpanId) {
      const p = byId.get(cur.parentSpanId);
      if (!p) break;
      d += 1;
      cur = p;
    }
    depth.set(s.spanId, d);
  }
  return depth;
}

/** Trace 详情：span 树 + 瀑布图 + OTLP JSON 导出。M9 接真实读模型。 */
export default function TraceDetailPage() {
  const { traceId = "" } = useParams<{ traceId: string }>();
  // M2：mock 单条详情；M9 按 traceId 取真实读模型（ClickHouse VIEW）
  const detail = MOCK_TRACE_DETAIL;
  const spans = detail.spans;
  const depth = buildDepth(spans);
  const rootStart = new Date(spans[0].startTime).getTime();
  const total = Math.max(...spans.map((s) => s.durationMs), 1);

  const columns: TableProps<TraceSpan>["columns"] = [
    {
      title: "Span",
      dataIndex: "name",
      key: "name",
      render: (_, r) => (
        <span style={{ paddingLeft: (depth.get(r.spanId) ?? 0) * 16 }}>{r.name}</span>
      ),
    },
    {
      title: "耗时",
      dataIndex: "durationMs",
      key: "durationMs",
      width: 100,
      render: (v: number) => `${v} ms`,
    },
    { title: "开始", dataIndex: "startTime", key: "startTime", width: 240 },
    {
      title: "瀑布",
      key: "waterfall",
      width: 240,
      render: (_, r) => {
        const start = new Date(r.startTime).getTime() - rootStart;
        const leftPct = (start / total) * 100;
        const widthPct = (r.durationMs / total) * 100;
        return (
          <div style={{ position: "relative", height: 12, background: "#f0f0f0", borderRadius: 6 }}>
            <div
              style={{
                position: "absolute",
                left: `${leftPct}%`,
                width: `${widthPct}%`,
                height: "100%",
                background: "#1677ff",
                borderRadius: 6,
              }}
            />
          </div>
        );
      },
    },
  ];

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(detail, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${traceId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Card
      title={`Trace 详情 · ${traceId}`}
      extra={
        <Space>
          <Link to="/admin/traces">
            <Button>返回列表</Button>
          </Link>
          <Button onClick={exportJson}>导出 OTLP JSON</Button>
        </Space>
      }
    >
      <Typography.Paragraph type="secondary">
        span 树 + 瀑布图（mock，M9 接真实读模型）
      </Typography.Paragraph>
      <Table dataSource={spans} columns={columns} rowKey="spanId" pagination={false} size="small" />
    </Card>
  );
}
