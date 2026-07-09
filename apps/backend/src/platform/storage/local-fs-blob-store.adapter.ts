import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative } from "node:path";
import { Injectable } from "@nestjs/common";
import type { BlobStore } from "./blob-store.port";

/**
 * 本地卷适配器：key 由调用方（DocumentsService）服务端生成
 * （kb/{kbId}/{docId}/original.{ext} 形状），本类只负责校验 key 不逃出 root + 落盘/读/删。
 * 换 OSS 只需新写一个实现同一端口的 OssBlobStore + 改 DI 注入（003:101）。
 */
@Injectable()
export class LocalFsBlobStore implements BlobStore {
  constructor(private readonly root: string) {}

  async put(key: string, data: Buffer): Promise<void> {
    const abs = this.resolve(key);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, data);
  }

  async get(key: string): Promise<Buffer> {
    return await readFile(this.resolve(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }

  private resolve(key: string): string {
    if (isAbsolute(key)) {
      throw new Error(`invalid blob key: ${key}`);
    }
    const abs = normalize(join(this.root, key));
    const rel = relative(this.root, abs);
    if (rel.startsWith("..") || rel === "" || join(this.root, rel) !== abs) {
      throw new Error(`invalid blob key: ${key}`);
    }
    return abs;
  }
}
