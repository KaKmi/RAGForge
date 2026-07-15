import { createHash } from "node:crypto";

export interface RiskCandidate {
  status: "success" | "fallback" | "failed";
  noCitations: boolean;
  confidence: number | null;
}

export function classifyRisk(candidate: RiskCandidate): boolean {
  return (
    candidate.status === "failed" ||
    candidate.status === "fallback" ||
    candidate.noCitations ||
    (candidate.confidence !== null && candidate.confidence < 0.6)
  );
}

export function stableSample(traceId: string, judgeVersion: string, rate: number): boolean {
  if (rate <= 0) return false;
  if (rate >= 1) return true;
  const digest = createHash("sha256").update(`${traceId}:${judgeVersion}`, "utf8").digest();
  const bucket = digest.readUInt32BE(digest.length - 4) / 0x1_0000_0000;
  return bucket < rate;
}

export function effectiveNormalRate(rate: number, dailyCount: number, dailyCap: number): number {
  return dailyCount >= Math.floor(dailyCap * 0.8) ? rate / 2 : rate;
}

export function evalDedupeKey(traceId: string, judgeVersion: string): string {
  return createHash("sha256").update(`${traceId}:${judgeVersion}`, "utf8").digest("hex");
}
