# M7 Agent 配置与管理 — Implementation Plan

> **For agentic workers:** Use /ship:dev to implement this plan task-by-task. Steps use checkbox syntax for tracking.
> Dev-phase 对抗强度：轻量对抗——不做逐 story 审，整个任务收尾跑一次 review 覆盖全量 diff（CLAUDE.md 分级）。

**Goal:** 把 Agent 管理从 M2 内存 mock 换成真实实现：三表版本化模型（`agents`/`agent_config_versions`/`agent_config_version_kbs`）、CRUD、Eval stub 门槛、发布/回滚，前后端全链路接通。

**Architecture:** 复刻 M6 `prompts` 模块的「版本 + `promote()` 单一入口」范式；跨域校验（知识库 embedding 一致性、模型 type/enabled、Prompt node 归属）在 `agents.service.ts` 内完成，只经由 `ModelsService`/`PromptsService`/`KnowledgeBasesRepository` 的既有导出面。

**Tech Stack:** NestJS + Drizzle (Postgres) + Zod (`nestjs-zod`) 后端；React + antd 前端；Jest（`@swc/jest`）单测 + supertest e2e。

参考文档：`docs/design/008-m7-agent-management.md`（架构权威）、`.ship/tasks/m7-agent-management/plan/spec.md`（本计划的直接输入，含所有 file:line 证据）。

---

### Task 1: 契约层重写 — `packages/contracts/src/agents.ts`

**Files:**
- Modify: `packages/contracts/src/agents.ts`（完全重写）
- Modify: `packages/contracts/src/m2-schemas.test.ts`（移除/改写 8 处旧 Agent 断言）

- [ ] **Step 1: 重写 `packages/contracts/src/agents.ts`**

```ts
import { z } from "zod";

export const AgentStatusSchema = z.enum(["draft", "active", "archived"]);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export const AgentConfigVersionStatusSchema = z.enum(["draft", "published", "archived"]);
export type AgentConfigVersionStatus = z.infer<typeof AgentConfigVersionStatusSchema>;

export const EvalStatusSchema = z.enum(["not_run", "passed", "exempt"]);
export type EvalStatus = z.infer<typeof EvalStatusSchema>;

export const FreedomSchema = z.enum(["precise", "balance", "improvise", "custom"]);
export type Freedom = z.infer<typeof FreedomSchema>;

export const NodeConfigSchema = z.object({
  freedom: FreedomSchema,
  temperatureEnabled: z.boolean(),
  temperature: z.number().min(0).max(1),
  topPEnabled: z.boolean(),
  topP: z.number().min(0).max(1),
});
export type NodeConfig = z.infer<typeof NodeConfigSchema>;

export const NodeParamsSchema = z.object({
  rewrite: NodeConfigSchema,
  intent: NodeConfigSchema,
  reply: NodeConfigSchema,
  fallback: NodeConfigSchema,
});
export type NodeParams = z.infer<typeof NodeParamsSchema>;

// 版本化配置字段：新建 Agent 的 v1 与「新建配置版本」共用同一形状（008 数据模型）
export const AgentConfigFieldsSchema = z.object({
  kbIds: z.array(z.string().min(1)).min(1),
  genModelId: z.string().min(1),
  lightModelId: z.string().min(1).optional(),
  rerankModelId: z.string().min(1).optional(),
  promptRewriteVerId: z.string().min(1),
  promptIntentVerId: z.string().min(1),
  promptReplyVerId: z.string().min(1),
  promptFallbackVerId: z.string().min(1),
  nodeParams: NodeParamsSchema,
  topK: z.number().int().positive(),
  topN: z.number().int().positive(),
  threshold: z.number().min(0).max(1),
  multiRecall: z.boolean(),
  vecWeight: z.number().min(0).max(1).optional(),
  fallbackHuman: z.boolean(),
});
export type AgentConfigFields = z.infer<typeof AgentConfigFieldsSchema>;

export const AgentConfigVersionSchema = AgentConfigFieldsSchema.extend({
  id: z.string().min(1),
  agentId: z.string().min(1),
  version: z.number().int().positive(),
  status: AgentConfigVersionStatusSchema,
  evalStatus: EvalStatusSchema,
  evalRunAt: z.string().datetime().nullable(),
  evalPassRate: z.number().min(0).max(1).nullable(),
  note: z.string().optional(),
  createdBy: z.string().min(1),
  createdAt: z.string().datetime(),
  publishedBy: z.string().nullable(),
  publishedAt: z.string().datetime().nullable(),
});
export type AgentConfigVersion = z.infer<typeof AgentConfigVersionSchema>;

// Agent 身份 + 派生 status + 当前生产版本展开（列表/详情/"从 Agent 加载"复用同一形状）
export const AgentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  desc: z.string(),
  enabled: z.boolean(),
  status: AgentStatusSchema,
  currentVersion: AgentConfigVersionSchema.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  updatedBy: z.string().min(1),
});
export type Agent = z.infer<typeof AgentSchema>;

export const AgentListResponseSchema = z.array(AgentSchema);
export type AgentListResponse = z.infer<typeof AgentListResponseSchema>;

export const CreateAgentRequestSchema = AgentConfigFieldsSchema.extend({
  name: z.string().min(1),
  desc: z.string().default(""),
});
export type CreateAgentRequest = z.infer<typeof CreateAgentRequestSchema>;

// 编辑收窄：仅 name/desc/enabled；strictObject 拒绝其他键（008 决策 3，对齐
// UpdateKnowledgeBaseRequestSchema 的 strictObject + service 层双重防线模式）
export const UpdateAgentRequestSchema = z.strictObject({
  name: z.string().min(1).optional(),
  desc: z.string().optional(),
  enabled: z.boolean().optional(),
});
export type UpdateAgentRequest = z.infer<typeof UpdateAgentRequestSchema>;

export const CreateAgentConfigVersionRequestSchema = AgentConfigFieldsSchema.extend({
  note: z.string().optional(),
});
export type CreateAgentConfigVersionRequest = z.infer<
  typeof CreateAgentConfigVersionRequestSchema
>;

export const AgentConfigVersionListResponseSchema = z.array(AgentConfigVersionSchema);
export type AgentConfigVersionListResponse = z.infer<
  typeof AgentConfigVersionListResponseSchema
>;
```

- [ ] **Step 2: 改写 `packages/contracts/src/m2-schemas.test.ts` 里的 Agent 相关用例**

删除 118-119、164-165、221-238、255-263 行（旧扁平 `AgentSchema`/`CreateAgentRequestSchema`/`UpdateAgentRequestSchema` 断言）与 54 行起的 `valid.agent` fixture 定义。`chatReq`/`conv` fixture（93-100 行）的 `agentId: "aftersale"` 字面量保留不动（那是 `ChatRequestSchema`/`ConversationSchema` 的普通字符串字段）。

新增等价覆盖（用 `AgentConfigFieldsSchema`/`NodeConfigSchema` 的合法示例值）：

```ts
const validNodeConfig = {
  freedom: "balance" as const,
  temperatureEnabled: true,
  temperature: 0.5,
  topPEnabled: false,
  topP: 0.9,
};
const validAgentConfigFields = {
  kbIds: ["kb1"],
  genModelId: "m1",
  promptRewriteVerId: "pv1",
  promptIntentVerId: "pv2",
  promptReplyVerId: "pv3",
  promptFallbackVerId: "pv4",
  nodeParams: {
    rewrite: validNodeConfig,
    intent: validNodeConfig,
    reply: validNodeConfig,
    fallback: validNodeConfig,
  },
  topK: 20,
  topN: 5,
  threshold: 0.65,
  multiRecall: true,
  fallbackHuman: true,
};

it("CreateAgentRequestSchema accepts full payload", () => {
  const req = { ...validAgentConfigFields, name: "售后助手", desc: "" };
  expect(CreateAgentRequestSchema.parse(req).name).toBe("售后助手");
});
it("CreateAgentRequestSchema rejects threshold out of range", () => {
  const req = { ...validAgentConfigFields, name: "x", desc: "", threshold: 2 };
  expect(() => CreateAgentRequestSchema.parse(req)).toThrow();
});
it("UpdateAgentRequestSchema is strict — rejects unknown keys", () => {
  expect(() => UpdateAgentRequestSchema.parse({ name: "新名字" })).not.toThrow();
  expect(() => UpdateAgentRequestSchema.parse({ topK: 10 })).toThrow();
});
```

- [ ] **Step 3: 跑契约包测试**

Run: `pnpm --filter @codecrush/contracts test`
Expected: PASS，无 Agent 相关失败用例。

- [ ] **Step 4: Commit**

```bash
git add packages/contracts/src/agents.ts packages/contracts/src/m2-schemas.test.ts
git commit -m "feat(contracts): M7 agents 契约改三层版本化模型"
```

---

### Task 2: 后端 schema — `apps/backend/src/modules/agents/schema.ts` + 迁移

**Files:**
- Create: `apps/backend/src/modules/agents/schema.ts`

- [ ] **Step 1: 写 schema.ts**

