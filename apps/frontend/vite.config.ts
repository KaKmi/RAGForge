import { defineConfig } from "vitest/config";
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

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@codecrush/contracts": contractsSrc,
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/health": "http://localhost:3000",
      "/api": "http://localhost:3000",
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
