import { NextResponse } from "next/server";
import { readFile, writeFile, chmod, mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { loadStudioSettings } from "@/lib/studio/settings-store";

export const runtime = "nodejs";

const asTrimmedString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

type UserRecord = {
  id: string;
  label: string;
  token: string;
  scope: "all" | string[];
};

type UsersFile = { users: UserRecord[] };

const registryPath = () => {
  const base = process.env.HERMES_STATE_DIR?.trim() || homedir();
  return path.resolve(`${base.replace(/\/+$/, "")}/.hermes/hermes3d/users.json`);
};

const slugify = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);

const resolveViewerScope = (request: Request) => {
  const header = asTrimmedString(request.headers.get("x-studio-user-scope")).toLowerCase();
  if (!header) return "all"; // legacy single-token deployment: master sees all
  if (header === "all" || header === "*") return "all";
  return header.split(",").map((entry) => entry.trim()).filter(Boolean);
};

/**
 * Access token visibility rules:
 * - viewer scope "all" (CEO/master): melihat token semua agent.
 * - scoped manager: hanya token milik dirinya (profil dalam scope-nya) atau
 *   sub-agent di bawah profil-nya (entry user yang scope-nya memuat profil
 *   viewer).
 */
export async function GET(request: Request) {
  const scope = resolveViewerScope(request);
  const isAll = scope === "all";
  const scopeList = isAll ? [] : (Array.isArray(scope) ? scope : []);

  let data: UsersFile = { users: [] };
  try {
    data = JSON.parse(await readFile(registryPath(), "utf8")) as UsersFile;
  } catch {
    return NextResponse.json({ exists: false });
  }
  const agentId = asTrimmedString(new URL(request.url).searchParams.get("agentId"));
  if (!agentId) {
    return NextResponse.json({ error: "invalid_agent_id" }, { status: 400 });
  }
  const lowerAgentId = agentId.toLowerCase();
  const lowerScope = scopeList.map((name) => name.toLowerCase());

  const user = (data.users ?? []).find(
    (entry) =>
      Array.isArray(entry.scope) &&
      entry.scope.some((name) => String(name).toLowerCase() === agentId.toLowerCase()),
  );

  if (!isAll) {
    // Viewer harus menyebut profil miliknya atau sub-agent di bawah profilnya.
    // Entry user lain yang scope-nya memuat salah satu profil viewer = sub-agent tim viewer.
    const subProfileIds: string[] = [];
    for (const entry of data.users ?? []) {
      const entryLower = ((entry.scope as string[] | undefined) ?? []).map((n) =>
        String(n).toLowerCase(),
      );
      const isSubOfViewer =
        entryLower.some((name) => lowerScope.includes(name)) &&
        !entryLower.every((name) => lowerScope.includes(name));
      if (isSubOfViewer) {
        for (const name of entryLower) subProfileIds.push(name);
      }
    }
    // Profil yang dilarang: mana pun di luar (scope viewer ∪ sub-agent tim viewer).
    const allowedIds = new Set([...lowerScope, ...subProfileIds]);
    if (!allowedIds.has(lowerAgentId)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
  }

  if (!user) {
    return NextResponse.json({ exists: false, agentId });
  }

  if (!isAll) {
    const entryScope = ((user.scope as string[] | undefined) ?? []).map((name) =>
      String(name).toLowerCase(),
    );
    const isSelf = entryLowerSameSet(lowerScope, entryScope);
    const isBelowViewer = entryScope.some((name) => lowerScope.includes(name)) && !lowerScope.every((name) => entryScope.includes(name));
    if (!isSelf && !isBelowViewer) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
  }

  return NextResponse.json({
    exists: true,
    agentId,
    userId: user.id,
    label: user.label,
    token: user.token,
  });
}

const entryLowerSameSet = (a: string[], b: string[]) =>
  a.length === b.length && a.every((name) => b.includes(name));

export async function POST(request: Request) {
  // Mint token = CEO-only. Manager tidak boleh membuat/mengubah token sendiri
  // (kalau kehilangan token, CEO yang mint ulang).
  const scope = resolveViewerScope(request);
  if (scope !== "all") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const settings = loadStudioSettings();
  const gatewayToken = asTrimmedString(settings.gateway?.token);
  const gatewayUrl = asTrimmedString(settings.gateway?.url);
  if (!gatewayToken || !gatewayUrl) {
    return NextResponse.json({ error: "studio.gateway_url_missing" }, { status: 503 });
  }

  let body: { agentId?: string; label?: string };
  try {
    body = (await request.json()) as { agentId?: string; label?: string };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const agentId = asTrimmedString(body.agentId);
  if (!agentId || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(agentId)) {
    return NextResponse.json({ error: "invalid_agent_id" }, { status: 400 });
  }

  const filePath = registryPath();
  let data: UsersFile = { users: [] };
  try {
    data = JSON.parse(await readFile(filePath, "utf8")) as UsersFile;
    if (!Array.isArray(data.users)) data = { users: [] };
  } catch {
    data = { users: [] };
  }

  const userId = `mgr-${slugify(agentId)}`;
  const existing = data.users.find((user) => user.id === userId);
  if (existing && asTrimmedString(existing.token)) {
    return NextResponse.json({ ok: true, userId, token: existing.token, reused: true });
  }

  const token = randomBytes(16).toString("hex");
  data.users = [
    ...data.users.filter((user) => user.id !== userId),
    { id: userId, label: asTrimmedString(body.label) || agentId, token, scope: [agentId] },
  ];

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await chmod(filePath, 0o600);

  return NextResponse.json({ ok: true, userId, token, reused: false });
}