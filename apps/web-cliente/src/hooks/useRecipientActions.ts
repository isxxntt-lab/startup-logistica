import { useCallback, useEffect, useRef, useState } from "react";
import {
  isTrackingGoneError,
  postConfirmPresence,
  postReschedule,
} from "../lib/tracking-api";
import type {
  GoneReason,
  RecipientUi,
  TrackingSession,
} from "../types/tracking";

function uiFromSession(session: TrackingSession | null): RecipientUi {
  if (!session) return "idle";
  if (session.status === "will_be_there") return "will_be_there";
  if (session.status === "rescheduled") return "reschedule_requested";
  return "idle";
}

export function useRecipientActions(
  token: string | null,
  session: TrackingSession | null,
  onGone: (reason: GoneReason) => void,
) {
  const [ui, setUi] = useState<RecipientUi>(() => uiFromSession(session));
  const inFlight = useRef(false);

  useEffect(() => {
    setUi(uiFromSession(session));
  }, [session]);

  const confirmPresence = useCallback(async () => {
    if (!token || inFlight.current) return;
    if (ui !== "idle" && ui !== "action_error") return;
    inFlight.current = true;
    setUi("confirming");
    try {
      await postConfirmPresence(token);
      setUi("will_be_there");
    } catch (err) {
      if (isTrackingGoneError(err)) {
        onGone(err.reason);
        return;
      }
      setUi("action_error");
    } finally {
      inFlight.current = false;
    }
  }, [token, ui, onGone]);

  const reschedule = useCallback(
    async (preferredWindow?: string) => {
      if (!token || inFlight.current) return;
      if (ui !== "idle" && ui !== "action_error") return;
      inFlight.current = true;
      setUi("rescheduling");
      try {
        await postReschedule(token, preferredWindow);
        setUi("reschedule_requested");
      } catch (err) {
        if (isTrackingGoneError(err)) {
          onGone(err.reason);
          return;
        }
        setUi("action_error");
      } finally {
        inFlight.current = false;
      }
    },
    [token, ui, onGone],
  );

  const busy = ui === "confirming" || ui === "rescheduling";
  const showActions = ui === "idle" || ui === "confirming" || ui === "rescheduling" || ui === "action_error";
  const showBanner = ui === "will_be_there" || ui === "reschedule_requested";

  return { ui, confirmPresence, reschedule, busy, showActions, showBanner };
}
