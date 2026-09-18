import {
  assertTransicion,
  currentCorrelationId,
  logOps,
  markApproachNotified,
  nextNotificationChannel,
  plantillaParaMotivo,
  renderPlantilla,
  repartidorChannel,
  type NotificationChannel,
  type NotificationRequested,
  type PlantillaId,
} from "@startup-logistica/shared";
import { pool } from "../db.js";
import { firmarTokenCliente } from "../jwt.js";
import { redis } from "../redis.js";

const publicWebUrl = process.env.PUBLIC_WEB_URL ?? "http://localhost:5173";
const twilioSid = process.env.TWILIO_ACCOUNT_SID ?? "";
const twilioToken = process.env.TWILIO_AUTH_TOKEN ?? "";
const twilioFrom = process.env.TWILIO_WHATSAPP_FROM ?? "";
const twilioSmsFrom = process.env.TWILIO_SMS_FROM ?? "";

type SendResult =
  | { ok: true; proveedorMessageId: string; dryRun: boolean }
  | { ok: false; errorCode: string; error: string };

async function insertJob(opts: {
  paradaId: string;
  orderId: string;
  channel: NotificationChannel;
  dedupeKey: string;
  fallbackOfJobId?: string | null;
  nextChannel: NotificationChannel | null;
  correlationId: string;
  payload: Record<string, unknown>;
}): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO notification_jobs (
       parada_id, order_id, channel, status, fallback_of_job_id, next_channel,
       dedupe_key, correlation_id, payload
     ) VALUES ($1,$2,$3,'pending',$4,$5,$6,$7,$8::jsonb)
     RETURNING id::text`,
    [
      opts.paradaId,
      opts.orderId,
      opts.channel,
      opts.fallbackOfJobId ?? null,
      opts.nextChannel,
      opts.dedupeKey,
      opts.correlationId,
      JSON.stringify(opts.payload),
    ],
  );
  return rows[0].id;
}

async function updateJob(
  id: string,
  patch: {
    status: "sent" | "failed" | "skipped" | "retry";
    errorCode?: string | null;
    payload?: Record<string, unknown>;
  },
) {
  await pool.query(
    `UPDATE notification_jobs
     SET status = $2,
         error_code = COALESCE($3, error_code),
         payload = CASE WHEN $4::jsonb IS NULL THEN payload ELSE payload || $4::jsonb END,
         updated_at = now()
     WHERE id = $1`,
    [id, patch.status, patch.errorCode ?? null, patch.payload ? JSON.stringify(patch.payload) : null],
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

  return { ok: false, errorCode: "UNSUPPORTED_CHANNEL", error: `canal ${channel} no soportado` };
}

async function processChannel(opts: {
  event: NotificationRequested;
  parada: Record<string, unknown>;
  texto: string;
  channel: NotificationChannel;
  fallbackOfJobId?: string | null;
  payloadBase: Record<string, unknown>;
}): Promise<void> {
  const orderId = String(opts.parada.referencia_pedido ?? opts.parada.id);
  const nextChannel = nextNotificationChannel(opts.channel);
  const correlationId = currentCorrelationId() ?? crypto.randomUUID();
  const dedupeKey = `${opts.parada.id}:${opts.channel}:${opts.event.motivo}`;
  const jobId = await insertJob({
    paradaId: String(opts.parada.id),
    orderId,
    channel: opts.channel,
    dedupeKey,
    fallbackOfJobId: opts.fallbackOfJobId,
    nextChannel,
    correlationId,
    payload: { ...opts.payloadBase, channel: opts.channel },
  });

  const sent = await sendChannel(
    opts.channel,
    String(opts.parada.cliente_telefono),
    opts.texto,
  );

  if (sent.ok) {
    await updateJob(jobId, {
      status: "sent",
      payload: { proveedorMessageId: sent.proveedorMessageId, dryRun: sent.dryRun },
    });
    await pool.query(
      `INSERT INTO eventos_notificacion (
         parada_id, tipo, proveedor, proveedor_message_id, payload_enviado, estado_envio, enviado_at
       ) VALUES ($1, $2, 'twilio', $3, $4::jsonb, 'enviado', now())
       ON CONFLICT DO NOTHING`,
      [
        opts.parada.id,
        opts.channel === "sms" ? "sms" : "whatsapp",
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
    return;
  }

  await updateJob(jobId, {
    status: "failed",
    errorCode: sent.errorCode,
    payload: { error: sent.error },
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
    await processChannel({
      ...opts,
      channel: nextChannel,
      fallbackOfJobId: jobId,
    });
  }
}

export async function handleNotification(event: NotificationRequested) {
  const { rows } = await pool.query(
    `SELECT p.*, r.agencia_id, r.repartidor_id,
            a.nombre AS nombre_empresa,
            a.nombre_saas,
            a.telefono_soporte,
            a.email_soporte,
            rp.nombre AS nombre_conductor,
            rp.matricula,
            (SELECT count(*) FROM paradas px WHERE px.ruta_id = p.ruta_id) AS total_paradas
     FROM paradas p
     JOIN rutas r ON r.id = p.ruta_id
     JOIN agencias a ON a.id = r.agencia_id
     JOIN repartidores rp ON rp.id = r.repartidor_id
     WHERE p.id = $1`,
    [event.paradaId],
  );
  const parada = rows[0];
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
    return;
  }

  let token = parada.token_acceso as string | null;
  if (!token) {
    token = firmarTokenCliente(parada.id, parada.agencia_id);
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
    new Date(Date.now() + minutos * 60_000).toLocaleTimeString("es-ES", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Europe/Madrid",
    });
  const horaEntrega = new Date().toLocaleTimeString("es-ES", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Madrid",
  });
  const enlace = `${publicWebUrl}/?token=${encodeURIComponent(token)}`;

  const texto = renderPlantilla(plantilla, {
    nombre_contacto: parada.cliente_nombre,
    nombre_empresa: parada.nombre_empresa,
    referencia_pedido: parada.referencia_pedido ?? parada.id,
    direccion_entrega: parada.direccion_texto,
    nombre_conductor: parada.nombre_conductor,
    matricula: parada.matricula ?? parada.vehiculo ?? "—",
    enlace_tracking: enlace,
    nombre_saas: parada.nombre_saas,
    numero_parada: parada.orden,
    total_paradas: parada.total_paradas,
    eta,
    minutos_restantes: minutos,
    telefono_soporte: parada.telefono_soporte,
    hora_entrega: horaEntrega,
    nombre_receptor: parada.receptor_nombre ?? parada.cliente_nombre,
    enlace_pod: parada.enlace_pod ?? enlace,
    email_soporte: parada.email_soporte,
  });

  const payload = {
    to: parada.cliente_telefono,
    motivo: event.motivo,
    plantilla,
  };

  await processChannel({
    event,
    parada,
    texto,
    channel: event.channel ?? "whatsapp",
    fallbackOfJobId: event.fallbackOfJobId ?? null,
    payloadBase: payload,
  });

  if (
    event.motivo === "proximidad_geocerca" ||
    event.motivo === "faltan_n_paradas" ||
    event.motivo === "manual"
  ) {
    await markApproachNotified(pool, { paradaId: parada.id });
  }

  if (parada.estado === "pendiente" && event.motivo !== "entrega_confirmada") {
    assertTransicion("pendiente", "notificado");
    await pool.query(
      `UPDATE paradas SET estado = 'notificado' WHERE id = $1 AND estado = 'pendiente'`,
      [parada.id],
    );
    await logOps({
      level: "info",
      category: "delivery_status",
      event: "delivery_status.changed",
      orderId: String(parada.referencia_pedido ?? parada.id),
      actor: "worker",
      payload: { from: "pendiente", to: "notificado", motivo: event.motivo },
    });
  }

  await redis.publish(
    repartidorChannel(parada.repartidor_id),
    JSON.stringify({
      tipo: "cliente_notificado",
      paradaId: parada.id,
      motivo: event.motivo,
      plantilla,
      body: texto,
      dryRun: !(twilioSid && twilioToken && twilioFrom),
    }),
  );
  console.log(`[notif] ${plantilla} parada=${parada.id} motivo=${event.motivo}`);
}
