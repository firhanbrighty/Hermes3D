// Per-user access registry for Hermes3D Studio.
//
// Replaces the single shared STUDIO_ACCESS_TOKEN flow when the file exists:
// each manager gets their own token and a scope that names which Hermes
// profiles they may see. Scope "all" (or ["*"]) sees every profile — intended
// for the CEO role.
//
// File: ~/.hermes/hermes3d/users.json
// {
//   "users": [
//     { "id": "ceo",     "label": "CEO",           "token": "<hex-or-phrase>", "scope": "all" },
//     { "id": "manager-a", "label": "Manager A",    "token": "<other>",         "scope": ["grooving"] }
//   ]
// }
//
// When the file has zero users, the legacy single-token behavior applies.
// STUDIO_ACCESS_TOKEN still acts as a master key for API clients (CEO-scope).

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const isRecord = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));

const registryPath = (env = process.env) => {
  const override = String(env.HERMES_STATE_DIR ?? "").trim();
  const home = override ? resolveUserPath(override) : os.homedir();
  return path.join(home, ".hermes", "hermes3d", "users.json");
};

const resolveUserPath = (input) => {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith("~")) return path.resolve(trimmed.replace(/^~(?=$|[\\/])/, os.homedir()));
  return path.resolve(trimmed);
};

const normalizeScope = (value) => {
  if (value === "all" || value === "*") return { kind: "all" };
  if (Array.isArray(value)) {
    const names = value.map((entry) => String(entry ?? "").trim()).filter(Boolean);
    return names.includes("*") ? { kind: "all" } : { kind: "list", names };
  }
  const single = String(value ?? "").trim();
  if (!single) return { kind: "all" };
  if (single === "all" || single === "*") return { kind: "all" };
  return { kind: "list", names: [single] };
};

const loadUsers = (env = process.env) => {
  const filePath = registryPath(env);
  let parsed;
  try {
    if (!fs.existsSync(filePath)) return [];
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed?.users) ? parsed.users : [];
  return rows.flatMap((row) => {
    if (!isRecord(row)) return [];
    const id = String(row.id ?? "").trim();
    const token = String(row.token ?? "").trim();
    if (!id || !token) return [];
    return [
      {
        id,
        label: String(row.label ?? "").trim() || id,
        token,
        scope: normalizeScope(row.scope),
        profilesPathAllow: Array.isArray(row.profiles) ? row.profiles.map(String) : null,
      },
    ];
  });
};

const findUserByToken = (token, env = process.env) => {
  const rows = loadUsers(env);
  const wanted = String(token ?? "").trim();
  if (!wanted) return null;
  return rows.find((user) => user.token === wanted) ?? null;
};

const scopeAllowsProfile = (scope, profileId) => {
  if (!scope) return false;
  if (scope.kind === "all") return true;
  return scope.names.some(
    (name) => name.toLowerCase() === String(profileId ?? "").toLowerCase(),
  );
};

const scopeDescription = (scope) =>
  scope?.kind === "all" ? "all" : (scope?.names ?? []).join(", ");

module.exports = { loadUsers, findUserByToken, scopeAllowsProfile, scopeDescription, registryPath };