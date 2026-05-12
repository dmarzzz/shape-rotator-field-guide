// Alchemy tab. Cohort-progress sandbox. Four exploratory views behind a
// left-rail switcher: legend (the shape vocabulary), shapes (the cohort
// rendered as those shapes), pulse, constellation. Aesthetic bridges
// atlas (dark cyber) and shaperotator.xyz (museum-specimen brutalism on
// warm paper) — same dark stage, oxide-red signature, mono small-caps
// "specimen tag" treatment, slow tilt/breathe motion.
//
// Data comes from cohort-source.js (the §4.5 abstraction). This module
// never touches swf-node directly. Only surface fields are read here —
// alchemist-only fields (class, archetype, status, etc.) live on the
// alchemist app's depth-bundle path and never enter this bundle.
//
// Public API matches atlas.js / cosmos.js / graph2.js so boot.js can
// mount this the same way:
//   mount(container)        - idempotent
//   setActive(bool)         - pause/resume any animations
//   notifyDataChanged()     - rebuild from latest data

import {
  SHAPES, SHAPE_BY_KEY, shapeForTeam, shapeSvgByFam, domainLabel,
} from "@shape-rotator/shape-ui";
import { getCohortSurface, subscribeToCohortChanges } from "./cohort-source.js";

const ALCHEMY_LS_KEY  = "srwk:alchemy_mode";
const PROFILE_LS_KEY  = "srwk:profile_v1";
const EVENTS_LS_KEY   = "srwk:cohort_events_v1";
const DETAIL_LS_KEY   = "srwk:alchemy_detail_v1";
const ALCHEMY_MODES   = ["feed", "shapes", "pulse", "constellation", "profile"];

const WEEKS_TOTAL = 10;
const WEEK_NOW = 1; // TODO: bump weekly, or derive from a cohort start date.

// GitHub event refresh cadence. 60 req/hr unauth limit; we fetch one
// request per tracked repo per refresh cycle. 14 teams × 1 repo each
// → 14 reqs every 10 min = 84/hr ⇒ stay within budget at 12 min idle
// with a single repo per team.
const FEED_REFRESH_MS = 12 * 60 * 1000;

// Where the cohort-data markdown lives. Profile tab surfaces a link to
// each team's record so participants can edit it directly. Hardcoded
// for now — if this repo is ever renamed or the cohort-data dir moves
// to a separate repo (D4 from the spec walkthrough), update this.
const COHORT_DATA_REPO = "https://github.com/dmarzzz/shape-rotator-field-guide";
const COHORT_DATA_BRANCH = "main";
function teamRecordEditUrl(record_id) {
  return `${COHORT_DATA_REPO}/edit/${COHORT_DATA_BRANCH}/cohort-data/teams/${record_id}.md`;
}
function teamRecordViewUrl(record_id) {
  return `${COHORT_DATA_REPO}/blob/${COHORT_DATA_BRANCH}/cohort-data/teams/${record_id}.md`;
}

const state = {
  mounted: false,
  active: false,
  container: null,
  canvas: null,
  rail: null,
  mode: "feed",
  shapesKindFilter: "all",  // "all" | "team" | "project" — chip on the shapes grid
  detailRecordId: null,     // when set, the alchemy canvas renders the full detail page for this team/project
  detailReturnMode: null,   // remembered so the back button knows where to land
  cohort: null,        // { teams, clusters, people } from cohort-source
  profile: null,       // local-only: { user, editor state, ... }
  events: [],          // normalized feed items, latest-first
  fetchedAt: 0,
  isFetching: false,
  unsubscribe: null,
  refreshTimer: null,
};

export function mount(container) {
  if (state.mounted) return;
  state.container = container;
  state.canvas = document.getElementById("alchemy-canvas");
  state.rail = container.querySelector(".alchemy-rail");
  if (!state.canvas || !state.rail) return;

  try {
    const saved = localStorage.getItem(ALCHEMY_LS_KEY);
    if (saved && ALCHEMY_MODES.includes(saved)) state.mode = saved;
    // Migrations:
    if (saved === "specimens") { state.mode = "shapes"; localStorage.setItem(ALCHEMY_LS_KEY, "shapes"); }
    if (saved === "legend")    { state.mode = "feed";   localStorage.setItem(ALCHEMY_LS_KEY, "feed"); }
  } catch {}
  // Detail page state — if a record was open at last reload, restore it
  // so the user lands back where they were instead of on the grid.
  try {
    const dRaw = localStorage.getItem(DETAIL_LS_KEY);
    if (dRaw) {
      const d = JSON.parse(dRaw);
      if (d?.recordId) state.detailRecordId = String(d.recordId);
      if (d?.returnMode && ALCHEMY_MODES.includes(d.returnMode)) state.detailReturnMode = d.returnMode;
    }
  } catch {}
  loadProfile();
  loadEventsCache();
  // Background feed refresh — runs regardless of which mode is visible
  // so the feed is always warm when the user lands on it.
  if (!state.refreshTimer) {
    state.refreshTimer = setInterval(() => refreshFeed({ source: "interval" }), FEED_REFRESH_MS);
    // First fetch on mount, deferred a beat so we don't compete with cohort load.
    setTimeout(() => refreshFeed({ source: "mount" }), 1500);
  }

  for (const btn of state.rail.querySelectorAll(".alchemy-rail-btn")) {
    btn.addEventListener("click", () => {
      const next = btn.dataset.alchMode;
      if (!next) return;
      // Clicking any rail mode also exits the detail page if it's open.
      const wasDetail = !!state.detailRecordId;
      if (next === state.mode && !wasDetail) return;
      state.mode = next;
      if (wasDetail) {
        state.detailRecordId = null;
        state.detailReturnMode = null;
        try { localStorage.removeItem(DETAIL_LS_KEY); } catch {}
      }
      try { localStorage.setItem(ALCHEMY_LS_KEY, next); } catch {}
      syncRailSelection();
      render();
    });
  }
  syncRailSelection();
  loadCohort().then(render).catch(err => {
    console.error("[alchemy] cohort load failed:", err);
    state.canvas.innerHTML = `<p class="alch-callout"><strong>cohort data unavailable</strong><br/>${escHtml(err.message || String(err))}</p>`;
  });
  state.unsubscribe = subscribeToCohortChanges(() => {
    loadCohort().then(render).catch(() => {});
  });
  state.mounted = true;
}

export function setActive(v) {
  state.active = !!v;
}

export function notifyDataChanged() {
  if (!state.mounted) return;
  loadCohort().then(render).catch(() => {});
}

// Cross-module bridge — identity.js (and any future caller) can route
// the user into the profile editor focused on a specific record:
//   window.__srwkOpenProfile({ kind: "person"|"team"|"project",
//                              record_id: "<slug>",
//                              mode: "edit"|"add" })
// Switches to the alchemy tab + profile mode, sets editor state, renders.
window.__srwkOpenProfile = function openProfileExternal(opts = {}) {
  const kind = (opts.kind === "team" || opts.kind === "project" || opts.kind === "person") ? opts.kind : "person";
  const mode = (opts.mode === "add") ? "add" : "edit";
  // Make sure profile state exists (may be called before alchemy mounts).
  if (!state.profile) loadProfile();
  state.profile.editKind = kind;
  state.profile.editMode = mode;
  if (mode === "edit" && opts.record_id) {
    state.profile.editTargetId = String(opts.record_id);
  } else if (mode === "add") {
    state.profile.editTargetId = null;
  }
  saveProfile();
  // Drop out of the detail page if it happens to be open.
  state.detailRecordId = null;
  state.detailReturnMode = null;
  try { localStorage.removeItem(DETAIL_LS_KEY); } catch {}
  // Switch the global tab to alchemy + alchemy mode to profile.
  state.mode = "profile";
  try { localStorage.setItem(ALCHEMY_LS_KEY, "profile"); } catch {}
  if (typeof window.__srwkGoTab === "function") {
    window.__srwkGoTab("alchemy");
  }
  // Repaint the alchemy canvas. If alchemy isn't mounted yet (very first
  // load before tab switch fires mount), the tab switch will trigger
  // loadCohort + render itself.
  if (state.mounted) {
    syncRailSelection();
    render();
  }
};

async function loadCohort() {
  state.cohort = await getCohortSurface();
}

function syncRailSelection() {
  if (!state.rail) return;
  for (const btn of state.rail.querySelectorAll(".alchemy-rail-btn")) {
    btn.setAttribute("aria-selected", btn.dataset.alchMode === state.mode ? "true" : "false");
  }
}

function render() {
  if (!state.canvas || !state.cohort) return;
  // Cross-fade: leave → swap → enter. Total ~440ms.
  const canvas = state.canvas;
  canvas.classList.remove("is-entering");
  canvas.classList.add("is-leaving");
  setTimeout(() => {
    canvas.classList.add("is-entering");
    canvas.classList.remove("is-leaving");
    // Detail page takes precedence over mode — opened by clicking a card,
    // closed by the back button (which clears state.detailRecordId).
    if (state.detailRecordId) {
      renderDetail(state.detailRecordId);
    } else if (state.mode === "feed") renderFeed();
    else if (state.mode === "shapes") renderShapes();
    else if (state.mode === "pulse") renderPulse();
    else if (state.mode === "constellation") renderConstellation();
    else if (state.mode === "profile") renderProfile();
    // Index cards for the staggered entrance.
    const cards = canvas.querySelectorAll(".alch-card, .alch-legend-card, .alch-feed-item");
    cards.forEach((c, i) => c.style.setProperty("--alch-i", String(i)));
    requestAnimationFrame(() => canvas.classList.remove("is-entering"));
    // Wire up post-render interactions per mode.
    if (!state.detailRecordId) {
      if (state.mode === "shapes") wireShapeCardClicks();
      if (state.mode === "feed") wireFeedInteractions();
      if (state.mode === "profile") wireProfileForm();
      // Kick a feed refresh on entry; the timer keeps it warm in background.
      if (state.mode === "feed") refreshFeed({ source: "mode-enter" });
      if (state.mode === "constellation") wireConstellationHover();
    }
  }, 220);
}

// Display id "SHAPE-NN" from the team's index in the array.
function displayId(idx) {
  return String(idx + 1).padStart(2, "0");
}

