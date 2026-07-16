import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Button,
  Drawer,
  Empty,
  Flex,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  Upload,
  message,
  type TableColumnsType,
} from "antd";
import { Link, useNavigate } from "react-router-dom";
import type {
  Application,
  Document,
  EvalCase,
  EvalSet,
  ImportEvalCasesRequest,
  ImportEvalCasesResponse,
  KnowledgeBase,
  OnlineEvalSettingsResponse,
} from "@codecrush/contracts";
import {
  RecentEvalRunConflictError,
  createEvalCase,
  createEvalRun,
  createEvalSet,
  deleteEvalCase,
  deleteEvalSet,
  getApplicationDetail,
  getApplications,
  getDocuments,
  getEvalCases,
  getEvalSets,
  getKnowledgeBases,
  getOnlineEvalSettings,
  importEvalCases,
  updateEvalCase,
} from "../../api/client";

const { Title, Text } = Typography;

/** 原型 §5 屏2「评测集管理(gold 题库)」/ §6「发起评测」/ §17.2 组件与状态矩阵 / §19.1 校验 / §19.2 文案。 */

// —— §19.1 字段上限（逐条照抄）——
const NAME_MAX = 50;
const QUESTION_MAX = 500;
const GOLD_POINT_MAX = 200;
const GOLD_DOC_MAX = 10;
const TAG_MAX = 5;
const TAG_LEN_MAX = 12;
const IMPORT_ROW_MAX = 1000;
/** 原型 §5「状态与边界」：单集软上限 500 条（超出提示拆分，不硬拒）。 */
const CASE_SOFT_LIMIT = 500;
/** ImportEvalCasesRequestSchema 的 DoS 兜底长度——超了会整批 400，先在前端给人话。 */
const CELL_QUESTION_MAX = 2000;
const CELL_ANSWER_MAX = 5000;

const CASE_STATUS_LABEL: Record<EvalCase["status"], string> = {
  draft: "待审核",
  reviewed: "已审核",
};

