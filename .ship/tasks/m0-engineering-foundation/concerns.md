# Concerns — M0

均为非阻塞项，M0 全部验收通过。记录供 M0.5/后续留意。

## 版本漂移（实装比 plan/docs 新，已验证可用）
- zod **4**（plan 设 3）：已用两参 `z.record`；env 校验用 `z.string().min(1)` 避开 `.url()` 弃用。
- TypeScript **6**：`moduleResolution: node10` 被当弃用错误 → 加 `ignoreDeprecations: "6.0"`；`outDir` 需显式 `rootDir`（TS5011）。**Revisit：TS 7 前迁移到 `nodenext` 模块解析。**
- 后端测试用 **@swc/jest**（非 ts-jest）：TS6 下 ts-jest 有 peer 版本风险；swc 原生支持 Nest 装饰器。
- antd **6** / Vite **8** / react-router **7** / vitest **4** / ESLint **10** / turbo **2.10**：均新大版本，编译/运行/测试通过。
- turbo 2.10 需根 `packageManager` 字段（已补 `pnpm@9.13.2`）。

## 刻意从 M0 移除（留 M1）
- 未装 `nestjs-zod` / `supertest`：M0 无消费方；M1 出现 DTO 校验 / e2e HTTP 测试时再加。
- 完整 `eslint-plugin-boundaries`（域模块 barrel-only）：M0 域模块尚少，先用 `no-restricted-imports` 落 FE/BE/contracts 两条硬边界；M1 域模块出现时再上。

## 镜像
- compose 镜像用 `:latest`（clickhouse/collector）：**M0.5 接线时锁定具体 tag**（可复现）。

## 审查独立性
- per-story 审查为 **host 自审 fallback**（未 spawn 子代理，遵 harness 规则）。独立性弱于跨模型 peer；建议后续 `/ship:review` 跑一次完整静态审查作为补充交叉验证。
