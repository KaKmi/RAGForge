import { EVALUATION_ERROR_MAX_LENGTH } from "./evaluation.constants";

export interface NormalizedEvaluationError {
  errorClass: string;
  message: string;
}

export function normalizeEvaluationError(error: unknown): NormalizedEvaluationError {
  const errorClass = error instanceof Error ? error.name || "Error" : "Error";
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, EVALUATION_ERROR_MAX_LENGTH);
  return { errorClass: errorClass.slice(0, 100), message: message || "unknown error" };
}
