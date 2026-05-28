const statusEl = document.getElementById("status");
const authCardEl = document.getElementById("auth-card");
const terminalWrapEl = document.getElementById("terminal-wrap");
const terminalEl = document.getElementById("terminal");
const screenEl = document.getElementById("screen");
const lineInputEl = document.getElementById("line-input");
const sendBtnEl = document.getElementById("send-btn");
const enterBtnEl = document.getElementById("enter-btn");
const loginBtnEl = document.getElementById("login-btn");
const passwordInputEl = document.getElementById("password-input");
const keysEl = document.getElementById("keys");
const ctrlBtnEl = document.getElementById("ctrl-btn");
const pasteBtnEl = document.getElementById("paste-btn");

let eventSource = null;
let ctrlLatch = false;
let textBuffer = "";
let textFlushTimer = null;
let autoLoginAttempted = false;

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
  terminalEl.focus();
}

function showAuth() {
  terminalWrapEl.classList.add("hidden");
  authCardEl.classList.remove("hidden");
}

function updateScreen(nextText) {
  const atBottom =
    terminalEl.scrollTop + terminalEl.clientHeight >= terminalEl.scrollHeight - 30;
  screenEl.textContent = nextText;
  if (atBottom) {
    terminalEl.scrollTop = terminalEl.scrollHeight;
  }
}

function flushTextBuffer() {
  if (!textBuffer) return;
  const text = textBuffer;
  textBuffer = "";
  textFlushTimer = null;
  sendInput({ text }).catch((err) => {
    setStatus(`Input error: ${err.message}`, true);
  });
}

function queueText(str) {
  textBuffer += str;
  if (!textFlushTimer) {
    textFlushTimer = setTimeout(flushTextBuffer, 35);
  }
}

async function sendInput(payload) {
  await api("/api/input", "POST", payload);
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

function closeStream() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
}

function connectStream() {
  closeStream();
  eventSource = new EventSource("/api/stream");
  eventSource.addEventListener("screen", (ev) => {
    const payload = JSON.parse(ev.data);
    updateScreen(payload.screen || "");
    setStatus("Connected");
  });
  eventSource.addEventListener("error", () => {
    setStatus("Disconnected, retrying...", true);
  });
}

async function bootstrap() {
  setStatus("Checking session...");
  try {
    const info = await api("/api/session");
    if (!info.ok) throw new Error(info.message || "Session unavailable");
    showTerminal();
    connectStream();
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

function mapKeyFromEvent(ev) {
  if (ev.key === "Enter") return "Enter";
  if (ev.key === "Backspace") return "Backspace";
  if (ev.key === "Tab") return "Tab";
  if (ev.key === "Escape") return "Escape";
  if (ev.key === "ArrowUp") return "ArrowUp";
  if (ev.key === "ArrowDown") return "ArrowDown";
  if (ev.key === "ArrowLeft") return "ArrowLeft";
  if (ev.key === "ArrowRight") return "ArrowRight";
  if (ev.key === "Delete") return "Delete";
  if (ev.key === "Home") return "Home";
  if (ev.key === "End") return "End";
  if (ev.key === "PageUp") return "PageUp";
  if (ev.key === "PageDown") return "PageDown";
  return "";
}

terminalEl.addEventListener("click", () => {
  terminalEl.focus();
});

lineInputEl.addEventListener("keydown", async (ev) => {
  if (ev.key !== "Enter") return;
  ev.preventDefault();
  const value = lineInputEl.value;
  if (!value) return;
  lineInputEl.value = "";
  try {
    await sendInput({ text: value, key: "Enter" });
  } catch (err) {
    setStatus(`Input error: ${err.message}`, true);
  }
});

sendBtnEl.addEventListener("click", async () => {
  const value = lineInputEl.value;
  if (!value) return;
  lineInputEl.value = "";
  try {
    await sendInput({ text: value });
  } catch (err) {
    setStatus(`Input error: ${err.message}`, true);
  }
});

enterBtnEl.addEventListener("click", async () => {
  try {
    await sendInput({ key: "Enter" });
  } catch (err) {
    setStatus(`Input error: ${err.message}`, true);
  }
});

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

keysEl.addEventListener("click", async (ev) => {
  const btn = ev.target.closest("button");
  if (!btn) return;
  const key = btn.dataset.key;
  if (!key) return;
  try {
    await sendInput({ key });
    terminalEl.focus();
  } catch (err) {
    setStatus(`Input error: ${err.message}`, true);
  }
});

ctrlBtnEl.addEventListener("click", () => {
  ctrlLatch = !ctrlLatch;
  ctrlBtnEl.classList.toggle("active", ctrlLatch);
  terminalEl.focus();
});

pasteBtnEl.addEventListener("click", async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (!text) return;
    await sendInput({ text });
    terminalEl.focus();
  } catch (err) {
    setStatus(`Paste error: ${err.message}`, true);
  }
});

document.addEventListener("keydown", async (ev) => {
  if (document.activeElement === lineInputEl || document.activeElement === passwordInputEl) {
    return;
  }
  if (!terminalWrapEl.classList.contains("hidden")) {
    terminalEl.focus();
  } else {
    return;
  }

  if (ev.metaKey) return;
  if (ev.ctrlKey && ev.key.toLowerCase() === "r") return;

  const special = mapKeyFromEvent(ev);
  if (special) {
    ev.preventDefault();
    try {
      await sendInput({ key: special });
    } catch (err) {
      setStatus(`Input error: ${err.message}`, true);
    }
    return;
  }

  if (ev.ctrlKey && ev.key.length === 1) {
    ev.preventDefault();
    const key = `C-${ev.key.toLowerCase()}`;
    try {
      await sendInput({ key });
    } catch (err) {
      setStatus(`Input error: ${err.message}`, true);
    }
    return;
  }

  if (ctrlLatch && ev.key.length === 1) {
    ev.preventDefault();
    ctrlLatch = false;
    ctrlBtnEl.classList.remove("active");
    try {
      await sendInput({ key: `C-${ev.key.toLowerCase()}` });
    } catch (err) {
      setStatus(`Input error: ${err.message}`, true);
    }
    return;
  }

  if (ev.key.length === 1 && !ev.altKey && !ev.ctrlKey) {
    ev.preventDefault();
    queueText(ev.key);
  }
});

window.addEventListener("beforeunload", () => {
  closeStream();
});

bootstrap();
