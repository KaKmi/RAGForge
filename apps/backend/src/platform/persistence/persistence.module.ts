import { Global, Module } from "@nestjs/common";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { AppConfigService } from "../config/config.service";
import * as schema from "../../db/schema";
import { DRIZZLE } from "./drizzle.constants";

export type DB = NodePgDatabase<typeof schema>;

/**
 * 事务句柄。`db.transaction(async (tx) => …)` 里那个 `tx` 的类型。
 *
 * 具名导出而不是各文件重复写这段内联类型表达式（B2a 只有 `gaps.repository.ts` 一处私有方法
 * 用过它）：B2b 起有**跨域共享事务**的调用面——`GapPromoteService` 开一个顶层事务，
 * 把同一个 `tx` 交给 `EvalSetsRepository` 与 `GapsRepository` 两个不同域的方法一起用
 * （整批 case 创建 + `markEnteredEvalSet` 要么全成要么全滚）。签名散在多处时类型漂移不可控。
 */
export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];

@Global()
@Module({
  providers: [
    {
      provide: DRIZZLE,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService): DB => {
        const pool = new Pool({ connectionString: config.databaseUrl });
        return drizzle(pool, { schema });
      },
    },
  ],
  exports: [DRIZZLE],
})
export class PersistenceModule {}
