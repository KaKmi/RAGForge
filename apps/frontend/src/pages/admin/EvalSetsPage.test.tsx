import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import type { EvalCase, EvalSet, GoldDocRef, RetrievalHit } from "@codecrush/contracts";
import * as api from "../../api/client";
import EvalSetsPage from "./EvalSetsPage";

vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return {
    ...actual,
    getEvalSets: vi.fn(),
    getEvalCases: vi.fn(),
    createEvalSet: vi.fn(),
    deleteEvalSet: vi.fn(),
    createEvalCase: vi.fn(),
    updateEvalCase: vi.fn(),
    deleteEvalCase: vi.fn(),
    importEvalCases: vi.fn(),
    createEvalRun: vi.fn(),
    getKnowledgeBases: vi.fn(),
    getDocuments: vi.fn(),
    getApplications: vi.fn(),
    getApplicationDetail: vi.fn(),
    getOnlineEvalSettings: vi.fn(),
    testRetrieval: vi.fn(),
    // B1/F4：人工「确认仍有效」
    confirmEvalCaseGold: vi.fn(),
  };
});
vi.mock("antd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("antd")>();
  return { ...actual, message: { error: vi.fn(), success: vi.fn() } };
});

const evalSet = (over: Partial<EvalSet> = {}): EvalSet => ({
  id: "set-1",
  name: "售后核心 50 题",
  description: "",
  kbIds: ["kb-1"],
  caseCount: 50,
  reviewedCaseCount: 50,
  goldDocCoverage: { withGoldDocs: 38, total: 50 },
  lastRunScore: 82,
  hasCompletedRun: true,
  createdAt: "2026-07-10T02:00:00.000Z",
  updatedAt: "2026-07-14T02:00:00.000Z",
  ...over,
});

const evalCase = (over: Partial<EvalCase> = {}): EvalCase => ({
  id: "case-1",
  setId: "set-1",
  version: 1,
  status: "reviewed",
  question: "课程可以退款吗",
  goldPoints: ["7 天内无理由退", "已开课按比例"],
  goldDocRefs: [],
  tags: ["退款"],
  sourceTraceId: null,
  goldStale: false,
  createdAt: "2026-07-10T02:00:00.000Z",
  ...over,
});

const goldRef = (over: Partial<GoldDocRef> = {}): GoldDocRef => ({
  docId: "d-1",
  chunkId: "c-1",
  docName: "退款政策",
  section: "§2",
  ...over,
});

const knowledgeBase = () =>
  ({
    id: "kb-1",
    name: "售后FAQ",
    desc: "",
    chunkTemplate: "general",
    embeddingModelId: "embed-1",
    docsCount: 3,
    chunksCount: 12,
    status: "ready",
    activeVersion: 1,
    buildingVersion: null,
    processingProfileId: null,
    processingProfileVersion: null,
    updatedAt: "2026-07-10T02:00:00.000Z",
  }) as never;

const retrievalHit = (over: Partial<RetrievalHit> = {}): RetrievalHit => ({
  chunkId: "c-1",
  docId: "d-1",
  docName: "退款政策",
  text: "课程支持 7 天无理由退款，已开课按剩余比例退还。",
  section: "§2",
  vecScore: 0.9,
  finalScore: 0.88,
  ...over,
});

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

function renderPage(sets: EvalSet[] = [evalSet()]) {
  vi.mocked(api.getEvalSets).mockResolvedValue(sets);
  return render(
    <MemoryRouter initialEntries={["/admin/eval/sets"]}>
      <EvalSetsPage />
      <LocationProbe />
    </MemoryRouter>,
  );
}

/** CSV：表头 + n 行数据。 */
function csvWithNRows(n: number): string {
  const rows = Array.from({ length: n }, (_, i) => `问题${i + 1},要点A；要点B`);
  return ["question,gold_answer", ...rows].join("\n");
}

