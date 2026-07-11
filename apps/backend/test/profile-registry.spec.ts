import {
  PROCESSING_PROFILES,
  ProfileRegistry,
  chunkTemplateToProfileRef,
} from "../src/modules/ingestion/profiles/profile-registry";

describe("ProfileRegistry", () => {
  const registry = new ProfileRegistry(PROCESSING_PROFILES);

  it("注册首批三个唯一 Profile", () => {
    const ids = PROCESSING_PROFILES.map((profile) => `${profile.id}@${profile.version}`);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(
      expect.arrayContaining(["general-v1@1", "faq-v1@1", "course-wechat-v1@1"]),
    );
  });

  it("get 命中精确版本，latest 返回同 id 的最高版本", () => {
    expect(registry.get("general-v1", 1)?.chunker.id).toBe("general");
    expect(registry.get("general-v1", 99)).toBeUndefined();
    expect(registry.get("missing", 1)).toBeUndefined();
    expect(registry.latest("general-v1")?.version).toBe(1);
  });

  it("listForType 过滤格式且不泄露内部质量门", () => {
    const descriptors = registry.listForType("pdf");
    expect(descriptors.map((profile) => profile.id)).toEqual(
      expect.arrayContaining(["general-v1", "faq-v1", "course-wechat-v1"]),
    );
    expect(descriptors[0]).toHaveProperty("summary");
    expect(descriptors[0]).not.toHaveProperty("qualityGate");
  });

  it("每个旧 chunkTemplate 都能反查到已注册 Profile", () => {
    for (const template of ["general", "qa", "custom"] as const) {
      const ref = chunkTemplateToProfileRef(template);
      expect(registry.get(ref.profileId, ref.profileVersion)).toBeDefined();
    }
    expect(chunkTemplateToProfileRef("custom").profileId).toBe("course-wechat-v1");
  });

  it("课程 Profile 使用明确的业务展示名", () => {
    expect(registry.get("course-wechat-v1", 1)?.label).toBe("课程/公众号文章");
  });

  it("构造时拒绝重复版本、未知组件与空 supportedTypes", () => {
    const base = PROCESSING_PROFILES[0];
    const known = { chunkers: ["general", "qa", "custom"], normalizers: ["markdown-basic"] };
    expect(() => new ProfileRegistry([base, base], known)).toThrow(/重复注册/);
    expect(
      () =>
        new ProfileRegistry(
          [{ ...base, chunker: { id: "missing" as never, config: {} } }],
          known,
        ),
    ).toThrow(/未注册 chunker/);
    expect(
      () =>
        new ProfileRegistry(
          [{ ...base, normalizers: [{ id: "missing", config: {} }] }],
          known,
        ),
    ).toThrow(/未注册 normalizer/);
    expect(() => new ProfileRegistry([{ ...base, supportedTypes: [] }], known)).toThrow(
      /supportedTypes/,
    );
  });
});
