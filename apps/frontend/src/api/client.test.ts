import {
  apiFetch,
  batchDeleteChunks,
  createKnowledgeBase,
  deleteDocument,
  getDocumentChunks,
  getDocumentContent,
  getDocumentLifecycle,
  getDocuments,
  getKnowledgeBases,
  triggerParse,
  updateDocumentMetadata,
  updateKnowledgeBase,
  uploadDocuments,
} from "./client";

const TOKEN_KEY = "token";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** 装一个类型友好的 fetch mock：返回固定 Response，并把调用参数暴露为 [url, init] 元组。 */
function mockFetch(response: Response) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response);
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function callArgs(
  fetchMock: ReturnType<typeof mockFetch>,
  index = 0,
): [string, RequestInit | undefined] {
  const call = fetchMock.mock.calls[index];
  return [call[0] as string, call[1]];
}

const validKb = {
  id: "kb1",
  name: "KB 1",
  desc: "",
  chunkTemplate: "general" as const,
  embeddingModelId: "m1",
  docsCount: 0,
  chunksCount: 0,
  status: "ready" as const,
  activeVersion: 1,
  buildingVersion: null,
  processingProfileId: null,
  processingProfileVersion: null,
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const validDocument = {
  id: "d1",
  kbId: "kb1",
  name: "a.pdf",
  type: "pdf" as const,
  size: 100,
  chunksCount: 0,
  chunkVersion: null,
  status: "pending" as const,
  metadata: {},
  uploadedAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("apiFetch", () => {
  it("JSON body：自动加 Content-Type: application/json", async () => {
    const fetchMock = mockFetch(jsonResponse({}));
    await apiFetch("/api/x", { method: "POST", body: JSON.stringify({ a: 1 }) });
    const [, init] = callArgs(fetchMock);
    expect((init?.headers as Headers).get("Content-Type")).toBe("application/json");
  });

  it("FormData body：不设 Content-Type（交给浏览器自动带 boundary）", async () => {
    const fetchMock = mockFetch(jsonResponse({}));
    const form = new FormData();
    form.append("files", new Blob(["x"]), "x.txt");
    await apiFetch("/api/x", { method: "POST", body: form });
    const [, init] = callArgs(fetchMock);
    expect((init?.headers as Headers).has("Content-Type")).toBe(false);
  });

  it("附带 Authorization header（来自 localStorage token）", async () => {
    localStorage.setItem(TOKEN_KEY, "tok-abc");
    const fetchMock = mockFetch(jsonResponse({}));
    await apiFetch("/api/x");
    const [, init] = callArgs(fetchMock);
    expect((init?.headers as Headers).get("Authorization")).toBe("Bearer tok-abc");
  });
});

describe("knowledge-bases", () => {
  it("getKnowledgeBases 请求 /api/knowledge-bases", async () => {
    const fetchMock = mockFetch(jsonResponse([validKb]));
    const result = await getKnowledgeBases();
    const [url] = callArgs(fetchMock);
    expect(url).toBe("/api/knowledge-bases");
    expect(result).toEqual([validKb]);
  });

  it("createKnowledgeBase POST /api/knowledge-bases，请求体经 Zod 校验", async () => {
    const fetchMock = mockFetch(jsonResponse(validKb, 201));
    const result = await createKnowledgeBase({
      name: "KB 1",
      desc: "",
      chunkTemplate: "general",
      embeddingModelId: "m1",
    });
    const [url, init] = callArgs(fetchMock);
    expect(url).toBe("/api/knowledge-bases");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toMatchObject({ name: "KB 1" });
    expect(result).toEqual(validKb);
  });

  it("updateKnowledgeBase PATCH /api/knowledge-bases/:id", async () => {
    const fetchMock = mockFetch(jsonResponse(validKb));
    await updateKnowledgeBase("kb1", { name: "New" });
    const [url, init] = callArgs(fetchMock);
    expect(url).toBe("/api/knowledge-bases/kb1");
    expect(init?.method).toBe("PATCH");
  });

  it("updateKnowledgeBase 非 2xx 时抛错", async () => {
    mockFetch(new Response("err", { status: 500, statusText: "Internal Error" }));
    await expect(updateKnowledgeBase("kb1", { name: "New" })).rejects.toThrow(/500/);
  });
});

describe("documents", () => {
  it("getDocuments 用 kbId query param", async () => {
    const fetchMock = mockFetch(jsonResponse([validDocument]));
    await getDocuments("kb1");
    const [url] = callArgs(fetchMock);
    expect(url).toBe("/api/documents?kbId=kb1");
  });

  it("uploadDocuments 走 multipart，字段名 files/autoParse，不带 Content-Type", async () => {
    const fetchMock = mockFetch(jsonResponse([validDocument]));
    const file = new File(["hello"], "a.pdf", { type: "application/pdf" });
    const result = await uploadDocuments("kb1", [file], { autoParse: true });

    const [url, init] = callArgs(fetchMock);
    expect(url).toBe("/api/knowledge-bases/kb1/documents");
    expect(init?.method).toBe("POST");
    const form = init?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("files")).toBeInstanceOf(File);
    expect(form.get("autoParse")).toBe("true");
    expect((init?.headers as Headers).has("Content-Type")).toBe(false);
    expect(result).toEqual([validDocument]);
  });

  it("triggerParse POST /api/documents/:id/parse", async () => {
    const fetchMock = mockFetch(jsonResponse(validDocument));
    await triggerParse("d1");
    const [url, init] = callArgs(fetchMock);
    expect(url).toBe("/api/documents/d1/parse");
    expect(init?.method).toBe("POST");
  });

  it("getDocumentLifecycle GET /api/documents/:id/lifecycle", async () => {
    const fetchMock = mockFetch(jsonResponse({ documentId: "d1", stages: [] }));
    await getDocumentLifecycle("d1");
    const [url] = callArgs(fetchMock);
    expect(url).toBe("/api/documents/d1/lifecycle");
  });

  it("updateDocumentMetadata PATCH /api/documents/:id/metadata", async () => {
    const fetchMock = mockFetch(jsonResponse(validDocument));
    await updateDocumentMetadata("d1", { metadata: { author: "x" } });
    const [url, init] = callArgs(fetchMock);
    expect(url).toBe("/api/documents/d1/metadata");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(init?.body as string)).toEqual({ metadata: { author: "x" } });
  });

  it("deleteDocument DELETE /api/documents/:id", async () => {
    const fetchMock = mockFetch(new Response(null, { status: 204 }));
    await deleteDocument("d1");
    const [url, init] = callArgs(fetchMock);
    expect(url).toBe("/api/documents/d1");
    expect(init?.method).toBe("DELETE");
  });

  it("getDocumentContent GET /api/documents/:id/content", async () => {
    const fetchMock = mockFetch(jsonResponse({ documentId: "d1", text: "hi" }));
    const result = await getDocumentContent("d1");
    const [url] = callArgs(fetchMock);
    expect(url).toBe("/api/documents/d1/content");
    expect(result).toEqual({ documentId: "d1", text: "hi" });
  });
});

