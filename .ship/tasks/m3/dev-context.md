# Dev Context — M3 模型接入

## Test Command
- 全仓：`pnpm test`（turbo）；lint：`pnpm lint`；build：`pnpm build`
- 分包：`pnpm --filter @codecrush/contracts test`（vitest）、`pnpm --filter @codecrush/backend test`（jest，可 `-- <spec>` 过滤）、`pnpm --filter @codecrush/frontend test`（vitest）
- 迁移：`pnpm db:generate` / `pnpm db:migrate`（需 `docker compose -f infra/docker-compose.yml --profile infra up -d --wait`）

## Code Conduct
- Conventional Commits，结尾 `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`；仅提交不推送。
- `pnpm lint` 边界规则 0 违规（前端只 import contracts/otel-conventions；跨模块只走 barrel/DI token；禁 import adapters/）。
- 中文注释风格（对齐 prompts 模块）；zod v4；Node 22 fetch；后端 jest、contracts/前端 vitest。

## Review 策略（CLAUDE.md 轻量对抗，用户 2026-07-05 拍板）
- 不做每 story peer 审。
- **Story 2（加密，安全敏感）单独 peer 审**。
- 全部 story 完成后一次 peer review 覆盖全量 diff（WAVE_BASE..HEAD）。
- WAVE_BASE_SHA = 3b55109d1452bfde161be21e60c4f8fc59100a01

## Pattern References
### Story 1（契约）
- `packages/contracts/src/prompts.ts` + `m2-schemas.test.ts` — schema 读写分离与正反例测试风格。
### Story 2（加密/SecurityModule）
- `apps/backend/src/platform/persistence/persistence.module.ts` — @Global + Symbol token + useFactory 范式。
- `apps/backend/test/config.schema.spec.ts` — env fail-fast 测试风格。
### Story 3（schema/repository）
- `apps/backend/src/modules/prompts/schema.ts`、`users.repository.ts` — 域内表定义（零 service 引用）+ 最简 repo。
### Story 4（port/adapter）
- `docs/design/003-code-organization.md:101` 端口/适配器落位；无现成 adapter 先例（M3 首个），`none found`（搜索过 modules/*/adapters）。
### Story 5（service/controller/e2e）
- `apps/backend/src/modules/prompts/prompts.service.ts`、`prompts.controller.ts`、`skeleton.e2e.spec.ts:58-148`（in-memory repo override 范式）。
### Story 6（前端）
- `apps/frontend/src/pages/admin/PromptsPage.tsx:86-130`（loading/err/busy 态）、`api/client.ts` deletePrompt 204 范式、`App.test.tsx:68-92`（挂载测试）。

## Waves
Story 1→2→3→4→5→6→7 全部单 story 顺序波（2/3/4 文件不重叠理论上可并行，但均为 mechanical/含完整代码，host 直接实现比派子代理更省；且顺序执行保证 Story 5 汇聚时上游已就绪）。
Story 1 落地后 backend/frontend 短暂红（未适配新契约），Story 5/6 恢复——中途只跑本包过滤测试，Story 7 跑全仓。