```ts
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { NodeParams } from "@codecrush/contracts";
import { modelProviders } from "../models/schema";
import { promptVersions } from "../prompts/schema";
import { knowledgeBases } from "../knowledge-bases/schema";

// 域内 schema：零 service 引用（003 不变量 5 / AGENTS.md 不变量 8）。
// 008:数据模型 — agents(身份+生产指针) / agent_config_versions(版本快照) /
// agent_config_version_kbs(版本级知识库快照)。

export const agents = pgTable("agents", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  desc: text("desc").notNull().default(""),
  enabled: boolean("enabled").notNull().default(true),
  // 循环 FK：无 DB 层即时约束，靠 service 写入顺序保证（先插 agents(null) → 插 v1 → 回填），
  // 复刻 prompts.currentVersionId 既有写法（prompts/schema.ts:11）。
  currentVersionId: uuid("current_version_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  updatedBy: text("updated_by").notNull(),
});

export const agentConfigVersions = pgTable(
  "agent_config_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    status: text("status").notNull().default("draft"),
    genModelId: uuid("gen_model_id")
      .notNull()
      .references(() => modelProviders.id, { onDelete: "restrict" }),
    lightModelId: uuid("light_model_id").references(() => modelProviders.id, {
      onDelete: "restrict",
    }),
    rerankModelId: uuid("rerank_model_id").references(() => modelProviders.id, {
      onDelete: "restrict",
    }),
    promptRewriteVerId: uuid("prompt_rewrite_ver_id")
      .notNull()
      .references(() => promptVersions.id, { onDelete: "restrict" }),
    promptIntentVerId: uuid("prompt_intent_ver_id")
      .notNull()
      .references(() => promptVersions.id, { onDelete: "restrict" }),
    promptReplyVerId: uuid("prompt_reply_ver_id")
      .notNull()
      .references(() => promptVersions.id, { onDelete: "restrict" }),
    promptFallbackVerId: uuid("prompt_fallback_ver_id")
      .notNull()
      .references(() => promptVersions.id, { onDelete: "restrict" }),
    // .$type<T>() 仅 TS 层断言，运行时 jsonb（对齐 prompts/schema.ts:27 variables 的既有惯例）
    nodeParams: jsonb("node_params").notNull().default({}).$type<NodeParams>(),
    topK: integer("top_k").notNull(),
    topN: integer("top_n").notNull(),
    threshold: real("threshold").notNull(),
    multiRecall: boolean("multi_recall").notNull().default(true),
    vecWeight: real("vec_weight"),
    fallbackHuman: boolean("fallback_human").notNull().default(true),
    // M7 阶段：eval_status 只取 not_run/passed/exempt；evalPassRate 恒 null（stub 不编造数字，008 Trade-offs）
    evalStatus: text("eval_status").notNull().default("not_run"),
    evalRunAt: timestamp("eval_run_at"),
    evalPassRate: real("eval_pass_rate"),
    evalSummary: jsonb("eval_summary"),
    note: text("note"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    publishedBy: text("published_by"),
    publishedAt: timestamp("published_at"),
  },
  (t) => ({
    // 撞号兜底（同 prompts）；(agentId,status) 加速找当前 prod/可回滚 archived；
    // (agentId,createdAt) 供配置版本抽屉时间倒序
    uniqAgentVersion: uniqueIndex("agent_config_versions_agent_id_version_idx").on(
      t.agentId,
      t.version,
    ),
    agentStatusIdx: index("agent_config_versions_agent_id_status_idx").on(t.agentId, t.status),
    agentCreatedIdx: index("agent_config_versions_agent_id_created_at_idx").on(
      t.agentId,
      t.createdAt,
    ),
  }),
);

export const agentConfigVersionKbs = pgTable(
  "agent_config_version_kbs",
  {
    versionId: uuid("version_id")
      .notNull()
      .references(() => agentConfigVersions.id, { onDelete: "cascade" }),
    kbId: uuid("kb_id")
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: "restrict" }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.versionId, t.kbId] }),
    kbIdx: index("agent_config_version_kbs_kb_id_idx").on(t.kbId),
  }),
);

export type AgentRow = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;
export type AgentConfigVersionRow = typeof agentConfigVersions.$inferSelect;
export type NewAgentConfigVersion = typeof agentConfigVersions.$inferInsert;
export type AgentConfigVersionKbRow = typeof agentConfigVersionKbs.$inferSelect;
```

- [ ] **Step 2: 生成迁移**

Run: `pnpm --filter @codecrush/backend db:generate`
Expected: 在 `apps/backend/drizzle/` 生成新的 `000X_xxx.sql` + `meta/000X_snapshot.json`，内容含 `CREATE TABLE agents/agent_config_versions/agent_config_version_kbs` 与对应索引/外键。检查生成的 SQL 文件确认三张表都出现且外键指向正确（`model_providers`/`prompt_versions`/`knowledge_bases`/`agents` 自身）。

- [ ] **Step 3: 本地跑迁移验证（需要 `docker compose -f infra/docker-compose.yml --profile infra up -d --wait` 已起）**

Run: `pnpm --filter @codecrush/backend db:migrate`
Expected: 无报错，三张新表创建成功。

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/modules/agents/schema.ts apps/backend/drizzle/
git commit -m "feat(backend): M7 agents 三表 schema + 迁移"
```

---

### Task 3: 联动补丁 — `prompts.service.ts` / `models.service.ts` / `knowledge-bases.repository.ts`

这三处改动 agents 模块后续会依赖，先落地并各自补测试。

**Files:**
- Modify: `apps/backend/src/modules/prompts/prompts.service.ts`
- Modify: `apps/backend/test/prompts.service.spec.ts`
- Modify: `apps/backend/src/modules/models/models.service.ts`
- Modify: `apps/backend/src/modules/knowledge-bases/knowledge-bases.repository.ts`

- [ ] **Step 1: `prompts.service.ts` — 补 `delete()` 的 FK 违反捕获 + 新增 `getVersionMeta()`**

在文件顶部 import 增加 `ConflictException`（已 import）；在 `isUniqueViolation` 函数旁新增一个独立的 `isForeignKeyViolation`（复刻 `models.service.ts:177-185` 的 `.cause.code` 检查，不复用 `isUniqueViolation`）：

```ts
// 追加到 prompts.service.ts 文件末尾（isUniqueViolation 函数之后）
function isForeignKeyViolation(e: unknown): boolean {
  const cause = e instanceof Error ? e.cause : undefined;
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause as { code: string }).code === "23503"
  );
}
```

改写 `delete()`（108-115 行）：

```ts
async delete(promptId: string): Promise<void> {
  const r = await this.repo.findPromptById(promptId);
  if (!r) throw new NotFoundException(`prompt ${promptId} not found`);
  if (r.currentVersionId !== null) {
    throw new ConflictException("已启用的 Prompt 不可删除，请先停用");
  }
  try {
    await this.repo.deletePrompt(promptId);
  } catch (err) {
    if (isForeignKeyViolation(err)) {
      throw new ConflictException(`prompt ${promptId} 的某个版本仍被 Agent 配置引用，无法删除`);
    }
    throw err;
  }
}
```

新增方法（放在 `delete()` 之后）：

```ts
// 供跨域（agents）调用：给定 prompt_version id，反查其所属 prompt 与 node（校验节点归属用）
async getVersionMeta(versionId: string): Promise<{ promptId: string; node: string } | null> {
  const version = await this.repo.findVersionById(versionId);
  if (!version) return null;
  const prompt = await this.repo.findPromptById(version.promptId);
  if (!prompt) return null;
  return { promptId: version.promptId, node: prompt.node };
}
```

- [ ] **Step 2: 扩展 `apps/backend/test/prompts.service.spec.ts`**

新增两个 `it`（放在文件末尾 `describe("PromptsService", ...)` 块内）：

```ts
it("delete → repo 抛 FK 违反（23503，包在 cause 里）时转 409", async () => {
  const fkError = Object.assign(new Error("update or delete violates foreign key constraint"), {
    cause: { code: "23503" },
  });
  const repo = makeRepo({
    findPromptById: jest.fn(async () => ({ ...promptListRow, currentVersionId: null })),
    deletePrompt: jest.fn(async () => {
      throw fkError;
    }),
  });
  const service = new PromptsService(repo);
  await expect(service.delete("p1")).rejects.toThrow(ConflictException);
});

it("getVersionMeta → 返回 {promptId, node}；版本不存在 → null", async () => {
  const repo = makeRepo({
    findVersionById: jest.fn(async (id: string) => (id === "pv1" ? versionRow : undefined)),
    findPromptById: jest.fn(async () => promptRow),
  });
  const service = new PromptsService(repo);
  expect(await service.getVersionMeta("pv1")).toEqual({ promptId: "p1", node: "rewrite" });
  expect(await service.getVersionMeta("nope")).toBeNull();
});
```

（`ConflictException` 需要在文件顶部 import：`import { ConflictException, NotFoundException } from "@nestjs/common";` 已存在 `NotFoundException`，追加 `ConflictException`。）

- [ ] **Step 3: 跑测试确认新增用例通过、既有用例不回归**

Run: `pnpm --filter @codecrush/backend test -- prompts.service.spec`
Expected: 全部 PASS。

- [ ] **Step 4: `models.service.ts:87` 错误文案泛化**

```ts
// 87 行，改前：
throw new ConflictException(`model ${id} 仍被知识库引用，无法删除`);
// 改后：
throw new ConflictException(`model ${id} 仍被知识库或 Agent 配置引用，无法删除`);
```

Run: `pnpm --filter @codecrush/backend test -- models.service.spec`
Expected: 若既有用例断言了旧文案原文，需要同步更新断言字符串；否则 PASS。先跑一次确认。

- [ ] **Step 5: `knowledge-bases.repository.ts` 新增 `findByIds`**

```ts
// 追加到 KnowledgeBasesRepository 类内（findById 方法之后）
async findByIds(ids: string[]): Promise<KnowledgeBaseRow[]> {
  if (ids.length === 0) return [];
  return await this.db.select().from(knowledgeBases).where(inArray(knowledgeBases.id, ids));
}
```

需要在文件顶部 import 增加 `inArray`：`import { desc, eq, inArray } from "drizzle-orm";`

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/modules/prompts/prompts.service.ts apps/backend/test/prompts.service.spec.ts apps/backend/src/modules/models/models.service.ts apps/backend/src/modules/knowledge-bases/knowledge-bases.repository.ts
git commit -m "fix(backend): prompts delete FK 捕获 + getVersionMeta + models 错误文案泛化 + kb 批量查询（M7 前置）"
```

---

### Task 4: 后端 repository — `apps/backend/src/modules/agents/agents.repository.ts`

**Files:**
- Create: `apps/backend/src/modules/agents/agents.repository.ts`

- [ ] **Step 1: 写 repository**

