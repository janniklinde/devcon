const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const pty = require("node-pty");
const { WebSocketServer } = require("ws");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 7682);
const TMUX_TARGET = process.env.TMUX_TARGET || "devcon";
const AUTH_TOKEN = process.env.WEB_PASSWORD || process.env.AUTH_TOKEN || "";
const AUTO_CREATE_SESSION = process.env.AUTO_CREATE_SESSION === "1";
const STATIC_DIR = path.join(__dirname, "public");
const TMUX_BIN = resolveTmuxBinary();

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

const VENDOR_FILES = {
  "/vendor/xterm/xterm.css": path.join(__dirname, "..", "node_modules", "xterm", "css", "xterm.css"),
  "/vendor/xterm/xterm.js": path.join(__dirname, "..", "node_modules", "xterm", "lib", "xterm.js"),
  "/vendor/xterm/xterm.js.map": path.join(__dirname, "..", "node_modules", "xterm", "lib", "xterm.js.map"),
  "/vendor/xterm-addon-fit/addon-fit.js": path.join(
    __dirname,
    "..",
    "node_modules",
    "@xterm",
    "addon-fit",
    "lib",
    "addon-fit.js"
  ),
  "/vendor/xterm-addon-fit/addon-fit.js.map": path.join(
    __dirname,
    "..",
    "node_modules",
    "@xterm",
    "addon-fit",
    "lib",
    "addon-fit.js.map"
  ),
};

function isExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveTmuxBinary() {
  const pathValue = process.env.PATH || "";
  for (const entry of pathValue.split(path.delimiter)) {
    if (!entry) continue;
    const candidate = path.join(entry, "tmux");
    if (isExecutable(candidate)) {
      return candidate;
    }
  }
  return "tmux";
}

function resolveNodePtySpawnHelperPath() {
  if (process.platform !== "darwin") {
    return "";
  }

  try {
    const nodePtyPackageJson = require.resolve("node-pty/package.json");
    return path.join(
      path.dirname(nodePtyPackageJson),
      "prebuilds",
      `darwin-${process.arch}`,
      "spawn-helper"
    );
  } catch {
    return "";
  }
}

function ensureNodePtyBackendReady() {
  if (process.platform !== "darwin") {
    return;
  }

  const helperPath = resolveNodePtySpawnHelperPath();
  if (!helperPath || !fs.existsSync(helperPath)) {
    return;
  }

  if (isExecutable(helperPath)) {
    return;
  }

  try {
    fs.chmodSync(helperPath, 0o755);
    process.stdout.write(
      `Web mode note: repaired executable bit on node-pty helper at ${helperPath}\n`
    );
  } catch (err) {
    const detail = err && err.message ? err.message : String(err);
    throw new Error(
      [
        `node-pty helper is not executable: ${helperPath}`,
        "",
        "This breaks browser attach on macOS with errors like \"posix_spawnp failed\".",
        "Repair it with:",
        `  chmod +x ${helperPath}`,
        "  npm rebuild node-pty",
        "",
        `Details: ${detail}`,
      ].join("\n")
    );
  }
}

