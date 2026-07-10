import { CHUNKER_REGISTRY } from "../src/modules/ingestion/adapters/chunkers/chunker-registry";
import { MarkdownBasicNormalizer } from "../src/modules/ingestion/adapters/normalizers/markdown-basic-normalizer";
import { assembleCanonical } from "../src/modules/ingestion/canonical/assemble-canonical";
import { cleanText } from "../src/modules/ingestion/pipeline/clean-text";

const SAMPLE = [
  "# 手册\n\n第一章内容，句子甲。句子乙。\n\n## 小节\n\n正文段落丙。",
  "问：什么是甲？\n答：甲是乙。\n\n问：丙呢？\n答：丙是丁。",
].join("\n\n");

describe("Profile 管线保持旧 chunk 文本", () => {
  for (const template of ["general", "qa", "custom"] as const) {
    it(`${template} 无损迁移`, () => {
      const meta = { filename: "第1课：示例.md", kbName: "示例课程" };
      const legacy = CHUNKER_REGISTRY[template]
        .chunk(cleanText(SAMPLE), meta)
        .map((chunk) => chunk.text);
      const { doc } = assembleCanonical([{ page: 1, text: SAMPLE }], []);
      const normalized = new MarkdownBasicNormalizer().normalize(doc, {});
      const next = CHUNKER_REGISTRY[template]
        .chunk(normalized.markdown, meta)
        .map((chunk) => chunk.text);
      expect(next).toEqual(legacy);
    });
  }
});
