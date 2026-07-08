import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { Chunk } from "@codecrush/contracts";
import { batchDeleteChunks, getDocumentChunks, getDocumentContent } from "../../api/client";

/** 文档切片：左原文 + 右切片结果（分页无限滚动 + 搜索 + 批量删除，接真实 /api/documents/:docId/chunks）。 */

const PAGE_SIZE = 20;
const SEARCH_DEBOUNCE_MS = 300;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function ChunksPage() {
  const navigate = useNavigate();
  const { kbId = "", docId = "" } = useParams<{ kbId: string; docId: string }>();

  const [fullText, setFullText] = useState("");
  const [contentError, setContentError] = useState<string | null>(null);

  const [chunks, setChunks] = useState<Chunk[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"full" | "brief">("brief");
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [deleting, setDeleting] = useState(false);

  const sentinelRef = useRef<HTMLDivElement>(null);
  // 请求代际计数：reset（搜索/换文档）时递增；迟到的旧代际响应直接丢弃，
  // 防止 (A) 两次搜索乱序回包旧结果覆盖新结果、(B) 旧 query 的翻页追加污染新列表与 offset。
  const genRef = useRef(0);

  const loadPage = useCallback(
    async (reset: boolean) => {
      if (reset) genRef.current += 1;
      const gen = genRef.current;
      setLoading(true);
      try {
        const page = await getDocumentChunks(docId, {
          offset: reset ? 0 : offset,
          limit: PAGE_SIZE,
          q: query || undefined,
        });
        if (gen !== genRef.current) return; // 已被更新的 reset 取代，丢弃
        setChunks(prev => (reset ? page.items : [...prev, ...page.items]));
        setOffset((reset ? 0 : offset) + page.items.length);
        setHasMore(page.hasMore);
        setTotal(page.total);
        setError(null);
      } catch (e) {
        if (gen !== genRef.current) return;
        setError(errMsg(e));
      } finally {
        // loading 也只由当前代际的请求收尾，避免旧请求提前放行 IntersectionObserver
        if (gen === genRef.current) setLoading(false);
      }
    },
    [docId, offset, query],
  );

  // 卸载时作废所有在途请求
  useEffect(() => {
    return () => {
      genRef.current += 1;
    };
  }, []);

  // 原文：docId 变化时拉一次，独立于切片分页/搜索
  useEffect(() => {
    let cancelled = false;
    setContentError(null);
    getDocumentContent(docId)
      .then(r => {
        if (!cancelled) setFullText(r.text);
      })
      .catch(e => {
        if (!cancelled) setContentError(errMsg(e));
      });
    return () => {
      cancelled = true;
    };
  }, [docId]);

  // 搜索框 debounce：300ms 无输入才更新真正触发请求的 query
  useEffect(() => {
    const t = setTimeout(() => setQuery(queryInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [queryInput]);

  // docId 或 query 变化时整页重置（不追加 offset 依赖，避免死循环）
  useEffect(() => {
    setSelected({});
    void loadPage(true);
    // 仅在 docId/query 变化时整页重置；loadPage 依赖 offset 会随分页变化，
    // 但此处刻意不把它列进依赖数组，避免每次翻页都触发重置死循环。
  }, [docId, query]);

  // IntersectionObserver 触发下一页（无限滚动）
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore || loading) return;
    const io = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting) void loadPage(false);
    });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loading, loadPage]);

  const toggleSelect = (id: string) =>
    setSelected(prev => {
      const next = { ...prev };
      if (next[id]) delete next[id];
      else next[id] = true;
      return next;
    });

  const visibleIds = chunks.map(c => c.id);
  const selectedIds = Object.keys(selected);
  const hasSel = selectedIds.length > 0;
  const allSelected = visibleIds.length > 0 && visibleIds.every(id => selected[id]);
  const batchCur = hasSel ? "pointer" : "not-allowed";

  const selectAll = () => {
    setSelected(() => {
      if (allSelected) return {};
      const m: Record<string, boolean> = {};
      visibleIds.forEach(id => (m[id] = true));
      return m;
    });
  };

  const batchDelete = async () => {
    if (selectedIds.length === 0 || deleting) return;
    setDeleting(true);
    try {
      await batchDeleteChunks({ ids: selectedIds });
      setSelected({});
      await loadPage(true);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setDeleting(false);
    }
  };

  const goBack = () => navigate(`/admin/knowledge-bases/${encodeURIComponent(kbId)}/documents`);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <div onClick={goBack} style={backBtn}>
          ← 返回
        </div>
        <div style={{ fontSize: 16, fontWeight: 600 }}>切片管理</div>
        <span style={{ fontSize: 12, color: "rgba(0,0,0,.45)" }}>文档 ID：{docId}</span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, alignItems: "start" }}>
        <div style={card}>
          <div style={cardHead}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>原文</div>
            <div style={{ fontSize: 12, color: "rgba(0,0,0,.45)", marginTop: 2 }}>文档解析后的完整文本。</div>
          </div>
          <div
            style={{
              padding: 18,
              height: 560,
              overflowY: "auto",
              fontSize: 13,
              lineHeight: 1.9,
              color: "rgba(0,0,0,.75)",
              whiteSpace: "pre-wrap",
            }}
          >
            {contentError ? (
              <span style={{ color: "#ff4d4f" }}>{contentError}</span>
            ) : (
              fullText
            )}
          </div>
        </div>

        <div style={card}>
          <div style={cardHead}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>切片结果</div>
            <div style={{ fontSize: 12, color: "rgba(0,0,0,.45)", marginTop: 2 }}>查看用于嵌入和召回的切片段落。</div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 14, flexWrap: "wrap" }}>
              <div onClick={selectAll} style={{ display: "flex", alignItems: "center", gap: 7, cursor: "pointer", userSelect: "none" }}>
                <div
                  style={{
                    width: 16,
                    height: 16,
                    borderRadius: 4,
                    border: `1.5px solid ${allSelected ? "#1677ff" : "#d9d9d9"}`,
                    background: allSelected ? "#1677ff" : "#fff",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "#fff",
                    fontSize: 11,
                  }}
                >
                  {allSelected ? "✓" : ""}
                </div>
                <span style={{ fontSize: 13, color: "rgba(0,0,0,.65)" }}>选择所有</span>
              </div>
              <div
                onClick={() => void batchDelete()}
                style={{
                  ...batchBtn,
                  border: `1px solid ${hasSel ? "#ffccc7" : "#d9d9d9"}`,
                  color: hasSel ? "#ff4d4f" : "rgba(0,0,0,.25)",
                  cursor: deleting ? "default" : batchCur,
                }}
              >
                🗑 {deleting ? "删除中…" : "删除"}
              </div>
              <div style={{ flex: 1 }} />
              <div style={{ display: "flex", border: "1px solid #d9d9d9", borderRadius: 6, overflow: "hidden" }}>
                <div
                  onClick={() => setMode("full")}
                  style={{
                    fontSize: 12,
                    lineHeight: "26px",
                    padding: "0 12px",
                    cursor: "pointer",
                    background: mode === "full" ? "#1677ff" : "#fff",
                    color: mode === "full" ? "#fff" : "rgba(0,0,0,.65)",
                  }}
                >
                  全文
                </div>
                <div
                  onClick={() => setMode("brief")}
                  style={{
                    fontSize: 12,
                    lineHeight: "26px",
                    padding: "0 12px",
                    cursor: "pointer",
                    background: mode === "brief" ? "#1677ff" : "#fff",
                    color: mode === "brief" ? "#fff" : "rgba(0,0,0,.65)",
                    borderLeft: "1px solid #d9d9d9",
                  }}
                >
                  省略
                </div>
              </div>
              <input
                value={queryInput}
                onChange={e => setQueryInput(e.target.value)}
                placeholder="搜索"
                style={{ width: 150, height: 28, padding: "0 12px", border: "1px solid #d9d9d9", borderRadius: 6, fontSize: 13, outline: "none" }}
              />
            </div>
            {hasSel && (
              <div style={{ fontSize: 12, color: "#1677ff", marginTop: 10 }}>已选择 {selectedIds.length} 个切片</div>
            )}
            {error && (
              <div style={{ fontSize: 12, color: "#ff4d4f", marginTop: 10, display: "flex", gap: 10 }}>
                <span style={{ flex: 1 }}>{error}</span>
                <span style={{ color: "#1677ff", cursor: "pointer" }} onClick={() => void loadPage(true)}>
                  重试
                </span>
              </div>
            )}
          </div>
          <div style={{ padding: "14px 18px", height: 496, overflowY: "auto", display: "flex", flexDirection: "column", gap: 12 }}>
            {chunks.length === 0 && !loading && !error ? (
              <div
                style={{
                  height: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "rgba(0,0,0,.3)",
                  fontSize: 13,
                }}
              >
                没有匹配的切片
              </div>
            ) : (
              chunks.map(c => {
                const sel = !!selected[c.id];
                const shown = mode === "full" ? c.text : c.text.length > 64 ? c.text.slice(0, 64) + "…" : c.text;
                return (
                  <div
                    key={c.id}
                    style={{ border: `1px solid ${sel ? "#1677ff" : "#f0f0f0"}`, borderRadius: 8, overflow: "hidden", background: "#fff" }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        padding: "8px 12px",
                        background: "#fafafa",
                        borderBottom: "1px solid #f0f0f0",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <div
                          onClick={() => toggleSelect(c.id)}
                          style={{
                            width: 16,
                            height: 16,
                            flex: "none",
                            borderRadius: 4,
                            border: `1.5px solid ${sel ? "#1677ff" : "#d9d9d9"}`,
                            background: sel ? "#1677ff" : "#fff",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            color: "#fff",
                            fontSize: 11,
                            cursor: "pointer",
                          }}
                        >
                          {sel ? "✓" : ""}
                        </div>
                        <span
                          style={{
                            fontSize: 11,
                            fontWeight: 600,
                            color: "#1677ff",
                            background: "#e6f4ff",
                            borderRadius: 4,
                            padding: "1px 7px",
                          }}
                        >
                          #{c.seq + 1}
                        </span>
                        <span style={{ fontSize: 12, color: "rgba(0,0,0,.4)" }}>{c.tokenCount} tokens</span>
                      </div>
                    </div>
                    <div
                      style={{
                        padding: "12px 14px",
                        fontSize: 13,
                        lineHeight: 1.85,
                        color: "rgba(0,0,0,.82)",
                        whiteSpace: "pre-wrap",
                      }}
                    >
                      {shown}
                    </div>
                  </div>
                );
              })
            )}
            {hasMore && (
              <div ref={sentinelRef} style={{ padding: "8px 0", textAlign: "center", fontSize: 12, color: "rgba(0,0,0,.35)" }}>
                {loading ? "加载中…" : ""}
              </div>
            )}
          </div>
          <div
            style={{
              padding: "10px 18px",
              borderTop: "1px solid #f0f0f0",
              display: "flex",
              alignItems: "center",
              justifyContent: "flex-end",
              gap: 14,
              fontSize: 13,
              color: "rgba(0,0,0,.55)",
            }}
          >
            <span>总共 {total} 条</span>
          </div>
        </div>
      </div>
    </div>
  );
}

const backBtn: CSSProperties = {
  height: 30,
  padding: "0 12px",
  border: "1px solid #d9d9d9",
  borderRadius: 6,
  background: "#fff",
  display: "flex",
  alignItems: "center",
  fontSize: 13,
  cursor: "pointer",
};

const card: CSSProperties = {
  background: "#fff",
  border: "1px solid #f0f0f0",
  borderRadius: 8,
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};

const cardHead: CSSProperties = {
  padding: "14px 18px",
  borderBottom: "1px solid #f0f0f0",
};

const batchBtn: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 5,
  height: 28,
  padding: "0 12px",
  border: "1px solid #d9d9d9",
  borderRadius: 6,
  fontSize: 12,
};
