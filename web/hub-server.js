const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");

const HOST = process.env.WEBHUB_HOST || "0.0.0.0";
const PORT = Number(process.env.WEBHUB_PORT || 7690);
const AUTH_TOKEN = process.env.WEBHUB_PASSWORD || "";
const STATIC_DIR = path.join(__dirname, "hub");
const DEFAULT_TOOLS = parseToolList();
const HISTORY_LINES = Math.max(80, Number(process.env.WEBHUB_HISTORY_LINES || 250));
const POLL_MS = Math.max(120, Number(process.env.WEBHUB_POLL_MS || 180));

const allowlist = parseAllowlist();
const devconCommand = parseDevconCommand();
const sessions = new Map();
const authSessions = new Map();

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function parseAllowlist() {
  const raw = process.env.WEBHUB_ALLOWLIST_JSON || "[]";
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry) => typeof entry === "string")
      .map((entry) => path.resolve(entry))
      .filter((entry, idx, arr) => arr.indexOf(entry) === idx);
  } catch {
    return [];
  }
}

function parseDevconCommand() {
  const raw = process.env.WEBHUB_DEVCON_CMD_JSON || '["devcon"]';
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return ["devcon"];
    const cleaned = parsed.filter((entry) => typeof entry === "string" && entry.length > 0);
    return cleaned.length > 0 ? cleaned : ["devcon"];
  } catch {
    return ["devcon"];
  }
}

function parseToolList() {
  const raw = process.env.WEBHUB_TOOLS_JSON || '["codex","claude","opencode","run"]';
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return ["codex", "claude", "opencode", "run"];
    const tools = parsed
      .filter((entry) => typeof entry === "string" && entry.trim().length > 0)
      .map((entry) => entry.trim());
    return tools.length > 0 ? Array.from(new Set(tools)) : ["codex", "claude", "opencode", "run"];
  } catch {
    return ["codex", "claude", "opencode", "run"];
  }
}

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
    const key = trimmed.slice(0, sep);
    out[key] = decodeURIComponent(trimmed.slice(sep + 1));
  }
  return out;
}

function getAuthId(req) {
  if (!AUTH_TOKEN) return "auth-disabled";
  const cookies = parseCookies(req);
  const sid = cookies.hub_sid;
  if (sid && authSessions.has(sid)) return sid;
  return "";
}

function isAuthed(req) {
  if (!AUTH_TOKEN) return true;
  return Boolean(getAuthId(req));
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
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolve(parsed && typeof parsed === "object" ? parsed : {});
      } catch {
        reject(new Error("invalid json"));
      }
    });
    req.on("error", reject);
  });
}

function tmux(args) {
  return new Promise((resolve) => {
    const child = spawn("tmux", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => resolve({ code: code || 0, stdout, stderr }));
    child.on("error", (err) =>
      resolve({ code: 1, stdout, stderr: err.message || String(err) })
    );
  });
}

function tmuxSessionExists(sessionName) {
  const result = spawnSync("tmux", ["has-session", "-t", sessionName], { stdio: "ignore" });
  return result.status === 0;
}

function killTmuxSession(sessionName) {
  if (!tmuxSessionExists(sessionName)) return;
  spawnSync("tmux", ["kill-session", "-t", sessionName], { stdio: "ignore" });
}

function sanitizeSessionToken(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "session";
}

function splitShellArgs(input) {
  if (!input || typeof input !== "string") return [];
  const out = [];
  let current = "";
  let quote = "";
  let escaping = false;
  for (const ch of input) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = "";
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        out.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) out.push(current);
  return out;
}

function isAllowedDirectory(dir) {
  const resolved = path.resolve(dir);
  return allowlist.includes(resolved);
}

function getSessionById(sessionId) {
  if (!sessionId || !sessions.has(sessionId)) return null;
  return sessions.get(sessionId);
}

async function execCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => resolve({ code: code || 0, stdout, stderr }));
    child.on("error", (err) =>
      resolve({ code: 1, stdout, stderr: err.message || String(err) })
    );
  });
}