describe("chunks", () => {
  it("getDocumentChunks 序列化分页参数 offset/limit/q", async () => {
    const fetchMock = mockFetch(
      jsonResponse({ items: [], total: 0, offset: 20, limit: 10, hasMore: false }),
    );
    await getDocumentChunks("d1", { offset: 20, limit: 10, q: "foo" });
    const [url] = callArgs(fetchMock);
    expect(url).toBe("/api/documents/d1/chunks?offset=20&limit=10&q=foo");
  });

  it("getDocumentChunks 省略 q 时不带该参数", async () => {
    const fetchMock = mockFetch(
      jsonResponse({ items: [], total: 0, offset: 0, limit: 20, hasMore: false }),
    );
    await getDocumentChunks("d1", { offset: 0, limit: 20 });
    const [url] = callArgs(fetchMock);
    expect(url).toBe("/api/documents/d1/chunks?offset=0&limit=20");
  });

  it("batchDeleteChunks POST /api/chunks/batch-delete", async () => {
    const fetchMock = mockFetch(jsonResponse({ deletedCount: 2 }));
    const result = await batchDeleteChunks({ ids: ["c1", "c2"] });
    const [url, init] = callArgs(fetchMock);
    expect(url).toBe("/api/chunks/batch-delete");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({ ids: ["c1", "c2"] });
    expect(result).toEqual({ deletedCount: 2 });
  });
});
