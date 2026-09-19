import type { StopDistance } from "@startup-logistica/shared";

const api = import.meta.env.VITE_API_URL ?? "http://localhost:3000";
const ridInput = document.querySelector("#rid") as HTMLInputElement;
const paradasEl = document.querySelector("#paradas") as HTMLUListElement;
const proximasEl = document.querySelector("#proximas") as HTMLUListElement;
const logEl = document.querySelector("#log") as HTMLDivElement;
const wsStatusEl = document.querySelector("#ws-status") as HTMLSpanElement;

let ws: WebSocket | null = null;
let rutaId: string | null = null;
let siguientePendiente: { id: string; lat: number; lon: number } | null = null;

function log(msg: string) {
  logEl.textContent = `${new Date().toLocaleTimeString()} ${msg}\n` + logEl.textContent;
}

function setWsStatus(connected: boolean) {
  wsStatusEl.textContent = connected ? "● conectado" : "● desconectado";
  wsStatusEl.className = `ws-status ${connected ? "ws-on" : "ws-off"}`;
}

/** Traduce los mensajes del canal en tiempo real a texto legible. */
function describeRealtime(raw: string): string {
  try {
    const msg = JSON.parse(raw) as Record<string, unknown>;
    switch (msg.tipo) {
      case "conectado":
        return `Conectado al canal (repartidor ${msg.repartidorId})`;
      case "cliente_respuesta": {
        const accion =
          msg.accion === "confirmado"
            ? "confirmó que estará presente"
            : msg.accion === "reprogramado"
              ? "pidió reprogramar"
              : String(msg.accion);
        const ventana = msg.ventana_alternativa
          ? ` (ventana: ${msg.ventana_alternativa})`
          : "";
        return `📩 El cliente ${accion}${ventana} · parada ${msg.paradaId}`;
      }
      case "cliente_notificado": {
        const dry = msg.dryRun ? " (dry-run)" : "";
        return `🔔 Cliente notificado · plantilla ${msg.plantilla ?? ""} · motivo ${msg.motivo ?? ""}${dry}`;
      }
      default:
        return raw;
    }
  } catch {
    return raw;
  }
}

async function cargarProximas(id: string) {
  proximasEl.innerHTML = "";
  const res = await fetch(`${api}/repartidor/${id}/proximas-paradas`);
  if (res.status === 409) {
    proximasEl.innerHTML =
      "<li class='prox'>Envía un GPS para calcular la proximidad.</li>";
    return;
  }
  if (!res.ok) {
    proximasEl.innerHTML = `<li class='prox'>Error ${res.status}</li>`;
    return;
  }
  const data = (await res.json()) as { stops: StopDistance[] };
  if (data.stops.length === 0) {
    proximasEl.innerHTML = "<li class='prox'>Sin paradas pendientes.</li>";
    return;
  }
  for (const s of data.stops) {
    const li = document.createElement("li");
    li.className = "prox";
    const badge = s.dentroGeocerca
      ? '<span class="badge badge-in">en geocerca</span>'
      : '<span class="badge badge-out">fuera</span>';
    const km = s.distanceM >= 1000
      ? `${(s.distanceM / 1000).toFixed(2)} km`
      : `${Math.round(s.distanceM)} m`;
    li.innerHTML =
      `${s.referencia ?? s.paradaId} — ${s.direccion} ` +
      `<span class="prox-dist">${km}</span>${badge}`;
    proximasEl.append(li);
  }
}

async function cargarRuta(id: string) {
  const res = await fetch(`${api}/repartidor/${id}/ruta-hoy`);
  if (!res.ok) {
    log(`No se pudo cargar la ruta (${res.status})`);
    return;
  }
  const data = await res.json();
  rutaId = data.id;
  paradasEl.innerHTML = "";
  const paradas = data.paradas as Array<{
    id: string;
    orden: number;
    cliente_nombre: string;
    direccion_texto: string;
    estado: string;
    lat: number;
    lon: number;
  }>;
  siguientePendiente = paradas.find((p) => p.estado === "pendiente") ?? null;

  for (const p of paradas) {
    const li = document.createElement("li");
    li.textContent = `${p.orden}. ${p.cliente_nombre} — ${p.direccion_texto} [${p.estado}]`;
    const btn = document.createElement("button");
    btn.textContent = "Marcar entregado";
    btn.addEventListener("click", async () => {
      await fetch(`${api}/repartidor/paradas/${p.id}/estado`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ estado: "entregado" }),
      });
      (document.querySelector("#load") as HTMLButtonElement).click();
    });
    li.append(btn);
    paradasEl.append(li);
  }

  ws?.close();
  // Los publicadores emiten a canal:repartidor:<uuid>, así que el WS debe
  // registrarse con el UUID del repartidor (no con el código introducido).
  const wsRepartidorId = data.repartidor_id ?? id;
  const wsUrl = api.replace("http", "ws") + `/ws/repartidor?id=${wsRepartidorId}`;
  ws = new WebSocket(wsUrl);
  ws.onopen = () => setWsStatus(true);
  ws.onclose = () => setWsStatus(false);
  ws.onerror = () => setWsStatus(false);
  ws.onmessage = (ev) => log(describeRealtime(String(ev.data)));

  await cargarProximas(id);
}

document.querySelector("#load")?.addEventListener("click", () => {
  void cargarRuta(ridInput.value);
});

document.querySelector("#refresh-prox")?.addEventListener("click", () => {
  void cargarProximas(ridInput.value);
});

document.querySelector("#ping")?.addEventListener("click", async () => {
  const id = ridInput.value;
  if (!siguientePendiente) {
    log("No hay parada pendiente: carga la ruta primero");
    return;
  }
  const body = {
    lat: Number(siguientePendiente.lat),
    lon: Number(siguientePendiente.lon),
    rutaId: rutaId ?? undefined,
  };
  await fetch(`${api}/repartidor/${id}/ubicacion`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  log(`GPS enviado (${body.lat}, ${body.lon}) → recalculo proximidad`);
  await cargarProximas(id);
});
