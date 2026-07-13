// OTel 引导必须在任何被 instrument 的模块（http/express/pg）import 前生效——故置为首条 import。
// prod（node dist/main.js）与 dev（nest start）统一经此引导，dev 也能落 trace（不再靠外部 -r 预加载）。
import "./tracing";
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
