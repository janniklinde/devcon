const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 7682);
const TMUX_TARGET = process.env.TMUX_TARGET || "devcon";
const AUTH_TOKEN = process.env.WEB_PASSWORD || process.env.AUTH_TOKEN || "";
const AUTO_CREATE_SESSION = process.env.AUTO_CREATE_SESSION === "1";
const HISTORY_LINES = Number(process.env.HISTORY_LINES || 250);
const POLL_MS = Math.max(120, Number(process.env.POLL_MS || 180));
const STATIC_DIR = path.join(__dirname, "public");

const sessions = new Map();

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function parseCookies(req) {
  const raw = req.headers.cookie || "";
  const out = {};
  for (const chunk of raw.split(";")) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf("=");
    if (sep < 0) continue;
    const k = trimmed.slice(0, sep);
    const v = trimmed.slice(sep + 1);
    out[k] = decodeURIComponent(v);
  }
  return out;
}

function parseBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolve(value && typeof value === "object" ? value : {});
      } catch {
        reject(new Error("invalid json"));
      }
    });
    req.on("error", reject);
  });
}

function tmux(args) {
  return new Promise((resolve) => {
    const proc = spawn("tmux", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => {
      stdout += d.toString("utf8");
    });
    proc.stderr.on("data", (d) => {
      stderr += d.toString("utf8");
    });
    proc.on("close", (code) => resolve({ code: code || 0, stdout, stderr }));
    proc.on("error", (err) =>
      resolve({ code: 1, stdout, stderr: err.message || String(err) })
    );
  });
}

async function ensureSession() {
  const has = await tmux(["has-session", "-t", TMUX_TARGET]);
  if (has.code === 0) return true;
  if (!AUTO_CREATE_SESSION) return false;
  const create = await tmux(["new-session", "-d", "-s", TMUX_TARGET]);
  return create.code === 0;
}

function getSessionId(req) {
  const cookies = parseCookies(req);
  if (cookies.sid && sessions.has(cookies.sid)) return cookies.sid;
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) {
    const token = auth.slice(7);
    if (sessions.has(token)) return token;
  }
  return "";
}

function isAuthed(req) {
  if (!AUTH_TOKEN) return true;
  return Boolean(getSessionId(req));
}

async function capturePane() {
  const result = await tmux([
    "capture-pane",
    "-p",
    "-t",
    TMUX_TARGET,
    "-S",
    `-${HISTORY_LINES}`,
  ]);
  if (result.code !== 0) {
    return {
      ok: false,
      error:
        result.stderr.trim() ||
        "Unable to capture tmux pane. Is the target session running?",
    };
  }
  return { ok: true, screen: result.stdout.replace(/\n$/, "") };
}

function tmuxKeyFromClient(key) {
  if (!key || typeof key !== "string") return "";
  const normalized = key.trim();
  if (!normalized) return "";
  if (/^C-[a-z]$/i.test(normalized)) return `C-${normalized.slice(2).toLowerCase()}`;
  if (/^M-[a-z]$/i.test(normalized)) return `M-${normalized.slice(2).toLowerCase()}`;

  const map = {
    Enter: "Enter",
    Escape: "Escape",
    Tab: "Tab",
    Backspace: "BSpace",
    Delete: "DC",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
  };
  return map[normalized] || normalized;
}

async function sendInput(body) {
  const text = typeof body.text === "string" ? body.text : "";
  const key = typeof body.key === "string" ? body.key : "";
  const keys = Array.isArray(body.keys) ? body.keys.filter((k) => typeof k === "string") : [];

  if (!text && !key && !keys.length) {
    return { ok: false, error: "No input provided" };
  }

  if (text) {
    const r = await tmux(["send-keys", "-t", TMUX_TARGET, "-l", text]);
    if (r.code !== 0) return { ok: false, error: r.stderr.trim() || "Failed to send text" };
  }

  const allKeys = [];
  if (key) allKeys.push(key);
  allKeys.push(...keys);

  for (const k of allKeys) {
    const tmuxKey = tmuxKeyFromClient(k);
    if (!tmuxKey) continue;
    const r = await tmux(["send-keys", "-t", TMUX_TARGET, tmuxKey]);
    if (r.code !== 0) {
      return { ok: false, error: r.stderr.trim() || `Failed to send key ${tmuxKey}` };
    }
  }

  return { ok: true };
}

async function serveStatic(req, res) {
  const reqPath = new URL(req.url, `http://${req.headers.host}`).pathname;
  let target = reqPath === "/" ? "/index.html" : reqPath;
  target = path.normalize(target).replace(/^(\.\.[/\\])+/, "");

  const filePath = path.join(STATIC_DIR, target);
  if (!filePath.startsWith(STATIC_DIR)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const type = CONTENT_TYPES[ext] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": type,
      "Content-Length": stat.size,
      "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=300",
    });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

