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
  },
});
