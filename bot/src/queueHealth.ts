export function redisStorageError(persistenceInfo: string): string | null {
  if (
    /^aof_enabled:1\r?$/m.test(persistenceInfo) &&
    /^aof_last_write_status:err\r?$/m.test(persistenceInfo)
  ) {
    return "Очередь остановлена: Redis не может записать журнал. Проверьте свободное место на сервере.";
  }
  return null;
}
