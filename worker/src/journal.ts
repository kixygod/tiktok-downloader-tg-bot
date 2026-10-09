import { appendFileSync, mkdirSync, existsSync, statSync, renameSync, rmSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { redact } from "./reliability";

export class Journal {
  constructor(private dir: string, private maxBytes = 2 * 1024 * 1024) {
    mkdirSync(dir, { recursive: true });
  }
  write(event: string, fields: Record<string, unknown> = {}): void {
    const line = redact(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));
    console.log(line);
    try {
      const file = join(this.dir, "events.jsonl");
      if (existsSync(file) && statSync(file).size >= this.maxBytes) {
        rmSync(`${file}.3`, { force: true });
        for (let i = 2; i >= 1; i--) {
          if (existsSync(`${file}.${i}`)) renameSync(`${file}.${i}`, `${file}.${i + 1}`);
        }
        renameSync(file, `${file}.1`);
      }
      appendFileSync(file, line + "\n", { mode: 0o600, flush: true });
    } catch (error) { console.error("Persistent journal write failed:", error); }
  }
}

export class StatsOutbox {
  private flushing = false;
  constructor(private dir: string, private deliver: (payload: any) => Promise<void>) {
    mkdirSync(dir, { recursive: true });
  }
  async record(payload: any): Promise<void> {
    const event_id = randomUUID();
    const file = join(this.dir, `${event_id}.json`);
    try {
      writeFileSync(`${file}.tmp`, JSON.stringify({ ...payload, event_id }), { mode: 0o600, flush: true });
      renameSync(`${file}.tmp`, file);
    } catch (error) {
      console.error("Stats outbox write failed:", error);
      try { await this.deliver({ ...payload, event_id }); } catch (e) { console.error("Stats delivery failed:", e); }
      return;
    }
    await this.flush();
  }
  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      for (const name of readdirSync(this.dir).filter(name => name.endsWith(".json")).slice(0, 100)) {
        const file = join(this.dir, name);
        try {
          await this.deliver(JSON.parse(readFileSync(file, "utf8")));
          rmSync(file, { force: true });
        } catch (error) {
          console.error("Stats delivery pending:", error);
          break;
        }
      }
    } finally { this.flushing = false; }
  }
}