// ─── legend ──────────────────────────────────────────────────────────
function renderLegend() {
  const teams = state.cohort.teams;
  const counts = new Map();
  for (const t of teams) {
    if (t.is_mentor) continue;
    const s = shapeForTeam(t);
    if (!s) continue;
    counts.set(s.key, (counts.get(s.key) || 0) + 1);
  }
  const cards = SHAPES.map((s, i) => {
    const idTag = `LEGEND-${String(i + 1).padStart(2, "0")}`;
    const n = counts.get(s.key) || 0;
    const dest = SHAPE_BY_KEY[s.rotates_to];
    return `
    <article class="alch-legend-card">
      <div class="alch-card-tag">
        <span class="ct-id">${idTag}</span>
        <span class="ct-sep">·</span>
        <span>${escHtml(domainLabel(s.domain))}</span>
      </div>
      <div class="alch-card-shape alch-legend-shape">${shapeSvgByFam(s.fam, (i + 1) * 53)}</div>
      <div class="alch-legend-name">${escHtml(s.name)}</div>
      <div class="alch-card-rule"></div>
      <div class="alch-card-meta">
        <div class="alch-card-meta-row"><span class="cm-k">meaning</span><span class="cm-v">${escHtml(s.meaning)}</span></div>
        <div class="alch-card-meta-row"><span class="cm-k">in cohort</span><span class="cm-v">${n} ${n === 1 ? "team" : "teams"}</span></div>
        <div class="alch-card-meta-row"><span class="cm-k">rotates to</span><span class="cm-v alch-rotates-to"><span class="ar-arrow" aria-hidden="true">↻</span> ${escHtml(dest ? dest.name : s.rotates_to)}</span></div>
      </div>
    </article>`;
  }).join("");
  state.canvas.innerHTML = `
    <div class="alch-legend-intro">
      <h2 class="alch-legend-title">the shape rotator vocabulary</h2>
      <p class="alch-legend-sub">Six shapes. Every team enters in one and rotates through others over the program. Count is at week ${WEEK_NOW}.</p>
    </div>
    <div class="alch-legend-grid">${cards}</div>
    <p class="alch-callout"><strong>legend · v0.1</strong><br/>
    The vocabulary is fixed in <code>@shape-rotator/shape-ui</code>; each team's <code>shape</code> field defaults to its <code>domain</code> until rotation begins. <em>rotates to</em> is a tendency, not a forecast — encoded from the kickoff lopsidedness analysis (most shapes pull toward SCAFFOLD because GTM is the universal cohort gap).</p>
  `;
}

// ─── shapes (the cohort, as shapes) ──────────────────────────────────
function renderShapes() {
  const all = state.cohort.teams || [];
  // Counts go on the chips so empty filters are obvious before clicking.
  const nTeam    = all.filter(t => teamKind(t) === "team").length;
  const nProject = all.filter(t => teamKind(t) === "project").length;
  const filter = state.shapesKindFilter;
  const teams = filter === "all" ? all : all.filter(t => teamKind(t) === filter);
  const chips = `
    <nav class="alch-shapes-filter" role="tablist" aria-label="filter by kind">
      <button class="alch-shapes-chip" data-shapes-filter="all"     type="button" aria-selected="${filter === "all"}">all <span class="ascn">${all.length}</span></button>
      <button class="alch-shapes-chip" data-shapes-filter="team"    type="button" aria-selected="${filter === "team"}">teams <span class="ascn">${nTeam}</span></button>
      <button class="alch-shapes-chip" data-shapes-filter="project" type="button" aria-selected="${filter === "project"}">projects <span class="ascn">${nProject}</span></button>
    </nav>
  `;
  const cards = teams.map((t, idx) => {
    const s = shapeForTeam(t);
    const links = [];
    const gh   = t?.links?.github;
    const repo = t?.links?.repo;
    const x    = t?.links?.x;
    if (repo && GH_REPO_RE.test(repo)) {
      links.push(`<div class="alch-card-meta-row"><span class="cm-k">repo</span><span class="cm-v"><a href="https://github.com/${escHtml(repo)}" data-external class="alch-card-repo-link">${escHtml(repo)}</a></span></div>`);
    }
    if (gh) links.push(`<div class="alch-card-meta-row"><span class="cm-k">github</span><span class="cm-v"><a href="https://github.com/${escHtml(gh)}" data-external>${escHtml(gh)}</a></span></div>`);
    if (x)  links.push(`<div class="alch-card-meta-row"><span class="cm-k">x</span><span class="cm-v"><a href="https://x.com/${escHtml(x)}" data-external>@${escHtml(x)}</a></span></div>`);
    if (!gh && !x && !repo) links.push(`<div class="alch-card-meta-row"><span class="cm-k">links</span><span class="cm-v" style="opacity:0.55">— not yet submitted</span></div>`);
    const cardCls = (t.is_mentor ? "alch-card alch-card-mentor" : "alch-card") + " is-clickable";
    const dest = s ? SHAPE_BY_KEY[s.rotates_to] : null;
    const m = Number(t.members_count) || 0;
    return `
    <article class="${cardCls}" data-record-id="${escHtml(t.record_id)}" data-display-id="${displayId(idx)}" tabindex="0" role="button" aria-label="${escHtml(t.name)} — open detail">
      <div class="alch-card-tag">
        <span class="ct-id">SHAPE-${displayId(idx)}</span>
        <span class="ct-sep">·</span>
        <span class="ct-kind ct-kind-${escHtml(teamKind(t))}">${escHtml(teamKind(t))}</span>
        <span class="ct-sep">·</span>
        <span>${escHtml(s ? s.name : domainLabel(t.domain))}</span>
        <span class="ct-sep">·</span>
        <span>${escHtml(domainLabel(t.domain))}</span>
        ${t.is_mentor ? `<span class="ct-sep">·</span><span>mentor</span>` : ""}
      </div>
      <div class="alch-card-shape">${shapeSvgByFam(s ? s.fam : 0, (idx + 1) * 37)}</div>
      <div class="alch-card-name">${escHtml(t.name)}</div>
      <div class="alch-card-rule"></div>
      <div class="alch-card-meta">
        <div class="alch-card-meta-row"><span class="cm-k">focus</span><span class="cm-v">${escHtml(t.focus)}</span></div>
        <div class="alch-card-meta-row"><span class="cm-k">lead</span><span class="cm-v">${escHtml(t.lead)}</span></div>
        <div class="alch-card-meta-row"><span class="cm-k">team</span><span class="cm-v">${m} ${m === 1 ? "person" : "people"}</span></div>
        <div class="alch-card-meta-row"><span class="cm-k">geo</span><span class="cm-v">${escHtml(t.geo)}</span></div>
        ${links.join("")}
      </div>
    </article>`;
  }).join("");
  const grid = teams.length
    ? `<div class="alch-specimens">${cards}</div>`
    : `<p class="alch-pf-pick">no ${escHtml(filter)} records yet — switch to the <strong>profile</strong> tab and use <strong>add</strong> to create one.</p>`;
  state.canvas.innerHTML = `
    ${chips}
    ${grid}
    <p class="alch-callout"><strong>shapes · v0.1</strong><br/>
    Each card is a team or project in its current shape (week ${WEEK_NOW}). At week 1 every record sits in its starting shape — the one inherited from its domain skillset. See <strong>legend</strong> for the full vocabulary.</p>
  `;
  // Wire the kind filter chips.
  for (const btn of state.canvas.querySelectorAll(".alch-shapes-chip[data-shapes-filter]")) {
    btn.addEventListener("click", () => {
      const next = btn.dataset.shapesFilter;
      if (next === state.shapesKindFilter) return;
      state.shapesKindFilter = next;
      renderShapes();
    });
  }
}

// ─── pulse ───────────────────────────────────────────────────────────
function renderPulse() {
  const teams = state.cohort.teams;
  const weekHeaders = Array.from({ length: WEEKS_TOTAL }, (_, i) =>
    `<span>w${String(i + 1).padStart(2, "0")}</span>`).join("");
  const rows = teams.map((t, idx) => {
    const bars = Array.from({ length: WEEKS_TOTAL }, (_, i) => {
      const week = i + 1;
      const v = pulseValue(t.record_id || displayId(idx), week);
      const future = week > WEEK_NOW;
      const isNow = week === WEEK_NOW;
      const height = future ? 4 : Math.max(6, Math.round(v * 44));
      const opacity = future ? 0.20 : 1;
      const cls = isNow ? "alch-pulse-bar is-now" : "alch-pulse-bar";
      const label = future ? `w${week}: future` : `w${week}: ${Math.round(v * 100)} units`;
      return `<div class="${cls}" style="height:${height}px;opacity:${opacity}" title="${escHtml(t.name)} — ${escHtml(label)}"></div>`;
    }).join("");
    return `
      <div class="alch-pulse-row">
        <div class="alch-pulse-name">
          <span class="alch-pulse-name-tag">SPC-${displayId(idx)}</span>
          ${escHtml(t.name)}
        </div>
        <div class="alch-pulse-bars">${bars}</div>
      </div>
    `;
  }).join("");
  state.canvas.innerHTML = `
    <div class="alch-pulse">
      <div class="alch-pulse-axis">
        <span>team / activity</span>
        <div class="alch-pulse-axis-weeks">${weekHeaders}</div>
      </div>
      ${rows}
    </div>
    <p class="alch-callout"><strong>pulse · v0.1</strong><br/>
    Per-team weekly activity. Bars are seeded-random for now — wire real signals (commits, posts, peer-search hits) by replacing <code>pulseValue()</code>. The cyan bar marks the current cohort week (w${String(WEEK_NOW).padStart(2, "0")}).</p>
  `;
}

// Stable hash from (key, week) → 0..1. No PRNG state; deterministic.
function pulseValue(key, week) {
  let t = (hashStr(String(key)) >>> 0) ^ (week * 31);
  t += 0x6D2B79F5;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return (((t ^ (t >>> 14)) >>> 0) % 10000) / 10000;
}
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h;
}