/** Modal 渲染在 body 的 portal 里，不在 render 的 container 内 → 从 document 找 Upload 的 input。 */
async function uploadCsv(content: string) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File([content], "cases.csv", { type: "text/csv" });
  fireEvent.change(input, { target: { files: [file] } });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getKnowledgeBases).mockResolvedValue([]);
  vi.mocked(api.getDocuments).mockResolvedValue([]);
  vi.mocked(api.testRetrieval).mockResolvedValue({ hits: [] });
  vi.mocked(api.getEvalCases).mockResolvedValue([evalCase()]);
  vi.mocked(api.getApplications).mockResolvedValue([]);
  vi.mocked(api.getOnlineEvalSettings).mockResolvedValue({
    settings: {
      id: "default",
      enabled: true,
      sampleRate: 0.1,
      judgeModelId: "judge-1",
      embeddingModelId: "embed-1",
      faithfulnessThreshold: 80,
      answerRelevancyThreshold: 80,
      contextPrecisionThreshold: 80,
      dailyCap: 500,
      judgeVersion: "online-v1",
      updatedAt: "2026-07-15T02:00:00.000Z",
    },
    models: {
      judges: [{ id: "judge-1", name: "qwen-plus", enabled: true, available: true }],
      embeddings: [{ id: "embed-1", name: "bge-m3", enabled: true, available: true }],
    },
  });
});

it("0 条已审核用例 →「发起评测」禁用并提示", async () => {
  renderPage([evalSet({ name: "空集", reviewedCaseCount: 0, caseCount: 3 })]);
  const btn = await screen.findByRole("button", { name: "发起评测" });
  expect(btn).toBeDisabled();
  // React 的 onMouseEnter 由 mouseover 合成 → fireEvent 必须发 mouseOver；
  // 且 antd 给 disabled 子元素包一层 span 承接 hover。
  fireEvent.mouseOver(btn.parentElement!);
  expect(await screen.findByText("至少 1 条已审核用例")).toBeInTheDocument();
});

it("删除评测集走 Popconfirm，文案照抄原型 §19.2", async () => {
  renderPage();
  // antd 给「两个汉字」按钮插空格（「删 除」）→ 一律用宽松匹配
  fireEvent.click(await screen.findByRole("button", { name: /删\s*除/ }));
  expect(
    await screen.findByText("删除后列表不再显示；历史报告仍可查看。确认删除？"),
  ).toBeInTheDocument();
  vi.mocked(api.deleteEvalSet).mockResolvedValue();
  // [0] = 行内「删除」，[1] = Popconfirm 的确认按钮（portal 挂在 body 末尾）
  const buttons = screen.getAllByRole("button", { name: /删\s*除/ });
  fireEvent.click(buttons[buttons.length - 1]);
  await waitFor(() => expect(api.deleteEvalSet).toHaveBeenCalledWith("set-1"));
});

it("列表按原型 §5 显示 gold docs 覆盖率与一位小数的上次得分", async () => {
  renderPage([evalSet(), evalSet({ id: "set-2", name: "高频 Badcase 集", kbIds: [], caseCount: 34, reviewedCaseCount: 0, goldDocCoverage: { withGoldDocs: 0, total: 34 }, lastRunScore: null, hasCompletedRun: false })]);
  expect(await screen.findByText("38/50")).toBeInTheDocument();
  expect(screen.getByText("82.0")).toBeInTheDocument();
  // 未跑过的集：null 得分显示「未运行」，绝不是 0；未关联知识库显示「全部」
  expect(screen.getByText("未运行")).toBeInTheDocument();
  expect(screen.getByText("0/34")).toBeInTheDocument();
  expect(screen.getByText("全部")).toBeInTheDocument();
});

it("知识库名称加载期间显示占位，不暴露内部 UUID", async () => {
  let resolveKnowledgeBases!: (
    value: Awaited<ReturnType<typeof api.getKnowledgeBases>>,
  ) => void;
  vi.mocked(api.getKnowledgeBases).mockReturnValue(
    new Promise((resolve) => {
      resolveKnowledgeBases = resolve;
    }),
  );

  renderPage([evalSet({ kbIds: ["kb-1"] })]);

  expect(await screen.findByText("加载中…")).toBeInTheDocument();
  expect(screen.queryByText("kb-1")).not.toBeInTheDocument();

  resolveKnowledgeBases([knowledgeBase()]);
  expect(await screen.findByText("售后FAQ")).toBeInTheDocument();
});

// QA P2：一个跑完 5 次 run 的集合被显示成「未运行」——NULL 是对的，词是假的。
it("跑过但没出分的集 →「未出分」而非「未运行」（两种 null 成因必须分词）", async () => {
  renderPage([
    evalSet({ id: "set-3", name: "全超时的集", lastRunScore: null, hasCompletedRun: true }),
  ]);
  expect(await screen.findByText("未出分")).toBeInTheDocument();
  // 「跑过」的集合绝不能被说成没跑过
  expect(screen.queryByText("未运行")).not.toBeInTheDocument();
  // 且仍然绝不退化成 0（本波中心不变式）
  expect(screen.queryByText("0")).not.toBeInTheDocument();
  expect(screen.queryByText("0.0")).not.toBeInTheDocument();
});