```ts
import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import { DRIZZLE } from "../../platform/persistence/drizzle.constants";
import type { DB } from "../../platform/persistence/persistence.module";
import {
  agents,
  agentConfigVersions,
  agentConfigVersionKbs,
  type AgentRow,
  type NewAgent,
  type AgentConfigVersionRow,
  type NewAgentConfigVersion,
} from "./schema";

// list/get 聚合行：当前生产版本的关键摘要字段一次拿全，避免 N+1（参照 prompts.repository.ts:26-45 PROMPT_AGG_SELECT）
export type AgentListRow = AgentRow & {
  currentVersionNumber: number | null;
  currentVersionStatus: string | null;
};

const AGENT_AGG_SELECT = {
  id: agents.id,
  name: agents.name,
  desc: agents.desc,
  enabled: agents.enabled,
  currentVersionId: agents.currentVersionId,
  createdAt: agents.createdAt,
  updatedAt: agents.updatedAt,
  updatedBy: agents.updatedBy,
  currentVersionNumber: sql<number | null>`(
    SELECT ${agentConfigVersions.version} FROM ${agentConfigVersions}
    WHERE ${agentConfigVersions.id} = "agents"."current_version_id"
  )`.as("current_version_number"),
  currentVersionStatus: sql<string | null>`(
    SELECT ${agentConfigVersions.status} FROM ${agentConfigVersions}
    WHERE ${agentConfigVersions.id} = "agents"."current_version_id"
  )`.as("current_version_status"),
} as const;

@Injectable()
export class AgentsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DB) {}

  async findAgents(): Promise<AgentListRow[]> {
    return await this.db
      .select(AGENT_AGG_SELECT)
      .from(agents)
      .orderBy(desc(agents.updatedAt));
  }

  async findAgentById(id: string): Promise<AgentListRow | undefined> {
    const rows = await this.db
      .select(AGENT_AGG_SELECT)
      .from(agents)
      .where(eq(agents.id, id))
      .limit(1);
    return rows[0];
  }

  async findAgentByName(name: string): Promise<AgentRow | undefined> {
    const rows = await this.db.select().from(agents).where(eq(agents.name, name)).limit(1);
    return rows[0];
  }

  async findVersionById(versionId: string): Promise<AgentConfigVersionRow | undefined> {
    const rows = await this.db
      .select()
      .from(agentConfigVersions)
      .where(eq(agentConfigVersions.id, versionId))
      .limit(1);
    return rows[0];
  }

  async findVersions(agentId: string): Promise<AgentConfigVersionRow[]> {
    return await this.db
      .select()
      .from(agentConfigVersions)
      .where(eq(agentConfigVersions.agentId, agentId))
      .orderBy(desc(agentConfigVersions.createdAt));
  }

  async findVersionKbIds(versionId: string): Promise<string[]> {
    const rows = await this.db
      .select({ kbId: agentConfigVersionKbs.kbId })
      .from(agentConfigVersionKbs)
      .where(eq(agentConfigVersionKbs.versionId, versionId));
    return rows.map((r) => r.kbId);
  }

  // 建 Agent + v1 配置版本 + 知识库快照 + 回填指针：单事务（008 数据流程图 ①）
  async createAgentWithV1(
    agentRow: NewAgent,
    versionRow: Omit<NewAgentConfigVersion, "agentId">,
    kbIds: string[],
  ): Promise<{ agent: AgentRow; version: AgentConfigVersionRow }> {
    return await this.db.transaction(async (tx) => {
      const [agent] = await tx.insert(agents).values(agentRow).returning();
      const [version] = await tx
        .insert(agentConfigVersions)
        .values({ ...versionRow, agentId: agent.id })
        .returning();
      if (kbIds.length > 0) {
        await tx
          .insert(agentConfigVersionKbs)
          .values(kbIds.map((kbId) => ({ versionId: version.id, kbId })));
      }
      const [updatedAgent] = await tx
        .update(agents)
        .set({ currentVersionId: version.id })
        .where(eq(agents.id, agent.id))
        .returning();
      return { agent: updatedAgent, version };
    });
  }

  // 新建草稿配置版本 + 知识库快照（不动 agents 表，008 数据流程图 ②）
  async insertDraftVersion(
    versionRow: NewAgentConfigVersion,
    kbIds: string[],
  ): Promise<AgentConfigVersionRow> {
    return await this.db.transaction(async (tx) => {
      const [version] = await tx.insert(agentConfigVersions).values(versionRow).returning();
      if (kbIds.length > 0) {
        await tx
          .insert(agentConfigVersionKbs)
          .values(kbIds.map((kbId) => ({ versionId: version.id, kbId })));
      }
      return version;
    });
  }

  async updateVersionEval(
    versionId: string,
    patch: { evalStatus: string; evalRunAt: Date; evalPassRate: number | null; evalSummary: unknown },
  ): Promise<AgentConfigVersionRow> {
    const rows = await this.db
      .update(agentConfigVersions)
      .set(patch)
      .where(eq(agentConfigVersions.id, versionId))
      .returning();
    return rows[0];
  }

  async updateAgentBase(
    id: string,
    patch: Partial<Pick<NewAgent, "name" | "desc" | "enabled" | "updatedBy">>,
  ): Promise<AgentRow | undefined> {
    const rows = await this.db
      .update(agents)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(agents.id, id))
      .returning();
    return rows[0];
  }

  // 发布/回滚统一事务（008 数据流程图 ③④，复刻 prompts.repository.ts:123-153 publishVersion 三步模式）
  async promote(
    agentId: string,
    versionId: string,
    actorEmail: string,
  ): Promise<AgentConfigVersionRow> {
    return await this.db.transaction(async (tx) => {
      await tx
        .update(agentConfigVersions)
        .set({ status: "archived" })
        .where(
          and(eq(agentConfigVersions.agentId, agentId), eq(agentConfigVersions.status, "published")),
        );
      await tx
        .update(agentConfigVersions)
        .set({ status: "published", publishedBy: actorEmail, publishedAt: new Date() })
        .where(eq(agentConfigVersions.id, versionId));
      await tx
        .update(agents)
        .set({ currentVersionId: versionId, updatedBy: actorEmail, updatedAt: new Date() })
        .where(eq(agents.id, agentId));
      const rows = await tx
        .select()
        .from(agentConfigVersions)
        .where(eq(agentConfigVersions.id, versionId))
        .limit(1);
      const row = rows[0];
      if (!row) throw new Error(`promote: version ${versionId} vanished after update`);
      return row;
    });
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/backend/src/modules/agents/agents.repository.ts
git commit -m "feat(backend): AgentsRepository — 三表版本化 CRUD + promote 事务"
```

---

### Task 5: 后端 service — `apps/backend/src/modules/agents/agents.service.ts`（TDD）

**Files:**
- Modify: `apps/backend/src/modules/agents/agents.service.ts`（完全重写）
- Create: `apps/backend/test/agents.service.spec.ts`

- [ ] **Step 1: 写失败测试 `apps/backend/test/agents.service.spec.ts`**

