import { Pool } from "pg";

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export async function initDB(): Promise<void> {
  const MAX_RETRIES = 20;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS jobs (
          id            SERIAL PRIMARY KEY,
          ts            BIGINT NOT NULL,
          url           TEXT NOT NULL,
          chat_id       BIGINT NOT NULL,
          user_id       BIGINT,
          username      TEXT,
          first_name    TEXT,
          platform      TEXT,
          status        TEXT NOT NULL,
          bytes         BIGINT NOT NULL DEFAULT 0,
          duration_ms   INTEGER NOT NULL DEFAULT 0,
          error_message TEXT,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_jobs_ts ON jobs (ts);
        CREATE INDEX IF NOT EXISTS idx_jobs_chat_id ON jobs (chat_id);
        CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status);
        CREATE INDEX IF NOT EXISTS idx_jobs_platform ON jobs (platform);
        CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs (created_at);
        CREATE INDEX IF NOT EXISTS idx_jobs_ts_status ON jobs (ts, status);
      `);
      console.log("✅ PostgreSQL tables initialized");
      return;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(
        `⏳ PostgreSQL not ready (attempt ${attempt}/${MAX_RETRIES}): ${message}`
      );
      if (attempt === MAX_RETRIES) throw err;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}
