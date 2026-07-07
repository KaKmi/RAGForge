import type { TagKey } from "./agents";

/** M2 mock：知识库管理 / 文档 / 切片页用，对齐原型 KB_ROWS / KB_DOCS / STAGE_DEFS / DOC_CONTENT。M4 接真实 /api/knowledge-bases 等。 */

/** 知识库列表卡片（对齐原型 KB_ROWS）。 */
export interface KbRow {
  name: string;
  desc: string;
  docs: string;
  chunks: string;
  st: string;
  tag: TagKey;
  updated: string;
}

export const KB_ROWS: KbRow[] = [
  { name: "课程目录库", desc: "全部在售课程介绍与大纲", docs: "86", chunks: "3,412", st: "已就绪", tag: "green", updated: "2026-06-30" },
  { name: "售后服务知识库", desc: "退款换课政策 · 服务条款", docs: "54", chunks: "2,180", st: "已就绪", tag: "green", updated: "2026-06-18" },
  { name: "学习指南库", desc: "学习路径 · 作业 · 证书", docs: "128", chunks: "5,631", st: "已就绪", tag: "green", updated: "2026-06-25" },
  { name: "订单FAQ", desc: "订单 · 支付 · 发票高频问答", docs: "37", chunks: "902", st: "已就绪", tag: "green", updated: "2026-06-02" },
  { name: "活动物料库", desc: "促销活动规则与物料", docs: "19", chunks: "445", st: "重建中 62%", tag: "blue", updated: "2026-07-02" },
];

export const KB_EMBED = "bge-m3";

/** 知识库下的文档（对齐原型 KB_DOCS）。 */
export interface KbDoc {
  name: string;
  type: string; // PDF / Word / MD
  chunks: number;
  st: string; // 已索引 / 解析中 / 排队中 / 解析失败
  tag: TagKey;
  updated: string; // MM-DD
}

export const KB_DOCS: Record<string, KbDoc[]> = {
  课程目录库: [
    { name: "2026 全课程目录总览.pdf", type: "PDF", chunks: 64, st: "已索引", tag: "green", updated: "06-30" },
    { name: "Python 系列课程大纲.docx", type: "Word", chunks: 48, st: "已索引", tag: "green", updated: "06-28" },
    { name: "前端工程师训练营介绍.md", type: "MD", chunks: 22, st: "已索引", tag: "green", updated: "06-25" },
    { name: "数据分析就业班课程表.pdf", type: "PDF", chunks: 31, st: "已索引", tag: "green", updated: "06-20" },
  ],
  售后服务知识库: [
    { name: "课程退款与换课政策 V3.2.pdf", type: "PDF", chunks: 28, st: "已索引", tag: "green", updated: "06-18" },
    { name: "发票开具规则.docx", type: "Word", chunks: 12, st: "已索引", tag: "green", updated: "06-15" },
    { name: "服务条款与用户协议.pdf", type: "PDF", chunks: 41, st: "已索引", tag: "green", updated: "05-30" },
  ],
  学习指南库: [
    { name: "Python 学习路径指南.md", type: "MD", chunks: 36, st: "已索引", tag: "green", updated: "05-20" },
    { name: "学习服务说明.pdf", type: "PDF", chunks: 24, st: "已索引", tag: "green", updated: "04-11" },
    { name: "作业与项目评审标准.docx", type: "Word", chunks: 18, st: "已索引", tag: "green", updated: "06-08" },
  ],
  订单FAQ: [
    { name: "订单与退款操作指南.md", type: "MD", chunks: 15, st: "已索引", tag: "green", updated: "06-02" },
    { name: "支付与分期常见问题.docx", type: "Word", chunks: 9, st: "已索引", tag: "green", updated: "05-28" },
  ],
  活动物料库: [
    { name: "暑期大促活动规则.pdf", type: "PDF", chunks: 11, st: "解析中", tag: "gold", updated: "07-02" },
    { name: "优惠券使用说明.md", type: "MD", chunks: 6, st: "排队中", tag: "gray", updated: "07-02" },
    { name: "双十一预热海报文案（扫描件）.pdf", type: "PDF", chunks: 0, st: "解析失败", tag: "red", updated: "07-02" },
  ],
};

/** 文档处理生命周期阶段（对齐原型 STAGE_DEFS，3 阶段）。 */
export interface StageDef {
  key: string;
  label: string;
  desc: string;
}

export const STAGE_DEFS: StageDef[] = [
  { key: "upload", label: "上传", desc: "文件校验 · 落盘存储" },
  { key: "ingest", label: "解析入库", desc: "解析 · 切片 · 向量化写入索引" },
  { key: "ready", label: "就绪", desc: "纳入检索 · 可被问答引用" },
];

