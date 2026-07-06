// M2 Story 0-5 运行时 QA：用 Playwright 驱动 frontend dev server。
// 验证 AC 1（15 屏可点开）/ AC 3（未登录重定向）/ AC 7（Sider 导航）/ AC 8（Chat 三栏）。
// 登录（AC 2）由 backend e2e + frontend 单测覆盖，本脚本不重复（避免起 backend+postgres）。
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const BASE = "http://localhost:5173";
const SHOT_DIR = ".ship/tasks/m2/qa/screenshots";

// 15 屏路由（含动态参数，用 mock 真实 id 以渲染内容而非空态）
const ROUTES = [
  { path: "/admin", name: "start", expect: "快速开始" },
  { path: "/admin/dashboard", name: "dashboard", expect: "运行看板" },
  { path: "/admin/agents", name: "agents", expect: "Agent 管理" },
  { path: "/admin/knowledge-bases", name: "knowledge-bases", expect: "知识库" },
  { path: "/admin/knowledge-bases/kb1/documents", name: "documents", expect: "文档" },
  { path: "/admin/knowledge-bases/kb1/documents/doc1/chunks", name: "chunks", expect: "切片" },
  { path: "/admin/retrieval-test", name: "retrieval-test", expect: "检索测试" },
  { path: "/admin/prompts", name: "prompts", expect: "Prompt" },
  { path: "/admin/evalsets", name: "evalsets", expect: "评测集" },
  { path: "/admin/evaluations", name: "evaluations", expect: "评测" },
  { path: "/admin/evaluations/er1", name: "eval-report", expect: "评测" },
  { path: "/admin/traces", name: "traces", expect: "Trace" },
  { path: "/admin/traces/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6", name: "trace-detail", expect: "Trace" },
  { path: "/admin/models", name: "models", expect: "模型" },
  { path: "/chat", name: "chat", expect: "会话列表" },
];

const issues = [];
const passed = [];

async function newPage(browser) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => pageErrors.push(err.message));
  return { page, consoleErrors, pageErrors };
}

async function setToken(page) {
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.setItem("token", "qa-stub-token"));
}

// 用系统 Chrome（channel:'chrome'）避免从 CDN 下载 chromium（上海网络拉不动 playwright CDN）。
const browser = await chromium.launch({ channel: "chrome" });

