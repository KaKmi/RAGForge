-- B2b 修复：「复发」判定的窗口必须从**簇进入终态那一刻**起算，而不是从「现在往前 7 天」。
--
-- 原型 `:376`/`:708` 的原话是「已回验**后** 7 天内新增 ≥5 条 → 自动重开」。
-- 初版实现按 `created_at >= now - 7d` 数**全部**成员，包含簇被忽略/回验**之前**就已经攒下的那些。
-- 后果：一个本周命中过 6 次的热簇，运营刚点「忽略」，下一条相似样本进来时窗口内计数已是 7 ≥ 5，
-- 立刻又被重开——「频次+1 但不重开」这条对**恰恰是人们真的会去忽略的簇**永远不成立，
-- [忽略] 按钮等于没有。
--
-- 为什么不用现成的 `updated_at` 当锚点：`attachItem` 每并入一条样本都会刷新它
-- （freq/last_seen_at/updated_at 一起写），所以它跟着新样本一起往前跑，压根不是「终态时刻」。
-- 也不用 `last_seen_at`（同理）。只能新加一列。
ALTER TABLE "gap_clusters" ADD COLUMN "terminal_at" timestamp with time zone;
--> statement-breakpoint

-- 存量数据的回填：把**已经处于终态**的簇视作「此刻刚进入终态」。
-- 比留 NULL 更安全——NULL 会退化回「从 now 往前数」的老行为，也就是上面那个 bug。
-- 代价是这些簇的复发窗口从迁移时刻重新起算，属可接受的一次性偏差（B2b 上线前池子里
-- 本来也没有 verified 簇；ignored 簇则本就该重新观察一个完整窗口）。
UPDATE "gap_clusters" SET "terminal_at" = now()
  WHERE "status" IN ('ignored', 'verified') AND "terminal_at" IS NULL;
