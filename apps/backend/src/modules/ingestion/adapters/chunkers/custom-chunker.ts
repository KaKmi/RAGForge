import type { ChunkDraftPartial, ChunkerMeta, ChunkerPort } from "../../ports/chunker.port";

// 结构感知切分参数（用户提供的课程导出规则，原样移植）。
const MAX_SECTION = 1200; // 超过此长度触发二次切分
const TARGET = 800; // 二次切分的目标块大小
const MIN_CHUNK = 200; // 低于此长度的块尽量与相邻块合并
const OVERLAP_CAP = 120; // overlap 上限（字）

// 公众号导出文本里指向 mp.weixin.qq.com 的纯导航链接行（如「1. [第一节：xxx](https://mp.weixin.qq.com/...)」）。
const NAV_LINK_RE =
  /^\s*(?:\d+\.|[-*])?\s*\[[^\]]*\]\(https?:\/\/mp\.weixin\.qq\.com[^)]*\)[；;，,。\s]*$/;
const IMAGE_LINE_RE = /^\s*!\[[^\]]*\]\([^)]*\)\s*$/;
const IMAGE_INLINE_RE = /!\[[^\]]*\]\([^)]*\)/g;
const ORPHAN_RECAP_RE = /^\s*(前情回顾|往期回顾|历史文章)[:：]?\s*$/gm;

interface FilenameMeta {
  isCourse: boolean;
  lessonNo: number | null;
  topic: string;
}

interface SectionDraft {
  section: string;
  part: number | null;
  rawText: string;
}

/**
 * 定制模板（用户提供的课程导出内容清洗+切分规则，原样移植）：
 * - 清洗：删顶部推广引用块、公众号导航链接行、图片、孤立的「前情回顾」标签
 * - 切分：按 ## 一级标题分段，超长再按 ### 二次切，仍超长按段落/句子聚合，
 *   小块合并，每片拼「《知识库名》第N课·主题 > 小节标题」上下文头
 * 知识库名称即课程名——来自参数 meta.kbName，不写死。
 */
export class CustomChunker implements ChunkerPort {
  chunk(text: string, meta: ChunkerMeta): ChunkDraftPartial[] {
    const cleaned = this.cleanCourseExport(text);
    const fileMeta = this.parseFilename(meta.filename);
    const sections = this.splitSections(cleaned);

    const drafts: SectionDraft[] = [];
    for (const sec of sections) {
      // 过短的整节并入上一个 chunk（多为图片说明残留）。
      if (sec.text.length < 50 && drafts.length > 0) {
        const prev = drafts[drafts.length - 1];
        prev.rawText += `\n\n## ${sec.title}\n${sec.text}`;
        continue;
      }
      const pieces = sec.text.length <= MAX_SECTION ? [sec.text] : this.splitLong(sec.text);
      pieces.forEach((piece, i) => {
        drafts.push({
          section: sec.title,
          part: pieces.length > 1 ? i + 1 : null,
          rawText: piece.trim(),
        });
      });
    }

    return drafts.map((d, seq) => {
      const header = this.buildHeader(meta.kbName, fileMeta, d.section, d.part);
      return { seq, text: `${header}\n\n${d.rawText}`, section: header };
    });
  }

  // ---- 清洗（规则 1-5，原样移植） ----
  private cleanCourseExport(raw: string): string {
    let lines = raw.split(/\r?\n/);

    // 规则 1：删除文件顶部的引用块（连续 > 开头行 + 空行）——顶部只可能是推广语。
    let start = 0;
    while (
      start < lines.length &&
      (lines[start].trim() === "" || lines[start].trimStart().startsWith(">"))
    ) {
      start++;
    }
    lines = lines.slice(start);

    const kept: string[] = [];
    for (const line of lines) {
      if (NAV_LINK_RE.test(line)) continue; // 规则 2：纯导航链接行
      if (IMAGE_LINE_RE.test(line)) continue; // 规则 4：图片整行
      kept.push(line.replace(IMAGE_INLINE_RE, "")); // 行内图片替换为空
    }

    let text = kept.join("\n");
    text = text.replace(ORPHAN_RECAP_RE, ""); // 规则 3：孤立的「前情回顾」标签
    text = text.replace(/\n{3,}/g, "\n\n").trim(); // 规则 5：压缩空行
    return text;
  }