/** gold 答案按「要点」分号分隔（原型 §5）；与后端 csv-import.ts 的 splitGoldPoints 同口径。 */
function splitGoldPoints(goldAnswer: string): string[] {
  return goldAnswer
    .split(/[;；]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// —— CSV：前端解析（018 决策 D13）——

/** U+FEFF。用码点构造而非字面量：字面 BOM 在编辑器里不可见，被改坏了没人看得出来。 */
const BOM = String.fromCharCode(0xfeff);

/** RFC4180 风格解析：支持引号包裹、字段内逗号/换行、`""` 转义。 */
function parseCsv(text: string): string[][] {
  // 去 UTF-8 BOM（Excel 导出的 CSV 常带）——留着会让首列表头带上不可见前缀而认不出 question 必列。
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") field += ch;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // 尾随空行不算数据行（Excel 导出常见）
  return rows.filter((cells) => cells.some((cell) => cell.trim().length > 0));
}

type ImportRow = ImportEvalCasesRequest["rows"][number];

/**
 * 两级校验的**前端那一级**（原型 §17.2 逐字：「缺 question/gold_answer **该行拒**；
 * >1000 行**整批拒**」）：这里只做「整批拒」与列结构；缺字段的**单行照发**，
 * 由后端逐行校验产出「第 N 行缺少 gold_answer」回执。
 */
function readCsv(text: string): { rows: ImportRow[] } | { error: string } {
  const table = parseCsv(text);
  if (table.length === 0) return { error: "CSV 内容为空" };
  const header = table[0].map((cell) => cell.trim().toLowerCase());
  const qi = header.indexOf("question");
  const ai = header.indexOf("gold_answer");
  if (qi < 0 || ai < 0) return { error: "CSV 必须包含 question 与 gold_answer 列" }; // §19.1 必列
  const di = header.indexOf("gold_docs");
  const ti = header.indexOf("tags");
  const body = table.slice(1);
  if (body.length === 0) return { error: "CSV 没有可导入的数据行" };
  if (body.length > IMPORT_ROW_MAX) return { error: "超过 1000 行，请拆分" }; // §19.2 逐字
  const oversized = body.findIndex(
    (cells) =>
      (cells[qi] ?? "").length > CELL_QUESTION_MAX || (cells[ai] ?? "").length > CELL_ANSWER_MAX,
  );
  if (oversized >= 0) return { error: `第 ${oversized + 1} 行单元格内容过长，无法导入` };
  return {
    rows: body.map((cells) => ({
      question: cells[qi] ?? "",
      goldAnswer: cells[ai] ?? "",
      ...(di >= 0 ? { goldDocs: cells[di] ?? "" } : {}),
      ...(ti >= 0 ? { tags: cells[ti] ?? "" } : {}),
    })),
  };
}

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** BOM + CRLF：Excel 直接双击打开不乱码。 */
function downloadCsv(filename: string, table: string[][]): void {
  const csv = table.map((cells) => cells.map(csvCell).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([BOM + csv], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** 原型 §6 预估条：耗时/Token/preview trace 条数。裁判调用 ~3 次/条，token 粗估 3.6k/条。 */
function estimate(caseCount: number): string {
  const tokens = Math.round((caseCount * 3600) / 1000);
  return `预估：${caseCount} 条 × (1 次编排 + ~3 次裁判调用) ≈ 耗时 3~6 分钟 · Token ~${tokens}k · 产出 ${caseCount} 条 preview trace（不入线上统计）`;
}

export default function EvalSetsPage() {
  const navigate = useNavigate();
  const [sets, setSets] = useState<EvalSet[]>([]);
  const [loading, setLoading] = useState(true);
  const [kbs, setKbs] = useState<KnowledgeBase[]>([]);
  const [cases, setCases] = useState<Record<string, EvalCase[]>>({});
  const [expanded, setExpanded] = useState<string[]>([]);
  const [selectedCases, setSelectedCases] = useState<Record<string, string[]>>({});

  const kbName = useCallback(
    (id: string) => kbs.find((kb) => kb.id === id)?.name ?? id,
    [kbs],
  );

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setSets(await getEvalSets());
    } catch (error) {
      // §17「接口失败一律 message.error + 保留上次数据（不清空不白屏）」
      message.error(error instanceof Error ? error.message : "评测集加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    getKnowledgeBases()
      .then(setKbs)
      .catch(() => setKbs([]));
  }, [reload]);

  const loadCases = useCallback(async (setId: string) => {
    try {
      const rows = await getEvalCases(setId);
      setCases((prev) => ({ ...prev, [setId]: rows }));
    } catch (error) {
      message.error(error instanceof Error ? error.message : "用例加载失败");
    }
  }, []);

  // 用例增删改会改动 caseCount / reviewedCaseCount / gold docs 覆盖率 → 主表同步重拉。
  const refreshSet = useCallback(
    async (setId: string) => {
      await Promise.all([loadCases(setId), reload()]);
    },
    [loadCases, reload],
  );

  return (
    <div>
      <Flex align="center" justify="space-between" gap={12} wrap style={{ marginBottom: 16 }}>
        <div>
          <Title level={4} style={{ margin: 0 }}>
            评测集
          </Title>
          <Text type="secondary" style={{ fontSize: 12 }}>
            管理 gold 题库；渐进式标注：先只标 gold answer（能测正确率），gold docs 后补
          </Text>
        </div>
        <Space>
          <ImportModal sets={sets} onDone={refreshSet} />
          <CreateSetModal kbs={kbs} onCreated={reload} />
        </Space>
      </Flex>

      <SetsTable
        sets={sets}
        loading={loading}
        kbName={kbName}
        cases={cases}
        expanded={expanded}
        selectedCases={selectedCases}
        onExpand={(keys) => {
          setExpanded(keys);
          for (const key of keys) if (!cases[key]) void loadCases(key);
        }}
        onSelectCases={(setId, keys) => setSelectedCases((prev) => ({ ...prev, [setId]: keys }))}
        onChanged={refreshSet}
        onDeleted={reload}
        onStarted={(runId) => navigate(`/admin/eval/runs/${runId}`)}
      />
    </div>
  );
}

// —— 屏2 主表（原型 §5 列：评测集 / 用例 / 覆盖知识库 / gold docs / 上次得分 / 操作）——

function SetsTable({
  sets,
  loading,
  kbName,
  cases,
  expanded,
  selectedCases,
  onExpand,
  onSelectCases,
  onChanged,
  onDeleted,
  onStarted,
}: {
  sets: EvalSet[];
  loading: boolean;
  kbName: (id: string) => string;
  cases: Record<string, EvalCase[]>;
  expanded: string[];
  selectedCases: Record<string, string[]>;
  onExpand: (keys: string[]) => void;
  onSelectCases: (setId: string, keys: string[]) => void;
  onChanged: (setId: string) => Promise<void>;
  onDeleted: () => Promise<void>;
  onStarted: (runId: string) => void;
}) {
  const [runTarget, setRunTarget] = useState<EvalSet | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const remove = async (row: EvalSet) => {
    setBusyId(row.id);
    try {
      await deleteEvalSet(row.id);
      message.success("评测集已删除");
      await onDeleted();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "删除失败");
    } finally {
      setBusyId(null);
    }
  };

  const columns: TableColumnsType<EvalSet> = [
    {
      title: "评测集",
      key: "name",
      render: (_: unknown, row) => (
        <div>
          <div style={{ fontWeight: 500 }}>{row.name}</div>
          {row.description && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {row.description}
            </Text>
          )}
        </div>
      ),
    },
    { title: "用例", dataIndex: "caseCount", key: "caseCount", width: 90 },
    {
      title: "覆盖知识库",
      key: "kbs",
      width: 220,
      // 原型 §5：未关联知识库的集显示「全部」（「高频 Badcase 集」行即 34 条 / 覆盖「全部」）
      render: (_: unknown, row) => (
        <Text type="secondary">
          {row.kbIds.length === 0 ? "全部" : row.kbIds.map(kbName).join("·")}
        </Text>
      ),
    },
    {
      title: "gold docs",
      key: "goldDocs",
      width: 110,
      // §17.2：「行内『gold docs 38/50』低于 80% 橙色」。分母 = 用例总数（契约注释已定口径）。
      render: (_: unknown, row) => {
        const { withGoldDocs, total } = row.goldDocCoverage;
        const low = total > 0 && withGoldDocs / total < 0.8;
        return (
          <span style={{ color: low ? "#d46b08" : undefined }}>
            {withGoldDocs}/{total}
          </span>
        );
      },
    },
    {
      title: "上次得分",
      key: "lastRunScore",
      width: 110,
      // 原型 §5 显示「82.0」（一位小数，非整数）；null → 灰字「未运行」，绝不显示 0。
      render: (_: unknown, row) =>
        row.lastRunScore === null ? (
          <Text type="secondary">未运行</Text>
        ) : (
          <span style={{ color: "#52c41a", fontWeight: 600 }}>{row.lastRunScore.toFixed(1)}</span>
        ),
    },
    {
      title: "操作",
      key: "action",
      width: 170,
      render: (_: unknown, row) => (
        <Space onClick={(e) => e.stopPropagation()}>
          {/* §5 状态与边界：0 条已审核用例 →「发起评测」禁用 + tooltip「至少 1 条已审核用例」 */}
          {row.reviewedCaseCount === 0 ? (
            <Tooltip title="至少 1 条已审核用例">
              {/*
                antd 6 的 Tooltip **不再**为 disabled 子元素自动包裹触发容器（antd 5 会）。
                disabled 的原生 button 本身不派发鼠标事件 → 必须手动包一层 span 承接 hover，
                并让按钮不吃指针事件，否则这条 tooltip 永远不显示（等于丢了原型的空态提示）。
              */}
              <span style={{ display: "inline-block", cursor: "not-allowed" }}>
                <Button
                  type="link"
                  size="small"
                  disabled
                  style={{ padding: 0, pointerEvents: "none" }}
                >
                  发起评测
                </Button>
              </span>
            </Tooltip>
          ) : (
            <Button
              type="link"
              size="small"
              style={{ padding: 0 }}
              onClick={() => setRunTarget(row)}
            >
              发起评测
            </Button>
          )}
          <Popconfirm
            title="删除后列表不再显示；历史报告仍可查看。确认删除？"
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true, loading: busyId === row.id }}
            onConfirm={() => remove(row)}
          >
            <Button type="link" size="small" danger style={{ padding: 0 }}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <>
      <Table<EvalSet>
        rowKey="id"
        loading={loading}
        columns={columns}
        dataSource={sets}
        pagination={{ pageSize: 20, hideOnSinglePage: true }}
        locale={{ emptyText: <Empty description="还没有评测集" /> }}
        expandable={{
          expandedRowKeys: expanded,
          onExpandedRowsChange: (keys) => onExpand(keys as string[]),
          expandedRowRender: (row) => (
            <CasesTable
              set={row}
              rows={cases[row.id]}
              selected={selectedCases[row.id] ?? []}
              onSelect={(keys) => onSelectCases(row.id, keys)}
              onChanged={() => onChanged(row.id)}
            />
          ),
        }}
      />
      {runTarget && (
        <StartRunModal
          set={runTarget}
          onClose={() => setRunTarget(null)}
          onStarted={(runId) => {
            setRunTarget(null);
            onStarted(runId);
          }}
        />
      )}
    </>
  );
}

// —— 用例子表（§17.2：状态列 + 可筛 + 勾选批量「审核通过 / 删除」；行点击开编辑抽屉）——

function CasesTable({
  set,
  rows,
  selected,
  onSelect,
  onChanged,
}: {
  set: EvalSet;
  rows: EvalCase[] | undefined;
  selected: string[];
  onSelect: (keys: string[]) => void;
  onChanged: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<EvalCase | "new" | null>(null);
  const [busy, setBusy] = useState(false);

  const batch = async (action: "review" | "delete") => {
    setBusy(true);
    try {
      for (const caseId of selected) {
        if (action === "review") await updateEvalCase(set.id, caseId, { status: "reviewed" });
        else await deleteEvalCase(set.id, caseId);
      }
      message.success(action === "review" ? "已审核通过" : "已删除");
      onSelect([]);
      await onChanged();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "操作失败");
      await onChanged();
    } finally {
      setBusy(false);
    }
  };

  const removeCase = async (row: EvalCase) => {
    try {
      await deleteEvalCase(set.id, row.id);
      message.success("用例已删除");
      await onChanged();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "删除失败");
    }
  };

  const columns: TableColumnsType<EvalCase> = [
    { title: "问题", dataIndex: "question", key: "question" },
    {
      title: "gold 要点",
      key: "goldPoints",
      width: 260,
      render: (_: unknown, row) =>
        row.goldPoints.length === 0 ? (
          <Text type="secondary">—</Text>
        ) : (
          <Text style={{ fontSize: 12 }}>{row.goldPoints.join("；")}</Text>
        ),
    },
    {
      title: "gold docs",
      key: "goldDocs",
      width: 90,
      render: (_: unknown, row) =>
        row.goldDocIds.length === 0 ? <Text type="secondary">未标</Text> : row.goldDocIds.length,
    },
    {
      title: "标签",
      key: "tags",
      width: 160,
      render: (_: unknown, row) =>
        row.tags.length === 0 ? (
          <Text type="secondary">—</Text>
        ) : (
          row.tags.map((tag) => (
            <Tag key={tag} color="blue">
              {tag}
            </Tag>
          ))
        ),
    },
    {
      title: "状态",
      key: "status",
      width: 110,
      // §17.2「可按状态筛」
      filters: [
        { text: "待审核", value: "draft" },
        { text: "已审核", value: "reviewed" },
      ],
      onFilter: (value, row) => row.status === value,
      render: (_: unknown, row) => (
        <Tag color={row.status === "reviewed" ? "green" : "gold"}>
          {CASE_STATUS_LABEL[row.status]}
        </Tag>
      ),
    },
    {
      title: "操作",
      key: "action",
      width: 120,
      render: (_: unknown, row) => (
        <Space onClick={(e) => e.stopPropagation()}>
          <Popconfirm
            title="删除后列表不再显示；历史报告仍可查看。确认删除？"
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => removeCase(row)}
          >
            <Button type="link" size="small" danger style={{ padding: 0 }}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const overSoftLimit = set.caseCount > CASE_SOFT_LIMIT;

  return (
    <div>
      <Flex align="center" gap={8} wrap style={{ marginBottom: 8 }}>
        <Button size="small" type="primary" onClick={() => setEditing("new")}>
          ＋ 新建用例
        </Button>
        {selected.length > 0 && (
          <>
            <Button size="small" loading={busy} onClick={() => batch("review")}>
              审核通过（{selected.length}）
            </Button>
            <Popconfirm
              title="删除后列表不再显示；历史报告仍可查看。确认删除？"
              okText="删除"
              cancelText="取消"
              okButtonProps={{ danger: true, loading: busy }}
              onConfirm={() => batch("delete")}
            >
              <Button size="small" danger>
                删除（{selected.length}）
              </Button>
            </Popconfirm>
          </>
        )}
        <Text type="secondary" style={{ fontSize: 12, marginLeft: "auto" }}>
          已审核 {set.reviewedCaseCount} / 共 {set.caseCount} —— 仅已审核用例参与评测运行
        </Text>
      </Flex>
      {/* 原型 §5 状态与边界：单集软上限 500 条（提示拆分，不硬拒） */}
      {overSoftLimit && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 8 }}
          title={`用例数已超过单集软上限 ${CASE_SOFT_LIMIT} 条，建议拆分（防单 run 成本失控）`}
        />
      )}
      <Table<EvalCase>
        rowKey="id"
        size="small"
        columns={columns}
        dataSource={rows ?? []}
        loading={rows === undefined}
        pagination={{ pageSize: 20, hideOnSinglePage: true }}
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有用例" /> }}
        rowSelection={{ selectedRowKeys: selected, onChange: (keys) => onSelect(keys as string[]) }}
        onRow={(row) => ({ onClick: () => setEditing(row), style: { cursor: "pointer" } })}
      />
      {editing && (
        <CaseDrawer
          set={set}
          value={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await onChanged();
          }}
        />
      )}
    </div>
  );
}

