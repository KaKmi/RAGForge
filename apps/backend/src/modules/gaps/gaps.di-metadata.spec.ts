import "reflect-metadata";
import { GapCollectorProcessor } from "./gap-collector.processor";
import { GapFillController } from "./gap-fill.controller";
import { GapFillService } from "./gap-fill.service";
import { GapPromoteController } from "./gap-promote.controller";
import { GapPromoteService } from "./gap-promote.service";
import { GapVerificationNotifier } from "./gap-verification.notifier";
import { GapVerificationService } from "./gap-verification.service";
import { GapsController } from "./gaps.controller";
import { GapsService } from "./gaps.service";

/**
 * 守一类**只在应用启动时才炸、且所有既有检查都看不见**的错误：
 * 构造参数的类型若写成 **接口 / 交叉类型 / 联合类型**，TypeScript 的 `emitDecoratorMetadata`
 * 会把它序列化成 `Object` ⇒ `design:paramtypes` 里没有可解析的 token ⇒ Nest 抛
 * 「can't resolve dependencies … at index [N]」。
 *
 * 为什么需要专门一条：
 *  · `tsc` 不报错——写接口类型在类型层面完全合法；
 *  · 单测发现不了——它们手工 `new`，绕过 DI；
 *  · e2e 也发现不了——它们用 `useValue` 注入现成实例，同样绕过构造函数解析；
 *  · 而 `AppModule` 整体的编译测试在本仓跑不起来（pg-boss v12 是纯 ESM，jest 加载不了）。
 *
 * B2a Task 5 的 peer review 正是抓出了这个：`GapCollectorProcessor` 的第 2 个参数曾写成
 * `GapCollectorStore & GapsRepository`，一旦 Task 6 把它注册进 `GapsModule`，启动即崩。
 *
 * 允许为 `Object` 的只有**显式 `@Inject(Symbol)`** 的位置（token 不来自类型）。
 */
const INJECTED_BY_TOKEN = {
  // GapCollectorProcessor 的第 0 个参数是 `@Inject(GAP_COLLECT_QUEUE)`。
  GapCollectorProcessor: [0],
  GapsService: [],
  GapsController: [],
  // GapPromoteService 的第 4 个参数是 `@Inject(DRIZZLE)`（跨域共享事务的顶层持有者）。
  GapPromoteService: [4],
  GapPromoteController: [],
  // B2b 新增的三个（都不用 token 注入，全部必须是可解析的具体类）。
  GapFillService: [],
  GapFillController: [],
  GapVerificationService: [],
  GapVerificationNotifier: [],
} as const;

describe("gaps 域的 DI 元数据（构造参数不得退化成 Object）", () => {
  it.each([
    ["GapCollectorProcessor", GapCollectorProcessor],
    ["GapsService", GapsService],
    ["GapsController", GapsController],
    ["GapPromoteService", GapPromoteService],
    ["GapPromoteController", GapPromoteController],
    ["GapFillService", GapFillService],
    ["GapFillController", GapFillController],
    ["GapVerificationService", GapVerificationService],
    ["GapVerificationNotifier", GapVerificationNotifier],
  ] as const)("%s 的每个构造参数都是可解析的具体类", (name, target) => {
    const paramTypes = (Reflect.getMetadata("design:paramtypes", target) ?? []) as Array<{
      name?: string;
    }>;
    expect(paramTypes.length).toBeGreaterThan(0);
    const allowed = INJECTED_BY_TOKEN[name] as readonly number[];
    paramTypes.forEach((type, index) => {
      if (allowed.includes(index)) return;
      expect({ index, type: type?.name }).toEqual({ index, type: expect.not.stringMatching(/^Object$/) });
    });
  });
});
