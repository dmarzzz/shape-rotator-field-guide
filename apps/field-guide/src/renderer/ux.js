// UX scaffolding — toasts, command palette, keyboard-shortcut overlay,
// connection status dot. Self-contained: nothing here imports from boot.js;
// boot.js wires it via the exports below.
//
// Conventions:
//  - Persisted prefs use the "srwk:" localStorage namespace.
//  - All animations honor prefers-reduced-motion (handled in styles.css).
//  - Inline SVG only; no icon font, no NPM dep.

const REDUCE_MOTION_KEY = "srwk:reduce-motion";

// ─── reduced motion ──────────────────────────────────────────────────────
// Source of truth merges OS preference + manual override (user can flip
// reduce-motion in the command palette to validate / disable trail effects
// they find distracting even if their OS lies).
function osPrefersReducedMotion() {
  try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; }
  catch { return false; }
}
function manualReducedMotion() {
  try { return localStorage.getItem(REDUCE_MOTION_KEY) === "1"; }
  catch { return false; }
}
export function isReducedMotion() {
  return osPrefersReducedMotion() || manualReducedMotion();
}
export function setManualReducedMotion(on) {
  try { localStorage.setItem(REDUCE_MOTION_KEY, on ? "1" : "0"); } catch {}
  applyReducedMotionAttr();
}
export function toggleManualReducedMotion() {
  setManualReducedMotion(!manualReducedMotion());
  return manualReducedMotion();
}
function applyReducedMotionAttr() {
  document.documentElement.dataset.reduceMotion = isReducedMotion() ? "1" : "0";
}
applyReducedMotionAttr();
try {
  window.matchMedia("(prefers-reduced-motion: reduce)").addEventListener?.("change", applyReducedMotionAttr);
} catch {}

// ─── toasts ──────────────────────────────────────────────────────────────
// Top-right stack, max 3 visible, auto-dismiss after 4s, hover pauses,
// click dismisses. role="status" + aria-live="polite" so screen readers
// announce the message without yanking focus.

const TOAST_MAX_STACK = 3;
const TOAST_DEFAULT_MS = 4000;

let toastHost = null;
function ensureToastHost() {
  if (toastHost && document.body.contains(toastHost)) return toastHost;
  toastHost = document.createElement("div");
  toastHost.id = "ux-toasts";
  toastHost.className = "ux-toasts";
  toastHost.setAttribute("role", "status");
  toastHost.setAttribute("aria-live", "polite");
  toastHost.setAttribute("aria-atomic", "false");
  document.body.appendChild(toastHost);
  return toastHost;
}

const TOAST_ICON = {
  info:    `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6.25"/><path d="M8 5.5v.01"/><path d="M8 8v3"/></svg>`,
  success: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8.5l3 3 7-7"/></svg>`,
  warn:    `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 1.75 14.5 13.5h-13L8 1.75Z"/><path d="M8 6.5v3"/><path d="M8 12v.01"/></svg>`,
  error:   `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6.25"/><path d="M5.5 5.5l5 5"/><path d="M10.5 5.5l-5 5"/></svg>`,
};

