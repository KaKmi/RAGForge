import { RetrievalService } from "../src/modules/retrieval/retrieval.service";
import type { RetrieverPort } from "../src/modules/retrieval/ports/retriever.port";

describe("RetrievalService.test", () => {
  it("调用注入的 RetrieverPort.retrieve，把结果包进 {hits}", async () => {
    const hit = {
      chunkId: "c1",
      docId: "d1",
      docName: "d.pdf",
      text: "t",
      section: "s",
      vecScore: 0.9,
      finalScore: 0.9,
    };
    const port: RetrieverPort = { retrieve: jest.fn(async () => [hit]) };
    const svc = new RetrievalService(port);
    const req = {
      query: "q",
      kbId: "kb1",
      embedModelId: "m2",
      topK: 10,
      threshold: 0.2,
      multi: true,
    };
    const res = await svc.test(req);
    expect(port.retrieve).toHaveBeenCalledWith(req);
    expect(res).toEqual({ hits: [hit] });
  });
});
