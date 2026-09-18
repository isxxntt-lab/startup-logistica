import type { SqlClient } from "./types.js";

export async function ensureOpenAttempt(
  db: SqlClient,
  opts: { paradaId: string; at?: string; orderId?: string | null },
): Promise<void> {
  const at = opts.at ?? new Date().toISOString();
  await db.query(
    `INSERT INTO delivery_attempts (
       parada_id, attempt_number, started_at, status,
       geofence_entered_at, failure_avoided_candidate, recipient_status
     )
     SELECT $1,
            coalesce((SELECT max(attempt_number) FROM delivery_attempts WHERE parada_id = $1), 0) + 1,
            $2::timestamptz,
            'open',
            $2::timestamptz,
            false,
            'pending'
     WHERE NOT EXISTS (
       SELECT 1 FROM delivery_attempts WHERE parada_id = $1 AND status = 'open'
     )`,
    [opts.paradaId, at],
  );
  await db.query(
    `UPDATE delivery_attempts
     SET geofence_entered_at = coalesce(geofence_entered_at, $2::timestamptz)
     WHERE parada_id = $1 AND status = 'open'`,
    [opts.paradaId, at],
  );
}

export async function closeAttemptDwell(
  db: SqlClient,
  opts: {
    paradaId: string;
    dwellSeconds: number;
    closedBy: "delivered" | "exited";
  },
): Promise<void> {
  await db.query(
    `UPDATE delivery_attempts
     SET dwell_seconds = coalesce(dwell_seconds, $2),
         geofence_dwell_seconds = coalesce(geofence_dwell_seconds, $2),
         dwell_closed_by = coalesce(dwell_closed_by, $3)
     WHERE parada_id = $1
       AND status = 'open'
       AND dwell_closed_by IS NULL`,
    [opts.paradaId, opts.dwellSeconds, opts.closedBy],
  );
}

export async function markApproachNotified(
  db: SqlClient,
  opts: { paradaId: string; at?: string },
): Promise<void> {
  const at = opts.at ?? new Date().toISOString();
  await ensureOpenAttempt(db, { paradaId: opts.paradaId, at });
  await db.query(
    `UPDATE delivery_attempts
     SET approach_notified_at = coalesce(approach_notified_at, $2::timestamptz),
         failure_avoided_candidate = true
     WHERE parada_id = $1 AND status = 'open'`,
    [opts.paradaId, at],
  );
}

export async function markRecipientResponse(
  db: SqlClient,
  opts: {
    paradaId: string;
    recipientStatus: "confirmed" | "rescheduled" | "absent";
    closeAttempt?: boolean;
  },
): Promise<void> {
  await db.query(
    `UPDATE delivery_attempts
     SET recipient_status = $2,
         status = CASE
           WHEN $3 AND $2 = 'rescheduled' THEN 'rescheduled'
           ELSE status
         END,
         completed_at = CASE
           WHEN $3 AND $2 = 'rescheduled' THEN now()
           ELSE completed_at
         END
     WHERE parada_id = $1 AND status = 'open'`,
    [opts.paradaId, opts.recipientStatus, opts.closeAttempt ?? false],
  );
}

export async function completeOpenAttempt(
  db: SqlClient,
  opts: {
    paradaId: string;
    status: "delivered" | "failed" | "rescheduled";
    failureReason?: string | null;
    failureAvoided: boolean;
    avoidanceChannel?: string | null;
    dwellSeconds?: number | null;
  },
): Promise<{ attemptNumber: number }> {
  const updated = await db.query<{ attempt_number: number }>(
    `UPDATE delivery_attempts
     SET completed_at = now(),
         status = $2,
         failure_reason = $3,
         failure_avoided = $4,
         avoidance_channel = $5,
         dwell_seconds = coalesce($6, dwell_seconds),
         geofence_dwell_seconds = coalesce($6, geofence_dwell_seconds, dwell_seconds),
         dwell_closed_by = CASE
           WHEN $2 = 'delivered' THEN coalesce(dwell_closed_by, 'delivered')
           ELSE dwell_closed_by
         END
     WHERE parada_id = $1 AND status = 'open'
     RETURNING attempt_number`,
    [
      opts.paradaId,
      opts.status,
      opts.failureReason ?? null,
      opts.failureAvoided,
      opts.avoidanceChannel ?? null,
      opts.dwellSeconds ?? null,
    ],
  );
  if (updated.rows[0]) {
    return { attemptNumber: Number(updated.rows[0].attempt_number) };
  }

  const { rows: n } = await db.query<{ n: number }>(
    `SELECT coalesce(max(attempt_number), 0) + 1 AS n FROM delivery_attempts WHERE parada_id = $1`,
    [opts.paradaId],
  );
  const attemptNumber = Number(n[0]?.n ?? 1);
  await db.query(
    `INSERT INTO delivery_attempts (
       parada_id, attempt_number, completed_at, status, failure_reason,
       failure_avoided, failure_avoided_candidate, avoidance_channel,
       geofence_dwell_seconds, dwell_seconds, dwell_closed_by
     ) VALUES ($1,$2,now(),$3,$4,$5,$6,$7,$8,$8,$9)`,
    [
      opts.paradaId,
      attemptNumber,
      opts.status,
      opts.failureReason ?? null,
      opts.failureAvoided,
      opts.failureAvoided,
      opts.avoidanceChannel ?? null,
      opts.dwellSeconds ?? null,
      opts.status === "delivered" && opts.dwellSeconds != null ? "delivered" : null,
    ],
  );
  return { attemptNumber };
}
