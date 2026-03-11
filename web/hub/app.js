const statusEl = document.getElementById("status");
const authCardEl = document.getElementById("auth-card");
const passwordInputEl = document.getElementById("password-input");
const loginBtnEl = document.getElementById("login-btn");
const hubEl = document.getElementById("hub");
const dirSelectEl = document.getElementById("dir-select");
const toolSelectEl = document.getElementById("tool-select");
const argsInputEl = document.getElementById("args-input");
const createBtnEl = document.getElementById("create-btn");
const sessionsListEl = document.getElementById("sessions-list");
const terminalTitleEl = document.getElementById("terminal-title");
const terminalEl = document.getElementById("terminal");
const screenEl = document.getElementById("screen");
const lineInputEl = document.getElementById("line-input");
const sendBtnEl = document.getElementById("send-btn");
const enterBtnEl = document.getElementById("enter-btn");
const keysEl = document.getElementById("keys");
const ctrlBtnEl = document.getElementById("ctrl-btn");
const pasteBtnEl = document.getElementById("paste-btn");

const state = {
  config: null,
  sessions: [],
  activeSessionId: "",
  eventSource: null,
  ctrlLatch: false,
  textBuffer: "",
  textFlushTimer: null,
  refreshTimer: null,
};

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
    throw new Error(payload.error || `${response.status} ${response.statusText}`);
  }
  return payload;
}

function showAuth() {
  authCardEl.classList.remove("hidden");
  hubEl.classList.add("hidden");
}

function showHub() {
  authCardEl.classList.add("hidden");
  hubEl.classList.remove("hidden");
}

function clearTerminal() {
  screenEl.textContent = "";
  terminalTitleEl.textContent = "Terminal";
}

function closeStream() {
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
}

function activeSession() {
  return state.sessions.find((s) => s.id === state.activeSessionId) || null;
}

function connectStream() {
  closeStream();
  const session = activeSession();
  if (!session) return;
  const url = `/api/stream?sessionId=${encodeURIComponent(session.id)}`;
  state.eventSource = new EventSource(url);
  state.eventSource.addEventListener("screen", (ev) => {
    const payload = JSON.parse(ev.data);
    const atBottom =
      terminalEl.scrollTop + terminalEl.clientHeight >= terminalEl.scrollHeight - 30;
    screenEl.textContent = payload.screen || "";
    if (atBottom) terminalEl.scrollTop = terminalEl.scrollHeight;
    setStatus(`Connected: ${session.tmuxSession}`);
  });
  state.eventSource.addEventListener("error", () => {
    setStatus(`Stream disconnected: ${session.tmuxSession}`, true);
  });
}

async function login() {
  const password = passwordInputEl.value;
  await api("/api/login", "POST", { password });
  passwordInputEl.value = "";
}

function fillConfig(config) {
  dirSelectEl.innerHTML = "";
  for (const dir of config.allowlist || []) {
    const option = document.createElement("option");
    option.value = dir;
    option.textContent = dir;
    dirSelectEl.appendChild(option);
  }

  toolSelectEl.innerHTML = "";
  for (const tool of config.tools || []) {
    const option = document.createElement("option");
    option.value = tool;
    option.textContent = tool;
    toolSelectEl.appendChild(option);
  }
}

function renderSessions() {
  sessionsListEl.innerHTML = "";
  if (!state.sessions.length) {
    const empty = document.createElement("p");
    empty.textContent = "No sessions yet.";
    empty.className = "status";
    sessionsListEl.appendChild(empty);
    return;
  }

  for (const session of state.sessions) {
    const item = document.createElement("div");
    item.className = "session-item";

    const name = document.createElement("p");
    name.className = "name";
    name.textContent = `${session.tmuxSession} (${session.tool})`;
    item.appendChild(name);

    const meta = document.createElement("p");
    meta.textContent = `${session.directory} • ${session.running ? "running" : "stopped"}`;
    item.appendChild(meta);

    const row = document.createElement("div");
    row.className = "row";

    const openBtn = document.createElement("button");
    openBtn.textContent = state.activeSessionId === session.id ? "Active" : "Open";
    openBtn.disabled = !session.running || state.activeSessionId === session.id;
    openBtn.addEventListener("click", () => {
      state.activeSessionId = session.id;
      terminalTitleEl.textContent = `Terminal • ${session.tmuxSession}`;
      connectStream();
      renderSessions();
      terminalEl.focus();
    });
    row.appendChild(openBtn);

    const killBtn = document.createElement("button");
    killBtn.textContent = "Kill";
    killBtn.addEventListener("click", async () => {
      try {
        await api(`/api/sessions/${encodeURIComponent(session.id)}`, "DELETE");
        if (state.activeSessionId === session.id) {
          state.activeSessionId = "";
          closeStream();
          clearTerminal();
        }
        await refreshSessions();
      } catch (err) {
        setStatus(`Kill failed: ${err.message}`, true);
      }
    });
    row.appendChild(killBtn);

    item.appendChild(row);
    sessionsListEl.appendChild(item);
  }
}

