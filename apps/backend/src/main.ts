// M0.5 将改为经 `node -r ./dist/tracing.js dist/main.js` 预加载 OTel（此处预留）
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { applyGlobalConfig, setupSwagger } from "./app/app-bootstrap";
import { AppConfigService } from "./platform/config/config.service";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors(); // dev 放开；后续收紧
  applyGlobalConfig(app); // 全局 /api 前缀（/health 除外）
  setupSwagger(app); // /api/docs UI + /api/docs-json
  const config = app.get(AppConfigService);
  await app.listen(config.port);
  console.log(`backend listening on :${config.port}`);
}
void bootstrap();
