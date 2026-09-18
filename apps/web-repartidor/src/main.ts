const api = import.meta.env.VITE_API_URL ?? "http://localhost:3000";
const ridInput = document.querySelector("#rid") as HTMLInputElement;
const apiKeyInput = document.querySelector("#apiKey") as HTMLInputElement;
const paradasEl = document.querySelector("#paradas") as HTMLUListElement;
const logEl = document.querySelector("#log") as HTMLDivElement;

let ws: WebSocket | null = null;
let rutaId: string | null = null;
let siguientePendiente: { id: string; lat: number; lon: number } | null = null;

function log(msg: string) {
  logEl.textContent = `${new Date().toLocaleTimeString()} ${msg}\n` + logEl.textContent;
}

function cabeceras(extra: Record<string, string> = {}) {
  return {
    "x-api-key": apiKeyInput.value,
    ...extra,
  };
}

document.querySelector("#load")?.addEventListener("click", async () => {
  const id = ridInput.value;
  const res = await fetch(`${api}/repartidor/${id}/ruta-hoy`, {
    headers: cabeceras(),
  });
  const data = await res.json();
  if (!res.ok) {
    log(`ruta-hoy ${res.status}: ${data.error ?? res.statusText}`);
    return;
  }
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
  siguientePendiente =
    paradas.find((p) => p.estado === "pendiente") ?? null;

  for (const p of paradas) {
    const li = document.createElement("li");
    li.textContent = `${p.orden}. ${p.cliente_nombre} — ${p.direccion_texto} [${p.estado}]`;
    const btn = document.createElement("button");
    btn.textContent = "Marcar entregado";
    btn.addEventListener("click", async () => {
      await fetch(`${api}/repartidor/paradas/${p.id}/estado`, {
        method: "POST",
        headers: cabeceras({ "Content-Type": "application/json" }),
        body: JSON.stringify({ estado: "entregado" }),
      });
      (document.querySelector("#load") as HTMLButtonElement).click();
    });
    li.append(btn);
    paradasEl.append(li);
  }

  ws?.close();
  const wsUrl = api.replace("http", "ws") + `/ws/repartidor?id=${encodeURIComponent(id)}`;
  ws = new WebSocket(wsUrl);
  ws.onopen = () => {
    ws?.send(
      JSON.stringify({
        tipo: "auth",
        apiKey: apiKeyInput.value,
        id,
      }),
    );
  };
  ws.onmessage = (ev) => log(String(ev.data));
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
    headers: cabeceras({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  log(
    `GPS en geocerca de ${siguientePendiente.id} (${body.lat}, ${body.lon})`,
  );
});
