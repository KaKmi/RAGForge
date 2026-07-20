import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Button,
  Empty,
  Flex,
  Popconfirm,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
  type TableColumnsType,
} from "antd";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import type { GapCluster, GapClusterStatus, GapItem, GapRootCause } from "@codecrush/contracts";
import {
  getGapItems,
  getGapSummary,
  getGaps,
  ignoreGap,
  mergeGap,
  reopenGap,
  routeGapToRetrieval,
  splitGap,
  updateGapRootCause,
} from "../../api/client";
import BadSampleToEvalSetModal from "./BadSampleToEvalSetModal";

const { Text } = Typography;

/**
 * 屏5 · 知识缺口 / 问题池（原型 `:353-380`，组件矩阵 §17.5 `:626-637`）。
 *
 * 1:1 还原的硬约束（改动前先回原型对一遍）：
 *  · 六列表头逐字：缺口(代表问题) / 频次 / 根因分诊 / 平均质量 / 状态 / 操作（`:357`）
 *  · 频次形态 `×23`，橙色加粗（`:358`）
 *  · 根因中文标签：缺内容(红) / 检索问题(琥珀) / 生成问题（`:358-360`）
 *  · 空态文案逐字（§19.2 `:762`）
 *
 * **本波（B2a）刻意不做的**：`[补知识库]` 三步向导与自动回验属 B2b ⇒ 该按钮**不渲染**
 * （渲染一个点了没反应的按钮比没有它更糟）。原型状态机里的
 * drafting/reviewing/filled/verified 四态同理不可达——DB 的 CHECK 只放行三态。
 */

/** 原型 `:358-360` 的根因中文与配色。 */
const ROOT_CAUSE: Record<GapRootCause, { label: string; color: string }> = {
  missing: { label: "缺内容", color: "red" },
  retrieval: { label: "检索问题", color: "gold" },
  generation: { label: "生成问题", color: "blue" },
};

/** 全七态。前三态 B2a 起可达，后四态是 B2b [补知识库] 向导与回验的流转（原型 §18.C `:363`）。 */
const STATUS: Record<GapClusterStatus, { label: string; color: string }> = {
  pending: { label: "待处理", color: "#fa8c16" },
  routed_retrieval: { label: "已转检索工单", color: "rgba(0,0,0,.45)" },
  ignored: { label: "已忽略", color: "rgba(0,0,0,.45)" },
  // 配色照原型 `:363` 的状态条 tag 色系：草拟中(蓝)→待人审(琥珀)→已入库(绿)→已回验(紫)。
  drafting: { label: "草拟中", color: "#1677ff" },
  reviewing: { label: "待人审", color: "#faad14" },
  filled: { label: "已入库", color: "#52c41a" },
  verified: { label: "已回验", color: "#722ed1" },
};

/**
 * 平均质量的配色，照原型三行的取值反推：41 红 / 58 琥珀 / 89 绿（`:358-360`）。
 * 分界取 50 与 80——80 同时是原型「回验通过」的判定线（`:368`），两处一致。
 */
function qualityColor(score: number): string {
  if (score < 50) return "#ff4d4f";
  if (score < 80) return "#faad14";
  return "#52c41a";
}

/** 根因在 URL 上的参数名（原型 §19.3 `:773`：`/admin/gaps` 的参数是 `status,cause`）。 */
const CAUSE_PARAM = "cause";

/** 每页条数。服务端分页（后端 `listClusters` 已带 id tiebreaker，跨页不重不漏）。 */
const PAGE_SIZE = 50;

/** URL 参数非法值静默回默认（原型 §19.3 对深链参数的既定处理）。 */
function parseStatus(raw: string | null): GapClusterStatus | undefined {
  return raw && raw in STATUS ? (raw as GapClusterStatus) : undefined;
}
function parseRootCause(raw: string | null): GapRootCause | undefined {
  return raw && raw in ROOT_CAUSE ? (raw as GapRootCause) : undefined;
}

interface SummaryCardProps {
  title: string;
  value: number;
  active?: boolean;
  /** 省略 = 这张卡不可交互（「已进评测集」是叠加标志，点了没有对应状态可筛）。 */
  onClick?: () => void;
}

/**
 * 概览卡 ×4（原型 `:629`：点击 → 下方列表按对应状态筛）。
 *
 * 手写 div 而非 antd `Card` 是**照原型**——§17.5 的「形态」栏写的就是「手写卡」。
 * 但**不可交互的卡绝不能伪装成按钮**：给了 `role="button"` 却没有 onClick，
 * 屏幕阅读器会播报「按钮」、键盘用户 Tab 得到焦点、敲空格什么也不发生还顺带滚屏。
 */