export function toast(opts) {
  const o = (typeof opts === "string") ? { message: opts } : (opts || {});
  const kind = o.kind || "info";
  const msg = String(o.message || "");
  if (!msg) return;
  const host = ensureToastHost();

  // cap stack
  while (host.children.length >= TOAST_MAX_STACK) {
    host.firstElementChild?.remove();
  }

  const el = document.createElement("div");
  el.className = `ux-toast ux-toast-${kind}`;
  el.setAttribute("role", "status");
  el.innerHTML = `
    <span class="ux-toast-icon" aria-hidden="true">${TOAST_ICON[kind] || TOAST_ICON.info}</span>
    <div class="ux-toast-body">
      ${o.title ? `<div class="ux-toast-title">${escapeHtml(o.title)}</div>` : ""}
      <div class="ux-toast-msg">${escapeHtml(msg)}</div>
    </div>
    <button class="ux-toast-close" type="button" aria-label="dismiss notification">&times;</button>
  `;
  let dismissed = false;
  let remaining = (typeof o.duration === "number") ? o.duration : TOAST_DEFAULT_MS;
  let startedAt = performance.now();
  let timer = null;
  function clearTimer() { if (timer) { clearTimeout(timer); timer = null; } }
  function schedule(ms) {
    clearTimer();
    if (ms <= 0) return;
    timer = setTimeout(dismiss, ms);
    startedAt = performance.now();
  }
  function dismiss() {
    if (dismissed) return;
    dismissed = true;
    clearTimer();
    el.classList.add("leaving");
    const cleanup = () => el.remove();
    if (isReducedMotion()) cleanup();
    else el.addEventListener("transitionend", cleanup, { once: true });
    setTimeout(cleanup, 400);  // belt+suspenders if no transitionend fires
  }
  el.addEventListener("mouseenter", () => {
    remaining = Math.max(0, remaining - (performance.now() - startedAt));
    clearTimer();
  });
  el.addEventListener("mouseleave", () => {
    if (!dismissed) schedule(remaining);
  });
  el.querySelector(".ux-toast-close").addEventListener("click", (e) => {
    e.stopPropagation();
    dismiss();
  });
  host.appendChild(el);
  // animate in on next frame
  requestAnimationFrame(() => { el.classList.add("entered"); });
  schedule(remaining);
  return { dismiss };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ─── connection status indicator ─────────────────────────────────────────
// Renders a 8px dot in the titlebar (next to the wordmark). Hover popover
// shows the swf-node URL, last-event-received timestamp, latest probe RTT
// to the local backend, peer count, and human-readable state. Updated by
// setConnectionState() called from boot. Lives in the chrome (titlebar)
// rather than the graph tab so it doesn't compete with the per-tab
// anonymity badge for the top-right corner.

const connState = {
  state: "connecting",   // 'connecting' | 'connected' | 'reconnecting' | 'down'
  serverUrl: "—",
  lastEventTs: null,
  rttMs: null,
  detail: "",
  peers: null,           // { total: number, selfOnly: boolean, others?: string[] }
};

let connDot = null;
let connPopover = null;

export function mountConnectionIndicator(opts = {}) {
  // Live in the titlebar wordmark row so the dot stays in the app chrome
  // (where status indicators belong) and out of the graph's top-right
  // corner (where the anonymity badge lives). Falls back to the tab-bar
  // only if the titlebar mark row isn't present yet.
  const host =
    document.querySelector(".titlebar .mark-row-primary") ||
    document.getElementById("tab-bar");
  if (!host) return;
  if (document.getElementById("ux-conn-dot")) return;
  const wrap = document.createElement("div");
  wrap.className = "ux-conn-wrap";
  wrap.id = "ux-conn-wrap";
  wrap.innerHTML = `
    <button id="ux-conn-dot" class="ux-conn-dot" type="button"
            aria-label="connection status" data-state="connecting">
      <span class="ux-conn-dot-inner" aria-hidden="true"></span>
    </button>
    <div id="ux-conn-popover" class="ux-conn-popover" hidden>
      <div class="ux-conn-row"><span class="k">state</span><span class="v" data-k="state">—</span></div>
      <div class="ux-conn-row"><span class="k">server</span><span class="v mono" data-k="server">—</span></div>
      <div class="ux-conn-row"><span class="k">backend</span><span class="v mono" data-k="rtt">—</span></div>
      <div class="ux-conn-row" data-row="peers"><span class="k">peers</span><span class="v mono" data-k="peers">—</span></div>
      <div class="ux-conn-row"><span class="k">last event</span><span class="v mono" data-k="last">—</span></div>
      <div class="ux-conn-detail" data-k="detail" hidden></div>
    </div>
  `;
  host.appendChild(wrap);
  connDot = wrap.querySelector("#ux-conn-dot");
  connPopover = wrap.querySelector("#ux-conn-popover");
  let hideTimer = null;
  function show() {
    clearTimeout(hideTimer);
    renderConnPopover();
    connPopover.hidden = false;
  }
  function hideSoon() {
    hideTimer = setTimeout(() => { connPopover.hidden = true; }, 120);
  }
  connDot.addEventListener("mouseenter", show);
  connDot.addEventListener("focus", show);
  connDot.addEventListener("mouseleave", hideSoon);
  connDot.addEventListener("blur", hideSoon);
  connPopover.addEventListener("mouseenter", () => clearTimeout(hideTimer));
  connPopover.addEventListener("mouseleave", hideSoon);
  if (opts.serverUrl) connState.serverUrl = opts.serverUrl;
  renderConnDot();
}

export function setConnectionState(patch) {
  Object.assign(connState, patch || {});
  renderConnDot();
  renderConnPopover();
}

export function noteConnectionEvent() {
  connState.lastEventTs = Date.now();
  renderConnPopover();
}

function renderConnDot() {
  if (!connDot) return;
  connDot.dataset.state = connState.state;
  const labels = {
    connecting: "connecting.",
    connected: "connected.",
    reconnecting: "reconnecting.",
    down: "disconnected.",
  };
  connDot.setAttribute("aria-label", `connection: ${labels[connState.state] || connState.state}`);
}

function renderConnPopover() {
  if (!connPopover) return;
  const set = (k, v) => {
    const el = connPopover.querySelector(`[data-k="${k}"]`);
    if (el) el.textContent = v;
  };
  const stateLabels = {
    connecting: "connecting.",
    connected: "connected.",
    reconnecting: "reconnecting.",
    down: "disconnected.",
  };
  set("state", stateLabels[connState.state] || connState.state);
  // Drop the URL scheme — saves horizontal space and the popover is
  // already labelled "server", so http:// adds no information.
  set("server", shortServer(connState.serverUrl));
  // BACKEND replaces the old "latency" label. This is RTT to the local
  // swf-node, not to remote peers — calling it "latency" was misleading
  // when the only "peer" is the local backend itself.
  set("rtt", connState.rttMs != null ? `${Math.round(connState.rttMs)} ms` : "—");
  // PEERS row. Show count + nicknames if they fit, else just the count.
  // We deliberately do NOT show a peer-RTT row: the backend doesn't
  // collect that, and fabricating a number leaks confusion.
  const peers = connState.peers;
  set("peers", formatPeers(peers));
  set("last", connState.lastEventTs ? agoString(connState.lastEventTs) : "—");
  const detailEl = connPopover.querySelector('[data-k="detail"]');
  if (detailEl) {
    if (connState.detail) {
      detailEl.textContent = connState.detail;
      detailEl.hidden = false;
    } else {
      detailEl.hidden = true;
    }
  }
}

function shortServer(url) {
  if (!url || url === "—") return "—";
  // Strip scheme. Leave any trailing path/port intact.
  return String(url).replace(/^https?:\/\//i, "");
}

function formatPeers(p) {
  if (!p || typeof p.total !== "number") return "—";
  if (p.total <= 0) return "0";
  if (p.selfOnly || p.total === 1) return "1 (self only)";
  // Inline nicknames if the line stays short. The popover is 208px so we
  // budget ~36 chars of value text before it wraps; otherwise just show
  // the count.
  const others = Array.isArray(p.others) ? p.others.filter(Boolean) : [];
  if (others.length) {
    const joined = others.join(", ");
    const candidate = `${p.total} — ${joined}`;
    if (candidate.length <= 36) return candidate;
  }
  return `${p.total} active`;
}

function agoString(ts) {
  const dt = Math.max(0, Date.now() - ts);
  if (dt < 1000) return "just now";
  if (dt < 60_000) return `${Math.round(dt / 1000)}s ago`;
  if (dt < 3_600_000) return `${Math.round(dt / 60_000)}m ago`;
  return `${Math.round(dt / 3_600_000)}h ago`;
}

// keep "last event" label fresh while popover is visible
setInterval(() => {
  if (connPopover && !connPopover.hidden) renderConnPopover();
}, 2000);

// ─── keyboard shortcut overlay (press ?) ─────────────────────────────────

let kbdOverlay = null;
let kbdShortcutGroups = [];

export function registerKeyboardShortcuts(groups) {
  kbdShortcutGroups = groups || [];
}

export function openKeyboardOverlay() {
  if (kbdOverlay) return;
  kbdOverlay = document.createElement("div");
  kbdOverlay.className = "ux-modal-backdrop ux-kbd-backdrop";
  kbdOverlay.setAttribute("role", "dialog");
  kbdOverlay.setAttribute("aria-modal", "true");
  kbdOverlay.setAttribute("aria-labelledby", "ux-kbd-title");
  const groupsHtml = kbdShortcutGroups.map(g => `
    <section class="ux-kbd-group">
      <h3 class="ux-kbd-group-title">${escapeHtml(g.title)}</h3>
      <ul class="ux-kbd-list">
        ${g.items.map(item => `
          <li class="ux-kbd-item">
            <span class="ux-kbd-keys">${(item.keys || []).map(k => `<kbd class="ux-kbd">${escapeHtml(k)}</kbd>`).join('<span class="ux-kbd-plus">+</span>')}</span>
            <span class="ux-kbd-label">${escapeHtml(item.label)}</span>
          </li>
        `).join("")}
      </ul>
    </section>
  `).join("");
  kbdOverlay.innerHTML = `
    <div class="ux-modal ux-kbd-modal" role="document">
      <header class="ux-kbd-header">
        <h2 class="ux-kbd-title" id="ux-kbd-title">keyboard shortcuts</h2>
        <button class="ux-modal-close" type="button" aria-label="close">&times;</button>
      </header>
      <div class="ux-kbd-body">
        ${groupsHtml || `<div class="ux-kbd-empty">no shortcuts registered</div>`}
      </div>
      <footer class="ux-kbd-footer">
        <span>press <kbd class="ux-kbd">?</kbd> any time to open this</span>
        <span>press <kbd class="ux-kbd">esc</kbd> to dismiss</span>
      </footer>
    </div>
  `;
  document.body.appendChild(kbdOverlay);
  requestAnimationFrame(() => kbdOverlay.classList.add("entered"));
  kbdOverlay.querySelector(".ux-modal-close").addEventListener("click", closeKeyboardOverlay);
  kbdOverlay.addEventListener("click", (e) => {
    if (e.target === kbdOverlay) closeKeyboardOverlay();
  });
}

export function closeKeyboardOverlay() {
  if (!kbdOverlay) return;
  const el = kbdOverlay;
  kbdOverlay = null;
  el.classList.add("leaving");
  const cleanup = () => el.remove();
  if (isReducedMotion()) cleanup();
  else el.addEventListener("transitionend", cleanup, { once: true });
  setTimeout(cleanup, 400);
}

// ─── command palette (Cmd-K) ─────────────────────────────────────────────
// Linear/Raycast-style: centered modal, mono input, single column of
// commands with grouped headers, J/K + arrow-key + mouse selection,
// Enter executes, Esc closes. Fuzzy match: subsequence + ranks contiguous
// matches higher.

let cmdState = {
  open: false,
  el: null,
  inputEl: null,
  listEl: null,
  query: "",
  commands: [],
  filtered: [],
  selectedIdx: 0,
};

let cmdRegistry = [];

export function registerCommands(list) {
  cmdRegistry = (list || []).filter(Boolean);
}

export function openCommandPalette() {
  if (cmdState.open) return;
  cmdState.open = true;
  const el = document.createElement("div");
  el.className = "ux-modal-backdrop ux-cmd-backdrop";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-labelledby", "ux-cmd-title");
  el.innerHTML = `
    <div class="ux-modal ux-cmd-modal" role="document">
      <h2 class="ux-cmd-title sr-only" id="ux-cmd-title">command palette</h2>
      <div class="ux-cmd-input-wrap">
        <span class="ux-cmd-glyph" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="7" r="5"/><path d="M14 14l-3.5-3.5"/></svg>
        </span>
        <input class="ux-cmd-input" type="text" autocomplete="off" spellcheck="false"
               placeholder="search commands…" aria-label="search commands" />
        <kbd class="ux-kbd ux-cmd-esc">esc</kbd>
      </div>
      <ul class="ux-cmd-list" role="listbox" aria-label="commands"></ul>
      <footer class="ux-cmd-footer">
        <span><kbd class="ux-kbd">↑</kbd><kbd class="ux-kbd">↓</kbd> navigate</span>
        <span><kbd class="ux-kbd">return</kbd> run</span>
        <span><kbd class="ux-kbd">esc</kbd> close</span>
      </footer>
    </div>
  `;
  document.body.appendChild(el);
  cmdState.el = el;
  cmdState.inputEl = el.querySelector(".ux-cmd-input");
  cmdState.listEl = el.querySelector(".ux-cmd-list");
  cmdState.commands = cmdRegistry.slice();
  cmdState.query = "";
  cmdState.selectedIdx = 0;
  filterAndRenderCommands();
  cmdState.inputEl.addEventListener("input", () => {
    cmdState.query = cmdState.inputEl.value;
    cmdState.selectedIdx = 0;
    filterAndRenderCommands();
  });
  cmdState.inputEl.addEventListener("keydown", onCommandInputKey);
  el.addEventListener("click", (e) => {
    if (e.target === el) closeCommandPalette();
  });
  requestAnimationFrame(() => {
    el.classList.add("entered");
    cmdState.inputEl.focus();
  });
}

export function closeCommandPalette() {
  if (!cmdState.open) return;
  cmdState.open = false;
  const el = cmdState.el;
  cmdState.el = null;
  cmdState.inputEl = null;
  cmdState.listEl = null;
  cmdState.commands = [];
  cmdState.filtered = [];
  if (!el) return;
  el.classList.add("leaving");
  const cleanup = () => el.remove();
  if (isReducedMotion()) cleanup();
  else el.addEventListener("transitionend", cleanup, { once: true });
  setTimeout(cleanup, 400);
}

function onCommandInputKey(e) {
  if (e.key === "Escape") {
    e.preventDefault();
    closeCommandPalette();
    return;
  }
  if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n") || (e.ctrlKey && e.key === "j")) {
    e.preventDefault();
    cmdState.selectedIdx = Math.min(cmdState.filtered.length - 1, cmdState.selectedIdx + 1);
    renderCommandList();
    return;
  }
  if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p") || (e.ctrlKey && e.key === "k")) {
    e.preventDefault();
    cmdState.selectedIdx = Math.max(0, cmdState.selectedIdx - 1);
    renderCommandList();
    return;
  }
  if (e.key === "Enter") {
    e.preventDefault();
    runSelectedCommand();
    return;
  }
}

