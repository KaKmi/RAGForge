import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { users } from "../modules/users/schema";
import { hashPassword } from "../modules/users/password";
import { normalizeEmail } from "../modules/users/users.service";

const DEMO_EMAIL = normalizeEmail(process.env.DEMO_USER_EMAIL ?? "demo@codecrush.local");
const DEMO_PASSWORD = process.env.DEMO_USER_PASSWORD ?? "CodeCrushDemo123!";
const DEMO_DISPLAY_NAME = process.env.DEMO_USER_DISPLAY_NAME ?? "Demo Admin";

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool);
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  await db
    .insert(users)
    .values({ email: DEMO_EMAIL, displayName: DEMO_DISPLAY_NAME, passwordHash })
    .onConflictDoNothing({ target: users.email });
  await pool.end();
  console.log(`demo user ensured: ${DEMO_EMAIL}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
