import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.turbo/**",
      "apps/backend/drizzle/**",
      "**/*.config.*",
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
  prettier,
);
