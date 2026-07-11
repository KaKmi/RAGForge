import type { DocumentNormalizerPort } from "../../ports/document-normalizer.port";
import { MarkdownBasicNormalizer } from "./markdown-basic-normalizer";

export const NORMALIZER_REGISTRY: Record<string, DocumentNormalizerPort> = {
  "markdown-basic": new MarkdownBasicNormalizer(),
};