  // 课程-11人才九宫格_2025-05-27.txt → { lessonNo:11, topic:"人才九宫格" }；兼容 .md.txt 双后缀。
  private parseFilename(filename: string): FilenameMeta {
    const base = filename.replace(/\.(md\.txt|txt|md)$/i, "");
    const m = /^课程-(\d+)(.+?)_(\d{4}-\d{2}-\d{2})$/.exec(base);
    if (m) {
      return { isCourse: true, lessonNo: parseInt(m[1], 10), topic: m[2].trim() };
    }
    return { isCourse: false, lessonNo: null, topic: base };
  }

  private buildHeader(
    kbName: string,
    fileMeta: FilenameMeta,
    sectionTitle: string,
    partNo: number | null,
  ): string {
    const doc = fileMeta.isCourse
      ? `《${kbName}》第${fileMeta.lessonNo}课·${fileMeta.topic}`
      : fileMeta.topic;
    const part = partNo ? `（${partNo}）` : "";
    return `${doc} > ${sectionTitle}${part}`;
  }

  // ---- 切分（原样移植） ----
  private splitSections(text: string): Array<{ title: string; text: string }> {
    const lines = text.split("\n");
    const sections: Array<{ title: string; text: string }> = [];
    let title = "引言";
    let buf: string[] = [];

    const flush = (): void => {
      const body = buf.join("\n").trim();
      if (body) sections.push({ title, text: body });
      buf = [];
    };

    for (const line of lines) {
      const m = /^##\s+(.+)$/.exec(line); // 只匹配 ##，### 留给二次切分
      if (m && !line.startsWith("###")) {
        flush();
        title = m[1].trim();
      } else {
        buf.push(line);
      }
    }
    flush();
    return sections;
  }

  private splitLong(text: string): string[] {
    // 先按 ### 子标题切（子标题行保留在所属块开头）。
    const units: string[] = [];
    let buf: string[] = [];
    for (const line of text.split("\n")) {
      if (/^###\s+/.test(line) && buf.join("\n").trim()) {
        units.push(buf.join("\n").trim());
        buf = [line];
      } else {
        buf.push(line);
      }
    }
    if (buf.join("\n").trim()) units.push(buf.join("\n").trim());

    const pieces: string[] = [];
    for (const unit of units) {
      if (unit.length <= MAX_SECTION) {
        pieces.push(unit);
      } else {
        pieces.push(...this.packParagraphs(unit));
      }
    }
    return this.mergeSmall(pieces);
  }

  // 相邻小块合并，直到不小于 MIN_CHUNK（且合并结果不超过 MAX_SECTION）。
  private mergeSmall(pieces: string[]): string[] {
    const out: string[] = [];
    for (const p of pieces) {
      const prev = out[out.length - 1];
      if (
        prev !== undefined &&
        (p.length < MIN_CHUNK || prev.length < MIN_CHUNK) &&
        prev.length + p.length <= MAX_SECTION
      ) {
        out[out.length - 1] = `${prev}\n\n${p}`;
      } else {
        out.push(p);
      }
    }
    return out;
  }

  private packParagraphs(text: string): string[] {
    // 段落定义：空行分隔；单段超长（如连续引用块）再按句子硬切。
    const paras = text
      .split(/\n{2,}/)
      .filter((p) => p.trim())
      .flatMap((p) => (p.length > MAX_SECTION ? this.splitBySentence(p) : [p]));

    const pieces: string[] = [];
    let buf: string[] = [];
    let size = 0;

    for (const p of paras) {
      if (size + p.length > TARGET && buf.length > 0) {
        pieces.push(buf.join("\n\n"));
        // overlap：带上上一块的最后一段（截断）。
        const last = buf[buf.length - 1];
        const overlap = last.length > OVERLAP_CAP ? last.slice(-OVERLAP_CAP) : last;
        buf = [`……${overlap}`];
        size = overlap.length;
      }
      buf.push(p);
      size += p.length;
    }
    if (buf.length) pieces.push(buf.join("\n\n"));
    return pieces;
  }

  // 按中文句末标点切句后聚合到 TARGET。
  private splitBySentence(text: string): string[] {
    const sentences = text.split(/(?<=[。！？；\n])/);
    const out: string[] = [];
    let buf = "";
    for (const s of sentences) {
      if (buf.length + s.length > TARGET && buf) {
        out.push(buf);
        buf = "";
      }
      buf += s;
    }
    if (buf.trim()) out.push(buf);
    return out;
  }
}
