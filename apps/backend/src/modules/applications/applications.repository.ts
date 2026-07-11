import { Inject, Injectable } from "@nestjs/common";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { DRIZZLE } from "../../platform/persistence/drizzle.constants";
import type { DB } from "../../platform/persistence/persistence.module";
import {
  applicationConfigVersionKbs,
  applicationConfigVersions,
  applications,
  type ApplicationConfigVersionRow,
  type ApplicationRow,
  type NewApplication,
  type NewApplicationConfigVersion,
} from "./schema";

export type ApplicationListRow = ApplicationRow & {
  productionVersion: number | null;
  latestVersion: number;
  versionCount: number;
};

const APP_SELECT = {
  id: applications.id,
  slug: applications.slug,
  name: applications.name,
  description: applications.description,
  enabled: applications.enabled,
  productionConfigVersionId: applications.productionConfigVersionId,
  createdBy: applications.createdBy,
  updatedBy: applications.updatedBy,
  createdAt: applications.createdAt,
  updatedAt: applications.updatedAt,
  deletedAt: applications.deletedAt,
  productionVersion: sql<
    number | null
  >`(SELECT version FROM application_config_versions WHERE id = "applications"."production_config_version_id")`.as(
    "production_version",
  ),
  latestVersion:
    sql<number>`COALESCE((SELECT max(version) FROM application_config_versions WHERE application_id = "applications"."id"), 1)`.as(
      "latest_version",
    ),
  versionCount:
    sql<number>`COALESCE((SELECT count(*)::int FROM application_config_versions WHERE application_id = "applications"."id"), 1)`.as(
      "version_count",
    ),
} as const;

@Injectable()
export class ApplicationsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DB) {}

  async findApplications(): Promise<ApplicationListRow[]> {
    return this.db.select(APP_SELECT).from(applications).orderBy(desc(applications.updatedAt));
  }
  async findApplicationById(id: string): Promise<ApplicationListRow | undefined> {
    return (
      await this.db.select(APP_SELECT).from(applications).where(eq(applications.id, id)).limit(1)
    )[0];
  }
  async findBySlug(slug: string): Promise<ApplicationRow | undefined> {
    return (
      await this.db.select().from(applications).where(eq(applications.slug, slug)).limit(1)
    )[0];
  }
  async findByName(name: string): Promise<ApplicationRow | undefined> {
    return (
      await this.db.select().from(applications).where(eq(applications.name, name)).limit(1)
    )[0];
  }
  async findVersions(applicationId: string): Promise<ApplicationConfigVersionRow[]> {
    return this.db
      .select()
      .from(applicationConfigVersions)
      .where(eq(applicationConfigVersions.applicationId, applicationId))
      .orderBy(desc(applicationConfigVersions.version));
  }
  async findVersionById(id: string): Promise<ApplicationConfigVersionRow | undefined> {
    return (
      await this.db
        .select()
        .from(applicationConfigVersions)
        .where(eq(applicationConfigVersions.id, id))
        .limit(1)
    )[0];
  }
  async findVersionKbIds(id: string): Promise<string[]> {
    return (
      await this.db
        .select({ kbId: applicationConfigVersionKbs.kbId })
        .from(applicationConfigVersionKbs)
        .where(eq(applicationConfigVersionKbs.configVersionId, id))
    ).map((r) => r.kbId);
  }
  async findKbIdsByVersionIds(ids: string[]): Promise<Map<string, string[]>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db
      .select({
        versionId: applicationConfigVersionKbs.configVersionId,
        kbId: applicationConfigVersionKbs.kbId,
      })
      .from(applicationConfigVersionKbs)
      .where(inArray(applicationConfigVersionKbs.configVersionId, ids));
    const result = new Map<string, string[]>();
    for (const row of rows)
      result.set(row.versionId, [...(result.get(row.versionId) ?? []), row.kbId]);
    return result;
  }
  async createApplicationWithV1(
    app: NewApplication,
    version: Omit<NewApplicationConfigVersion, "applicationId">,
    kbIds: string[],
  ) {
    return this.db.transaction(async (tx) => {
      const [application] = await tx.insert(applications).values(app).returning();
      const [createdVersion] = await tx
        .insert(applicationConfigVersions)
        .values({ ...version, applicationId: application.id })
        .returning();
      await tx
        .insert(applicationConfigVersionKbs)
        .values(kbIds.map((kbId) => ({ configVersionId: createdVersion.id, kbId })));
      return { application, version: createdVersion };
    });
  }
  async insertVersion(row: NewApplicationConfigVersion, kbIds: string[], actor: string) {
    return this.db.transaction(async (tx) => {
      const [version] = await tx.insert(applicationConfigVersions).values(row).returning();
      await tx
        .insert(applicationConfigVersionKbs)
        .values(kbIds.map((kbId) => ({ configVersionId: version.id, kbId })));
      await tx
        .update(applications)
        .set({ updatedBy: actor, updatedAt: new Date() })
        .where(eq(applications.id, row.applicationId));
      return version;
    });
  }
  async updateBase(
    id: string,
    patch: Partial<Pick<NewApplication, "name" | "description" | "enabled" | "updatedBy">>,
  ) {
    return (
      await this.db
        .update(applications)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(applications.id, id))
        .returning()
    )[0];
  }
  async deleteApplication(id: string): Promise<number> {
    return (
      await this.db
        .delete(applications)
        .where(eq(applications.id, id))
        .returning({ id: applications.id })
    ).length;
  }
  async findPromptUsage(promptVersionIds: string[]) {
    if (promptVersionIds.length === 0) return [];
    const ids = sql`ARRAY[${sql.join(
      promptVersionIds.map((id) => sql`${id}`),
      sql`, `,
    )}]::uuid[]`;
    const result = await this.db.execute(sql`
      SELECT a.id application_id, a.name application_name, v.version config_version,
        CASE WHEN v.prompt_rewrite_version_id = ANY(${ids}) THEN 'rewrite'
             WHEN v.prompt_intent_version_id = ANY(${ids}) THEN 'intent'
             WHEN v.prompt_reply_version_id = ANY(${ids}) THEN 'reply'
             ELSE 'fallback' END node,
        CASE WHEN v.prompt_rewrite_version_id = ANY(${ids}) THEN v.prompt_rewrite_version_id
             WHEN v.prompt_intent_version_id = ANY(${ids}) THEN v.prompt_intent_version_id
             WHEN v.prompt_reply_version_id = ANY(${ids}) THEN v.prompt_reply_version_id
             ELSE v.prompt_fallback_version_id END prompt_version_id
      FROM applications a JOIN application_config_versions v ON v.id = a.production_config_version_id
      WHERE v.prompt_rewrite_version_id = ANY(${ids}) OR v.prompt_intent_version_id = ANY(${ids}) OR v.prompt_reply_version_id = ANY(${ids}) OR v.prompt_fallback_version_id = ANY(${ids})
    `);
    return result.rows as {
      application_id: string;
      application_name: string;
      config_version: number;
      node: string;
      prompt_version_id: string;
    }[];
  }
}
