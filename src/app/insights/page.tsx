"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useViewerIsOwner } from "@/features/agents/components/inspect/useViewerIsOwner";

type HermesProfile = {
  agentId: string;
  name: string;
  emoji: string;
};

type HistorySession = {
  id: string;
  display_name: string;
  started_at: number | null;
  ended_at: number | null;
  message_count: number | null;
  source: string | null;
  model: string | null;
  tool_call_count: number | null;
  preview: string | null;
};

type HistoryMessage = {
  role?: string;
  text?: string;
  content?: string;
};

type ActivityFrame = {
  id: string;
  at: number;
  summary: string;
};

const formatRelativeTime = (timestampMs: number | null) => {
  if (timestampMs === null) return "unknown time";
  const deltaMs = Date.now() - timestampMs;
  if (deltaMs < 60_000) return `${Math.max(1, Math.floor(deltaMs / 1000))}s ago`;
  if (deltaMs < 3_600_000) return `${Math.floor(deltaMs / 60_000)}m ago`;
  if (deltaMs < 86_400_000) return `${Math.floor(deltaMs / 3_600_000)}h ago`;
  return `${Math.floor(deltaMs / 86_400_000)}d ago`;
};

const frameSummary = (frame: Record<string, unknown>) => {
  if (typeof frame.text === "string" && frame.text.trim()) return frame.text.trim().slice(0, 240);
  return JSON.stringify(frame).slice(0, 240);
};

const SESSION_MESSAGES_LIMIT = 40;
const ACTIVITY_KEEP = 10;