async function handleApi(req, res) {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);

  if (pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      tmuxTarget: TMUX_TARGET,
      authEnabled: Boolean(AUTH_TOKEN),
    });
    return;
  }

  if (pathname === "/api/login" && req.method === "POST") {
    if (!AUTH_TOKEN) {
      sendJson(res, 200, { ok: true, auth: "disabled" });
      return;
    }

    let body = {};
    try {
      body = await parseBody(req);
    } catch (err) {
      sendJson(res, 400, { error: err.message || "Invalid request" });
      return;
    }

    const provided = typeof body.password === "string" ? body.password : "";
    if (!provided || provided !== AUTH_TOKEN) {
      sendJson(res, 401, { error: "Invalid password" });
      return;
    }

    const sid = crypto.randomBytes(24).toString("base64url");
    sessions.set(sid, { createdAt: Date.now() });
    res.setHeader(
      "Set-Cookie",
      `sid=${encodeURIComponent(sid)}; Path=/; HttpOnly; SameSite=Lax`
    );
    sendJson(res, 200, { ok: true });
    return;
  }

  if (!isAuthed(req)) {
    sendJson(res, 401, { error: "Not authenticated" });
    return;
  }

  if (pathname === "/api/session" && req.method === "GET") {
    const exists = await ensureSession();
    sendJson(res, exists ? 200 : 409, {
      ok: exists,
      tmuxTarget: TMUX_TARGET,
      autoCreate: AUTO_CREATE_SESSION,
      message: exists
        ? "Session available"
        : `tmux session "${TMUX_TARGET}" not found`,
    });
    return;
  }

  if (pathname === "/api/input" && req.method === "POST") {
    let body = {};
    try {
      body = await parseBody(req);
    } catch (err) {
      sendJson(res, 400, { error: err.message || "Invalid request" });
      return;
    }
    const exists = await ensureSession();
    if (!exists) {
      sendJson(res, 409, { error: `tmux session "${TMUX_TARGET}" not found` });
      return;
    }
    const result = await sendInput(body);
    sendJson(res, result.ok ? 200 : 400, result);
    return;
  }

  if (pathname === "/api/resize" && req.method === "POST") {
    let body = {};
    try {
      body = await parseBody(req);
    } catch (err) {
      sendJson(res, 400, { error: err.message || "Invalid request" });
      return;
    }
    const cols = Number(body.cols);
    const rows = Number(body.rows);
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) {
      sendJson(res, 400, { error: "cols and rows must be numbers" });
      return;
    }

    const exists = await ensureSession();
    if (!exists) {
      sendJson(res, 409, { error: `tmux session "${TMUX_TARGET}" not found` });
      return;
    }
    const r = await tmux([
      "resize-pane",
      "-t",
      TMUX_TARGET,
      "-x",
      String(Math.max(40, Math.round(cols))),
      "-y",
      String(Math.max(10, Math.round(rows))),
    ]);
    if (r.code !== 0) {
      sendJson(res, 400, { ok: false, error: r.stderr.trim() || "Resize failed" });
      return;
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  if (pathname === "/api/stream" && req.method === "GET") {
    const exists = await ensureSession();
    if (!exists) {
      sendJson(res, 409, { error: `tmux session "${TMUX_TARGET}" not found` });
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("\n");

    let closed = false;
    let lastScreen = "";
    let inFlight = false;

    const sendEvent = (event, data) => {
      if (closed) return;
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const tick = async () => {
      if (closed || inFlight) return;
      inFlight = true;
      try {
        const snap = await capturePane();
        if (!snap.ok) {
          sendEvent("error", { message: snap.error });
          return;
        }
        if (snap.screen !== lastScreen) {
          lastScreen = snap.screen;
          sendEvent("screen", { screen: snap.screen, ts: Date.now() });
        }
      } finally {
        inFlight = false;
      }
    };

    await tick();
    const interval = setInterval(tick, POLL_MS);
    const keepAlive = setInterval(() => {
      sendEvent("ping", { ts: Date.now() });
    }, 10000);

    req.on("close", () => {
      closed = true;
      clearInterval(interval);
      clearInterval(keepAlive);
    });
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

const server = http.createServer(async (req, res) => {
  if (!req.url || !req.method) {
    sendJson(res, 400, { error: "Bad request" });
    return;
  }

  if (req.url.startsWith("/api/")) {
    await handleApi(req, res);
    return;
  }

  await serveStatic(req, res);
});

server.listen(PORT, HOST, () => {
  const auth = AUTH_TOKEN ? "enabled" : "disabled";
  process.stdout.write(
    [
      `Web terminal listening on http://${HOST}:${PORT}`,
      `tmux target: ${TMUX_TARGET}`,
      `auth: ${auth}`,
      `auto create session: ${AUTO_CREATE_SESSION ? "yes" : "no"}`,
    ].join("\n") + "\n"
  );
});
