import { NextResponse } from "next/server";
import { NodeGatewayClient } from "@/lib/gateway/nodeGatewayClient";
import { loadStudioSettings } from "@/lib/studio/settings-store";

export const runtime = "nodejs";

type HermesRestSessionsResponse = {
  sessions?: Array<{
    id?: string;
    display_name?: string | null;
    profile?: string;
    started_at?: number | null;
    ended_at?: number | null;
    message_count?: number;
    source?: string | null;
  }>;
};

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
};

type SpawnTreeResponse = {
  nodes?: Array<{
    id?: string;
    label?: string;
    session_id?: string | null;
    parent?: string | null;
  }>;
};

const asTrimmedString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

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
 * Sub-agent/team panel data for one profile. Spawn tree (sub-agent
 * hierarchy) is a hermes RPC the bridge does not forward, so it's attempted
 * through the gateway and degrades gracefully when unsupported; the rest is
 * plain hermes REST (same Bearer token the Studio server already holds).
 */
const loadSubagentsViaGateway = async (params: {
  gatewayUrl: string;
  token: string;
  agentId: string;
}): Promise<AgentTeamSubagent[]> => {
  const gatewayClient = new NodeGatewayClient();
  try {
    await gatewayClient.connect({ gatewayUrl: params.gatewayUrl, token: params.token });
    const tree = (await gatewayClient.request("spawn_tree.list", {
      cross_session: true,
    })) as SpawnTreeResponse | null;
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
      .filter((node) => node.id.length > 0 && node.parent === params.agentId);
  } catch (error) {
    console.info("[agent-team] spawn_tree RPC unavailable; skipping sub-agents.", {
      error: error instanceof Error ? error.message : String(error),
      agentId: params.agentId,
    });
    return [];
  } finally {
    gatewayClient.close();
  }
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
    const profilesResponse = await fetchWithTimeout(`${base}/api/profiles`, headers, 12_000);
    if (!profilesResponse.ok) throw new Error(`profiles endpoint HTTP ${profilesResponse.status}`);
    const profilesData = (await profilesResponse.json()) as {
      profiles?: Array<{ name?: string }>;
    };
    const profileNames = (profilesData.profiles ?? [])
      .map((profile) => asTrimmedString(profile.name))
      .filter(Boolean);

    const sessionsResponse = await fetchWithTimeout(
      `${base}/api/profiles/sessions?profile=${encodeURIComponent(agentId)}&limit=50&order=recent`,
      headers,
      15_000,
    );
    const sessionsRaw: HermesRestSessionsResponse["sessions"] = sessionsResponse.ok
      ? ((await sessionsResponse.json()) as HermesRestSessionsResponse).sessions ?? []
      : [];

    const sessions: AgentTeamSession[] = sessionsRaw
      .map((session) => ({
        id: asTrimmedString(session.id),
        display_name: asTrimmedString(session.display_name) || asTrimmedString(session.id),
        // hermes REST reports seconds since the epoch; the UI wants ms.
        started_at:
          typeof session.started_at === "number" ? Math.round(session.started_at * 1000) : null,
        ended_at:
          typeof session.ended_at === "number" ? Math.round(session.ended_at * 1000) : null,
        message_count: typeof session.message_count === "number" ? session.message_count : null,
        source: asTrimmedString(session.source) || null,
        profile: asTrimmedString(session.profile) || "default",
      }))
      .slice(0, 10);

    const subagents = await loadSubagentsViaGateway({ gatewayUrl, token, agentId });

    const payload: AgentTeamResponse = {
      agentId,
      profilesCount: profileNames.length || 1,
      sessions,
      subagents,
    };
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load agent team.";
    console.warn("[agent-team] Failed to load agent team.", { error: message, agentId });
    return NextResponse.json({ error: message }, { status: 502 });
  }
}