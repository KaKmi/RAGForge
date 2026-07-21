import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GapCluster, GapItem, GapListResponse, GapSummary } from "@codecrush/contracts";
import GapsPage from "./GapsPage";

/**
 * 屏5 问题池（原型 `:353-380` + §17.5 `:626-637`）。
 *
 * 断言逐字对着原型：六列表头（`:357`）、空态文案（§19.2 `:762`）、频次的 `×N` 形态（`:358`）、
 * 根因标签中文（`:358-360`）。这些**不是**实现细节——它们就是这一屏的验收标准本身。
 */

const gapsMock = vi.hoisted(() => ({
  getGaps: vi.fn(),
  getGapSummary: vi.fn(),
  getGapItems: vi.fn(),
  ignoreGap: vi.fn(),
  routeGapToRetrieval: vi.fn(),
  reopenGap: vi.fn(),
  updateGapRootCause: vi.fn(),
  splitGap: vi.fn(),
  mergeGap: vi.fn(),
  // Task 9：[进评测集] 挂的「从坏样本生成」弹窗会用到这几个。
  getEvalSets: vi.fn(),
  createEvalSet: vi.fn(),
  draftGapGold: vi.fn(),
  promoteGapToEvalSet: vi.fn(),
  // B2b Task 10：[补知识库] 挂的三步向导。
  // ⚠️ 这个 `vi.mock` 是**整模块替换**（工厂没有 spread 真模块），所以向导用到的每个
  // 函数都必须在这里列出来——漏一个不是「那个调用返回 undefined」，而是
  // `getKnowledgeBases is not a function` 直接把渲染打挂，报错还指向 useEffect 内部。
  getGapFillDraft: vi.fn(),
  draftGapFill: vi.fn(),
  cancelGapFill: vi.fn(),
  submitGapFill: vi.fn(),
  getKnowledgeBases: vi.fn(),
  getApplications: vi.fn(),
  getApplicationDetail: vi.fn(),
}));

vi.mock("../../api/client", () => gapsMock);

const messageMock = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("antd", async () => {
  const antd = await vi.importActual<typeof import("antd")>("antd");
  return { ...antd, message: { ...antd.message, ...messageMock } };
});

function cluster(patch: Partial<GapCluster> = {}): GapCluster {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    representativeQuestion: "能开专用发票吗/对公转账",
    freq: 23,
    freq30d: 9,
    status: "pending",
    rootCause: "missing",
    rootCauseIsManual: false,
    avgQuality: 41,
    followUpRatio: 0,
    enteredEvalSetAt: null,
    recurred: false,
    fillPreScore: null,
    verifiedScore: null,
    firstSeenAt: "2026-07-01T00:00:00.000Z",
    lastSeenAt: "2026-07-18T00:00:00.000Z",
    ...patch,
  };
}

function item(patch: Partial<GapItem> = {}): GapItem {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    clusterId: "11111111-1111-4111-8111-111111111111",
    source: "online",
    sourceTraceId: "a".repeat(32),
    question: "能开专用发票吗",
    rewrittenQuestion: null,
    rewriteResolved: true,
    followUpSuspected: false,
    traceStartTime: "2026-07-18T00:00:00.000Z",
    traceExpired: false,
    faithfulness: 40,
    answerRelevancy: 50,
    contextPrecision: 30,
    confidence: 35,
    ...patch,
  };
}

const EMPTY_SUMMARY: GapSummary = { pending: 0, routedRetrieval: 0, ignored: 0, enteredEvalSet: 0 };

function mockGaps(items: GapCluster[], summary: Partial<GapSummary> = {}): void {
  const response: GapListResponse = { items, total: items.length };
  gapsMock.getGaps.mockResolvedValue(response);
  gapsMock.getGapSummary.mockResolvedValue({ ...EMPTY_SUMMARY, ...summary });
}

/** 观测 URL 的探针——断言「跳去了哪」，而不是只断言「某函数被调过」。 */
function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}

function renderPage(initialEntry = "/admin/gaps") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <GapsPage />
      <LocationProbe />
    </MemoryRouter>,
  );
}

const locationText = () => screen.getByTestId("location").textContent;

