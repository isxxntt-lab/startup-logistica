import type { WebhookReceived } from "@startup-logistica/shared";
import { pool } from "../db.js";

export async function handleWebhook(event: WebhookReceived) {
  const body = JSON.parse(event.rawBody) as Record<string, unknown>;
  const messageId =
    event.proveedorMessageId ||
    String(body.MessageSid ?? body.SmsSid ?? "");

  if (messageId) {
    const { rowCount } = await pool.query(
      `UPDATE eventos_notificacion
       SET estado_envio = CASE
             WHEN $2 IN ('delivered', 'read') THEN 'entregado'
             WHEN $2 IN ('failed', 'undelivered') THEN 'fallido'
             ELSE estado_envio
           END,
           respuesta_cliente = COALESCE(respuesta_cliente, '{}'::jsonb) || $3::jsonb,
           actualizado_at = now()
       WHERE proveedor = $4 AND proveedor_message_id = $1`,
      [
        messageId,
        String(body.MessageStatus ?? body.status ?? ""),
        JSON.stringify({ inbound: body }),
        event.proveedor,
      ],
    );
    if (rowCount && rowCount > 0) return;
  }

  await pool.query(
    `INSERT INTO eventos_notificacion (
       parada_id, tipo, proveedor, proveedor_message_id, payload_enviado, estado_envio
     )
     SELECT p.id, 'whatsapp', $1, $2, $3::jsonb, 'entregado'
     FROM paradas p
     WHERE p.cliente_telefono = $4
     ORDER BY p.updated_at DESC
     LIMIT 1
     ON CONFLICT (proveedor, proveedor_message_id) DO NOTHING`,
    [
      event.proveedor,
      messageId || `inbound-${event.receivedAt}`,
      JSON.stringify(body),
      String(body.From ?? body.from ?? "").replace("whatsapp:", ""),
    ],
  );
}
