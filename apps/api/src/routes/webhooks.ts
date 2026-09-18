import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { enqueueWebhook } from "../queue.js";
import { config } from "../config.js";
import { validarFirmaMeta, validarFirmaTwilio } from "../webhooks/signatures.js";
import { logOps } from "../lib/ops/logger.js";

function asStringMap(body: unknown): Record<string, string> {
  if (!body || typeof body !== "object") return {};
  return Object.fromEntries(
    Object.entries(body as Record<string, unknown>).map(([k, v]) => [
      k,
      String(v),
    ]),
  );
}

async function tracedWebhook(
  request: FastifyRequest,
  reply: FastifyReply,
  actor: string,
  handler: () => Promise<{ status: number; body: unknown }>,
) {
  const started = Date.now();
  await logOps({
    level: "info",
    category: "webhook",
    event: "webhook.start",
    actor,
    payload: { path: request.url, method: request.method },
  });
  try {
    const result = await handler();
    const durationMs = Date.now() - started;
    const failed = result.status >= 400;
    await logOps({
      level: failed ? "error" : "info",
      category: "webhook",
      event: failed ? "webhook.fail" : "webhook.success",
      actor,
      durationMs,
      payload: { statusCode: result.status, path: request.url },
    });
    return reply.code(result.status).send(result.body);
  } catch (err) {
    await logOps({
      level: "error",
      category: "webhook",
      event: "webhook.fail",
      actor,
      durationMs: Date.now() - started,
      payload: {
        statusCode: 500,
        path: request.url,
        error: (err as Error).message,
      },
    });
    throw err;
  }
}

export async function webhookRoutes(app: FastifyInstance) {
  app.post(
    "/webhooks/twilio",
    {
      config: { rateLimit: false },
    },
    async (request, reply) => {
      return tracedWebhook(request, reply, "twilio", async () => {
        const signature = request.headers["x-twilio-signature"] as
          | string
          | undefined;
        const params = asStringMap(request.body);
        const url = `${request.protocol}://${request.hostname}${request.url}`;
        if (!validarFirmaTwilio(config.twilioAuthToken, url, params, signature)) {
          if (config.nodeEnv !== "development" || config.twilioAuthToken) {
            return { status: 401, body: { error: "firma inválida" } };
          }
        }

        await enqueueWebhook({
          type: "WEBHOOK_RECEIVED",
          proveedor: "twilio",
          proveedorMessageId: params.MessageSid || params.SmsSid,
          rawBody: JSON.stringify(params),
          receivedAt: new Date().toISOString(),
        });

        return { status: 200, body: { ok: true } };
      });
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
      return tracedWebhook(request, reply, "meta", async () => {
        const raw =
          typeof request.body === "string"
            ? request.body
            : JSON.stringify(request.body ?? {});
        const signature = request.headers["x-hub-signature-256"] as
          | string
          | undefined;
        if (!validarFirmaMeta(config.metaAppSecret, raw, signature)) {
          if (config.nodeEnv !== "development" || config.metaAppSecret) {
            return { status: 401, body: { error: "firma inválida" } };
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

        return { status: 200, body: { ok: true } };
      });
    },
  );
}