beforeEach(() => {
  vi.clearAllMocks();
  gapsMock.getGapItems.mockResolvedValue([]);
  // 向导一打开就并发拉这三份下拉数据；不给默认值，每条测试都要自己 mock 才不炸。
  gapsMock.getKnowledgeBases.mockResolvedValue([]);
  gapsMock.getApplications.mockResolvedValue([]);
  gapsMock.getGapFillDraft.mockResolvedValue(null);
});

describe("屏5 问题池", () => {
  it("空态逐字照原型 §19.2", async () => {
    mockGaps([]);
    renderPage();
    expect(
      await screen.findByText("问题池为空 — 低质量问答会自动聚类出现在这里"),
    ).toBeInTheDocument();
  });

  it("六列表头按原型 `:357` 的顺序", async () => {
    mockGaps([cluster()]);
    renderPage();
    await screen.findByText("能开专用发票吗/对公转账");
    // antd 的 expandable 会在最前面插一个**空**列头（展开箭头），它不属于原型的六列。
    const headers = screen
      .getAllByRole("columnheader")
      .map((el) => el.textContent?.trim())
      .filter((text): text is string => Boolean(text));
    expect(headers).toEqual(["缺口(代表问题)", "频次", "根因分诊", "平均质量", "状态", "操作"]);
  });

  it("频次列保留原型的 ×N 形态，并另起一行显示近 30 天", async () => {
    mockGaps([cluster({ freq: 23, freq30d: 9 })]);
    renderPage();
    expect(await screen.findByText("×23")).toBeInTheDocument();
    expect(screen.getByText("近30天 9")).toBeInTheDocument();
  });

  it("根因用原型的中文标签（缺内容 / 检索问题 / 生成问题）", async () => {
    mockGaps([
      cluster({ id: "a1111111-1111-4111-8111-111111111111", rootCause: "missing" }),
      cluster({
        id: "b1111111-1111-4111-8111-111111111111",
        rootCause: "retrieval",
        representativeQuestion: "直播回放能下载吗",
      }),
      cluster({
        id: "c1111111-1111-4111-8111-111111111111",
        rootCause: "generation",
        representativeQuestion: "课程有效期是终身吗",
      }),
    ]);
    renderPage();
    expect(await screen.findByText("缺内容")).toBeInTheDocument();
    expect(screen.getByText("检索问题")).toBeInTheDocument();
    expect(screen.getByText("生成问题")).toBeInTheDocument();
  });

  it("展开行显示簇内真实问题", async () => {
    mockGaps([cluster()]);
    gapsMock.getGapItems.mockResolvedValue([item({ question: "发票能开专票吗" })]);
    renderPage();
    await screen.findByText("能开专用发票吗/对公转账");

    fireEvent.click(screen.getByRole("button", { name: /展开行|Expand row/i }));

    expect(await screen.findByText("发票能开专票吗")).toBeInTheDocument();
    expect(gapsMock.getGapItems).toHaveBeenCalledWith(cluster().id);
  });

  it("指代未消解的成员挂「指代未消解」标签（决策 G）", async () => {
    mockGaps([cluster()]);
    gapsMock.getGapItems.mockResolvedValue([
      item({ rewriteResolved: false, followUpSuspected: true }),
    ]);
    renderPage();
    await screen.findByText("能开专用发票吗/对公转账");
    fireEvent.click(screen.getByRole("button", { name: /展开行|Expand row/i }));

    expect(await screen.findByText("指代未消解")).toBeInTheDocument();
  });

  it("followUpRatio > 0.5 时行上出现「多轮追问」标签", async () => {
    mockGaps([cluster({ followUpRatio: 0.75 })]);
    renderPage();
    expect(await screen.findByText("多轮追问 75%")).toBeInTheDocument();
  });

  it("勾选簇内成员后浮出工具条（拆分 / 移入其他簇）", async () => {
    mockGaps([cluster()]);
    gapsMock.getGapItems.mockResolvedValue([
      item({ question: "能开专票吗" }),
      item({ id: "33333333-3333-4333-8333-333333333333", question: "可以对公转账吗" }),
    ]);
    renderPage();
    await screen.findByText("能开专用发票吗/对公转账");
    fireEvent.click(screen.getByRole("button", { name: /展开行|Expand row/i }));
    await screen.findByText("能开专票吗");

    // [0] 是 antd 的表头全选框；要的是**首行**那个。
    const checkboxes = screen.getAllByRole("checkbox");
    fireEvent.click(checkboxes[1]);

    expect(await screen.findByText("已选 1 条")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "拆分为新簇" })).toBeInTheDocument();
    expect(screen.getByText("移入其他簇")).toBeInTheDocument();
  });

  it("筛选状态写进 URL（原型 §17.5：状态/根因走 URL 参数）", async () => {
    mockGaps([cluster()]);
    renderPage("/admin/gaps?status=ignored");

    await waitFor(() => {
      expect(gapsMock.getGaps).toHaveBeenCalledWith(expect.objectContaining({ status: "ignored" }));
    });
  });

  it("点概览卡按对应状态筛（原型 §17.5）", async () => {
    mockGaps([cluster()], { pending: 3, ignored: 1 });
    renderPage();
    await screen.findByText("能开专用发票吗/对公转账");

    const ignoredCard = screen
      .getAllByRole("button")
      .find((el) => el.textContent?.startsWith("已忽略"))!;
    fireEvent.click(ignoredCard);

    await waitFor(() => {
      expect(gapsMock.getGaps).toHaveBeenCalledWith(expect.objectContaining({ status: "ignored" }));
    });
  });

  it("[修检索参数] 转工单并带 ?fromGap= 跳转（原型 `:635`）", async () => {
    mockGaps([cluster()]);
    gapsMock.routeGapToRetrieval.mockResolvedValue(cluster({ status: "routed_retrieval" }));
    renderPage();
    await screen.findByText("能开专用发票吗/对公转账");

    fireEvent.click(screen.getByRole("button", { name: "修检索参数" }));

    await waitFor(() => expect(gapsMock.routeGapToRetrieval).toHaveBeenCalledWith(cluster().id));
    // 断言**跳到哪了**——标题里承诺的就是这个，只验「函数被调过」等于没验。
    await waitFor(() => expect(locationText()).toContain(`fromGap=${cluster().id}`));
  });

  /**
   * 这条**取代**了 B2a 的「不渲染尚未接上的 [补知识库]」——那时按钮还没有真实去处，
   * 「点了没反应的按钮比没有它更糟」。B2b 把去处（三步向导）补上了，于是同一个位置
   * 的正确断言从「不该在」翻成「该在，且点了要真开向导」。留着旧断言就是拿 B2a 的
   * 临时状态当永久契约，会把本波的交付判成回归。
   */
  it("[补知识库] 打开三步向导（B2b）", async () => {
    /**
     * ⚠️ 这条曾经断言的是一个**崩溃的向导**（独立复审用探针实测抓出）。
     *
     * `beforeEach` 里 `getGapFillDraft` 被 mock 成 `null`（违反 `GapFillDraftSchema`），
     * 向导 `load` 里对 `null` 取 `.clusterId` 直接抛 TypeError，屏上实际是两条 alert：
     * 「Cannot read properties of null」+「该缺口当前状态为『未知』，补库向导不适用」。
     * 而原来的断言查的是 Steps 的三个标题——它们**无条件渲染**，对 load 成功/失败/崩溃
     * 一视同仁，什么都证明不了：向导的数据接线整体坏掉，这条测试照样绿。
     *
     * 现在返回合法草稿，并断言**只属于成功路径**的东西（第②步的人审表单）。
     */
    mockGaps([cluster()]);
    gapsMock.getGapFillDraft.mockResolvedValue({
      clusterId: cluster().id,
      status: "reviewing",
      representativeQuestion: "能开专用发票吗/对公转账",
      draftQuestion: "能开增值税专用发票吗？",
      draftAnswer: "可以。请提供开票抬头与税号。",
      targetKbId: null,
      targetDocumentId: null,
    });
    renderPage();
    await screen.findByText("能开专用发票吗/对公转账");

    fireEvent.click(screen.getByRole("button", { name: "补知识库" }));

    // 按 role 取：抽屉标题与刚点的那个按钮同名，findByText 会两个都命中。
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    // 人审表单里的真实内容——只有 load 成功、状态解析正确才会出现。
    expect(await screen.findByDisplayValue("能开增值税专用发票吗？")).toBeInTheDocument();
  });

  /**
   * 以下三条补的是复审指出的**空白验收项**：`cluster()` 工厂把 recurred/fillPreScore/
   * verifiedScore 写死成 false/null 且没有任何用例覆盖过它们，于是「复发红标」和
   * 「41→89」这两条明文验收标准一条断言都没有——改坏了套件照样全绿。
   */
  it("复发的簇显示红色「复发」标（原型 §17.5 `:631`）", async () => {
    mockGaps([cluster({ recurred: true })]);
    renderPage();
    await screen.findByText("能开专用发票吗/对公转账");

    // 标题写的是「**红色**复发标」，就得断言红色：这个角标全靠颜色在一屏几十行里
    // 抓住注意力，掉成默认灰色时文字还在、测试照绿，而它已经不起作用了。
    const tag = await screen.findByText("复发");
    expect(tag).toHaveClass("ant-tag-red");
  });

  it("没复发的簇不显示复发标", async () => {
    // 与上一条配对：只测「有的时候有」，一个无条件渲染的角标也能通过。
    mockGaps([cluster({ recurred: false })]);
    renderPage();
    await screen.findByText("能开专用发票吗/对公转账");

    expect(screen.queryByText("复发")).not.toBeInTheDocument();
  });

  it("已回验的簇在平均质量列显示改善 41→89（原型 §9 `:370`）", async () => {
    mockGaps([cluster({ status: "verified", fillPreScore: 41, verifiedScore: 89 })]);
    renderPage();
    await screen.findByText("能开专用发票吗/对公转账");

    // 断言的是**两端都在**的那个形态；只显示 89 等于丢掉了「补库确实起作用了」这个信息。
    expect(await screen.findByText("41→89")).toBeInTheDocument();
    expect(await screen.findByText("已回验")).toBeInTheDocument();
  });

  it("根因不是「缺内容」时，[补知识库] 先二次确认而不是直接开向导（原型 `:700`）", async () => {
    mockGaps([cluster({ rootCause: "retrieval" })]);
    renderPage();
    await screen.findByText("能开专用发票吗/对公转账");

    fireEvent.click(screen.getByRole("button", { name: "补知识库" }));

    // 守卫栏要的是「二次确认」而不是「禁用」——分诊是启发式的，人有权推翻它。
    // 所以断言：确认框出现了，且向导**还没**开。
    expect(await screen.findByText("当前分诊不是「缺内容」")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("[进评测集] 打开「从坏样本生成」弹窗并锁定为本簇（原型 :634）", async () => {
    mockGaps([cluster()]);
    gapsMock.getEvalSets.mockResolvedValue([]);
    gapsMock.getGapItems.mockResolvedValue([]);
    renderPage();
    await screen.findByText("能开专用发票吗/对公转账");

    fireEvent.click(screen.getByRole("button", { name: "进评测集" }));

    expect(await screen.findByText("从坏样本生成")).toBeInTheDocument();
    // 锁定 ⇒ 弹窗不去拉整张缺口列表当下拉选项（那会让人以为还能改来源）。
    expect(await screen.findByText("已锁定为你选中的缺口簇")).toBeInTheDocument();
  });

  it("接口失败时提示错误且不白屏", async () => {
    gapsMock.getGaps.mockRejectedValue(new Error("服务器开小差"));
    gapsMock.getGapSummary.mockResolvedValue(EMPTY_SUMMARY);
    renderPage();

    await waitFor(() => expect(messageMock.error).toHaveBeenCalled());
    // 标题仍在 —— 页面没有整体崩掉。
    expect(screen.getByText("知识缺口 / 问题池")).toBeInTheDocument();
  });

  // ───────── 交互闭环（peer review 指出：9 个 mock 里 5 个从未被触发过） ─────────

  /**
   * ⚠️ 「点开 Popconfirm → 点确定」在本 harness 里跑不了：jsdom 未实现
   * `getComputedStyle` 的伪元素，rc-trigger 的对齐会挂死（`EvalSetsPage.test.tsx:566-578`
   * 已就同一限制留档）。故忽略这条**只静态断言入口在**，「确定后真的调 ignoreGap」
   * 交给运行时 QA。下面的「重新打开」没有 Popconfirm，正好把
   * `act() → 调接口 → 重新拉列表` 这条闭环跑通。
   */
  it("未忽略的行有「忽略」入口，已忽略的行换成「重新打开」", async () => {
    mockGaps([cluster()]);
    const { unmount } = renderPage();
    await screen.findByText("能开专用发票吗/对公转账");
    expect(screen.getByText("忽 略")).toBeInTheDocument();
    expect(screen.queryByText("重新打开")).not.toBeInTheDocument();
    unmount();

    mockGaps([cluster({ status: "ignored" })]);
    renderPage();
    await screen.findByText("能开专用发票吗/对公转账");
    expect(screen.getByText("重新打开")).toBeInTheDocument();
    expect(screen.queryByText("忽 略")).not.toBeInTheDocument();
  });

  it("重新打开：调接口并重新拉列表（act 闭环）", async () => {
    mockGaps([cluster({ status: "ignored" })]);
    gapsMock.reopenGap.mockResolvedValue(cluster({ status: "pending" }));
    renderPage();
    await screen.findByText("能开专用发票吗/对公转账");
    const before = gapsMock.getGaps.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "重新打开" }));

    await waitFor(() => expect(gapsMock.reopenGap).toHaveBeenCalledWith(cluster().id));
    await waitFor(() => expect(gapsMock.getGaps.mock.calls.length).toBeGreaterThan(before));
    expect(messageMock.error).not.toHaveBeenCalled();
  });

  it("改判根因走 updateGapRootCause 并刷新", async () => {
    mockGaps([cluster({ rootCause: "missing" })]);
    gapsMock.updateGapRootCause.mockResolvedValue(cluster({ rootCause: "generation" }));
    renderPage();
    await screen.findByText("能开专用发票吗/对公转账");

    // 根因下拉的 option label 是 <Tag>（不是字符串），所以没有 title 属性，只能按文案找。
    fireEvent.mouseDown(screen.getByText("缺内容"));
    const option = await screen.findByText("生成问题");
    fireEvent.click(option.closest(".ant-select-item") ?? option);

    await waitFor(() =>
      expect(gapsMock.updateGapRootCause).toHaveBeenCalledWith(cluster().id, {
        rootCause: "generation",
      }),
    );
  });

  /**
   * P1 回归：合并走**全部**成员 ⇒ 后端软删源簇 ⇒ 若前端还去拉它的成员，会拿到
   * 404「缺口不存在：<uuid>」——绿 toast 后面紧跟一条带裸 UUID 的红 toast，而操作其实成功了。
   * 这个 bug 曾在 299 条全绿的情况下溜过去，因为没有任何用例真的点下过「确认移入」。
   */
  it("合并走全部成员后不再拉源簇成员（不会跟一条假 404）", async () => {
    mockGaps([cluster(), cluster({ id: "44444444-4444-4444-8444-444444444444" })]);
    gapsMock.getGapItems.mockResolvedValue([item({ question: "能开专票吗" })]);
    gapsMock.mergeGap.mockResolvedValue({
      targetClusterId: "44444444-4444-4444-8444-444444444444",
      sourceSoftDeleted: true,
    });
    renderPage();
    await screen.findAllByText("能开专用发票吗/对公转账");
    fireEvent.click(screen.getAllByRole("button", { name: /展开行|Expand row/i })[0]);
    await screen.findByText("能开专票吗");
    fireEvent.click(screen.getAllByRole("checkbox")[1]);
    await screen.findByText("已选 1 条");

    const itemsCallsBefore = gapsMock.getGapItems.mock.calls.length;
    fireEvent.mouseDown(screen.getByText("移入其他簇"));
    fireEvent.click(await screen.findByTitle("能开专用发票吗/对公转账"));
    fireEvent.click(screen.getByRole("button", { name: "确认移入" }));

    await waitFor(() => expect(gapsMock.mergeGap).toHaveBeenCalled());
    // 源簇已软删 ⇒ 绝不能再拉它的成员。
    expect(gapsMock.getGapItems.mock.calls.length).toBe(itemsCallsBefore);
    expect(messageMock.error).not.toHaveBeenCalled();
  });

  it("平均质量为 null 时显示未评而不是 0", async () => {
    mockGaps([cluster({ avgQuality: null })]);
    renderPage();
    const cell = await screen.findByText("未评");
    expect(cell).toBeInTheDocument();
    // 断言限定在这一格：概览卡本身就有一堆 0，全页 queryByText("0") 会假红。
    expect(cell.closest("td")?.textContent).toBe("未评");
  });
});
