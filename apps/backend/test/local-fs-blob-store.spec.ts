import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalFsBlobStore } from "../src/platform/storage/local-fs-blob-store.adapter";

describe("LocalFsBlobStore", () => {
  let root: string;
  let store: LocalFsBlobStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "blobstore-"));
    store = new LocalFsBlobStore(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("writes then reads back the same bytes", async () => {
    await store.put("kb/kb1/doc1/original.pdf", Buffer.from("hello"));
    const back = await store.get("kb/kb1/doc1/original.pdf");
    expect(back.toString()).toBe("hello");
  });

  it("creates nested directories as needed", async () => {
    await store.put("kb/kb1/doc2/original.md", Buffer.from("# a"));
    const back = await store.get("kb/kb1/doc2/original.md");
    expect(back.toString()).toBe("# a");
  });

  it("deletes a stored blob", async () => {
    await store.put("kb/kb1/doc3/original.txt", Buffer.from("x"));
    await store.delete("kb/kb1/doc3/original.txt");
    await expect(store.get("kb/kb1/doc3/original.txt")).rejects.toThrow();
  });

  it("rejects a key that escapes the storage root via ..", async () => {
    await expect(store.put("../escape.txt", Buffer.from("x"))).rejects.toThrow(/invalid blob key/);
  });

  it("rejects an absolute-path-looking key", async () => {
    await expect(store.put("/etc/passwd", Buffer.from("x"))).rejects.toThrow(/invalid blob key/);
  });
});
