import { EncryptionService } from "../src/platform/security/encryption";

const KEY = Buffer.alloc(32, 7).toString("base64"); // 固定测试主密钥
const OTHER_KEY = Buffer.alloc(32, 9).toString("base64");

describe("EncryptionService (AES-256-GCM)", () => {
  const enc = new EncryptionService(KEY);

  it("encrypt→decrypt 往返一致，envelope 为 v1: 前缀", () => {
    const blob = enc.encrypt("sk-test12345678");
    expect(blob.startsWith("v1:")).toBe(true);
    expect(blob).not.toContain("sk-test12345678");
    expect(enc.decrypt(blob)).toBe("sk-test12345678");
  });

  it("同明文两次加密密文不同（随机 iv）", () => {
    expect(enc.encrypt("same")).not.toBe(enc.encrypt("same"));
  });

  it("错误 key 解密抛错（GCM auth 失败）", () => {
    const blob = enc.encrypt("secret");
    expect(() => new EncryptionService(OTHER_KEY).decrypt(blob)).toThrow();
  });

  it("篡改密文抛错；非 v1 前缀抛错", () => {
    const blob = enc.encrypt("secret-长一点的内容避免空密文");
    const [v, iv, tag, ct] = blob.split(":");
    const ctBuf = Buffer.from(ct, "base64");
    ctBuf[0] ^= 0xff; // 翻转首字节
    const tampered = [v, iv, tag, ctBuf.toString("base64")].join(":");
    expect(() => enc.decrypt(tampered)).toThrow();
    expect(() => enc.decrypt("v0:a:b:c")).toThrow();
  });

  it("主密钥非 32 字节 → 构造抛错", () => {
    expect(() => new EncryptionService(Buffer.alloc(16, 1).toString("base64"))).toThrow();
  });

  it("maskApiKey：≥8 → 首3****末4；<8 → ****；空串 → ****", () => {
    expect(enc.maskApiKey("sk-abcdef1234")).toBe("sk-****1234");
    expect(enc.maskApiKey("12345678")).toBe("123****5678");
    expect(enc.maskApiKey("1234567")).toBe("****");
    expect(enc.maskApiKey("")).toBe("****");
  });
});