```ts
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { AgentsService } from "../src/modules/agents/agents.service";
import type { AgentsRepository } from "../src/modules/agents/agents.repository";

const now = new Date("2026-07-09T00:00:00.000Z");
const nodeConfig = {
  freedom: "balance" as const,
  temperatureEnabled: true,
  temperature: 0.5,
  topPEnabled: false,
  topP: 0.9,
};
const nodeParams = {
  rewrite: nodeConfig,
  intent: nodeConfig,
  reply: nodeConfig,
  fallback: nodeConfig,
};
const validReq = {
  name: "售后助手",
  desc: "",
  kbIds: ["kb1"],
  genModelId: "m1",
  promptRewriteVerId: "pv1",
  promptIntentVerId: "pv2",
  promptReplyVerId: "pv3",
  promptFallbackVerId: "pv4",
  nodeParams,
  topK: 20,
  topN: 5,
  threshold: 0.65,
  multiRecall: true,
  fallbackHuman: true,
};

function makeRepo(overrides: Partial<Record<keyof AgentsRepository, jest.Mock>> = {}): AgentsRepository {
  return {
    findAgents: jest.fn(),
    findAgentById: jest.fn(),
    findAgentByName: jest.fn(async () => undefined),
    findVersionById: jest.fn(),
    findVersions: jest.fn(),
    findVersionKbIds: jest.fn(async () => ["kb1"]),
    createAgentWithV1: jest.fn(),
    insertDraftVersion: jest.fn(),
    updateVersionEval: jest.fn(),
    updateAgentBase: jest.fn(),
    promote: jest.fn(),
    ...overrides,
  } as unknown as AgentsRepository;
}
function makeKbRepo(overrides: Record<string, jest.Mock> = {}) {
  return {
    findByIds: jest.fn(async (ids: string[]) =>
      ids.map((id) => ({ id, embeddingModelId: "embed1" })),
    ),
    ...overrides,
  };
}
function makeModelsService(overrides: Record<string, jest.Mock> = {}) {
  return {
    get: jest.fn(async (id: string) => {
      if (id === "m1") return { id, type: "llm", enabled: true };
      throw new NotFoundException(`model ${id} not found`);
    }),
    ...overrides,
  };
}
function makePromptsService(overrides: Record<string, jest.Mock> = {}) {
  const nodeById: Record<string, string> = {
    pv1: "rewrite",
    pv2: "intent",
    pv3: "reply",
    pv4: "fallback",
  };
  return {
    getVersionMeta: jest.fn(async (id: string) =>
      nodeById[id] ? { promptId: "p1", node: nodeById[id] } : null,
    ),
    ...overrides,
  };
}

describe("AgentsService.create", () => {
  it("合法请求 → repo.createAgentWithV1 被调用，v1 eval_status=exempt", async () => {
    const repo = makeRepo({
      createAgentWithV1: jest.fn(async () => ({
        agent: { id: "a1", name: "售后助手", desc: "", enabled: true, currentVersionId: "v1", createdAt: now, updatedAt: now, updatedBy: "u@x" },
        version: { id: "v1", agentId: "a1", version: 1, status: "published", evalStatus: "exempt", genModelId: "m1", promptRewriteVerId: "pv1", promptIntentVerId: "pv2", promptReplyVerId: "pv3", promptFallbackVerId: "pv4", nodeParams, topK: 20, topN: 5, threshold: 0.65, multiRecall: true, vecWeight: null, fallbackHuman: true, evalRunAt: null, evalPassRate: null, evalSummary: null, note: null, createdBy: "u@x", createdAt: now, publishedBy: null, publishedAt: null, lightModelId: null, rerankModelId: null },
      })),
    });
    const service = new AgentsService(repo, makeKbRepo(), makeModelsService() as never, makePromptsService() as never);
    const res = await service.create(validReq, "u@x");
    expect(res.status).toBe("active");
    expect(res.currentVersion?.evalStatus).toBe("exempt");
    expect(repo.createAgentWithV1).toHaveBeenCalled();
  });

  it("kbIds 指向不同 embedding 模型 → 400", async () => {
    const kbRepo = makeKbRepo({
      findByIds: jest.fn(async () => [
        { id: "kb1", name: "库A", embeddingModelId: "embed1" },
        { id: "kb2", name: "库B", embeddingModelId: "embed2" },
      ]),
    });
    const repo = makeRepo();
    const service = new AgentsService(repo, kbRepo, makeModelsService() as never, makePromptsService() as never);
    await expect(
      service.create({ ...validReq, kbIds: ["kb1", "kb2"] }, "u@x"),
    ).rejects.toThrow(BadRequestException);
  });

  it("genModelId 指向非 llm 类型模型 → 400", async () => {
    const models = makeModelsService({
      get: jest.fn(async () => ({ id: "m1", type: "embedding", enabled: true })),
    });
    const repo = makeRepo();
    const service = new AgentsService(repo, makeKbRepo(), models as never, makePromptsService() as never);
    await expect(service.create(validReq, "u@x")).rejects.toThrow(BadRequestException);
  });

  it("promptRewriteVerId 指向 node 不匹配的版本（如填了 intent 节点的版本）→ 400", async () => {
    const prompts = makePromptsService({
      getVersionMeta: jest.fn(async (id: string) =>
        id === "pv1" ? { promptId: "p1", node: "intent" } : { promptId: "p2", node: "intent" },
      ),
    });
    const repo = makeRepo();
    const service = new AgentsService(repo, makeKbRepo(), makeModelsService() as never, prompts as never);
    await expect(service.create(validReq, "u@x")).rejects.toThrow(BadRequestException);
  });

  it("promptRewriteVerId 指向不存在的版本 → 404", async () => {
    const prompts = makePromptsService({ getVersionMeta: jest.fn(async () => null) });
    const repo = makeRepo();
    const service = new AgentsService(repo, makeKbRepo(), makeModelsService() as never, prompts as never);
    await expect(service.create(validReq, "u@x")).rejects.toThrow(NotFoundException);
  });
});

describe("AgentsService.updateBase", () => {
  it("PATCH 仅 name/desc/enabled 落库", async () => {
    const repo = makeRepo({
      updateAgentBase: jest.fn(async () => ({
        id: "a1", name: "新名字", desc: "", enabled: true, currentVersionId: "v1", createdAt: now, updatedAt: now, updatedBy: "u@x",
      })),
      findAgentById: jest.fn(async () => ({
        id: "a1", name: "新名字", desc: "", enabled: true, currentVersionId: "v1", createdAt: now, updatedAt: now, updatedBy: "u@x", currentVersionNumber: 1, currentVersionStatus: "published",
      })),
      findVersionById: jest.fn(async () => ({ id: "v1", agentId: "a1", version: 1, status: "published", evalStatus: "exempt", genModelId: "m1", promptRewriteVerId: "pv1", promptIntentVerId: "pv2", promptReplyVerId: "pv3", promptFallbackVerId: "pv4", nodeParams, topK: 20, topN: 5, threshold: 0.65, multiRecall: true, vecWeight: null, fallbackHuman: true, evalRunAt: null, evalPassRate: null, evalSummary: null, note: null, createdBy: "u@x", createdAt: now, publishedBy: null, publishedAt: null, lightModelId: null, rerankModelId: null })),
      findVersionKbIds: jest.fn(async () => ["kb1"]),
    });
    const service = new AgentsService(repo, makeKbRepo(), makeModelsService() as never, makePromptsService() as never);
    const res = await service.updateBase("a1", { name: "新名字" }, "u@x");
    expect(res.name).toBe("新名字");
    expect(repo.updateAgentBase).toHaveBeenCalledWith("a1", { name: "新名字", updatedBy: "u@x" });
  });
});

describe("AgentsService publish/rollback — Eval 门槛", () => {
  const draftVersion = {
    id: "v2", agentId: "a1", version: 2, status: "draft", evalStatus: "not_run",
    genModelId: "m1", promptRewriteVerId: "pv1", promptIntentVerId: "pv2", promptReplyVerId: "pv3", promptFallbackVerId: "pv4",
    nodeParams, topK: 20, topN: 5, threshold: 0.65, multiRecall: true, vecWeight: null, fallbackHuman: true,
    evalRunAt: null, evalPassRate: null, evalSummary: null, note: null, createdBy: "u@x", createdAt: now,
    publishedBy: null, publishedAt: null, lightModelId: null, rerankModelId: null,
  };

  it("eval_status=not_run 时发布 → 409", async () => {
    const repo = makeRepo({ findVersionById: jest.fn(async () => draftVersion) });
    const service = new AgentsService(repo, makeKbRepo(), makeModelsService() as never, makePromptsService() as never);
    await expect(service.publish("a1", "v2", "u@x")).rejects.toThrow(ConflictException);
  });

  it("evalRun stub → eval_status=passed, eval_pass_rate=null", async () => {
    const repo = makeRepo({
      findVersionById: jest.fn(async () => draftVersion),
      updateVersionEval: jest.fn(async (id, patch) => ({ ...draftVersion, ...patch })),
    });
    const service = new AgentsService(repo, makeKbRepo(), makeModelsService() as never, makePromptsService() as never);
    const res = await service.evalRun("a1", "v2");
    expect(res.evalStatus).toBe("passed");
    expect(res.evalPassRate).toBeNull();
  });

  it("eval_status=passed 后发布 → 200，repo.promote 被调用", async () => {
    const passedVersion = { ...draftVersion, evalStatus: "passed" };
    const repo = makeRepo({
      findVersionById: jest.fn(async () => passedVersion),
      promote: jest.fn(async () => ({ ...passedVersion, status: "published" })),
    });
    const service = new AgentsService(repo, makeKbRepo(), makeModelsService() as never, makePromptsService() as never);
    await service.publish("a1", "v2", "u@x");
    expect(repo.promote).toHaveBeenCalledWith("a1", "v2", "u@x");
  });

  it("rollback 目标版本非 archived → 409", async () => {
    const repo = makeRepo({ findVersionById: jest.fn(async () => ({ ...draftVersion, status: "draft" })) });
    const service = new AgentsService(repo, makeKbRepo(), makeModelsService() as never, makePromptsService() as never);
    await expect(service.rollback("a1", "v2", "u@x")).rejects.toThrow(ConflictException);
  });

  it("rollback 目标版本已 archived → 通过，不重新校验 eval_status", async () => {
    const archivedVersion = { ...draftVersion, status: "archived", evalStatus: "not_run" };
    const repo = makeRepo({
      findVersionById: jest.fn(async () => archivedVersion),
      promote: jest.fn(async () => ({ ...archivedVersion, status: "published" })),
    });
    const service = new AgentsService(repo, makeKbRepo(), makeModelsService() as never, makePromptsService() as never);
    await service.rollback("a1", "v2", "u@x");
    expect(repo.promote).toHaveBeenCalledWith("a1", "v2", "u@x");
  });
});
```

- [ ] **Step 2: 跑测试确认失败（因 `agents.service.ts` 尚未实现新签名）**

Run: `pnpm --filter @codecrush/backend test -- agents.service.spec`
Expected: FAIL（`AgentsService` 构造函数参数不匹配 / 方法不存在）。

- [ ] **Step 3: 重写 `apps/backend/src/modules/agents/agents.service.ts`**