it("CSV 导入：>1000 行前端即拒，文案「超过 1000 行，请拆分」", async () => {
  renderPage();
  fireEvent.click(await screen.findByRole("button", { name: "导入 CSV" }));
  await uploadCsv(csvWithNRows(1001));
  expect(await screen.findByText("超过 1000 行，请拆分")).toBeInTheDocument();
  expect(api.importEvalCases).not.toHaveBeenCalled();
});

it("CSV 导入：合法行照发，后端逐行回执标红并可下载", async () => {
  renderPage();
  vi.mocked(api.importEvalCases).mockResolvedValue({
    imported: 1,
    errors: [{ row: 2, message: "第 2 行缺少 gold_answer" }],
  });
  fireEvent.click(await screen.findByRole("button", { name: "导入 CSV" }));
  const modal = await screen.findByRole("dialog");
  // 目标评测集必选（集名同时出现在主表与下拉里 → 用 option 角色消歧）
  // antd Select 不是原生 <select>：mouseDown 开下拉后点选项内容（集名同时出现在主表里 →
  // 必须限定在下拉门户内取，否则 getByText 命中多个）。
  fireEvent.mouseDown(within(modal).getByRole("combobox"));
  await screen.findByRole("option", { name: "售后核心 50 题" });
  const dropdown = document.querySelector(".ant-select-dropdown") as HTMLElement;
  fireEvent.click(within(dropdown).getByText("售后核心 50 题"));
  await uploadCsv("question,gold_answer\n课程可以退款吗,7 天内无理由退\n缺答案的问题,");
  expect(await screen.findByText("已解析 2 行")).toBeInTheDocument();
  fireEvent.click(within(modal).getByRole("button", { name: "开始导入" }));
  // 缺 gold_answer 的行**照发**（该行拒由后端判定并回执），不在前端整批拦掉
  await waitFor(() =>
    expect(api.importEvalCases).toHaveBeenCalledWith("set-1", {
      rows: [
        { question: "课程可以退款吗", goldAnswer: "7 天内无理由退" },
        { question: "缺答案的问题", goldAnswer: "" },
      ],
    }),
  );
  expect(await screen.findByText("第 2 行缺少 gold_answer")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "下载回执" })).toBeInTheDocument();
});

it("新建评测集：空名称报「请输入名称」，不发请求", async () => {
  renderPage();
  fireEvent.click(await screen.findByRole("button", { name: /新建评测集/ }));
  fireEvent.click(await screen.findByRole("button", { name: /创\s*建/ }));
  expect(await screen.findByText("请输入名称")).toBeInTheDocument();
  expect(api.createEvalSet).not.toHaveBeenCalled();
});

it("新建评测集：重名透出后端「名称已存在」", async () => {
  renderPage();
  vi.mocked(api.createEvalSet).mockRejectedValue(new Error("名称已存在"));
  fireEvent.click(await screen.findByRole("button", { name: /新建评测集/ }));
  fireEvent.change(screen.getByLabelText("名称"), { target: { value: "售后核心 50 题" } });
  fireEvent.click(screen.getByRole("button", { name: /创\s*建/ }));
  expect(await screen.findByText("名称已存在")).toBeInTheDocument();
});

it("展开行显示用例子表，行点击开编辑抽屉", async () => {
  renderPage();
  fireEvent.click(await screen.findByRole("button", { name: /Expand row/i }));
  expect(await screen.findByText("课程可以退款吗")).toBeInTheDocument();
  await waitFor(() => expect(api.getEvalCases).toHaveBeenCalledWith("set-1"));
  fireEvent.click(screen.getByText("课程可以退款吗"));
  // gold 要点按分号回填（原型 §5「按要点分号分隔」）
  expect(await screen.findByDisplayValue("7 天内无理由退；已开课按比例")).toBeInTheDocument();
  expect(screen.getByText("保存将生成新版本，历史报告仍引用旧版本")).toBeInTheDocument();
});