// ─── constellation ───────────────────────────────────────────────────
function renderConstellation() {
  const teams = state.cohort.teams;
  const clusters = state.cohort.clusters;

  const W = 980, H = 540, CX = W / 2, CY = H / 2, R = 215;
  const byRecordId = new Map(teams.map(t => [t.record_id, t]));
  const positions = teams.map((t, i) => {
    const a = (i / teams.length) * Math.PI * 2 - Math.PI / 2;
    return { t, x: CX + Math.cos(a) * R, y: CY + Math.sin(a) * R };
  });
  const posByRecordId = new Map(positions.map(p => [p.t.record_id, p]));

  const edges = [];
  for (const cl of clusters) {
    const present = (cl.teams || []).filter(rid => byRecordId.has(rid));
    for (let i = 0; i < present.length; i++) {
      for (let j = i + 1; j < present.length; j++) {
        const a = posByRecordId.get(present[i]);
        const b = posByRecordId.get(present[j]);
        if (a && b) edges.push({ a, b, cluster: cl });
      }
    }
  }
  const dup = new Map();
  for (const e of edges) {
    const k = [e.a.t.record_id, e.b.t.record_id].sort().join("→");
    e._dupKey = k;
    e._dupIdx = (dup.get(k) || 0);
    dup.set(k, e._dupIdx + 1);
  }
  const dupTotal = new Map(dup);

  const edgeMarkup = edges.map(e => {
    const total = dupTotal.get(e._dupKey) || 1;
    const offset = (e._dupIdx - (total - 1) / 2) * 4;
    const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y;
    const len = Math.hypot(dx, dy) || 1;
    const px = -dy / len * offset, py = dx / len * offset;
    const cls = `ac-edge ac-edge-${e.cluster.record_id || e.cluster.name || "x"}`;
    return `<line class="${cls}" data-a="${escHtml(e.a.t.record_id)}" data-b="${escHtml(e.b.t.record_id)}"
      x1="${(e.a.x + px).toFixed(1)}" y1="${(e.a.y + py).toFixed(1)}"
      x2="${(e.b.x + px).toFixed(1)}" y2="${(e.b.y + py).toFixed(1)}"/>`;
  }).join("");

  const nodeMarkup = positions.map(({ t, x, y }) => `
    <g class="ac-node-group" data-record-id="${escHtml(t.record_id)}" transform="translate(${x.toFixed(1)},${y.toFixed(1)})">
      <circle class="ac-node-shape ${t.is_mentor ? "ac-node-mentor" : ""}" r="9"/>
      <text class="ac-node-label" y="26" text-anchor="middle">${escHtml(t.name)}</text>
    </g>`).join("");

  const legend = clusters.map(cl => `
    <span class="acl-item"><span class="acl-swatch acl-swatch-${escHtml(cl.record_id)}"></span>${escHtml(cl.label)}</span>
  `).join("");

  state.canvas.innerHTML = `
    <div class="alch-constellation">
      <div class="alch-constellation-stage">
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
          ${edgeMarkup}
          ${nodeMarkup}
        </svg>
      </div>
      <div class="alch-constellation-legend">${legend}</div>
      <p class="alch-callout"><strong>constellation · v0.1</strong><br/>
      Edges are the synergy clusters from the cohort surface data — every pair of teams that share a cluster gets one line per cluster (so Conclave, which sits in three, fans out). Mentor cards are rendered hollow.</p>
    </div>
  `;
}

function escHtml(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ─── shape card → drawer ─────────────────────────────────────────────
function wireShapeCardClicks() {
  const cards = state.canvas.querySelectorAll(".alch-card[data-record-id]");
  for (const card of cards) {
    card.addEventListener("click", () => openDetail(card.dataset.recordId));
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openDetail(card.dataset.recordId);
      }
    });
  }
  // External links inside the cards (repo / github / x) — route through
  // shell.openExternal and stop the click bubbling to the card.
  wireExternalLinks(state.canvas);
}

function openDetail(recordId) {
  if (!recordId) return;
  state.detailRecordId = String(recordId);
  // Remember where to land on back — usually shapes, but if user opened
  // the detail from a different mode (future entry points) honor that.
  state.detailReturnMode = state.mode || "shapes";
  try {
    localStorage.setItem(DETAIL_LS_KEY, JSON.stringify({
      recordId: state.detailRecordId,
      returnMode: state.detailReturnMode,
    }));
  } catch {}
  render();
  // Scroll the canvas to the top so the hero is in view.
  try { state.canvas?.scrollTo({ top: 0, behavior: "auto" }); } catch {}
}

function closeDetail() {
  state.detailRecordId = null;
  if (state.detailReturnMode) state.mode = state.detailReturnMode;
  state.detailReturnMode = null;
  try { localStorage.removeItem(DETAIL_LS_KEY); } catch {}
  try { localStorage.setItem(ALCHEMY_LS_KEY, state.mode); } catch {}
  syncRailSelection();
  render();
}

// ─── constellation hover ─────────────────────────────────────────────
function wireConstellationHover() {
  const stage = state.canvas.querySelector(".alch-constellation-stage");
  if (!stage) return;
  const groups = stage.querySelectorAll(".ac-node-group");
  for (const g of groups) {
    const rid = g.dataset.recordId;
    g.addEventListener("mouseenter", () => setConstellationHover(stage, rid, true));
    g.addEventListener("mouseleave", () => setConstellationHover(stage, rid, false));
    g.addEventListener("click", () => openDrawer(rid));
  }
}
function setConstellationHover(stage, recordId, on) {
  if (!on) {
    stage.removeAttribute("data-hover-active");
    stage.querySelectorAll(".ac-edge.is-hot").forEach(e => e.classList.remove("is-hot"));
    stage.querySelectorAll(".ac-node-group.is-related").forEach(e => e.classList.remove("is-related"));
    return;
  }
  stage.setAttribute("data-hover-active", "true");
  // light up edges touching this node, collect related nodes.
  const related = new Set();
  stage.querySelectorAll(".ac-edge").forEach(edge => {
    const a = edge.dataset.a, b = edge.dataset.b;
    if (a === recordId || b === recordId) {
      edge.classList.add("is-hot");
      related.add(a); related.add(b);
    } else {
      edge.classList.remove("is-hot");
    }
  });
  stage.querySelectorAll(".ac-node-group").forEach(g => {
    const rid = g.dataset.recordId;
    if (related.has(rid) && rid !== recordId) g.classList.add("is-related");
    else g.classList.remove("is-related");
  });
}

// ─── detail page (full-canvas team / project profile) ────────────────
// Replaces the side drawer for a roomier read. Same data, more space:
// hero (shape glyph + name + kind), about, credentials, links, members,
// synergy clusters. Entered by clicking a card; back button returns to
// the previous mode (typically shapes).
function renderDetail(recordId) {
  const team = state.cohort?.teams.find(t => t.record_id === recordId);
  if (!team) {
    // Record vanished (e.g. cohort republished, slug changed). Bail out
    // back to the grid rather than showing an empty page.
    closeDetail();
    return;
  }
  const s = shapeForTeam(team);
  const kind = teamKind(team);
  const m = Number(team.members_count) || 0;
  const memberClusters = (state.cohort.clusters || []).filter(cl =>
    Array.isArray(cl.teams) && cl.teams.includes(recordId)
  );
  // People whose `team` field points at this record. For projects this
  // surfaces who's working on it; for teams, the roster.
  const teamPeople = (state.cohort.people || []).filter(p => p.team === recordId);

  const linksRow = renderDetailLinks(team.links || {});
  const editUrl = `https://github.com/dmarzzz/shape-rotator-field-guide/edit/main/cohort-data/teams/${encodeURIComponent(recordId)}.md?quick_pull=1`;

  state.canvas.innerHTML = `
    <header class="alch-detail-bar">
      <button class="alch-detail-back" type="button" id="alch-detail-back" aria-label="back to grid">
        <span aria-hidden="true">←</span>
        <span>back</span>
      </button>
      <div class="alch-detail-bar-tag">
        <span>${escHtml(team.record_id.toUpperCase())}</span>
        <span class="ct-sep">·</span>
        <span class="ct-kind ct-kind-${escHtml(kind)}">${escHtml(kind)}</span>
        ${team.is_mentor ? `<span class="ct-sep">·</span><span>mentor</span>` : ""}
      </div>
      <a href="${escHtml(editUrl)}" data-external class="alch-detail-edit" title="edit this record on github">edit on github →</a>
    </header>

    <section class="alch-detail-hero">
      <div class="alch-detail-shape">${s ? shapeSvgByFam(s.fam, hashStr(team.record_id)) : ""}</div>
      <div class="alch-detail-hero-text">
        <h2 class="alch-detail-name">${escHtml(team.name)}</h2>
        <p class="alch-detail-focus">${escHtml(team.focus || "—")}</p>
        <div class="alch-detail-meta">
          <span><span class="adm-k">shape</span> ${escHtml(s ? s.name : "—")}</span>
          <span class="ct-sep">·</span>
          <span><span class="adm-k">domain</span> ${escHtml(domainLabel(team.domain))}</span>
          <span class="ct-sep">·</span>
          <span><span class="adm-k">${kind === "project" ? "contributors" : "team"}</span> ${m} ${m === 1 ? "person" : "people"}</span>
          <span class="ct-sep">·</span>
          <span><span class="adm-k">geo</span> ${escHtml(team.geo || "—")}</span>
        </div>
      </div>
    </section>

    <div class="alch-detail-grid">
      <section class="alch-detail-section">
        <h3 class="alch-detail-h">about</h3>
        <div class="alch-detail-row"><span class="adr-k">lead</span><span class="adr-v">${escHtml(team.lead || "—")}</span></div>
        ${team.traction ? `<div class="alch-detail-row"><span class="adr-k">traction</span><span class="adr-v">${escHtml(team.traction)}</span></div>` : ""}
      </section>

      ${(team.paper_basis || team.hackathon_note) ? `
        <section class="alch-detail-section">
          <h3 class="alch-detail-h">credentials</h3>
          ${team.paper_basis  ? `<div class="alch-detail-row"><span class="adr-k">paper</span><span class="adr-v">${escHtml(team.paper_basis)}</span></div>`  : ""}
          ${team.hackathon_note ? `<div class="alch-detail-row"><span class="adr-k">hackathon</span><span class="adr-v"><span style="color:var(--alchemy-oxide-bright)">★</span> ${escHtml(team.hackathon_note)}</span></div>` : ""}
        </section>
      ` : ""}

      <section class="alch-detail-section">
        <h3 class="alch-detail-h">links</h3>
        ${linksRow}
      </section>

      ${teamPeople.length ? `
        <section class="alch-detail-section">
          <h3 class="alch-detail-h">${kind === "project" ? "contributors" : "members"} <span class="alch-profile-h-aux">— ${teamPeople.length}</span></h3>
          <ul class="alch-detail-people">
            ${teamPeople.map(p => `
              <li class="alch-detail-person" data-person="${escHtml(p.record_id)}">
                <span class="adp-name">${escHtml(p.name || p.record_id)}</span>
                ${p.role ? `<span class="adp-role">${escHtml(p.role)}</span>` : ""}
              </li>
            `).join("")}
          </ul>
        </section>
      ` : ""}

      ${memberClusters.length ? `
        <section class="alch-detail-section">
          <h3 class="alch-detail-h">synergy clusters</h3>
          <div class="alch-detail-clusters">
            ${memberClusters.map(cl => `
              <span class="alch-detail-cluster">${escHtml(cl.label)}</span>
            `).join("")}
          </div>
        </section>
      ` : ""}
    </div>
  `;

  // Wire interactions.
  state.canvas.querySelector("#alch-detail-back")?.addEventListener("click", closeDetail);
  wireExternalLinks(state.canvas);
}