```ts
import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type {
  Agent,
  AgentConfigVersion,
  CreateAgentConfigVersionRequest,
  CreateAgentRequest,
  UpdateAgentRequest,
} from "@codecrush/contracts";
import { AgentsRepository, type AgentListRow } from "./agents.repository";
import type { AgentRow, AgentConfigVersionRow } from "./schema";
import { KnowledgeBasesRepository } from "../knowledge-bases/knowledge-bases.repository";
import { ModelsService } from "../models/models.service";
import { PromptsService } from "../prompts/prompts.service";

type ConfigFields = Omit<CreateAgentRequest, "name" | "desc"> | CreateAgentConfigVersionRequest;

const PROMPT_FIELD_NODE: Array<[keyof ConfigFields, string]> = [
  ["promptRewriteVerId", "rewrite"],
  ["promptIntentVerId", "intent"],
  ["promptReplyVerId", "reply"],
  ["promptFallbackVerId", "fallback"],
];

@Injectable()
export class AgentsService {
  constructor(
    private readonly repo: AgentsRepository,
    private readonly kbRepo: KnowledgeBasesRepository,
    private readonly models: ModelsService,
    private readonly prompts: PromptsService,
  ) {}

  async list(): Promise<Agent[]> {
    const rows = await this.repo.findAgents();
    return Promise.all(rows.map((r) => this.toAgentFromListRow(r)));
  }

  async get(id: string): Promise<Agent> {
    const row = await this.mustFindAgent(id);
    return this.toAgentFromListRow(row);
  }

  // 建 Agent + v1（008 数据流程图 ①）：校验 → 单事务落库，v1 直接 published + eval_status=exempt
  async create(req: CreateAgentRequest, actorEmail: string): Promise<Agent> {
    await this.validateConfigFields(req);
    const { agent, version } = await this.repo.createAgentWithV1(
      {
        name: req.name,
        desc: req.desc,
        enabled: true,
        currentVersionId: null,
        updatedBy: actorEmail,
      },
      {
        version: 1,
        status: "published",
        genModelId: req.genModelId,
        lightModelId: req.lightModelId ?? null,
        rerankModelId: req.rerankModelId ?? null,
        promptRewriteVerId: req.promptRewriteVerId,
        promptIntentVerId: req.promptIntentVerId,
        promptReplyVerId: req.promptReplyVerId,
        promptFallbackVerId: req.promptFallbackVerId,
        nodeParams: req.nodeParams,
        topK: req.topK,
        topN: req.topN,
        threshold: req.threshold,
        multiRecall: req.multiRecall,
        vecWeight: req.vecWeight ?? null,
        fallbackHuman: req.fallbackHuman,
        evalStatus: "exempt",
        evalRunAt: null,
        evalPassRate: null,
        evalSummary: null,
        note: null,
        createdBy: actorEmail,
        publishedBy: actorEmail,
        publishedAt: new Date(),
      },
      req.kbIds,
    );
    return this.toAgent(agent, version, req.kbIds);
  }

  // 编辑：仅 name/desc/enabled（008 决策 3，契约层已 strictObject 拒绝其他键，此处不再重复校验字段范围）
  async updateBase(id: string, req: UpdateAgentRequest, actorEmail: string): Promise<Agent> {
    await this.mustFindAgent(id);
    const row = await this.repo.updateAgentBase(id, { ...req, updatedBy: actorEmail });
    if (!row) throw new NotFoundException(`agent ${id} not found`);
    return this.toAgentFromListRow(await this.mustFindAgent(id));
  }

  async listVersions(agentId: string): Promise<AgentConfigVersion[]> {
    await this.mustFindAgent(agentId);
    const rows = await this.repo.findVersions(agentId);
    return Promise.all(rows.map((r) => this.toVersionWithKbs(r)));
  }

  // 新建草稿配置版本（008 数据流程图 ②），可重新绑定知识库
  async createVersion(
    agentId: string,
    req: CreateAgentConfigVersionRequest,
    actorEmail: string,
  ): Promise<AgentConfigVersion> {
    await this.mustFindAgent(agentId);
    await this.validateConfigFields(req);
    const existing = await this.repo.findVersions(agentId);
    const nextVersion = existing.reduce((m, v) => Math.max(m, v.version), 0) + 1;
    const version = await this.repo.insertDraftVersion(
      {
        agentId,
        version: nextVersion,
        status: "draft",
        genModelId: req.genModelId,
        lightModelId: req.lightModelId ?? null,
        rerankModelId: req.rerankModelId ?? null,
        promptRewriteVerId: req.promptRewriteVerId,
        promptIntentVerId: req.promptIntentVerId,
        promptReplyVerId: req.promptReplyVerId,
        promptFallbackVerId: req.promptFallbackVerId,
        nodeParams: req.nodeParams,
        topK: req.topK,
        topN: req.topN,
        threshold: req.threshold,
        multiRecall: req.multiRecall,
        vecWeight: req.vecWeight ?? null,
        fallbackHuman: req.fallbackHuman,
        evalStatus: "not_run",
        evalRunAt: null,
        evalPassRate: null,
        evalSummary: null,
        note: req.note ?? null,
        createdBy: actorEmail,
        publishedBy: null,
        publishedAt: null,
      },
      req.kbIds,
    );
    return this.toVersionWithKbs(version);
  }

  // Eval stub（008 决策 2：硬编码 stub，不编造 evalPassRate）
  async evalRun(agentId: string, versionId: string): Promise<AgentConfigVersion> {
    const v = await this.mustFindVersion(agentId, versionId);
    if (v.status !== "draft") {
      throw new ConflictException("只能对草稿版本发起 Eval");
    }
    const updated = await this.repo.updateVersionEval(versionId, {
      evalStatus: "passed",
      evalRunAt: new Date(),
      evalPassRate: null,
      evalSummary: { stub: true, message: "M11 评测系统上线前占位，默认标记通过" },
    });
    return this.toVersionWithKbs(updated);
  }

  // 发布：draft → published，校验 Eval 门槛（008 Invariant 2）
  async publish(agentId: string, versionId: string, actorEmail: string): Promise<AgentConfigVersion> {
    const v = await this.mustFindVersion(agentId, versionId);
    if (v.status !== "draft") throw new ConflictException("只有草稿版本可以发布");
    if (v.evalStatus !== "passed" && v.evalStatus !== "exempt") {
      throw new ConflictException("未通过 Eval 门槛，无法发布");
    }
    return this.toVersionWithKbs(await this.repo.promote(agentId, versionId, actorEmail));
  }

  // 回滚：archived → published，历史上已过门槛，不重新校验（008 Invariant 2）
  async rollback(agentId: string, versionId: string, actorEmail: string): Promise<AgentConfigVersion> {
    const v = await this.mustFindVersion(agentId, versionId);
    if (v.status !== "archived") throw new ConflictException("只能回滚到已归档版本");
    return this.toVersionWithKbs(await this.repo.promote(agentId, versionId, actorEmail));
  }

  // === 校验（create 与 createVersion 共用，008「知识库 Embedding 一致性后端校验」+ 模型/Prompt 引用校验）===
  private async validateConfigFields(req: ConfigFields): Promise<void> {
    const kbs = await this.kbRepo.findByIds(req.kbIds);
    const foundIds = new Set(kbs.map((k) => k.id));
    const missing = req.kbIds.find((id) => !foundIds.has(id));
    if (missing) throw new NotFoundException(`knowledge base ${missing} not found`);
    const distinctEmbed = new Set(kbs.map((k) => k.embeddingModelId));
    if (distinctEmbed.size > 1) {
      const base = kbs.find((k) => k.id === req.kbIds[0])!;
      const conflict = kbs.find((k) => k.embeddingModelId !== base.embeddingModelId)!;
      throw new BadRequestException(
        `「${conflict.name}」使用与已选知识库不一致的向量模型，无法同时绑定`,
      );
    }

    const gen = await this.models.get(req.genModelId);
    if (gen.type !== "llm" || !gen.enabled) {
      throw new BadRequestException("genModelId 必须指向已启用的 llm 类型模型");
    }
    if (req.lightModelId) {
      const light = await this.models.get(req.lightModelId);
      if (light.type !== "llm" || !light.enabled) {
        throw new BadRequestException("lightModelId 必须指向已启用的 llm 类型模型");
      }
    }
    if (req.rerankModelId) {
      const rerank = await this.models.get(req.rerankModelId);
      if (rerank.type !== "rerank" || !rerank.enabled) {
        throw new BadRequestException("rerankModelId 必须指向已启用的 rerank 类型模型");
      }
    }

    for (const [field, expectedNode] of PROMPT_FIELD_NODE) {
      const versionId = req[field] as string;
      const meta = await this.prompts.getVersionMeta(versionId);
      if (!meta) throw new NotFoundException(`prompt version ${versionId} not found`);
      if (meta.node !== expectedNode) {
        throw new BadRequestException(
          `${field} 指向的版本所属节点为 ${meta.node}，与期望的 ${expectedNode} 不一致`,
        );
      }
    }
  }

  private async mustFindAgent(id: string): Promise<AgentListRow> {
    const row = await this.repo.findAgentById(id);
    if (!row) throw new NotFoundException(`agent ${id} not found`);
    return row;
  }

  private async mustFindVersion(agentId: string, versionId: string): Promise<AgentConfigVersionRow> {
    const v = await this.repo.findVersionById(versionId);
    if (!v || v.agentId !== agentId) throw new NotFoundException(`version ${versionId} not found`);
    return v;
  }

  private deriveStatus(row: { currentVersionId: string | null; enabled: boolean }): Agent["status"] {
    if (row.currentVersionId === null) return "draft";
    return row.enabled ? "active" : "archived";
  }

  private async toAgentFromListRow(row: AgentListRow): Promise<Agent> {
    const versionRow = row.currentVersionId
      ? await this.mustFindVersionRowOnly(row.currentVersionId)
      : null;
    const currentVersion = versionRow ? await this.toVersionWithKbs(versionRow) : null;
    return {
      id: row.id,
      name: row.name,
      desc: row.desc,
      enabled: row.enabled,
      status: this.deriveStatus(row),
      currentVersion,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      updatedBy: row.updatedBy,
    };
  }

  private async toAgent(
    agent: AgentRow,
    version: AgentConfigVersionRow,
    kbIds: string[],
  ): Promise<Agent> {
    return {
      id: agent.id,
      name: agent.name,
      desc: agent.desc,
      enabled: agent.enabled,
      status: this.deriveStatus(agent),
      currentVersion: await this.toVersionWithKbs(version, kbIds),
      createdAt: agent.createdAt.toISOString(),
      updatedAt: agent.updatedAt.toISOString(),
      updatedBy: agent.updatedBy,
    };
  }

  private async mustFindVersionRowOnly(versionId: string): Promise<AgentConfigVersionRow> {
    const v = await this.repo.findVersionById(versionId);
    if (!v) throw new Error(`toAgentFromListRow: version ${versionId} vanished`);
    return v;
  }

  private async toVersionWithKbs(
    row: AgentConfigVersionRow,
    knownKbIds?: string[],
  ): Promise<AgentConfigVersion> {
    const kbIds = knownKbIds ?? (await this.repo.findVersionKbIds(row.id));
    return {
      id: row.id,
      agentId: row.agentId,
      version: row.version,
      status: row.status as AgentConfigVersion["status"],
      kbIds,
      genModelId: row.genModelId,
      lightModelId: row.lightModelId ?? undefined,
      rerankModelId: row.rerankModelId ?? undefined,
      promptRewriteVerId: row.promptRewriteVerId,
      promptIntentVerId: row.promptIntentVerId,
      promptReplyVerId: row.promptReplyVerId,
      promptFallbackVerId: row.promptFallbackVerId,
      nodeParams: row.nodeParams,
      topK: row.topK,
      topN: row.topN,
      threshold: row.threshold,
      multiRecall: row.multiRecall,
      vecWeight: row.vecWeight ?? undefined,
      fallbackHuman: row.fallbackHuman,
      evalStatus: row.evalStatus as AgentConfigVersion["evalStatus"],
      evalRunAt: row.evalRunAt ? row.evalRunAt.toISOString() : null,
      evalPassRate: row.evalPassRate,
      note: row.note ?? undefined,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      publishedBy: row.publishedBy,
      publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    };
  }
}
```

- [ ] **Step 4: 跑测试确认全部通过**

Run: `pnpm --filter @codecrush/backend test -- agents.service.spec`
Expected: PASS，全部用例绿。

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/modules/agents/agents.service.ts apps/backend/test/agents.service.spec.ts
git commit -m "feat(backend): AgentsService — CRUD + 配置版本 + Eval stub + 发布回滚"
```

---

### Task 6: 后端 controller + module 接线

**Files:**
- Modify: `apps/backend/src/modules/agents/agents.controller.ts`（完全重写）
- Modify: `apps/backend/src/modules/agents/agents.module.ts`

- [ ] **Step 1: 重写 controller**

```ts
import { Body, Controller, Get, HttpCode, Param, Patch, Post, Req } from "@nestjs/common";
import { createZodDto } from "nestjs-zod";
import {
  CreateAgentConfigVersionRequestSchema,
  CreateAgentRequestSchema,
  UpdateAgentRequestSchema,
  type Agent,
  type AgentConfigVersion,
} from "@codecrush/contracts";
import type { AuthenticatedUser } from "../../platform/security/authenticated-user";
import { AgentsService } from "./agents.service";

class CreateAgentRequestDto extends createZodDto(CreateAgentRequestSchema) {}
class UpdateAgentRequestDto extends createZodDto(UpdateAgentRequestSchema) {}
class CreateAgentConfigVersionRequestDto extends createZodDto(
  CreateAgentConfigVersionRequestSchema,
) {}

type AuthedRequest = { user: AuthenticatedUser };

@Controller("agents")
export class AgentsController {
  constructor(private readonly agentsService: AgentsService) {}

  @Get()
  list(): Promise<Agent[]> {
    return this.agentsService.list();
  }

  @Get(":id")
  get(@Param("id") id: string): Promise<Agent> {
    return this.agentsService.get(id);
  }

  @Post()
  @HttpCode(201)
  create(@Body() body: CreateAgentRequestDto, @Req() req: AuthedRequest): Promise<Agent> {
    return this.agentsService.create(body, req.user.email);
  }

  @Patch(":id")
  updateBase(
    @Param("id") id: string,
    @Body() body: UpdateAgentRequestDto,
    @Req() req: AuthedRequest,
  ): Promise<Agent> {
    return this.agentsService.updateBase(id, body, req.user.email);
  }

  @Get(":id/config-versions")
  listVersions(@Param("id") id: string): Promise<AgentConfigVersion[]> {
    return this.agentsService.listVersions(id);
  }

  @Post(":id/config-versions")
  @HttpCode(201)
  createVersion(
    @Param("id") id: string,
    @Body() body: CreateAgentConfigVersionRequestDto,
    @Req() req: AuthedRequest,
  ): Promise<AgentConfigVersion> {
    return this.agentsService.createVersion(id, body, req.user.email);
  }

