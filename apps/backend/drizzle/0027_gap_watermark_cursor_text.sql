-- B2a Task 5：把收集器游标的时间列从 timestamptz 改成不透明字符串。
--
-- 0026 把 `last_ts` 建成 `timestamp with time zone`，但游标要比较的排序键是 ClickHouse 的
-- `start_time DateTime64(9)`（纳秒）。经 PG timestamptz 往返会被截断（列本身只到微秒，
-- 而 node-postgres 更是直接还原成 JS `Date`，只剩毫秒）：
--   实际 `...123456789` 写回读出变 `...123000000`
--   ⇒ 元组比较 `(123456789, id) > (123000000, id)` 仍然成立
--   ⇒ **最后一行每轮都被重新取出，游标永远推不过它**（问题池永久卡在同一条 trace）。
-- 这与 story 4 在 `GapPoolCursor` 上修掉的是同一个 bug，只是当时只修了内存里的一半，
-- 落库的另一半还留在 0026 里。
--
-- 改成 varchar 存原样 CH 时间串（`YYYY-MM-DD HH:MM:SS.fffffffff`，定宽 ⇒ 字典序即时间序）。
-- 表此刻必然为空（收集器 worker 本次才落地，没有任何写入方），故直接改类型无数据风险；
-- USING 子句仍写全，让「万一有行」的情况也能得到格式正确的值而不是报错。
ALTER TABLE "gap_watermarks"
  ALTER COLUMN "last_ts" TYPE varchar(40)
  USING to_char("last_ts" AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '000';