it("已审核用例清空 gold 要点报「至少填写 1 个答案要点」", async () => {
  renderPage();
  fireEvent.click(await screen.findByRole("button", { name: /Expand row/i }));
  fireEvent.click(await screen.findByText("课程可以退款吗"));
  fireEvent.change(await screen.findByLabelText("gold 答案"), { target: { value: "  " } });
  fireEvent.click(screen.getByRole("button", { name: /保\s*存/ }));
  expect(await screen.findByText("至少填写 1 个答案要点")).toBeInTheDocument();
  expect(api.updateEvalCase).not.toHaveBeenCalled();
});

it("发起评测 409 幂等 → 弹「1 小时内已有相同评测结果」，「仍重新运行」带 force 重发", async () => {
  renderPage();
  vi.mocked(api.getApplications).mockResolvedValue([
    { id: "app-1", name: "售后支持", productionConfigVersionId: "ver-7" } as never,
  ]);
  vi.mocked(api.getApplicationDetail).mockResolvedValue({
    id: "app-1",
    productionConfigVersionId: "ver-7",
    versions: [{ id: "ver-7", version: 7 }],
  } as never);
  vi.mocked(api.createEvalRun)
    .mockRejectedValueOnce(new api.RecentEvalRunConflictError("run-old"))
    .mockResolvedValueOnce({ id: "run-new" } as never);

  fireEvent.click(await screen.findByRole("button", { name: "发起评测" }));
  await screen.findByText("发起评测 · 售后核心 50 题");
  await waitFor(() => expect(screen.getByTestId("version-select")).toHaveTextContent("v7"));
  fireEvent.click(screen.getByRole("button", { name: "开始运行" }));

  // antd 6 的 Modal.confirm 把 title 同时渲染进 .ant-modal-title 与 .ant-modal-confirm-title
  expect(await screen.findAllByText("1 小时内已有相同评测结果")).not.toHaveLength(0);
  expect(screen.getByRole("button", { name: /查\s*看/ })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "仍重新运行" }));
  await waitFor(() =>
    expect(api.createEvalRun).toHaveBeenLastCalledWith(expect.objectContaining({ force: true })),
  );
  // 成功后跳 run 详情页（原型 §6：Modal 关闭后跳 run 详情页）
  await waitFor(() =>
    expect(screen.getByTestId("location")).toHaveTextContent("/admin/eval/runs/run-new"),
  );
});

// QA P3-1：预估耗时曾是硬编码的「3~6 分钟」，而原型那句是**对 50 条说的**。
describe("发起评测 Modal 的预估耗时随用例数缩放", () => {
  async function openRunModal(reviewedCaseCount: number) {
    renderPage([evalSet({ reviewedCaseCount })]);
    vi.mocked(api.getApplications).mockResolvedValue([
      { id: "app-1", name: "售后支持", productionConfigVersionId: "ver-7" } as never,
    ]);
    vi.mocked(api.getApplicationDetail).mockResolvedValue({
      id: "app-1",
      productionConfigVersionId: "ver-7",
      versions: [{ id: "ver-7", version: 7 }],
    } as never);
    fireEvent.click(await screen.findByRole("button", { name: "发起评测" }));
    return await screen.findByText(/预估：/);
  }

  it("50 条 → 逐字复现原型 §6 的「3~6 分钟」（锚点不漂移）", async () => {
    expect(await openRunModal(50)).toHaveTextContent("耗时 3~6 分钟");
  });

  it("5 条 → 按比例缩到「0.3~0.6 分钟」，不再谎报 3~6 分钟", async () => {
    const line = await openRunModal(5);
    expect(line).toHaveTextContent("耗时 0.3~0.6 分钟");
    expect(line).not.toHaveTextContent("3~6 分钟");
  });

  it("200 条 → 放大到「12~24 分钟」", async () => {
    expect(await openRunModal(200)).toHaveTextContent("耗时 12~24 分钟");
  });
});

// —— F3：chunk 级 gold 选择器 ——

/** 展开评测集第一行并打开该用例的编辑抽屉。 */
async function openCaseDrawer() {
  fireEvent.click(await screen.findByRole("button", { name: /Expand row/i }));
  fireEvent.click(await screen.findByText("课程可以退款吗"));
  await screen.findByText("保存将生成新版本，历史报告仍引用旧版本");
}

