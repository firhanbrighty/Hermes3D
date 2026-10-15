"use client";

import { useCallback, useEffect, useState } from "react";
import { Bot, Clock, Loader2 } from "lucide-react";

type AgentTeamSession = {
  id: string;
  display_name: string;
  started_at: number | null;
  ended_at: number | null;
  message_count: number | null;
  source: string | null;
  profile: string;
};

type AgentTeamSubagent = {
  id: string;
  label: string;
  session_id: string | null;
  parent: string;
};

type AgentTeamResponse = {
  agentId: string;
  profilesCount: number;
  sessions: AgentTeamSession[];
  subagents: AgentTeamSubagent[];
  error?: string;
};

const formatTimestamp = (value: number | null) => {
  if (value === null) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
};

/**
 * Manager-facing inspect section: recent sessions plus any sub-agents the
 * backend exposes for this profile. No tokens are shown here — it renders for
 * every viewer, but the API only answers for the viewer's own scoped profile
 * unless the viewer is CEO.
 */
export const AgentTeamSection = ({ agentId }: { agentId: string }) => {
  const [state, setState] = useState<{
    loading: boolean;
    data: AgentTeamResponse | null;
    error: string | null;
  }>({ loading: true, data: null, error: null });

  const load = useCallback(async () => {
    setState((current) => ({ ...current, loading: true, error: null, data: null }));
    try {
      const response = await fetch(
        `/api/agent-team?agentId=${encodeURIComponent(agentId)}`,
        { cache: "no-store" },
      );
      const payload = (await response.json()) as AgentTeamResponse;
      if (!response.ok) {
        setState({ loading: false, data: null, error: payload.error ?? `Request failed (${response.status})` });
        return;
      }
      setState({ loading: false, data: payload, error: null });
    } catch (error) {
      setState({
        loading: false,
        data: null,
        error: error instanceof Error ? error.message : "Failed to load team",
      });
    }
  }, [agentId]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void load();
    }, 0);
    return () => clearTimeout(timer);
  }, [load]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-6">
      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4">
        <section className="sidebar-section" data-testid="agent-team">
          <div className="px-1 py-1">
            <span className="font-medium text-foreground/88 text-[12px]">Team activity</span>
            <div className="sidebar-copy mt-1 text-[11px] text-muted-foreground">
              Recent sessions and sub-agents for profile{" "}
              <span className="font-mono">{agentId}</span>.
            </div>

            {state.loading ? (
              <div className="mt-3 flex items-center gap-2 text-[11px] text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Loading team…
              </div>
            ) : state.error ? (
              <div className="mt-2 text-[11px] text-[var(--destructive)]">{state.error}</div>
            ) : (
              <>
                <div className="mt-3 space-y-2">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Sessions ({state.data?.sessions.length ?? 0})
                  </div>
                  {(state.data?.sessions.length ?? 0) === 0 ? (
                    <div className="text-[11px] text-muted-foreground">No sessions yet.</div>
                  ) : (
                    (state.data?.sessions ?? []).map((session) => (
                      <div
                        key={session.id}
                        className="rounded-md border border-border/50 bg-background/40 px-3 py-2"
                        data-testid="agent-team-session"
                      >
                        <div className="flex items-center gap-2 text-[12px] font-medium text-foreground">
                          <Clock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          <span className="truncate">{session.display_name}</span>
                        </div>
                        <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-muted-foreground">
                          <span>
                            {formatTimestamp(session.started_at)} → {formatTimestamp(session.ended_at)}
                          </span>
                          <span>{session.message_count ?? 0} msgs</span>
                          {session.source ? <span className="font-mono">{session.source}</span> : null}
                        </div>
                      </div>
                    ))
                  )}
                </div>

                <div className="mt-4 space-y-2">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Sub-agents ({state.data?.subagents.length ?? 0})
                  </div>
                  {(state.data?.subagents.length ?? 0) === 0 ? (
                    <div className="text-[11px] text-muted-foreground">
                      No sub-agents observed for this profile.
                    </div>
                  ) : (
                    (state.data?.subagents ?? []).map((subagent) => (
                      <div
                        key={subagent.id}
                        className="flex items-center gap-2 rounded-md border border-border/50 bg-background/40 px-3 py-2 text-[12px] text-foreground"
                        data-testid="agent-team-subagent"
                      >
                        <Bot className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="font-medium">{subagent.label}</span>
                        <span className="ml-auto font-mono text-[11px] text-muted-foreground">
                          {subagent.id}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </>
            )}
          </div>
        </section>
      </div>
    </div>
  );
};