  @Post(":id/config-versions/:versionId/eval-run")
  @HttpCode(200)
  evalRun(
    @Param("id") id: string,
    @Param("versionId") versionId: string,
  ): Promise<AgentConfigVersion> {
    return this.agentsService.evalRun(id, versionId);
  }

  @Post(":id/config-versions/:versionId/publish")
  @HttpCode(200)
  publish(
    @Param("id") id: string,
    @Param("versionId") versionId: string,
    @Req() req: AuthedRequest,
  ): Promise<AgentConfigVersion> {
    return this.agentsService.publish(id, versionId, req.user.email);
  }

  @Post(":id/config-versions/:versionId/rollback")
  @HttpCode(200)
  rollback(
    @Param("id") id: string,
    @Param("versionId") versionId: string,
    @Req() req: AuthedRequest,
  ): Promise<AgentConfigVersion> {
    return this.agentsService.rollback(id, versionId, req.user.email);
  }
}
```

- [ ] **Step 2: 重写 module**

```ts
import { Module } from "@nestjs/common";
import { AgentsController } from "./agents.controller";
import { AgentsRepository } from "./agents.repository";
import { AgentsService } from "./agents.service";
import { ModelsModule } from "../models/models.module";
import { PromptsModule } from "../prompts/prompts.module";
import { KnowledgeBasesModule } from "../knowledge-bases/knowledge-bases.module";

// 依赖装配：ModelsModule 导出 ModelsService（type/enabled 校验）；
// PromptsModule 导出 PromptsService（getVersionMeta 校验 node 归属）；
// KnowledgeBasesModule 导出 KnowledgeBasesRepository（embedding 一致性批量查）。
@Module({
  imports: [ModelsModule, PromptsModule, KnowledgeBasesModule],
  controllers: [AgentsController],
  providers: [AgentsRepository, AgentsService],
  exports: [AgentsService],
})
export class AgentsModule {}
```

- [ ] **Step 3: 全量构建确认无编译错误**

Run: `pnpm --filter @codecrush/backend build`
Expected: 编译通过。若报 `KnowledgeBasesModule`/`PromptsModule` 循环 import（两者都不依赖 agents，理论上不会成环，但需要实跑验证），按错误信息调整。

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/modules/agents/agents.controller.ts apps/backend/src/modules/agents/agents.module.ts
git commit -m "feat(backend): AgentsController + module 接线真实端点"
```

---

### Task 7: e2e 测试重写 — `apps/backend/test/skeleton.e2e.spec.ts`

**Files:**
- Modify: `apps/backend/test/skeleton.e2e.spec.ts`

- [ ] **Step 1: 新增 `inMemoryAgentsRepo`**

在文件里其他 `inMemoryXxxRepo` 定义附近（参照 `inMemoryPromptsRepo` 的位置和风格，约在原 95-200 行区域）新增：

```ts
import type { AgentRow, AgentConfigVersionRow, NewAgent, NewAgentConfigVersion } from "../src/modules/agents/schema";
import type { AgentListRow } from "../src/modules/agents/agents.repository";

const inMemoryAgents: AgentRow[] = [];
const inMemoryAgentVersions: AgentConfigVersionRow[] = [];
const inMemoryAgentVersionKbs: Array<{ versionId: string; kbId: string }> = [];

function toAgentListRow(a: AgentRow): AgentListRow {
  const cur = a.currentVersionId
    ? inMemoryAgentVersions.find((v) => v.id === a.currentVersionId)
    : undefined;
  return { ...a, currentVersionNumber: cur?.version ?? null, currentVersionStatus: cur?.status ?? null };
}

const inMemoryAgentsRepo = {
  findAgents: async () => inMemoryAgents.map(toAgentListRow),
  findAgentById: async (id: string) => {
    const a = inMemoryAgents.find((x) => x.id === id);
    return a ? toAgentListRow(a) : undefined;
  },
  findAgentByName: async (name: string) => inMemoryAgents.find((x) => x.name === name),
  findVersionById: async (id: string) => inMemoryAgentVersions.find((v) => v.id === id),
  findVersions: async (agentId: string) =>
    inMemoryAgentVersions.filter((v) => v.agentId === agentId),
  findVersionKbIds: async (versionId: string) =>
    inMemoryAgentVersionKbs.filter((k) => k.versionId === versionId).map((k) => k.kbId),
  createAgentWithV1: async (
    agentRow: NewAgent,
    versionRow: Omit<NewAgentConfigVersion, "agentId">,
    kbIds: string[],
  ) => {
    const agent: AgentRow = {
      id: `agent${inMemoryAgents.length + 1}`,
      name: agentRow.name!,
      desc: agentRow.desc ?? "",
      enabled: agentRow.enabled ?? true,
      currentVersionId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      updatedBy: agentRow.updatedBy!,
    };
    inMemoryAgents.push(agent);
    const version: AgentConfigVersionRow = {
      ...(versionRow as AgentConfigVersionRow),
      id: `av${inMemoryAgentVersions.length + 1}`,
      agentId: agent.id,
    };
    inMemoryAgentVersions.push(version);
    kbIds.forEach((kbId) => inMemoryAgentVersionKbs.push({ versionId: version.id, kbId }));
    agent.currentVersionId = version.id;
    return { agent, version };
  },
  insertDraftVersion: async (versionRow: NewAgentConfigVersion, kbIds: string[]) => {
    const version: AgentConfigVersionRow = {
      ...(versionRow as AgentConfigVersionRow),
      id: `av${inMemoryAgentVersions.length + 1}`,
    };
    inMemoryAgentVersions.push(version);
    kbIds.forEach((kbId) => inMemoryAgentVersionKbs.push({ versionId: version.id, kbId }));
    return version;
  },
  updateVersionEval: async (versionId: string, patch: Partial<AgentConfigVersionRow>) => {
    const v = inMemoryAgentVersions.find((x) => x.id === versionId)!;
    Object.assign(v, patch);
    return v;
  },
  updateAgentBase: async (id: string, patch: Partial<AgentRow>) => {
    const a = inMemoryAgents.find((x) => x.id === id);
    if (!a) return undefined;
    Object.assign(a, patch, { updatedAt: new Date() });
    return a;
  },
  promote: async (agentId: string, versionId: string, actorEmail: string) => {
    inMemoryAgentVersions
      .filter((v) => v.agentId === agentId && v.status === "published")
      .forEach((v) => (v.status = "archived"));
    const target = inMemoryAgentVersions.find((v) => v.id === versionId)!;
    target.status = "published";
    target.publishedBy = actorEmail;
    target.publishedAt = new Date();
    const agent = inMemoryAgents.find((a) => a.id === agentId)!;
    agent.currentVersionId = versionId;
    agent.updatedBy = actorEmail;
    agent.updatedAt = new Date();
    return target;
  },
};
```

- [ ] **Step 2: 在 `beforeAll` 的 testing module 装配里加入 override**

在 356-397 行的 `.overrideProvider(ChunksRepository).useValue(inMemoryChunksRepo)` 之后追加：

```ts
.overrideProvider(AgentsRepository)
.useValue(inMemoryAgentsRepo)
```

顶部 import 增加：`import { AgentsRepository } from "../src/modules/agents/agents.repository";`

- [ ] **Step 3: 重写 879-909 行的 `describe("agents", ...)` 块**

删除 `validCreateAgent` 常量（78-93 行）与旧 describe 内容，替换为：

