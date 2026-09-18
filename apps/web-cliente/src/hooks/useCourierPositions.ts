import { useEffect, useState } from "react";
import {
  fetchCourierPosition,
  isTrackingGoneError,
} from "../lib/tracking-api";
import type { GoneReason, TrackingPosition } from "../types/tracking";

const POLL_MS = 8_000;

export function useCourierPositions(
  token: string | null,
  enabled: boolean,
  onGone?: (reason: GoneReason) => void,
) {
  const [position, setPosition] = useState<TrackingPosition | null>(null);

  useEffect(() => {
    if (!token || !enabled) return;
    let cancelled = false;

    async function poll() {
      try {
        const next = await fetchCourierPosition(token!);
        if (!cancelled && next) setPosition(next);
      } catch (err) {
        if (cancelled) return;
        if (isTrackingGoneError(err)) onGone?.(err.reason);
      }
    }

    void poll();
    const id = window.setInterval(() => {
      void poll();
    }, POLL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [token, enabled, onGone]);

  return { position };
}