function fuzzyScore(needle, hay) {
  if (!needle) return 1;
  const n = needle.toLowerCase();
  const h = hay.toLowerCase();
  if (h.includes(n)) {
    return 200 + (h.startsWith(n) ? 50 : 0) - h.indexOf(n);
  }
  let i = 0, j = 0, score = 0, lastMatch = -2;
  while (i < n.length && j < h.length) {
    if (n[i] === h[j]) {
      score += (j === lastMatch + 1) ? 4 : 1;
      lastMatch = j;
      i++;
    }
    j++;
  }
  return i === n.length ? score : 0;
}

function resolveCmdLabel(c) {
  return typeof c.label === "function" ? c.label() : c.label;
}
function resolveCmdHint(c) {
  return typeof c.hint === "function" ? c.hint() : c.hint;
}
function filterAndRenderCommands() {
  const q = cmdState.query.trim();
  if (!q) {
    cmdState.filtered = cmdState.commands.slice();
  } else {
    const scored = cmdState.commands
      .map(c => ({ c, s: fuzzyScore(q, `${resolveCmdLabel(c)} ${c.group || ""} ${(c.keywords || []).join(" ")}`) }))
      .filter(x => x.s > 0)
      .sort((a, b) => b.s - a.s);
    cmdState.filtered = scored.map(x => x.c);
  }
  if (cmdState.selectedIdx >= cmdState.filtered.length) {
    cmdState.selectedIdx = Math.max(0, cmdState.filtered.length - 1);
  }
  renderCommandList();
}

