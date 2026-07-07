import { Global, Module } from "@nestjs/common";
import { AppConfigService } from "../config/config.service";
import { EncryptionService } from "./encryption";
import { ENCRYPTION } from "./security.constants";

// 平台安全模块：提供 ENCRYPTION token（对齐 PersistenceModule 的 @Global + Symbol token 范式）。
// 测试中可 overrideProvider(ENCRYPTION) 注入固定 key 实例。
@Global()
@Module({
  providers: [
    {
      provide: ENCRYPTION,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) =>
        new EncryptionService(config.modelApiKeyEncryptionKey),
    },
  ],
  exports: [ENCRYPTION],
})
export class SecurityModule {}
