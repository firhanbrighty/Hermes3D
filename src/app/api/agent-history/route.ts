import { NextResponse } from "next/server";
import { loadStudioSettings } from "@/lib/studio/settings-store";

export const runtime = "nodejs";

type HermesRestSession = {
  id?: string;
  display_name?: string | null;
  profile?: string;
  started_at?: number | null;
  ended_at?: number | null;
  message_count?: number;
  source?: string | null;
  model?: string | null;
  tool_call_count?: number;
};

type HermesRestSessionsResponse = {
  sessions?: HermesRestSession[];
};

type HermesRestMessagesResponse = {
  messages?: Array<{
    role?: string;
    text?: string;
    content?: string;
  }>;
};

export type AgentHistorySession = {
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

export type AgentHistoryResponse = {
  agentId: string;
  sessions: AgentHistorySession[];
};

const asTrimmedString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

const fetchWithTimeout = async (url: string, headers: HeadersInit, timeoutMs: number) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { headers, signal: controller.signal, cache: "no-store" });
  } finally {
    clearTimeout(timer);
  }
};

/** CEO-only: "all" bawaan master token atau header kosong (legacy deployment). */
const resolveViewerScope = (request: Request) => {
  const header = asTrimmedString(request.headers.get("x-studio-user-scope")).toLowerCase();
  if (!header) return "all";
  if (header === "all" || header === "*") return "all";
  return header;
};

const restBaseUrlFromGatewayUrl = (gatewayUrl: string) => {
  if (gatewayUrl.startsWith("http://") || gatewayUrl.startsWith("https://")) return gatewayUrl;
  return gatewayUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
};

/** Preview: 200 karakter pertama dari pesan user terakhir, bila ada. */
const buildPreview = (payload: HermesRestMessagesResponse) => {
  const messages = payload.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (asTrimmedString(message?.role).toLowerCase() !== "user") continue;
    const text = asTrimmedString(message?.text) || asTrimmedString(message?.content);
    if (!text) continue;
    return text.slice(0, 200);
  }
  return null;
};

export async function GET(request: Request) {
  const scope = resolveViewerScope(request);
  const agentIdParam = asTrimmedString(
    new URL(request.url).searchParams.get("agentId"),
  );
  // Manager (scoped viewer) boleh membaca riwayat profilnya sendiri; CEO boleh semua.
  if (scope !== "all") {
    const scopeList = scope.split(",").filter(Boolean);
    const owns = (agentIdParam || "").length > 0 &&
      scopeList.some((name) => name.toLowerCase() === agentIdParam.toLowerCase());
    if (!owns) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
  }

  const agentId = agentIdParam;
  if (!agentId) {
    return NextResponse.json({ error: "invalid_agent_id" }, { status: 400 });
  }
  const sessionId = asTrimmedString(new URL(request.url).searchParams.get("sessionId"));
  const limitParam = asTrimmedString(new URL(request.url).searchParams.get("limit"));
  const parsedLimit = Number.parseInt(limitParam, 10);
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 200) : 50;

  const settings = loadStudioSettings();
  const gatewayUrl = asTrimmedString(settings.gateway?.url);
  if (!gatewayUrl) {
    return NextResponse.json({ error: "studio.gateway_url_missing" }, { status: 503 });
  }
  const token = asTrimmedString(settings.gateway?.token);
  const headers = { Authorization: `Bearer ${token}` };
  const base = restBaseUrlFromGatewayUrl(gatewayUrl).replace(/\/+$/, "");

  // Transcript satu session: proxy endpoint messages hermes REST. 501 bila tak ada.
  if (sessionId) {
    try {
      const messagesResponse = await fetchWithTimeout(
        `${base}/api/sessions/${encodeURIComponent(sessionId)}/messages`,
        headers,
        15_000,
      );
      if (!messagesResponse.ok) {
        if (messagesResponse.status === 404) {
          return NextResponse.json({ error: "hermes_messages_endpoint_unavailable" }, { status: 501 });
        }
        throw new Error(`messages endpoint HTTP ${messagesResponse.status}`);
      }
      const payload = (await messagesResponse.json()) as { messages?: unknown };
      return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      const message = error instanceof Error ? error.message : "hermes REST messages failed";
      console.error("[agent-history] Failed to load session transcript.", { agentId, sessionId, error: message });
      return NextResponse.json({ error: message }, { status: 502 });
    }
  }

  let sessions: HermesRestSession[];
  try {
    const response = await fetchWithTimeout(
      `${base}/api/profiles/sessions?profile=${encodeURIComponent(agentId)}&limit=${limit}&order=recent`,
      headers,
      15_000,
    );
    if (!response.ok) throw new Error(`sessions endpoint HTTP ${response.status}`);
    sessions = ((await response.json()) as HermesRestSessionsResponse).sessions ?? [];
  } catch (error) {
    const message = error instanceof Error ? error.message : "hermes REST sessions failed";
    console.error("[agent-history] Failed to list sessions.", { agentId, error: message });
    return NextResponse.json({ error: message }, { status: 502 });
  }

  const ordered = sessions
    .filter((session) => (asTrimmedString(session.profile) || "default") === agentId)
    .sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0));

  // Transcript penuh butuh session-key mapping gateway; ringkas per session,
  // plus preview dari endpoint messages hermes REST. 501 kalau endpoint tak ada.
  let messagesEndpointAvailable = true;
  const enriched: AgentHistorySession[] = [];
  for (const session of ordered.slice(0, limit)) {
    const id = asTrimmedString(session.id) || asTrimmedString(session.display_name);
    const record: AgentHistorySession = {
      id,
      display_name: asTrimmedString(session.display_name) || id,
      started_at:
        session.started_at !== null && session.started_at !== undefined
          ? Math.round(session.started_at * 1000)
          : null,
      ended_at:
        session.ended_at !== null && session.ended_at !== undefined
          ? Math.round(session.ended_at * 1000)
          : null,
      message_count: typeof session.message_count === "number" ? session.message_count : null,
      source: asTrimmedString(session.source) || null,
      model: asTrimmedString(session.model) || null,
      tool_call_count:
        typeof session.tool_call_count === "number" ? session.tool_call_count : null,
      preview: null,
    };
    if (id && messagesEndpointAvailable) {
      try {
        const messagesResponse = await fetchWithTimeout(
          `${base}/api/sessions/${encodeURIComponent(id)}/messages`,
          headers,
          10_000,
        );
        if (messagesResponse.ok) {
          const payload = (await messagesResponse.json()) as HermesRestMessagesResponse;
          record.preview = buildPreview(payload);
        } else if (messagesResponse.status === 404) {
          messagesEndpointAvailable = false;
        } else {
          throw new Error(`messages endpoint HTTP ${messagesResponse.status}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "hermes REST messages failed";
        console.warn("[agent-history] Messages preview unavailable.", { sessionId: id, error: message });
        if (/endpoint|404/.test(message)) messagesEndpointAvailable = false;
      }
    }
    enriched.push(record);
  }

  if (!messagesEndpointAvailable && enriched.length) {
    return NextResponse.json(
      { error: "hermes_messages_endpoint_unavailable" },
      { status: 501 },
    );
  }

  const body: AgentHistoryResponse = { agentId, sessions: enriched };
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}