function formatAttachError(err) {
  const detail = err && err.message ? err.message : String(err);
  const lines = [`Failed to attach browser terminal to tmux: ${detail}`];

  if (process.platform === "darwin") {
    const helperPath = resolveNodePtySpawnHelperPath();
    if (helperPath) {
      lines.push("");
      lines.push("macOS note: node-pty uses a spawn-helper binary.");
      lines.push(`Check it here: ${helperPath}`);
      lines.push("If needed, run:");
      lines.push(`  chmod +x ${helperPath}`);
      lines.push("  npm rebuild node-pty");
    }
  }

  return lines.join("\n");
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
    const proc = spawn(TMUX_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
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

async function enableTmuxMouse(sessionName) {
  const result = await tmux(["set-option", "-t", sessionName, "mouse", "on"]);
  if (result.code !== 0) {
    process.stderr.write(
      `Web mode note: failed to enable tmux mouse mode for "${sessionName}": ${result.stderr.trim() || "unknown error"}\n`
    );
  }
}

async function ensureSession() {
  const has = await tmux(["has-session", "-t", TMUX_TARGET]);
  if (has.code === 0) return true;
  if (!AUTO_CREATE_SESSION) return false;
  const create = await tmux(["new-session", "-d", "-s", TMUX_TARGET]);
  if (create.code !== 0) return false;
  await enableTmuxMouse(TMUX_TARGET);
  return true;
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

async function serveFile(res, filePath, cacheControl) {
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
      "Cache-Control": cacheControl,
    });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

async function serveStatic(req, res) {
  const reqPath = new URL(req.url, `http://${req.headers.host}`).pathname;

  if (VENDOR_FILES[reqPath]) {
    await serveFile(res, VENDOR_FILES[reqPath], "no-store");
    return;
  }

  let target = reqPath === "/" ? "/index.html" : reqPath;
  target = path.normalize(target).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(STATIC_DIR, target);
  if (!filePath.startsWith(STATIC_DIR)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  await serveFile(
    res,
    filePath,
    "no-store"
  );
}

async function handleApi(req, res) {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);

  if (pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      tmuxTarget: TMUX_TARGET,
      authEnabled: Boolean(AUTH_TOKEN),
      transport: "websocket",
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

  sendJson(res, 404, { error: "Not found" });
}

function replyUpgradeError(socket, statusCode, statusText, body) {
  socket.write(
    [
      `HTTP/1.1 ${statusCode} ${statusText}`,
      "Connection: close",
      "Content-Type: text/plain; charset=utf-8",
      `Content-Length: ${Buffer.byteLength(body)}`,
      "",
      body,
    ].join("\r\n")
  );
  socket.destroy();
}

function clampDimension(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function attachTmuxClient(ws, req) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const cols = clampDimension(url.searchParams.get("cols"), 120, 40, 400);
  const rows = clampDimension(url.searchParams.get("rows"), 32, 10, 200);
  let ptyProcess;
  try {
    ptyProcess = pty.spawn(TMUX_BIN, ["attach-session", "-t", TMUX_TARGET], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: process.cwd(),
      env: {
        ...process.env,
        TERM: "xterm-256color",
      },
    });
  } catch (err) {
    const message = formatAttachError(err);
    process.stderr.write(`${message}\n`);
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "error", message }));
      ws.close();
    }
    return;
  }

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      ptyProcess.kill();
    } catch {}
  };

  ptyProcess.onData((data) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ type: "output", data }));
  });

  ptyProcess.onExit(({ exitCode, signal }) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "exit", exitCode, signal }));
      ws.close();
    }
    close();
  });

  ws.on("message", (raw) => {
    let payload;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      return;
    }
    if (!payload || typeof payload !== "object") return;
    if (payload.type === "input" && typeof payload.data === "string") {
      ptyProcess.write(payload.data);
      return;
    }
    if (payload.type === "resize") {
      const nextCols = clampDimension(payload.cols, cols, 40, 400);
      const nextRows = clampDimension(payload.rows, rows, 10, 200);
      ptyProcess.resize(nextCols, nextRows);
    }
  });

  ws.on("close", close);
  ws.on("error", close);

  ws.send(JSON.stringify({ type: "ready", cols, rows }));
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

const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws, req) => {
  attachTmuxClient(ws, req);
});

server.on("upgrade", async (req, socket, head) => {
  if (!req.url) {
    replyUpgradeError(socket, 400, "Bad Request", "Missing request URL.");
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== "/ws") {
    replyUpgradeError(socket, 404, "Not Found", "Unknown websocket endpoint.");
    return;
  }

  if (!isAuthed(req)) {
    replyUpgradeError(socket, 401, "Unauthorized", "Authentication required.");
    return;
  }

  const exists = await ensureSession();
  if (!exists) {
    replyUpgradeError(socket, 409, "Conflict", `tmux session "${TMUX_TARGET}" not found.`);
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

try {
  ensureNodePtyBackendReady();
} catch (err) {
  process.stderr.write(`${err.message || String(err)}\n`);
  process.exit(1);
}

server.listen(PORT, HOST, () => {
  const auth = AUTH_TOKEN ? "enabled" : "disabled";
  process.stdout.write(
    [
      `Web terminal listening on http://${HOST}:${PORT}`,
      `tmux target: ${TMUX_TARGET}`,
      `auth: ${auth}`,
      `auto create session: ${AUTO_CREATE_SESSION ? "yes" : "no"}`,
      "transport: xterm.js + websocket + node-pty",
    ].join("\n") + "\n"
  );
});
