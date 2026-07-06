import { type INestApplication } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { cleanupOpenApiDoc } from "nestjs-zod";

/**
 * 全局前缀：所有路由统一切到 `/api/*`，`/health` 除外（保持健康检查路径稳定，方便探活与前端 getHealth）。
 *
 * 抽成函数供 main.ts 与 e2e 测试复用，确保前缀一致（破坏性变更影响所有端点路径）。
 */
export function applyGlobalConfig(app: INestApplication): void {
  app.setGlobalPrefix("api", { exclude: ["health"] });
}

/**
 * 挂载 Swagger UI 于 `/api/docs`，JSON 于 `/api/docs-json`。
 *
 * nestjs-zod 通过 `createZodDto` 在 `@nestjs/swagger` 的元数据探索里注入 zod→JSONSchema，
 * `cleanupOpenApiDoc` 做后处理（null/literal/nullable 等兼容 3.0/3.1）。UI 路由不在 Nest
 * 路由表内，全局 JwtAuthGuard 不会拦截。
 */
export function setupSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle("CodeCrush RAG API")
    .setDescription("通用 RAG 平台后端 API 契约（nestjs-zod + Zod 自动生成）")
    .setVersion("0.1.0")
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup("api/docs", app, cleanupOpenApiDoc(document));
}
