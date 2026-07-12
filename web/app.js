/**
 * iknow chat UI — container/state + presentation.
 * Loads after DOM; uses api.js same-origin Session API.
 */
import * as api from "./api.js";

/** @typedef {'idle'|'loading'|'ready'|'error'|'sending'} UiPhase */

const els = {
  messages: document.getElementById("messages"),
  form: document.getElementById("composer"),
  input: document.getElementById("query-input"),
  send: document.getElementById("send-btn"),
  status: document.getElementById("conn-status"),
  sessionId: document.getElementById("session-id"),
  mode: document.getElementById("mode-select"),
  role: document.getElementById("role-select"),
  reset: document.getElementById("reset-btn"),
  newSession: document.getElementById("new-session-btn"),
  sideSummary: document.getElementById("side-summary"),
  sideG2: document.getElementById("side-g2"),
  live: document.getElementById("live-region"),
};

/** @type {{ phase: UiPhase, session: object|null, turns: object[], lastAnswer: object|null, error: string|null }} */
const state = {
  phase: "idle",
  session: null,
  turns: [],
  lastAnswer: null,
  error: null,
};

function setBusy(busy) {
  els.send.disabled = busy || !state.session;
  els.input.disabled = busy || !state.session;
  els.reset.disabled = busy || !state.session;
  els.mode.disabled = busy || !state.session;
  els.role.disabled = busy || !state.session;
  els.status.dataset.busy = busy ? "true" : "false";
}

function announce(msg) {
  els.live.textContent = msg;
}

function renderSide() {
  const s = state.session;
  if (!s) {
    els.sessionId.textContent = "—";
    els.sideSummary.innerHTML = "<p class=\"visually-status\">无会话</p>";
    els.sideG2.textContent = "";
    return;
  }
  els.sessionId.textContent = s.conversation_id.slice(0, 8) + "…";
  els.sideSummary.innerHTML = `
    <dl>
      <dt>conversation</dt><dd title="${escapeAttr(s.conversation_id)}">${escapeHtml(s.conversation_id.slice(0, 13))}…</dd>
      <dt>mode</dt><dd>${escapeHtml(s.mode)}</dd>
      <dt>role</dt><dd>${escapeHtml(s.caller_role)}</dd>
      <dt>turns</dt><dd>${s.turn_count}</dd>
      <dt>priors</dt><dd>${s.prior_count}</dd>
      <dt>embeddings</dt><dd>${s.embeddings ? "on" : "off"}</dd>
    </dl>`;
  if (state.lastAnswer) {
    els.sideG2.textContent = JSON.stringify(
      {
        snapshot_id: state.lastAnswer.snapshot_id,
        governance_status: state.lastAnswer.governance_status,
        hops_used: state.lastAnswer.hops_used,
        tool_trace: state.lastAnswer.tool_trace,
        source_spans: state.lastAnswer.source_spans,
        tool_calls: state.lastAnswer.tool_calls,
      },
      null,
      2,
    );
  } else {
    els.sideG2.textContent = "（尚无 G2 信封）";
  }
}

function renderMessages() {
  const root = els.messages;
  root.replaceChildren();

  if (state.phase === "loading" && !state.session) {
    root.appendChild(stateBlock("loading", "正在创建会话…", "连接 Session API"));
    return;
  }
  if (state.phase === "error" && !state.session) {
    const block = stateBlock("error", "无法连接后端", state.error || "unknown");
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "primary";
    retry.textContent = "重试";
    retry.addEventListener("click", () => void bootstrap());
    block.appendChild(retry);
    root.appendChild(block);
    return;
  }
  if (state.turns.length === 0) {
    root.appendChild(
      stateBlock(
        "empty",
        "开始提问",
        "输入企业知识库问题。每轮回答含 snapshot_id 与 source_spans（G2）。",
      ),
    );
    return;
  }

  for (const t of state.turns) {
    root.appendChild(renderUserMsg(t.query));
    root.appendChild(renderAgentMsg(t));
  }

  if (state.phase === "sending") {
    root.appendChild(stateBlock("loading", "思考中…", "agent.answer in progress"));
  }
  if (state.phase === "error" && state.error) {
    root.appendChild(stateBlock("error", "本轮失败", state.error));
  }

  root.scrollTop = root.scrollHeight;
}

/**
 * @param {'loading'|'empty'|'error'} kind
 * @param {string} title
 * @param {string} detail
 */
function stateBlock(kind, title, detail) {
  const div = document.createElement("div");
  div.className = "state-block";
  if (kind === "error") {
    div.setAttribute("role", "alert");
  } else {
    div.setAttribute("role", "status");
  }
  const h = document.createElement("h2");
  h.textContent = title;
  const p = document.createElement("p");
  p.textContent = detail;
  div.append(h, p);
  return div;
}

