import { useEffect, useState } from "react";
import { Button, Checkbox, Empty, Input, List, Modal, Select, Space, Typography } from "antd";
import type { GoldDocRef, KnowledgeBase, RetrievalHit } from "@codecrush/contracts";
import { getKnowledgeBases, testRetrieval } from "../../api/client";
import { GOLD_DOC_MAX } from "./evalShared";

const { Text } = Typography;
/** 候选片段正文摘要长度（原型 §5「text 前 80 字」）。 */
const TEXT_PREVIEW = 80;

/**
 * chunk 级 gold 检索选择器（E-W2b F3，原型 §5「检索选择器：退款政策 §2 ×」）。
 *
 * antd Modal 内嵌：选知识库 + 关键词 → 复用现有检索测试台端点 `POST /retrieval/test`
 * 返回候选 chunk → 勾选合入 refs（按 chunkId 去重，快照 docName/section 供 tag 显示）。
 * 触发按钮「＋ 添加」自带，父组件只渲染已选 tag + 本组件。
 */
export function GoldRefSelector({
  value,
  onChange,
  kbIds,
}: {
  value: GoldDocRef[];
  onChange: (refs: GoldDocRef[]) => void;
  kbIds: string[];
}) {
  const [open, setOpen] = useState(false);
  const [kbs, setKbs] = useState<KnowledgeBase[]>([]);
  const [kbId, setKbId] = useState<string | undefined>();
  const [hits, setHits] = useState<RetrievalHit[]>([]);
  const [searched, setSearched] = useState(false);
  const [searching, setSearching] = useState(false);
  // 勾选中的候选：chunkId → hit（跨多次检索保留勾选）。
  const [picked, setPicked] = useState<Record<string, RetrievalHit>>({});
  const [error, setError] = useState<string | null>(null);

  // 候选知识库：优先取该集关联的（kbIds），未关联（=覆盖「全部」）则取全部 KB——沿用 CaseDrawer 旧逻辑。
  useEffect(() => {
    if (!open) return;
    let live = true;
    void (async () => {
      try {
        const all = await getKnowledgeBases();
        if (!live) return;
        const candidates = kbIds.length > 0 ? all.filter((k) => kbIds.includes(k.id)) : all;
        setKbs(candidates);
        setKbId((prev) => prev ?? candidates[0]?.id);
      } catch {
        if (live) setKbs([]);
      }
    })();
    return () => {
      live = false;
    };
  }, [open, kbIds]);

  const kb = kbs.find((k) => k.id === kbId);

  const search = async (query: string) => {
    const q = query.trim();
    if (!q) return;
    if (!kb) return setError("请选择知识库");
    setError(null);
    setSearching(true);
    try {
      const resp = await testRetrieval({
        query: q,
        kbId: kb.id,
        embedModelId: kb.embeddingModelId,
        topK: 10,
        threshold: 0,
        multi: false,
      });
      setHits(resp.hits);
      setSearched(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "检索失败");
    } finally {
      setSearching(false);
    }
  };

  const toggle = (hit: RetrievalHit, checked: boolean) => {
    setPicked((prev) => {
      const next = { ...prev };
      if (checked) next[hit.chunkId] = hit;
      else delete next[hit.chunkId];
      return next;
    });
  };

  const close = () => {
    setOpen(false);
    setHits([]);
    setPicked({});
    setSearched(false);
    setError(null);
  };

  const confirm = () => {
    const existing = new Set(value.map((r) => r.chunkId));
    const additions: GoldDocRef[] = Object.values(picked)
      // 去重：已选过（同 chunkId）的候选不重复合入。
      .filter((h) => !existing.has(h.chunkId))
      .map((h) => ({
        docId: h.docId,
        chunkId: h.chunkId,
        docName: h.docName,
        section: h.section || null,
      }));
    const merged = [...value, ...additions];
    if (merged.length > GOLD_DOC_MAX) return setError("最多关联 10 个片段"); // §19.1 逐字
    onChange(merged);
    close();
  };

  return (
    <>
      <Button size="small" onClick={() => setOpen(true)}>
        ＋ 添加
      </Button>
      <Modal
        title="选择 gold 片段"
        open={open}
        width={640}
        onCancel={close}
        onOk={confirm}
        okText="确认"
        cancelText="取消"
        destroyOnHidden
      >
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          <Select
            aria-label="知识库"
            data-testid="gold-kb-select"
            style={{ width: "100%" }}
            placeholder="选择知识库"
            value={kbId}
            onChange={setKbId}
            options={kbs.map((k) => ({ value: k.id, label: k.name }))}
          />
          <Input.Search
            aria-label="检索关键词"
            placeholder="输入关键词检索候选片段"
            enterButton="检索"
            loading={searching}
            onSearch={search}
          />
          <List
            size="small"
            bordered
            dataSource={hits}
            locale={{
              emptyText: (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={searched ? "没有匹配的片段" : "输入关键词检索候选片段"}
                />
              ),
            }}
            style={{ maxHeight: 320, overflow: "auto" }}
            renderItem={(hit) => (
              <List.Item>
                <Checkbox
                  checked={hit.chunkId in picked}
                  onChange={(e) => toggle(hit, e.target.checked)}
                  style={{ width: "100%" }}
                >
                  <div>
                    <Text strong>{hit.docName}</Text>
                    {hit.section && <Text type="secondary"> {hit.section}</Text>}
                    <Text type="secondary"> · {hit.finalScore.toFixed(2)}</Text>
                  </div>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {hit.text.slice(0, TEXT_PREVIEW)}
                  </Text>
                </Checkbox>
              </List.Item>
            )}
          />
          {error && <Text type="danger">{error}</Text>}
        </Space>
      </Modal>
    </>
  );
}