function renderDetailLinks(L) {
  const LINK_LABELS = {
    website: "website", demo: "demo", deck: "deck", repo: "repo",
    article: "article", slides: "slides", alt: "alt site",
  };
  const rows = [];
  if (L.repo && GH_REPO_RE.test(String(L.repo))) {
    rows.push(`<div class="alch-detail-row"><span class="adr-k">repo</span><span class="adr-v"><a href="https://github.com/${escHtml(L.repo)}" data-external class="alch-card-repo-link">${escHtml(L.repo)}</a></span></div>`);
  }
  if (L.github) {
    const gh = String(L.github);
    const url = gh.startsWith("http") ? gh : `https://github.com/${gh}`;
    rows.push(`<div class="alch-detail-row"><span class="adr-k">github</span><span class="adr-v"><a href="${escHtml(url)}" data-external>${escHtml(gh)}</a></span></div>`);
  }
  if (L.x) {
    const handle = String(L.x).replace(/^@/, "");
    rows.push(`<div class="alch-detail-row"><span class="adr-k">x</span><span class="adr-v"><a href="https://x.com/${escHtml(handle)}" data-external>@${escHtml(handle)}</a></span></div>`);
  }
  for (const k of Object.keys(L)) {
    if (k === "github" || k === "x" || k === "repo") continue;
    const v = L[k];
    if (!v) continue;
    const label = LINK_LABELS[k] || k;
    const display = (typeof v === "string") ? v.replace(/^https?:\/\//, "") : String(v);
    rows.push(`<div class="alch-detail-row"><span class="adr-k">${escHtml(label)}</span><span class="adr-v"><a href="${escHtml(v)}" data-external>${escHtml(display)}</a></span></div>`);
  }
  if (rows.length === 0) rows.push(`<div class="alch-detail-row"><span class="adr-k">links</span><span class="adr-v" style="opacity:0.55">— not yet submitted</span></div>`);
  return rows.join("");
}

// ─── drawer (specimen detail) ────────────────────────────────────────
function openDrawer(recordId) {
  if (!state.cohort) return;
  const team = state.cohort.teams.find(t => t.record_id === recordId);
  if (!team) return;

  const { backdrop, drawer, body } = ensureDrawer();
  const s = shapeForTeam(team);
  const dest = s ? SHAPE_BY_KEY[s.rotates_to] : null;
  const m = Number(team.members_count) || 0;

  // Find which clusters this team belongs to
  const memberClusters = (state.cohort.clusters || []).filter(cl =>
    Array.isArray(cl.teams) && cl.teams.includes(recordId)
  );

  // Render every available link key with a sensible label; github + x
  // get full URL prefixes, the rest are passed through.
  const LINK_LABELS = {
    website: "website", demo: "demo", deck: "deck", repo: "repo",
    article: "article", slides: "slides", alt: "alt site",
  };
  const linksRow = (() => {
    const rows = [];
    const L = team.links || {};
    if (L.github) {
      // Treat as github user/org if no slash; as path otherwise.
      const gh = String(L.github);
      const url = gh.startsWith("http") ? gh : `https://github.com/${gh}`;
      rows.push(`<div class="alch-drawer-row"><span class="dr-k">github</span><span class="dr-v"><a href="${escHtml(url)}" data-external>${escHtml(gh)}</a></span></div>`);
    }
    if (L.x) {
      const handle = String(L.x).replace(/^@/, "");
      rows.push(`<div class="alch-drawer-row"><span class="dr-k">x</span><span class="dr-v"><a href="https://x.com/${escHtml(handle)}" data-external>@${escHtml(handle)}</a></span></div>`);
    }
    for (const k of Object.keys(L)) {
      if (k === "github" || k === "x") continue;
      const v = L[k];
      if (!v) continue;
      const label = LINK_LABELS[k] || k;
      const display = (typeof v === "string") ? v.replace(/^https?:\/\//, "") : String(v);
      rows.push(`<div class="alch-drawer-row"><span class="dr-k">${escHtml(label)}</span><span class="dr-v"><a href="${escHtml(v)}" data-external>${escHtml(display)}</a></span></div>`);
    }
    if (rows.length === 0) rows.push(`<div class="alch-drawer-row"><span class="dr-k">links</span><span class="dr-v muted">— not yet submitted</span></div>`);
    return rows.join("");
  })();

  const tagBits = [
    `<span class="dt-id">${escHtml(team.record_id.toUpperCase())}</span>`,
    `<span>·</span>`,
    `<span>${escHtml(s ? s.name : domainLabel(team.domain))}</span>`,
    `<span>·</span>`,
    `<span>${escHtml(domainLabel(team.domain))}</span>`,
  ];
  if (team.is_mentor) {
    tagBits.push(`<span>·</span>`, `<span>mentor</span>`);
  }

  body.innerHTML = `
    <div class="alch-drawer-tag">${tagBits.join("")}</div>
    <div class="alch-drawer-name">${escHtml(team.name)}</div>
    <div class="alch-drawer-shape">${s ? shapeSvgByFam(s.fam, hashStr(team.record_id)) : ""}</div>
    <div class="alch-drawer-rule"></div>
    <section class="alch-drawer-section">
      <h4>about</h4>
      <div class="alch-drawer-row"><span class="dr-k">focus</span><span class="dr-v">${escHtml(team.focus || "—")}</span></div>
      <div class="alch-drawer-row"><span class="dr-k">lead</span><span class="dr-v">${escHtml(team.lead || "—")}</span></div>
      <div class="alch-drawer-row"><span class="dr-k">team</span><span class="dr-v">${m} ${m === 1 ? "person" : "people"}</span></div>
      <div class="alch-drawer-row"><span class="dr-k">geo</span><span class="dr-v">${escHtml(team.geo || "—")}</span></div>
      ${team.traction ? `<div class="alch-drawer-row"><span class="dr-k">traction</span><span class="dr-v">${escHtml(team.traction)}</span></div>` : ""}
    </section>
    ${team.paper_basis || team.hackathon_note ? `
      <section class="alch-drawer-section">
        <h4>credentials</h4>
        ${team.paper_basis  ? `<div class="alch-drawer-row"><span class="dr-k">paper</span><span class="dr-v">${escHtml(team.paper_basis)}</span></div>`  : ""}
        ${team.hackathon_note ? `<div class="alch-drawer-row"><span class="dr-k">hackathon</span><span class="dr-v"><span style="color:var(--alchemy-oxide-bright)">★</span> ${escHtml(team.hackathon_note)}</span></div>` : ""}
      </section>
    ` : ""}
    <section class="alch-drawer-section">
      <h4>links</h4>
      ${linksRow}
    </section>
    ${memberClusters.length ? `
      <section class="alch-drawer-section">
        <h4>synergy clusters</h4>
        <div class="alch-drawer-clusters">
          ${memberClusters.map(cl => `
            <span class="alch-drawer-cluster" data-cluster="${escHtml(cl.record_id)}">${escHtml(cl.label)}</span>
          `).join("")}
        </div>
      </section>
    ` : ""}
  `;
  // Open external links via the Electron shell, not in-window.
  for (const a of body.querySelectorAll("a[data-external]")) {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const url = a.getAttribute("href");
      if (url) try { window.api?.openExternal?.(url); } catch {}
    });
  }
  drawer.querySelector(".alch-drawer-tag-host")?.replaceChildren();
  // Open with a frame delay so the transition fires.
  requestAnimationFrame(() => {
    backdrop.classList.add("is-open");
    drawer.classList.add("is-open");
  });
}

function closeDrawer() {
  const backdrop = document.querySelector(".alch-drawer-backdrop");
  const drawer = document.querySelector(".alch-drawer");
  if (backdrop) backdrop.classList.remove("is-open");
  if (drawer) drawer.classList.remove("is-open");
}

let _drawerNodes = null;
function ensureDrawer() {
  if (_drawerNodes) return _drawerNodes;
  const backdrop = document.createElement("div");
  backdrop.className = "alch-drawer-backdrop";
  backdrop.addEventListener("click", closeDrawer);
  document.body.appendChild(backdrop);

  const drawer = document.createElement("aside");
  drawer.className = "alch-drawer";
  drawer.setAttribute("aria-label", "team detail");
  drawer.innerHTML = `
    <header class="alch-drawer-head">
      <div class="alch-drawer-tag-host"></div>
      <button class="alch-drawer-close" type="button" title="close (esc)">close</button>
    </header>
    <div class="alch-drawer-body"></div>
  `;
  drawer.querySelector(".alch-drawer-close").addEventListener("click", closeDrawer);
  document.body.appendChild(drawer);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && drawer.classList.contains("is-open")) closeDrawer();
  });

  _drawerNodes = { backdrop, drawer, body: drawer.querySelector(".alch-drawer-body") };
  return _drawerNodes;
}

