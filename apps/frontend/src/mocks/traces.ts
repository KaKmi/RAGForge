import type { TraceDetailResponse, TraceSpan } from "@codecrush/contracts";

/** M2 mock：Trace 追踪 / 详情页用。M9 接真实读模型（ClickHouse VIEW）。 */

/** Trace 列表项（M9 读模型未定，本地类型；M9 落 contracts） */
export interface TraceListItem {
  id: string;
  agentName: string;
  query: string;
  status: "ok" | "error";
  durationMs: number;
  time: string;
}

export const MOCK_TRACES: TraceListItem[] = [
  {
    id: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
    agentName: "售后客服 Agent",
    query: "退货流程怎么走？",
    status: "ok",
    durationMs: 1240,
    time: "2026-07-06T09:00:00Z",
  },
  {
    id: "b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7",
    agentName: "售前咨询 Agent",
    query: "这款产品支持防水吗",
    status: "error",
    durationMs: 3120,
    time: "2026-07-06T10:05:00Z",
  },
  {
    id: "c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8",
    agentName: "售后客服 Agent",
    query: "保修期多久",
    status: "ok",
    durationMs: 980,
    time: "2026-07-06T10:30:00Z",
  },
];

const TID = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";

export const MOCK_TRACE_DETAIL: TraceDetailResponse = {
  traceId: TID,
  spans: [
    {
      traceId: TID,
      spanId: "0000000000000001",
      parentSpanId: null,
      name: "rag.orchestrate",
      kind: "internal",
      startTime: "2026-07-06T09:00:00Z",
      durationMs: 1240,
      statusCode: "UNSET",
      attributes: { "rag.agent_id": "aftersale" },
    },
    {
      traceId: TID,
      spanId: "0000000000000002",
      parentSpanId: "0000000000000001",
      name: "gen_ai.rewrite",
      kind: "internal",
      startTime: "2026-07-06T09:00:00.05Z",
      durationMs: 180,
      statusCode: "UNSET",
      attributes: { "gen_ai.system": "openai" },
    },
    {
      traceId: TID,
      spanId: "0000000000000003",
      parentSpanId: "0000000000000001",
      name: "rag.retrieve",
      kind: "internal",
      startTime: "2026-07-06T09:00:00.25Z",
      durationMs: 320,
      statusCode: "UNSET",
      attributes: { "rag.top_k": 20 },
    },
    {
      traceId: TID,
      spanId: "0000000000000004",
      parentSpanId: "0000000000000003",
      name: "rag.rerank",
      kind: "internal",
      startTime: "2026-07-06T09:00:00.4Z",
      durationMs: 90,
      statusCode: "UNSET",
      attributes: { "rag.top_n": 5 },
    },
    {
      traceId: TID,
      spanId: "0000000000000005",
      parentSpanId: "0000000000000001",
      name: "gen_ai.reply",
      kind: "internal",
      startTime: "2026-07-06T09:00:00.6Z",
      durationMs: 620,
      statusCode: "UNSET",
      attributes: { "gen_ai.system": "openai" },
    },
  ],
};

/** 瀑布图节点（按 span 平铺，供 TraceDetail 渲染壳） */
export const MOCK_TRACE_NODES: TraceSpan[] = MOCK_TRACE_DETAIL.spans;