try {
  // ---------- AC 3: 未登录访问 /admin → 重定向 /login ----------
  const ac3 = await newPage(browser);
  await ac3.page.goto(`${BASE}/admin`, { waitUntil: "networkidle" });
  const ac3Url = ac3.page.url();
  const ac3HasLogin = await ac3.page.getByPlaceholder("邮箱").count();
  if (ac3Url.endsWith("/login") && ac3HasLogin > 0) {
    passed.push("AC3: 未登录访问 /admin 重定向到 /login");
  } else {
    issues.push({
      id: "ISSUE-001",
      category: "Functional",
      severity: "P1",
      desc: `AC3 失败：未登录访问 /admin 未重定向到 /login。url=${ac3Url}, 邮箱框=${ac3HasLogin}`,
    });
  }
  await ac3.page.screenshot({ path: `${SHOT_DIR}/ac3-redirect.png`, fullPage: false });
  await ac3.page.close();

  // ---------- 设 token，后续访问都带认证 ----------
  const ctx = await newPage(browser);
  await setToken(ctx.page);

  // ---------- AC 1: 15 屏可点开 + console 错误检查 ----------
  for (const r of ROUTES) {
    await ctx.page.goto(`${BASE}${r.path}`, { waitUntil: "networkidle" });
    // 等 lazy chunk 加载 + antd 渲染
    try {
      await ctx.page.waitForLoadState("networkidle", { timeout: 5000 });
    } catch {}
    await ctx.page.waitForTimeout(400);
    const title = await ctx.page.title();
    const bodyText = (await ctx.page.locator("body").innerText()).slice(0, 2000);
    const ok = bodyText.includes(r.expect);
    const shot = `${SHOT_DIR}/${r.name}.png`;
    await ctx.page.screenshot({ path: shot, fullPage: false });
    const errs = [...ctx.consoleErrors, ...ctx.pageErrors];
    if (!ok) {
      issues.push({
        id: `ISSUE-${String(issues.length + 1).padStart(3, "0")}`,
        category: "Functional",
        severity: "P2",
        desc: `AC1: ${r.path} 未渲染期望文案「${r.expect}」。title=${title}`,
        screenshot: shot,
      });
    }
    if (errs.length > 0) {
      issues.push({
        id: `ISSUE-${String(issues.length + 1).padStart(3, "0")}`,
        category: "Console/Errors",
        severity: "P3",
        desc: `${r.path} 有 ${errs.length} 条 console/page 错误：\n${errs.slice(0, 5).join("\n")}`,
        screenshot: shot,
      });
    } else {
      passed.push(`AC1: ${r.path} 渲染「${r.expect}」OK，console 无错`);
    }
    // 清空错误列表，下一页重新计
    ctx.consoleErrors.length = 0;
    ctx.pageErrors.length = 0;
  }

  // ---------- AC 7: Sider 导航点击跳转 ----------
  // 回到 /admin，点侧栏「模型接入」应跳 /admin/models
  await ctx.page.goto(`${BASE}/admin`, { waitUntil: "networkidle" });
  await ctx.page.waitForTimeout(300);
  const navClick = await ctx.page.getByRole("menuitem", { name: "模型接入" }).first().click().catch((e) => e.message);
  await ctx.page.waitForTimeout(500);
  const afterNavUrl = ctx.page.url();
  if (afterNavUrl.endsWith("/admin/models")) {
    passed.push("AC7: Sider 点击「模型接入」→ /admin/models");
  } else {
    issues.push({
      id: `ISSUE-${String(issues.length + 1).padStart(3, "0")}`,
      category: "Functional",
      severity: "P2",
      desc: `AC7: 点「模型接入」后 url=${afterNavUrl}（期望 /admin/models）。click=${navClick}`,
      screenshot: `${SHOT_DIR}/ac7-nav.png`,
    });
  }
  await ctx.page.screenshot({ path: `${SHOT_DIR}/ac7-nav.png`, fullPage: false });

  // ---------- AC 8: Chat 三栏布局 ----------
  await ctx.page.goto(`${BASE}/chat`, { waitUntil: "networkidle" });
  await ctx.page.waitForTimeout(400);
  const hasConv = await ctx.page.getByText("会话列表").count();
  const hasChat = await ctx.page.getByText("聊天").count();
  const hasCite = await ctx.page.getByText("引用").count();
  await ctx.page.screenshot({ path: `${SHOT_DIR}/ac8-chat.png`, fullPage: false });
  if (hasConv > 0 && hasChat > 0 && hasCite > 0) {
    passed.push("AC8: /chat 三栏（会话列表/聊天/引用）渲染 OK");
  } else {
    issues.push({
      id: `ISSUE-${String(issues.length + 1).padStart(3, "0")}`,
      category: "Functional",
      severity: "P2",
      desc: `AC8: /chat 三栏缺失：会话列表=${hasConv} 聊天=${hasChat} 引用=${hasCite}`,
      screenshot: `${SHOT_DIR}/ac8-chat.png`,
    });
  }

  await ctx.page.close();
} finally {
  await browser.close();
}

// ---------- 写报告 ----------
const reportMd = [
  "# M2 QA — Browser Report",
  "",
  "> Playwright 驱动 frontend dev server（http://localhost:5173）。",
  "> 验证 AC 1/3/7/8。AC 2（登录）由 backend e2e + frontend 单测覆盖，AC 4/9/10 由 backend e2e 覆盖。",
  "",
  "## Verdict",
  "",
  issues.length === 0 ? "**PASS** — 15 屏渲染、导航、Auth、Chat 三栏均通过。" : `**FAIL / FINDINGS** — ${issues.length} 个问题。`,
  "",
  "## Passed",
  "",
  ...passed.map((p) => `- ${p}`),
  "",
  "## Issues",
  "",
  ...(issues.length === 0 ? ["（无）"] : issues.map((i) => `### ${i.id} [${i.severity}] ${i.category}\n- ${i.desc}\n- 截图：${i.screenshot ?? "N/A"}`)),
  "",
].join("\n");
writeFileSync(".ship/tasks/m2/qa/browser-report.md", reportMd);
console.log(reportMd);
console.log(`\n[QA] passed=${passed.length} issues=${issues.length}`);