// ─── profile (localStorage; cohort-data write-back is Phase 4) ───────
function defaultProfile() {
  return {
    // Local "me" preferences. Used to seed the person-edit form when
    // creating a new person record. Not the same as the published record.
    user: { team_id: null, name: "", github: "", website: "", x: "" },
    // Editor state for the team/project/person editor (UI-only, not published).
    // editMode flips between "add" (blank form → /new/ URL) and "edit"
    // (record picker → /edit/ URL + diff panel).
    editMode: "edit",                          // "add" | "edit"
    editKind: "team",                          // "team" | "project" | "person"
    editTargetId: null,                        // <slug>; null in add mode or before pick
  };
}
function loadProfile() {
  let raw = null;
  try { raw = localStorage.getItem(PROFILE_LS_KEY); } catch {}
  if (raw) {
    try {
      state.profile = { ...defaultProfile(), ...JSON.parse(raw) };
      // Drop legacy fields that no longer exist on the profile shape.
      // trackedRepos was the private feed-watch list; replaced by every
      // team's canonical links.repo in the cohort.surface bundle.
      delete state.profile.trackedRepos;
      // Migrate old state: editTargetId="_new_" (person) was the prior
      // way to signal a create flow; consolidate under editMode="add".
      if (state.profile.editTargetId === "_new_") {
        state.profile.editMode = "add";
        state.profile.editTargetId = null;
      }
      return;
    } catch {}
  }
  state.profile = defaultProfile();
}
function saveProfile() {
  try { localStorage.setItem(PROFILE_LS_KEY, JSON.stringify(state.profile)); } catch {}
}
function loadEventsCache() {
  let raw = null;
  try { raw = localStorage.getItem(EVENTS_LS_KEY); } catch {}
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.items)) {
        state.events = parsed.items;
        state.fetchedAt = Number(parsed.fetchedAt) || 0;
      }
    } catch {}
  }
}
function saveEventsCache() {
  try {
    localStorage.setItem(EVENTS_LS_KEY, JSON.stringify({
      fetchedAt: state.fetchedAt,
      items: state.events.slice(0, 200),  // cap cache
    }));
  } catch {}
}

// ─── github scraper ─────────────────────────────────────────────────
// Fetch /events for each tracked repo, normalize into feed items.
// Unauthenticated; the cohort fits within the 60-req/hr budget.
const GH_REPO_RE = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;

async function refreshFeed({ source = "auto", force = false } = {}) {
  if (state.isFetching) return;
  const fresh = Date.now() - state.fetchedAt < FEED_REFRESH_MS;
  if (fresh && !force && state.events.length > 0) {
    paintFeedMeta();
    return;
  }
  // Single source: every team's canonical `links.repo` from the
  // cohort.surface bundle. Dedupe by repo string in case two teams
  // ever share a monorepo.
  const seen = new Set();
  const repos = [];
  for (const t of state.cohort?.teams || []) {
    const repo = String(t?.links?.repo || "").trim();
    if (!GH_REPO_RE.test(repo) || seen.has(repo)) continue;
    seen.add(repo);
    repos.push({ team_id: t.record_id, repo });
  }
  if (repos.length === 0) { paintFeedMeta(); return; }
  state.isFetching = true;
  paintFeedMeta(`fetching · ${repos.length} repos · ${source}`);
  const collected = [];
  for (const { team_id, repo } of repos) {
    try {
      const items = await fetchGithubRepoEvents(repo, team_id);
      collected.push(...items);
    } catch (e) {
      console.warn(`[alch.feed] github fetch ${repo}:`, e?.message || e);
    }
  }
  // Merge with existing cache, dedupe by id, sort latest-first, cap.
  const byId = new Map();
  for (const it of [...collected, ...state.events]) {
    if (!byId.has(it.id)) byId.set(it.id, it);
  }
  state.events = Array.from(byId.values()).sort((a, b) => (b.at_ms || 0) - (a.at_ms || 0)).slice(0, 200);
  state.fetchedAt = Date.now();
  state.isFetching = false;
  saveEventsCache();
  if (state.mode === "feed") {
    renderFeed();
    wireFeedInteractions();
  }
}

async function fetchGithubRepoEvents(repo, team_id) {
  const url = `https://api.github.com/repos/${repo}/events?per_page=20`;
  const r = await fetch(url, { headers: { Accept: "application/vnd.github+json" } });
  if (!r.ok) {
    if (r.status === 404 || r.status === 403) return [];
    throw new Error(`HTTP ${r.status}`);
  }
  const evs = await r.json();
  if (!Array.isArray(evs)) return [];
  return evs.map(ev => normalizeGithubEvent(ev, repo, team_id)).filter(Boolean);
}

function normalizeGithubEvent(ev, repo, team_id) {
  const id = `gh:${ev.id || `${repo}:${ev.created_at}:${ev.type}`}`;
  const at_ms = ev.created_at ? Date.parse(ev.created_at) : Date.now();
  const actor = ev.actor?.login || "—";
  const url = githubEventUrl(ev, repo);
  let summary;
  switch (ev.type) {
    case "PushEvent": {
      const n = ev.payload?.commits?.length || ev.payload?.size || 0;
      const branch = (ev.payload?.ref || "").replace(/^refs\/heads\//, "") || "main";
      const commits = ev.payload?.commits || [];
      const firstMsg = commits[0]?.message?.split("\n")[0] || "";
      summary = `pushed ${n} commit${n === 1 ? "" : "s"} to ${branch}${firstMsg ? ` — ${firstMsg}` : ""}`;
      break;
    }
    case "PullRequestEvent": {
      const action = ev.payload?.action;
      const num = ev.payload?.number;
      const title = ev.payload?.pull_request?.title || "";
      const verb = action === "closed" && ev.payload?.pull_request?.merged ? "merged" : action;
      summary = `${verb} PR #${num}${title ? ` — ${title}` : ""}`;
      break;
    }
    case "PullRequestReviewEvent": {
      const num = ev.payload?.pull_request?.number;
      summary = `reviewed PR #${num}`;
      break;
    }
    case "IssuesEvent": {
      const action = ev.payload?.action;
      const num = ev.payload?.issue?.number;
      const title = ev.payload?.issue?.title || "";
      summary = `${action} issue #${num}${title ? ` — ${title}` : ""}`;
      break;
    }
    case "IssueCommentEvent": {
      const num = ev.payload?.issue?.number;
      summary = `commented on #${num}`;
      break;
    }
    case "CreateEvent": {
      const refType = ev.payload?.ref_type;
      const ref = ev.payload?.ref;
      summary = `created ${refType}${ref ? ` ${ref}` : ""}`;
      break;
    }
    case "DeleteEvent": {
      const refType = ev.payload?.ref_type;
      const ref = ev.payload?.ref;
      summary = `deleted ${refType}${ref ? ` ${ref}` : ""}`;
      break;
    }
    case "ReleaseEvent": {
      const tag = ev.payload?.release?.tag_name || "";
      summary = `released ${tag}`;
      break;
    }
    case "ForkEvent": summary = "forked the repo"; break;
    case "WatchEvent": summary = "starred the repo"; break;
    case "PublicEvent": summary = "made the repo public"; break;
    case "MemberEvent": summary = `added ${ev.payload?.member?.login || "a member"}`; break;
    default: return null; // skip uninteresting types
  }
  return { id, source: "github", repo, team_id, type: ev.type, actor, at_ms, summary, url };
}

function githubEventUrl(ev, repo) {
  switch (ev.type) {
    case "PushEvent": {
      const head = ev.payload?.head;
      return head ? `https://github.com/${repo}/commit/${head}` : `https://github.com/${repo}/commits`;
    }
    case "PullRequestEvent":       return ev.payload?.pull_request?.html_url || `https://github.com/${repo}/pulls`;
    case "PullRequestReviewEvent": return ev.payload?.pull_request?.html_url || `https://github.com/${repo}/pulls`;
    case "IssuesEvent":            return ev.payload?.issue?.html_url || `https://github.com/${repo}/issues`;
    case "IssueCommentEvent":      return ev.payload?.comment?.html_url || `https://github.com/${repo}/issues`;
    case "ReleaseEvent":           return ev.payload?.release?.html_url || `https://github.com/${repo}/releases`;
    default:                       return `https://github.com/${repo}`;
  }
}

// ─── feed renderer ───────────────────────────────────────────────────
function teamByRecordId(rid) {
  return (state.cohort?.teams || []).find(t => t.record_id === rid) || null;
}
function teamLabel(rid) {
  const t = teamByRecordId(rid);
  return t ? t.name : rid || "—";
}
function relativeTime(ms) {
  const diff = Date.now() - ms;
  if (!Number.isFinite(diff)) return "—";
  const s = Math.max(0, Math.round(diff / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}
function feedSourceGlyph(src) {
  return src === "github" ? "◇" : src === "transcript" ? "❍" : "·";
}

function renderFeed() {
  // Repos are the cohort's: every team with a valid links.repo.
  const repos = (state.cohort?.teams || []).filter(t => GH_REPO_RE.test(String(t?.links?.repo || "").trim()));
  const items = state.events;
  const head = `
    <header class="alch-feed-head">
      <div>
        <h2 class="alch-feed-title">recent activity</h2>
        <p class="alch-feed-sub" id="alch-feed-meta"></p>
      </div>
      <div class="alch-feed-actions">
        <button id="alch-feed-refresh" class="alch-feed-btn" type="button" title="re-fetch from github">
          <span aria-hidden="true">↻</span>
          <span>refresh</span>
        </button>
      </div>
    </header>
  `;
  let body;
  if (repos.length === 0) {
    body = `
      <div class="alch-feed-empty">
        <div class="alch-feed-empty-glyph" aria-hidden="true">◇</div>
        <div class="alch-feed-empty-title">no repos tracked yet</div>
        <div class="alch-feed-empty-sub">
          go to <button class="alch-link-btn" data-go="profile">profile</button> to register
          your team's github repos. activity will populate here within a few seconds.
        </div>
      </div>
    `;
  } else if (items.length === 0) {
    body = `
      <div class="alch-feed-empty">
        <div class="alch-feed-empty-glyph" aria-hidden="true">⊙</div>
        <div class="alch-feed-empty-title">tracking ${repos.length} ${repos.length === 1 ? "repo" : "repos"} · no events yet</div>
        <div class="alch-feed-empty-sub">github is being polled. fresh activity shows up here.</div>
      </div>
    `;
  } else {
    body = `<ul class="alch-feed-list">${items.map(renderFeedItem).join("")}</ul>`;
    body += `
      <p class="alch-callout"><strong>feed · v0.1</strong><br/>
      Github events from your registered repos. Transcripts join the feed once swf-node's
      hivemind sink lands (issue #93). Add or remove repos in the <strong>profile</strong> tab.</p>
    `;
  }
  state.canvas.innerHTML = head + body;
  paintFeedMeta();
}

function renderFeedItem(ev) {
  const teamName = teamLabel(ev.team_id);
  const sourceClass = `is-${ev.source}`;
  return `
    <li class="alch-feed-item ${sourceClass}" data-event-id="${escHtml(ev.id)}" data-url="${escHtml(ev.url || "")}">
      <div class="alch-feed-glyph" aria-hidden="true">${feedSourceGlyph(ev.source)}</div>
      <div class="alch-feed-body">
        <div class="alch-feed-headline">
          <span class="alch-feed-team">${escHtml(teamName)}</span>
          <span class="alch-feed-sep">·</span>
          <span class="alch-feed-repo">${escHtml(ev.repo || "")}</span>
        </div>
        <div class="alch-feed-summary">
          <span class="alch-feed-actor">${escHtml(ev.actor || "")}</span>
          <span class="alch-feed-action">${escHtml(ev.summary || "")}</span>
        </div>
      </div>
      <div class="alch-feed-time" title="${escHtml(new Date(ev.at_ms).toLocaleString())}">${escHtml(relativeTime(ev.at_ms))}</div>
    </li>
  `;
}

function paintFeedMeta(override) {
  const meta = document.getElementById("alch-feed-meta");
  if (!meta) return;
  const repos = (state.cohort?.teams || []).filter(t => GH_REPO_RE.test(String(t?.links?.repo || "").trim())).length;
  if (override) { meta.textContent = override; return; }
  if (state.isFetching) {
    meta.textContent = `fetching…`;
  } else if (state.fetchedAt > 0) {
    meta.textContent = `${state.events.length} events · ${repos} ${repos === 1 ? "repo" : "repos"} tracked · last fetched ${relativeTime(state.fetchedAt)}`;
  } else {
    meta.textContent = `${repos} ${repos === 1 ? "repo" : "repos"} tracked · waiting on first fetch`;
  }
}

function wireFeedInteractions() {
  const refreshBtn = document.getElementById("alch-feed-refresh");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => refreshFeed({ source: "manual", force: true }));
  }
  for (const item of state.canvas.querySelectorAll(".alch-feed-item[data-url]")) {
    const url = item.dataset.url;
    if (!url) continue;
    item.style.cursor = "pointer";
    item.addEventListener("click", () => {
      try { window.api?.openExternal?.(url); } catch {}
    });
    item.tabIndex = 0;
    item.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        try { window.api?.openExternal?.(url); } catch {}
      }
    });
  }
  // Empty-state link → switch to profile tab.
  for (const link of state.canvas.querySelectorAll(".alch-link-btn[data-go='profile']")) {
    link.addEventListener("click", () => {
      state.mode = "profile";
      try { localStorage.setItem(ALCHEMY_LS_KEY, "profile"); } catch {}
      syncRailSelection();
      render();
    });
  }
  // (timer is mounted globally in mount())
}

