import { z } from "zod";
import type { StructuredOutputSpec } from "../models/ports/model-provider.port";

const MAX_ATTEMPTS = 2;

export class RetriableJudgeError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "RetriableJudgeError";
  }
}

export function structuredOutput(name: string, schema: z.ZodType): StructuredOutputSpec {
  return {
    name,
    schema: z.toJSONSchema(schema) as Record<string, unknown>,
    strict: true,
  };
}

export function parseJudgeOutput<T>(content: string, schema: z.ZodType<T>): T {
  try {
    return schema.parse(JSON.parse(content));
  } catch (error) {
    throw new RetriableJudgeError("judge output failed JSON or schema validation", error);
  }
}

export async function callJudgeProvider<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw new RetriableJudgeError("judge provider call failed", error);
  }
}

export function invalidJudgeOutput(message: string): never {
  throw new RetriableJudgeError(message);
}

export async function withJudgeRetry<T>(
  metric: "faithfulness" | "answer relevancy" | "context precision",
  attempt: () => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let index = 0; index < MAX_ATTEMPTS; index += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (!(error instanceof RetriableJudgeError)) throw error;
      lastError = error;
    }
  }
  throw new Error(`${metric} judge output invalid after retry`, { cause: lastError });
}

export function limitedEvidence(values: string[], emptyMessage: string): string[] {
  return values.length === 0 ? [emptyMessage] : values.slice(0, 3);
}
