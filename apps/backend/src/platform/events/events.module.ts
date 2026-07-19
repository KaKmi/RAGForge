import { Module } from "@nestjs/common";
import { DocumentChangeNotifier } from "./document-change.notifier";

/**
 * 平台事件模块。广播点要同时被 `documents`（单文档解析/删除）与 `ingestion`（整库重建）注入，
 * 而这两个模块之间已是 forwardRef 互引——本模块**零依赖**，谁 import 都不会成环。
 *
 * 刻意**不用 @Global**：本仓有多个测试自行拼装局部模块图
 * （`skeleton.e2e.spec.ts:918` 逐个列 imports），@Global 只在「该模块被图里某处 import 过」
 * 时才生效，于是局部图里会拿到一个 `Nest can't resolve dependencies` ——
 * 那正是这次改动第一版踩的坑。让消费方显式 import，任何拼装方式都成立。
 */
@Module({
  providers: [DocumentChangeNotifier],
  exports: [DocumentChangeNotifier],
})
export class EventsModule {}