// ─── profile renderer ────────────────────────────────────────────────
// Two editing modes:
//   • team   — pick an existing team, edit its surface fields. Submit
//              opens github's /edit/ URL + shows a diff panel since
//              github web editor doesn't accept pre-filled content for
//              existing files. User makes the listed changes manually.
//   • person — pick an existing person OR create new. New uses /new/
//              with prefilled content (one-click); existing uses
//              /edit/ + diff panel like teams.
//
// editDraft is the in-progress edit; editBaseline is what was loaded
// (so we can compute a diff of just the changed fields).

// Team and project share the same frontmatter shape, so they share the
// same field list — but copy that says "team name" or "members on the
// team" reads wrong in the project editor. teamFieldsFor(kind) returns
// the same fields with kind-aware placeholders + labels.
function teamFieldsFor(kind) {
  const isProject = kind === "project";
  return [
    { key: "name",            label: "name",            type: "text",     placeholder: isProject ? "project name" : "team name" },
    { key: "focus",           label: "focus",           type: "text",     placeholder: isProject ? "what it does, in one line" : "what you're building, in one line" },
    { key: "lead",            label: "lead",            type: "text",     placeholder: isProject ? "owner / maintainer" : "primary point of contact" },
    { key: "members_count",   label: isProject ? "contributors" : "members", type: "number", placeholder: isProject ? "how many people work on it" : "how many on the team" },
    { key: "geo",             label: "geo",             type: "text",     placeholder: "NYC, etc." },
    { key: "domain",          label: "domain",          type: "select",   options: ["crypto", "tee", "ai", "app-ux", "bd-gtm", "design"] },
    { key: "shape",           label: "shape",           type: "select",   options: ["torus", "hex", "prism", "meridian", "scaffold", "plate"] },
    { key: "paper_basis",     label: "paper basis",     type: "text",     placeholder: "the IC3/Flashbots paper your work cites" },
    { key: "traction",        label: "traction",        type: "text",     placeholder: "short public blurb (no $ amounts)" },
    { key: "hackathon_note",  label: "hackathon",       type: "text",     placeholder: "any award worth surfacing" },
    { key: "links.website",   label: "website",         type: "url",      placeholder: "https://…" },
    { key: "links.github",    label: "github",          type: "text",     placeholder: "owner (org/user vanity link)" },
    { key: "links.repo",      label: "repo",            type: "text",     placeholder: "owner/repo — feed auto-tracks this" },
    { key: "links.x",         label: "x / twitter",     type: "text",     placeholder: "@handle" },
    { key: "links.demo",      label: "demo",            type: "url",      placeholder: "video / loom / drive" },
    { key: "links.deck",      label: "deck",            type: "url",      placeholder: "https://…" },
  ];
}

const PERSON_EDITABLE_FIELDS = [
  { key: "name",            label: "name",            type: "text",     placeholder: "your name" },
  { key: "team",            label: "team",            type: "team-select" },
  { key: "role",            label: "role",            type: "text",     placeholder: "what you do on the team" },
  { key: "geo",             label: "geo",             type: "text",     placeholder: "NYC, etc." },
  { key: "domain",          label: "domain",          type: "select",   options: ["crypto", "tee", "ai", "app-ux", "bd-gtm", "design"] },
  { key: "links.github",    label: "github",          type: "text",     placeholder: "username" },
  { key: "links.x",         label: "x / twitter",     type: "text",     placeholder: "@handle" },
  { key: "links.website",   label: "website",         type: "url",      placeholder: "https://…" },
  { key: "links.linkedin",  label: "linkedin",        type: "text",     placeholder: "username" },
];

function getNested(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
}
function setNested(obj, path, value) {
  const ks = path.split(".");
  let cur = obj;
  for (let i = 0; i < ks.length - 1; i++) {
    if (cur[ks[i]] == null || typeof cur[ks[i]] !== "object") cur[ks[i]] = {};
    cur = cur[ks[i]];
  }
  cur[ks[ks.length - 1]] = value;
}

// `kind` lives on the team-shaped record; absence defaults to "team".
// Treats projects as team-shaped records with `kind: "project"`.
function teamKind(t) { return (t && t.kind) || "team"; }
function teamsOfKind(teams, kind) {
  return (teams || []).filter(t => teamKind(t) === kind);
}

// When switching mode/kind in EDIT mode, snap editTargetId to a valid
// record from the new pool if the current one isn't in it. Avoids the
// editor showing a stale form for a record that doesn't match the kind.
function pickFirstTargetIfMissing(p) {
  const cohort = state.cohort;
  if (!cohort) return;
  const pool = (p.editKind === "person")
    ? (cohort.people || [])
    : teamsOfKind(cohort.teams, p.editKind);
  const stillValid = pool.some(r => r.record_id === p.editTargetId);
  if (!stillValid) p.editTargetId = pool[0]?.record_id || null;
}

function loadEditTarget() {
  const p = state.profile;
  const cohort = state.cohort;
  if (!cohort) { p.editDraft = null; p.editBaseline = null; return; }

  // ADD mode: seed a blank draft for the chosen kind. No baseline (null
  // signals "creating", which submitEditAsPR uses to pick /new/ URL).
  if (p.editMode === "add") {
    if (p.editKind === "person") {
      p.editDraft = {
        record_id: "",
        record_type: "person",
        schema_version: 1,
        name: p.user.name || "",
        team: p.user.team_id || null,
        role: "",
        geo: "",
        domain: null,
        links: {
          github: p.user.github || "",
          x: p.user.x || "",
          website: p.user.website || "",
        },
      };
    } else {
      // team or project — both team-shaped, distinguished by `kind`.
      p.editDraft = {
        record_id: "",
        record_type: "team",
        schema_version: 1,
        kind: p.editKind,           // "team" | "project"
        name: "",
        focus: "",
        lead: "",
        members_count: null,
        geo: "",
        domain: null,
        shape: null,
        is_mentor: false,
        links: { github: null, x: null, website: null, demo: null, deck: null },
        paper_basis: null,
        traction: null,
        hackathon_note: null,
      };
    }
    p.editBaseline = null;
    return;
  }

  // EDIT mode: look up the picked record in the cohort.
  if (p.editKind === "person") {
    const person = (cohort.people || []).find(pp => pp.record_id === p.editTargetId);
    if (person) {
      p.editDraft = JSON.parse(JSON.stringify(person));
      p.editBaseline = JSON.parse(JSON.stringify(person));
    } else {
      p.editDraft = null;
      p.editBaseline = null;
    }
    return;
  }
  // team or project — pull from cohort.teams, filter by kind.
  const pool = teamsOfKind(cohort.teams, p.editKind);
  const t = pool.find(x => x.record_id === p.editTargetId);
  if (t) {
    p.editDraft = JSON.parse(JSON.stringify(t));
    p.editBaseline = JSON.parse(JSON.stringify(t));
  } else {
    p.editDraft = null;
    p.editBaseline = null;
  }
}

