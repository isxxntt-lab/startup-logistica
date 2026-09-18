import { useCallback, useEffect, useState } from "react";
import {
  fetchTrackingSession,
  isTrackingGoneError,
  readTokenFromSearchParams,
} from "../lib/tracking-api";
import type { GoneReason, TokenGate, TrackingSession } from "../types/tracking";

export function useTrackingToken() {
  const [token] = useState<string | null>(() => readTokenFromSearchParams());
  const [gate, setGate] = useState<TokenGate>(token ? "loading" : "invalid");
  const [reason, setReason] = useState<GoneReason | null>(null);
  const [session, setSession] = useState<TrackingSession | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    void (async () => {
      try {
        const data = await fetchTrackingSession(token);
        if (cancelled) return;
        setSession(data);
        setGate("valid");
      } catch (err) {
        if (cancelled) return;
        if (isTrackingGoneError(err)) {
          setReason(err.reason);
          setGate(err.reason === "used" ? "used" : "expired");
          return;
        }
        setGate("invalid");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const applyGone = useCallback((gone: GoneReason) => {
    setReason(gone);
    setGate(gone === "used" ? "used" : "expired");
  }, []);

  return { token, gate, reason, session, applyGone };
}
