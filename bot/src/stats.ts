import { pool } from "./db";
import type { StatsBody } from "./types";

export async function insertStat(body: StatsBody): Promise<void> {
  const {
    ts,
    url,
    status,
    bytes,
    duration_ms,
    chat_id,
    source_message_id,
    source_thread_id,
    user_id,
    username,
    first_name,
    platform,
    error_message,
    event_id,
  } = body;

  await pool.query(
    `INSERT INTO jobs (ts, url, chat_id, source_message_id, source_thread_id, user_id, username, first_name, platform, status, bytes, duration_ms, error_message, event_id)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
   ON CONFLICT (event_id) DO NOTHING`,
    [
      ts,
      url,
      chat_id,
      source_message_id ?? null,
      source_thread_id ?? null,
      user_id ?? null,
      username ?? null,
      first_name ?? null,
      platform ?? null,
      status,
      bytes,
      duration_ms,
      error_message ?? null,
      event_id ?? null,
    ],
  );
}
