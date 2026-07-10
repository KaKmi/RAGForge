import { z } from "zod";
import { DocumentTypeSchema } from "./documents";

// 前端与 API 只认 profileId + profileVersion（010 不变量 3：Profile 与实现解耦）。
export const ProcessingProfileRefSchema = z.object({
  profileId: z.string().min(1),
  profileVersion: z.number().int().positive(),
});
export type ProcessingProfileRef = z.infer<typeof ProcessingProfileRefSchema>;

// 公开描述：只暴露业务名称/适用场景/只读摘要，不暴露 normalizers/引擎库名（010 §前端）。
export const ProcessingProfileDescriptorSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  label: z.string().min(1),
  description: z.string(),
  supportedTypes: z.array(DocumentTypeSchema),
  summary: z.string(),
});
export type ProcessingProfileDescriptor = z.infer<typeof ProcessingProfileDescriptorSchema>;
export const ProcessingProfileListResponseSchema = z.array(ProcessingProfileDescriptorSchema);
export type ProcessingProfileListResponse = z.infer<typeof ProcessingProfileListResponseSchema>;

export const ProcessingRunStatusSchema = z.enum(["queued", "running", "succeeded", "failed"]);
export type ProcessingRunStatus = z.infer<typeof ProcessingRunStatusSchema>;

export const ProcessingRunSchema = z.object({
  id: z.string().min(1),
  documentId: z.string().min(1),
  targetVersion: z.number().int().positive(),
  profileId: z.string().min(1),
  profileVersion: z.number().int().positive(),
  profileLabel: z.string(), // 从 snapshot 取，前端处理历史免拉 profiles 映射
  parserEngine: z.string().nullable(),
  parserVersion: z.string().nullable(),
  status: ProcessingRunStatusSchema,
  warnings: z.array(z.string()),
  metrics: z.record(z.string(), z.number()),
  error: z.string().nullable(),
  startedAt: z.string().datetime().nullable(),
  endedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type ProcessingRun = z.infer<typeof ProcessingRunSchema>;
export const ProcessingRunListResponseSchema = z.array(ProcessingRunSchema);
export type ProcessingRunListResponse = z.infer<typeof ProcessingRunListResponseSchema>;

// 空 body / mode:"reparse" = 用当前有效 Profile；mode:"retry" = 服务端定位最近 failed Run 复用其 snapshot；
// 带完整 ref = 显式换 Profile 并写回文档 override（010「单文档重新解析时覆盖」）。
export const ParseDocumentRequestSchema = z
  .strictObject({
    mode: z.enum(["retry", "reparse"]).optional(),
    profileId: z.string().min(1).optional(),
    profileVersion: z.number().int().positive().optional(),
  })
  .refine((v) => (v.profileId === undefined) === (v.profileVersion === undefined), {
    message: "profileId 与 profileVersion 必须成对出现",
  })
  .refine((v) => !(v.mode === "retry" && v.profileId !== undefined), {
    message: "retry 复用失败 Run 快照，不可同时指定 Profile",
  });
export type ParseDocumentRequest = z.infer<typeof ParseDocumentRequestSchema>;

export const RebuildKnowledgeBaseRequestSchema = z.object({
  scope: z.enum(["inherited", "all"]),
});
export type RebuildKnowledgeBaseRequest = z.infer<typeof RebuildKnowledgeBaseRequestSchema>;
