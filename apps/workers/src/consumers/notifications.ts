import {
  assertTransicion,
  plantillaParaMotivo,
  renderPlantilla,
  repartidorChannel,
  type PlantillaId,
  type NotificationRequested,
} from "@startup-logistica/shared";
import {
  currentCorrelationId,
  logOps,
  markApproachNotified,
  nextNotificationChannel,
  type NotificationChannel,
  type NotificationJobStatus,
} from "@startup-logistica/shared/ops";
import { pool } from "../db.js";
import { firmarTokenCliente } from "../jwt.js";
import { redis } from "../redis.js";
import { asChannel, destinationForChannel, planForParada } from "./notification-plan.js";

export { planForParada, asChannel, destinationForChannel };

const publicWebUrl = process.env.PUBLIC_WEB_URL ?? "http://localhost:5173";
const twilioSid = process.env.TWILIO_ACCOUNT_SID ?? "";
const twilioToken = process.env.TWILIO_AUTH_TOKEN ?? "";
const twilioFrom = process.env.TWILIO_WHATSAPP_FROM ?? "";
const twilioSmsFrom = process.env.TWILIO_SMS_FROM ?? "";

type SendResult =
  | { ok: true; proveedorMessageId: string; dryRun: boolean }
  | { ok: false; errorCode: string; error: string };

type ProcessOutcome = "sent" | "deferred" | "skipped";

export type NotificationHandleOptions = {
  now?: Date;
  resumeJobId?: string;
};

function eventoTipo(channel: NotificationChannel): "whatsapp" | "sms" | "push_repartidor" {
  if (channel === "sms") return "sms";
  if (channel === "app") return "push_repartidor";
  return "whatsapp";
}

function eventoProveedor(channel: NotificationChannel): "twilio" | "fcm" {
  return channel === "app" ? "fcm" : "twilio";
}

async function loadJobByDedupe(dedupeKey: string): Promise<{
  id: string;
  status: NotificationJobStatus;
  next_retry_at: string | null;
} | null> {
  const { rows } = await pool.query<{
    id: string;
    status: NotificationJobStatus;
    next_retry_at: string | null;
  }>(
    `SELECT id::text, status, next_retry_at::text
     FROM notification_jobs
     WHERE dedupe_key = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [dedupeKey],
  );
  return rows[0] ?? null;
}

async function insertJob(opts: {
  paradaId: string;
  orderId: string;
  channel: NotificationChannel;
  status?: NotificationJobStatus;
  dedupeKey: string;
  fallbackOfJobId?: string | null;
  nextChannel: NotificationChannel | null;
  correlationId: string;
  payload: Record<string, unknown>;
  nextRetryAt?: Date | null;
  errorCode?: string | null;
}): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO notification_jobs (
       parada_id, order_id, channel, status, fallback_of_job_id, next_channel,
       dedupe_key, correlation_id, payload, next_retry_at, error_code
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)
     RETURNING id::text`,
    [
      opts.paradaId,
      opts.orderId,
      opts.channel,
      opts.status ?? "pending",
      opts.fallbackOfJobId ?? null,
      opts.nextChannel,
      opts.dedupeKey,
      opts.correlationId,
      JSON.stringify(opts.payload),
      opts.nextRetryAt?.toISOString() ?? null,
      opts.errorCode ?? null,
    ],
  );
  return rows[0].id;
}

async function updateJob(
  id: string,
  patch: {
    status: NotificationJobStatus;
    errorCode?: string | null;
    payload?: Record<string, unknown>;
    nextRetryAt?: Date | null;
  },
) {
  await pool.query(
    `UPDATE notification_jobs
     SET status = $2,
         error_code = COALESCE($3, error_code),
         payload = CASE WHEN $4::jsonb IS NULL THEN payload ELSE payload || $4::jsonb END,
         next_retry_at = CASE WHEN $5::timestamptz IS NULL AND $6::boolean THEN next_retry_at ELSE $5::timestamptz END,
         updated_at = now()
     WHERE id = $1`,
    [
      id,
      patch.status,
      patch.errorCode ?? null,
      patch.payload ? JSON.stringify(patch.payload) : null,
      patch.nextRetryAt !== undefined ? patch.nextRetryAt?.toISOString() ?? null : null,
      patch.nextRetryAt === undefined,
    ],
  );
}

