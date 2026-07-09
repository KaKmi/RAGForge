import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Alert, Button, Checkbox, Empty, Input, Popconfirm, Segmented, Spin, Tag } from "antd";
import type { Chunk, Document } from "@codecrush/contracts";
import {
  batchDeleteChunks,
  getDocumentChunks,
  getDocumentContent,
  getDocuments,
} from "../../api/client";

/** 文档切片：左原文 + 右切片结果（分页无限滚动 + 搜索 + 批量删除，接真实 /api/documents/:docId/chunks）。 */

const PAGE_SIZE = 20;
const SEARCH_DEBOUNCE_MS = 300;
const BRIEF_LEN = 64;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 文档大小格式化（对齐 DocumentsPage 的 B/KB/MB 阈值）。 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 上传时间格式化（对齐 DocumentsPage 的 YYYY-MM-DD HH:mm）。 */
function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function ChunksPage() {
  const navigate = useNavigate();
  const { kbId = "", docId = "" } = useParams<{ kbId: string; docId: string }>();

  // 头部文档信息：复用现有 getDocuments(kbId) 列表接口后 find(docId)，不新增后端接口；拿不到时优雅回退显示 docId。
  const [doc, setDoc] = useState<Document | null>(null);

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
        setChunks((prev) => (reset ? page.items : [...prev, ...page.items]));
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

  // 头部文档信息：拉 KB 文档列表后取当前文档；失败/找不到时静默回退（头部显示 docId）
  useEffect(() => {
    let cancelled = false;
    setDoc(null);
    getDocuments(kbId)
      .then((list) => {
        if (!cancelled) setDoc(list.find((d) => d.id === docId) ?? null);
      })
      .catch(() => {
        if (!cancelled) setDoc(null);
      });
    return () => {
      cancelled = true;
    };
  }, [kbId, docId]);

  // 原文：docId 变化时拉一次，独立于切片分页/搜索
  useEffect(() => {
    let cancelled = false;
    setContentError(null);
    getDocumentContent(docId)
      .then((r) => {
        if (!cancelled) setFullText(r.text);
      })
      .catch((e) => {
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

  // IntersectionObserver 触发下一页（无限滚动）——哨兵保留，仅用于触发加载，可见提示统一在底部提示区
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore || loading) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) void loadPage(false);
    });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loading, loadPage]);

  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = { ...prev };
      if (next[id]) delete next[id];
      else next[id] = true;
      return next;
    });

  const visibleIds = chunks.map((c) => c.id);
  const selectedIds = Object.keys(selected);
  const hasSel = selectedIds.length > 0;
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selected[id]);

  const selectAll = () => {
    setSelected(() => {
      if (allSelected) return {};
      const m: Record<string, boolean> = {};
      visibleIds.forEach((id) => (m[id] = true));
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
        <Button onClick={goBack}>← 返回</Button>
        <div style={{ fontSize: 16, fontWeight: 600 }}>{doc?.name ?? docId}</div>
        {doc && (
          <span style={{ fontSize: 12, color: "rgba(0,0,0,.45)" }}>
            {formatSize(doc.size)} · 上传于 {formatDateTime(doc.uploadedAt)}
          </span>
        )}
      </div>

      <div
        style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, alignItems: "start" }}
      >
        <div style={card}>
          <div style={cardHead}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>原文</div>
            <div style={{ fontSize: 12, color: "rgba(0,0,0,.45)", marginTop: 2 }}>
              文档解析后的完整文本。
            </div>
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
            {contentError ? <span style={{ color: "#ff4d4f" }}>{contentError}</span> : fullText}
          </div>
        </div>

        <div style={card}>
          <div style={cardHead}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>切片结果</div>
            <div style={{ fontSize: 12, color: "rgba(0,0,0,.45)", marginTop: 2 }}>
              查看用于嵌入和召回的切片段落。
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                marginTop: 14,
                flexWrap: "wrap",
              }}
            >
              <Checkbox
                checked={allSelected}
                indeterminate={hasSel && !allSelected}
                onChange={selectAll}
              >
                选择所有
              </Checkbox>
              <Popconfirm
                title="删除选中切片"
                description={`将删除 ${selectedIds.length} 个切片，不可撤销。`}
                okText="删除"
                okButtonProps={{ danger: true }}
                cancelText="取消"
                disabled={!hasSel || deleting}
                onConfirm={() => void batchDelete()}
              >
                <Button danger size="small" disabled={!hasSel} loading={deleting}>
                  删除
                </Button>
              </Popconfirm>
              <div style={{ flex: 1 }} />
              <Segmented
                size="small"
                value={mode}
                onChange={(v) => setMode(v as "full" | "brief")}
                options={[
                  { label: "全文", value: "full" },
                  { label: "省略", value: "brief" },
                ]}
              />
              <Input
                allowClear
                value={queryInput}
                onChange={(e) => setQueryInput(e.target.value)}
                placeholder="搜索"
                style={{ width: 150 }}
              />
            </div>
            {hasSel && (
              <div style={{ fontSize: 12, color: "#1677ff", marginTop: 10 }}>
                已选择 {selectedIds.length} 个切片
              </div>
            )}
            {error && (
              <Alert
                type="error"
                showIcon
                style={{ marginTop: 10 }}
                message={error}
                action={
                  <Button size="small" type="text" onClick={() => void loadPage(true)}>
                    重试
                  </Button>
                }
              />
            )}
          </div>
          <div
            style={{
              padding: "14px 18px",
              height: 496,
              overflowY: "auto",
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            {chunks.length === 0 && !loading && !error ? (
              <div
                style={{
                  height: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Empty description="没有匹配的切片" />
              </div>
            ) : (
              chunks.map((c) => {
                const sel = !!selected[c.id];
                const shown =
                  mode === "full"
                    ? c.text
                    : c.text.length > BRIEF_LEN
                      ? c.text.slice(0, BRIEF_LEN) + "…"
                      : c.text;
                return (
                  <div
                    key={c.id}
                    style={{
                      border: `1px solid ${sel ? "#1677ff" : "#f0f0f0"}`,
                      borderRadius: 8,
                      overflow: "hidden",
                      background: "#fff",
                      flexShrink: 0,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: "8px 12px",
                        background: "#fafafa",
                        borderBottom: "1px solid #f0f0f0",
                      }}
                    >
                      <Checkbox checked={sel} onChange={() => toggleSelect(c.id)} />
                      <Tag color="blue" style={{ marginInlineEnd: 0 }}>
                        #{c.seq + 1}
                      </Tag>
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
            {/* 无限滚动哨兵：进入视口即触发下一页；可见提示统一放到底部提示区 */}
            {hasMore && <div ref={sentinelRef} style={{ height: 1, flexShrink: 0 }} />}
          </div>
          {/* 单一底部提示区（居中）：加载中 Spin / 有更多显示已显示计数 / 加载完显示总数 */}
          <div
            style={{
              padding: "10px 18px",
              borderTop: "1px solid #f0f0f0",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              fontSize: 12,
              color: "rgba(0,0,0,.4)",
            }}
          >
            {loading ? (
              <Spin size="small" />
            ) : hasMore ? (
              <span>
                向下滚动加载更多 · 已显示 {chunks.length} / {total}
              </span>
            ) : (
              <span>已加载全部 {total} 条</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

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