it("CaseDrawer 显示 chunk 级与文档级 gold ref tag，点 × 移除（F3）", async () => {
  vi.mocked(api.getEvalCases).mockResolvedValue([
    evalCase({
      goldDocRefs: [
        goldRef({ docId: "d-1", chunkId: "c-1", docName: "退款政策", section: "§2" }),
        goldRef({ docId: "d-old", chunkId: null, docName: "旧文档", section: null }),
      ],
    }),
  ]);
  renderPage();
  await openCaseDrawer();
  // chunk 级：docName + section；文档级遗留（chunkId=null）：docName（整篇）
  expect(await screen.findByText("退款政策 §2")).toBeInTheDocument();
  expect(screen.getByText("旧文档（整篇）")).toBeInTheDocument();
  // 点 × 移除 chunk 级 tag
  const tag = screen.getByText("退款政策 §2").closest(".ant-tag") as HTMLElement;
  fireEvent.click(tag.querySelector(".ant-tag-close-icon") as HTMLElement);
  await waitFor(() => expect(screen.queryByText("退款政策 §2")).not.toBeInTheDocument());
  // 文档级 tag 不受影响
  expect(screen.getByText("旧文档（整篇）")).toBeInTheDocument();
});

it("GoldRefSelector：选 KB + 关键词 → 候选 chunk 勾选确认 → tag 出现（F3）", async () => {
  vi.mocked(api.getKnowledgeBases).mockResolvedValue([knowledgeBase()]);
  vi.mocked(api.testRetrieval).mockResolvedValue({
    hits: [
      retrievalHit({ chunkId: "c-1", docName: "退款政策", section: "§2", text: "课程支持 7 天无理由退款" }),
      retrievalHit({ chunkId: "c-2", docName: "退款政策", section: "§3", text: "已开课按剩余比例退还" }),
    ],
  });
  renderPage();
  await openCaseDrawer();
  fireEvent.click(screen.getByRole("button", { name: /添加/ }));
  // 关键词检索 → 复用检索测试台端点
  const searchInput = await screen.findByPlaceholderText("输入关键词检索候选片段");
  const modal = searchInput.closest(".ant-modal") as HTMLElement;
  fireEvent.change(searchInput, { target: { value: "退款" } });
  fireEvent.click(within(modal).getByRole("button", { name: /检\s*索/ }));
  await waitFor(() =>
    expect(api.testRetrieval).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "退款",
        kbId: "kb-1",
        embedModelId: "embed-1",
        topK: 10,
        threshold: 0,
        multi: false,
      }),
    ),
  );
  await within(modal).findByText("课程支持 7 天无理由退款");
  // 勾第一个候选 → 确认
  fireEvent.click(within(modal).getAllByRole("checkbox")[0]);
  fireEvent.click(within(modal).getByRole("button", { name: /确\s*认/ }));
  // 合入抽屉后显示 tag
  expect(await screen.findByText("退款政策 §2")).toBeInTheDocument();
});

it("GoldRefSelector：已选满 10 再合入报「最多关联 10 个片段」（§19.1）", async () => {
  vi.mocked(api.getKnowledgeBases).mockResolvedValue([knowledgeBase()]);
  vi.mocked(api.testRetrieval).mockResolvedValue({
    hits: [retrievalHit({ chunkId: "c-new", docId: "d-new", docName: "新文档", section: "§9", text: "新片段内容" })],
  });
  vi.mocked(api.getEvalCases).mockResolvedValue([
    evalCase({
      goldDocRefs: Array.from({ length: 10 }, (_, i) =>
        goldRef({ docId: `d-${i}`, chunkId: `c-${i}`, docName: `文档${i}`, section: `§${i}` }),
      ),
    }),
  ]);
  renderPage();
  await openCaseDrawer();
  fireEvent.click(screen.getByRole("button", { name: /添加/ }));
  const searchInput = await screen.findByPlaceholderText("输入关键词检索候选片段");
  const modal = searchInput.closest(".ant-modal") as HTMLElement;
  fireEvent.change(searchInput, { target: { value: "退款" } });
  fireEvent.click(within(modal).getByRole("button", { name: /检\s*索/ }));
  await within(modal).findByText("新片段内容");
  fireEvent.click(within(modal).getAllByRole("checkbox")[0]);
  fireEvent.click(within(modal).getByRole("button", { name: /确\s*认/ }));
  expect(await within(modal).findByText("最多关联 10 个片段")).toBeInTheDocument();
});