async function sendChannel(
  channel: NotificationChannel,
  to: string,
  texto: string,
): Promise<SendResult> {
  if (channel === "whatsapp") {
    if (twilioSid && twilioToken && twilioFrom) {
      const body = new URLSearchParams({
        To: `whatsapp:${to}`,
        From: twilioFrom,
        Body: texto,
      });
      const res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`,
        {
          method: "POST",
          headers: {
            Authorization:
              "Basic " + Buffer.from(`${twilioSid}:${twilioToken}`).toString("base64"),
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body,
        },
      );
      const json = (await res.json()) as { sid?: string; message?: string; code?: number };
      if (!res.ok || !json.sid) {
        return {
          ok: false,
          errorCode: String(json.code ?? res.status),
          error: json.message ?? `twilio ${res.status}`,
        };
      }
      return { ok: true, proveedorMessageId: json.sid, dryRun: false };
    }
    const id = `dryrun-wa-${Date.now()}`;
    console.log("[notif dry-run]", { channel, to, texto });
    return { ok: true, proveedorMessageId: id, dryRun: true };
  }

  if (channel === "sms") {
    if (twilioSid && twilioToken && twilioSmsFrom) {
      const body = new URLSearchParams({
        To: to,
        From: twilioSmsFrom,
        Body: texto,
      });
      const res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`,
        {
          method: "POST",
          headers: {
            Authorization:
              "Basic " + Buffer.from(`${twilioSid}:${twilioToken}`).toString("base64"),
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body,
        },
      );
      const json = (await res.json()) as { sid?: string; message?: string; code?: number };
      if (!res.ok || !json.sid) {
        return {
          ok: false,
          errorCode: String(json.code ?? res.status),
          error: json.message ?? `twilio ${res.status}`,
        };
      }
      return { ok: true, proveedorMessageId: json.sid, dryRun: false };
    }
    if (!twilioSid || !twilioToken) {
      const id = `dryrun-sms-${Date.now()}`;
      console.log("[notif dry-run]", { channel, to, texto });
      return { ok: true, proveedorMessageId: id, dryRun: true };
    }
    return { ok: false, errorCode: "NO_SMS_PROVIDER", error: "TWILIO_SMS_FROM ausente" };
  }

  if (channel === "app") {
    if (!to) {
      return { ok: false, errorCode: "NO_PUSH_TOKEN", error: "sin device_push_token" };
    }
    const id = `dryrun-app-${Date.now()}`;
    console.log("[notif dry-run]", { channel, to, texto });
    return { ok: true, proveedorMessageId: id, dryRun: true };
  }

  return { ok: false, errorCode: "UNSUPPORTED_CHANNEL", error: `canal ${channel} no soportado` };
}

async function recordSkipJob(opts: {
  parada: Record<string, unknown>;
  event: NotificationRequested;
  channel: NotificationChannel;
  reason: string;
  fallbackOfJobId?: string | null;
  payloadBase: Record<string, unknown>;
}): Promise<void> {
  const orderId = String(opts.parada.referencia_pedido ?? opts.parada.id);
  const correlationId = currentCorrelationId() ?? crypto.randomUUID();
  const dedupeKey = `${opts.parada.id}:${opts.channel}:${opts.event.motivo}`;
  const existing = await loadJobByDedupe(dedupeKey);
  if (existing) return;
  const jobId = await insertJob({
    paradaId: String(opts.parada.id),
    orderId,
    channel: opts.channel,
    status: "skipped",
    dedupeKey,
    fallbackOfJobId: opts.fallbackOfJobId,
    nextChannel: nextNotificationChannel(opts.channel),
    correlationId,
    payload: { ...opts.payloadBase, channel: opts.channel, reason: opts.reason },
    errorCode: opts.reason.toUpperCase(),
  });
  await logOps({
    level: "info",
    category: "notification_fallback",
    event: "notification.skipped",
    orderId,
    correlationId,
    actor: "worker",
    payload: {
      channel: opts.channel,
      next_channel: nextNotificationChannel(opts.channel),
      dedupe_key: dedupeKey,
      status: "skipped",
      reason: opts.reason,
      job_id: jobId,
    },
  });
}

