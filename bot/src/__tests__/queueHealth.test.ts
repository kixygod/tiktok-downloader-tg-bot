import { describe, expect, it } from "vitest";
import { redisStorageError } from "../queueHealth";

describe("Redis queue storage health", () => {
  it("reports the AOF write failure that blocks delayed jobs", () => {
    expect(redisStorageError("# Persistence\r\naof_enabled:1\r\naof_last_write_status:err\r\n"))
      .toContain("Очередь остановлена");
  });

  it("clears the warning after Redis resumes writing", () => {
    expect(redisStorageError("aof_enabled:1\r\naof_last_write_status:ok\r\n"))
      .toBeNull();
  });

  it("ignores a stale AOF status when AOF persistence is disabled", () => {
    expect(redisStorageError("aof_enabled:0\r\naof_last_write_status:err\r\n"))
      .toBeNull();
  });
});
