const statusEl = document.getElementById("status");
const authCardEl = document.getElementById("auth-card");
const terminalWrapEl = document.getElementById("terminal-wrap");
const terminalHostEl = document.getElementById("terminal");
const loginBtnEl = document.getElementById("login-btn");
const passwordInputEl = document.getElementById("password-input");
const pasteBtnEl = document.getElementById("paste-btn");
const ctrlcBtnEl = document.getElementById("ctrlc-btn");
const clearBtnEl = document.getElementById("clear-btn");
const reconnectBtnEl = document.getElementById("reconnect-btn");

let autoLoginAttempted = false;
let socket = null;
let resizeObserver = null;
let reconnectTimer = null;
let terminalReady = false;
let fitScheduled = false;
let lastMeasuredWidth = 0;
let lastMeasuredHeight = 0;
let lastCols = 0;
let lastRows = 0;

const terminal = new Terminal({
  cursorBlink: true,
  convertEol: false,
  fontFamily: "Iosevka Web, JetBrains Mono, Menlo, monospace",
  fontSize: 13,
  lineHeight: 1.18,
  scrollback: 5000,
  theme: {
    background: "#05111b",
    foreground: "#e7f5ff",
    cursor: "#7bf1a8",
    cursorAccent: "#05111b",
    selectionBackground: "rgba(123, 241, 168, 0.22)",
    black: "#05111b",
    red: "#ff7a90",
    green: "#7bf1a8",
    yellow: "#ffbc6d",
    blue: "#77c3ff",
    magenta: "#dba8ff",
    cyan: "#73f0ff",
    white: "#e7f5ff",
    brightBlack: "#557287",
    brightRed: "#ff9cae",
    brightGreen: "#a0ffc0",
    brightYellow: "#ffd394",
    brightBlue: "#9bd4ff",
    brightMagenta: "#ebc2ff",
    brightCyan: "#9af7ff",
    brightWhite: "#ffffff",
  },
});
const fitAddon = new FitAddon.FitAddon();
terminal.loadAddon(fitAddon);

function setStatus(text, warn = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("warn", warn);
}

async function api(path, method = "GET", body) {
  const response = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  if (!response.ok) {
    const message = payload.error || `${response.status} ${response.statusText}`;
    throw new Error(message);
  }
  return payload;
}

function showTerminal() {
  authCardEl.classList.add("hidden");
  terminalWrapEl.classList.remove("hidden");
}

function showAuth() {
  terminalWrapEl.classList.add("hidden");
  authCardEl.classList.remove("hidden");
}

async function login() {
  const password = passwordInputEl.value;
  await api("/api/login", "POST", { password });
  passwordInputEl.value = "";
}

function readPasswordFromUrl() {
  const url = new URL(window.location.href);
  const password = url.searchParams.get("pwd");
  return password && password.length > 0 ? password : "";
}

function clearPasswordFromUrl() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("pwd")) return;
  url.searchParams.delete("pwd");
  const nextUrl = `${url.pathname}${url.search}${url.hash}`;
  window.history.replaceState({}, "", nextUrl);
}

async function maybeAutoLoginFromUrl() {
  if (autoLoginAttempted) return false;
  autoLoginAttempted = true;
  const password = readPasswordFromUrl();
  if (!password) return false;
  try {
    await api("/api/login", "POST", { password });
    clearPasswordFromUrl();
    return true;
  } catch (err) {
    setStatus(err.message || "Login failed", true);
    return false;
  }
}

