import { AnswerRelevancyEvaluator } from "../src/modules/evaluations/answer-relevancy.evaluator";
import { ContextPrecisionEvaluator } from "../src/modules/evaluations/context-precision.evaluator";
import { EvaluationJudgeService } from "../src/modules/evaluations/evaluation-judge.service";
import { withJudgeRetry } from "../src/modules/evaluations/evaluation-judge.utils";
import { FaithfulnessEvaluator } from "../src/modules/evaluations/faithfulness.evaluator";
import type { ModelsService } from "../src/modules/models/models.service";

const inputWithThreeContexts = {
  targetTraceId: "a".repeat(32),
  question: "退款期限多久",
  answer: "七天内可退款并自动到账",
  contexts: [
    { chunkId: "c1", text: "七天内可申请退款", finalScore: 0.9 },
    { chunkId: "c2", text: "发票说明", finalScore: 0.8 },
    { chunkId: "c3", text: "退款入口在订单页", finalScore: 0.7 },
  ],
};
const inputWithoutContexts = { ...inputWithThreeContexts, answer: "你好", contexts: [] };
const modelIds = { judgeModelId: "judge-1", embeddingModelId: "embed-1" };

describe("EvaluationJudgeService", () => {
  let models: { chat: jest.Mock; embedTexts: jest.Mock };
  let judge: EvaluationJudgeService;

  beforeEach(() => {
    models = { chat: jest.fn(), embedTexts: jest.fn() };
    const faithfulness = new FaithfulnessEvaluator(models as unknown as ModelsService);
    const relevancy = new AnswerRelevancyEvaluator(models as unknown as ModelsService);
    const precision = new ContextPrecisionEvaluator(models as unknown as ModelsService);
    judge = new EvaluationJudgeService(faithfulness, relevancy, precision);
  });

  it("computes claim support, reverse-question cosine and ranked average precision", async () => {
    models.chat
      .mockResolvedValueOnce({
        content: JSON.stringify({
          claims: [
            { claim: "七天内可退款", supported: true, reason: "context 1" },
            { claim: "自动到账", supported: false, reason: "not present" },
          ],
        }),
      })
      .mockResolvedValueOnce({ content: JSON.stringify({ questions: ["退款期限多久"] }) })
      .mockResolvedValueOnce({
        content: JSON.stringify({
          judgments: [
            { chunkId: "c1", relevant: true, reason: "answers deadline" },
            { chunkId: "c2", relevant: false, reason: "unrelated" },
            { chunkId: "c3", relevant: true, reason: "refund path" },
          ],
        }),
      });
    models.embedTexts.mockResolvedValue([
      [1, 0],
      [0.8, 0.6],
    ]);

    const result = await judge.score(inputWithThreeContexts, modelIds);

    expect(result).toMatchObject({
      faithfulness: 50,
      answerRelevancy: 80,
      contextPrecision: 83,
    });
    expect(result.evidence.faithfulness).toEqual(["context 1", "not present"]);
    expect(result.evidence.answerRelevancy).toEqual(["退款期限多久"]);
    expect(result.evidence.contextPrecision).toEqual([
      "answers deadline",
      "unrelated",
      "refund path",
    ]);
    expect(models.chat.mock.calls.every((call) => call[2]?.temperature === 0)).toBe(true);
    expect(models.embedTexts).toHaveBeenCalledWith("embed-1", ["退款期限多久", "退款期限多久"]);
    expect(models.chat.mock.calls.every((call) => call[2]?.structuredOutput?.strict === true)).toBe(
      true,
    );

    const faithfulnessSchema = models.chat.mock.calls[0][2].structuredOutput.schema;
    expect(faithfulnessSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["claims"],
      properties: {
        claims: {
          type: "array",
          maxItems: 20,
          items: {
            type: "object",
            additionalProperties: false,
            properties: { reason: { type: "string", minLength: 1, maxLength: 300 } },
          },
        },
      },
    });
    const relevancySchema = models.chat.mock.calls[1][2].structuredOutput.schema;
    expect(relevancySchema).toMatchObject({
      properties: {
        questions: {
          type: "array",
          minItems: 1,
          maxItems: 3,
          items: { type: "string", minLength: 1, maxLength: 300 },
        },
      },
    });
    const precisionSchema = models.chat.mock.calls[2][2].structuredOutput.schema;
    expect(precisionSchema).toMatchObject({
      properties: {
        judgments: {
          type: "array",
          minItems: 3,
          maxItems: 3,
          items: {
            type: "object",
            additionalProperties: false,
            properties: { reason: { type: "string", minLength: 1, maxLength: 300 } },
          },
        },
      },
    });
  });

  it("returns 100 faithfulness for no factual claims and zero precision for no contexts", async () => {
    models.chat.mockResolvedValueOnce({ content: JSON.stringify({ claims: [] }) });
    models.chat.mockResolvedValueOnce({ content: JSON.stringify({ questions: ["你好"] }) });
    models.embedTexts.mockResolvedValue([
      [1, 0],
      [1, 0],
    ]);

    const result = await judge.score(inputWithoutContexts, modelIds);

    expect(result.faithfulness).toBe(100);
    expect(result.contextPrecision).toBe(0);
    expect(result.evidence.faithfulness).toHaveLength(1);
    expect(result.evidence.contextPrecision).toHaveLength(1);
    expect(models.chat).toHaveBeenCalledTimes(2);
  });

  it("scores factual claims with no context as zero even if the model marks them supported", async () => {
    models.chat.mockResolvedValueOnce({
      content: JSON.stringify({
        claims: [{ claim: "自动到账", supported: true, reason: "unsupported model assertion" }],
      }),
    });
    const evaluator = new FaithfulnessEvaluator(models as unknown as ModelsService);

    const result = await evaluator.score(
      { ...inputWithoutContexts, answer: "退款会自动到账" },
      "judge-1",
    );

    expect(result.score).toBe(0);
  });

  it("retries one invalid metric response once then fails the whole evaluation", async () => {
    models.chat.mockResolvedValue({ content: "not-json" });

    await expect(judge.score(inputWithThreeContexts, modelIds)).rejects.toThrow(
      "faithfulness judge output invalid after retry",
    );
    expect(models.chat).toHaveBeenCalledTimes(2);
    expect(models.embedTexts).not.toHaveBeenCalled();
  });

  it("retries a provider rejection and succeeds on the second attempt", async () => {
    models.chat
      .mockRejectedValueOnce(new Error("provider timeout"))
      .mockResolvedValueOnce({ content: JSON.stringify({ claims: [] }) });
    const evaluator = new FaithfulnessEvaluator(models as unknown as ModelsService);

    await expect(evaluator.score(inputWithThreeContexts, "judge-1")).resolves.toMatchObject({
      score: 100,
    });
    expect(models.chat).toHaveBeenCalledTimes(2);
  });

  it("does not retry an unknown internal programming error", async () => {
    const attempt = jest.fn(async () => {
      throw new TypeError("internal invariant broken");
    });

    await expect(withJudgeRetry("faithfulness", attempt)).rejects.toThrow(
      "internal invariant broken",
    );
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("rejects overlong evidence after one retry", async () => {
    models.chat.mockResolvedValue({
      content: JSON.stringify({
        claims: [{ claim: "x", supported: true, reason: "x".repeat(301) }],
      }),
    });

    await expect(judge.score(inputWithThreeContexts, modelIds)).rejects.toThrow(
      "faithfulness judge output invalid after retry",
    );
    expect(models.chat).toHaveBeenCalledTimes(2);
  });

  it("rejects context judgments that do not preserve ranked input order", async () => {
    models.chat.mockResolvedValue({
      content: JSON.stringify({
        judgments: [
          { chunkId: "c2", relevant: true, reason: "wrong order" },
          { chunkId: "c1", relevant: true, reason: "wrong order" },
          { chunkId: "c3", relevant: false, reason: "ok" },
        ],
      }),
    });
    const evaluator = new ContextPrecisionEvaluator(models as unknown as ModelsService);

    await expect(evaluator.score(inputWithThreeContexts, "judge-1")).rejects.toThrow(
      "context precision judge output invalid after retry",
    );
    expect(models.chat).toHaveBeenCalledTimes(2);
  });

  it("maps negative and zero-vector cosine to zero and retries malformed embeddings", async () => {
    models.chat
      .mockResolvedValueOnce({ content: JSON.stringify({ questions: ["反向问题"] }) })
      .mockResolvedValueOnce({ content: JSON.stringify({ questions: ["反向问题"] }) });
    models.embedTexts.mockResolvedValueOnce([[1, 0]]).mockResolvedValueOnce([
      [0, 0],
      [1, 0],
    ]);
    const evaluator = new AnswerRelevancyEvaluator(models as unknown as ModelsService);

    await expect(evaluator.score(inputWithThreeContexts, modelIds)).resolves.toMatchObject({
      score: 0,
    });
    expect(models.chat).toHaveBeenCalledTimes(2);
    expect(models.embedTexts).toHaveBeenCalledTimes(2);

    models.chat.mockReset().mockResolvedValue({
      content: JSON.stringify({ questions: ["反向问题"] }),
    });
    models.embedTexts.mockReset().mockResolvedValue([
      [1, 0],
      [-1, 0],
    ]);
    await expect(evaluator.score(inputWithThreeContexts, modelIds)).resolves.toMatchObject({
      score: 0,
    });
  });

  it("clamps each reverse-question cosine before averaging", async () => {
    models.chat.mockResolvedValue({
      content: JSON.stringify({ questions: ["同向问题", "反向问题"] }),
    });
    models.embedTexts.mockResolvedValue([
      [1, 0],
      [1, 0],
      [-1, 0],
    ]);
    const evaluator = new AnswerRelevancyEvaluator(models as unknown as ModelsService);

    await expect(evaluator.score(inputWithThreeContexts, modelIds)).resolves.toMatchObject({
      score: 50,
    });
  });
});