async function recordDeferredJob(opts: {
  parada: Record<string, unknown>;
  event: NotificationRequested;
  channel: NotificationChannel;
  nextRetryAt: Date;
  fallbackOfJobId?: string | null;
  payloadBase: Record<string, unknown>;
  resumeJobId?: string;
}): Promise<void> {
  const orderId = String(opts.parada.referencia_pedido ?? opts.parada.id);
  const correlationId = currentCorrelationId() ?? crypto.randomUUID();
  const dedupeKey = `${opts.parada.id}:${opts.channel}:${opts.event.motivo}`;
  const payload = {
    ...opts.payloadBase,
    channel: opts.channel,
    reason: "quiet_hours",
    next_retry_at: opts.nextRetryAt.toISOString(),
  };

  if (opts.resumeJobId) {
    await updateJob(opts.resumeJobId, {
      status: "pending",
      errorCode: "QUIET_HOURS",
      payload,
      nextRetryAt: opts.nextRetryAt,
    });
    await logOps({
      level: "info",
      category: "notification_fallback",
      event: "notification.deferred",
      orderId,
      correlationId,
      actor: "worker",
      payload: {
        channel: opts.channel,
        status: "pending",
        reason: "quiet_hours",
        next_retry_at: opts.nextRetryAt.toISOString(),
        job_id: opts.resumeJobId,
      },
    });
    return;
  }

  const existing = await loadJobByDedupe(dedupeKey);
  if (existing) return;

  const jobId = await insertJob({
    paradaId: String(opts.parada.id),
    orderId,
    channel: opts.channel,
    status: "pending",
    dedupeKey,
    fallbackOfJobId: opts.fallbackOfJobId,
    nextChannel: nextNotificationChannel(opts.channel),
    correlationId,
    payload,
    nextRetryAt: opts.nextRetryAt,
    errorCode: "QUIET_HOURS",
  });
  await logOps({
    level: "info",
    category: "notification_fallback",
    event: "notification.deferred",
    orderId,
    correlationId,
    actor: "worker",
    payload: {
      channel: opts.channel,
      next_channel: nextNotificationChannel(opts.channel),
      dedupe_key: dedupeKey,
      status: "pending",
      reason: "quiet_hours",
      next_retry_at: opts.nextRetryAt.toISOString(),
      job_id: jobId,
    },
  });
}

