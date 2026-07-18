import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Button,
  Empty,
  Flex,
  Progress,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
  type TableColumnsType,
} from "antd";
import { useNavigate } from "react-router-dom";
import type { EvalRunListItem, EvalRunStatus } from "@codecrush/contracts";
import { getEvalRuns } from "../../api/client";
import { COMPARABLE_RUN_STATUSES } from "./evalShared";

const { Title, Text } = Typography;

/** 原型 §7「run 列表页 /admin/eval/runs：时间倒序，列=评测集/配置版本/状态/综合分/耗时」。 */

/** §18.A 状态机逐字对齐；文案取 §17.3「排队/运行中(进度%)/完成/部分完成/预算中断/失败」。 */
const RUN_STATUS_LABEL: Record<EvalRunStatus, string> = {
  queued: "排队",
  running: "运行中",
  done: "完成",
  partial: "部分完成",
  budget_stop: "预算中断",
  failed: "失败",
};
const RUN_STATUS_COLOR: Record<EvalRunStatus, string | undefined> = {
  queued: undefined,
  running: "processing",
  done: "green",
  partial: "gold",
  budget_stop: "orange",
  failed: "red",
};

/** ISO datetime → "MM-DD HH:mm"（原型 §7「07-14 14:20」）。UTC 存、本地显（§17）。 */
function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** ms → "3m12s"（原型 §7）。 */
function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m${String(s).padStart(2, "0")}s` : `${s}s`;
}

export default function EvalRunsPage() {
  const navigate = useNavigate();
  const [runs, setRuns] = useState<EvalRunListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);

  const selectedRuns = useMemo(
    () => selectedKeys.map((k) => runs.find((r) => r.id === k)).filter((r): r is EvalRunListItem => !!r),
    [selectedKeys, runs],
  );
  // 恰 2 个、同评测集、均为可对比终态（§17.3）。
  const canCompare =
    selectedRuns.length === 2 &&
    selectedRuns[0].setId === selectedRuns[1].setId &&
    selectedRuns.every((r) => COMPARABLE_RUN_STATUSES.includes(r.status));

  const goCompare = () => {
    if (!canCompare) return;
    // a=较早、b=较新（按 createdAt 排）。
    const [a, b] = [...selectedRuns].sort(
      (x, y) => new Date(x.createdAt).getTime() - new Date(y.createdAt).getTime(),
    );
    navigate(`/admin/eval/compare?a=${a.id}&b=${b.id}`);
  };

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setRuns(await getEvalRuns());
    } catch (error) {
      // §17：接口失败一律 message.error + 保留上次数据（不清空不白屏）
      message.error(error instanceof Error ? error.message : "评测列表加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const columns: TableColumnsType<EvalRunListItem> = [
    {
      title: "评测集",
      key: "set",
      render: (_: unknown, row) => (
        <div>
          <div style={{ fontWeight: 500 }}>{row.setName}</div>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {formatDateTime(row.createdAt)}
          </Text>
        </div>
      ),
    },
    {
      title: "配置版本",
      key: "version",
      width: 160,
      render: (_: unknown, row) => <Text>{row.configVersionLabel}</Text>,
    },
    {
      title: "状态",
      key: "status",
      width: 170,
      // §17.3：状态 tag「运行中」带进度百分比
      render: (_: unknown, row) => {
        const totalUnits = row.totalCases * row.repeatCount;
        return (
          <Flex align="center" gap={8}>
            <Tag color={RUN_STATUS_COLOR[row.status]} style={{ margin: 0 }}>
              {RUN_STATUS_LABEL[row.status]}
            </Tag>
            {row.status === "running" && totalUnits > 0 && (
              <Progress
                type="line"
                size="small"
                style={{ width: 60, margin: 0 }}
                percent={Math.round((row.doneCases / totalUnits) * 100)}
              />
            )}
            {(row.status === "partial" || row.status === "budget_stop") && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                {row.doneCases}/{totalUnits}
              </Text>
            )}
          </Flex>
        );
      },
    },
    {
      title: "综合分",
      key: "overallScore",
      width: 110,
      // null 必须渲染「—」，绝不是 0（本波中心不变式）
      render: (_: unknown, row) =>
        row.overallScore === null ? (
          <Text type="secondary">—</Text>
        ) : (
          <span style={{ fontWeight: 600 }}>{row.overallScore.toFixed(1)}</span>
        ),
    },
    {
      title: "耗时",
      key: "duration",
      width: 110,
      render: (_: unknown, row) => <Text type="secondary">{formatDuration(row.durationMs)}</Text>,
    },
  ];

  return (
    <div>
      <Flex align="center" justify="space-between" gap={12} wrap style={{ marginBottom: 16 }}>
        <div>
          <Title level={4} style={{ margin: 0 }}>
            效果评测
          </Title>
          <Text type="secondary" style={{ fontSize: 12 }}>
            一次「评测集 × 配置版本」的完整跑分；点击行查看报告
          </Text>
        </div>
        {/* §17.3：勾选恰 2 个同评测集终态 run → 顶部浮出「对比」主按钮。 */}
        {selectedKeys.length > 0 && (
          <Tooltip title={canCompare ? "" : "勾选同一评测集的 2 个 run 进行对比"}>
            <Button type="primary" disabled={!canCompare} onClick={goCompare}>
              对比
            </Button>
          </Tooltip>
        )}
      </Flex>

      <Table<EvalRunListItem>
        rowKey="id"
        loading={loading}
        columns={columns}
        // 后端已按 createdAt 倒序返回（原型 §7「时间倒序」），前端不再二次排序。
        dataSource={runs}
        rowSelection={{
          selectedRowKeys: selectedKeys,
          onChange: (keys) => setSelectedKeys(keys as string[]),
        }}
        pagination={{ pageSize: 20, hideOnSinglePage: true }}
        locale={{ emptyText: <Empty description="还没有评测记录" /> }}
        onRow={(row) => ({
          onClick: () => navigate(`/admin/eval/runs/${row.id}`),
          style: { cursor: "pointer" },
        })}
      />
    </div>
  );
}
