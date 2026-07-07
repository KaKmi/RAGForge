import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { Injectable } from "@nestjs/common";

/**
 * 模型 API Key 应用层加密（001:159）。AES-256-GCM，envelope `v1:<ivB64>:<tagB64>:<ctB64>`，
 * 版本前缀为日后 KMS 迁移留判别标识。主密钥 32 字节 base64（env MODEL_API_KEY_ENCRYPTION_KEY）。
 */
@Injectable()
export class EncryptionService {
  private readonly key: Buffer;

  constructor(masterKeyB64: string) {
    this.key = Buffer.from(masterKeyB64, "base64");
    if (this.key.length !== 32) {
      throw new Error("MODEL_API_KEY_ENCRYPTION_KEY must decode to exactly 32 bytes");
    }
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
  }

  decrypt(envelope: string): string {
    const parts = envelope.split(":");
    const [version, ivB64, tagB64, ctB64] = parts;
    // ctB64 允许为空串（AES-GCM 支持零长明文，encrypt("") 产出 `v1:<iv>:<tag>:`）
    if (parts.length !== 4 || version !== "v1" || !ivB64 || !tagB64 || ctB64 === undefined) {
      throw new Error("unsupported ciphertext envelope");
    }
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(ctB64, "base64")),
      decipher.final(),
    ]).toString("utf8");
  }

  // len≥8 → 首3+****+末4（与 M2 展示格式 sk-****1234 一致）；否则 ****
  maskApiKey(plaintext: string): string {
    if (plaintext.length < 8) return "****";
    return `${plaintext.slice(0, 3)}****${plaintext.slice(-4)}`;
  }
}