/** 部分文档的原文分块（对齐原型 DOC_CONTENT）；未命中的文档用 GENERIC_CHUNKS 循环填充。 */
export const DOC_CONTENT: Record<string, string[]> = {
  "课程退款与换课政策 V3.2.pdf": [
    "第一条 适用范围：本政策适用于 CodeCrush 平台全部录播课程与直播训练营课程，实物周边与线下活动票务不在此列。平台保留在法律法规允许范围内对本政策进行调整的权利。",
    "第二条 七天无理由退款：学员自购买课程之日起 7 个自然日内，未学习任何课时（学习进度为 0）的，可向平台申请全额退款。退款金额为实际支付金额，使用优惠券支付的部分不予折现。",
    "第三条 部分学习退款：已学习课时不超过全部课时 10% 且不超过 2 节的，可申请退款，退款金额 = 实际支付金额 − 已学课时对应费用。超出上述范围的订单不再支持退款。",
    "第四条 特殊情形：因平台原因导致课程长期无法正常访问、且 7 个工作日内未修复的，学员可不受进度限制申请全额退款。",
    "第五条 换课规则：学习进度超过退款标准的学员，可在开课后 30 个自然日内申请一次免费换课，可换同价位课程或补差价换更高价位课程，差价多退少补，每个订单限一次。",
    "第六条 争议处理：对退款审核结果有异议的，可联系人工客服发起申诉，客服将在 5 个工作日内给出书面答复。",
  ],
  "Python 学习路径指南.md": [
    "本指南面向零基础学员，按「入门 → 实战 → 就业」三个阶段规划完整学习路径，建议按顺序推进，避免跳级。",
    "入门阶段：先完成《Python 基础语法》课程（建议 2 周），掌握变量、控制流、函数与常用数据结构，每章随堂练习完成率达到 80% 以上再进入下一阶段。",
    "实战阶段：进入《Python 数据分析实战》，跟随项目案例完成 3 个实战作业，重点掌握 Pandas、可视化与数据清洗。",
    "就业阶段：完成两门进阶课程后，可报名就业班，获得项目实战、简历辅导与内推机会。学有余力者可挑战《机器学习入门》进入算法方向。",
  ],
};

export const GENERIC_CHUNKS: string[] = [
  "本章节介绍了课程的核心框架与学习目标，帮助学员建立整体认知，明确后续各小节的学习重点与顺序。",
  "通过案例拆解，本节讲解了关键概念的实际应用场景，并给出了可落地的操作步骤与常见误区提示。",
  "本节总结了前述内容的要点，并布置了配套练习，建议学员完成后再进入下一节，以巩固学习效果。",
  "结课部分回顾了整门课程的知识脉络，给出了进阶学习建议与推荐的后续课程方向。",
];

/** 解析状态文案与色点（对齐原型 parseState）。 */
export function parseStateOf(tag: TagKey): { parse: string; dot: string; pc: string } {
  if (tag === "green") return { parse: "已就绪", dot: "#52c41a", pc: "#52c41a" };
  if (tag === "gold") return { parse: "处理中", dot: "#faad14", pc: "#faad14" };
  if (tag === "red") return { parse: "失败", dot: "#ff4d4f", pc: "#ff4d4f" };
  return { parse: "排队中", dot: "#bfbfbf", pc: "rgba(0,0,0,.45)" };
}

/** 取文档的分块正文：命中 DOC_CONTENT 用原文，否则用 GENERIC_CHUNKS 循环填充 n 条。 */
export function chunkBodiesOf(docName: string, n: number): string[] {
  const authored = DOC_CONTENT[docName];
  if (authored) return authored.slice();
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(GENERIC_CHUNKS[i % GENERIC_CHUNKS.length]);
  return out;
}

export type DocStageStatus = "done" | "running" | "failed" | "queued" | "pending";

export interface DocLifeStage {
  label: string;
  desc: string;
  icon: string;
  statusLabel: string;
  c: string;
  bg: string;
  bd: string;
  line: string;
  notLast: boolean;
  dur: string;
  time: string;
}

const STAGE_VIS: Record<DocStageStatus, { icon: string; c: string; bg: string; bd: string; line: string; t: string }> = {
  done: { icon: "✓", c: "#52c41a", bg: "#f6ffed", bd: "#b7eb8f", line: "#52c41a", t: "完成" },
  running: { icon: "◐", c: "#d48806", bg: "#fffbe6", bd: "#ffe58f", line: "#faad14", t: "进行中" },
  failed: { icon: "✕", c: "#ff4d4f", bg: "#fff2f0", bd: "#ffccc7", line: "#ffccc7", t: "失败" },
  queued: { icon: "·", c: "#8c8c8c", bg: "#fafafa", bd: "#e8e8e8", line: "#e8e8e8", t: "排队中" },
  pending: { icon: "", c: "#bfbfbf", bg: "#fff", bd: "#e8e8e8", line: "#e8e8e8", t: "待处理" },
};

/** 构建文档生命周期阶段（对齐原型 docLife.stages，纯计算无 handler）。 */
export function buildDocLifeStages(doc: KbDoc): DocLifeStage[] {
  const tag = doc.tag;
  const nc = doc.chunks || 0;
  const stg = STAGE_DEFS.map(s => ({ ...s, status: "pending" as DocStageStatus }));
  if (tag === "green") {
    stg[0].status = "done";
    stg[1].status = "done";
    stg[2].status = "done";
  } else if (tag === "gold") {
    stg[0].status = "done";
    stg[1].status = "running";
  } else if (tag === "red") {
    stg[0].status = "done";
    stg[1].status = "failed";
  } else {
    stg[0].status = "done";
    stg[1].status = "queued";
  }
  const durs = ["0.4s", (nc * 0.112).toFixed(1) + "s", "—"];
  const times = ["01:35:02", "01:35:48", "01:35:49"];
  const last = STAGE_DEFS.length - 1;
  return stg.map((s, i) => {
    const v = STAGE_VIS[s.status];
    const showTiming = s.status === "done" || s.status === "running";
    return {
      label: s.label,
      desc: s.desc,
      icon: v.icon || String(i + 1),
      statusLabel: v.t,
      c: v.c,
      bg: v.bg,
      bd: v.bd,
      line: v.line,
      notLast: i !== last,
      dur: showTiming ? durs[i] : "—",
      time: showTiming ? times[i] : "—",
    };
  });
}

export const DOC_FAIL_REASON =
  "第 3 页起为扫描图片，OCR 引擎无法识别文字层，抽取内容为空。请转换为文本版 PDF 后重试。";

/** 上传抽屉的分块策略选项。 */
export const CHUNK_OPTS = ["按语义分块", "定长 512", "按标题"];