function renderCommandList() {
  const list = cmdState.listEl;
  if (!list) return;
  if (cmdState.filtered.length === 0) {
    list.innerHTML = `<li class="ux-cmd-empty">no commands match</li>`;
    return;
  }
  list.innerHTML = "";
  let prevGroup = null;
  cmdState.filtered.forEach((cmd, i) => {
    if (cmd.group && cmd.group !== prevGroup) {
      const h = document.createElement("li");
      h.className = "ux-cmd-group";
      h.textContent = cmd.group;
      list.appendChild(h);
      prevGroup = cmd.group;
    }
    const li = document.createElement("li");
    li.className = "ux-cmd-item";
    if (i === cmdState.selectedIdx) li.classList.add("selected");
    li.setAttribute("role", "option");
    li.setAttribute("aria-selected", i === cmdState.selectedIdx ? "true" : "false");
    li.dataset.idx = String(i);
    const label = resolveCmdLabel(cmd);
    const hint = resolveCmdHint(cmd);
    li.innerHTML = `
      <span class="ux-cmd-item-label">${escapeHtml(label)}</span>
      ${hint ? `<span class="ux-cmd-item-hint">${escapeHtml(hint)}</span>` : ""}
      ${cmd.keys ? `<span class="ux-cmd-item-keys">${cmd.keys.map(k => `<kbd class="ux-kbd">${escapeHtml(k)}</kbd>`).join("")}</span>` : ""}
    `;
    li.addEventListener("mouseenter", () => {
      if (cmdState.selectedIdx !== i) {
        cmdState.selectedIdx = i;
        renderCommandList();
      }
    });
    li.addEventListener("click", () => runSelectedCommand());
    list.appendChild(li);
  });
  // scroll selected into view
  const selEl = list.querySelector(".ux-cmd-item.selected");
  if (selEl?.scrollIntoView) selEl.scrollIntoView({ block: "nearest" });
}