async function sendAndPersist(opts: {
  event: NotificationRequested;
  parada: Record<string, unknown>;
  texto: string;
  channel: NotificationChannel;
  fallbackOfJobId?: string | null;
  payloadBase: Record<string, unknown>;
  resumeJobId?: string;
  now: Date;
}): Promise<ProcessOutcome> {
  const orderId = String(opts.parada.referencia_pedido ?? opts.parada.id);
  const nextChannel = nextNotificationChannel(opts.channel);
  const correlationId = currentCorrelationId() ?? crypto.randomUUID();
  const dedupeKey = `${opts.parada.id}:${opts.channel}:${opts.event.motivo}`;

  let jobId = opts.resumeJobId;
  if (!jobId) {
    const existing = await loadJobByDedupe(dedupeKey);
    if (existing?.status === "sent") return "sent";
    if (existing?.status === "skipped" || existing?.status === "failed") {
      return "skipped";
    }
    if (existing?.status === "pending" || existing?.status === "retry") {
      jobId = existing.id;
    } else {
      jobId = await insertJob({
        paradaId: String(opts.parada.id),
        orderId,
        channel: opts.channel,
        dedupeKey,
        fallbackOfJobId: opts.fallbackOfJobId,
        nextChannel,
        correlationId,
        payload: { ...opts.payloadBase, channel: opts.channel, body: opts.texto },
      });
    }
  }

  const sent = await sendChannel(
    opts.channel,
    destinationForChannel(opts.channel, opts.parada),
    opts.texto,
  );

  if (sent.ok) {
    await updateJob(jobId, {
      status: "sent",
      payload: { proveedorMessageId: sent.proveedorMessageId, dryRun: sent.dryRun },
      nextRetryAt: null,
    });
    await pool.query(
      `INSERT INTO eventos_notificacion (
         parada_id, tipo, proveedor, proveedor_message_id, payload_enviado, estado_envio, enviado_at
       ) VALUES ($1, $2, $3, $4, $5::jsonb, 'enviado', now())
       ON CONFLICT DO NOTHING`,
      [
        opts.parada.id,
        eventoTipo(opts.channel),
        eventoProveedor(opts.channel),
        sent.proveedorMessageId,
        JSON.stringify({ ...opts.payloadBase, channel: opts.channel }),
      ],
    );
    await logOps({
      level: "info",
      category: "notification_fallback",
      event: opts.fallbackOfJobId ? "notification.fallback" : "notification.sent",
      orderId,
      correlationId,
      actor: "worker",
      payload: {
        channel: opts.channel,
        next_channel: nextChannel,
        dedupe_key: dedupeKey,
        status: "sent",
        fallback_of_job_id: opts.fallbackOfJobId ?? null,
        job_id: jobId,
      },
    });
    return "sent";
  }

  await updateJob(jobId, {
    status: "failed",
    errorCode: sent.errorCode,
    payload: { error: sent.error },
    nextRetryAt: null,
  });
  await logOps({
    level: nextChannel ? "warn" : "error",
    category: "notification_fallback",
    event: nextChannel ? "notification.fallback" : "notification.fallback_exhausted",
    orderId,
    correlationId,
    actor: "worker",
    payload: {
      channel: opts.channel,
      error_code: sent.errorCode,
      next_channel: nextChannel,
      dedupe_key: dedupeKey,
      status: "failed",
      fallback_of_job_id: opts.fallbackOfJobId ?? null,
      job_id: jobId,
    },
  });

  if (nextChannel) {
    return processChannel({
      event: opts.event,
      parada: opts.parada,
      texto: opts.texto,
      channel: nextChannel,
      fallbackOfJobId: jobId,
      payloadBase: opts.payloadBase,
      now: opts.now,
    });
  }
  return "skipped";
}

async function processChannel(opts: {
  event: NotificationRequested;
  parada: Record<string, unknown>;
  texto: string;
  channel: NotificationChannel;
  fallbackOfJobId?: string | null;
  payloadBase: Record<string, unknown>;
  resumeJobId?: string;
  now: Date;
}): Promise<ProcessOutcome> {
  const plan = planForParada(opts.parada, { ...opts.event, channel: opts.channel }, opts.now);

  for (const skip of plan.skipped) {
    await recordSkipJob({
      parada: opts.parada,
      event: opts.event,
      channel: skip.channel,
      reason: skip.reason,
      fallbackOfJobId: opts.fallbackOfJobId,
      payloadBase: opts.payloadBase,
    });
  }

  if (plan.action === "skip") {
    if (opts.resumeJobId) {
      await updateJob(opts.resumeJobId, {
        status: "skipped",
        errorCode: plan.reason.toUpperCase(),
        payload: { reason: plan.reason },
        nextRetryAt: null,
      });
    }
    return "skipped";
  }

  if (plan.action === "defer") {
    const sameChannel = plan.channel === opts.channel;
    await recordDeferredJob({
      parada: opts.parada,
      event: opts.event,
      channel: plan.channel,
      nextRetryAt: plan.nextRetryAt,
      fallbackOfJobId: sameChannel ? opts.fallbackOfJobId : opts.resumeJobId ?? opts.fallbackOfJobId,
      payloadBase: { ...opts.payloadBase, body: opts.texto },
      resumeJobId: sameChannel ? opts.resumeJobId : undefined,
    });
    if (opts.resumeJobId && !sameChannel) {
      await updateJob(opts.resumeJobId, {
        status: "skipped",
        errorCode: "FALLBACK_CHANNEL",
        payload: { reason: "plan_moved_channel", to: plan.channel },
        nextRetryAt: null,
      });
    }
    return "deferred";
  }

  const sameChannel = plan.channel === opts.channel;
  if (opts.resumeJobId && !sameChannel) {
    await updateJob(opts.resumeJobId, {
      status: "skipped",
      errorCode: "FALLBACK_CHANNEL",
      payload: { reason: "plan_moved_channel", to: plan.channel },
      nextRetryAt: null,
    });
  }
  return sendAndPersist({
    ...opts,
    channel: plan.channel,
    fallbackOfJobId: sameChannel ? opts.fallbackOfJobId : opts.resumeJobId ?? opts.fallbackOfJobId,
    resumeJobId: sameChannel ? opts.resumeJobId : undefined,
  });
}

