import type { FastifyInstance, FastifyRequest } from "fastify";
import { enqueueWebhook } from "../queue.js";
import { config } from "../config.js";
import { validarFirmaMeta, validarFirmaTwilio } from "../webhooks/signatures.js";

function asStringMap(body: unknown): Record<string, string> {
  if (!body || typeof body !== "object") return {};
  return Object.fromEntries(
    Object.entries(body as Record<string, unknown>).map(([k, v]) => [
      k,
      String(v),
    ]),
  );
}

export async function webhookRoutes(app: FastifyInstance) {
  app.post(
    "/webhooks/twilio",
    {
      config: { rateLimit: false },
    },
    async (request, reply) => {
      const signature = request.headers["x-twilio-signature"] as
        | string
        | undefined;
      const params = asStringMap(request.body);
      const url = `${request.protocol}://${request.hostname}${request.url}`;
      if (!validarFirmaTwilio(config.twilioAuthToken, url, params, signature)) {
        if (config.nodeEnv !== "development" || config.twilioAuthToken) {
          return reply.code(401).send({ error: "firma inválida" });
        }
      }

      await enqueueWebhook({
        type: "WEBHOOK_RECEIVED",
        proveedor: "twilio",
        proveedorMessageId: params.MessageSid || params.SmsSid,
        rawBody: JSON.stringify(params),
        receivedAt: new Date().toISOString(),
      });

      return reply.code(200).send({ ok: true });
    },
  );

  app.get("/webhooks/whatsapp", async (request, reply) => {
    const q = request.query as Record<string, string>;
    if (
      q["hub.mode"] === "subscribe" &&
      q["hub.verify_token"] === config.metaVerifyToken
    ) {
      return reply.type("text/plain").send(q["hub.challenge"] ?? "");
    }
    return reply.code(403).send("forbidden");
  });

  app.post(
    "/webhooks/whatsapp",
    { config: { rateLimit: false } },
    async (request: FastifyRequest, reply) => {
      const raw =
        typeof request.body === "string"
          ? request.body
          : JSON.stringify(request.body ?? {});
      const signature = request.headers["x-hub-signature-256"] as
        | string
        | undefined;
      if (!validarFirmaMeta(config.metaAppSecret, raw, signature)) {
        if (config.nodeEnv !== "development" || config.metaAppSecret) {
          return reply.code(401).send({ error: "firma inválida" });
        }
      }

      const parsed = JSON.parse(raw) as {
        entry?: Array<{
          changes?: Array<{
            value?: { messages?: Array<{ id?: string }> };
          }>;
        }>;
      };
      const messageId =
        parsed.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.id;

      await enqueueWebhook({
        type: "WEBHOOK_RECEIVED",
        proveedor: "meta",
        proveedorMessageId: messageId,
        rawBody: raw,
        receivedAt: new Date().toISOString(),
      });

      return reply.code(200).send({ ok: true });
    },
  );
}
