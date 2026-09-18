/** Clave estable para `notification_jobs.dedupe_key` (parada + canal + motivo). */
export function notificationDedupeKey(
  paradaId: string,
  channel: string,
  motivo: string,
): string {
  return `${paradaId}:${channel}:${motivo}`;
}
