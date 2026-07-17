import { parseProcessRole, PROCESS_ROLES } from "../src/platform/config/process-role";

describe("parseProcessRole（019 Boundary 2：唯一解析点）", () => {
  it("未设置（键不存在）→ all（零变化默认，回滚路径）", () => {
    expect(parseProcessRole({})).toBe("all");
  });

  it("显式空串 → all（dotenv 里 `PROCESS_ROLE=` 占位行按未设置处理）", () => {
    expect(parseProcessRole({ PROCESS_ROLE: "" })).toBe("all");
  });

  it.each(PROCESS_ROLES)("合法值 %s 原样返回", (role) => {
    expect(parseProcessRole({ PROCESS_ROLE: role })).toBe(role);
  });

  it.each(["API", "Worker", "ALL", "bogus", " api"])(
    "非法值 %j → throw（大小写敏感、不 trim，fail-fast 在 tracing 启动之前）",
    (raw) => {
      expect(() => parseProcessRole({ PROCESS_ROLE: raw })).toThrow(raw.trim() || "PROCESS_ROLE");
    },
  );
});
