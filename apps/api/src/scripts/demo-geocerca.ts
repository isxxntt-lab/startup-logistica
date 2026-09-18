import pg from "pg";
import { GROK_LOCATION_PINGS } from "@startup-logistica/shared";
import type { DashboardPayload } from "@startup-logistica/shared";

const api = process.env.API_PUBLIC_URL ?? "http://localhost:3000";
const apiKey = "demo-api-key";

const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ??
    "postgres://logistica:logistica@localhost:5432/startup_logistica",
});

async function esperarApi() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${api}/health`);
      if (res.ok) return;
    } catch {
      /* aún no */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("La API no responde en " + api);
}

async function main() {
  await esperarApi();

  await pool.query(
    `UPDATE paradas
     SET estado = 'pendiente',
         token_acceso = NULL,
         token_expira_at = NULL,
         delivered_at = NULL,
         first_attempt_success = false
     WHERE referencia_pedido = 'ORD-TEST-001'`,
  );
  await pool.query(
    `DELETE FROM eventos_notificacion
     WHERE parada_id = '55555555-5555-5555-5555-555555555552'`,
  );
  await pool.query(
    `DELETE FROM geofence_events
     WHERE parada_id = '55555555-5555-5555-5555-555555555552'`,
  );
  await pool.query(
    `DELETE FROM location_pings
     WHERE order_id = 'ORD-TEST-001'`,
  );

  console.log("Reproduciendo pings Grok (ORD-TEST-001 / repartidor_001)…");
  for (const ping of GROK_LOCATION_PINGS) {
    const res = await fetch(`${api}/events/location_update`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify(ping),
    });
    if (!res.ok) throw new Error(`Ping falló: ${res.status} ${await res.text()}`);
    const loc = ping.location;
    console.log(
      `  ${ping.timestamp} → ${loc.lat},${loc.lng} speed=${loc.speed_mps} m/s`,
    );
    await new Promise((r) => setTimeout(r, 400));
  }

  for (let i = 0; i < 20; i++) {
    const { rows } = await pool.query<{
      estado: string;
      plantilla: string | null;
      body: string | null;
    }>(
      `SELECT p.estado,
              e.payload_enviado->>'plantilla' AS plantilla,
              e.payload_enviado->>'body' AS body
       FROM paradas p
       LEFT JOIN LATERAL (
         SELECT payload_enviado
         FROM eventos_notificacion
         WHERE parada_id = p.id
         ORDER BY actualizado_at DESC
         LIMIT 1
       ) e ON true
       WHERE p.referencia_pedido = 'ORD-TEST-001'`,
    );
    const row = rows[0];
    if (row?.estado === "notificado" && row.plantilla === "aviso_cercania") {
      console.log("\nPlantilla aviso_cercania enviada:\n");
      console.log(row.body);
      break;
    }
    if (i === 19) {
      throw new Error("No llegó la plantilla aviso_cercania");
    }
    await new Promise((r) => setTimeout(r, 400));
  }

  const today = new Date().toISOString().slice(0, 10);
  const dashRes = await fetch(
    `${api}/agencia/dashboard?from=${today}&to=${today}&comparePreviousPeriod=true`,
    { headers: { "x-api-key": apiKey } },
  );
  if (!dashRes.ok) throw new Error(await dashRes.text());
  const dash = (await dashRes.json()) as DashboardPayload;
  console.log("\nKPIs dashboard:");
  console.log(
    JSON.stringify(
      {
        totalDeliveries: dash.kpis.totalDeliveries,
        deliveredCount: dash.kpis.deliveredCount,
        failedDeliveriesAvoided: dash.kpis.failedDeliveriesAvoided,
        firstAttemptSuccessRate: dash.kpis.firstAttemptSuccessRate,
        inGeofenceNow: dash.kpis.inGeofenceNow,
        liveInGeofence: dash.liveInGeofence,
      },
      null,
      2,
    ),
  );

  await pool.end();
  console.log("\nDemo plantillas + KPIs completada.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