// —— 用例编辑抽屉（原型 §5 + §17.2「Drawer 480px」）——

function CaseDrawer({
  set,
  value,
  onClose,
  onSaved,
}: {
  set: EvalSet;
  value: EvalCase | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [question, setQuestion] = useState(value?.question ?? "");
  const [goldAnswer, setGoldAnswer] = useState((value?.goldPoints ?? []).join("；"));
  const [goldDocIds, setGoldDocIds] = useState<string[]>(value?.goldDocIds ?? []);
  const [tags, setTags] = useState<string[]>(value?.tags ?? []);
  const [docs, setDocs] = useState<Document[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // gold 文档候选：优先取该集关联知识库的文档；未关联（=覆盖「全部」）则取全部知识库。
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const kbIds = set.kbIds.length > 0 ? set.kbIds : (await getKnowledgeBases()).map((k) => k.id);
        const lists = await Promise.all(kbIds.map((kbId) => getDocuments(kbId)));
        if (live) setDocs(lists.flat());
      } catch {
        if (live) setDocs([]); // 候选拉不到不挡编辑（gold docs 选填）
      }
    })();
    return () => {
      live = false;
    };
  }, [set.kbIds]);

  const save = async () => {
    // §19.1 逐条校验，文案逐字。
    const trimmed = question.trim();
    if (!trimmed) return setError("问题不能为空");
    if (trimmed.length > QUESTION_MAX) return setError("不超过 500 字");
    const goldPoints = splitGoldPoints(goldAnswer);
    // reviewed 是**不变式**（非仅转移守卫）：已审核用例不得把 gold 清空（对齐后端 service）。
    if (value?.status === "reviewed" && goldPoints.length === 0) {
      return setError("至少填写 1 个答案要点");
    }
    if (goldPoints.some((point) => point.length > GOLD_POINT_MAX)) {
      return setError(`gold 要点每条不超过 ${GOLD_POINT_MAX} 字`);
    }
    if (goldDocIds.length > GOLD_DOC_MAX) return setError("最多关联 10 个片段");
    if (tags.length > TAG_MAX) return setError("最多 5 个标签");
    if (tags.some((tag) => tag.length > TAG_LEN_MAX)) return setError(`标签不超过 ${TAG_LEN_MAX} 字`);
    setError(null);
    setSaving(true);
    try {
      if (value) {
        await updateEvalCase(set.id, value.id, { question: trimmed, goldPoints, goldDocIds, tags });
        // 更新分支**不可**复用 §19.2 的入集文案：后端只在 `req.status !== undefined` 时才写
        // status，而本抽屉从不传 status → 已审核用例保存后**仍是 reviewed**（只是 v+1）。
        // 沿用「状态：待审核」会与事实相反，诱使用户去「重新审核」一条从未离开 reviewed 的
        // 用例，或误以为编辑会把它踢出 run 候选集 —— 而「reviewed 编辑后不回退 draft」
        // 恰恰是本波刻意保住的产品语义。
        message.success(`已保存，已生成新版本 v${value.version + 1}`);
      } else {
        await createEvalCase(set.id, { question: trimmed, goldPoints, goldDocIds, tags });
        message.success(`已加入评测集『${set.name}』，状态：待审核`); // §19.2 逐字
      }
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      title={value ? `编辑用例 · v${value.version}` : "新建用例"}
      width={480}
      open
      onClose={onClose}
      extra={
        <Space>
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" loading={saving} onClick={save}>
            保存
          </Button>
        </Space>
      }
    >
      {/* §18.B：编辑保存 = 新不可变版本 v+1；旧版本冻结供历史 run 引用（报告不会因改题失真）。 */}
      {value && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          title="保存将生成新版本，历史报告仍引用旧版本"
        />
      )}
      <Form layout="vertical">
        <Form.Item label="问题" required>
          <Input.TextArea
            aria-label="问题"
            rows={2}
            maxLength={QUESTION_MAX}
            showCount
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
          />
        </Form.Item>
        <Form.Item label="gold 答案" required extra="按要点分号分隔，判分按要点比对">
          <Input.TextArea
            aria-label="gold 答案"
            rows={3}
            value={goldAnswer}
            placeholder="7 天内无理由退；已开课按比例；赠品课不退"
            onChange={(e) => setGoldAnswer(e.target.value)}
          />
        </Form.Item>
        <Form.Item label="gold 文档" extra="选填，标了才能测召回">
          <Select
            aria-label="gold 文档"
            mode="multiple"
            allowClear
            showSearch
            optionFilterProp="label"
            style={{ width: "100%" }}
            placeholder="输入关键词筛选文档"
            value={goldDocIds}
            onChange={setGoldDocIds}
            options={docs.map((doc) => ({ value: doc.id, label: doc.name }))}
          />
        </Form.Item>
        <Form.Item label="标签" extra={`最多 ${TAG_MAX} 个，每个 ≤${TAG_LEN_MAX} 字`}>
          <Select
            aria-label="标签"
            mode="tags"
            style={{ width: "100%" }}
            value={tags}
            onChange={setTags}
            options={[]}
          />
        </Form.Item>
        {/* 原型 §5：「来源 trace 4f2a…(点击查看)」 */}
        {value?.sourceTraceId && (
          <Form.Item label="来源">
            <Link to={`/admin/traces/${value.sourceTraceId}`}>
              trace {value.sourceTraceId.slice(0, 4)}…（点击查看）
            </Link>
          </Form.Item>
        )}
        {error && <Text type="danger">{error}</Text>}
      </Form>
    </Drawer>
  );
}

