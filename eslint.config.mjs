import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      // 019：worker dev watch 的独立编译产物（apps/backend/tsconfig.worker.json 的 outDir）——
      // 与 dist 同性质，是产物不是源码；`**/dist/**` 匹配不到它，必须单列。
      "**/dist-worker/**",
      "**/node_modules/**",
      "**/.turbo/**",
      "apps/backend/drizzle/**",
      "**/*.config.*",
      // 前端 UI 原型参考目录（非源码，仅供页面还原参考，见 AGENTS.md「原型参考」）
      "RAG知识库问答系统设计/**",
      // Ship 工作流过程产物（spec/plan/ledger/QA 脚本等，gitignored，非源码）
      ".ship/**",
      // Ship/Claude 临时 git worktree（gitignored；各含独立 tsconfig，会打断
      // typescript-eslint 的 tsconfigRootDir 自动探测——扫进去会导致全仓 Parsing error）
      ".claude/**",
    ],
  },
  // 让 ESLint flat config 处理 .ts/.tsx（默认只处理 .js/.mjs/.cjs）
  { files: ["**/*.{ts,tsx}"] },
  ...tseslint.configs.recommended,
  // 允许 `_` 前缀显式标注「已知未用」（stub/占位签名常见，如 M2 skeleton service 忽略入参）
  // 放在 recommended 之后以覆盖其默认无 pattern 的配置；边界规则（no-restricted-imports）不受影响
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
  // Boundary ①：frontend 只能 import @codecrush/contracts 与 @codecrush/otel-conventions（纯常量）
  {
    files: ["apps/frontend/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@codecrush/backend", "@codecrush/backend/*"],
              message: "frontend 只能用 @codecrush/contracts / @codecrush/otel-conventions，不得 import backend",
            },
            {
              group: ["@codecrush/otel", "@codecrush/otel/*"],
              message:
                "@codecrush/otel 是 Node-only SDK，前端打包会炸；前端只用 @codecrush/otel-conventions（纯常量）",
            },
          ],
        },
      ],
    },
  },
  // Boundary ②：contracts 是地基，只依赖 zod（不得依赖 app / OTel）
  {
    files: ["packages/contracts/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@codecrush/backend", "@codecrush/frontend"],
              message: "contracts 是地基，不得依赖 apps",
            },
            {
              group: ["@opentelemetry/*"],
              message: "contracts 只放 API DTO；OTLP 属性常量归 @codecrush/otel-conventions",
            },
          ],
        },
      ],
    },
  },
  // Boundary ③：otel-conventions 是纯常量地基，零运行时依赖（前后端 + VIEW 共用）
  {
    files: ["packages/otel-conventions/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@opentelemetry/*"],
              message:
                "otel-conventions 是纯常量地基，禁 OTel SDK 运行时依赖（否则前端打包炸）；发射逻辑归 @codecrush/otel",
            },
            {
              group: ["@codecrush/*"],
              message: "otel-conventions 是最底层，不得依赖其它 workspace 包",
            },
            {
              group: ["node:*"],
              message: "otel-conventions 禁 Node 内建模块，保持纯净可供前端使用",
            },
          ],
        },
      ],
    },
  },
  // Boundary ④：@codecrush/otel 只管 trace 语义/OTLP 发射，不碰物理存储与 API 契约
  {
    files: ["packages/otel/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@codecrush/contracts", "@codecrush/contracts/*"],
              message:
                "@codecrush/otel 不得依赖 API 契约；DTO 转换留在 backend traces 模块（SDK 只返回 SpanIdentity）",
            },
            {
              group: ["@clickhouse/client", "@clickhouse/client/*"],
              message: "@codecrush/otel 不碰物理存储；ClickHouse 归 infra + backend traces 模块",
            },
            {
              group: ["@codecrush/backend", "@codecrush/backend/*", "@codecrush/frontend"],
              message: "@codecrush/otel 是底层 SDK，不得依赖 apps",
            },
          ],
        },
      ],
    },
  },
  // Boundary ⑤：gaps 是依赖顶点（docs/design/021 决策 A）——它 import 别人，别人不 import 它。
  //
  // 为什么单独给这一条上机械门禁：`gaps → eval-runs`（进评测集要服务端批量建 gold 用例）已是既定边，
  // 于是任何 `eval-runs → gaps` 都直接成环。而最自然的写法恰恰会踩：屏3「加入问题池」按钮长在
  // eval-runs 的页面上，后端顺手调一下 gaps 就闭环了——所以 021 决策 B 规定它走前端组合。
  // 这条规则就是那个决策的执行者。
  //
  // 注意它**不是**通用模块 DAG 强制器：本仓没装 eslint-plugin-boundaries，其余依赖边靠
  // docs/design/003 的边表 + review 守（见 003「依赖规则的真实强制力」）。
  //
  // 作用范围是**整个 apps/backend/src**，不是只有 modules/：`gaps → platform/{clickhouse,persistence,queue}`
  // 是允许边，所以 `platform → gaps` 同样成环，而 platform 恰好不在 modules/ 下。
  //
  // 三处豁免，都是**聚合根**——按定义就要引用每一个模块，不是域代码在建依赖：
  //   ① gaps 域自身；
  //   ② `app.module.ts`：必须 import GapsModule 才能注册；
  //   ③ `db/schema.ts`：Drizzle 查询侧的类型聚合点，迁移流程（drizzle/README.md 第 3 步）
  //      明令新表要同步到这里。
  // 「任何文件都不许 import gaps」写成规则是**不可满足**的，这三处就是原因。
  {
    files: ["apps/backend/src/**/*.ts"],
    ignores: [
      "apps/backend/src/modules/gaps/**/*.ts",
      "apps/backend/src/app.module.ts",
      "apps/backend/src/db/schema.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              // 必须用 `**/gaps` + `**/gaps/**` 这种任意深度的写法。
              // 反例（本规则第一版就踩了）：`["../gaps", "../gaps/*", "**/modules/gaps/*"]`
              // 只拦得住深度恰为 1 的相对路径——`eval-runs/foo/bar.ts` 里写
              // `../../gaps/gaps.service` 会畅通无阻，而 `**/modules/gaps/*` 对相对路径
              // 根本不匹配（import 字符串里没有 "modules/" 这一段）。
              // 后端模块下有 16 个子目录，等于门禁对绝大多数文件失效。
              group: ["**/gaps", "**/gaps/**"],
              message:
                "gaps 是依赖顶点（docs/design/021 决策 A）：它 import 别人，别人不得 import 它——反向依赖会成环",
            },
          ],
        },
      ],
    },
  },
  prettier,
);
