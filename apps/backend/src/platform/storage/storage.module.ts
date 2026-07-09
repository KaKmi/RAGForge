import { Global, Module } from "@nestjs/common";
import { AppConfigService } from "../config/config.service";
import { LocalFsBlobStore } from "./local-fs-blob-store.adapter";
import { BLOB_STORE } from "./blob-store.constants";

@Global()
@Module({
  providers: [
    {
      provide: BLOB_STORE,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => new LocalFsBlobStore(config.blobStorePath),
    },
  ],
  exports: [BLOB_STORE],
})
export class StorageModule {}