// —— 新建评测集 Modal（原型 §5：名称(必填,查重) / 描述 / 关联知识库(多选)）——

function CreateSetModal({ kbs, onCreated }: { kbs: KnowledgeBase[]; onCreated: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [kbIds, setKbIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) return setError("请输入名称"); // §19.1 逐字
    if (trimmed.length > NAME_MAX) return setError(`不超过 ${NAME_MAX} 字`);
    setError(null);
    setSaving(true);
    try {
      // 名称唯一性由后端查重（409「名称已存在」，§19.1 逐字）——前端不再本地复述一遍口径。
      await createEvalSet({ name: trimmed, description: description.trim(), kbIds });
      message.success(`已创建评测集『${trimmed}』`);
      setOpen(false);
      setName("");
      setDescription("");
      setKbIds([]);
      await onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Button type="primary" onClick={() => setOpen(true)}>
        ＋ 新建评测集
      </Button>
      <Modal
        title="新建评测集"
        open={open}
        onCancel={() => setOpen(false)}
        onOk={submit}
        okText="创建"
        cancelText="取消"
        confirmLoading={saving}
      >
        <Form layout="vertical">
          <Form.Item label="名称" required>
            <Input
              aria-label="名称"
              maxLength={NAME_MAX}
              showCount
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Form.Item>
          <Form.Item label="描述">
            <Input.TextArea
              aria-label="描述"
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Form.Item>
          <Form.Item label="关联知识库" extra="多选，用于 LLM 生成与统计口径">
            <Select
              aria-label="关联知识库"
              mode="multiple"
              allowClear
              style={{ width: "100%" }}
              placeholder="不选 = 覆盖全部"
              value={kbIds}
              onChange={setKbIds}
              options={kbs.map((kb) => ({ value: kb.id, label: kb.name }))}
            />
          </Form.Item>
          {error && <Text type="danger">{error}</Text>}
        </Form>
      </Modal>
    </>
  );
}

// —— CSV 导入 Modal（原型 §5 + §17.2：模板下载常显 / 逐行校验 / 错误行标红 + 下载回执）——

function ImportModal({
  sets,
  onDone,
}: {
  sets: EvalSet[];
  onDone: (setId: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [setId, setSetId] = useState<string | undefined>();
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportEvalCasesResponse | null>(null);
  const [importing, setImporting] = useState(false);

  const reset = () => {
    setRows([]);
    setFileName("");
    setError(null);
    setResult(null);
  };

  const readFile = async (file: File) => {
    reset();
    setFileName(file.name);
    const parsed = readCsv(await file.text());
    if ("error" in parsed) setError(parsed.error);
    else setRows(parsed.rows);
  };

  const submit = async () => {
    if (!setId) return setError("请选择目标评测集");
    if (rows.length === 0) return setError("请先选择 CSV 文件");
    setImporting(true);
    try {
      const response = await importEvalCases(setId, { rows });
      setResult(response);
      if (response.errors.length === 0) {
        message.success(`已导入 ${response.imported} 条，状态：待审核`);
        setOpen(false);
        reset();
      }
      await onDone(setId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "导入失败");
    } finally {
      setImporting(false);
    }
  };

  const errorRows = useMemo(() => {
    if (!result) return [];
    return result.errors.map((item) => ({
      key: item.row,
      row: item.row,
      question: rows[item.row - 1]?.question ?? "",
      message: item.message,
    }));
  }, [result, rows]);

  return (
    <>
      <Button onClick={() => setOpen(true)}>导入 CSV</Button>
      <Modal
        title="导入 CSV"
        open={open}
        width={640}
        onCancel={() => {
          setOpen(false);
          reset();
        }}
        onOk={submit}
        okText="开始导入"
        cancelText="取消"
        okButtonProps={{ disabled: rows.length === 0 }}
        confirmLoading={importing}
      >
        <Form layout="vertical">
          <Form.Item label="目标评测集" required>
            <Select
              aria-label="目标评测集"
              style={{ width: "100%" }}
              placeholder="选择要导入的评测集"
              value={setId}
              onChange={setSetId}
              options={sets.map((item) => ({ value: item.id, label: item.name }))}
            />
          </Form.Item>
          <Form.Item
            label="CSV 文件"
            extra={`模板列：question, gold_answer, gold_docs（可空）, tags；≤${IMPORT_ROW_MAX} 行，导入后状态为「待审核」`}
          >
            <Space>
              <Upload
                accept=".csv,text/csv"
                maxCount={1}
                showUploadList={false}
                // 前端解析（018 决策 D13）：返回 false 阻断 antd 自带上传，只读文件内容。
                beforeUpload={(file) => {
                  void readFile(file as unknown as File);
                  return false;
                }}
              >
                <Button>选择 CSV 文件</Button>
              </Upload>
              <Button
                type="link"
                style={{ padding: 0 }}
                onClick={() =>
                  downloadCsv("eval-cases-template.csv", [
                    ["question", "gold_answer", "gold_docs", "tags"],
                    ["课程可以退款吗", "7 天内无理由退；已开课按比例；赠品课不退", "", "退款,售后"],
                  ])
                }
              >
                下载模板
              </Button>
              {fileName && <Text type="secondary">{fileName}</Text>}
            </Space>
          </Form.Item>
        </Form>
        {rows.length > 0 && !result && <Alert type="info" showIcon title={`已解析 ${rows.length} 行`} />}
        {error && <Alert type="error" showIcon title={error} />}
        {result && (
          <>
            <Alert
              type={result.errors.length > 0 ? "warning" : "success"}
              showIcon
              style={{ marginBottom: 8 }}
              title={`已导入 ${result.imported} 条（待审核）${
                result.errors.length > 0 ? ` · ${result.errors.length} 行校验失败` : ""
              }`}
              action={
                result.errors.length > 0 ? (
                  <Button
                    size="small"
                    onClick={() =>
                      downloadCsv("import-receipt.csv", [
                        ["row", "question", "message"],
                        ...errorRows.map((item) => [String(item.row), item.question, item.message]),
                      ])
                    }
                  >
                    下载回执
                  </Button>
                ) : undefined
              }
            />
            {/* 原型 §5「错误行标红下载回执」 */}
            <Table
              size="small"
              rowKey="key"
              pagination={{ pageSize: 5, hideOnSinglePage: true }}
              dataSource={errorRows}
              onRow={() => ({ style: { background: "#fff2f0" } })}
              columns={[
                { title: "行", dataIndex: "row", width: 60 },
                { title: "问题", dataIndex: "question" },
                {
                  title: "错误",
                  dataIndex: "message",
                  render: (text: string) => <Text type="danger">{text}</Text>,
                },
              ]}
            />
          </>
        )}
      </Modal>
    </>
  );
}

// —— 发起评测 Modal（原型 §6）——

function StartRunModal({
  set,
  onClose,
  onStarted,
}: {
  set: EvalSet;
  onClose: () => void;
  onStarted: (runId: string) => void;
}) {
  const navigate = useNavigate();
  const [apps, setApps] = useState<Application[]>([]);
  const [appId, setAppId] = useState<string | undefined>();
  const [versions, setVersions] = useState<Array<{ id: string; version: number; note?: string }>>([]);
  const [productionId, setProductionId] = useState<string | null>(null);
  const [versionId, setVersionId] = useState<string | undefined>();
  const [settings, setSettings] = useState<OnlineEvalSettingsResponse | null>(null);
  const [judgeModelId, setJudgeModelId] = useState<string | undefined>();
  const [embeddingModelId, setEmbeddingModelId] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  // 裁判/embedding 模型候选复用在线评测设置端点（不新增端点）。
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const [applications, onlineSettings] = await Promise.all([
          getApplications(),
          getOnlineEvalSettings(),
        ]);
        if (!live) return;
        setApps(applications);
        setSettings(onlineSettings);
        setJudgeModelId(
          onlineSettings.settings.judgeModelId ??
            onlineSettings.models.judges.find((m) => m.available)?.id,
        );
        setEmbeddingModelId(
          onlineSettings.settings.embeddingModelId ??
            onlineSettings.models.embeddings.find((m) => m.available)?.id,
        );
        // 默认落在「已上线」的那个应用，对齐原型「默认=production 当前版本」。
        setAppId((applications.find((a) => a.productionConfigVersionId) ?? applications[0])?.id);
      } catch (err) {
        if (live) setError(err instanceof Error ? err.message : "加载配置版本失败");
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!appId) return;
    let live = true;
    void (async () => {
      try {
        const detail = await getApplicationDetail(appId);
        if (!live) return;
        setVersions(detail.versions);
        setProductionId(detail.productionConfigVersionId);
        // 原型 §6：「默认=production 当前版本」；未上线的应用退到最新版本。
        setVersionId(detail.productionConfigVersionId ?? detail.versions[0]?.id);
      } catch (err) {
        if (live) setError(err instanceof Error ? err.message : "加载配置版本失败");
      }
    })();
    return () => {
      live = false;
    };
  }, [appId]);

  const start = async (force: boolean) => {
    if (!appId || !versionId) return setError("该版本已不可用"); // §19.1 逐字
    if (!judgeModelId || !embeddingModelId) return setError("请选择可用的裁判模型与 Embedding 模型");
    setError(null);
    setStarting(true);
    try {
      const run = await createEvalRun({
        setId: set.id,
        applicationId: appId,
        configVersionId: versionId,
        judgeModelId,
        embeddingModelId,
        force,
      });
      message.success("评测已开始，预计 3~6 分钟"); // §19.2 逐字
      onStarted(run.id);
    } catch (err) {
      // §19.2 逐字：「1 小时内已有相同评测结果 · 查看 / 仍重新运行」
      if (err instanceof RecentEvalRunConflictError) {
        const { recentRunId } = err;
        Modal.confirm({
          title: "1 小时内已有相同评测结果",
          okText: "仍重新运行",
          cancelText: "查看",
          onOk: () => start(true),
          onCancel: () => {
            onClose();
            navigate(`/admin/eval/runs/${recentRunId}`);
          },
        });
      } else {
        setError(err instanceof Error ? err.message : "发起评测失败");
      }
    } finally {
      setStarting(false);
    }
  };

  return (
    <Modal
      title={`发起评测 · ${set.name}`}
      open
      width={520}
      onCancel={onClose}
      onOk={() => start(false)}
      okText="开始运行"
      cancelText="取消"
      confirmLoading={starting}
    >
      <Form layout="vertical">
        <Form.Item label="应用" required>
          <Select
            aria-label="应用"
            data-testid="app-select"
            style={{ width: "100%" }}
            value={appId}
            onChange={setAppId}
            options={apps.map((app) => ({ value: app.id, label: app.name }))}
          />
        </Form.Item>
        <Form.Item label="被评配置版本" required extra="默认 = production 当前版本">
          <Select
            aria-label="被评配置版本"
            data-testid="version-select"
            style={{ width: "100%" }}
            value={versionId}
            onChange={setVersionId}
            options={versions.map((item) => ({
              value: item.id,
              label: `v${item.version}${item.id === productionId ? "（production）" : "（候选）"}`,
            }))}
          />
        </Form.Item>
        <Form.Item label="裁判模型" required>
          <Select
            aria-label="裁判模型"
            data-testid="judge-select"
            style={{ width: "100%" }}
            value={judgeModelId}
            onChange={setJudgeModelId}
            options={(settings?.models.judges ?? []).map((model) => ({
              value: model.id,
              disabled: !model.available,
              label: `${model.name}${model.available ? "" : "（不可用）"}`,
            }))}
          />
        </Form.Item>
        <Form.Item label="Embedding 模型" required>
          <Select
            aria-label="Embedding 模型"
            data-testid="embed-select"
            style={{ width: "100%" }}
            value={embeddingModelId}
            onChange={setEmbeddingModelId}
            options={(settings?.models.embeddings ?? []).map((model) => ({
              value: model.id,
              disabled: !model.available,
              label: `${model.name}${model.available ? "" : "（不可用）"}`,
            }))}
          />
        </Form.Item>
        {/* 原型 §6 预估条（前端本地估算，非后端返回） */}
        <div style={{ background: "#fafafa", borderRadius: 6, padding: "8px 12px", fontSize: 12 }}>
          {estimate(set.reviewedCaseCount)}
        </div>
        {error && (
          <div style={{ marginTop: 8 }}>
            <Text type="danger">{error}</Text>
          </div>
        )}
      </Form>
    </Modal>
  );
}