// —— F5：发起 Modal「每题重复」——

it("发起评测 Modal 显示「每题重复」默认 1，选 3 后请求体带 repeatCount:3、预估数值 ×3", async () => {
  renderPage();
  vi.mocked(api.getApplications).mockResolvedValue([
    { id: "app-1", name: "售后支持", productionConfigVersionId: "ver-7" } as never,
  ]);
  vi.mocked(api.getApplicationDetail).mockResolvedValue({
    id: "app-1",
    productionConfigVersionId: "ver-7",
    versions: [{ id: "ver-7", version: 7 }],
  } as never);
  vi.mocked(api.createEvalRun).mockResolvedValue({ id: "run-new" } as never);

  fireEvent.click(await screen.findByRole("button", { name: "发起评测" }));
  await screen.findByText("发起评测 · 售后核心 50 题");
  await waitFor(() => expect(screen.getByTestId("version-select")).toHaveTextContent("v7"));

  // 默认 1 次；预估 50 条对应「3~6 分钟」
  const repeatSelect = screen.getByTestId("repeat-select");
  expect(repeatSelect).toHaveTextContent("1 次");
  expect(screen.getByText(/预估：/)).toHaveTextContent("耗时 3~6 分钟");

  // 选 3 次（antd 6 虚拟列表下 option 角色名不稳定 → 按下拉门户内文本点选，同 ImportModal 模式）
  fireEvent.mouseDown(within(repeatSelect).getByRole("combobox"));
  const repeatDropdown = await waitFor(() => {
    const items = document.querySelectorAll(".ant-select-dropdown .ant-select-item-option-content");
    const three = Array.from(items).find((el) => el.textContent === "3 次");
    if (!three) throw new Error("option 3 次 not rendered yet");
    return three as HTMLElement;
  });
  fireEvent.click(repeatDropdown);

  // 预估随 repeat 缩放 ×3：150 units → 9~18 分钟 · Token ~540k · 150 条
  await waitFor(() => expect(screen.getByText(/预估：/)).toHaveTextContent("耗时 9~18 分钟"));
  const estimateLine = screen.getByText(/预估：/);
  expect(estimateLine).toHaveTextContent("Token ~540k");
  expect(estimateLine).toHaveTextContent("产出 150 条");

  fireEvent.click(screen.getByRole("button", { name: "开始运行" }));
  await waitFor(() =>
    expect(api.createEvalRun).toHaveBeenCalledWith(expect.objectContaining({ repeatCount: 3 })),
  );
});

// —— B1/F4：gold 过期橙 tag + 筛选 + 「确认仍有效」（原型 §17.2 `:594`、§18.B `:692`）——

async function expandFirstSet() {
  fireEvent.click(await screen.findByRole("button", { name: /Expand row/i }));
}

it("goldStale 用例显示橙 tag「gold 可能过期」", async () => {
  vi.mocked(api.getEvalCases).mockResolvedValue([evalCase({ id: "case-1", goldStale: true })]);
  renderPage();
  await expandFirstSet();
  expect(await screen.findByText("gold 可能过期")).toBeInTheDocument();
});

/** 原型：gold-stale 是**叠加**标志位，与 待审核/已审核 正交，不是排他状态。 */
it("橙 tag 与状态 tag 并存，不替换", async () => {
  vi.mocked(api.getEvalCases).mockResolvedValue([
    evalCase({ id: "case-1", status: "reviewed", goldStale: true }),
  ]);
  renderPage();
  await expandFirstSet();
  expect(await screen.findByText("gold 可能过期")).toBeInTheDocument();
  expect(screen.getByText("已审核")).toBeInTheDocument();
});

it("非 stale 用例不显示该 tag", async () => {
  vi.mocked(api.getEvalCases).mockResolvedValue([evalCase({ id: "case-1", goldStale: false })]);
  renderPage();
  await expandFirstSet();
  await screen.findByText("课程可以退款吗"); // 子表已渲染
  expect(screen.queryByText("gold 可能过期")).not.toBeInTheDocument();
});

