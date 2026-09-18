import type { RecipientUi } from "../types/tracking";

type Props = {
  ui: RecipientUi;
};

export function StatusBanner({ ui }: Props) {
  const text =
    ui === "will_be_there"
      ? "Hemos registrado que estarás. El mapa sigue actualizándose."
      : ui === "reschedule_requested"
        ? "Hemos pedido reprogramar la entrega. El mapa sigue visible."
        : null;

  if (!text) return null;

  return (
    <p className="banner" role="status" data-testid="status-banner">
      {text}
    </p>
  );
}