function renderProfile() {
  loadEditTarget();
  const p = state.profile;
  const teams = state.cohort?.teams || [];
  const people = state.cohort?.people || [];

  const editorBody = renderEditorBody(p, teams, people);

  state.canvas.innerHTML = `
    <header class="alch-profile-head">
      <h2 class="alch-profile-title">profile</h2>
      <p class="alch-profile-sub">
        add or edit a team / project / person record. submitting opens a PR on github
        — for new files content is pre-filled, for existing files we hand you a diff to apply in the editor.
      </p>
    </header>

    <section class="alch-profile-section">
      <h3 class="alch-profile-h">${p.editMode === "add" ? "add a record" : "edit a record"}</h3>
      <nav class="alch-pf-modetabs" role="tablist" aria-label="add or edit">
        <button class="alch-pf-modetab" data-edit-mode="add"  type="button" aria-selected="${p.editMode === "add"}">add</button>
        <button class="alch-pf-modetab" data-edit-mode="edit" type="button" aria-selected="${p.editMode === "edit"}">edit</button>
      </nav>
      <nav class="alch-pf-subtabs" role="tablist" aria-label="record kind">
        <button class="alch-pf-subtab" data-edit-kind="team"    type="button" aria-selected="${p.editKind === "team"}">team</button>
        <button class="alch-pf-subtab" data-edit-kind="project" type="button" aria-selected="${p.editKind === "project"}">project</button>
        <button class="alch-pf-subtab" data-edit-kind="person"  type="button" aria-selected="${p.editKind === "person"}">person</button>
      </nav>
      <div class="alch-pf-editor" id="alch-pf-editor">${editorBody}</div>
      <div id="alch-submit-pr-result" class="alch-submit-pr-result" hidden></div>
    </section>

    <p class="alch-callout"><strong>profile · v0.2</strong><br/>
    Submitting opens a PR against this repo. Stewards review + merge → cohort sees the change on next
    <code>npm run build:cohort</code>. Updates only touch surface fields (steward-managed fields like class /
    archetype / status are preserved by manual edit in the github editor). The feed auto-tracks every
    team or project's <code>links.repo</code> — fill it in via <strong>edit → team</strong> or <strong>edit → project</strong> to surface activity.</p>
  `;
}

function renderEditorBody(p, teams, people) {
  const fields = (p.editKind === "person") ? PERSON_EDITABLE_FIELDS : teamFieldsFor(p.editKind);

  // ADD mode: blank form, no record-picker. The slug is derived live
  // from the form (name / github) and previewed in the submit block.
  if (p.editMode === "add") {
    const formHtml = p.editDraft
      ? renderEditorForm(fields, p.editDraft, { teams })
      : `<p class="alch-pf-pick">loading…</p>`;
    return `${formHtml}${p.editDraft ? renderSubmitBlock(p) : ""}`;
  }

  // EDIT mode: pick an existing record, then edit. Pool is filtered by
  // kind so projects don't pollute the team picker (and vice versa).
  if (p.editKind === "person") {
    const pool = people;
    const opts = ['<option value="">— pick a person —</option>']
      .concat(pool.map(pp => `<option value="${escHtml(pp.record_id)}" ${p.editTargetId === pp.record_id ? "selected" : ""}>${escHtml(pp.name || pp.record_id)}</option>`))
      .join("");
    const formHtml = p.editDraft
      ? renderEditorForm(fields, p.editDraft, { teams })
      : `<p class="alch-pf-pick">${pool.length ? "pick a person above to edit." : "no person records yet — switch to <strong>add</strong> to create one."}</p>`;
    return `
      <div class="alch-pf-target">
        <label><span>person</span>
          <select id="alch-pf-target-select" class="alch-pf-target-select">${opts}</select>
        </label>
      </div>
      ${formHtml}
      ${p.editDraft ? renderSubmitBlock(p) : ""}
    `;
  }
  // team or project
  const pool = teamsOfKind(teams, p.editKind);
  const opts = [`<option value="">— pick a ${p.editKind} —</option>`]
    .concat(pool.map(t => `<option value="${escHtml(t.record_id)}" ${p.editTargetId === t.record_id ? "selected" : ""}>${escHtml(t.name)} · ${escHtml(t.record_id)}</option>`))
    .join("");
  const formHtml = p.editDraft
    ? renderEditorForm(fields, p.editDraft, { teams })
    : `<p class="alch-pf-pick">${pool.length ? `pick a ${p.editKind} above to edit its surface record.` : `no ${p.editKind} records yet — switch to <strong>add</strong> to create one.`}</p>`;
  return `
    <div class="alch-pf-target">
      <label><span>which ${escHtml(p.editKind)}</span>
        <select id="alch-pf-target-select" class="alch-pf-target-select">${opts}</select>
      </label>
    </div>
    ${formHtml}
    ${p.editDraft ? renderSubmitBlock(p) : ""}
  `;
}

function renderEditorForm(fields, draft, ctx) {
  const rows = fields.map(f => {
    const value = getNested(draft, f.key);
    const display = value == null ? "" : String(value);
    let input;
    if (f.type === "select") {
      const opts = ['<option value="">—</option>']
        .concat(f.options.map(o => `<option value="${escHtml(o)}" ${o === value ? "selected" : ""}>${escHtml(o)}</option>`))
        .join("");
      input = `<select name="${escAttr(f.key)}">${opts}</select>`;
    } else if (f.type === "team-select") {
      const teamOpts = ['<option value="">— no team —</option>']
        .concat((ctx.teams || []).map(t => `<option value="${escHtml(t.record_id)}" ${value === t.record_id ? "selected" : ""}>${escHtml(t.name)} · ${escHtml(t.record_id)}</option>`))
        .join("");
      input = `<select name="${escAttr(f.key)}">${teamOpts}</select>`;
    } else {
      input = `<input type="${f.type}" name="${escAttr(f.key)}" value="${escAttr(display)}" placeholder="${escAttr(f.placeholder || "")}" />`;
    }
    return `<label class="alch-pf-row"><span>${escHtml(f.label)}</span>${input}</label>`;
  }).join("");
  return `<form id="alch-pf-edit-form" class="alch-profile-form" autocomplete="off">${rows}</form>`;
}

function renderSubmitBlock(p) {
  const isAdd = p.editMode === "add";
  const slug = isAdd ? (draftSlug(p) || "<your-slug>") : p.editTargetId;
  // team and project both live under cohort-data/teams/.
  const folder = (p.editKind === "person") ? "people" : "teams";
  const targetPath = `cohort-data/${folder}/${slug}.md`;
  const action = isAdd ? "create new file (PR)" : "open github editor (PR)";
  const hint = isAdd
    ? `opens github's web editor pre-filled with the new record. click <strong>commit new file</strong> → github walks you into PR creation.`
    : `opens github's web editor on the existing file plus a <strong>changes</strong> panel showing exactly which lines to edit. github web editor doesn't accept pre-filled content for existing files.`;
  return `
    <div class="alch-profile-submit">
      <button id="alch-submit-pr" class="alch-feed-btn alch-submit-pr-btn" type="button">
        <span aria-hidden="true">↑</span>
        <span class="alch-submit-pr-label">${escHtml(action)}</span>
      </button>
      <p class="alch-submit-pr-hint">
        will publish to <code id="alch-submit-pr-target">${escHtml(targetPath)}</code>.
        ${hint}
      </p>
    </div>
  `;
}

function profileSlug(profile) {
  const src = (profile?.user?.github || profile?.user?.name || "").toString();
  return src.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
// Slug for an in-flight ADD form. Prefers values from the form itself
// over the long-lived "me" prefs so the path preview updates live and
// the submitted record_id matches the visible NAME / GITHUB fields.
// Person uses github > name; team/project just use name.
function draftSlug(p) {
  const d = p?.editDraft || {};
  const isPerson = p?.editKind === "person";
  const src = isPerson
    ? (d?.links?.github || d?.name || p?.user?.github || p?.user?.name || "")
    : (d?.name || "");
  return String(src).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function wireExternalLinks(root) {
  for (const a of (root || document).querySelectorAll("a[data-external]")) {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      // Stop the click bubbling — links inside clickable cards (shapes
      // grid) would otherwise also fire the card's "open detail" handler.
      e.stopPropagation();
      const url = a.getAttribute("href");
      if (!url || url === "#") return;
      try { window.api?.openExternal?.(url); } catch {}
    });
  }
}

function wireProfileForm() {
  // Mode tabs (add / edit)
  for (const btn of state.canvas.querySelectorAll(".alch-pf-modetab[data-edit-mode]")) {
    btn.addEventListener("click", () => {
      const next = btn.dataset.editMode;
      if (next === state.profile.editMode) return;
      state.profile.editMode = next;
      // Switching to edit: try to keep targetId valid for the current
      // kind, otherwise clear so the picker prompts.
      if (next === "edit") pickFirstTargetIfMissing(state.profile);
      else state.profile.editTargetId = null;
      saveProfile();
      renderProfile();
      wireProfileForm();
    });
  }

  // Kind tabs (team / project / person)
  for (const btn of state.canvas.querySelectorAll(".alch-pf-subtab[data-edit-kind]")) {
    btn.addEventListener("click", () => {
      const next = btn.dataset.editKind;
      if (next === state.profile.editKind) return;
      state.profile.editKind = next;
      if (state.profile.editMode === "edit") pickFirstTargetIfMissing(state.profile);
      saveProfile();
      renderProfile();
      wireProfileForm();
    });
  }

  // Target selector (only present in EDIT mode)
  const targetSel = document.getElementById("alch-pf-target-select");
  if (targetSel) {
    targetSel.addEventListener("change", () => {
      state.profile.editTargetId = targetSel.value || null;
      saveProfile();
      renderProfile();
      wireProfileForm();
    });
  }

  // Edit form: live-update editDraft on input. NO re-render so focus
  // stays in the input the user is typing into.
  const editForm = document.getElementById("alch-pf-edit-form");
  if (editForm) {
    const onChange = (e) => {
      const target = e.target;
      if (!target?.name || !state.profile.editDraft) return;
      const value = target.value;
      // Coerce number / select empty / etc.
      let coerced = value;
      if (target.type === "number") coerced = value === "" ? null : Number(value);
      else if (value === "") coerced = null;
      setNested(state.profile.editDraft, target.name, coerced);
      // Refresh the ADD path preview so the user can see exactly where
      // their record will land before they hit submit. Folder mirrors
      // renderSubmitBlock: people → people/, team+project → teams/.
      const targetEl = document.getElementById("alch-submit-pr-target");
      if (targetEl && state.profile.editMode === "add") {
        const slug = draftSlug(state.profile) || "<your-slug>";
        const folder = state.profile.editKind === "person" ? "people" : "teams";
        targetEl.textContent = `cohort-data/${folder}/${slug}.md`;
      }
    };
    editForm.addEventListener("input", onChange);
    editForm.addEventListener("change", onChange);
  }

  // Submit
  const prBtn = document.getElementById("alch-submit-pr");
  if (prBtn) prBtn.addEventListener("click", submitEditAsPR);

  wireExternalLinks(state.canvas);
}

