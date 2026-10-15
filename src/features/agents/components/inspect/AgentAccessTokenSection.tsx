"use client";

import { useCallback, useEffect, useState } from "react";
import { useViewerIsOwner } from "@/features/agents/components/inspect/useViewerIsOwner";

type InviteResponse = {
  exists?: boolean;
  agentId?: string;
  userId?: string;
  label?: string;
  token?: string;
  error?: string;
};

/**
 * Access section in the agent editor:
 * - viewer scope "all" (CEO): full access — show/copy/mint untuk semua agent.
 * - scoped manager: token profilnya sendiri only, read-only reveal (tanpa mint).
 */
export const AgentAccessTokenSection = ({ agentId }: { agentId: string }) => {
  const isOwner = useViewerIsOwner();
  const [state, setState] = useState<{
    loading: boolean;
    userId: string | null;
    token: string | null;
    exists: boolean;
    error: string | null;
    revealed: boolean;
    mintBusy: boolean;
  }>({
    loading: true,
    userId: null,
    token: null,
    exists: false,
    error: null,
    revealed: false,
    mintBusy: false,
  });

  const load = useCallback(async () => {
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const response = await fetch(
        `/api/gateway/agent-create-invite?agentId=${encodeURIComponent(agentId)}`,
        { cache: "no-store" },
      );
      const payload = (await response.json()) as InviteResponse;
      if (!response.ok) {
        setState((current) => ({
          ...current,
          loading: false,
          error: payload.error ?? `Request failed (${response.status})`,
        }));
        return;
      }
      setState((current) => ({
        ...current,
        loading: false,
        exists: Boolean(payload.exists),
        userId: payload.userId ?? null,
        token: payload.token ?? null,
      }));
    } catch (error) {
      setState((current) => ({
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : "Failed to load token",
      }));
    }
  }, [agentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const mint = useCallback(async () => {
    if (!isOwner) return; // mint = CEO only
    setState((current) => ({ ...current, mintBusy: true, error: null }));
    try {
      const response = await fetch("/api/gateway/agent-create-invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId }),
      });
      const payload = (await response.json()) as InviteResponse;
      if (!response.ok || !payload.token) {
        setState((current) => ({
          ...current,
          mintBusy: false,
          error: payload.error ?? `Request failed (${response.status})`,
        }));
        return;
      }
      setState((current) => ({
        ...current,
        mintBusy: false,
        exists: true,
        userId: payload.userId ?? null,
        token: payload.token ?? null,
        revealed: true,
      }));
      // Reveal fresh tokens by default; existing ones require a click.
    } catch (error) {
      setState((current) => ({
        ...current,
        mintBusy: false,
        error: error instanceof Error ? error.message : "Failed to mint token",
      }));
    }
  }, [agentId, isOwner]);

  const tokenLabel = state.revealed ? state.token : "•".repeat(32);

  return (
    <section className="sidebar-section" data-testid="agent-access-token">
      <div className="px-1 py-1">
        <span className="font-medium text-foreground/88 text-[12px]">Manager access</span>
        {isOwner ? null : (
          <div className="sidebar-copy mt-1 text-[11px] text-muted-foreground">
            Token login dashboard untuk profil ini (terlihat karena profil ini milikmu).
          </div>
        )}
        {!isOwner ? null : (
          <div className="sidebar-copy mt-1 text-[11px] text-muted-foreground">
            Token yang dipakai manager profil ini untuk login dashboard
            (hermes.groovingspaces.com). Hanya tampil untuk akses CEO.
          </div>
        )}

        {state.loading ? (
          <div className="mt-2 text-[11px] text-muted-foreground">Loading…</div>
        ) : state.error ? (
          <div className="mt-2 text-[11px] text-[var(--destructive)]">{state.error}</div>
        ) : state.exists && state.token ? (
          <div className="mt-2">
            <div className="text-[11px] text-muted-foreground">
              {state.userId ? <span className="font-mono">{state.userId}</span> : null}
            </div>
            <div className="mt-1 flex items-center gap-2">
              <code className="flex-1 truncate rounded-md bg-muted px-2.5 py-1.5 font-mono text-[11px]">
                {tokenLabel}
              </code>
              <button
                type="button"
                data-testid="agent-token-toggle"
                onClick={() => setState((current) => ({ ...current, revealed: !current.revealed }))}
                className="rounded-md border border-border px-2.5 py-1.5 text-[11px] font-medium hover:bg-accent"
              >
                {state.revealed ? "Hide" : "Show"}
              </button>
              <button
                type="button"
                data-testid="agent-token-copy"
                onClick={() => {
                  if (state.revealed && state.token) void navigator.clipboard?.writeText(state.token);
                }}
                disabled={!state.revealed}
                className="rounded-md border border-border px-2.5 py-1.5 text-[11px] font-medium hover:bg-accent disabled:opacity-40"
              >
                Copy
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-2">
            <div className="text-[11px] text-muted-foreground">
              {isOwner
                ? "Belum ada token untuk profil ini."
                : "Token belum dibuat oleh CEO untuk profil ini."}
            </div>
            {isOwner ? (
              <button
                type="button"
                data-testid="agent-token-mint"
                onClick={() => void mint()}
                disabled={state.mintBusy}
                className="mt-2 rounded-md border border-border px-2.5 py-1.5 text-[11px] font-medium hover:bg-accent disabled:opacity-40"
              >
                {state.mintBusy ? "Minting…" : "Buat access token"}
              </button>
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
};