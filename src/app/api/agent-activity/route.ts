import { NextResponse } from "next/server";
import { loadStudioSettings } from "@/lib/studio/settings-store";

export const runtime = "nodejs";

const HERMES_AGENT_EVENTS_PATH = "/api/events";
const DEFAULT_CHANNEL = "hermes3d";
/** Auto close setelah 15 menit biar tidak leak koneksi. */
const CONNECTION_TTL_MS = 15 * 60 * 1000;

const asTrimmedString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

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

/**
 * Pass-through SSE: baca stream JSONL dari hermes REST (GET /api/events?channel=),
 * filter frame yang menyebut agentId (field `profile`), lalu re-emit sebagai
 * text/event-stream. Frame lain tetap dikirim sebagai SSE keepalive kosong agar
 * koneksi dan reconnection di sisi EventSource stabil.
 */
export async function GET(request: Request) {
  if (resolveViewerScope(request) !== "all") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const agentId = asTrimmedString(new URL(request.url).searchParams.get("agentId"));
  if (!agentId) {
    return NextResponse.json({ error: "invalid_agent_id" }, { status: 400 });
  }
  const agentIdLower = agentId.toLowerCase();

  const settings = loadStudioSettings();
  const gatewayUrl = asTrimmedString(settings.gateway?.url);
  if (!gatewayUrl) {
    return NextResponse.json({ error: "studio.gateway_url_missing" }, { status: 503 });
  }
  const token = asTrimmedString(settings.gateway?.token);

  const base = restBaseUrlFromGatewayUrl(gatewayUrl).replace(/\/+$/, "");
  const eventsUrl = new URL(`${base}${HERMES_AGENT_EVENTS_PATH}`);
  eventsUrl.searchParams.set("channel", DEFAULT_CHANNEL);
  if (token) eventsUrl.searchParams.set("token", token);

  let upstreamResponse: Response | null = null;
  try {
    upstreamResponse = await fetch(eventsUrl.toString(), {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      cache: "no-store",
    });
    if (!upstreamResponse.ok || !upstreamResponse.body) {
      throw new Error(`hermes events endpoint HTTP ${upstreamResponse.status}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "hermes events stream failed";
    console.error("[agent-activity] Failed to open upstream events stream.", { agentId, error: message });
    return NextResponse.json({ error: message }, { status: 502 });
  }
  const upstreamBody: ReadableStream<Uint8Array> = upstreamResponse.body;

  const agentPattern = new RegExp(`(^|[^\\p{L}\\p{N}])${agentId}([^\\p{L}\\p{N}]|$)`, "iu");
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let upstreamClosed = false;
      let finished = false;
      const closeAll = () => {
        if (finished) return;
        finished = true;
        try {
          upstreamBody.cancel().catch(() => {});
        } catch {}
        try {
          controller.close();
        } catch {}
      };
      /** Server-side TTL 15 menit: paksa tutup koneksi agar tidak leak. */
      const ttlTimer = setTimeout(closeAll, CONNECTION_TTL_MS);
      if (typeof ttlTimer.unref === "function") ttlTimer.unref();

      const push = (payload: string) => {
        if (finished) return;
        try {
          controller.enqueue(encoder.encode(payload));
        } catch {
          closeAll();
        }
      };

      push(": connected\n\n");

      const emitFrame = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let profile = "";
        try {
          const frame = JSON.parse(trimmed) as { profile?: unknown };
          profile = typeof frame.profile === "string" ? frame.profile.trim() : "";
        } catch {
          return; // bukan JSONL valid; hanyakan
        }
        if (profile === agentIdLower || agentPattern.test(profile)) {
          push(`data: ${trimmed}\n\n`);
        }
      };

      const reader = upstreamBody.getReader();
      let buffer = "";

      const pump = () => {
        if (finished) return;
        reader
          .read()
          .then(({ done, value }) => {
            if (finished) return;
            if (done) {
              upstreamClosed = true;
              push("event: end\ndata: upstream_closed\n\n");
              clearTimeout(ttlTimer);
              closeAll();
              return;
            }
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) emitFrame(line);
            pump();
          })
          .catch(() => {
            if (!finished) {
              push("event: end\ndata: upstream_closed\n\n");
              clearTimeout(ttlTimer);
              closeAll();
            }
          });
      };
      pump();

      // Bila klien membatalkan, lepas upstream reader.
      return () => {
        if (!upstreamClosed) reader.cancel().catch(() => {});
        clearTimeout(ttlTimer);
        finished = true;
      };
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}