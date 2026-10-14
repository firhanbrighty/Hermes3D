"use client";

import { useEffect, useState } from "react";

/**
 * True when the studio viewer's scope is "all" (master/CEO). Reads the
 * identity surfaced by the access gate via /api/studio/viewer.
 */
export const useViewerIsOwner = (): boolean => {
  const [isOwner, setIsOwner] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/studio/viewer", { cache: "no-store" });
        if (!response.ok) return;
        const payload = (await response.json()) as { scope?: string };
        if (!cancelled && payload.scope === "all") setIsOwner(true);
      } catch {
        // not owner
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return isOwner;
};