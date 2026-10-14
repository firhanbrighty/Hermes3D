const crypto = require("node:crypto");


const parseCookies = (header) => {
  const raw = typeof header === "string" ? header : "";
  if (!raw.trim()) return {};
  const out = {};
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    out[key] = value;
  }
  return out;
};

/** Constant-time string comparison to prevent timing attacks. */
const safeCompare = (a, b) => {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    // Compare against self to burn constant time, then return false
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
};

/** Simple in-memory rate limiter for auth attempts. */
const createRateLimiter = (maxAttempts = 10, windowMs = 60_000) => {
  const attempts = new Map();
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of attempts) {
      if (now - entry.start > windowMs) attempts.delete(key);
    }
  }, windowMs);
  cleanup.unref();

  return {
    isLimited(ip) {
      const entry = attempts.get(ip);
      if (!entry) return false;
      return entry.count >= maxAttempts;
    },
    recordFailure(ip) {
      const now = Date.now();
      const entry = attempts.get(ip);
      if (!entry || now - entry.start > windowMs) {
        attempts.set(ip, { count: 1, start: now });
        return;
      }
      entry.count++;
    },
    reset(ip) {
      attempts.delete(ip);
    },
  };
};

/**
 * Resolve client IP for rate limiting.
 * When TRUSTED_PROXY=1 is set, the first value of X-Forwarded-For is used.
 * Only set TRUSTED_PROXY=1 when this server sits behind a reverse proxy that
 * you control (nginx, Caddy, Vercel edge). Without it, X-Forwarded-For is
 * ignored to prevent spoofing by direct clients.
 */
const resolveClientIp = (req) => {
  if (process.env.TRUSTED_PROXY === "1") {
    const forwarded = req.headers?.["x-forwarded-for"];
    if (typeof forwarded === "string") {
      const first = forwarded.split(",")[0]?.trim();
      if (first) return first;
    }
  }
  return req.socket?.remoteAddress || "unknown";
};

function createAccessGate(options) {
  const token = String(options?.token ?? "").trim();
  const cookieName = String(options?.cookieName ?? "studio_access").trim() || "studio_access";

  const enabled = Boolean(token);
  const rateLimiter = createRateLimiter(10, 60_000);

  const getAuthState = (req) => {
    if (!enabled) return { authorized: true, limited: false };
    const ip = resolveClientIp(req);
    const cookieHeader = req.headers?.cookie;
    const cookies = parseCookies(cookieHeader);
    const authorized = safeCompare(cookies[cookieName] || "", token);
    if (authorized) {
      rateLimiter.reset(ip);
      return { authorized: true, limited: false };
    }
    if (rateLimiter.isLimited(ip)) {
      return { authorized: false, limited: true };
    }
    rateLimiter.recordFailure(ip);
    return { authorized: false, limited: rateLimiter.isLimited(ip) };
  };

  const safeNextFromUrl = (rawUrl) => {
    const start = rawUrl.indexOf("next=");
    if (start === -1) return "/";
    const raw = rawUrl.slice(start + 5);
    try {
      const decoded = decodeURIComponent(raw);
      return decoded.startsWith("/") && !decoded.startsWith("/studio-login") ? decoded : "/";
    } catch {
      return "/";
    }
  };

  const buildLoginHtml = (nextPath, errorText) => {
    const escape = (value) =>
      String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const safeNext = escape(nextPath || "/");
    const errorHtml = errorText
      ? `<p class="error">${escape(errorText)}</p>`
      : "";
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Studio access</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #10141b; color: #e8ecf1; font-family: system-ui, sans-serif; }
  form { background: #171d27; border: 1px solid #2a3342; border-radius: 12px; padding: 28px; width: min(360px, 90vw); }
  h1 { font-size: 18px; margin: 0 0 6px; }
  p.hint { margin: 0 0 18px; font-size: 13px; color: #9aa7b8; }
  input { width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 8px; border: 1px solid #2a3342; background: #10141b; color: inherit; font-size: 14px; }
  button { width: 100%; margin-top: 12px; padding: 10px 12px; border: 0; border-radius: 8px; background: #4c8fd6; color: #0b1219; font-weight: 600; font-size: 14px; cursor: pointer; }
  .error { color: #ff8f8f; font-size: 13px; margin: 0 0 12px; }
</style>
</head>
<body>
<form method="POST" action="/studio-login">
  <h1>Hermes3D Studio</h1>
  <p class="hint">Paste the studio access token to continue.</p>
  ${errorHtml}
  <input type="hidden" name="next" value="${safeNext}">
  <input type="password" name="token" placeholder="Access token" autofocus autocomplete="off">
  <button type="submit">Sign in</button>
</form>
</body>
</html>`;
  };

  const readBody = (req, cb, maxBytes = 8192) => {
    let body = "";
    let overflow = false;
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > maxBytes) {
        overflow = true;
        req.destroy();
      }
    });
    req.on("end", () => {
      if (overflow) return;
      cb(body);
    });
    req.on("error", () => {});
  };

  const handleHttp = (req, res) => {
    if (!enabled) return false;
    const url = String(req.url || "/");
    const auth = getAuthState(req);
    if (auth.authorized) return false;

    // The login form GET must render from the gate itself (Next.js has no
    // /studio-login page); POST is handled below.
    const isLoginPath = url === "/studio-login" || url.startsWith("/studio-login?");
    if (isLoginPath && req.method !== "POST") {
      res.statusCode = 401;
      res.setHeader("Content-Type", "text/html");
      res.end(buildLoginHtml(safeNextFromUrl(url), ""));
      return true;
    }

    // Login roundtrip: set cookie on valid POST (unauthorized POSTs land here).
    if (isLoginPath && req.method === "POST") {
      readBody(req, (raw) => {
        const params = new URLSearchParams(raw);
        const token = String(params.get("token") || "").trim();
        const nextPath = String(params.get("next") || "/");
        const safeNext = nextPath.startsWith("/") && !nextPath.startsWith("/studio-login") ? nextPath : "/";
        if (token && safeCompare(token, String(options?.token ?? "").trim())) {
          res.statusCode = 303;
          res.setHeader("Set-Cookie", `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
          res.setHeader("Location", safeNext);
          res.end();
        } else if (auth.limited) {
          res.statusCode = 429;
          res.setHeader("Content-Type", "text/html");
          res.end(buildLoginHtml(safeNext, "Too many attempts. Wait a minute and retry."));
        } else {
          rateLimiter.recordFailure(resolveClientIp(req));
          res.statusCode = 401;
          res.setHeader("Content-Type", "text/html");
          res.end(buildLoginHtml(safeNext, "Invalid access token."));
        }
      });
      return true;
    }

    if (auth.limited) {
      if (url.startsWith("/api/")) {
        res.statusCode = 429;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Too many failed studio access attempts. Wait a minute and retry." }));
        return true;
      }
      res.statusCode = 429;
      res.setHeader("Content-Type", "text/html");
      res.end(buildLoginHtml("/", "Too many attempts. Wait a minute and retry."));
      return true;
    }

    if (url.startsWith("/api/")) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          error: "Studio access token required. Send the configured Studio access cookie and retry.",
        })
      );
      return true;
    }

    // Browser page: redirect to the login form so no DevTools needed.
    res.statusCode = 302;
    res.setHeader("Location", `/studio-login?next=${encodeURIComponent(url)}`);
    res.end();
    return true;
  };

  const allowUpgrade = (req) => {
    if (!enabled) return true;
    return getAuthState(req).authorized;
  };

  return { enabled, handleHttp, allowUpgrade };
}

module.exports = { createAccessGate };