function clearReconnectTimer() {
  if (!reconnectTimer) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function websocketUrl() {
  const url = new URL(window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.search = "";
  return url.toString();
}

function sendResizeIfNeeded() {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  if (terminal.cols === lastCols && terminal.rows === lastRows) return;
  lastCols = terminal.cols;
  lastRows = terminal.rows;
  socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
}

function fitTerminal() {
  fitScheduled = false;
  if (!terminalReady) return;
  const nextWidth = terminalHostEl.clientWidth;
  const nextHeight = terminalHostEl.clientHeight;
  if (nextWidth <= 0 || nextHeight <= 0) return;
  if (nextWidth === lastMeasuredWidth && nextHeight === lastMeasuredHeight) {
    sendResizeIfNeeded();
    return;
  }
  lastMeasuredWidth = nextWidth;
  lastMeasuredHeight = nextHeight;
  fitAddon.fit();
  sendResizeIfNeeded();
}

function scheduleFit() {
  if (fitScheduled) return;
  fitScheduled = true;
  window.requestAnimationFrame(() => {
    fitTerminal();
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectTerminal(true);
  }, 1000);
}

function connectTerminal(isReconnect = false) {
  clearReconnectTimer();
  if (socket) {
    socket.onclose = null;
    socket.onerror = null;
    socket.onmessage = null;
    socket.close();
  }

  setStatus(isReconnect ? "Reconnecting..." : "Connecting...");
  socket = new WebSocket(websocketUrl());

  socket.addEventListener("open", () => {
    setStatus("Connected");
    scheduleFit();
    terminal.focus();
  });

  socket.addEventListener("message", (event) => {
    let payload = null;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!payload || typeof payload !== "object") return;
    if (payload.type === "output" && typeof payload.data === "string") {
      terminal.write(payload.data);
      return;
    }
    if (payload.type === "ready") {
      scheduleFit();
      return;
    }
    if (payload.type === "exit") {
      setStatus("Session exited", true);
      return;
    }
  });

  socket.addEventListener("close", () => {
    setStatus("Disconnected, retrying...", true);
    scheduleReconnect();
  });

  socket.addEventListener("error", () => {
    setStatus("Websocket error", true);
  });
}

function ensureTerminalMounted() {
  if (terminalReady) return;
  terminal.open(terminalHostEl);
  terminal.onData((data) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: "input", data }));
  });
  resizeObserver = new ResizeObserver(() => {
    scheduleFit();
  });
  resizeObserver.observe(terminalWrapEl);
  window.addEventListener("resize", scheduleFit);
  terminalReady = true;
  scheduleFit();
}

async function bootstrap() {
  setStatus("Checking session...");
  try {
    const info = await api("/api/session");
    if (!info.ok) throw new Error(info.message || "Session unavailable");
    showTerminal();
    ensureTerminalMounted();
    connectTerminal(false);
    setStatus(`Connected to tmux target "${info.tmuxTarget}"`);
  } catch (err) {
    if (String(err.message || "").includes("Not authenticated")) {
      const loggedIn = await maybeAutoLoginFromUrl();
      if (loggedIn) {
        await bootstrap();
        return;
      }
      showAuth();
      setStatus("Authentication required", true);
      return;
    }
    setStatus(err.message || "Failed to connect", true);
  }
}

loginBtnEl.addEventListener("click", async () => {
  try {
    await login();
    await bootstrap();
  } catch (err) {
    setStatus(err.message || "Login failed", true);
  }
});

passwordInputEl.addEventListener("keydown", async (ev) => {
  if (ev.key !== "Enter") return;
  ev.preventDefault();
  try {
    await login();
    await bootstrap();
  } catch (err) {
    setStatus(err.message || "Login failed", true);
  }
});

pasteBtnEl.addEventListener("click", async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (!text || !socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: "input", data: text }));
    terminal.focus();
  } catch (err) {
    setStatus(`Paste error: ${err.message}`, true);
  }
});

ctrlcBtnEl.addEventListener("click", () => {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: "input", data: "\u0003" }));
  terminal.focus();
});

clearBtnEl.addEventListener("click", () => {
  terminal.clear();
  terminal.focus();
});

reconnectBtnEl.addEventListener("click", () => {
  connectTerminal(true);
});

window.addEventListener("beforeunload", () => {
  clearReconnectTimer();
  if (resizeObserver) {
    resizeObserver.disconnect();
  }
  window.removeEventListener("resize", scheduleFit);
  if (socket) {
    socket.close();
  }
});

bootstrap();
