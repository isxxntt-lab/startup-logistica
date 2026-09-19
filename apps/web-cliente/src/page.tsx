import { lazy, Suspense } from "react";
import { ActionPanel } from "./components/ActionPanel";
import { CourierDistance } from "./components/CourierDistance";
import { StatusBanner } from "./components/StatusBanner";
import { TokenErrorView } from "./components/TokenErrorView";
import { TrackingShell } from "./components/TrackingShell";
import { useCourierPositions } from "./hooks/useCourierPositions";
import { useRecipientActions } from "./hooks/useRecipientActions";
import { useTrackingToken } from "./hooks/useTrackingToken";

const TrackingMap = lazy(() => import("./components/TrackingMap"));

export function TrackingPage() {
  const { token, gate, reason, session, applyGone } = useTrackingToken();
  const live = gate === "valid";
  const { position } = useCourierPositions(token, live, applyGone);
  const actions = useRecipientActions(token, session, applyGone);

  if (gate === "loading") {
    return (
      <TrackingShell title="Cargando…">
        <p className="muted">Comprobando tu enlace de seguimiento.</p>
      </TrackingShell>
    );
  }

  if (gate !== "valid" || !session) {
    const errorGate = gate === "valid" ? "invalid" : gate;
    return <TokenErrorView gate={errorGate} reason={reason} />;
  }

  return (
    <TrackingShell
      title={session.direccionTexto}
      subtitle={session.referenciaPedido ?? session.clienteNombre}
    >
      <Suspense fallback={<div id="mapa" className="mapa-loading" />}>
        <TrackingMap delivery={session.delivery} courier={position} />
      </Suspense>
      <CourierDistance delivery={session.delivery} courier={position} />
      {actions.showBanner ? <StatusBanner ui={actions.ui} /> : null}
      {actions.showActions ? (
        <ActionPanel
          ui={actions.ui}
          busy={actions.busy}
          onConfirmPresence={() => {
            void actions.confirmPresence();
          }}
          onReschedule={(window) => {
            void actions.reschedule(window);
          }}
        />
      ) : null}
    </TrackingShell>
  );
}