async function refreshSessions() {
  const payload = await api("/api/sessions");
  state.sessions = payload.sessions || [];
  if (state.activeSessionId) {
    const current = activeSession();
    if (!current) {
      state.activeSessionId = "";
      closeStream();
      clearTerminal();
    } else if (!current.running) {
      closeStream();
      setStatus(`Session stopped: ${current.tmuxSession}`, true);
    }
  }
  renderSessions();
}

async function createSession() {
  const directory = dirSelectEl.value;
  const tool = toolSelectEl.value;
  const toolArgs = argsInputEl.value;
  const payload = await api("/api/sessions", "POST", { directory, tool, toolArgs });
  argsInputEl.value = "";
  await refreshSessions();
  state.activeSessionId = payload.session.id;
  terminalTitleEl.textContent = `Terminal • ${payload.session.tmuxSession}`;
  connectStream();
  renderSessions();
  terminalEl.focus();
}

async function sendInput(payload) {
  const session = activeSession();
  if (!session) {
    throw new Error("no active session");
  }
  await api("/api/input", "POST", { sessionId: session.id, ...payload });
}

function flushTextBuffer() {
  if (!state.textBuffer) return;
  const text = state.textBuffer;
  state.textBuffer = "";
  state.textFlushTimer = null;
  sendInput({ text }).catch((err) => {
    setStatus(`Input error: ${err.message}`, true);
  });
}

function queueText(str) {
  state.textBuffer += str;
  if (!state.textFlushTimer) {
    state.textFlushTimer = setTimeout(flushTextBuffer, 35);
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

createBtnEl.addEventListener("click", async () => {
  try {
    await createSession();
  } catch (err) {
    setStatus(`Create failed: ${err.message}`, true);
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
  state.ctrlLatch = !state.ctrlLatch;
  ctrlBtnEl.classList.toggle("active", state.ctrlLatch);
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
  if (!state.activeSessionId) return;
  if (document.activeElement === lineInputEl || document.activeElement === passwordInputEl) return;
  terminalEl.focus();

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
    try {
      await sendInput({ key: `C-${ev.key.toLowerCase()}` });
    } catch (err) {
      setStatus(`Input error: ${err.message}`, true);
    }
    return;
  }

  if (state.ctrlLatch && ev.key.length === 1) {
    ev.preventDefault();
    state.ctrlLatch = false;
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

loginBtnEl.addEventListener("click", async () => {
  try {
    await login();
    await bootstrap();
  } catch (err) {
    setStatus(err.message || "login failed", true);
  }
});

passwordInputEl.addEventListener("keydown", async (ev) => {
  if (ev.key !== "Enter") return;
  ev.preventDefault();
  try {
    await login();
    await bootstrap();
  } catch (err) {
    setStatus(err.message || "login failed", true);
  }
});

window.addEventListener("beforeunload", () => {
  closeStream();
  if (state.refreshTimer) clearInterval(state.refreshTimer);
});

async function bootstrap() {
  setStatus("Loading webhub...");
  try {
    const config = await api("/api/config");
    state.config = config;
    fillConfig(config);
    showHub();
    await refreshSessions();
    if (state.refreshTimer) clearInterval(state.refreshTimer);
    state.refreshTimer = setInterval(() => {
      refreshSessions().catch(() => {});
    }, 2500);
    setStatus("Connected");
  } catch (err) {
    if (String(err.message || "").includes("not authenticated")) {
      showAuth();
      setStatus("Authentication required", true);
      return;
    }
    setStatus(err.message || "Failed to load webhub", true);
  }
}

bootstrap();

