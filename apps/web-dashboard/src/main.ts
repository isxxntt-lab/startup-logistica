import type { DashboardPayload } from "@startup-logistica/shared";
import "./style.css";

const api = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

function pct(n: number) {
  return `${Math.round(n * 100)}%`;
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

document.querySelector("#reload")?.addEventListener("click", () => {
  void load().catch((err) => alert((err as Error).message));
});
void load().catch((err) => alert((err as Error).message));
