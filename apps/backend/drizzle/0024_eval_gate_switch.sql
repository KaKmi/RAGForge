-- B1/F5：应用级上线门禁开关。
-- 默认 false = 原型 §8「默认关(仅提示)」，且保证既有应用升级后发布行为零变化。
-- 开关只影响前端是否 disable「去上线」按钮；后端永远软放行（门禁 issue 为 warning 级）。
ALTER TABLE "applications" ADD COLUMN "eval_gate_enabled" boolean DEFAULT false NOT NULL;