async function createSession(body) {
  const dir = typeof body.directory === "string" ? path.resolve(body.directory) : "";
  if (!dir) return { ok: false, status: 400, error: "directory is required" };
  if (!isAllowedDirectory(dir)) {
    return { ok: false, status: 403, error: "directory is not in webhub allowlist" };
  }

  const tool = typeof body.tool === "string" && body.tool.trim() ? body.tool.trim() : "codex";
  if (!DEFAULT_TOOLS.includes(tool)) {
    return { ok: false, status: 400, error: `unsupported tool "${tool}"` };
  }

  const argsInput = typeof body.toolArgs === "string" ? body.toolArgs : "";
  const toolArgs = splitShellArgs(argsInput);
  const requestedName =
    typeof body.sessionName === "string" && body.sessionName.trim()
      ? body.sessionName.trim()
      : `webhub-${sanitizeSessionToken(tool)}-${crypto.randomBytes(3).toString("hex")}`;
  const tmuxSession = sanitizeSessionToken(requestedName);
  if (tmuxSessionExists(tmuxSession)) {
    return { ok: false, status: 409, error: `tmux session "${tmuxSession}" already exists` };
  }

  const [cmd, ...baseArgs] = devconCommand;
  const invokeArgs = [...baseArgs, "--web", "--web-no-server", "--web-session", tmuxSession, tool];
  if (toolArgs.length > 0) {
    invokeArgs.push("--", ...toolArgs);
  }

  const result = await execCommand(cmd, invokeArgs, { cwd: dir, env: process.env });
  if (result.code !== 0) {
    const output = `${result.stderr || ""}\n${result.stdout || ""}`.trim();
    return {
      ok: false,
      status: 500,
      error: output || "failed to launch session",
    };
  }
  if (!tmuxSessionExists(tmuxSession)) {
    const output = `${result.stderr || ""}\n${result.stdout || ""}`.trim();
    return {
      ok: false,
      status: 500,
      error:
        output
        || `session launch finished but tmux session "${tmuxSession}" was not found`,
    };
  }

  const id = crypto.randomBytes(12).toString("base64url");
  const created = {
    id,
    tmuxSession,
    directory: dir,
    tool,
    toolArgs,
    createdAt: new Date().toISOString(),
  };
  sessions.set(id, created);
  return { ok: true, session: created };
}

async function capturePane(tmuxSession) {
  const result = await tmux([
    "capture-pane",
    "-p",
    "-t",
    tmuxSession,
    "-S",
    `-${HISTORY_LINES}`,
  ]);
  if (result.code !== 0) {
    return {
      ok: false,
      error: result.stderr.trim() || `unable to capture tmux session "${tmuxSession}"`,
    };
  }
  return { ok: true, screen: result.stdout.replace(/\n$/, "") };
}