async function finalizeSuccessfulNotification(opts: {
  event: NotificationRequested;
  parada: Record<string, unknown>;
  texto: string;
  plantilla: PlantillaId;
}): Promise<void> {
  if (
    opts.event.motivo === "proximidad_geocerca" ||
    opts.event.motivo === "faltan_n_paradas" ||
    opts.event.motivo === "manual"
  ) {
    await markApproachNotified(pool, { paradaId: String(opts.parada.id) });
  }

  if (opts.parada.estado === "pendiente" && opts.event.motivo !== "entrega_confirmada") {
    assertTransicion("pendiente", "notificado");
    await pool.query(
      `UPDATE paradas SET estado = 'notificado' WHERE id = $1 AND estado = 'pendiente'`,
      [opts.parada.id],
    );
    await logOps({
      level: "info",
      category: "delivery_status",
      event: "delivery_status.changed",
      orderId: String(opts.parada.referencia_pedido ?? opts.parada.id),
      actor: "worker",
      payload: { from: "pendiente", to: "notificado", motivo: opts.event.motivo },
    });
  }

  await redis.publish(
    repartidorChannel(String(opts.parada.repartidor_id)),
    JSON.stringify({
      tipo: "cliente_notificado",
      paradaId: opts.parada.id,
      motivo: opts.event.motivo,
      plantilla: opts.plantilla,
      body: opts.texto,
      dryRun: !(twilioSid && twilioToken && twilioFrom),
    }),
  );
}

