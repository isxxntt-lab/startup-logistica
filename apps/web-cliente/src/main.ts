import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";

const api = import.meta.env.VITE_API_URL ?? "http://localhost:3000";
const token = new URLSearchParams(location.search).get("token");
const errorEl = document.querySelector("#error") as HTMLParagraphElement;
const titulo = document.querySelector("#titulo") as HTMLHeadingElement;
const estadoEl = document.querySelector("#estado") as HTMLParagraphElement;
const acciones = document.querySelector("#acciones") as HTMLElement;
const puntosEl = document.querySelector("#puntos") as HTMLUListElement;

function fail(msg: string) {
  errorEl.textContent = msg;
}

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${api}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<T>;
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${api}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<T>;
}

if (!token) {
  titulo.textContent = "Enlace no válido";
  fail("Falta el token de acceso en la URL.");
} else {
  void bootstrap();
}

async function bootstrap() {
  try {
    const parada = await apiGet<{
      cliente_nombre: string;
      direccion_texto: string;
      estado: string;
      lat: number;
      lon: number;
    }>("/cliente/parada");

    titulo.textContent = parada.direccion_texto;
    estadoEl.textContent = parada.estado;
    acciones.hidden = false;

    const map = new maplibregl.Map({
      container: "mapa",
      style: "https://tiles.openfreemap.org/styles/liberty",
      center: [parada.lon, parada.lat],
      zoom: 15,
    });
    new maplibregl.Marker().setLngLat([parada.lon, parada.lat]).addTo(map);

    acciones.addEventListener("click", async (ev) => {
      const btn = (ev.target as HTMLElement).closest("button");
      if (!btn) return;
      if (btn.id === "btn-puntos") {
        await cargarPuntos();
        return;
      }
      const accion = btn.getAttribute("data-accion");
      if (!accion) return;
      const result = await apiPost<{ estado: string }>("/cliente/parada/respuesta", {
        accion,
      });
      estadoEl.textContent = result.estado;
    });
  } catch (err) {
    titulo.textContent = "No se pudo abrir la entrega";
    fail((err as Error).message);
  }
}

async function cargarPuntos() {
  const data = await apiGet<{
    puntos: Array<{
      id: string;
      nombre: string;
      distancia_m: number;
    }>;
  }>("/cliente/puntos-recogida");
  puntosEl.innerHTML = "";
  for (const punto of data.puntos) {
    const li = document.createElement("li");
    li.textContent = `${punto.nombre} · ${Math.round(punto.distancia_m)} m`;
    li.addEventListener("click", async () => {
      const result = await apiPost<{ estado: string }>(
        "/cliente/parada/respuesta",
        { accion: "reasignado", punto_recogida_id: punto.id },
      );
      estadoEl.textContent = result.estado;
    });
    puntosEl.append(li);
  }
}
