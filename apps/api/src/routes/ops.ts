import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  applyOpsSchema,
  correlationFromHeader,
  getOpsHealth,
  getOpsMetrics,
  initOps,
  listOpsLogs,
  runOpsChecks,
  withCorrelation,
} from "@startup-logistica/shared/ops";
import { pool } from "../db.js";
import { agenciaPorApiKey } from "../auth-agencia.js";

declare module "fastify" {
  interface FastifyRequest {
    correlationId?: string;
    opsAgenciaId?: string;
  }
}

export async function requireOpsAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<{ agenciaId?: string; actor: string } | null> {
  const expected = process.env.OPS_TOKEN;
  const provided = request.headers["x-ops-token"];
  if (expected && typeof provided === "string" && provided === expected) {
    return { actor: "ops-cron" };
  }
  const agencia = await agenciaPorApiKey(request);
  if (!agencia) {
    reply.code(401).send({ error: "no autorizado" });
    return null;
  }
  request.opsAgenciaId = agencia.id;
  return { agenciaId: agencia.id, actor: "api" };
}

export async function registerOps(app: FastifyInstance) {
  initOps(pool);
  await applyOpsSchema(pool);

  app.addHook("onRequest", (request, reply, done) => {
    const correlationId = correlationFromHeader(
      request.headers["x-correlation-id"],
    );
    request.correlationId = correlationId;
    reply.header("x-correlation-id", correlationId);
    withCorrelation(() => done(), correlationId);
  });

  const interval = Number(process.env.OPS_CHECKS_INTERVAL_MS ?? 120_000);
  if (interval > 0) {
    const timer = setInterval(() => {
      void runOpsChecks(pool).catch((err) => app.log.error(err));
    }, interval);
    timer.unref();
  }
}

export async function opsRoutes(app: FastifyInstance) {
  app.get(
    "/api/ops/health",
    { config: { rateLimit: false } },
    async () => getOpsHealth(pool),
  );

  app.get("/api/ops/metrics", async (request, reply) => {
    const auth = await requireOpsAuth(request, reply);
    if (!auth) return;
    const q = request.query as { from?: string; to?: string };
    return getOpsMetrics(pool, {
      from: q.from,
      to: q.to,
      agenciaId: auth.agenciaId,
    });
  });

  app.get("/api/ops/logs", async (request, reply) => {
    const auth = await requireOpsAuth(request, reply);
    if (!auth) return;
    const q = request.query as {
      category?: string;
      orderId?: string;
      limit?: string;
    };
    const logs = await listOpsLogs(pool, {
      category: q.category,
      orderId: q.orderId,
      limit: q.limit ? Number(q.limit) : undefined,
    });
    return { logs };
  });

  app.post("/api/ops/checks", async (request, reply) => {
    const auth = await requireOpsAuth(request, reply);
    if (!auth) return;
    const result = await runOpsChecks(pool);
    return {
      ok: true,
      evaluated: result.evaluated,
      opened: result.opened,
      skipped: result.skipped,
    };
  });
}