function mapTmuxKey(key) {
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

async function sendInput(tmuxSession, body) {
  const text = typeof body.text === "string" ? body.text : "";
  const key = typeof body.key === "string" ? body.key : "";
  const keys = Array.isArray(body.keys) ? body.keys.filter((k) => typeof k === "string") : [];
  if (!text && !key && !keys.length) {
    return { ok: false, error: "No input provided" };
  }

  if (text) {
    const result = await tmux(["send-keys", "-t", tmuxSession, "-l", text]);
    if (result.code !== 0) {
      return { ok: false, error: result.stderr.trim() || "failed to send text" };
    }
  }

  const allKeys = [];
  if (key) allKeys.push(key);
  allKeys.push(...keys);
  for (const k of allKeys) {
    const tmuxKey = mapTmuxKey(k);
    if (!tmuxKey) continue;
    const result = await tmux(["send-keys", "-t", tmuxSession, tmuxKey]);
    if (result.code !== 0) {
      return { ok: false, error: result.stderr.trim() || `failed to send key ${tmuxKey}` };
    }
  }
  return { ok: true };
}

async function listSessions() {
  const out = [];
  for (const session of sessions.values()) {
    const running = tmuxSessionExists(session.tmuxSession);
    out.push({
      ...session,
      running,
    });
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

async function serveStatic(req, res) {
  const reqPath = new URL(req.url, `http://${req.headers.host}`).pathname;
  let target = reqPath === "/" ? "/index.html" : reqPath;
  target = path.normalize(target).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(STATIC_DIR, target);
  if (!filePath.startsWith(STATIC_DIR)) {
    sendJson(res, 403, { error: "forbidden" });
    return;
  }
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) {
      sendJson(res, 404, { error: "not found" });
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
    sendJson(res, 404, { error: "not found" });
  }
}

function extractSessionIdFromPath(pathname) {
  const killMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (!killMatch) return "";
  return decodeURIComponent(killMatch[1]);
}

async function handleApi(req, res) {
  const { pathname, searchParams } = new URL(req.url, `http://${req.headers.host}`);

  if (pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      host: HOST,
      port: PORT,
      authEnabled: Boolean(AUTH_TOKEN),
      allowlist,
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
      sendJson(res, 400, { error: err.message || "invalid request" });
      return;
    }
    const password = typeof body.password === "string" ? body.password : "";
    if (!password || password !== AUTH_TOKEN) {
      sendJson(res, 401, { error: "invalid password" });
      return;
    }
    const sid = crypto.randomBytes(24).toString("base64url");
    authSessions.set(sid, { createdAt: Date.now() });
    res.setHeader(
      "Set-Cookie",
      `hub_sid=${encodeURIComponent(sid)}; Path=/; HttpOnly; SameSite=Lax`
    );
    sendJson(res, 200, { ok: true });
    return;
  }

  if (!isAuthed(req)) {
    sendJson(res, 401, { error: "not authenticated" });
    return;
  }

  if (pathname === "/api/config" && req.method === "GET") {
    sendJson(res, 200, {
      ok: true,
      allowlist,
      tools: DEFAULT_TOOLS,
      authEnabled: Boolean(AUTH_TOKEN),
    });
    return;
  }

  if (pathname === "/api/sessions" && req.method === "GET") {
    const items = await listSessions();
    sendJson(res, 200, { ok: true, sessions: items });
    return;
  }

  if (pathname === "/api/sessions" && req.method === "POST") {
    let body = {};
    try {
      body = await parseBody(req);
    } catch (err) {
      sendJson(res, 400, { error: err.message || "invalid request" });
      return;
    }
    const created = await createSession(body);
    if (!created.ok) {
      sendJson(res, created.status || 500, { ok: false, error: created.error });
      return;
    }
    sendJson(res, 200, { ok: true, session: created.session });
    return;
  }

  if (pathname.startsWith("/api/sessions/") && req.method === "DELETE") {
    const id = extractSessionIdFromPath(pathname);
    const session = getSessionById(id);
    if (!session) {
      sendJson(res, 404, { error: "session not found" });
      return;
    }
    killTmuxSession(session.tmuxSession);
    sessions.delete(id);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (pathname === "/api/input" && req.method === "POST") {
    let body = {};
    try {
      body = await parseBody(req);
    } catch (err) {
      sendJson(res, 400, { error: err.message || "invalid request" });
      return;
    }
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    const session = getSessionById(sessionId);
    if (!session) {
      sendJson(res, 404, { error: "session not found" });
      return;
    }
    if (!tmuxSessionExists(session.tmuxSession)) {
      sendJson(res, 409, { error: "tmux session is not running" });
      return;
    }
    const result = await sendInput(session.tmuxSession, body);
    sendJson(res, result.ok ? 200 : 400, result);
    return;
  }

  if (pathname === "/api/resize" && req.method === "POST") {
    let body = {};
    try {
      body = await parseBody(req);
    } catch (err) {
      sendJson(res, 400, { error: err.message || "invalid request" });
      return;
    }
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    const session = getSessionById(sessionId);
    if (!session) {
      sendJson(res, 404, { error: "session not found" });
      return;
    }
    const cols = Number(body.cols);
    const rows = Number(body.rows);
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) {
      sendJson(res, 400, { error: "cols and rows must be numeric" });
      return;
    }
    const result = await tmux([
      "resize-pane",
      "-t",
      session.tmuxSession,
      "-x",
      String(Math.max(40, Math.round(cols))),
      "-y",
      String(Math.max(10, Math.round(rows))),
    ]);
    if (result.code !== 0) {
      sendJson(res, 400, { ok: false, error: result.stderr.trim() || "resize failed" });
      return;
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  if (pathname === "/api/stream" && req.method === "GET") {
    const sessionId = searchParams.get("sessionId") || "";
    const session = getSessionById(sessionId);
    if (!session) {
      sendJson(res, 404, { error: "session not found" });
      return;
    }
    if (!tmuxSessionExists(session.tmuxSession)) {
      sendJson(res, 409, { error: "tmux session is not running" });
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
        const snap = await capturePane(session.tmuxSession);
        if (!snap.ok) {
          sendEvent("error", { message: snap.error });
          return;
        }
        if (snap.screen !== lastScreen) {
          lastScreen = snap.screen;
          sendEvent("screen", { sessionId, screen: snap.screen, ts: Date.now() });
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

  sendJson(res, 404, { error: "not found" });
}

function shutdown() {
  for (const session of sessions.values()) {
    killTmuxSession(session.tmuxSession);
  }
}

process.on("SIGINT", () => {
  shutdown();
  process.exit(0);
});
process.on("SIGTERM", () => {
  shutdown();
  process.exit(0);
});
process.on("exit", shutdown);

const server = http.createServer(async (req, res) => {
  if (!req.url || !req.method) {
    sendJson(res, 400, { error: "bad request" });
    return;
  }

  if (req.url.startsWith("/api/")) {
    await handleApi(req, res);
    return;
  }
  await serveStatic(req, res);
});

server.listen(PORT, HOST, () => {
  process.stdout.write(
    [
      `Devcon webhub listening on http://${HOST}:${PORT}`,
      `auth: ${AUTH_TOKEN ? "enabled" : "disabled"}`,
      `allowlist entries: ${allowlist.length}`,
      `devcon launcher: ${devconCommand.join(" ")}`,
    ].join("\n") + "\n"
  );
});