function SummaryCard({ title, value, active = false, onClick }: SummaryCardProps) {
  const interactive = Boolean(onClick);
  return (
    <div
      {...(interactive
        ? {
            role: "button",
            tabIndex: 0,
            "aria-pressed": active,
            onClick,
            onKeyDown: (e: React.KeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault(); // 不加这行，空格会在触发筛选的同时把页面滚下去
                onClick?.();
              }
            },
          }
        : {})}
      style={{
        flex: 1,
        background: "#fff",
        border: `1px solid ${active ? "#1677ff" : "#f0f0f0"}`,
        borderRadius: 8,
        padding: "12px 16px",
        cursor: interactive ? "pointer" : "default",
      }}
    >
      <div style={{ fontSize: 12, color: "rgba(0,0,0,.45)" }}>{title}</div>
      <div style={{ fontSize: 22, fontWeight: 600, marginTop: 2 }}>{value}</div>
    </div>
  );
}

/** 行展开区：簇内真实问题（原型 `:366`，每条 → trace 详情，过期置灰）。 */
function ClusterItems({
  clusterId,
  clusters,
  onChanged,
}: {
  clusterId: string;
  clusters: GapCluster[];
  onChanged: () => void;
}) {
  const [items, setItems] = useState<GapItem[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [mergeTarget, setMergeTarget] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setItems(await getGapItems(clusterId));
    } catch (error) {
      message.error(error instanceof Error ? error.message : "加载簇内问题失败");
      setItems([]);
    }
  }, [clusterId]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * `reloadItems` 用来处理**源簇已经不存在了**的情形：合并走光全部成员时后端会软删源簇，
   * 此时再拉一次它的成员会拿到 404「缺口不存在：<uuid>」——一条绿 toast 后面紧跟一条
   * 带裸 UUID 的红 toast，而操作其实完全成功了。这类"成功后的假报错"最消耗排查信任。
   */
  async function run<T>(
    action: () => Promise<T>,
    ok: string,
    reloadItems: (result: T) => boolean = () => true,
  ) {
    setBusy(true);
    try {
      const result = await action();
      message.success(ok);
      setSelected([]);
      setMergeTarget(undefined);
      if (reloadItems(result)) await load();
      onChanged();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }

  if (items === null) return <Spin size="small" />;
  if (items.length === 0)
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无成员" />;

  return (
    <div>
      {/* 选中 ≥1 才浮出工具条（原型 `:632`）。 */}
      {selected.length > 0 && (
        <Flex align="center" gap={8} style={{ marginBottom: 8 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            已选 {selected.length} 条
          </Text>
          <Popconfirm
            title="拆分为新簇"
            description={`将选中的 ${selected.length} 条移出，成为一个新缺口簇？`}
            disabled={selected.length === items.length}
            onConfirm={() =>
              run(() => splitGap(clusterId, { itemIds: selected }), "已拆分为新缺口")
            }
          >
            {/* 全选等于「什么都没拆」，后端会 400（gaps.service.ts）——别给一条必然失败的路径。 */}
            <Tooltip title={selected.length === items.length ? "不能拆走全部成员" : ""}>
              <Button size="small" disabled={busy || selected.length === items.length}>
                拆分为新簇
              </Button>
            </Tooltip>
          </Popconfirm>
          <Select
            size="small"
            placeholder="移入其他簇"
            style={{ minWidth: 200 }}
            value={mergeTarget}
            onChange={setMergeTarget}
            options={clusters
              .filter((c) => c.id !== clusterId)
              .map((c) => ({ value: c.id, label: c.representativeQuestion }))}
          />
          <Button
            size="small"
            disabled={!mergeTarget || busy}
            onClick={() =>
              run(
                () => mergeGap(clusterId, { targetClusterId: mergeTarget!, itemIds: selected }),
                "已移入目标缺口",
                // 源簇被清空软删了就别再拉它的成员——那必然 404。
                (result) => !result.sourceSoftDeleted,
              )
            }
          >
            确认移入
          </Button>
        </Flex>
      )}
      <Table<GapItem>
        rowKey="id"
        size="small"
        pagination={false}
        dataSource={items}
        rowSelection={{
          selectedRowKeys: selected,
          onChange: (keys) => setSelected(keys as string[]),
        }}
        columns={[
          {
            title: "用户实际问的",
            dataIndex: "question",
            render: (question: string, row) => (
              <Space size={4} wrap>
                {/* 改写消解成功的，把检索实际用的问题放进 Tooltip（决策 G）。 */}
                {row.rewriteResolved && row.rewrittenQuestion ? (
                  <Tooltip title={`检索用：${row.rewrittenQuestion}`}>
                    <span>{question}</span>
                  </Tooltip>
                ) : (
                  <span>{question}</span>
                )}
                {!row.rewriteResolved && (
                  <Tooltip title="改写没能把指代消解成独立问题——沉淀为评测用例前需要人工改写">
                    <Tag color="orange">指代未消解</Tag>
                  </Tooltip>
                )}
              </Space>
            ),
          },
          {
            title: "来源",
            dataIndex: "source",
            width: 110,
            render: (source: GapItem["source"]) =>
              ({ online: "线上", manual_trace: "人工加入", offline_run: "离线重跑" })[source],
          },
          {
            title: "trace",
            dataIndex: "sourceTraceId",
            width: 130,
            render: (traceId: string, row) =>
              // 过 TTL 只置灰、不删行、不减频次（原型 `:377` `:631`）。
              row.traceExpired ? (
                <Tooltip title="源 trace 已过期（30 天 TTL），但频次不因此递减">
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {traceId.slice(0, 8)}…
                  </Text>
                </Tooltip>
              ) : (
                // 必须是 <Link>：裸 <a href> 会整页刷新，AdminLayout 全量重挂、
                // 筛选与展开态全部丢失（全仓其余 7 处 trace 跳转都用 Link/navigate）。
                <Link to={`/admin/traces/${traceId}`} style={{ fontSize: 12 }}>
                  {traceId.slice(0, 8)}…
                </Link>
              ),
          },
        ]}
      />
    </div>
  );
}

export default function GapsPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const status = parseStatus(searchParams.get("status"));
  // URL 上叫 `cause`（原型 §19.3 `:773` 的深链参数表），而 API 查询参数叫 `rootCause`（契约如此）。
  // 两者不必同名——URL 是给人分享的，契约是给机器的。
  const rootCause = parseRootCause(searchParams.get(CAUSE_PARAM));

  const [clusters, setClusters] = useState<GapCluster[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [summary, setSummary] = useState({
    pending: 0,
    routedRetrieval: 0,
    ignored: 0,
    enteredEvalSet: 0,
  });
  const [loading, setLoading] = useState(true);
  /** 非空 = 「从坏样本生成」弹窗打开且锁定为这个簇（原型 `:634`「预选本簇问题」）。 */
  const [promoteClusterId, setPromoteClusterId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, cards] = await Promise.all([
        // 服务端分页：`total` 必须用起来，否则超过一页的簇会被**静默截断**
        // ——看到 50 行、没有任何迹象表明后面还有 200 个。
        getGaps({ status, rootCause, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
        getGapSummary(),
      ]);
      setClusters(list.items);
      setTotal(list.total);
      setSummary(cards);
    } catch (error) {
      // 保留上一次数据、不清空——失败时白屏比看到略旧的数据更糟。
      message.error(error instanceof Error ? error.message : "加载问题池失败");
    } finally {
      setLoading(false);
    }
  }, [status, rootCause, page]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * 写筛选态到 URL。**未被本次修改的那一项要重新走一遍解析**——否则
   * `/admin/gaps?status=bogus` 下选一个根因，URL 会变成 `?status=bogus&cause=missing`：
   * 下拉显示「全部状态」而 URL 说 `bogus`，把这条链接分享出去对方看到的又是另一回事。
   */
  const setFilter = useCallback(
    (next: { status?: GapClusterStatus; rootCause?: GapRootCause }) => {
      const params = new URLSearchParams(searchParams);
      const nextStatus = "status" in next ? next.status : parseStatus(params.get("status"));
      const nextCause = "rootCause" in next ? next.rootCause : parseRootCause(params.get(CAUSE_PARAM));
      if (nextStatus) params.set("status", nextStatus);
      else params.delete("status");
      if (nextCause) params.set(CAUSE_PARAM, nextCause);
      else params.delete(CAUSE_PARAM);
      setSearchParams(params);
    },
    [searchParams, setSearchParams],
  );

  const act = useCallback(
    async (action: () => Promise<unknown>, ok: string) => {
      try {
        await action();
        message.success(ok);
        await load();
      } catch (error) {
        message.error(error instanceof Error ? error.message : "操作失败");
      }
    },
    [load],
  );

  const columns = useMemo<TableColumnsType<GapCluster>>(
    () => [
      {
        title: "缺口(代表问题)",
        dataIndex: "representativeQuestion",
        render: (question: string, row) => (
          <Space size={4} wrap>
            <span style={{ fontWeight: 500 }}>{question}</span>
            {row.enteredEvalSetAt && <Tag color="purple">已进评测集</Tag>}
            {/* 021 决策 E：簇里过半是指代追问时，低精确率来自改写没解析、不是知识缺口。 */}
            {row.followUpRatio > 0.5 && (
              <Tooltip title="该簇多数样本是未消解的指代追问——低精确率多半来自改写，补文档解决不了">
                <Tag color="orange">多轮追问 {Math.round(row.followUpRatio * 100)}%</Tag>
              </Tooltip>
            )}
          </Space>
        ),
      },
      {
        title: (
          <Tooltip title="累计命中次数不随 trace 过期递减；近 30 天为滚动窗口，不含离线重跑样本">
            <span>频次</span>
          </Tooltip>
        ),
        dataIndex: "freq",
        width: 96,
        /**
         * **刻意不给 `sorter`**：后端的排序是两级的「pending 在前 → freq 倒序」（原型 `:631`），
         * 而 antd 的列排序只按单键。挂上去点一下，已忽略/已转工单的高频簇就会盖到待处理之上，
         * 把这一屏最重要的信息序打乱；何况分页在服务端，前端排序只对当前页有效，
         * 会给出「这就是全量顺序」的错觉。
         */
        render: (freq: number, row) => (
          <div>
            <b style={{ color: "#fa8c16" }}>×{freq}</b>
            <div style={{ fontSize: 11, color: "rgba(0,0,0,.45)" }}>近30天 {row.freq30d}</div>
          </div>
        ),
      },
      {
        title: "根因分诊",
        dataIndex: "rootCause",
        width: 160,
        render: (cause: GapRootCause | null, row) => (
          <Space size={2}>
            <Select<GapRootCause>
              size="small"
              variant="borderless"
              style={{ minWidth: 110 }}
              value={cause ?? undefined}
              placeholder="待分诊"
              onChange={(next) =>
                act(() => updateGapRootCause(row.id, { rootCause: next }), "已改判根因")
              }
              options={(Object.keys(ROOT_CAUSE) as GapRootCause[]).map((key) => ({
                value: key,
                label: (
                  <Tag color={ROOT_CAUSE[key].color} style={{ marginInlineEnd: 0 }}>
                    {ROOT_CAUSE[key].label}
                  </Tag>
                ),
              }))}
            />
            {/* 人工改判过就标出来——UI 要能区分「人判的」与「worker 判的」。 */}
            {row.rootCauseIsManual && (
              <Tooltip title="人工改判过，worker 不会再覆盖">
                <Text type="secondary" style={{ fontSize: 11 }}>
                  人工
                </Text>
              </Tooltip>
            )}
          </Space>
        ),
      },
      {
        title: "平均质量",
        dataIndex: "avgQuality",
        width: 96,
        render: (score: number | null) =>
          // NULL 是「没评过」不是 0 分——显示 0 会把未评说成最差（全局约束 6 的 UI 侧同源要求）。
          score === null ? (
            <Text type="secondary" style={{ fontSize: 12 }}>
              未评
            </Text>
          ) : (
            <span style={{ color: qualityColor(score) }}>{Math.round(score)}</span>
          ),
      },
      {
        title: "状态",
        dataIndex: "status",
        width: 110,
        render: (value: GapClusterStatus) => (
          <span style={{ fontSize: 11, color: STATUS[value].color }}>{STATUS[value].label}</span>
        ),
      },
      {
        title: "操作",
        key: "actions",
        width: 230,
        render: (_, row) => (
          <Space size={4} wrap>
            {/*
              [补知识库] 三步向导仍缺席（→ B2b）。[进评测集] 本波补回：它复用 §17.2 的
              「从坏样本生成」弹窗并**预选本簇**（原型 `:634`），成功后后端打「已进评测集」标志。
              一度渲染过一个只 navigate 到 `/admin/eval/sets?fromGap=` 的版本并因此被移除——
              全仓没有任何地方读 `fromGap`，点了既不弹窗也不预选、簇上也不会出现标志。
              现在它有真实去处了。
            */}
            <Button size="small" onClick={() => setPromoteClusterId(row.id)}>
              进评测集
            </Button>
            {row.status === "pending" && (
              <Button
                size="small"
                onClick={() =>
                  act(async () => {
                    await routeGapToRetrieval(row.id);
                    // 原型 `:635`：跳应用配置检索区并携带缺口 id。
                    navigate(`/admin/applications?fromGap=${encodeURIComponent(row.id)}`);
                  }, "已转检索工单")
                }
              >
                修检索参数
              </Button>
            )}
            {row.status === "ignored" ? (
              <Button size="small" onClick={() => act(() => reopenGap(row.id), "已重新打开")}>
                重新打开
              </Button>
            ) : (
              <Popconfirm
                title="忽略该缺口？"
                description="忽略后默认列表不再显示（筛选「已忽略」仍可查看）。"
                onConfirm={() => act(() => ignoreGap(row.id), "已忽略")}
              >
                <Button size="small">忽略</Button>
              </Popconfirm>
            )}
          </Space>
        ),
      },
    ],
    [act, navigate],
  );

  return (
    <div>
      <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>知识缺口 / 问题池</div>
      <div style={{ fontSize: 13, color: "rgba(0,0,0,.45)", margin: "8px 0 16px" }}>
        坏样本自动收集聚类成「缺口簇」，人只处理不打捞。
      </div>

      <Flex gap={12} style={{ marginBottom: 16 }}>
        <SummaryCard
          title="待处理"
          value={summary.pending}
          active={status === "pending"}
          onClick={() => setFilter({ status: status === "pending" ? undefined : "pending" })}
        />
        <SummaryCard
          title="已转检索工单"
          value={summary.routedRetrieval}
          active={status === "routed_retrieval"}
          onClick={() =>
            setFilter({ status: status === "routed_retrieval" ? undefined : "routed_retrieval" })
          }
        />
        <SummaryCard
          title="已忽略"
          value={summary.ignored}
          active={status === "ignored"}
          onClick={() => setFilter({ status: status === "ignored" ? undefined : "ignored" })}
        />
        {/* 「已进评测集」是叠加标志不是状态（原型 `:634`）⇒ 只展示计数，不可点、不筛状态。 */}
        <SummaryCard title="已进评测集" value={summary.enteredEvalSet} />
      </Flex>

      <Flex gap={8} style={{ marginBottom: 12 }}>
        <Select<GapClusterStatus>
          allowClear
          placeholder="全部状态"
          style={{ width: 160 }}
          value={status}
          onChange={(next) => setFilter({ status: next })}
          options={(Object.keys(STATUS) as GapClusterStatus[]).map((key) => ({
            value: key,
            label: STATUS[key].label,
          }))}
        />
        <Select<GapRootCause>
          allowClear
          placeholder="全部根因"
          style={{ width: 160 }}
          value={rootCause}
          onChange={(next) => setFilter({ rootCause: next })}
          options={(Object.keys(ROOT_CAUSE) as GapRootCause[]).map((key) => ({
            value: key,
            label: ROOT_CAUSE[key].label,
          }))}
        />
      </Flex>

      <Table<GapCluster>
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={clusters}
        columns={columns}
        pagination={{
          current: page,
          pageSize: PAGE_SIZE,
          total,
          showSizeChanger: false,
          onChange: setPage,
        }}
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="问题池为空 — 低质量问答会自动聚类出现在这里"
            />
          ),
        }}
        expandable={{
          expandedRowRender: (row) => (
            <ClusterItems clusterId={row.id} clusters={clusters} onChanged={load} />
          ),
        }}
      />

      <BadSampleToEvalSetModal
        open={promoteClusterId !== null}
        presetClusterId={promoteClusterId ?? undefined}
        presetClusterLabel={
          clusters.find((c) => c.id === promoteClusterId)?.representativeQuestion
        }
        onClose={() => setPromoteClusterId(null)}
        onDone={() => {
          setPromoteClusterId(null);
          // 留在屏5 并重拉——簇上会多出「已进评测集」紫标（后端刚打的），重拉才看得见。
          // 原来这里 `load()` 之后紧接着 `navigate` 走人：请求结果落在已卸载的组件上，
          // 注释说的「必须重拉才看得见」也就永远看不见。二选一，选留下。
          void load();
        }}
      />
    </div>
  );
}
