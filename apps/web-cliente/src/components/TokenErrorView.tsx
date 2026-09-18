import type { GoneReason, TokenGate } from "../types/tracking";

type Props = {
  gate: Exclude<TokenGate, "loading" | "valid">;
  reason?: GoneReason | null;
};

export function TokenErrorView({ gate, reason }: Props) {
  const kind = gate === "expired" || reason === "expired" ? "expired" : gate === "used" || reason === "used" ? "used" : "invalid";

  const copy = {
    expired: {
      title: "Enlace caducado",
      body: "Este enlace de seguimiento ha caducado y ya no se puede usar.",
    },
    used: {
      title: "Enlace utilizado",
      body: "Este enlace de seguimiento ya se ha utilizado.",
    },
    invalid: {
      title: "Enlace no válido",
      body: "Falta el token de acceso o el enlace no es válido.",
    },
  }[kind];

  return (
    <div id="app" data-testid="token-error" data-reason={kind}>
      <header>
        <p className="eyebrow">Entrega de hoy</p>
        <h1>{copy.title}</h1>
      </header>
      <p className="error" role="alert">
        {copy.body}
      </p>
    </div>
  );
}
