import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { DRIZZLE } from "../../platform/persistence/drizzle.constants";
import type { DB } from "../../platform/persistence/persistence.module";
import { users, type UserRow } from "./schema";

@Injectable()
export class UsersRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DB) {}

  async findById(id: string): Promise<UserRow | undefined> {
    const rows = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    return rows[0];
  }

  async findByEmail(normalizedEmail: string): Promise<UserRow | undefined> {
    const rows = await this.db.select().from(users).where(eq(users.email, normalizedEmail)).limit(1);
    return rows[0];
  }

  async updatePasswordHash(id: string, passwordHash: string): Promise<void> {
    await this.db
      .update(users)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(users.id, id));
  }
}