// YAML-quote a user-supplied string. Always wrap in double quotes +
// escape internal quotes/backslashes — bulletproof for our schema
// (URLs, names with punctuation, handles, etc.).
function quoteYaml(s) {
  return `"${String(s ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// Build the full markdown content for a NEW team or project record.
// Both share the team-shaped frontmatter; `kind` discriminates them.
function buildTeamMarkdown(draft, slug, kind) {
  const links = draft.links || {};
  const lp = [];
  if (links.github)  lp.push(`  github: ${quoteYaml(links.github)}`);
  if (links.repo)    lp.push(`  repo: ${quoteYaml(links.repo)}`);
  if (links.x)       lp.push(`  x: ${quoteYaml(links.x)}`);
  if (links.website) lp.push(`  website: ${quoteYaml(links.website)}`);
  if (links.demo)    lp.push(`  demo: ${quoteYaml(links.demo)}`);
  if (links.deck)    lp.push(`  deck: ${quoteYaml(links.deck)}`);
  const linksBlock = lp.length ? `links:\n${lp.join("\n")}` : `links: {}`;
  const bodyHint = kind === "project"
    ? "(project description — what it does, who it's for, current state)"
    : "(team description — focus, members, where to find you)";
  return `---
record_id: ${slug}
record_type: team
schema_version: 1
kind: ${kind}
name: ${quoteYaml(draft.name || "")}
focus: ${quoteYaml(draft.focus || "")}
lead: ${quoteYaml(draft.lead || "")}
members_count: ${draft.members_count == null ? "null" : Number(draft.members_count)}
geo: ${quoteYaml(draft.geo || "")}
domain: ${draft.domain || "null"}
shape: ${draft.shape || "null"}
is_mentor: ${draft.is_mentor ? "true" : "false"}
${linksBlock}
paper_basis: ${draft.paper_basis ? quoteYaml(draft.paper_basis) : "null"}
traction: ${draft.traction ? quoteYaml(draft.traction) : "null"}
hackathon_note: ${draft.hackathon_note ? quoteYaml(draft.hackathon_note) : "null"}
---

## about

${bodyHint}
`;
}

// Build the full markdown content for a NEW person record. Used with
// github's /new/ URL which accepts pre-filled content via query param.
function buildPersonMarkdown(draft, slug) {
  const links = draft.links || {};
  const lp = [];
  if (links.github)   lp.push(`  github: ${quoteYaml(links.github)}`);
  if (links.x)        lp.push(`  x: ${quoteYaml(links.x)}`);
  if (links.website)  lp.push(`  website: ${quoteYaml(links.website)}`);
  if (links.linkedin) lp.push(`  linkedin: ${quoteYaml(links.linkedin)}`);
  const linksBlock = lp.length ? `links:\n${lp.join("\n")}` : `links: {}`;
  return `---
record_id: ${slug}
record_type: person
schema_version: 1
name: ${quoteYaml(draft.name || "")}
team: ${draft.team || "null"}
role: ${quoteYaml(draft.role || "")}
geo: ${quoteYaml(draft.geo || "")}
domain: ${draft.domain || "null"}
${linksBlock}
---

## bio

(write a short bio here — what you're building, what you're into, what you'd be a good thought partner on)
`;
}

// Compute the diff between the in-progress draft and the loaded
// baseline. Returns a list of { path, before, after } for any field
// whose final value differs. Used to render the "what to change"
// panel for /edit/ submissions.
function computeFieldDiff(baseline, draft, fields) {
  const out = [];
  for (const f of fields) {
    const before = getNested(baseline, f.key);
    const after  = getNested(draft, f.key);
    const same = before == null && after == null
      ? true
      : (before === after) || (String(before ?? "") === String(after ?? ""));
    if (!same) out.push({ path: f.key, before, after, label: f.label });
  }
  return out;
}

// Render a YAML patch — just the changed fields, ready to paste
// into github's web editor. For nested keys we group under the
// parent (links: { github: …, x: … }).
function buildYamlPatch(diff) {
  const flat = {};
  const nested = {};
  for (const d of diff) {
    if (d.path.includes(".")) {
      const [parent, child] = d.path.split(".");
      nested[parent] = nested[parent] || {};
      nested[parent][child] = d.after;
    } else {
      flat[d.path] = d.after;
    }
  }
  const lines = [];
  for (const [k, v] of Object.entries(flat)) {
    lines.push(`${k}: ${formatYamlValue(v)}`);
  }
  for (const [parent, kids] of Object.entries(nested)) {
    lines.push(`${parent}:`);
    for (const [k, v] of Object.entries(kids)) {
      lines.push(`  ${k}: ${formatYamlValue(v)}`);
    }
  }
  return lines.join("\n");
}
function formatYamlValue(v) {
  if (v == null || v === "") return "null";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return String(v);
  // String. Quote it.
  return quoteYaml(v);
}

function submitEditAsPR() {
  const result = document.getElementById("alch-submit-pr-result");
  if (!result) return;
  const p = state.profile;
  const owner  = "dmarzzz";
  const repo   = "shape-rotator-field-guide";
  const branch = "main";

  // ADD mode → github /new/ URL with prefilled content.
  if (p.editMode === "add") {
    const slug = draftSlug(p);
    if (!slug) {
      result.hidden = false;
      result.dataset.kind = "error";
      const hint = p.editKind === "person"
        ? "fill in either name or github username, then submit."
        : `fill in the ${p.editKind} name, then submit.`;
      result.innerHTML = `<div class="aspr-line"><span class="aspr-tag aspr-tag-warn">need a name</span> <span>${escHtml(hint)}</span></div>`;
      return;
    }
    // Stamp slug into draft so the markdown reflects it.
    p.editDraft.record_id = slug;
    const folder = p.editKind === "person" ? "people" : "teams";
    const filename = `cohort-data/${folder}/${slug}.md`;
    const content = p.editKind === "person"
      ? buildPersonMarkdown(p.editDraft, slug)
      : buildTeamMarkdown(p.editDraft, slug, p.editKind);
    // `quick_pull=1` forces github's commit dialog to default to
    // "create a new branch and start a pull request" instead of letting
    // a writer commit directly to main. Without it, anyone with push
    // access (i.e. the alchemists) accidentally bypasses PR review.
    const url =
      `https://github.com/${owner}/${repo}/new/${branch}` +
      `?filename=${encodeURIComponent(filename)}` +
      `&value=${encodeURIComponent(content)}` +
      `&quick_pull=1`;
    try { window.api?.openExternal?.(url); } catch {}
    result.hidden = false;
    result.dataset.kind = "success";
    result.innerHTML = `
      <div class="aspr-line"><span class="aspr-tag">github opened</span> <span>review → <strong>commit new file</strong> → github prompts you to open a PR</span></div>
      <div class="aspr-line"><span class="aspr-aux">file:</span> <code>${escHtml(filename)}</code></div>
      <div class="aspr-line">
        <button type="button" class="alch-feed-btn aspr-reopen">reopen editor</button>
      </div>
    `;
    const reopen = result.querySelector(".aspr-reopen");
    if (reopen) reopen.addEventListener("click", () => { try { window.api?.openExternal?.(url); } catch {} });
    return;
  }

  // EDIT mode → /edit/ URL + diff panel.
  const slug = p.editTargetId;
  if (!slug) {
    result.hidden = false;
    result.dataset.kind = "error";
    result.innerHTML = `<div class="aspr-line"><span class="aspr-tag aspr-tag-warn">no record picked</span> <span>pick a ${escHtml(p.editKind)} above first.</span></div>`;
    return;
  }
  const fields = (p.editKind === "person") ? PERSON_EDITABLE_FIELDS : teamFieldsFor(p.editKind);
  const folder = (p.editKind === "person") ? "people" : "teams";
  const filename = `cohort-data/${folder}/${slug}.md`;
  // quick_pull=1 — force the commit dialog into "create new branch +
  // open PR" mode so writers can't accidentally commit straight to main.
  const editUrl = `https://github.com/${owner}/${repo}/edit/${branch}/${filename}?quick_pull=1`;
  const diff = computeFieldDiff(p.editBaseline || {}, p.editDraft || {}, fields);
  if (diff.length === 0) {
    result.hidden = false;
    result.dataset.kind = "error";
    result.innerHTML = `<div class="aspr-line"><span class="aspr-tag aspr-tag-warn">no changes</span> <span>edit any field above first.</span></div>`;
    return;
  }
  const patch = buildYamlPatch(diff);
  const diffRows = diff.map(d => `
    <div class="aspr-diff-row">
      <span class="aspr-diff-key">${escHtml(d.label)}</span>
      <span class="aspr-diff-before">${escHtml(formatDiffValue(d.before))}</span>
      <span class="aspr-diff-arrow" aria-hidden="true">→</span>
      <span class="aspr-diff-after">${escHtml(formatDiffValue(d.after))}</span>
    </div>
  `).join("");
  result.hidden = false;
  result.dataset.kind = "diff";
  result.innerHTML = `
    <div class="aspr-line"><span class="aspr-tag">github opened</span> <span>edit <code>${escHtml(filename)}</code> in the github editor — apply the changes below, then commit + open PR</span></div>
    <div class="aspr-diff">${diffRows}</div>
    <details class="aspr-patch">
      <summary>YAML patch (paste-ready)</summary>
      <pre class="aspr-patch-pre">${escHtml(patch)}</pre>
      <button type="button" class="alch-feed-btn aspr-copy">copy patch</button>
    </details>
    <div class="aspr-line aspr-aux">stewards merge → next <code>npm run build:cohort</code> ships the change to the cohort.</div>
    <div class="aspr-line">
      <button type="button" class="alch-feed-btn aspr-reopen">reopen editor</button>
    </div>
  `;
  try { window.api?.openExternal?.(editUrl); } catch {}
  const reopen = result.querySelector(".aspr-reopen");
  if (reopen) reopen.addEventListener("click", () => { try { window.api?.openExternal?.(editUrl); } catch {} });
  const copy = result.querySelector(".aspr-copy");
  if (copy) {
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(patch);
        const prev = copy.textContent;
        copy.textContent = "copied";
        setTimeout(() => { copy.textContent = prev; }, 1400);
      } catch {}
    });
  }
}

function formatDiffValue(v) {
  if (v == null) return "—";
  if (v === "") return '""';
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function escAttr(s) {
  return escHtml(s).replace(/"/g, "&quot;");
}