```ts
describe("agents (M7 真实 CRUD + 版本化 + Eval stub)", () => {
  let agentModelId: string;
  let agentKbId: string;
  let promptVerIds: Record<"rewrite" | "intent" | "reply" | "fallback", string>;

  const nodeConfig = {
    freedom: "balance" as const,
    temperatureEnabled: true,
    temperature: 0.5,
    topPEnabled: false,
    topP: 0.9,
  };
  const validCreateAgent = () => ({
    name: `助手-${Date.now()}`,
    desc: "e2e",
    kbIds: [agentKbId],
    genModelId: agentModelId,
    promptRewriteVerId: promptVerIds.rewrite,
    promptIntentVerId: promptVerIds.intent,
    promptReplyVerId: promptVerIds.reply,
    promptFallbackVerId: promptVerIds.fallback,
    nodeParams: { rewrite: nodeConfig, intent: nodeConfig, reply: nodeConfig, fallback: nodeConfig },
    topK: 10,
    topN: 3,
    threshold: 0.25,
    multiRecall: false,
    fallbackHuman: false,
  });

  beforeAll(async () => {
    await ensureEmbeddingModel();
    const modelRes = await request(app.getHttpServer())
      .post("/api/models")
      .set(auth())
      .send({
        type: "llm",
        protocol: "openai_compat",
        name: "agent-e2e-llm",
        baseUrl: "https://api.example.com/v1",
        apiKey: "sk-agente2e12345",
      })
      .expect(201);
    agentModelId = modelRes.body.id;

    const kbRes = await request(app.getHttpServer())
      .post("/api/knowledge-bases")
      .set(auth())
      .send({ name: `agent-e2e-kb-${Date.now()}`, desc: "", chunkTemplate: "general", embeddingModelId })
      .expect(201);
    agentKbId = kbRes.body.id;

    const nodes = ["rewrite", "intent", "reply", "fallback"] as const;
    const ids: Partial<Record<(typeof nodes)[number], string>> = {};
    for (const node of nodes) {
      const pRes = await request(app.getHttpServer())
        .post("/api/prompts")
        .set(auth())
        .send({ name: `agent-e2e-${node}`, node, body: "内容 {x}" })
        .expect(201);
      const versions = await request(app.getHttpServer())
        .get(`/api/prompts/${pRes.body.id}/versions`)
        .set(auth())
        .expect(200);
      ids[node] = versions.body[0].id;
    }
    promptVerIds = ids as Record<(typeof nodes)[number], string>;
  });

  it("GET / → 200 + schema", async () => {
    const res = await request(app.getHttpServer()).get("/api/agents").set(auth()).expect(200);
    for (const a of res.body) expect(() => AgentSchema.parse(a)).not.toThrow();
  });

  it("POST / 合法 → 201，v1 eval_status=exempt，status=active", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/agents")
      .set(auth())
      .send(validCreateAgent())
      .expect(201);
    expect(() => AgentSchema.parse(res.body)).not.toThrow();
    expect(res.body.status).toBe("active");
    expect(res.body.currentVersion.evalStatus).toBe("exempt");
  });

  it("POST / kbIds 指向不同 embedding 模型的知识库 → 400", async () => {
    // 复用 ensureEmbeddingModel 的模型建一个第二个 embedding 模型 + 第二个 kb，制造冲突
    const embed2 = await request(app.getHttpServer())
      .post("/api/models")
      .set(auth())
      .send({
        type: "embedding",
        protocol: "openai_compat",
        name: "agent-e2e-embed2",
        baseUrl: "https://api.example.com/v1",
        apiKey: "sk-embed2test123",
      })
      .expect(201);
    const kb2 = await request(app.getHttpServer())
      .post("/api/knowledge-bases")
      .set(auth())
      .send({ name: `agent-e2e-kb2-${Date.now()}`, desc: "", chunkTemplate: "general", embeddingModelId: embed2.body.id })
      .expect(201);
    await request(app.getHttpServer())
      .post("/api/agents")
      .set(auth())
      .send({ ...validCreateAgent(), kbIds: [agentKbId, kb2.body.id] })
      .expect(400);
  });

  it("POST / 非法 body（threshold 越界）→ 400（ZodValidationPipe）", async () => {
    await request(app.getHttpServer())
      .post("/api/agents")
      .set(auth())
      .send({ ...validCreateAgent(), threshold: 5 })
      .expect(400);
  });

  it("PATCH 携带非 name/desc/enabled 字段 → 400（strictObject）", async () => {
    const created = await request(app.getHttpServer())
      .post("/api/agents")
      .set(auth())
      .send(validCreateAgent())
      .expect(201);
    await request(app.getHttpServer())
      .patch(`/api/agents/${created.body.id}`)
      .set(auth())
      .send({ topK: 99 })
      .expect(400);
  });

  it("PATCH name → 200", async () => {
    const created = await request(app.getHttpServer())
      .post("/api/agents")
      .set(auth())
      .send(validCreateAgent())
      .expect(201);
    const res = await request(app.getHttpServer())
      .patch(`/api/agents/${created.body.id}`)
      .set(auth())
      .send({ name: "改名后" })
      .expect(200);
    expect(res.body.name).toBe("改名后");
  });

  it("新建配置版本 → eval_status=not_run；发布前 409；eval-run 后可发布；rollback 校验", async () => {
    const created = await request(app.getHttpServer())
      .post("/api/agents")
      .set(auth())
      .send(validCreateAgent())
      .expect(201);
    const agentId = created.body.id;

    const draft = await request(app.getHttpServer())
      .post(`/api/agents/${agentId}/config-versions`)
      .set(auth())
      .send({ ...validCreateAgent(), topK: 30, note: "调大召回" })
      .expect(201);
    expect(draft.body.evalStatus).toBe("not_run");

    await request(app.getHttpServer())
      .post(`/api/agents/${agentId}/config-versions/${draft.body.id}/publish`)
      .set(auth())
      .expect(409);

    await request(app.getHttpServer())
      .post(`/api/agents/${agentId}/config-versions/${draft.body.id}/eval-run`)
      .set(auth())
      .expect(200)
      .then((res) => {
        expect(res.body.evalStatus).toBe("passed");
        expect(res.body.evalPassRate).toBeNull();
      });

    await request(app.getHttpServer())
      .post(`/api/agents/${agentId}/config-versions/${draft.body.id}/publish`)
      .set(auth())
      .expect(200);

    // v1（此时已 archived）尚未 archived 前不能回滚；发布后 v1 转 archived，可回滚
    const versions = await request(app.getHttpServer())
      .get(`/api/agents/${agentId}/config-versions`)
      .set(auth())
      .expect(200);
    const v1 = versions.body.find((v: { version: number }) => v.version === 1);
    expect(v1.status).toBe("archived");

    await request(app.getHttpServer())
      .post(`/api/agents/${agentId}/config-versions/${v1.id}/rollback`)
      .set(auth())
      .expect(200);
  });

  it("引用不存在的 prompt version → 404", async () => {
    await request(app.getHttpServer())
      .post("/api/agents")
      .set(auth())
      .send({ ...validCreateAgent(), promptRewriteVerId: "nope" })
      .expect(404);
  });

  it("prompt version node 不匹配（用 intent 版本填 rewrite 字段）→ 400", async () => {
    await request(app.getHttpServer())
      .post("/api/agents")
      .set(auth())
      .send({ ...validCreateAgent(), promptRewriteVerId: promptVerIds.intent })
      .expect(400);
  });
});
```

- [ ] **Step 4: 跑 e2e**

Run: `pnpm --filter @codecrush/backend test -- skeleton.e2e.spec`
Expected: PASS 全部（含既有的 models/knowledge-bases/documents/chunks/retrieval/prompts 用例不回归）。

- [ ] **Step 5: Commit**

```bash
git add apps/backend/test/skeleton.e2e.spec.ts
git commit -m "test(backend): 重写 skeleton e2e agents 块 — 真实 CRUD/版本化/Eval stub/发布回滚"
```

---

### Task 8: 前端 API client — `apps/frontend/src/api/client.ts`

**Files:**
- Modify: `apps/frontend/src/api/client.ts`

- [ ] **Step 1: 更新顶部 import**（替换 `AgentListResponseSchema, AgentSchema` 为新增的类型，参照现有 prompts 部分的 import 风格）

```ts
// 替换原有 Agent 相关 import 为：
AgentListResponseSchema,
AgentSchema,
type Agent,
type AgentListResponse,
CreateAgentRequestSchema,
type CreateAgentRequest,
UpdateAgentRequestSchema,
type UpdateAgentRequest,
CreateAgentConfigVersionRequestSchema,
type CreateAgentConfigVersionRequest,
AgentConfigVersionListResponseSchema,
type AgentConfigVersionListResponse,
AgentConfigVersionSchema,
type AgentConfigVersion,
```

- [ ] **Step 2: 重写 141-145 行附近的 agents 函数区块，新增写操作**

```ts
// agents — @Controller("agents")
export const getAgents = (): Promise<AgentListResponse> =>
  getJson("/api/agents", AgentListResponseSchema);
export const getAgent = (id: string): Promise<Agent> =>
  getJson(`/api/agents/${encodeURIComponent(id)}`, AgentSchema);
export const createAgent = (req: CreateAgentRequest): Promise<Agent> =>
  postJson("/api/agents", req, CreateAgentRequestSchema, AgentSchema);
export async function updateAgent(id: string, req: UpdateAgentRequest): Promise<Agent> {
  const resp = await apiFetch(`/api/agents/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(UpdateAgentRequestSchema.parse(req)),
  });
  if (!resp.ok) throw new Error(`update agent failed: ${resp.status} ${resp.statusText}`);
  return AgentSchema.parse(await resp.json());
}
export const getAgentConfigVersions = (agentId: string): Promise<AgentConfigVersionListResponse> =>
  getJson(
    `/api/agents/${encodeURIComponent(agentId)}/config-versions`,
    AgentConfigVersionListResponseSchema,
  );
export const createAgentConfigVersion = (
  agentId: string,
  req: CreateAgentConfigVersionRequest,
): Promise<AgentConfigVersion> =>
  postJson(
    `/api/agents/${encodeURIComponent(agentId)}/config-versions`,
    req,
    CreateAgentConfigVersionRequestSchema,
    AgentConfigVersionSchema,
  );
export async function runAgentConfigVersionEval(
  agentId: string,
  versionId: string,
): Promise<AgentConfigVersion> {
  const resp = await apiFetch(
    `/api/agents/${encodeURIComponent(agentId)}/config-versions/${encodeURIComponent(versionId)}/eval-run`,
    { method: "POST" },
  );
  if (!resp.ok) throw new Error(`eval-run failed: ${resp.status}`);
  return AgentConfigVersionSchema.parse(await resp.json());
}
export async function publishAgentConfigVersion(
  agentId: string,
  versionId: string,
): Promise<AgentConfigVersion> {
  const resp = await apiFetch(
    `/api/agents/${encodeURIComponent(agentId)}/config-versions/${encodeURIComponent(versionId)}/publish`,
    { method: "POST" },
  );
  if (!resp.ok) throw new Error(`publish failed: ${resp.status}`);
  return AgentConfigVersionSchema.parse(await resp.json());
}
export async function rollbackAgentConfigVersion(
  agentId: string,
  versionId: string,
): Promise<AgentConfigVersion> {
  const resp = await apiFetch(
    `/api/agents/${encodeURIComponent(agentId)}/config-versions/${encodeURIComponent(versionId)}/rollback`,
    { method: "POST" },
  );
  if (!resp.ok) throw new Error(`rollback failed: ${resp.status}`);
  return AgentConfigVersionSchema.parse(await resp.json());
}
```

- [ ] **Step 3: 类型检查**

Run: `pnpm --filter @codecrush/frontend build`
Expected: 编译通过（`AgentsPage.tsx`/`mocks/agents.ts` 尚未改，会有类型错误——这是预期的，留给 Task 9/10 处理；此步只确认 `client.ts` 本身无语法/类型错误，若整体构建因下游文件报错属正常，用 `pnpm --filter @codecrush/frontend exec tsc --noEmit apps/frontend/src/api/client.ts` 或直接推进到 Task 9 一并验证也可）。

- [ ] **Step 4: Commit**

```bash
git add apps/frontend/src/api/client.ts
git commit -m "feat(frontend): agents API client 接真实端点（含配置版本/eval/发布/回滚）"
```

---

### Task 9: 前端 AgentsPage 重写为 antd（对齐 PromptsPage 模式）

**Files:**
- Modify: `apps/frontend/src/pages/admin/AgentsPage.tsx`（整页重写）
- Modify: `apps/frontend/src/mocks/agents.ts`（精简为纯展示常量）

- [ ] **Step 1: 精简 `mocks/agents.ts`**，只保留跟真实数据无关的展示常量（色板/标签映射），删除 `AGENT_ROWS`/`DF_DEFAULT`/`ALL_KBS`/`GEN_MODELS` 等会被真实 API 数据替代的部分：

```ts
/** Agent 管理页展示常量（真实数据经 api/client.ts 获取，见 AgentsPage.tsx）。 */
export type TagKey = "green" | "blue" | "gold" | "red" | "gray" | "purple" | "cyan";

export const TAGS: Record<TagKey, { bg: string; c: string; bd: string }> = {
  green: { bg: "#f6ffed", c: "#52c41a", bd: "#b7eb8f" },
  blue: { bg: "#e6f4ff", c: "#1677ff", bd: "#91caff" },
  gold: { bg: "#fffbe6", c: "#d48806", bd: "#ffe58f" },
  red: { bg: "#fff2f0", c: "#ff4d4f", bd: "#ffccc7" },
  gray: { bg: "#fafafa", c: "rgba(0,0,0,.45)", bd: "#d9d9d9" },
  purple: { bg: "#f9f0ff", c: "#722ed1", bd: "#d3adf7" },
  cyan: { bg: "#e6fffb", c: "#08979c", bd: "#87e8de" },
};

export function tagOf(name: TagKey) {
  return TAGS[name] || TAGS.gray;
}

