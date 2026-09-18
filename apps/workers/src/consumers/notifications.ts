import {
  assertTransicion,
  plantillaParaMotivo,
  renderPlantilla,
  repartidorChannel,
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
    body: texto,
    motivo: event.motivo,
    plantilla,
  };

  let proveedorMessageId: string | null = null;
  let estadoEnvio: "enviado" | "pendiente" = "pendiente";

  if (twilioSid && twilioToken && twilioFrom) {
    const body = new URLSearchParams({
      To: `whatsapp:${parada.cliente_telefono}`,
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
    const json = (await res.json()) as { sid?: string };
    proveedorMessageId = json.sid ?? null;
    estadoEnvio = res.ok ? "enviado" : "pendiente";
  } else {
    console.log("[notif dry-run]", payload);
    proveedorMessageId = `dryrun-${event.paradaId}-${Date.now()}`;
    estadoEnvio = "enviado";
  }

  await pool.query(
    `INSERT INTO eventos_notificacion (
       parada_id, tipo, proveedor, proveedor_message_id, payload_enviado, estado_envio, enviado_at
     ) VALUES ($1, 'whatsapp', 'twilio', $2, $3::jsonb, $4, now())
     ON CONFLICT DO NOTHING`,
    [parada.id, proveedorMessageId, JSON.stringify(payload), estadoEnvio],
  );

  if (parada.estado === "pendiente" && event.motivo !== "entrega_confirmada") {
    assertTransicion("pendiente", "notificado");
    await pool.query(
      `UPDATE paradas SET estado = 'notificado' WHERE id = $1 AND estado = 'pendiente'`,
      [parada.id],
    );
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
  console.log(
    `[notif] ${plantilla} parada=${parada.id} motivo=${event.motivo} msg=${proveedorMessageId}`,
  );
}
