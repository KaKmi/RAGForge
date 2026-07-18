import { QUEUE_CONSUMER_ROLES } from "../src/platform/queue/queue.constants";

/**
 * AC 29：人工评测必须由 api 进程消费。
 * 若有人把它挪回 evaluation token（worker 角色），只起 api 的部署里任务永不被消费，
 * 前端一直「评分中」直到超时报「裁判调用失败」——一个查不出来的假错误。
 */
it("manualScore 队列登记为 api 角色", () => {
  expect(QUEUE_CONSUMER_ROLES.manualScore).toEqual(["api", "all"]);
});

it("evaluation 队列仍是 worker 角色（没被顺手改坏）", () => {
  expect(QUEUE_CONSUMER_ROLES.evaluation).toEqual(["worker", "all"]);
});
