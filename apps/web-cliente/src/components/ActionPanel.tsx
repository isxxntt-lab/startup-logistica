import { useState } from "react";
import type { RecipientUi } from "../types/tracking";

type Props = {
  ui: RecipientUi;
  busy: boolean;
  onConfirmPresence: () => void;
  onReschedule: (preferredWindow?: string) => void;
};

export function ActionPanel({
  ui,
  busy,
  onConfirmPresence,
  onReschedule,
}: Props) {
  const [windowText, setWindowText] = useState("");
  const confirming = ui === "confirming";
  const rescheduling = ui === "rescheduling";

  return (
    <section id="acciones" aria-busy={busy}>
      <button
        type="button"
        disabled={busy}
        onClick={onConfirmPresence}
      >
        {confirming ? <span className="spinner" aria-hidden /> : null}
        Estaré ahí
      </button>
      <label className="ventana">
        Ventana preferida (opcional)
        <input
          type="text"
          value={windowText}
          disabled={busy}
          placeholder="p. ej. mañana 18:00–20:00"
          onChange={(ev) => setWindowText(ev.target.value)}
        />
      </label>
      <button
        type="button"
        className="ghost"
        disabled={busy}
        onClick={() => onReschedule(windowText.trim() || undefined)}
      >
        {rescheduling ? <span className="spinner" aria-hidden /> : null}
        Reprogramar
      </button>
      {ui === "action_error" ? (
        <p className="error" role="alert">
          No se pudo guardar tu respuesta. Inténtalo de nuevo.
        </p>
      ) : null}
    </section>
  );
}
