// M2 Story 7 — AC2 端到端 login 验证（浏览器驱动）。
// 验：未登录访问 /admin 重定向 /login 且表单渲染；提交正确凭据 → 存 token → 跳 /admin。
import { chromium } from "playwright";

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") errs.push("console: " + m.text());
});

await page.goto("http://localhost:5173/admin", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(800);
const urlAfterRedirect = page.url();
const emailInput = await page.getByPlaceholder("邮箱").count();

await page.getByPlaceholder("邮箱").fill("demo@codecrush.local");
await page.getByPlaceholder("密码").fill("CodeCrushDemo123!");
await page.locator("form").dispatchEvent("submit");
await page.waitForTimeout(1500);
const urlAfterLogin = page.url();
const token = await page.evaluate(() => localStorage.getItem("token"));
const hasBrand = await page.getByText("CodeCrushBot").count();

console.log(
  JSON.stringify(
    {
      redirectUrl: urlAfterRedirect,
      emailInputRendered: emailInput,
      afterLoginUrl: urlAfterLogin,
      tokenStored: token ? token.slice(0, 20) + "..." : null,
      brandRendered: hasBrand,
      runtimeErrors: errs,
    },
    null,
    2,
  ),
);
await page.screenshot({ path: ".ship/tasks/m2/qa/screenshots/ac2-login.png", fullPage: false });
await browser.close();