function renderUserMsg(text) {
  const art = document.createElement("article");
  art.className = "msg user";
  art.innerHTML = `<div class="role-label">你</div><div class="body"></div>`;
  art.querySelector(".body").textContent = text;
  return art;
}

/**
 * @param {{ query: string, answer: object, human_text?: string }} turn
 */
function renderAgentMsg(turn) {
  const a = turn.answer;
  const art = document.createElement("article");
  art.className = "msg agent";
  const body = turn.human_text || a.text || "";
  const meta = `治理 ${a.governance_status} · snapshot ${shortId(a.snapshot_id)} · hops ${a.hops_used}`;
  art.innerHTML = `
    <div class="role-label">iknow</div>
    <div class="body"></div>
    <div class="meta"></div>
    <ol class="sources"></ol>`;
  art.querySelector(".body").textContent = body;
  art.querySelector(".meta").textContent = meta;
  const ol = art.querySelector(".sources");
  const spans = Array.isArray(a.source_spans) ? a.source_spans : [];
  if (spans.length === 0) {
    ol.remove();
  } else {
    for (const sp of spans) {
      const li = document.createElement("li");
      li.textContent = `${sp.chunk_id}${sp.quote ? " — " + sp.quote.slice(0, 120) : ""}`;
      ol.appendChild(li);
    }
  }
  return art;
}

function shortId(id) {
  if (!id || typeof id !== "string") return "—";
  return id.length > 12 ? id.slice(0, 12) + "…" : id;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, "&#39;");
}

function paint() {
  renderMessages();
  renderSide();
  setBusy(state.phase === "loading" || state.phase === "sending");
  if (state.session) {
    els.mode.value = state.session.mode;
    els.role.value = state.session.caller_role;
    els.status.textContent = "已连接";
  } else if (state.phase === "loading") {
    els.status.textContent = "连接中…";
  } else if (state.phase === "error") {
    els.status.textContent = "失败";
  } else {
    els.status.textContent = "未连接";
  }
}

async function bootstrap() {
  state.phase = "loading";
  state.error = null;
  state.session = null;
  state.turns = [];
  state.lastAnswer = null;
  paint();
  try {
    await api.health();
    const created = await api.createSession({
      mode: els.mode.value || "deterministic",
      role: els.role.value || "employee",
      json_mode: false,
      embeddings: false,
    });
    state.session = created.session;
    state.turns = created.turns || [];
    state.phase = "ready";
    announce("会话已创建");
  } catch (err) {
    state.phase = "error";
    state.error = err.message || String(err);
    announce("连接失败");
  }
  paint();
}

async function onSubmit(ev) {
  ev.preventDefault();
  if (!state.session || state.phase === "sending") return;
  const text = els.input.value.trim();
  if (!text) {
    els.input.focus();
    return;
  }
  state.phase = "sending";
  state.error = null;
  paint();
  try {
    const res = await api.postMessage(state.session.conversation_id, text);
    state.session = res.session;
    state.turns.push(res.turn);
    state.lastAnswer = res.turn.answer;
    els.input.value = "";
    state.phase = "ready";
    announce("回答已返回");
  } catch (err) {
    state.phase = "error";
    state.error = err.message || String(err);
    announce("提问失败");
  }
  paint();
  els.input.focus();
}

async function onReset() {
  if (!state.session) return;
  state.phase = "sending";
  paint();
  try {
    const res = await api.resetSession(state.session.conversation_id);
    state.session = res.session;
    state.turns = [];
    state.lastAnswer = null;
    state.phase = "ready";
    announce("会话已清空");
  } catch (err) {
    state.phase = "error";
    state.error = err.message || String(err);
  }
  paint();
}

async function onModeChange() {
  if (!state.session) return;
  const mode = els.mode.value;
  try {
    const res = await api.postCommand(
      state.session.conversation_id,
      "mode",
      [mode],
    );
    state.session = res.session;
    if (res.effect === "error") {
      state.error = res.message;
      state.phase = "error";
    } else {
      state.phase = "ready";
      state.error = null;
      announce(res.message);
    }
  } catch (err) {
    state.phase = "error";
    state.error = err.message || String(err);
  }
  paint();
}

async function onRoleChange() {
  if (!state.session) return;
  try {
    const res = await api.postCommand(
      state.session.conversation_id,
      "role",
      [els.role.value],
    );
    state.session = res.session;
    state.phase = "ready";
    announce(res.message);
  } catch (err) {
    state.phase = "error";
    state.error = err.message || String(err);
  }
  paint();
}

els.form.addEventListener("submit", (e) => void onSubmit(e));
els.reset.addEventListener("click", () => void onReset());
els.newSession.addEventListener("click", () => void bootstrap());
els.mode.addEventListener("change", () => void onModeChange());
els.role.addEventListener("change", () => void onRoleChange());

els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    els.form.requestSubmit();
  }
});

void bootstrap();