export const STATUS_TAG: Record<"draft" | "active" | "archived", { label: string; tag: TagKey }> = {
  draft: { label: "草稿", tag: "purple" },
  active: { label: "已上线", tag: "green" },
  archived: { label: "已下线", tag: "gray" },
};

export const EVAL_STATUS_LABEL: Record<"not_run" | "passed" | "exempt", string> = {
  not_run: "未跑 Eval",
  passed: "已通过（人工/占位）",
  exempt: "豁免（首个版本）",
};
```

- [ ] **Step 2: 重写 `AgentsPage.tsx`** — 结构对齐 `PromptsPage.tsx`（已读全文，作为直接模板）：

顶层结构：
- 用 `useState`/`useEffect` 拉取 `getAgents()` 填充 `Table`，`loading`/`listErr` 状态管理模式照抄 `PromptsPage.tsx:86-131`。
- `Table` 列：Agent（头像色块首字+名称+简介，参照原型头像渲染逻辑，色块用 `TAGS` 里挑一个固定映射或按名称 hash 取色）、绑定知识库（`currentVersion.kbIds` 需要转成知识库名——调用 `getKnowledgeBases()` 一次性拉全量建 id→name 的 Map，参照 `KnowledgeBasesPage.tsx` 是否已有类似查询可复用；没有则自行 `useEffect` 拉一次）、生成模型（同理需要 `getModels()` 建 id→name Map）、状态（`STATUS_TAG[row.status]` 渲染 `Tag`）、更新时间、操作列（编辑/配置版本/日志三个 `Button type="link"`）。
- 「日志」按钮：`onClick={() => navigate(`/admin/traces?agentId=${row.id}`)}`（用 `react-router-dom` 的 `useNavigate`，检查项目里其他页面是否已用这个 hook，参照其 import 方式）。
- 「新建 Agent」`Drawer`（`size={480}` 对齐产品文档"右侧抽屉 480px"）：五区块表单——
  1. 基础信息：`Input` name（必填）+ `Input` desc。
  2. 绑定知识库：`getKnowledgeBases()` 拉全量，渲染成 chips（复用原型的选中/冲突红色警示态交互——**选中态**蓝色边框+浅蓝底；**冲突态**（与已选第一个知识库 embeddingModelId 不同）红色边框 `#ffccc7` + 浅红底 `#fff2f0` + 红字 `#ff7875`，点击冲突项不加入选中列表且在抽屉底部 `Alert type="error"` 提示，文案对齐 008 文档「错误文案」；这段前端交互逻辑不经后端校验预演，纯前端算好看即可，真正拦截在后端 400——前端只是体验层）。
  3. 模型设置：`Select` 生成模型/改写-意图模型/重排模型，选项来自 `getModels()` 按 `type` 过滤（`genModel`/`lightModel` 用 `type==='llm'`，`rerankModel` 用 `type==='rerank'`，都只显示 `enabled===true` 的）。
  4. Prompt 配置：4 个 `Select`（问题改写/意图识别/回复生成/兜底话术），选项来自 `getPrompts({page:1, pageSize:100, node:'rewrite'|...})` 按对应 node 过滤，`Select` value 存的是 `promptVersionId`——需要先选 Prompt 再选版本，或简化为直接选"当前生产版本"（`prompt.currentVersionId`，若为 null 则该 Prompt 不可选，因为没有版本可引用）。**这是一个需要在实现时做的简化判断**：产品原型是两级下拉（先选 Prompt 名称，隐含用其最新/当前版本），本次先支持「选 Prompt → 自动带出其 `currentVersionId`（若为 null 则该 Prompt 置灰不可选，并提示"该 Prompt 尚无已发布版本"）」，不做独立的"版本选择器"（008 设计文档没有要求这么细，避免过度设计）。同时渲染 `NodeConfigSchema` 的自由度/温度/TopP（4 组，UI 可以先给自由度下拉 + 一组温度/TopP 滑杆，`temperatureEnabled`/`topPEnabled` 用 `Switch` 控制启用态，禁用时置灰滑杆）。
  5. 检索设置：`InputNumber` topK/topN，`Slider` threshold（0-1，step 0.01），`Switch` multiRecall，启用时展示 `Slider` vecWeight，`Switch` fallbackHuman。
  - 底部：取消 / 创建 Agent，校验失败（缺 name / 空 kbIds）在抽屉底部展示 `Alert type="error"`，成功后 `createAgent(req)` → 关闭抽屉 → 刷新列表。
- 「编辑」`Drawer`（复用同一个 480px 抽屉容器，但内容收窄）：只渲染 name/desc 两个 `Input` + enabled `Switch`，其余信息只读展示（当前生产版本的模型/Prompt/检索参数以纯文本摘要展示，不可编辑），底部一行提示「如需调整模型/Prompt/检索参数，请通过下方「配置版本」新建版本」+ 一个跳转到「配置版本」抽屉的 `Button type="link"`（对齐 spec.md「Changes by File」里已定案的收窄方案）。
- 「配置版本」`Drawer`（`size={760}`，结构照抄 `PromptsPage.tsx:784-1000` 的左右两栏布局：左栏版本历史列表 + 右栏详情）：
  - 左栏：`getAgentConfigVersions(agentId)` 拉全部版本，倒序展示，每项显示版本号/`status` Tag/`evalStatus` Tag（用 `EVAL_STATUS_LABEL`）/`note`/`createdBy`+时间，点击选中。
  - 右栏：选中版本的完整配置摘要（知识库/模型/4个Prompt/检索参数只读展示）+ 操作区：
    - `status==='draft'` 且 `evalStatus==='not_run'`：显示「跑 Eval」`Button`，`onClick` 调 `runAgentConfigVersionEval`，成功后刷新该版本详情（`evalStatus` 变 `passed`）。
    - `status==='draft'` 且 `evalStatus∈{passed,exempt}`：显示「通过并发布」`Button type="primary"`，包一层 `Popconfirm`（对齐 PromptsPage 发布确认交互），`onClick` 调 `publishAgentConfigVersion`。
    - `status==='archived'`：显示「回滚到此版本」`Button`，`Popconfirm` 确认，`onClick` 调 `rollbackAgentConfigVersion`。
    - `status==='published'`：不显示操作按钮（当前生产版本）。
  - 顶部有一个「＋ 新建配置版本」`Button`，打开与「新建 Agent」抽屉五区块内容一致的表单（可预填当前生产版本的值作为起点），提交调 `createAgentConfigVersion`。

- [ ] **Step 2b: 关键代码片段 — 知识库冲突态 chips（前端体验层，非安全边界）**

```tsx
function KbChips({
  kbs, selected, onToggle,
}: {
  kbs: KnowledgeBase[];
  selected: string[];
  onToggle: (id: string) => void;
}) {
  const baseEmbed = selected.length > 0
    ? kbs.find(k => k.id === selected[0])?.embeddingModelId
    : null;
  const [conflictMsg, setConflictMsg] = useState("");
  return (
    <>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {kbs.map(k => {
          const on = selected.includes(k.id);
          const conflict = !on && baseEmbed !== null && k.embeddingModelId !== baseEmbed;
          return (
            <Tag
              key={k.id}
              onClick={() => {
                if (conflict) {
                  setConflictMsg(`「${k.name}」与已选知识库的向量模型不一致，无法同时绑定`);
                  return;
                }
                setConflictMsg("");
                onToggle(k.id);
              }}
              color={on ? "blue" : conflict ? "error" : undefined}
              style={{ cursor: "pointer", userSelect: "none", padding: "4px 10px" }}
            >
              {k.name}
            </Tag>
          );
        })}
      </div>
      {conflictMsg && <Alert type="error" showIcon message={conflictMsg} style={{ marginTop: 8 }} />}
    </>
  );
}
```

- [ ] **Step 3: preview 验证（人工，非自动化）**

启动前端 dev server（`preview_start` 或已有 launch 配置），访问 Agent 管理页：
1. 列表正确显示（若数据库为空，先用「新建 Agent」走一遍全流程）。
2. 新建 Agent：选知识库（含制造一次 embedding 冲突验证红色警示态）、选模型、选 4 个 Prompt、设检索参数、提交成功。
3. 打开「配置版本」抽屉，新建一个草稿版本、点「跑 Eval」、点「通过并发布」，确认版本历史正确显示旧版本转「已归档」。
4. 对已归档版本点「回滚到此版本」，确认成功。
5. 「编辑」抽屉确认只能改 name/desc/enabled。
6. 用 `preview_console_logs`/`preview_network` 确认无报错、无 4xx（除测试冲突态那次故意的 400）。

- [ ] **Step 4: Commit**

```bash
git add apps/frontend/src/pages/admin/AgentsPage.tsx apps/frontend/src/mocks/agents.ts
git commit -m "feat(frontend): AgentsPage 改用 antd 接真实 API — 列表/新建/编辑/配置版本抽屉"
```

---

### Task 10: 收尾 — 全量 lint/test + 一次性 review（轻量对抗档收尾方式）

**Files:** 无新增，全量校验。

- [ ] **Step 1: 全量测试**

Run: `pnpm test`
Expected: 全绿，含 Task 1-9 新增/修改的全部测试文件。

- [ ] **Step 2: 全量 lint（含依赖边界规则）**

Run: `pnpm lint`
Expected: 0 错误，特别确认 `agents` 模块没有违反依赖边界（不直接 import 其他域的 `adapters/`，只经 barrel 导出的 service/repository）。

- [ ] **Step 3: 全量构建**

Run: `pnpm build`
Expected: `packages/contracts`、`apps/backend`、`apps/frontend` 全部编译通过。

- [ ] **Step 4: 触发一次性全量 diff review**

按 CLAUDE.md「轻量对抗」dev 阶段约定：不做逐 story 审，此处收尾跑一次 `/code-review` 覆盖本任务全部 diff（`git diff main...HEAD` 范围），重点检查：Eval 门槛校验是否在 publish 与 create 两条路径都生效、知识库一致性校验是否为顺序无关的集合判断、`agent_config_versions` 业务字段是否真正不可变（没有暴露 UPDATE 业务字段的端点）。

- [ ] **Step 5: 更新 `docs/design/008-m7-agent-management.md` 的 Status**

实现落地并对照代码校验通过后，把文档 frontmatter 的 `status: draft` 推进为 `status: current`，`last_modified` 更新为实现完成当天日期，Status 章节补一句"实现已完成，对照代码校验通过（日期）"。

- [ ] **Step 6: Commit**

```bash
git add docs/design/008-m7-agent-management.md
git commit -m "docs(design): M7 Agent 管理设计文档推进为 current（实现校验通过）"
```
