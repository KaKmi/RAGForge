import type { CanonicalDocument } from "../canonical/canonical-document";

export interface DocumentNormalizerPort {
  readonly id: string;
  normalize(doc: CanonicalDocument, config: Record<string, unknown>): CanonicalDocument;
}
