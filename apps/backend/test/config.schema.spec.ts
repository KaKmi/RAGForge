import { envSchema } from "../src/platform/config/config.schema";

const base = {
  DATABASE_URL: "postgres://codecrush:codecrush@localhost:5432/codecrush",
};

describe("envSchema JWT fail-fast", () => {
  it("JWT_SECRET 缺失 → 校验失败", () => {
    expect(envSchema.safeParse(base).success).toBe(false);
  });

  it("JWT_SECRET 过短（<32）→ 校验失败", () => {
    expect(envSchema.safeParse({ ...base, JWT_SECRET: "short" }).success).toBe(false);
  });

  it("合法 JWT_SECRET → 通过且 JWT_EXPIRES_IN 默认 12h", () => {
    const r = envSchema.safeParse({
      ...base,
      JWT_SECRET: "dev-only-change-me-please-32-chars-min!!",
      MODEL_API_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.JWT_EXPIRES_IN).toBe("12h");
  });
});

describe("envSchema 模型密钥主密钥 fail-fast (M3)", () => {
  const withJwt = { ...base, JWT_SECRET: "dev-only-change-me-please-32-chars-min!!" };

  it("MODEL_API_KEY_ENCRYPTION_KEY 缺失 → 校验失败", () => {
    expect(envSchema.safeParse(withJwt).success).toBe(false);
  });

  it("过短（<44 字符）→ 校验失败", () => {
    expect(
      envSchema.safeParse({ ...withJwt, MODEL_API_KEY_ENCRYPTION_KEY: "tooshort" }).success,
    ).toBe(false);
  });
});

describe("envSchema BlobStore/Ingestion 配置 (M4)", () => {
  const valid = {
    ...base,
    JWT_SECRET: "dev-only-change-me-please-32-chars-min!!",
    MODEL_API_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
  };

  it("BLOB_STORE_PATH 未设置时默认 ./.data/blobs", () => {
    const r = envSchema.safeParse(valid);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.BLOB_STORE_PATH).toBe("./.data/blobs");
  });

  it("INGESTION_EMBED_BATCH_SIZE 未设置时默认 10", () => {
    const r = envSchema.safeParse(valid);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.INGESTION_EMBED_BATCH_SIZE).toBe(10);
  });

  it("INGESTION_EMBED_BATCH_SIZE 非正数 → 校验失败", () => {
    expect(envSchema.safeParse({ ...valid, INGESTION_EMBED_BATCH_SIZE: "0" }).success).toBe(false);
  });
});

describe("envSchema 离线评测单用例超时 (E-W2a QA P1)", () => {
  const valid = {
    ...base,
    JWT_SECRET: "dev-only-change-me-please-32-chars-min!!",
    MODEL_API_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
  };

  // 默认必须 120s 而非在线熔断的 30s：实测 rewrite+intent 两次结构化调用即吃掉 27.7s，
  // 30s 下**每一条用例都超时**、整个离线评测出不来一个分（QA 4 次真实 run 全 timeout）。
  it("EVAL_RUN_CASE_TIMEOUT_MS 未设置时默认 120000（离线口径，非在线 30s）", () => {
    const r = envSchema.safeParse(valid);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.EVAL_RUN_CASE_TIMEOUT_MS).toBe(120_000);
  });

  it("EVAL_RUN_CASE_TIMEOUT_MS 可被 env 覆盖（字符串 → number）", () => {
    const r = envSchema.safeParse({ ...valid, EVAL_RUN_CASE_TIMEOUT_MS: "45000" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.EVAL_RUN_CASE_TIMEOUT_MS).toBe(45_000);
  });

  it("EVAL_RUN_CASE_TIMEOUT_MS 非正数 → 校验失败（0 会让每条用例立刻判超时）", () => {
    expect(envSchema.safeParse({ ...valid, EVAL_RUN_CASE_TIMEOUT_MS: "0" }).success).toBe(false);
  });
});

describe("envSchema 进程角色分流 (019)", () => {
  const valid = {
    ...base,
    JWT_SECRET: "dev-only-change-me-please-32-chars-min!!",
    MODEL_API_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
  };

  it("PROCESS_ROLE 未设置时默认 all（零变化默认）", () => {
    const r = envSchema.safeParse(valid);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.PROCESS_ROLE).toBe("all");
  });

  it("空串按未设置处理 → all（与 parseProcessRole 同一校验器，语义必然一致）", () => {
    const r = envSchema.safeParse({ ...valid, PROCESS_ROLE: "" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.PROCESS_ROLE).toBe("all");
  });

  it("worker 合法通过", () => {
    const r = envSchema.safeParse({ ...valid, PROCESS_ROLE: "worker" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.PROCESS_ROLE).toBe("worker");
  });

  it("非法值（含大小写错）→ 校验失败", () => {
    expect(envSchema.safeParse({ ...valid, PROCESS_ROLE: "API" }).success).toBe(false);
    expect(envSchema.safeParse({ ...valid, PROCESS_ROLE: "bogus" }).success).toBe(false);
  });
});