export default function InsightsPage() {
  const isOwner = useViewerIsOwner();
  const [profiles, setProfiles] = useState<HermesProfile[]>([]);
  const [profilesError, setProfilesError] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<HistorySession[] | null>(null);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [expandedSessionId, setExpandedSessionId] = useState<string | null>(null);
  const [sessionMessages, setSessionMessages] = useState<HistoryMessage[] | null>(null);
  const [messagesError, setMessagesError] = useState<string | null>(null);
  const [activity, setActivity] = useState<ActivityFrame[]>([]);
  const [activityStatus, setActivityStatus] = useState<"idle" | "connecting" | "live" | "closed">("idle");
  const selectedRef = useRef<string | null>(null);

  useEffect(() => {
    selectedRef.current = selectedAgentId;
  }, [selectedAgentId]);

  const refreshProfiles = useCallback(async () => {
    try {
      setProfilesError(null);
      const response = await fetch("/api/profiles", { cache: "no-store" });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Request failed (${response.status})`);
      }
      const payload = (await response.json()) as {
        profiles?: Array<{ agentId: string; name: string; emoji: string }>;
      };
      setProfiles(payload.profiles ?? []);
    } catch (err) {
      setProfilesError(err instanceof Error ? err.message : "Failed to load profiles.");
    }
  }, []);

  useEffect(() => {
    void refreshProfiles();
  }, [refreshProfiles]);

  const selectAgent = useCallback((agentId: string) => {
    setSelectedAgentId(agentId);
    setSessions(null);
    setSessionsError(null);
    setExpandedSessionId(null);
    setSessionMessages(null);
    setMessagesError(null);
    setActivity([]);
  }, []);

  // Daftar sessions untuk agent terpilih.
  useEffect(() => {
    if (!isOwner || !selectedAgentId) return;
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`/api/agent-history?agentId=${encodeURIComponent(selectedAgentId)}`, {
          cache: "no-store",
        });
        if (!cancelled && !response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `Request failed (${response.status})`);
        }
        if (cancelled) return;
        const payload = (await response.json()) as { sessions?: HistorySession[] };
        setSessions(payload.sessions ?? []);
      } catch (err) {
        if (!cancelled) {
          setSessions([]);
          setSessionsError(err instanceof Error ? err.message : "Failed to load history.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOwner, selectedAgentId]);

  // Live activity SSE untuk agent terpilih.
  useEffect(() => {
    if (!isOwner || !selectedAgentId) {
      setActivityStatus("idle");
      return;
    }
    setActivityStatus("connecting");
    const source = new EventSource(`/api/agent-activity?agentId=${encodeURIComponent(selectedAgentId)}`);
    let sequence = 0;
    source.onopen = () => setActivityStatus("live");
    source.onmessage = (event) => {
      try {
        const frame = JSON.parse(event.data) as Record<string, unknown>;
        sequence += 1;
        setActivity((previous) =>
          [
            ...previous,
            {
              id: `frame-${sequence}`,
              at: typeof frame.atMs === "number" ? frame.atMs : Date.now(),
              summary: frameSummary(frame),
            },
          ].slice(-ACTIVITY_KEEP),
        );
      } catch {
        // frame bukan JSON valid; abaikan
      }
    };
    source.onerror = () => setActivityStatus("closed");
    return () => {
      source.close();
      setActivityStatus("idle");
    };
  }, [isOwner, selectedAgentId]);

  // Isi satu session saat di-expand.
  useEffect(() => {
    if (!isOwner || !selectedAgentId || !expandedSessionId) return;
    const agentId = selectedAgentId;
    const sessionId = expandedSessionId;
    let cancelled = false;
    (async () => {
      try {
        setMessagesError(null);
        setSessionMessages(null);
        const messagesResponse = await fetch(
          `/api/agent-history?agentId=${encodeURIComponent(agentId)}&sessionId=${encodeURIComponent(sessionId)}`,
          { cache: "no-store" },
        );
        if (cancelled) return;
        if (!messagesResponse.ok) {
          if (messagesResponse.status === 501) {
            throw new Error("Transcript penuh belum tersedia (endpoint messages hermes tidak ada).");
          }
          throw new Error(`Request failed (${messagesResponse.status})`);
        }
        const payload = (await messagesResponse.json()) as { messages?: HistoryMessage[] };
        setSessionMessages(payload.messages ?? []);
      } catch (err) {
        if (!cancelled) {
          setMessagesError(err instanceof Error ? err.message : "Failed to load messages.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOwner, selectedAgentId, expandedSessionId]);

  if (!isOwner) {
    return (
      <main className="mx-auto min-h-screen max-w-3xl px-6 py-10">
        <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-6 text-sm">
          <p className="font-medium text-[var(--destructive)]">Forbidden</p>
          <p className="mt-1 text-[var(--muted-foreground)]">
            Halaman insights hanya tersedia untuk akun CEO (scope &quot;all&quot;).
          </p>
        </div>
      </main>
    );
  }

  const selectedProfile = profiles.find((profile) => profile.agentId === selectedAgentId) ?? null;

  return (
    <main className="mx-auto min-h-screen max-w-5xl px-6 py-10">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Agent Insights</h1>
        <p className="mt-1 text-sm text-[var(--muted-foreground)]">
          Riwayat session and live activity per agent (CEO only).
        </p>
      </header>

      {profilesError ? (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4 text-sm">
          <p className="font-medium text-[var(--destructive)]">Could not load profiles</p>
          <p className="mt-1 text-[var(--muted-foreground)]">{profilesError}</p>
        </div>
      ) : profiles.length === 0 ? (
        <p className="text-sm text-[var(--muted-foreground)]">Loading profiles…</p>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
              Agents
            </p>
            <ul className="space-y-1.5">
              {profiles.map((profile) => (
                <li key={profile.agentId}>
                  <button
                    onClick={() => selectAgent(profile.agentId)}
                    className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                      profile.agentId === selectedAgentId
                        ? "border-[var(--border)] bg-[var(--accent)] text-[var(--accent-foreground)]"
                        : "border-[var(--border)] bg-[var(--card)] hover:bg-[var(--accent)]"
                    }`}
                  >
                    <span className="text-lg">{profile.emoji}</span>
                    <span className="truncate font-medium">{profile.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div className="space-y-6">
            {!selectedProfile ? (
              <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4 text-sm text-[var(--muted-foreground)]">
                Pilih agent di kiri untuk melihat riwayat session dan live activity.
              </div>
            ) : (
              <>
                <section className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
                  <div className="flex items-center justify-between">
                    <h2 className="font-medium">Live activity · {selectedProfile.name}</h2>
                    <span
                      className={`rounded-full border border-[var(--border)] px-2 py-0.5 text-[10px] uppercase tracking-wide ${
                        activityStatus === "live" && activity.length > 0
                          ? "bg-[oklch(0.62_0.17_145)] text-white"
                          : "bg-[var(--muted)] text-[var(--muted-foreground)]"
                      }`}
                    >
                      {activityStatus === "live"
                        ? activity.length > 0
                          ? "live"
                          : "listening"
                        : activityStatus}
                    </span>
                  </div>
                  {activity.length > 0 ? (
                    <p className="mt-1 text-[10px] text-[var(--muted-foreground)]">
                      event terakhir: {new Date(activity[activity.length - 1].at).toLocaleTimeString()} ·{" "}
                      {Math.max(1, Math.round((Date.now() - activity[activity.length - 1].at) / 1000))}s lalu
                    </p>
                  ) : null}
                  {activity.length === 0 ? (
                    <p className="mt-3 text-xs text-[var(--muted-foreground)]">
                      {activityStatus === "live"
                        ? "Belum ada event untuk agent ini."
                        : activityStatus === "connecting"
                          ? "Menghubungkan ke event stream…"
                          : "Belum ada event (stream idle)."}
                    </p>
                  ) : (
                    <ul className="mt-3 space-y-1.5">
                      {[...activity].reverse().map((frame) => (
                        <li key={frame.id} className="flex gap-3 text-xs">
                          <span className="shrink-0 text-[var(--muted-foreground)]">
                            {new Date(frame.at).toLocaleTimeString()}
                          </span>
                          <span className="break-words text-[var(--muted-foreground)]">{frame.summary}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                <section className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
                  <h2 className="font-medium">Sessions · {selectedProfile.name}</h2>
                  {sessionsError ? (
                    <p className="mt-3 text-sm text-[var(--destructive)]">{sessionsError}</p>
                  ) : sessions === null ? (
                    <p className="mt-3 text-sm text-[var(--muted-foreground)]">Loading history…</p>
                  ) : sessions.length === 0 ? (
                    <p className="mt-3 text-sm text-[var(--muted-foreground)]">Belum ada session tercatat.</p>
                  ) : (
                    <ul className="mt-3 space-y-2">
                      {sessions.map((session) => {
                        const isExpanded = session.id === expandedSessionId;
                        return (
                          <li key={session.id} className="rounded-lg border border-[var(--border)]">
                            <button
                              onClick={() => setExpandedSessionId(isExpanded ? null : session.id)}
                              className="flex w-full flex-wrap items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-[var(--accent)]"
                            >
                              <span className="truncate font-medium">
                                {session.display_name || session.id}
                              </span>
                              <span className="flex items-center gap-2 text-xs text-[var(--muted-foreground)]">
                                {session.source ? (
                                  <span className="rounded bg-[var(--muted)] px-1.5 py-0.5">{session.source}</span>
                                ) : null}
                                {session.message_count !== null ? `${session.message_count} msgs` : ""}
                                <span>{formatRelativeTime(session.started_at)}</span>
                              </span>
                            </button>
                            {isExpanded ? (
                              <div className="border-t border-[var(--border)] px-3 py-2.5">
                                {session.preview ? (
                                  <p className="mb-2 line-clamp-2 rounded bg-[var(--muted)] px-2 py-1.5 text-xs text-[var(--muted-foreground)]">
                                    {session.preview}
                                  </p>
                                ) : null}
                                {messagesError ? (
                                  <p className="text-xs text-[var(--destructive)]">{messagesError}</p>
                                ) : sessionMessages === null ? (
                                  <p className="text-xs text-[var(--muted-foreground)]">Loading messages…</p>
                                ) : sessionMessages.length === 0 ? (
                                  <p className="text-xs text-[var(--muted-foreground)]">Tidak ada pesan.</p>
                                ) : (
                                  <ul className="space-y-1.5">
                                    {sessionMessages.slice(-SESSION_MESSAGES_LIMIT).map((message, index) => (
                                      <li
                                        key={`${session.id}-message-${index}`}
                                        className="rounded bg-[var(--muted)] px-2.5 py-1.5 text-xs"
                                      >
                                        <span className="font-medium capitalize">
                                          {message.role ?? "unknown"}
                                        </span>
                                        {": "}
                                        {message.text || message.content}
                                      </li>
                                    ))}
                                  </ul>
                                )}
                              </div>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </section>
              </>
            )}
          </div>
        </div>
      )}
    </main>
  );
}