export async function handleNotification(
  event: NotificationRequested,
  opts: NotificationHandleOptions = {},
) {
  const now = opts.now ?? new Date();
  const { rows } = await pool.query(
    `SELECT p.*, r.agencia_id, r.repartidor_id,
            a.nombre AS nombre_empresa,
            a.nombre_saas,
            a.telefono_soporte,
            a.email_soporte,
            rp.nombre AS nombre_conductor,
            rp.matricula,
            rp.device_push_token,
            (SELECT count(*) FROM paradas px WHERE px.ruta_id = p.ruta_id) AS total_paradas
     FROM paradas p
     JOIN rutas r ON r.id = p.ruta_id
     JOIN agencias a ON a.id = r.agencia_id
     JOIN repartidores rp ON rp.id = r.repartidor_id
     WHERE p.id = $1`,
    [event.paradaId],
  );
  const parada = rows[0] as Record<string, unknown> | undefined;
  if (!parada) return;

  if (
    event.motivo !== "manual" &&
    event.motivo !== "entrega_confirmada" &&
    parada.estado !== "pendiente"
  ) {
    const orderId = String(parada.referencia_pedido ?? parada.id);
    await logOps({
      level: "info",
      category: "notification_fallback",
      event: "notification.skipped",
      orderId,
      actor: "worker",
      payload: {
        channel: event.channel ?? "whatsapp",
        status: "skipped",
        reason: "estado_no_pendiente",
        estado: parada.estado,
      },
    });
    if (opts.resumeJobId) {
      await updateJob(opts.resumeJobId, {
        status: "skipped",
        errorCode: "ESTADO_NO_PENDIENTE",
        payload: { reason: "estado_no_pendiente", estado: parada.estado },
        nextRetryAt: null,
      });
    }
    return;
  }

  let token = parada.token_acceso as string | null;
  if (!token) {
    token = firmarTokenCliente(String(parada.id), String(parada.agencia_id));
    await pool.query(
      `UPDATE paradas
       SET token_acceso = $2, token_expira_at = now() + interval '48 hours'
       WHERE id = $1`,
      [parada.id, token],
    );
  }

  const plantilla: PlantillaId = plantillaParaMotivo(event.motivo);
  const minutos = event.minutosRestantes ?? (event.paradasRestantes ?? 3) * 4;
  const eta = event.eta ??
    now.toLocaleTimeString("es-ES", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Europe/Madrid",
    });
  const horaEntrega = now.toLocaleTimeString("es-ES", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Madrid",
  });
  const enlace = `${publicWebUrl}/?token=${encodeURIComponent(token)}`;

  const texto = renderPlantilla(plantilla, {
    nombre_contacto: parada.cliente_nombre as string,
    nombre_empresa: parada.nombre_empresa as string,
    referencia_pedido: (parada.referencia_pedido as string | null) ?? String(parada.id),
    direccion_entrega: parada.direccion_texto as string,
    nombre_conductor: parada.nombre_conductor as string,
    matricula: (parada.matricula as string | null) ?? (parada.vehiculo as string | null) ?? "—",
    enlace_tracking: enlace,
    nombre_saas: parada.nombre_saas as string,
    numero_parada: parada.orden as number,
    total_paradas: parada.total_paradas as number,
    eta,
    minutos_restantes: minutos,
    telefono_soporte: parada.telefono_soporte as string,
    hora_entrega: horaEntrega,
    nombre_receptor: (parada.receptor_nombre as string | null) ?? (parada.cliente_nombre as string),
    enlace_pod: (parada.enlace_pod as string | null) ?? enlace,
    email_soporte: parada.email_soporte as string,
  });

  const payload = {
    to: parada.cliente_telefono,
    motivo: event.motivo,
    plantilla,
    body: texto,
  };

  const outcome = await processChannel({
    event,
    parada,
    texto,
    channel: asChannel(event.channel),
    fallbackOfJobId: event.fallbackOfJobId ?? null,
    payloadBase: payload,
    resumeJobId: opts.resumeJobId,
    now,
  });

  if (outcome === "sent") {
    await finalizeSuccessfulNotification({ event, parada, texto, plantilla });
  }
  console.log(
    `[notif] ${plantilla} parada=${parada.id} motivo=${event.motivo} outcome=${outcome}`,
  );
}

export async function processDueNotificationJobs(now = new Date()): Promise<number> {
  const { rows } = await pool.query<{
    id: string;
    parada_id: string;
    channel: string;
    payload: Record<string, unknown>;
    fallback_of_job_id: string | null;
  }>(
    `WITH due AS (
       SELECT id
       FROM notification_jobs
       WHERE status = 'pending'
         AND next_retry_at IS NOT NULL
         AND next_retry_at <= $1::timestamptz
       ORDER BY next_retry_at ASC
       LIMIT 50
       FOR UPDATE SKIP LOCKED
     )
     UPDATE notification_jobs AS j
     SET status = 'retry', updated_at = now()
     FROM due
     WHERE j.id = due.id
     RETURNING j.id::text, j.parada_id::text, j.channel, j.payload, j.fallback_of_job_id::text`,
    [now.toISOString()],
  );

  for (const job of rows) {
    const payload = job.payload ?? {};
    const event: NotificationRequested = {
      type: "NOTIFICATION_REQUESTED",
      paradaId: job.parada_id,
      motivo: (payload.motivo as NotificationRequested["motivo"]) ?? "manual",
      channel: asChannel(job.channel),
      fallbackOfJobId: job.fallback_of_job_id ?? undefined,
      eta: typeof payload.eta === "string" ? payload.eta : undefined,
    };
    try {
      await handleNotification(event, { now, resumeJobId: job.id });
    } catch (err) {
      console.error(`[notif] resume job=${job.id}`, err);
      await updateJob(job.id, {
        status: "pending",
        errorCode: "RESUME_ERROR",
        payload: { error: String(err) },
      });
    }
  }
  return rows.length;
}
