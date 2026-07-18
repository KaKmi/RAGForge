import { defineConfig } from "vitest/config";
import { createLogger, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// dev/build/test 一律解析到 contracts 源码，不消费 dist。
// 原因：contracts 输出 CJS barrel（__exportStar），Vite dev 的 esbuild 预打包静态分析
// 不出命名导出，导致 `import { LoginResponseSchema } from "@codecrush/contracts"` 抛
// "does not provide an export named '...'"。解析到源码（ESM TS）后 Vite 逐文件编译，
// 命名导出可见。backend 仍消费 contracts dist（NestJS CJS 互操作正常）。
const contractsSrc = fileURLToPath(
  new URL("../../packages/contracts/src/index.ts", import.meta.url),
);

const backendTarget = "http://localhost:3000";

// 启动竞态降噪：`turbo run dev` 并发起 vite 与 `nest start --watch`——vite 约 2s 就绪，
// 后端要先全量编译 TS 才监听 3000（本机实测 ~23s）。浏览器首屏在这段空窗里打 /api/*，
// 每条都会在终端刷一段 AggregateError [ECONNREFUSED] 堆栈，一次启动十几条，把真正的
// 报错淹掉。这里只收敛「后端还没起来」这一种情形，其余代理错误照常打印全文——
// 不能为了安静把真实故障也吞了。
//
// 两处配合，缺一不可（Vite 8 的 proxyMiddleware 里 `opts.configure` 在 Vite 自己的
// error 监听器**之前**执行，故无法在 configure 里摘掉它，只能靠 customLogger 过滤）：
//   1. configure —— 抢先应答 503 JSON（Vite 自带的兜底是 502 text/plain）
//   2. customLogger —— 丢掉 Vite 那条堆栈，换成一行节流提示
const QUIET_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "EAI_AGAIN"]);
const WARN_THROTTLE_MS = 10_000;

const errCode = (err: unknown): string | undefined =>
  (err as NodeJS.ErrnoException | undefined)?.code;

const isBackendBooting = (err: unknown): boolean => {
  const code = errCode(err);
  return code !== undefined && QUIET_CODES.has(code);
};

const quietBootProxy: NonNullable<ProxyOptions["configure"]> = (proxy) => {
  proxy.on("error", (err, _req, res) => {
    if (!isBackendBooting(err)) return; // 交给 Vite 自己的处理器打全文

    // res 在 websocket 升级失败时是 Socket，没有 writeHead。
    if ("writeHead" in res && !res.headersSent) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "backend is starting" }));
    }
  });
};

const logger = createLogger();
const baseError = logger.error.bind(logger);
let lastWarnedAt = 0;

logger.error = (msg, opts) => {
  if (!isBackendBooting(opts?.error)) {
    baseError(msg, opts);
    return;
  }
  // 按时间节流而非「只提示一次」：后端若在会话中途挂掉，仍要能再看到提示。
  const now = Date.now();
  if (now - lastWarnedAt > WARN_THROTTLE_MS) {
    lastWarnedAt = now;
    logger.info(
      `后端 (${backendTarget}) 尚未就绪，已忽略启动期请求——nest 编译完成后刷新页面即可`,
      { timestamp: true },
    );
  }
};

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@codecrush/contracts": contractsSrc,
    },
  },
  customLogger: logger,
  server: {
    port: 5173,
    proxy: {
      "/health": { target: backendTarget, configure: quietBootProxy },
      "/api": { target: backendTarget, configure: quietBootProxy },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: "./src/test/setup.ts",
    // 每个测试文件都在自己的 fork 里冷启动一遍 antd/echarts 的模块图（vite-node 逐模块
    // 编译、不打包），再付一次 antd cssinjs 首帧的同步开销——空载约 0.5s，CPU 一被抢占就
    // 涨到数秒。默认 5s 的 testTimeout 是按「普通单测」定的墙钟阈值，跟这里的工作量不匹配：
    // `pnpm test` 全量并跑（backend jest 十几个 worker + 本套件十几个 fork）时会被随机击穿，
    // 表现为每次红的文件都不一样、单独跑却全绿。放宽阈值不放宽断言——真挂住的用例照样红。
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // 16 个 fork 各自扛一份 jsdom + antd 模块图，内存和 CPU 双重超订，既拖慢自己也把
    // turbo 全量跑推向 OOM。压到半数核心：并发仍够用，峰值内存减半。
    maxWorkers: "50%",
  },
});
