import type { CanonicalDocument } from "../../canonical/canonical-document";
import { cleanText } from "../../pipeline/clean-text";
import type { DocumentNormalizerPort } from "../../ports/document-normalizer.port";

export class MarkdownBasicNormalizer implements DocumentNormalizerPort {
  readonly id = "markdown-basic";

  normalize(doc: CanonicalDocument): CanonicalDocument {
    const blocks = doc.blocks
      .map((block) => ({ ...block, markdown: cleanText(block.markdown) }))
      .filter((block) => block.markdown.length > 0);
    return {
      ...doc,
      blocks,
      markdown: blocks.map((block) => block.markdown).join("\n\n"),
    };
  }
}