it("可按「gold 可能过期」筛选，只留 stale 用例", async () => {
  vi.mocked(api.getEvalCases).mockResolvedValue([
    evalCase({ id: "case-1", question: "过期的题", goldStale: true }),
    evalCase({ id: "case-2", question: "正常的题", goldStale: false }),
  ]);
  renderPage();
  await expandFirstSet();
  await screen.findByText("过期的题");

  // antd Table 列筛选：点列头漏斗 → 勾选项 → 确定。
  // 必须把查询**限定在下拉面板内**——「gold 可能过期」同时是行内的橙 tag，
  // 全局 findByText 会撞上多个元素。
  const triggers = document.querySelectorAll(".ant-table-filter-trigger");
  fireEvent.click(triggers[triggers.length - 1]);
  const dropdown = await waitFor(() => {
    const el = document.querySelector(".ant-table-filter-dropdown");
    if (!el) throw new Error("filter dropdown not open");
    return el as HTMLElement;
  });
  fireEvent.click(within(dropdown).getByText("gold 可能过期"));
  // 确认按钮按位置取（`.ant-table-filter-dropdown-btns` 内为 [重置, 确定]）：
  // 测试环境没有挂 ConfigProvider locale，antd 内置按钮文案是英文（OK/Reset），
  // 按中文文案找必然落空。这两个按钮不是本波实现的，不该由本用例去钉它们的文案。
  const btns = dropdown.querySelector(".ant-table-filter-dropdown-btns")!;
  const okBtn = btns.querySelectorAll("button")[1];
  fireEvent.click(okBtn);

  await waitFor(() => expect(screen.queryByText("正常的题")).not.toBeInTheDocument());
  expect(screen.getByText("过期的题")).toBeInTheDocument();

  // 关掉下拉，避免这个 portal 面板漏进后续用例的全局查询里。
  fireEvent.click(triggers[triggers.length - 1]);
});

/**
 * 「确认仍有效」按钮**存在且只在 stale 时出现**由下面两条用例钉住（stale 时在场 / 非 stale 时不在场）；
 * 「点开 Popconfirm → 点确定 → 调 confirm-gold」这一段**在本 harness 里跑不了**：
 * 在 antd `expandedRowRender` 的嵌套子表里打开任何 popover，jsdom 下会挂死
 * （rc-trigger 的对齐依赖 `getComputedStyle` 伪元素，jsdom 未实现 ⇒ 测试 30s 超时）。
 *
 * **这不是本波引入的**：本文件此前也从未有任何用例点过子表里的 Popconfirm
 * （`deleteEvalCase` 被 mock 了但一条断言都没有），父表那条「删除评测集走 Popconfirm」
 * 之所以能跑，正因为它不在展开行里。已用最小复现验证过：只「点开」不「确定」同样挂死。
 *
 * 故该段交由 **运行时 QA（/ship:qa，真浏览器）**覆盖，并已记入 concerns.md。
 * 组件侧不为可测性改 UX —— Popconfirm 是原型 §18.B 与相邻「删除」动作的一致做法。
 */

/**
 * stale 用例**必须**渲染出这个按钮——F4 唯一的人工清除入口。
 *
 * 之前这里只有「非 stale 不显示」一条（断言不存在），于是把 `EvalSetsPage.tsx` 里
 * `{row.goldStale && <Popconfirm …>}` 整块删掉，全量前端用例仍然全绿——入口静默消失而无人知晓。
 * 这条是纯静态渲染断言，不需要点开 popover。
 *
 * ⚠️ 用 `findByText` 而**不是** `findByRole("button", …)`：role 查询要对全树算可访问名，
 * 在 Popconfirm 已渲染的展开行里会踩到同一处 rc-trigger/jsdom 挂死（实测 30s 超时）。
 * 文案查询绕开它，且照样能钉住「按钮渲染了」——删掉 `{row.goldStale && <Popconfirm …>}` 即红。
 */
it("stale 用例显示「确认仍有效」按钮", async () => {
  vi.mocked(api.getEvalCases).mockResolvedValue([evalCase({ id: "case-1", goldStale: true })]);
  renderPage();
  await expandFirstSet();
  expect(await screen.findByText("确认仍有效")).toBeInTheDocument();
});

/** 非 stale 用例不该出现这个按钮——没什么可确认的。 */
it("非 stale 用例不显示「确认仍有效」", async () => {
  vi.mocked(api.getEvalCases).mockResolvedValue([evalCase({ id: "case-1", goldStale: false })]);
  renderPage();
  await expandFirstSet();
  await screen.findByText("课程可以退款吗");
  expect(screen.queryByRole("button", { name: "确认仍有效" })).not.toBeInTheDocument();
});
