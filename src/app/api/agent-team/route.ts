import { NextResponse } from "next/server";
import { WebSocket } from "ws";
import { loadStudioSettings } from "@/lib/studio/settings-store";

export const runtime = "nodejs";

const asTrimmedString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

type SpawnTreeNode = {
  id?: string;
  label?: string;
  session_id?: string;
  parent?: string;
};

type SpawnTreeResponse = { nodes?: SpawnTreeNode[] } | null;

export type AgentTeamSubagent = {
  id: string;
  label: string;
  session_id: string | null;
  parent: string | null;
};

const restBaseUrlFromGatewayUrl = (gatewayUrl: string) => {
  if (gatewayUrl.startsWith("http://") || gatewayUrl.startsWith("https://")) return gatewayUrl;
  return gatewayUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
};

const fetchWithTimeout = async (url: string, headers: HeadersInit, timeoutMs: number) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { headers, signal: controller.signal, cache: "no-store" });
  } finally {
    clearTimeout(timer);
  }
};

/**
 * hermes v0.19 exposes the sub-agent tree (spawn_tree.list) only as a JSON-RPC
 * method on its WebSocket gateway — no REST fallback. Speak the JSON-RPC
 * framing directly on /api/ws.
 */
const loadSubagentsViaJsonRpc = async (params: {
  restBase: string;
  token: string;
  agentId: string;
}): Promise<AgentTeamSubagent[]> => {
  const parsed = new URL(params.restBase.replace(/\/+$/, ""));
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  parsed.pathname = "/api/ws";
  const wsUrl = `${parsed.toString()}?token=${encodeURIComponent(params.token)}`;

  const tree = await new Promise<SpawnTreeResponse>((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { headers: { Host: "localhost" } });
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* not open */ }
      reject(new Error("spawn_tree.list timed out (12s)"));
    }, 12_000);
    ws.on("open", () => {
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "spawn_tree.list", params: { cross_session: true, limit: 50 } }));
    });
    ws.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as {
        id?: number; result?: unknown; error?: unknown;
        method?: string; params?: { type?: string };
      };
      // gateway.ready event arrives before any response.
      if (!frame.id) return;
      clearTimeout(timer);
      try { ws.close(); } catch { /* not open */ }
      if (frame.error) {
        reject(new Error(JSON.stringify(frame.error).slice(0, 160)));
        return;
      }
      resolve((frame.result ?? null) as SpawnTreeResponse);
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    });
    ws.on("close", (code) => {
      clearTimeout(timer);
      reject(new Error(`gateway closed (${code})`));
    });
  });

  const nodes = Array.isArray(tree?.nodes) ? tree.nodes : [];
  return nodes
    .map((node) => ({
      id: asTrimmedString(node.id),
      label:
        asTrimmedString(node.label) ||
        asTrimmedString(node.id) ||
        "(unnamed sub-agent)",
      session_id: asTrimmedString(node.session_id) || null,
      parent: asTrimmedString(node.parent) || params.agentId,
    }))
    .filter(
      (node) =>
        node.id.length > 0 &&
        (node.parent.toLowerCase() === params.agentId.toLowerCase() ||
          params.agentId.toLowerCase() === "default"),
    );
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  const agentId = asTrimmedString(url.searchParams.get("agentId"));
  if (!agentId) {
    return NextResponse.json({ error: "agent-team.agentId_required" }, { status: 400 });
  }

  // Scope: "all" viewers may query any profile; a scoped viewer may only
  // look at the profile(s) named in their own scope.
  const scopeHeader = asTrimmedString(request.headers.get("x-studio-user-scope")).toLowerCase();
  const scopeNames =
    scopeHeader === "all" || !scopeHeader
      ? null
      : scopeHeader.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (scopeNames && !scopeNames.some((name) => name.toLowerCase() === agentId.toLowerCase())) {
    return NextResponse.json({ error: "agent-team.agentId_forbidden" }, { status: 403 });
  }

  const settings = loadStudioSettings();
  const gatewayUrl = asTrimmedString(settings.gateway?.url);
  const token = asTrimmedString(settings.gateway?.token);
  if (!gatewayUrl || !token) {
    return NextResponse.json({ error: "agent-team.gateway_unconfigured" }, { status: 503 });
  }
  const base = restBaseUrlFromGatewayUrl(gatewayUrl).replace(/\/+$/, "");
  const headers = { Authorization: `Bearer ${token}` };

  try {
    const [profilesResponse, sessionsResponse] = await Promise.all([
      fetchWithTimeout(`${base}/api/profiles`, headers, 12_000),
      fetchWithTimeout(
        `${base}/api/profiles/sessions?profile=${encodeURIComponent(agentId)}&limit=50&order=recent`,
        headers,
        15_000,
      ),
    ]);
    if (!profilesResponse.ok) {
      return NextResponse.json(
        { error: `agent-team.profiles_http_${profilesResponse.status}` },
        { status: 502 },
      );
    }
    const profilesPayload = (await profilesResponse.json()) as {
      profiles?: Array<{ name?: string }>;
    };
    const profilesCount = (profilesPayload.profiles ?? []).length;

    let sessions: Array<Record<string, unknown>> = [];
    if (sessionsResponse.ok) {
      const payload = (await sessionsResponse.json()) as {
        sessions?: Array<Record<string, unknown>>;
      };
      sessions = (payload.sessions ?? []).slice(0, 10);
    }

    let subagents: AgentTeamSubagent[] = [];
    let subagentsNote: string | null = null;
    if (sessionsResponse.ok) {
      try {
        subagents = await loadSubagentsViaJsonRpc({ restBase: base, token, agentId });
      } catch (error) {
        subagents = [];
        subagentsNote =
          error instanceof Error ? error.message.slice(0, 120) : "spawn_tree unavailable";
      }
    }

    return NextResponse.json(
      {
        agentId,
        profilesCount,
        sessions,
        subagents,
        ...(subagentsNote ? { subagentsNote } : {}),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "agent-team request failed";
    console.error("[agent-team] request failed.", { error: message, agentId });
    return NextResponse.json({ error: message }, { status: 502 });
  }
}