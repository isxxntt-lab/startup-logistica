import type {
  DashboardPayload,
  NearbyCourier,
  RoutePlan,
} from "@startup-logistica/shared";
import "./style.css";

const api = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

function pct(n: number) {
  return `${Math.round(n * 100)}%`;
}

function apiKey(): string {
  return (document.querySelector("#key") as HTMLInputElement).value;
}

function meters(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
}

async function load() {
  const key = (document.querySelector("#key") as HTMLInputElement).value;
  const today = new Date().toISOString().slice(0, 10);
  const res = await fetch(
    `${api}/agencia/dashboard?from=${today}&to=${today}&comparePreviousPeriod=true`,
    { headers: { "x-api-key": key } },
  );
  if (!res.ok) throw new Error(await res.text());
  const data = (await res.json()) as DashboardPayload;
  const k = data.kpis;
  const cards = [
    ["Entregas", String(k.totalDeliveries)],
    ["Entregadas", String(k.deliveredCount)],
    ["Fallos evitados", String(k.failedDeliveriesAvoided)],
    ["Tasa fallos evitados", pct(k.failedDeliveriesAvoidedRate)],
    ["Éxito 1.er intento", pct(k.firstAttemptSuccessRate)],
    ["Permanencia geocerca", `${k.avgGeofenceDwellMinutes} min`],
    ["A tiempo", pct(k.onTimeRate)],
    ["En geocerca ahora", String(k.inGeofenceNow)],
  ];
  document.querySelector("#kpis")!.innerHTML = cards
    .map(([label, value]) => `<article class="card">${label}<strong>${value}</strong></article>`)
    .join("");

  document.querySelector("#live")!.innerHTML =
    data.liveInGeofence
      .map(
        (item) =>
          `<li>${item.reference} · ${item.courierName} · ${item.dwellSeconds}s</li>`,
      )
      .join("") || "<li>Nadie en geocerca</li>";

  document.querySelector("#rows")!.innerHTML = data.recentDeliveries
    .map(
      (d) =>
        `<tr><td>${d.reference}</td><td>${d.status}</td><td>${d.courierName}</td><td>${d.address}</td><td>${d.firstAttemptSuccess ? "sí" : "no"}</td></tr>`,
    )
    .join("");
}

async function optimizarRuta() {
  const rutaId = (document.querySelector("#ruta-id") as HTMLInputElement).value;
  const persist = (document.querySelector("#persistir") as HTMLInputElement).checked;
  const out = document.querySelector("#opt-result") as HTMLDivElement;
  out.textContent = "Optimizando…";
  const res = await fetch(`${api}/agencia/rutas/${rutaId}/optimizar`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey() },
    body: JSON.stringify({ persist }),
  });
  if (!res.ok) {
    out.textContent = `Error ${res.status}: ${await res.text()}`;
    return;
  }
  const data = (await res.json()) as {
    plan: RoutePlan;
    currentTotalMeters: number;
    persisted: boolean;
  };
  const saved = data.currentTotalMeters - data.plan.totalMeters;
  const savedPct = data.currentTotalMeters
    ? Math.round((saved / data.currentTotalMeters) * 100)
    : 0;
  const secuencia = data.plan.stops
    .map((s, i) => `${i + 1}. ${s.referencia ?? s.paradaId} (${meters(s.cumulativeMeters)})`)
    .join("<br/>");
  out.innerHTML =
    `<p>Secuencial: <b>${meters(data.currentTotalMeters)}</b> → ` +
    `Optimizado: <b>${meters(data.plan.totalMeters)}</b> ` +
    `<span class="save">(−${savedPct}%)</span>${data.persisted ? " · <b>persistido</b>" : ""}</p>` +
    `<div class="seq">${secuencia}</div>`;
  if (data.persisted) void load().catch(() => {});
}

async function buscarCercanos() {
  const lat = (document.querySelector("#near-lat") as HTMLInputElement).value;
  const lon = (document.querySelector("#near-lon") as HTMLInputElement).value;
  const radiusM = (document.querySelector("#near-radius") as HTMLInputElement).value;
  const listEl = document.querySelector("#cercanos") as HTMLUListElement;
  const qs = new URLSearchParams({ lat, lon, radiusM });
  const res = await fetch(`${api}/agencia/repartidores-cercanos?${qs.toString()}`, {
    headers: { "x-api-key": apiKey() },
  });
  if (!res.ok) {
    listEl.innerHTML = `<li>Error ${res.status}</li>`;
    return;
  }
  const data = (await res.json()) as { couriers: NearbyCourier[] };
  listEl.innerHTML =
    data.couriers
      .map(
        (c) =>
          `<li>${c.nombre} <small>(${c.codigo ?? c.repartidorId})</small> · <b>${meters(c.distanceM)}</b></li>`,
      )
      .join("") || "<li>Ninguno en el radio</li>";
}

let autoTimer: number | null = null;
function syncAutoRefresh() {
  const on = (document.querySelector("#auto") as HTMLInputElement).checked;
  if (autoTimer !== null) {
    window.clearInterval(autoTimer);
    autoTimer = null;
  }
  if (on) {
    autoTimer = window.setInterval(() => {
      void load().catch(() => {});
    }, 10_000);
  }
}

document.querySelector("#reload")?.addEventListener("click", () => {
  void load().catch((err) => alert((err as Error).message));
});
document.querySelector("#optimizar")?.addEventListener("click", () => {
  void optimizarRuta().catch((err) => alert((err as Error).message));
});
document.querySelector("#buscar-cercanos")?.addEventListener("click", () => {
  void buscarCercanos().catch((err) => alert((err as Error).message));
});
document.querySelector("#auto")?.addEventListener("change", syncAutoRefresh);

void load().catch((err) => alert((err as Error).message));
syncAutoRefresh();