function runSelectedCommand() {
  const cmd = cmdState.filtered[cmdState.selectedIdx];
  if (!cmd) return;
  closeCommandPalette();
  try { cmd.run?.(); }
  catch (e) {
    console.warn("[cmd]", cmd.id, e);
    toast({ kind: "error", message: `command failed: ${cmd.label}` });
  }
}

// ─── global keyboard wiring (delegated) ──────────────────────────────────
// Returns a cleanup-not-needed handle. The hooks let boot.js attach app-
// specific behavior (jumping tabs, restarting connection, etc.) via
// registerCommands / registerKeyboardShortcuts.
export function wireGlobalKeyboard() {
  document.addEventListener("keydown", (e) => {
    const inEditable = isEditableTarget(e.target);
    // Cmd/Ctrl-K → command palette (replaces previous shortcut that was
    // re-bound to '/' for focus-search).
    if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
      // open even when inside an input
      e.preventDefault();
      if (cmdState.open) closeCommandPalette();
      else openCommandPalette();
      return;
    }
    // '?' anywhere (not modified, not in an editable) → keyboard overlay.
    if (!inEditable && (e.key === "?" || (e.key === "/" && e.shiftKey))) {
      e.preventDefault();
      if (kbdOverlay) closeKeyboardOverlay();
      else openKeyboardOverlay();
      return;
    }
    // Plain Esc closes whichever modal is open
    if (e.key === "Escape") {
      if (kbdOverlay) { e.preventDefault(); closeKeyboardOverlay(); return; }
      if (cmdState.open) { e.preventDefault(); closeCommandPalette(); return; }
    }
  });
}

function isEditableTarget(t) {
  if (!t || !t.tagName) return false;
  const tag = t.tagName.toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (t.isContentEditable) return true;
  return false;
}
