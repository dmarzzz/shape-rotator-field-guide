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
  mountShape, mountShapesIn,
  // Extracted into shape-ui so the sibling web app can render the same
  // cohort surface. The Electron renderer keeps the same call sites —
  // only the implementations moved.
  escHtml, escAttr,
  buildEditPRUrl,
  teamCardHtml, personCardHtml,
  buildCalendarRows, drawCalendar,
} from "@shape-rotator/shape-ui";
import { getCohortSurface, subscribeToCohortChanges } from "./cohort-source.js";

const ALCHEMY_LS_KEY  = "srwk:alchemy_mode";
const PROFILE_LS_KEY  = "srwk:profile_v1";
const EVENTS_LS_KEY   = "srwk:cohort_events_v1";
const DETAIL_LS_KEY   = "srwk:alchemy_detail_v1";
// `atlas` was here as an alchemy sub-mode but collides with the top-level
// atlas tab (the swf-node wall-map). Renderer (renderAtlas / wireAtlas) is
// kept in place so the view can be promoted to a top tab later under a
// different name if desired — just unreachable from the alchemy rail today.
const ALCHEMY_MODES   = ["feed", "shapes", "pulse", "constellation", "calendar", "profile", "onboarding", "program", "asks"];

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
  shapesKindFilter: "works",  // "works" (teams + projects) | "people"
  detailRecordId: null,     // when set, the alchemy canvas renders the full detail page for this team/project
  detailReturnMode: null,   // remembered so the back button knows where to land
  shapeControllers: [],     // active shader-canvas controllers — destroyed before each re-render so GL contexts don't leak
  cohort: null,        // { teams, clusters, people, program, asks, cohort_vocab } from cohort-source
  profile: null,       // local-only: { user, editor state, ... }
  programPage: null,   // active program-handbook page slug (overview | success | rules | schedule)
  atlasFocus: null,    // active tag in the atlas view (null = whole-graph mode)
  onboardingJustToggled: null,  // step key that was just marked/unmarked done; consumed by wireOnboarding to scroll-into-view the next step
  constellationMode: "clusters",  // "clusters" (shared cluster membership) | "dependencies" (team-asserted dependency edges)
  calendarSub: "this-week",       // calendar sub-view: "this-week" | "schedule" | "availability"
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
  // Tear down every active shape-shader controller before the innerHTML
  // rewrite — each one owns a WebGL2 context, and browsers cap us to
  // ~16. Leaving them alive across renders would silently exhaust the
  // budget after a few mode switches.
  destroyAllShapes();
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
    else if (state.mode === "calendar") renderCalendar();
    else if (state.mode === "profile") renderProfile();
    else if (state.mode === "onboarding") renderOnboarding();
    else if (state.mode === "program") renderProgram();
    else if (state.mode === "asks") renderAsks();
    // atlas — sub-mode disabled to avoid collision with top-level atlas tab.
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
      if (state.mode === "calendar") wireCalendar();
      if (state.mode === "onboarding") wireOnboarding();
      if (state.mode === "program") wireProgram();
      if (state.mode === "asks") wireAsks();
      // atlas wire skipped — see ALCHEMY_MODES comment.
    }
    // Mount shape shaders LAST — every <canvas data-shape-fam> emitted
    // by the renderers above gets one WebGL2 context here. Controllers
    // are tracked in state.shapeControllers so the next render can
    // .destroy() them all in one shot.
    mountAllShapes();
  }, 220);
}

function destroyAllShapes() {
  for (const c of state.shapeControllers) {
    try { c.destroy(); } catch {}
  }
  state.shapeControllers = [];
}
function mountAllShapes() {
  if (!state.canvas) return;
  state.shapeControllers = mountShapesIn(state.canvas);
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
      <div class="alch-card-shape alch-legend-shape"><canvas data-shape-fam="${s.fam}" data-shape-kind="team" data-shape-seed="legend:${escAttr(s.key)}"></canvas></div>
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
  const allTeams  = state.cohort.teams  || [];
  const allPeople = state.cohort.people || [];
  const nWorks  = allTeams.length;
  const nPeople = allPeople.length;
  // Migrate legacy filter values ("all" | "team" | "project" → "works",
  // "person" → "people") so old persisted state lands sensibly.
  const raw = state.shapesKindFilter;
  const filter = (raw === "people" || raw === "person") ? "people" : "works";
  state.shapesKindFilter = filter;
  const records = (filter === "people")
    ? allPeople.map(p => ({ ...p, _kind: "person" }))
    : allTeams.map(t => ({ ...t, _kind: teamKind(t) }));
  const chips = `
    <div class="alch-shapes-toolbar">
      <nav class="alch-shapes-filter" role="tablist" aria-label="filter by kind">
        <button class="alch-shapes-chip" data-shapes-filter="works"  type="button" aria-selected="${filter === "works"}">teams & projects <span class="ascn">${nWorks}</span></button>
        <button class="alch-shapes-chip" data-shapes-filter="people" type="button" aria-selected="${filter === "people"}">individuals <span class="ascn">${nPeople}</span></button>
      </nav>
      <button id="dossier-export-png" class="cal-action" type="button">export dossier (png)</button>
    </div>
  `;
  const cardCtx = { people: state.cohort?.people || [] };
  const cards = records.map((r, idx) => {
    if (r._kind === "person") return personCardHtml(r, idx);
    return teamCardHtml(r, idx, cardCtx);
  }).join("");
  const grid = records.length
    ? `<div class="alch-specimens">${cards}</div>`
    : `<p class="alch-pf-pick">no ${escHtml(filter)} records yet — switch to the <strong>profile</strong> tab and use <strong>add</strong> to create one.</p>`;
  state.canvas.innerHTML = `
    ${chips}
    ${grid}
    <p class="alch-callout"><strong>shapes · v0.1</strong><br/>
    Each card is a team, project or individual in its current shape (week ${WEEK_NOW}). Teams render as their starting domain shape; projects share the team vocabulary with a stitched rim; individuals render as a portrait medallion.</p>
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
  // Wire the dossier export button.
  const dossierBtn = document.getElementById("dossier-export-png");
  if (dossierBtn) dossierBtn.addEventListener("click", exportDossier);
}

// teamCardHtml / personCardHtml live in @shape-rotator/shape-ui now.
// The Electron renderer keeps the same call sites — see imports above.

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
  const mode = state.constellationMode || "clusters";

  const W = 980, H = 540, CX = W / 2, CY = H / 2, R = 215;
  const byRecordId = new Map(teams.map(t => [t.record_id, t]));
  const positions = teams.map((t, i) => {
    const a = (i / teams.length) * Math.PI * 2 - Math.PI / 2;
    return { t, x: CX + Math.cos(a) * R, y: CY + Math.sin(a) * R };
  });
  const posByRecordId = new Map(positions.map(p => [p.t.record_id, p]));

  // Build edges based on the selected mode.
  // - "clusters":     every pair of teams that share a cluster gets one edge per cluster (existing behavior).
  // - "dependencies": directed edges from each team to its `dependencies[]` records. Asserted by the team itself.
  const edges = [];
  if (mode === "clusters") {
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
  } else if (mode === "dependencies") {
    // Each team's self-asserted dependency list. Deduped by unordered pair
    // so a mutual "we depend on each other" only draws one edge.
    const seen = new Set();
    for (const t of teams) {
      const deps = Array.isArray(t.dependencies) ? t.dependencies : [];
      for (const depId of deps) {
        if (!byRecordId.has(depId)) continue;
        const k = [t.record_id, depId].sort().join("→");
        if (seen.has(k)) continue;
        seen.add(k);
        const a = posByRecordId.get(t.record_id);
        const b = posByRecordId.get(depId);
        if (a && b) edges.push({ a, b, cluster: null, kind: "dependency" });
      }
    }
  }

  // Multi-line dedupe: cluster mode can have multiple edges between the
  // same pair (one per shared cluster); dependencies mode is already
  // deduped above (each pair appears once) so the offset becomes a no-op.
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
    const cls = mode === "dependencies"
      ? "ac-edge ac-edge-dependency"
      : `ac-edge ac-edge-${e.cluster.record_id || e.cluster.name || "x"}`;
    return `<line class="${cls}" data-a="${escHtml(e.a.t.record_id)}" data-b="${escHtml(e.b.t.record_id)}"
      x1="${(e.a.x + px).toFixed(1)}" y1="${(e.a.y + py).toFixed(1)}"
      x2="${(e.b.x + px).toFixed(1)}" y2="${(e.b.y + py).toFixed(1)}"/>`;
  }).join("");

  const nodeMarkup = positions.map(({ t, x, y }) => `
    <g class="ac-node-group" data-record-id="${escHtml(t.record_id)}" transform="translate(${x.toFixed(1)},${y.toFixed(1)})">
      <circle class="ac-node-shape ${t.is_mentor ? "ac-node-mentor" : ""}" r="9"/>
      <text class="ac-node-label" y="26" text-anchor="middle">${escHtml(t.name)}</text>
    </g>`).join("");

  const legend = mode === "clusters"
    ? clusters.map(cl => `<span class="acl-item"><span class="acl-swatch acl-swatch-${escHtml(cl.record_id)}"></span>${escHtml(cl.label)}</span>`).join("")
    : `<span class="acl-item"><span class="acl-swatch acl-swatch-dependency"></span>declared dependency · self-asserted by the team</span>`;

  const calloutBody = mode === "clusters"
    ? `Edges are the synergy clusters from the cohort surface data — every pair of teams that share a cluster gets one line per cluster (so Conclave, which sits in three, fans out). Mentor cards are rendered hollow.`
    : `Edges are <code>dependencies[]</code> declared by each team — "we depend on this team's output" or "we'd unblock with them." Self-asserted, asymmetric source data, deduped per pair. Mentor cards are rendered hollow. See <button class="alch-link-btn" data-go="program" data-program-page="rules">program · rules</button> for why we don't infer connections automatically.`;

  state.canvas.innerHTML = `
    <div class="alch-constellation">
      <nav class="alch-const-modes" role="tablist" aria-label="constellation edge source">
        <button class="alch-const-mode-btn" data-const-mode="clusters" aria-selected="${mode === "clusters"}" type="button">
          <span class="acm-glyph" aria-hidden="true">◑</span><span class="acm-label">clusters</span>
          <span class="acm-hint">shared cluster membership</span>
        </button>
        <button class="alch-const-mode-btn" data-const-mode="dependencies" aria-selected="${mode === "dependencies"}" type="button">
          <span class="acm-glyph" aria-hidden="true">↬</span><span class="acm-label">dependencies</span>
          <span class="acm-hint">team-asserted edges</span>
        </button>
      </nav>
      <div class="alch-constellation-stage">
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
          ${edgeMarkup}
          ${nodeMarkup}
        </svg>
      </div>
      <div class="alch-constellation-legend">${legend}</div>
      <p class="alch-callout"><strong>constellation · v0.2</strong><br/>${calloutBody}</p>
    </div>
  `;
}

// escHtml / escAttr live in @shape-rotator/shape-ui now (imported above).

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
  // Member chips (data-person) embedded in team/project cards — open the
  // person's detail and stop the click from also firing the card handler.
  wirePersonLinks(state.canvas);
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
  if (stage) {
    const groups = stage.querySelectorAll(".ac-node-group");
    for (const g of groups) {
      const rid = g.dataset.recordId;
      g.addEventListener("mouseenter", () => setConstellationHover(stage, rid, true));
      g.addEventListener("mouseleave", () => setConstellationHover(stage, rid, false));
      g.addEventListener("click", () => openDrawer(rid));
    }
  }
  // Mode-toggle nav: switches the edge source between cluster-membership
  // and team-asserted dependencies. State persists for the session.
  for (const btn of state.canvas.querySelectorAll(".alch-const-mode-btn[data-const-mode]")) {
    btn.addEventListener("click", () => {
      const next = btn.dataset.constMode;
      if (next === state.constellationMode) return;
      state.constellationMode = next;
      render();
    });
  }
  // Inline jump to program → rules from the callout (dependencies mode).
  for (const b of state.canvas.querySelectorAll(".alch-link-btn[data-go='program']")) {
    b.addEventListener("click", () => {
      state.mode = "program";
      state.programPage = b.dataset.programPage || null;
      try { localStorage.setItem(ALCHEMY_LS_KEY, "program"); } catch {}
      syncRailSelection();
      render();
    });
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

// ─── calendar (cohort presence over time) ─────────────────────────────
// Gantt-style canvas: rows = people grouped by team, columns = days from
// program start → end. Each row shows the person's overall window as a
// filled bar in their hash-derived hue; absences render as a striped
// overlay so the visual delta between "in cohort" and "actually here"
// reads at a glance. A vertical "today" marker pulses on top.
//
// Scales: the canvas is built at full size (no clipping) so when the
// cohort grows from 17 to 50 the layout just adds more rows. The CSS
// container scrolls; export captures the FULL canvas regardless of
// visible portion.
//
// Export: PNG via canvas.toDataURL → Electron IPC save dialog. PNG is
// the most messaging-app-friendly format (renders inline in iMessage,
// Slack, Discord). PDF as bonus through electron's printToPDF if asked.
const CAL_DAY_W      = 22;        // pixel width per day column
const CAL_ROW_H      = 32;        // height per person row
const CAL_HEADER_H   = 148;       // top — concurrent strip + month band + week labels + day numbers
const CAL_DENSITY_H  = 32;        // height of the concurrent-headcount strip above the grid
const CAL_TEAM_H     = 36;        // height of team-group header rows
const CAL_LEFT_W     = 240;       // left column — person labels
const CAL_PAD_R      = 40;
const CAL_PAD_B      = 40;
const CAL_FOOTER_H   = 64;        // bottom — date span + legend
const CAL_BG         = "#0b0a08";
const CAL_BG_LANE    = "#15120e";
const CAL_RULE       = "rgba(245, 243, 238, 0.07)";
const CAL_RULE_WEEK  = "rgba(245, 243, 238, 0.14)";
const CAL_INK_1      = "#f5f3ee";
const CAL_INK_2      = "#b8b4ab";
const CAL_INK_3      = "#7a7368";
const CAL_INK_4      = "#3a3833";
const CAL_OXIDE      = "#c44025";  // today marker

// Reasonable defaults for the program; if cohort data exposes a
// programStart/end later this lifts straight from there.
const CAL_PROGRAM_START = "2026-05-18";
const CAL_PROGRAM_END   = "2026-07-18";

function isoToDate(s) {
  if (!s) return null;
  // Accept either "YYYY-MM-DD" or full ISO. Force UTC midnight to avoid TZ drift.
  const m = String(s).match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
}
function daysBetween(a, b) {
  return Math.round((b - a) / 86400000);
}
function fmtShortDate(d) {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).toLowerCase();
}
// fmtMonth, buildCalendarRows, drawCalendar, drawPersonRow,
// drawHeadcountStrip, and roundRect have moved to
// @shape-rotator/shape-ui (cohort-calendar.js) so the sibling web app
// can render the same calendar. The Electron renderer keeps the same
// call sites — buildCalendarRows + drawCalendar are imported above.
// personColors and hsl stay here because the dossier exporter
// (drawShapeGlyph) uses them too.

// ─── calendar — sub-tabbed live view ─────────────────────────────────
// Three sub-views, switchable via state.calendarSub:
//   this-week    what's happening this ISO week + side rhythm card
//   schedule     full chronological event list + add-event PR launcher
//   availability the existing presence Gantt (everyone's window + absences)
//
// Events come from cohort-data/events/*.md (loaded into state.cohort.events
// by the build script). Edits flow through the standard PR loop — same
// shape as profile / asks / program-page edits.
function renderCalendar() {
  const sub = (state.calendarSub === "schedule" || state.calendarSub === "availability") ? state.calendarSub : "this-week";

  state.canvas.innerHTML = `
    <header class="cal-page-head">
      <div class="cal-page-title">cohort calendar</div>
      <div class="cal-page-sub">live · edits open a PR · cohort-data/events/</div>
    </header>

    <nav class="cal-subtabs" role="tablist" aria-label="calendar view">
      <button class="cal-subtab" data-cal-sub="this-week"    aria-selected="${sub === "this-week"}"    type="button">
        <span class="cs-num">①</span><span class="cs-label">this week</span>
        <span class="cs-hint">events · rhythm</span>
      </button>
      <button class="cal-subtab" data-cal-sub="schedule"     aria-selected="${sub === "schedule"}"     type="button">
        <span class="cs-num">②</span><span class="cs-label">key dates</span>
        <span class="cs-hint">milestones · anchor points</span>
      </button>
      <button class="cal-subtab" data-cal-sub="availability" aria-selected="${sub === "availability"}" type="button">
        <span class="cs-num">③</span><span class="cs-label">availability</span>
        <span class="cs-hint">who's here, when</span>
      </button>
    </nav>

    <div class="cal-subview" data-cal-active="${sub}">
      ${sub === "this-week"    ? renderCalThisWeek()    : ""}
      ${sub === "schedule"     ? renderCalSchedule()    : ""}
      ${sub === "availability" ? renderCalAvailability() : ""}
    </div>
  `;

  if (sub === "availability") mountAvailabilityCanvas();
}

// ── helpers ──────────────────────────────────────────────────────────

function getAllEvents() {
  const events = (state.cohort?.events || []).slice();
  // Normalize: every event has a single sortable startMs / endMs.
  const norm = events.map(e => {
    const startIso = e.range_start || e.date;
    const endIso   = e.range_end   || e.date;
    return {
      ...e,
      _startIso: startIso,
      _endIso:   endIso,
      _startMs:  isoToDate(startIso)?.getTime() ?? 0,
      _endMs:    isoToDate(endIso)?.getTime() ?? 0,
      _isRange:  !!(e.range_start || e.range_end),
    };
  }).filter(e => e._startMs > 0);
  // Sort by start asc.
  norm.sort((a, b) => a._startMs - b._startMs);
  return norm;
}

// Monday-of-this-week (UTC) for the "this week" filter. Treats Sunday
// as part of the prior week (ISO convention) so the cohort week aligns
// with the weekly_intention / weekly_goals refresh cadence (Monday).
function isoWeekStartMs(now = new Date()) {
  // Today at UTC-midnight.
  const t = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  // getUTCDay: Sun=0, Mon=1, ..., Sat=6. Days back to Mon:
  const dow = new Date(t).getUTCDay();
  const back = dow === 0 ? 6 : dow - 1;
  return t - back * 86400000;
}

function eventStateFor(e, nowMs = Date.now()) {
  if (nowMs > e._endMs)        return "past";
  if (nowMs >= e._startMs)     return "now";
  return "future";
}

function fmtEventWhen(e) {
  if (e._isRange) return `${fmtKeyDate(e._startIso)} → ${fmtKeyDate(e._endIso)}`;
  return fmtKeyDate(e._startIso);
}

// Build the GitHub /new/ URL with a prefilled template for adding an event.
// Filename slug is date-prefixed-title so the directory stays chronologically
// sortable in the file browser (mirroring our existing files).
function buildAddEventUrl() {
  const today = new Date();
  const iso = today.toISOString().slice(0, 10);
  const branch = "main";
  const slug = `${iso}-new-event`;
  const template = `---
record_id: ${slug}
record_type: event
schema_version: 1

date: ${iso}
kind: anchor
title: ""
subtitle: ""
links: {}
---

## about

(public surface — fill in this body if there's prose to attach)
`;
  const path = `cohort-data/events/${slug}.md`;
  return `https://github.com/dmarzzz/shape-rotator-field-guide/new/${branch}` +
    `?filename=${encodeURIComponent(path)}` +
    `&value=${encodeURIComponent(template)}` +
    `&quick_pull=1`;
}
function buildEditEventUrl(recordId) {
  return `https://github.com/dmarzzz/shape-rotator-field-guide/edit/main/cohort-data/events/${encodeURIComponent(recordId)}.md?quick_pull=1`;
}

// ── card markup ──────────────────────────────────────────────────────

function renderEventCard(e, opts = {}) {
  const today = Date.now();
  const st = eventStateFor(e, today);
  const editUrl = buildEditEventUrl(e.record_id);
  const linkBits = [];
  const L = e.links || {};
  if (L.website) linkBits.push(`<a class="cal-event-link" data-external href="${escAttr(L.website)}">website</a>`);
  if (L.deck)    linkBits.push(`<a class="cal-event-link" data-external href="${escAttr(L.deck)}">deck</a>`);
  if (L.signup)  linkBits.push(`<a class="cal-event-link" data-external href="${escAttr(L.signup)}">signup</a>`);
  if (L.recap)   linkBits.push(`<a class="cal-event-link" data-external href="${escAttr(L.recap)}">recap</a>`);
  return `
    <article class="cal-event" data-kind="${escAttr(e.kind || "anchor")}" data-state="${st}">
      <div class="cal-event-when">${escHtml(fmtEventWhen(e))}</div>
      <div class="cal-event-body">
        <div class="cal-event-title">${escHtml(e.title || "—")}</div>
        ${e.subtitle ? `<div class="cal-event-sub">${escHtml(e.subtitle)}</div>` : ""}
        ${linkBits.length ? `<div class="cal-event-links">${linkBits.join('<span class="acm-sep">·</span>')}</div>` : ""}
      </div>
      <div class="cal-event-actions">
        <a class="cal-event-edit" data-cal-edit="${escAttr(editUrl)}" href="#" title="edit on github">✎</a>
      </div>
    </article>
  `;
}

// ── this-week view ───────────────────────────────────────────────────

function renderCalThisWeek() {
  const all = getAllEvents();
  const weekStart = isoWeekStartMs();
  const weekEnd = weekStart + 7 * 86400000 - 1;
  const todayMs = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());

  const thisWeek = all.filter(e => e._endMs >= weekStart && e._startMs <= weekEnd);
  const today = thisWeek.filter(e => e._startMs <= todayMs && e._endMs >= todayMs);
  const restOfWeek = thisWeek.filter(e => !today.includes(e));
  // Up next: first 3 future events beyond this week.
  const upNext = all.filter(e => e._startMs > weekEnd).slice(0, 3);

  // ISO week label — "week of mon may 18"
  const weekStartIso = new Date(weekStart).toISOString().slice(0, 10);
  const weekLabel = fmtKeyDate(weekStartIso);

  const todayHtml = today.length
    ? `<section class="cal-tw-today">
         <header class="cal-tw-h">
           <span class="cal-tw-h-glyph">●</span>
           <span class="cal-tw-h-label">today</span>
         </header>
         ${today.map(e => renderEventCard(e)).join("")}
       </section>`
    : `<section class="cal-tw-today cal-tw-today-empty">
         <header class="cal-tw-h">
           <span class="cal-tw-h-glyph">○</span>
           <span class="cal-tw-h-label">today</span>
         </header>
         <p class="cal-tw-empty-msg">no scheduled events today — heads-down mode unless a team-level meeting is on your calendar.</p>
       </section>`;

  const weekHtml = restOfWeek.length
    ? `<section class="cal-tw-week">
         <header class="cal-tw-h">
           <span class="cal-tw-h-label">rest of this week</span>
           <span class="cal-tw-h-count">${restOfWeek.length}</span>
         </header>
         <div class="cal-tw-list">${restOfWeek.map(e => renderEventCard(e)).join("")}</div>
       </section>`
    : "";

  const upNextHtml = upNext.length
    ? `<section class="cal-tw-next">
         <header class="cal-tw-h">
           <span class="cal-tw-h-label">up next</span>
           <span class="cal-tw-h-count">${upNext.length}</span>
         </header>
         <div class="cal-tw-list">${upNext.map(e => renderEventCard(e)).join("")}</div>
         <p class="cal-tw-foot"><button class="alch-link-btn" data-cal-jump="schedule">→ see all key dates</button></p>
       </section>`
    : "";

  return `
    <div class="cal-tw-wrap">
      <div class="cal-tw-main">
        <div class="cal-tw-weeklabel">${escHtml(weekLabel)} → +6 days</div>
        ${todayHtml}
        ${weekHtml}
        ${upNextHtml}
      </div>
      <aside class="cal-tw-side">
        ${renderRhythmCardInline()}
        <div class="cal-tw-side-jump">
          <button class="alch-feed-btn" data-cal-jump="availability" type="button">
            <span aria-hidden="true">⌬</span><span>see everyone's availability</span>
          </button>
        </div>
      </aside>
    </div>
  `;
}

// ── full-schedule view ───────────────────────────────────────────────

function renderCalSchedule() {
  const all = getAllEvents();
  const today = Date.now();
  const past   = all.filter(e => eventStateFor(e, today) === "past");
  const now    = all.filter(e => eventStateFor(e, today) === "now");
  const future = all.filter(e => eventStateFor(e, today) === "future");

  const addUrl = buildAddEventUrl();
  const sectionsFlat = [
    now.length    ? { title: "happening now", count: now.length,    list: now }    : null,
    future.length ? { title: "future",        count: future.length, list: future } : null,
    past.length   ? { title: "past",          count: past.length,   list: past }   : null,
  ].filter(Boolean);

  const sectionsHtml = sectionsFlat.map(s => `
    <section class="cal-sched-section">
      <header class="cal-sched-h">
        <span class="cal-sched-h-label">${escHtml(s.title)}</span>
        <span class="cal-sched-h-count">${s.count}</span>
      </header>
      <div class="cal-sched-list">${s.list.map(e => renderEventCard(e)).join("")}</div>
    </section>
  `).join("");

  return `
    <div class="cal-sched-wrap">
      <header class="cal-sched-pagehead">
        <div>
          <h3 class="cal-section-title">key dates</h3>
          <span class="cal-section-sub">${all.length} milestone${all.length === 1 ? "" : "s"} · click ✎ on any card to edit</span>
        </div>
        <button class="alch-feed-btn cal-sched-add" type="button" data-cal-add-url="${escAttr(addUrl)}">
          <span aria-hidden="true">+</span><span>add a key date</span>
        </button>
      </header>
      ${sectionsHtml || `<p class="alch-callout">no events yet. click <strong>add an event</strong> to open a PR with a prefilled template.</p>`}
    </div>
  `;
}

// ── availability view (the existing presence Gantt) ──────────────────

function renderCalAvailability() {
  const start = isoToDate(CAL_PROGRAM_START);
  const end   = isoToDate(CAL_PROGRAM_END);
  const numDays = daysBetween(start, end) + 1;
  const rows = buildCalendarRows(state.cohort || {});
  let bodyH = 0;
  for (const r of rows) bodyH += (r.type === "team" ? CAL_TEAM_H : CAL_ROW_H);
  const w = CAL_LEFT_W + numDays * CAL_DAY_W + CAL_PAD_R;
  const h = CAL_HEADER_H + bodyH + CAL_FOOTER_H + CAL_PAD_B;

  const numPeople = rows.filter(r => r.type === "person").length;
  const numTeamGroups = rows.filter(r => r.type === "team").length;

  return `
    <div class="cal-avail-wrap">
      <header class="cal-avail-head">
        <div>
          <h3 class="cal-section-title">availability</h3>
          <span class="cal-section-sub">${escHtml(fmtShortDate(start))} → ${escHtml(fmtShortDate(end))} · ${numPeople} individuals · ${numTeamGroups} groups · striped = absence</span>
        </div>
        <div class="cal-page-actions">
          <button id="cal-export-png" class="cal-action" type="button">export png</button>
          <button id="cal-export-pdf" class="cal-action" type="button">export pdf</button>
          <button class="alch-feed-btn cal-avail-edit" type="button" data-cal-go-profile="1" title="edit your dates_start, dates_end, absences in your person record">
            <span aria-hidden="true">✎</span><span>edit my availability</span>
          </button>
        </div>
      </header>
      <div class="cal-section cal-section-presence">
        <div class="cal-scroll">
          <canvas id="cal-canvas" width="${w}" height="${h}" style="width:${w}px; height:${h}px;" data-cal-w="${w}" data-cal-h="${h}" data-cal-numdays="${numDays}"></canvas>
        </div>
      </div>
    </div>
  `;
}

// Mount step for the availability canvas. Called from renderCalendar after
// innerHTML replacement so the canvas DOM node exists.
function mountAvailabilityCanvas() {
  const cnv = document.getElementById("cal-canvas");
  if (!cnv) return;
  const w = Number(cnv.dataset.calW) || cnv.width;
  const h = Number(cnv.dataset.calH) || cnv.height;
  const numDays = Number(cnv.dataset.calNumdays) || 1;
  const start = isoToDate(CAL_PROGRAM_START);
  const end   = isoToDate(CAL_PROGRAM_END);
  const rows = buildCalendarRows(state.cohort || {});
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  cnv.width  = Math.round(w * dpr);
  cnv.height = Math.round(h * dpr);
  cnv.style.width  = w + "px";
  cnv.style.height = h + "px";
  const ctx = cnv.getContext("2d");
  ctx.scale(dpr, dpr);
  drawCalendar(ctx, w, h, rows, start, end, numDays);
}

// FNV-1a hash → two hues in [0,1) for a person, matching the shader's
// per-team palette derivation so each individual's color in the calendar
// echoes their shape on the grid.
function personColors(seed) {
  let h = 2166136261 >>> 0;
  const s = String(seed || "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  const a =  h         & 0xff;
  const b = (h >>> 8)  & 0xff;
  return {
    hue:  a / 255,
    hue2: (a / 255 + 0.33 + (b / 255) * 0.34) % 1,
  };
}

function hsl(h, s, l, a) {
  // h/s/l in [0,1]; alpha 0..1 — returns rgba() string
  function f(n) {
    const k = (n + h * 12) % 12;
    return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  }
  const r = Math.round(f(0) * 255);
  const g = Math.round(f(8) * 255);
  const b = Math.round(f(4) * 255);
  return `rgba(${r},${g},${b},${a == null ? 1 : a})`;
}

// Wire interactions for the active calendar sub-view. Mode-tab clicks,
// add-event launcher, per-card edit links, jumps to other sub-views,
// jumps to program / profile, and the gantt export buttons.
function wireCalendar() {
  // Sub-tab switch
  for (const btn of state.canvas.querySelectorAll(".cal-subtab[data-cal-sub]")) {
    btn.addEventListener("click", () => {
      const next = btn.dataset.calSub;
      if (!next || next === state.calendarSub) return;
      state.calendarSub = next;
      render();
    });
  }
  // Inline "jump to sub-view" links (this-week page → schedule / availability)
  for (const a of state.canvas.querySelectorAll("[data-cal-jump]")) {
    a.addEventListener("click", () => {
      state.calendarSub = a.dataset.calJump;
      render();
    });
  }
  // Add-event launcher (schedule view)
  const addBtn = state.canvas.querySelector(".cal-sched-add[data-cal-add-url]");
  if (addBtn) addBtn.addEventListener("click", () => {
    try { window.api?.openExternal?.(addBtn.dataset.calAddUrl); } catch {}
  });
  // Per-card edit launcher
  for (const a of state.canvas.querySelectorAll(".cal-event-edit[data-cal-edit]")) {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      try { window.api?.openExternal?.(a.dataset.calEdit); } catch {}
    });
  }
  // Availability view's "edit my availability" → profile editor (person).
  const editAvail = state.canvas.querySelector(".cal-avail-edit[data-cal-go-profile]");
  if (editAvail) editAvail.addEventListener("click", () => {
    state.mode = "profile";
    try { localStorage.setItem(ALCHEMY_LS_KEY, "profile"); } catch {}
    syncRailSelection();
    render();
  });
  // Inline jumps from the rhythm card → program handbook page.
  for (const a of state.canvas.querySelectorAll(".alch-link-btn[data-go='program']")) {
    a.addEventListener("click", () => {
      state.mode = "program";
      state.programPage = a.dataset.programPage || null;
      try { localStorage.setItem(ALCHEMY_LS_KEY, "program"); } catch {}
      syncRailSelection();
      render();
    });
  }
  // Gantt export (availability view only)
  const pngBtn = document.getElementById("cal-export-png");
  if (pngBtn) pngBtn.addEventListener("click", () => exportCalendar("png"));
  const pdfBtn = document.getElementById("cal-export-pdf");
  if (pdfBtn) pdfBtn.addEventListener("click", () => exportCalendar("pdf"));
  // External links inside event cards (website / deck / signup / recap).
  wireExternalLinks(state.canvas);
}

// Format a YYYY-MM-DD as "wed jun 11" lowercase, UTC-safe.
function fmtKeyDate(iso) {
  const d = isoToDate(iso);
  if (!d) return "";
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).toLowerCase();
}

// The default-week rhythm. Source of truth for the prose form is
// cohort-data/program/schedule.md; this block is the at-a-glance grid we
// surface on the calendar's "this week" view. When the cohort wants to
// shift the rhythm permanently, edit the program page + bump this block.
const PROGRAM_WEEKLY_RHYTHM = [
  { slot: "morning",        weekdays: "every weekday",   note: "heads-down · no required programming until lunch" },
  { slot: "5–7pm",          weekdays: "mon · tue · thu", note: "cohort sessions (workshops · talks · whiteboarding)" },
  { slot: "wednesday",      weekdays: "all day",         note: "no required meetings — protected focus day" },
  { slot: "9–10pm",         weekdays: "rotating",        note: "salon / roast / improv night — opt-in" },
  { slot: "office hours",   weekdays: "weekly",          note: "1hr per project · 30min per individual · on-demand slots" },
  { slot: "weekend",        weekdays: "sat + sun",       note: "off by default — anything programmatic is opt-in" },
];

function renderRhythmCardInline() {
  const rows = PROGRAM_WEEKLY_RHYTHM.map(r => `
    <li class="cal-rhythm-row">
      <span class="cal-rhythm-slot">${escHtml(r.slot)}</span>
      <span class="cal-rhythm-when">${escHtml(r.weekdays)}</span>
      <span class="cal-rhythm-note">${escHtml(r.note)}</span>
    </li>
  `).join("");
  return `
    <section class="cal-section cal-section-rhythm cal-tw-rhythm">
      <header class="cal-section-head">
        <h3 class="cal-section-title">weekly rhythm</h3>
        <span class="cal-section-sub">the default week, when the program is in flight</span>
      </header>
      <ul class="cal-rhythm">${rows}</ul>
      <p class="cal-section-foot">prose + nuance lives in <button class="alch-link-btn" data-go="program" data-program-page="schedule">program → schedule</button>.</p>
    </section>
  `;
}

// ─── onboarding ─────────────────────────────────────────────────────
// First-week walkthrough. The app never *stores* progress here — we just
// surface the steps and hand off to either profile-tab edits or github
// PR URLs. Each step is "click this to do that"; completion lives in the
// markdown source (a person has a `weekly_intention`, a team has
// `weekly_goals` etc.) so the same content shows up in dossiers + feeds.
//
// Step contract: { id, title, ask, action, kind }
//   action.kind = "go-profile"  — switch to the profile sub-mode focused on
//                                 a specific record + kind. Uses the existing
//                                 openProfileEditor() helper.
//   action.kind = "go-program"  — switch to the program sub-mode + a page.
//   action.kind = "external"    — open a URL in the browser.

// Per-step "I've already done this" overrides — stored locally so an existing
// participant whose record predates the auto-detect heuristics can still
// check off steps. Keyed by step `key` (stable across renames + reorders).
const ONBOARDING_DONE_LS_KEY = "srfg:onboarding_done_v1";
function loadOnboardingDone() {
  try {
    const raw = localStorage.getItem(ONBOARDING_DONE_LS_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return (obj && typeof obj === "object") ? obj : {};
  } catch { return {}; }
}
function saveOnboardingDone(map) {
  try { localStorage.setItem(ONBOARDING_DONE_LS_KEY, JSON.stringify(map || {})); } catch {}
}
function toggleOnboardingDone(key) {
  const cur = loadOnboardingDone();
  if (cur[key]) delete cur[key];
  else cur[key] = true;
  saveOnboardingDone(cur);
}

function renderOnboarding() {
  const people  = state.cohort?.people || [];
  const teams   = state.cohort?.teams  || [];
  const p       = state.profile || {};
  // Best-effort identity: prefer an explicit profile.user.record_id, else
  // match by github handle, else nothing. Onboarding doesn't require this
  // to be set — the missing case is the most common first-launch state.
  const meId    = p?.user?.record_id || null;
  const meGh    = (p?.user?.github || "").toLowerCase();
  const me = people.find(pp =>
    (meId && pp.record_id === meId) ||
    (meGh && (pp.links?.github || "").toLowerCase() === meGh)
  ) || null;
  const myTeam = me ? teams.find(t => t.record_id === me.team) : null;

  // Two sources of "complete":
  //   1. Auto-detect: the underlying field exists in the cohort surface.
  //   2. Local override: user explicitly checked it off (localStorage).
  // The local override wins so participants whose records predate the
  // heuristics aren't stuck staring at false-negatives.
  const has = (obj, key) => obj && obj[key] != null && String(obj[key]).trim() !== "";
  const done = loadOnboardingDone();

  // Step 01's effective state propagates downstream: once you mark "claim
  // your person record" done (or the auto-detect found you), steps 02-05
  // should no longer be greyed out as "blocked". Without this, marking
  // step 01 done felt like a no-op — the next step stayed un-clickable.
  const step1Effective = !!me || !!done["claim-person-record"];
  // Step 05 (project goals) needs a team. Auto-derives from `me.team`;
  // if we can't auto-derive but step 01 was overridden, we don't block —
  // the user picks their team in the profile editor.
  const step5HasTeamContext = !!myTeam || step1Effective;

  // Generic action for "I overrode step 01 but no auto-detected record
  // exists" — drop the user into the profile editor without prefilling a
  // record id so they can pick the right one from the dropdown.
  const openPersonEditorGeneric = { kind: "go-profile", mode: "edit", recordKind: "person", recordId: null, label: "open profile · pick your record" };
  const openTeamEditorGeneric   = { kind: "go-profile", mode: "edit", recordKind: "team",   recordId: null, label: "open profile · pick your team" };

  // `key` is stable across renames + reorders; numbers (n) are display-only.
  // Step "confirm-your-project" was removed by request — the auto-detect
  // for project assignment lives on the person record's `team` field, which
  // step 02 (personal API) already pulls into the edit view.
  const stepDefs = [
    {
      key: "claim-person-record",
      title: "claim your person record",
      ask: me
        ? `you're already on the map as <strong>${escHtml(me.name || me.record_id)}</strong>.`
        : done["claim-person-record"]
          ? `you marked this done locally. if your record uses a different github handle than the one in your profile, the auto-detect can't find it — that's fine, the override stands.`
          : "no person record matches you yet. add one so you appear on the cohort map + calendar.",
      autoComplete: !!me,
      missingState: "missing",
      action: me
        ? { kind: "go-profile", mode: "edit", recordKind: "person", recordId: me.record_id, label: "edit my record" }
        : { kind: "go-profile", mode: "add",  recordKind: "person",                          label: "add my record" },
    },
    {
      key: "personal-api",
      title: "fill in your personal API",
      ask: me
        ? `tell the cohort how to collaborate with you well — comm style, what you'd happily pair on, your weekly rhythm. fields: <code>comm_style</code>, <code>contribute_interests</code>, <code>availability_pref</code>.`
        : step1Effective
          ? `pick your record in the profile editor — these go on it: <code>comm_style</code>, <code>contribute_interests</code>, <code>availability_pref</code>.`
          : "(complete step 01 first.)",
      autoComplete: !!me && (has(me, "comm_style") || has(me, "contribute_interests") || has(me, "availability_pref")),
      missingState: !step1Effective ? "blocked" : "missing",
      action: me
        ? { kind: "go-profile", mode: "edit", recordKind: "person", recordId: me.record_id, label: "edit my personal API" }
        : (step1Effective ? openPersonEditorGeneric : null),
    },
    {
      key: "week-1-intention",
      title: "set your week-1 intention",
      ask: me
        ? `one concrete thing you want to ship or learn this week. lives on your person record as <code>weekly_intention</code> — refresh it every monday.`
        : step1Effective
          ? `one concrete thing you want to ship or learn this week. lives on your person record as <code>weekly_intention</code> — pick your record to set it.`
          : "(complete step 01 first.)",
      autoComplete: !!me && has(me, "weekly_intention"),
      missingState: !step1Effective ? "blocked" : "missing",
      action: me
        ? { kind: "go-profile", mode: "edit", recordKind: "person", recordId: me.record_id, label: "write my week-1 intention" }
        : (step1Effective ? openPersonEditorGeneric : null),
    },
    {
      key: "project-success-criteria",
      title: "set your project's success criteria",
      ask: myTeam
        ? `each project defines its own. fields on <strong>${escHtml(myTeam.name || myTeam.record_id)}</strong>: <code>success_dimensions</code>, <code>weekly_goals</code>, <code>monthly_milestones</code>, <code>graduation_target</code>. this is the office-hours-week-1 conversation.`
        : step5HasTeamContext
          ? `pick your team in the profile editor and set: <code>success_dimensions</code>, <code>weekly_goals</code>, <code>monthly_milestones</code>, <code>graduation_target</code>. this is the office-hours-week-1 conversation.`
          : "(complete step 01 first.)",
      autoComplete: !!myTeam && (has(myTeam, "weekly_goals") || has(myTeam, "graduation_target")),
      missingState: !step5HasTeamContext ? "blocked" : "missing",
      action: myTeam
        ? { kind: "go-profile", mode: "edit", recordKind: (myTeam.kind === "project" ? "project" : "team"), recordId: myTeam.record_id, label: "edit project goals" }
        : (step5HasTeamContext ? openTeamEditorGeneric : null),
    },
    {
      key: "read-program-handbook",
      title: "read the program handbook",
      ask: "the rules, success vectors, and weekly rhythm are spelled out under <strong>program</strong>. read it once; reference it when something's ambiguous.",
      autoComplete: false,
      missingState: "info",
      action: { kind: "go-program", label: "open program handbook" },
    },
  ];

  const steps = stepDefs.map((s, i) => {
    const overridden = !!done[s.key];
    const isComplete = overridden || s.autoComplete;
    return {
      ...s,
      n: String(i + 1).padStart(2, "0"),
      overridden,
      state: isComplete ? "complete" : s.missingState,
    };
  });

  const stepHtml = steps.map(s => {
    const action = s.action
      ? `<button class="alch-feed-btn alch-onb-action" type="button"
                 data-onb-action="${escAttr(JSON.stringify(s.action))}">
           ${escHtml(s.action.label)}
         </button>`
      : "";
    // Per-step "mark done" toggle. Reflects + writes the localStorage map.
    // When auto-detect already says complete we still show the toggle so the
    // user can manually uncheck (and re-pin the step's state if they want).
    const toggleLabel = s.overridden
      ? "✓ marked done"
      : (s.autoComplete ? "auto · mark done" : "mark done");
    const toggleCls = s.overridden ? "alch-onb-done alch-onb-done-on" : "alch-onb-done";
    return `
      <li class="alch-onb-step" data-state="${escAttr(s.state)}">
        <div class="alch-onb-step-num">${escHtml(s.n)}</div>
        <div class="alch-onb-step-body">
          <h3 class="alch-onb-step-title">${escHtml(s.title)}</h3>
          <p class="alch-onb-step-ask">${s.ask}</p>
          <div class="alch-onb-step-actions">
            ${action}
            <button class="${toggleCls}" type="button"
                    data-onb-toggle="${escAttr(s.key)}"
                    aria-pressed="${s.overridden}"
                    title="stored in localStorage on this machine">
              ${escHtml(toggleLabel)}
            </button>
          </div>
        </div>
        <div class="alch-onb-step-mark" aria-hidden="true"></div>
      </li>
    `;
  }).join("");

  state.canvas.innerHTML = `
    <header class="alch-onb-head">
      <h2 class="alch-onb-title">onboarding</h2>
      <p class="alch-onb-sub">
        ${me
          ? `you're <strong>${escHtml(me.name || me.record_id)}</strong>. five steps · take ~30 minutes total · everything below opens a github PR.`
          : `five steps · take ~30 minutes total · everything below opens a github PR. start with step 01 so the rest can find you.`}
      </p>
    </header>
    <ol class="alch-onb-steps">${stepHtml}</ol>
    <p class="alch-callout"><strong>onboarding · v0.2</strong><br/>
    auto-detected completion reads from the merged cohort surface — so it stays correct across machines. the <strong>mark done</strong> toggle is a per-machine override stored in <code>localStorage</code>, useful when the auto-detect can't see a record you already have. revisit weekly to refresh your intention + goals.</p>
  `;
}

function wireOnboarding() {
  for (const btn of state.canvas.querySelectorAll(".alch-onb-done[data-onb-toggle]")) {
    btn.addEventListener("click", () => {
      const key = btn.dataset.onbToggle;
      if (!key) return;
      toggleOnboardingDone(key);
      // Remember which step we just toggled so the post-render handler
      // can scroll to (and momentarily pulse) whatever comes next.
      state.onboardingJustToggled = key;
      render();
    });
  }
  // After re-render, surface forward motion: scroll the first step that
  // still needs action into view + brief pulse highlight. Render() is
  // animated (~220ms swap) so we wait past that before measuring DOM.
  if (state.onboardingJustToggled) {
    const justKey = state.onboardingJustToggled;
    state.onboardingJustToggled = null;
    setTimeout(() => {
      if (!state.canvas) return;
      // Prefer the step immediately after the one we just toggled. Fall
      // back to the first non-complete actionable step on the page.
      const steps = Array.from(state.canvas.querySelectorAll(".alch-onb-step"));
      const justIdx = steps.findIndex(li => li.querySelector(`[data-onb-toggle="${justKey}"]`));
      const candidates = justIdx >= 0 ? steps.slice(justIdx + 1) : steps;
      const next = candidates.find(li => {
        const st = li.getAttribute("data-state");
        return st === "missing" || st === "info";
      });
      if (next) {
        next.scrollIntoView({ behavior: "smooth", block: "center" });
        next.classList.add("is-onb-next-pulse");
        setTimeout(() => next.classList.remove("is-onb-next-pulse"), 1600);
      }
    }, 260);
  }
  for (const btn of state.canvas.querySelectorAll(".alch-onb-action")) {
    btn.addEventListener("click", () => {
      let a;
      try { a = JSON.parse(btn.dataset.onbAction || "{}"); } catch { return; }
      if (a.kind === "go-profile") {
        // Reuse the public profile-opener already wired for cross-tab handoff
        // (defined on window.__srwkOpenProfile). Keeps a single code path
        // for "land on profile focused on record X".
        if (typeof window.__srwkOpenProfile === "function") {
          window.__srwkOpenProfile({ kind: a.recordKind, mode: a.mode || "edit", record_id: a.recordId });
        }
      } else if (a.kind === "go-program") {
        state.mode = "program";
        try { localStorage.setItem(ALCHEMY_LS_KEY, "program"); } catch {}
        if (a.page) state.programPage = a.page;
        syncRailSelection();
        render();
      } else if (a.kind === "external" && a.url) {
        try { window.api?.openExternal?.(a.url); } catch {}
      }
    });
  }
}

// ─── program handbook ───────────────────────────────────────────────
// Tabbed renderer over cohort-data/program/*.md. Each page's body_md
// is shipped in the surface bundle; we do a lightweight markdown→HTML
// pass (enough for headings, paragraphs, em/strong, code, lists, links).
// Each page has a "edit this page" link that opens github's web editor
// at the corresponding cohort-data/program/<slug>.md path.

function escHtmlPreserve(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Minimal markdown→HTML. Intentionally narrow: handles the subset we
// actually use in program/*.md. If we need more (tables, footnotes,
// images) lift a real lib later; today: zero deps, predictable output.
function renderProgramMarkdown(md) {
  const src = String(md || "").trim();
  if (!src) return `<p class="alch-prog-empty">(this page is empty — fill it in via the edit button above.)</p>`;
  const lines = src.split(/\r?\n/);
  const out = [];
  let inUl = false, inOl = false, inP = false;
  const closeBlocks = () => {
    if (inP)  { out.push("</p>"); inP = false; }
    if (inUl) { out.push("</ul>"); inUl = false; }
    if (inOl) { out.push("</ol>"); inOl = false; }
  };
  const inline = (text) => {
    let t = escHtmlPreserve(text);
    // code spans first so we don't escape inside them
    t = t.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
    t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    t = t.replace(/_([^_\n]+)_/g, "<em>$1</em>");
    // [label](url)
    t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
      const safe = url.startsWith("http") || url.startsWith("/") || url.startsWith("#") ? url : "#";
      return `<a href="${safe}" data-external>${label}</a>`;
    });
    return t;
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) { closeBlocks(); continue; }
    const h = /^(#{1,6})\s+(.+)$/.exec(line);
    if (h) { closeBlocks(); out.push(`<h${h[1].length} class="alch-prog-h${h[1].length}">${inline(h[2])}</h${h[1].length}>`); continue; }
    const ul = /^\s*[-*]\s+(.+)$/.exec(line);
    if (ul) {
      if (inP)  { out.push("</p>"); inP = false; }
      if (inOl) { out.push("</ol>"); inOl = false; }
      if (!inUl) { out.push(`<ul class="alch-prog-ul">`); inUl = true; }
      out.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }
    const ol = /^\s*\d+\.\s+(.+)$/.exec(line);
    if (ol) {
      if (inP)  { out.push("</p>"); inP = false; }
      if (inUl) { out.push("</ul>"); inUl = false; }
      if (!inOl) { out.push(`<ol class="alch-prog-ol">`); inOl = true; }
      out.push(`<li>${inline(ol[1])}</li>`);
      continue;
    }
    // Paragraph text.
    if (inUl || inOl) closeBlocks();
    if (!inP) { out.push(`<p class="alch-prog-p">`); inP = true; }
    else out.push(" ");
    out.push(inline(line));
  }
  closeBlocks();
  return out.join("");
}

function renderProgram() {
  const pages = (state.cohort?.program || []).slice();
  // Defensive sort by `order` then record_id; matches the build script.
  pages.sort((a, b) => {
    const ao = Number.isFinite(a.order) ? a.order : 1e9;
    const bo = Number.isFinite(b.order) ? b.order : 1e9;
    if (ao !== bo) return ao - bo;
    return String(a.record_id).localeCompare(String(b.record_id));
  });

  if (pages.length === 0) {
    state.canvas.innerHTML = `
      <header class="alch-prog-head">
        <h2 class="alch-prog-title">program</h2>
        <p class="alch-prog-sub">no program pages in the surface bundle yet.</p>
      </header>
      <p class="alch-callout">run <code>npm run build:cohort</code> after adding files under <code>cohort-data/program/</code>.</p>
    `;
    return;
  }

  const want = state.programPage || pages[0].record_id;
  const current = pages.find(p => p.record_id === want) || pages[0];

  const tabs = pages.map(p => `
    <button class="alch-prog-tab" type="button"
            data-program-page="${escAttr(p.record_id)}"
            aria-selected="${p.record_id === current.record_id}">
      <span class="alch-prog-tab-num">${escHtml(String(Number.isFinite(p.order) ? p.order : "·").padStart(2, "0"))}</span>
      <span class="alch-prog-tab-label">${escHtml(p.title || p.record_id)}</span>
    </button>
  `).join("");

  const bodyHtml = renderProgramMarkdown(current.body_md);
  const editPath = `cohort-data/program/${current.record_id}.md`;
  const editUrl = `https://github.com/dmarzzz/shape-rotator-field-guide/edit/main/${editPath}?quick_pull=1`;

  state.canvas.innerHTML = `
    <header class="alch-prog-head">
      <h2 class="alch-prog-title">program</h2>
      <p class="alch-prog-sub">the handbook. edits open a PR on github — stewards merge → next build:cohort ships the change to the cohort.</p>
    </header>
    <nav class="alch-prog-tabs" role="tablist" aria-label="program section">${tabs}</nav>
    <article class="alch-prog-page">
      <header class="alch-prog-page-head">
        <h2 class="alch-prog-page-title">${escHtml(current.title || current.record_id)}</h2>
        <button class="alch-feed-btn alch-prog-edit" type="button" data-edit-url="${escAttr(editUrl)}" title="opens github's web editor (PR-only)">
          <span aria-hidden="true">✎</span>
          <span>edit this page</span>
        </button>
      </header>
      <div class="alch-prog-body">${bodyHtml}</div>
      <footer class="alch-prog-page-foot">
        <span class="alch-prog-aux">source:</span> <code>${escHtml(editPath)}</code>
      </footer>
    </article>
  `;
}

function wireProgram() {
  for (const btn of state.canvas.querySelectorAll(".alch-prog-tab[data-program-page]")) {
    btn.addEventListener("click", () => {
      state.programPage = btn.dataset.programPage;
      render();
    });
  }
  const editBtn = state.canvas.querySelector(".alch-prog-edit[data-edit-url]");
  if (editBtn) {
    editBtn.addEventListener("click", () => {
      try { window.api?.openExternal?.(editBtn.dataset.editUrl); } catch {}
    });
  }
  wireExternalLinks(state.canvas);
}

// ─── asks board ─────────────────────────────────────────────────────
// Recurse pairing-bot + ETHGlobal #find-a-team pattern. Each ask is a
// markdown file under cohort-data/asks/ with frontmatter {posted_at,
// author, verb, topic, skill_areas, status}. Posts fade after 5 days
// from posted_at (renderer-side filter; the underlying file stays so
// the audit trail is preserved).
//
// Sensitivity: this surface intentionally has NO leaderboard, NO claim
// count, NO "endorsement" mechanic, NO algorithm matching. Filter +
// browse + open-the-author's-dm. See program/rules.md anti-patterns.

const ASK_EXPIRY_DAYS = 5;

function asksWithStatus() {
  const all = (state.cohort?.asks || []).slice();
  const todayMs = Date.now();
  return all.map(a => {
    const posted = isoToDate(a.posted_at);
    const ageDays = posted ? Math.floor((todayMs - posted.getTime()) / 86400000) : 999;
    const expired = ageDays >= ASK_EXPIRY_DAYS;
    return { ...a, _ageDays: ageDays, _expired: expired };
  }).sort((a, b) => {
    // Open + recent first; expired drift to the bottom.
    if (a._expired !== b._expired) return a._expired ? 1 : -1;
    return (a._ageDays || 0) - (b._ageDays || 0);
  });
}

function personByRecordId(rid) {
  return (state.cohort?.people || []).find(p => p.record_id === rid) || null;
}

function dmLinkForPerson(p) {
  // Preference order: telegram > x > website > github > email.
  // Returns { label, url } or null.
  if (!p) return null;
  const L = p.links || {};
  if (L.telegram) return { label: "telegram", url: L.telegram.startsWith("http") ? L.telegram : `https://t.me/${L.telegram.replace(/^@/, "")}` };
  if (L.x)        return { label: "x / dm",   url: L.x.startsWith("http")        ? L.x        : `https://x.com/${L.x.replace(/^@/, "")}` };
  if (L.github)   return { label: "github",   url: L.github.startsWith("http")   ? L.github   : `https://github.com/${L.github}` };
  if (L.website)  return { label: "website",  url: L.website };
  if (p.email)    return { label: "email",    url: `mailto:${p.email}` };
  return null;
}

function renderAsks() {
  const asks = asksWithStatus();
  const me = state.profile?.user || {};
  const myHandle = String(me.github || "").toLowerCase();
  const myAuthorId = me.record_id || null;

  if (asks.length === 0) {
    state.canvas.innerHTML = `
      <header class="alch-asks-head">
        <h2 class="alch-asks-title">asks</h2>
        <p class="alch-asks-sub">verb-first pair-requests. 5-day expiry. tap-to-claim opens the author's DM.</p>
      </header>
      <p class="alch-callout">no asks yet. <strong>post one</strong> by creating a markdown file under <code>cohort-data/asks/</code> via the same PR flow as your profile.</p>
    `;
    return;
  }

  const open    = asks.filter(a => !a._expired && (a.status || "open") === "open");
  const claimed = asks.filter(a => !a._expired && a.status === "claimed");
  const done    = asks.filter(a => !a._expired && a.status === "done");
  const expired = asks.filter(a => a._expired);

  const renderAsk = (a) => {
    const author = personByRecordId(a.author);
    const authorLabel = author ? (author.name || author.record_id) : a.author;
    const dm = dmLinkForPerson(author);
    const chips = (a.skill_areas || []).map(s => `<span class="alch-asks-chip">${escHtml(s)}</span>`).join("");
    const isMine = (a.author === myAuthorId) || (author && String(author.links?.github || "").toLowerCase() === myHandle);
    const ageLabel = a._ageDays === 0 ? "today"
                   : a._ageDays === 1 ? "1 day ago"
                   : `${a._ageDays} days ago`;
    const statusBadge = a.status === "claimed" ? `<span class="alch-asks-status alch-asks-status-claimed">claimed</span>`
                      : a.status === "done"    ? `<span class="alch-asks-status alch-asks-status-done">done</span>`
                      : "";
    const action = isMine
      ? `<a class="alch-asks-action alch-asks-action-edit" data-asks-edit="${escAttr(a.record_id)}" href="#">edit</a>`
      : (dm
          ? `<a class="alch-asks-action" data-external href="${escAttr(dm.url)}">${escHtml(dm.label)} →</a>`
          : `<span class="alch-asks-action alch-asks-action-disabled">no contact link on author</span>`);
    return `
      <article class="alch-asks-card" data-expired="${a._expired ? "1" : "0"}">
        <div class="alch-asks-verb">${escHtml(a.verb || "·")}</div>
        <div class="alch-asks-body">
          <div class="alch-asks-topic">${escHtml(a.topic || "")}</div>
          <div class="alch-asks-meta">
            <span class="alch-asks-author">${escHtml(authorLabel)}</span>
            <span class="alch-asks-sep">·</span>
            <span class="alch-asks-when">${escHtml(ageLabel)}</span>
            ${statusBadge}
          </div>
          ${chips ? `<div class="alch-asks-chips">${chips}</div>` : ""}
        </div>
        <div class="alch-asks-actions">${action}</div>
      </article>
    `;
  };

  const section = (title, list, extraNote = "") => list.length === 0 ? "" : `
    <section class="alch-asks-section">
      <header class="alch-asks-section-head">
        <h3 class="alch-asks-section-title">${escHtml(title)}</h3>
        <span class="alch-asks-section-count">${list.length}</span>
        ${extraNote ? `<span class="alch-asks-section-note">${escHtml(extraNote)}</span>` : ""}
      </header>
      <div class="alch-asks-list">${list.map(renderAsk).join("")}</div>
    </section>
  `;

  // New-ask handoff: same /new/ URL pattern as profile records. We
  // pre-fill enough that the user only has to fill `topic` + verb.
  const todayIso = new Date().toISOString().slice(0, 10);
  const authorSlug = myAuthorId || (myHandle ? myHandle : "your-slug");
  const askTemplate = `---
record_id: ${authorSlug}-${todayIso}
record_type: ask
posted_at: ${todayIso}
author: ${authorSlug}
verb: "🤝 pair on"
topic: ""
skill_areas: []
status: open
---

(optional body — extra context for the ask.)
`;
  const newUrl = `https://github.com/dmarzzz/shape-rotator-field-guide/new/cohort-enrichment-mega-pr` +
    `?filename=${encodeURIComponent(`cohort-data/asks/${authorSlug}-${todayIso}.md`)}` +
    `&value=${encodeURIComponent(askTemplate)}` +
    `&quick_pull=1`;

  state.canvas.innerHTML = `
    <header class="alch-asks-head">
      <h2 class="alch-asks-title">asks</h2>
      <p class="alch-asks-sub">verb-first pair-requests · 5-day expiry · tap-to-claim opens the author's DM</p>
      <div class="alch-asks-head-actions">
        <button class="alch-feed-btn alch-asks-new" type="button" data-asks-new-url="${escAttr(newUrl)}">
          <span aria-hidden="true">+</span><span>post an ask</span>
        </button>
      </div>
    </header>

    ${section("open", open)}
    ${section("claimed", claimed, "in flight")}
    ${section("done", done, "wrap-up only")}
    ${section("fading", expired, "past the 5-day window")}

    <p class="alch-callout"><strong>asks · v0.1</strong><br/>
    posts are markdown under <code>cohort-data/asks/</code>. expiry is renderer-side — files stay so the audit trail is preserved. no claim count, no leaderboard, no algorithm. filter + browse + DM. see <button class="alch-link-btn" data-go="program" data-program-page="rules">program · rules</button> for the anti-patterns we left out.</p>
  `;
}

function wireAsks() {
  for (const btn of state.canvas.querySelectorAll(".alch-asks-new[data-asks-new-url]")) {
    btn.addEventListener("click", () => {
      try { window.api?.openExternal?.(btn.dataset.asksNewUrl); } catch {}
    });
  }
  for (const a of state.canvas.querySelectorAll(".alch-asks-action[data-asks-edit]")) {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const slug = a.dataset.asksEdit;
      const url = `https://github.com/dmarzzz/shape-rotator-field-guide/edit/cohort-enrichment-mega-pr/cohort-data/asks/${encodeURIComponent(slug)}.md?quick_pull=1`;
      try { window.api?.openExternal?.(url); } catch {}
    });
  }
  // Inline jump to program → rules from the callout.
  for (const b of state.canvas.querySelectorAll(".alch-link-btn[data-go='program']")) {
    b.addEventListener("click", () => {
      state.mode = "program";
      state.programPage = b.dataset.programPage || null;
      try { localStorage.setItem(ALCHEMY_LS_KEY, "program"); } catch {}
      syncRailSelection();
      render();
    });
  }
  wireExternalLinks(state.canvas);
}

// ─── topic atlas ────────────────────────────────────────────────────
// Force-directed bubble cluster of `skill_areas` tags across teams +
// people. Bubble size = number of cohort members carrying the tag.
// Adjacency = co-occurrence on the same record. Click bubble → reveal
// the teams + people that carry it.
//
// Layout: simple custom force iteration on canvas. ~25 nodes; no need
// for a real graph library. The deterministic seed-based init keeps
// the layout stable across renders.

function aggregateSkillAreas() {
  const cohort = state.cohort || {};
  const tagsToTeams = new Map();   // tag → Set(team_record_id)
  const tagsToPeople = new Map();  // tag → Set(person_record_id)
  const teamPairs = new Map();     // "tagA::tagB" → count (for adjacency)

  const consume = (areas, kind, id) => {
    const uniq = Array.from(new Set((areas || []).filter(Boolean)));
    for (const t of uniq) {
      const tn = String(t).trim().toLowerCase();
      if (!tn) continue;
      if (kind === "team") {
        if (!tagsToTeams.has(tn)) tagsToTeams.set(tn, new Set());
        tagsToTeams.get(tn).add(id);
      } else {
        if (!tagsToPeople.has(tn)) tagsToPeople.set(tn, new Set());
        tagsToPeople.get(tn).add(id);
      }
    }
    for (let i = 0; i < uniq.length; i++) {
      for (let j = i + 1; j < uniq.length; j++) {
        const a = String(uniq[i]).trim().toLowerCase();
        const b = String(uniq[j]).trim().toLowerCase();
        if (!a || !b || a === b) continue;
        const key = a < b ? `${a}::${b}` : `${b}::${a}`;
        teamPairs.set(key, (teamPairs.get(key) || 0) + 1);
      }
    }
  };
  for (const t of cohort.teams || []) consume(t.skill_areas, "team", t.record_id);
  for (const p of cohort.people || []) consume(p.skill_areas, "person", p.record_id);

  const allTags = new Set([...tagsToTeams.keys(), ...tagsToPeople.keys()]);
  const nodes = Array.from(allTags).map(tag => {
    const teams = Array.from(tagsToTeams.get(tag) || []);
    const people = Array.from(tagsToPeople.get(tag) || []);
    return {
      tag,
      teams,
      people,
      size: teams.length + people.length,
    };
  }).sort((a, b) => b.size - a.size);

  const edges = Array.from(teamPairs.entries()).map(([k, v]) => {
    const [a, b] = k.split("::");
    return { a, b, weight: v };
  });
  return { nodes, edges };
}

// Deterministic seeded RNG so the layout is stable across renders.
function mulberry32(seed) {
  let t = seed >>> 0;
  return function() {
    t = (t + 0x6D2B79F5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function layoutAtlas(nodes, edges, w, h) {
  if (nodes.length === 0) return [];
  const rand = mulberry32(0xC0FFEE);
  // Bubble radius scales with sqrt(size); min/max clamped.
  const maxSize = Math.max(...nodes.map(n => n.size), 1);
  const rOf = (n) => Math.max(14, Math.min(56, 14 + 36 * Math.sqrt(n.size / maxSize)));
  const pts = nodes.map((n) => ({
    ...n,
    r: rOf(n),
    x: w / 2 + (rand() - 0.5) * w * 0.6,
    y: h / 2 + (rand() - 0.5) * h * 0.6,
    vx: 0, vy: 0,
  }));
  const idx = new Map(pts.map((p, i) => [p.tag, i]));

  // Run a fixed number of force iterations. O(n^2) repulsion + attraction
  // along edges + centering. n ≤ 25 so this is sub-millisecond.
  const ITERS = 240;
  for (let step = 0; step < ITERS; step++) {
    const alpha = 1 - step / ITERS;
    // Repulsion
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const a = pts[i], b = pts[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        const minD = a.r + b.r + 14;
        if (d2 < 0.0001) { dx = (rand() - 0.5); dy = (rand() - 0.5); d2 = 1; }
        const d = Math.sqrt(d2);
        const overlap = Math.max(0, minD - d);
        const force = (1500 / Math.max(d2, 100)) + overlap * 1.4;
        const fx = (dx / d) * force * alpha;
        const fy = (dy / d) * force * alpha;
        a.vx += fx; a.vy += fy;
        b.vx -= fx; b.vy -= fy;
      }
    }
    // Attraction along edges (weighted)
    for (const e of edges) {
      const ai = idx.get(e.a), bi = idx.get(e.b);
      if (ai == null || bi == null) continue;
      const a = pts[ai], b = pts[bi];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const target = (a.r + b.r) * 1.6;
      const stretch = d - target;
      const force = stretch * 0.012 * Math.min(e.weight, 4) * alpha;
      const fx = (dx / d) * force, fy = (dy / d) * force;
      a.vx += fx; a.vy += fy;
      b.vx -= fx; b.vy -= fy;
    }
    // Centering
    for (const p of pts) {
      p.vx += (w / 2 - p.x) * 0.005 * alpha;
      p.vy += (h / 2 - p.y) * 0.005 * alpha;
      p.x += p.vx; p.y += p.vy;
      p.vx *= 0.82; p.vy *= 0.82;
      // Clamp to viewport.
      p.x = Math.max(p.r + 6, Math.min(w - p.r - 6, p.x));
      p.y = Math.max(p.r + 6, Math.min(h - p.r - 6, p.y));
    }
  }
  return pts;
}

function renderAtlas() {
  const { nodes, edges } = aggregateSkillAreas();
  const teams = state.cohort?.teams || [];
  const people = state.cohort?.people || [];
  const totalTeams = teams.length;
  const totalPeople = people.length;
  const W = 880, H = 520;

  if (nodes.length === 0) {
    state.canvas.innerHTML = `
      <header class="alch-atlas-head">
        <h2 class="alch-atlas-title">atlas</h2>
        <p class="alch-atlas-sub">skill_areas tags across the cohort.</p>
      </header>
      <p class="alch-callout">no tagged records yet. add <code>skill_areas</code> to your team or person record via the profile editor; this view reads from the merged cohort surface.</p>
    `;
    return;
  }

  const laid = layoutAtlas(nodes, edges, W, H);
  const active = state.atlasFocus || null;
  const activeNode = active ? laid.find(n => n.tag === active) : null;
  // Edges with end points after layout, filtered to a sensible top set
  // (the strongest co-occurrences) so the canvas isn't a hairball.
  const TOP_EDGES = 24;
  const drawableEdges = edges
    .map(e => ({ ...e, _a: laid.find(p => p.tag === e.a), _b: laid.find(p => p.tag === e.b) }))
    .filter(e => e._a && e._b)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, TOP_EDGES);

  const edgeSvg = drawableEdges.map(e => {
    const dim = active && active !== e.a && active !== e.b ? 0.08 : 0.30;
    return `<line x1="${e._a.x.toFixed(1)}" y1="${e._a.y.toFixed(1)}" x2="${e._b.x.toFixed(1)}" y2="${e._b.y.toFixed(1)}" stroke="rgba(245,243,238,${dim})" stroke-width="${Math.min(2.5, 0.6 + e.weight * 0.3).toFixed(2)}" />`;
  }).join("");

  const nodeSvg = laid.map(n => {
    const dim = active ? (n.tag === active ? 1 : 0.32) : 1;
    const fill = n.tag === active ? "#c44025" : "rgba(193,168,114,0.55)";
    const stroke = n.tag === active ? "#c44025" : "rgba(245,243,238,0.55)";
    const label = n.tag.length > 16 ? n.tag.slice(0, 15) + "…" : n.tag;
    return `
      <g class="alch-atlas-node" data-atlas-tag="${escAttr(n.tag)}" opacity="${dim}" style="cursor:pointer;">
        <circle cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="${n.r.toFixed(1)}" fill="${fill}" fill-opacity="0.18" stroke="${stroke}" stroke-width="1.2" />
        <text x="${n.x.toFixed(1)}" y="${(n.y + 3).toFixed(1)}" text-anchor="middle" font-family="var(--ed-mono, ui-monospace, monospace)" font-size="${Math.max(10, Math.min(13, n.r / 3.5)).toFixed(1)}" fill="rgba(245,243,238,0.92)" style="letter-spacing:0.04em;">${escHtml(label)}</text>
        <text x="${n.x.toFixed(1)}" y="${(n.y + n.r + 14).toFixed(1)}" text-anchor="middle" font-family="var(--ed-mono, ui-monospace, monospace)" font-size="9.5" fill="rgba(245,243,238,0.55)" style="letter-spacing:0.16em;">${n.size}</text>
      </g>
    `;
  }).join("");

  // Side panel — when a tag is focused, list its teams + people.
  let panel = "";
  if (activeNode) {
    const tList = (activeNode.teams || []).map(rid => {
      const t = teams.find(x => x.record_id === rid);
      return `<li class="alch-atlas-li" data-atlas-go-team="${escAttr(rid)}">${escHtml(t?.name || rid)}</li>`;
    }).join("");
    const pList = (activeNode.people || []).map(rid => {
      const p = people.find(x => x.record_id === rid);
      return `<li class="alch-atlas-li" data-atlas-go-person="${escAttr(rid)}">${escHtml(p?.name || rid)}</li>`;
    }).join("");
    panel = `
      <aside class="alch-atlas-panel">
        <header class="alch-atlas-panel-head">
          <h3 class="alch-atlas-panel-title">${escHtml(activeNode.tag)}</h3>
          <span class="alch-atlas-panel-count">${activeNode.size}</span>
          <button class="alch-atlas-panel-x" type="button" data-atlas-clear="1" aria-label="clear focus">×</button>
        </header>
        ${tList ? `<section class="alch-atlas-panel-section"><h4 class="alch-atlas-panel-h">teams (${activeNode.teams.length})</h4><ul class="alch-atlas-ul">${tList}</ul></section>` : ""}
        ${pList ? `<section class="alch-atlas-panel-section"><h4 class="alch-atlas-panel-h">people (${activeNode.people.length})</h4><ul class="alch-atlas-ul">${pList}</ul></section>` : ""}
      </aside>
    `;
  }

  state.canvas.innerHTML = `
    <header class="alch-atlas-head">
      <h2 class="alch-atlas-title">atlas</h2>
      <p class="alch-atlas-sub">${nodes.length} skill_areas tags · ${totalTeams} teams · ${totalPeople} people · bubble size = members carrying the tag · click a bubble to inspect</p>
    </header>
    <div class="alch-atlas-stage" data-active="${active ? "1" : "0"}">
      <svg class="alch-atlas-svg" viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet">
        <g class="alch-atlas-edges">${edgeSvg}</g>
        <g class="alch-atlas-nodes">${nodeSvg}</g>
      </svg>
      ${panel}
    </div>
    <p class="alch-callout"><strong>atlas · v0.1</strong><br/>
    flat folksonomy of the cohort's controlled-vocab skill_areas. no proficiency, no ranking — just adjacency. populated from every team's + person's record. add a tag to your record via <button class="alch-link-btn" data-go="profile">profile</button> and it shows up here on the next build.</p>
  `;
}

function wireAtlas() {
  for (const g of state.canvas.querySelectorAll(".alch-atlas-node[data-atlas-tag]")) {
    g.addEventListener("click", () => {
      const tag = g.dataset.atlasTag;
      state.atlasFocus = (state.atlasFocus === tag) ? null : tag;
      render();
    });
  }
  const clr = state.canvas.querySelector("[data-atlas-clear]");
  if (clr) clr.addEventListener("click", () => { state.atlasFocus = null; render(); });
  for (const li of state.canvas.querySelectorAll("[data-atlas-go-team]")) {
    li.addEventListener("click", () => openDetail(li.dataset.atlasGoTeam));
  }
  for (const li of state.canvas.querySelectorAll("[data-atlas-go-person]")) {
    li.addEventListener("click", () => openDetail(li.dataset.atlasGoPerson));
  }
  for (const b of state.canvas.querySelectorAll(".alch-link-btn[data-go='profile']")) {
    b.addEventListener("click", () => {
      state.mode = "profile";
      try { localStorage.setItem(ALCHEMY_LS_KEY, "profile"); } catch {}
      syncRailSelection();
      render();
    });
  }
}

// ── Dossier export — multi-card PNG of all teams + projects ─────────
// Renders each team/project as a card with shape glyph, kind tag,
// focus, lead, and member count to a single offscreen canvas, then
// pipes through the same IPC PNG save flow.
async function exportDossier() {
  const all = (state.cohort?.teams || []).slice();
  const people = state.cohort?.people || [];
  if (all.length === 0) return;
  // Sort teams first by kind (team > project), then alpha.
  all.sort((a, b) => {
    const ak = (a.kind || "team") === "team" ? 0 : 1;
    const bk = (b.kind || "team") === "team" ? 0 : 1;
    if (ak !== bk) return ak - bk;
    return String(a.name).localeCompare(String(b.name));
  });

  // Group people by team id so each card can list members inline.
  const peopleByTeam = new Map();
  for (const p of people) {
    const k = p.team;
    if (!k) continue;
    if (!peopleByTeam.has(k)) peopleByTeam.set(k, []);
    peopleByTeam.get(k).push(p);
  }
  // Sort each team's members: lead first, then alpha.
  for (const arr of peopleByTeam.values()) {
    arr.sort((a, b) => {
      const al = a.role === "lead" ? 0 : 1;
      const bl = b.role === "lead" ? 0 : 1;
      if (al !== bl) return al - bl;
      return String(a.name || a.record_id).localeCompare(String(b.name || b.record_id));
    });
  }

  // Layout: 3-column grid, card 380×260 + 24px gutter, plus header.
  const cols = 3;
  const cardW = 380;
  const cardH = 260;
  const gap = 24;
  const padL = 56;
  const padT = 140;     // header
  const padR = 56;
  const padB = 56;
  const rows = Math.ceil(all.length / cols);
  const W = padL + cols * cardW + (cols - 1) * gap + padR;
  const H = padT + rows * cardH + (rows - 1) * gap + padB;

  const cnv = document.createElement("canvas");
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  cnv.width  = Math.round(W * dpr);
  cnv.height = Math.round(H * dpr);
  const ctx = cnv.getContext("2d");
  ctx.scale(dpr, dpr);

  // Background — same warm radial as the app.
  const bg = ctx.createRadialGradient(W / 2, -100, 100, W / 2, H / 2, Math.max(W, H));
  bg.addColorStop(0, "#17140f");
  bg.addColorStop(1, "#0a0908");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // ── Header ─────────────────────────────────────────────────────────
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.fillStyle = CAL_INK_1;
  ctx.font = `italic 44px "Iowan Old Style", "Hoefler Text", Georgia, serif`;
  ctx.globalAlpha = 0.96;
  ctx.fillText("cohort dossier", padL, 64);
  ctx.font = `400 13px "Geist Mono", "Berkeley Mono", ui-monospace, monospace`;
  ctx.globalAlpha = 0.55;
  const nTeams = all.filter(t => (t.kind || "team") === "team").length;
  const nProjects = all.filter(t => (t.kind || "team") === "project").length;
  ctx.fillText(`shape rotator · summer 2026 · ${nTeams} teams · ${nProjects} projects · ${people.length} individuals`,
               padL, 90);
  ctx.globalAlpha = 1;
  // Hairline rule under header
  ctx.strokeStyle = "rgba(245, 243, 238, 0.16)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, padT - 24 + 0.5);
  ctx.lineTo(W - padR, padT - 24 + 0.5);
  ctx.stroke();

  // ── Cards ──────────────────────────────────────────────────────────
  for (let i = 0; i < all.length; i++) {
    const t = all[i];
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = padL + col * (cardW + gap);
    const y = padT + row * (cardH + gap);
    drawDossierCard(ctx, t, peopleByTeam.get(t.record_id) || [], x, y, cardW, cardH);
  }

  // Footer
  ctx.fillStyle = CAL_INK_3;
  ctx.globalAlpha = 0.55;
  ctx.font = `400 11px "Geist Mono", ui-monospace, monospace`;
  ctx.textAlign = "right";
  ctx.fillText("generated by shape rotator field guide · " + new Date().toISOString().slice(0, 10),
               W - padR, H - 28);
  ctx.globalAlpha = 1;
  ctx.textAlign = "left";

  // Export through the same IPC path as the calendar — but pass a
  // distinct filename so the saved file isn't called "cohort-calendar".
  const dataUrl = cnv.toDataURL("image/png");
  const stamp = new Date().toISOString().slice(0, 10);
  if (window.api?.exportCalendar) {
    const r = await window.api.exportCalendar({
      format: "png",
      dataUrl,
      filename: `cohort-dossier-${stamp}`,
    });
    if (r?.ok) {
      const c = document.querySelector(".alch-callout");
      if (c) {
        const note = document.createElement("div");
        note.style.cssText = "margin-top:8px;color:#f5f3ee;opacity:0.85;font-family:var(--ed-mono);font-size:11px;letter-spacing:0.16em;text-transform:lowercase";
        note.textContent = `dossier saved → ${r.path}`;
        c.appendChild(note);
        setTimeout(() => { try { note.remove(); } catch {} }, 6000);
      }
    }
  } else {
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = `cohort-dossier-${stamp}.png`;
    a.click();
  }
}

function drawDossierCard(ctx, team, members, x, y, w, h) {
  // Card background — slight vertical gradient
  const grad = ctx.createLinearGradient(x, y, x, y + h);
  grad.addColorStop(0, "#15120e");
  grad.addColorStop(1, "#0e0c0a");
  ctx.fillStyle = grad;
  ctx.fillRect(x, y, w, h);
  // Top hairline rule (matches the app's "border-top only" card style)
  ctx.strokeStyle = "rgba(245, 243, 238, 0.10)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, y + 0.5);
  ctx.lineTo(x + w, y + 0.5);
  ctx.stroke();

  // ── Tag row: SHAPE-NN · KIND · DOMAIN ─────────────────────────────
  ctx.font = `500 9.5px "Geist Mono", ui-monospace, monospace`;
  ctx.fillStyle = CAL_INK_1;
  ctx.globalAlpha = 0.55;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  const tagParts = [
    String(team.record_id || "").toUpperCase(),
    String(team.kind || "team").toUpperCase(),
    String(team.domain || "—").toUpperCase(),
  ];
  // Pseudo letter-spacing
  let tx = x + 20;
  const tag = tagParts.join("  ·  ");
  for (const ch of tag) {
    ctx.fillText(ch, tx, y + 26);
    tx += ctx.measureText(ch).width + 1.2;
  }
  ctx.globalAlpha = 1;

  // ── Shape glyph (left) ─────────────────────────────────────────────
  const glyphSize = 88;
  const glyphX = x + 20;
  const glyphY = y + 42;
  drawShapeGlyph(ctx, team.shape, team.kind, team.record_id || team.name || "_",
                 glyphX, glyphY, glyphSize);

  // ── Name (right, large italic Iowan) ──────────────────────────────
  const textX = glyphX + glyphSize + 22;
  ctx.font = `italic 26px "Iowan Old Style", "Hoefler Text", Georgia, serif`;
  ctx.fillStyle = CAL_INK_1;
  ctx.globalAlpha = 0.96;
  ctx.fillText(team.name || "—", textX, glyphY + 26);

  // ── Focus (italic, smaller) ────────────────────────────────────────
  if (team.focus) {
    ctx.font = `italic 13.5px "Iowan Old Style", "Hoefler Text", Georgia, serif`;
    ctx.globalAlpha = 0.78;
    wrapText(ctx, team.focus, textX, glyphY + 50, w - (textX - x) - 20, 18, 3);
  }
  ctx.globalAlpha = 1;

  // ── Meta strip (GEO · #CONTRIBUTORS) at bottom-left ───────────────
  // Two columns (LEAD column was retired with the lead field). The full
  // contributor list still renders below as the ROSTER row.
  const colGeoX        = x + 20;
  const colMembersX    = x + 220;
  const colGeoW        = (colMembersX - colGeoX) - 10;
  const colMembersW    = (x + w - 20) - colMembersX;

  ctx.font = `500 9.5px "Geist Mono", ui-monospace, monospace`;
  ctx.fillStyle = CAL_INK_1;
  ctx.globalAlpha = 0.42;
  ctx.fillText("GEO",          colGeoX,     y + h - 70);
  ctx.fillText("CONTRIBUTORS", colMembersX, y + h - 70);
  ctx.globalAlpha = 0.88;
  ctx.font = `500 12px "Geist Mono", ui-monospace, monospace`;
  ctx.fillText(truncateText(ctx, team.geo || "—", colGeoW), colGeoX, y + h - 52);
  ctx.fillText(truncateText(ctx, String(members.length || team.members_count || 0), colMembersW), colMembersX, y + h - 52);

  // ── Member chips ───────────────────────────────────────────────────
  if (members.length) {
    ctx.font = `400 10px "Geist Mono", ui-monospace, monospace`;
    ctx.fillStyle = CAL_INK_1;
    ctx.globalAlpha = 0.42;
    ctx.fillText("ROSTER", x + 20, y + h - 28);
    ctx.globalAlpha = 0.85;
    ctx.font = `italic 12px "Iowan Old Style", Georgia, serif`;
    const rosterX = x + 70;
    const rosterW = (x + w - 20) - rosterX;
    const names = members.slice(0, 5).map(m => m.name || m.record_id).join("  ·  ");
    const suffix = members.length > 5 ? `  · +${members.length - 5}` : "";
    ctx.fillText(truncateText(ctx, names + suffix, rosterW), rosterX, y + h - 28);
  }
  ctx.globalAlpha = 1;
}

function drawShapeGlyph(ctx, shapeKey, kind, seed, x, y, size) {
  const cx = x + size / 2;
  const cy = y + size / 2;
  const r = size * 0.42;
  const colors = personColors(seed);
  const c1 = hsl(colors.hue, 0.70, 0.55, 1);
  const c2 = hsl(colors.hue2, 0.72, 0.60, 1);

  // Soft gradient backdrop (square card behind the silhouette)
  ctx.fillStyle = "rgba(245, 243, 238, 0.02)";
  ctx.fillRect(x, y, size, size);

  // Silhouette path per shape key. Kind=project gets stitched stroke;
  // person doesn't apply here (dossier is teams + projects only).
  ctx.lineWidth = 4;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  ctx.beginPath();
  switch (shapeKey) {
    case "torus":
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      break;
    case "scaffold":
      ctx.rect(cx - r * 0.82, cy - r * 0.82, r * 1.64, r * 1.64);
      break;
    case "hex": {
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i - Math.PI / 2;
        const px = cx + Math.cos(a) * r;
        const py = cy + Math.sin(a) * r;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      break;
    }
    case "prism":
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx + r * 0.866, cy + r * 0.5);
      ctx.lineTo(cx - r * 0.866, cy + r * 0.5);
      ctx.closePath();
      break;
    case "meridian":
      ctx.arc(cx, cy, r, Math.PI, 0, false);
      ctx.lineTo(cx - r, cy);
      ctx.closePath();
      break;
    case "plate":
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx + r, cy);
      ctx.lineTo(cx, cy + r);
      ctx.lineTo(cx - r, cy);
      ctx.closePath();
      break;
    default:
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
  }
  // Stroke twice: thick halo in c2, sharp in c1.
  if (kind === "project") ctx.setLineDash([4, 3]);
  ctx.strokeStyle = c2;
  ctx.globalAlpha = 0.35;
  ctx.lineWidth = 10;
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = c1;
  ctx.lineWidth = 2.5;
  ctx.stroke();
  ctx.setLineDash([]);
  // Inner dot
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.15, 0, Math.PI * 2);
  ctx.fillStyle = c2;
  ctx.fill();
}

function wrapText(ctx, text, x, y, maxW, lineH, maxLines) {
  const words = String(text).split(/\s+/);
  let line = "";
  let lines = 0;
  for (let n = 0; n < words.length; n++) {
    const test = line ? line + " " + words[n] : words[n];
    if (ctx.measureText(test).width > maxW && line) {
      ctx.fillText(line, x, y + lines * lineH);
      lines++;
      if (lines >= maxLines) {
        ctx.fillText("…", x + ctx.measureText(line).width + 2, y + (lines - 1) * lineH);
        return;
      }
      line = words[n];
    } else {
      line = test;
    }
  }
  if (line) ctx.fillText(line, x, y + lines * lineH);
}

function truncateText(ctx, text, maxW) {
  const s = String(text);
  if (ctx.measureText(s).width <= maxW) return s;
  const ell = "…";
  let lo = 0, hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(s.slice(0, mid) + ell).width <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return s.slice(0, lo) + ell;
}

async function exportCalendar(format) {
  const cnv = document.getElementById("cal-canvas");
  if (!cnv) return;
  if (format === "png") {
    // Snapshot the canvas as PNG. Routed through Electron IPC so we get
    // a native save dialog instead of a browser blob download.
    const dataUrl = cnv.toDataURL("image/png");
    if (window.api?.exportCalendar) {
      const r = await window.api.exportCalendar({ format: "png", dataUrl });
      announceExport(r);
    } else {
      // Fallback for non-Electron contexts: trigger a download link.
      const a = document.createElement("a");
      a.href = dataUrl;
      a.download = `cohort-calendar-${new Date().toISOString().slice(0,10)}.png`;
      a.click();
    }
  } else if (format === "pdf") {
    // For PDF we ask the main process to embed the canvas image into a
    // single-page PDF at the canvas's pixel dimensions. printToPDF would
    // capture the WHOLE app chrome which is not what we want.
    const dataUrl = cnv.toDataURL("image/png");
    if (window.api?.exportCalendar) {
      const r = await window.api.exportCalendar({ format: "pdf", dataUrl, w: cnv.width, h: cnv.height });
      announceExport(r);
    }
  }
}
function announceExport(r) {
  if (!r) return;
  if (r.ok) {
    // Toast-style transient confirmation using the existing callout.
    const c = document.querySelector(".alch-callout");
    if (c) {
      const note = document.createElement("div");
      note.style.cssText = "margin-top:8px;color:#f5f3ee;opacity:0.85;font-family:var(--ed-mono);font-size:11px;letter-spacing:0.16em;text-transform:lowercase";
      note.textContent = `saved → ${r.path}`;
      c.appendChild(note);
      setTimeout(() => { try { note.remove(); } catch {} }, 6000);
    }
  } else if (r.reason !== "cancelled") {
    console.warn("[calendar] export failed:", r);
  }
}

// ─── detail page (full-canvas team / project profile) ────────────────
// Replaces the side drawer for a roomier read. Same data, more space:
// hero (shape glyph + name + kind), about, credentials, links, members,
// synergy clusters. Entered by clicking a card; back button returns to
// the previous mode (typically shapes).
function renderDetail(recordId) {
  const team = state.cohort?.teams.find(t => t.record_id === recordId);
  if (team) return renderTeamDetail(team);
  const person = (state.cohort?.people || []).find(p => p.record_id === recordId);
  if (person) return renderPersonDetail(person);
  // Record vanished (e.g. cohort republished, slug changed). Bail out
  // back to the grid rather than showing an empty page.
  closeDetail();
}

function renderTeamDetail(team) {
  const recordId = team.record_id;
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
  const editUrl = buildEditPRUrl({ recordType: "team", recordId });

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
      <div class="alch-detail-shape">${s ? `<canvas data-shape-fam="${s.fam}" data-shape-kind="${escAttr(teamKind(team))}" data-shape-seed="${escAttr(team.record_id)}"></canvas>` : ""}</div>
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
        <div class="alch-detail-row"><span class="adr-k">contributors</span><span class="adr-v">${teamPeople.length} ${teamPeople.length === 1 ? "person" : "people"}</span></div>
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
              <li class="alch-detail-person is-clickable" data-person="${escHtml(p.record_id)}" tabindex="0" role="button" aria-label="open ${escHtml(p.name || p.record_id)}">
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
  wirePersonLinks(state.canvas);
  wireExternalLinks(state.canvas);
}

function renderPersonDetail(person) {
  const recordId = person.record_id;
  const fam = Math.abs(hashStr(recordId || "_")) % 6;
  const team = person.team
    ? (state.cohort?.teams || []).find(t => t.record_id === person.team)
    : null;
  const secondary = (Array.isArray(person.secondary_teams) ? person.secondary_teams : [])
    .map(id => (state.cohort?.teams || []).find(t => t.record_id === id))
    .filter(Boolean);
  const linksRow = renderDetailLinks(person.links || {});
  const editUrl = buildEditPRUrl({ recordType: "person", recordId });
  const datesLine = (person.dates_start || person.dates_end)
    ? `${escHtml(person.dates_start || "—")} → ${escHtml(person.dates_end || "—")}`
    : "—";
  const absences = Array.isArray(person.absences) ? person.absences : [];

  state.canvas.innerHTML = `
    <header class="alch-detail-bar">
      <button class="alch-detail-back" type="button" id="alch-detail-back" aria-label="back to grid">
        <span aria-hidden="true">←</span>
        <span>back</span>
      </button>
      <div class="alch-detail-bar-tag">
        <span>${escHtml(recordId.toUpperCase())}</span>
        <span class="ct-sep">·</span>
        <span class="ct-kind ct-kind-person">individual</span>
        <span class="ct-sep">·</span>
        <span>${escHtml(domainLabel(person.domain))}</span>
      </div>
      <a href="${escHtml(editUrl)}" data-external class="alch-detail-edit" title="edit this record on github">edit on github →</a>
    </header>

    <section class="alch-detail-hero">
      <div class="alch-detail-shape"><canvas data-shape-fam="${fam}" data-shape-kind="person" data-shape-seed="${escAttr(recordId)}"></canvas></div>
      <div class="alch-detail-hero-text">
        <h2 class="alch-detail-name">${escHtml(person.name || recordId)}</h2>
        <p class="alch-detail-focus">${escHtml(person.role || "—")}</p>
        <div class="alch-detail-meta">
          <span><span class="adm-k">team</span> ${team
            ? `<button type="button" class="alch-card-member" data-person="${escHtml(team.record_id)}">${escHtml(team.name)}</button>`
            : "—"}</span>
          <span class="ct-sep">·</span>
          <span><span class="adm-k">domain</span> ${escHtml(domainLabel(person.domain))}</span>
          <span class="ct-sep">·</span>
          <span><span class="adm-k">geo</span> ${escHtml(person.geo || "—")}</span>
        </div>
      </div>
    </section>

    <div class="alch-detail-grid">
      <section class="alch-detail-section">
        <h3 class="alch-detail-h">window</h3>
        <div class="alch-detail-row"><span class="adr-k">dates</span><span class="adr-v">${datesLine}</span></div>
        ${absences.length ? `
          <div class="alch-detail-row"><span class="adr-k">absences</span><span class="adr-v">${absences.map(a =>
            `${escHtml(a.start || "—")} → ${escHtml(a.end || "—")}${a.note ? ` <span style="opacity:0.55">(${escHtml(a.note)})</span>` : ""}`
          ).join("<br/>")}</span></div>
        ` : ""}
      </section>

      ${secondary.length ? `
        <section class="alch-detail-section">
          <h3 class="alch-detail-h">also contributes to</h3>
          <ul class="alch-detail-people">
            ${secondary.map(t => `
              <li class="alch-detail-person is-clickable" data-person="${escHtml(t.record_id)}" tabindex="0" role="button" aria-label="open ${escHtml(t.name)}">
                <span class="adp-name">${escHtml(t.name)}</span>
                <span class="adp-role">${escHtml(teamKind(t))}</span>
              </li>
            `).join("")}
          </ul>
        </section>
      ` : ""}

      <section class="alch-detail-section">
        <h3 class="alch-detail-h">links</h3>
        ${linksRow}
      </section>
    </div>
  `;

  state.canvas.querySelector("#alch-detail-back")?.addEventListener("click", closeDetail);
  wirePersonLinks(state.canvas);
  wireExternalLinks(state.canvas);
}

function wirePersonLinks(root) {
  // Member chips on team cards / detail and the "team" pill on person
  // detail share the same hook: data-person="<record_id>" → openDetail.
  // stopPropagation so clicks inside a card don't also fire the card.
  const handler = (e) => {
    const id = (e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.person) || "";
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    openDetail(id);
  };
  for (const el of root.querySelectorAll("[data-person]")) {
    el.addEventListener("click", handler);
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") handler(e);
    });
  }
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
// TODO: extract this whole block into @shape-rotator/shape-ui
// (profile-form.js currently ships a minimal single-record edit form
// for the sibling web app, but the full add/edit/diff/markdown-gen
// flow below stays here because it's wired into state.profile,
// cohort-relative pickers, and steward-merge expectations that are
// out of scope for the web app today). Convergence work is Phase 2.
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
    // `lead` retired — team identity is the contributor list, derived from
    // person records. Anyone with role: "lead" on their person record is
    // still highlighted in the dossier + member views.
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
    // Program-track fields — set in week-1 office hours per the agenda.
    { key: "success_dimensions", label: "success dimensions", type: "text",     placeholder: "productization, research_lineage, collaborative — pick any subset" },
    { key: "graduation_target",  label: "graduation target",  type: "textarea", placeholder: "what 'graduating well' looks like for this project" },
    { key: "monthly_milestones", label: "monthly milestones", type: "textarea", placeholder: "rough month-by-month checkpoints (one per line)" },
    { key: "weekly_goals",       label: "this week's goals",  type: "textarea", placeholder: "concrete goal(s) for this week — refresh on monday" },
  ];
}

const PERSON_EDITABLE_FIELDS = [
  { key: "name",                label: "name",                type: "text",     placeholder: "your name" },
  { key: "team",                label: "team",                type: "team-select" },
  { key: "role",                label: "role",                type: "text",     placeholder: "what you do on the team" },
  { key: "geo",                 label: "geo",                 type: "text",     placeholder: "NYC, etc." },
  { key: "domain",              label: "domain",              type: "select",   options: ["crypto", "tee", "ai", "app-ux", "bd-gtm", "design"] },
  { key: "links.github",        label: "github",              type: "text",     placeholder: "username" },
  { key: "links.x",             label: "x / twitter",         type: "text",     placeholder: "@handle" },
  { key: "links.website",       label: "website",             type: "url",      placeholder: "https://…" },
  { key: "links.linkedin",      label: "linkedin",            type: "text",     placeholder: "username" },
  // Personal-API fields. Free-text, all optional; surfaced in the onboarding
  // walkthrough + person dossier so the cohort can collaborate well.
  { key: "comm_style",          label: "comm style",          type: "textarea", placeholder: "sync vs async, DM vs issue, fastest path to reach you" },
  { key: "contribute_interests",label: "contribute interests",type: "textarea", placeholder: "what you'd happily pair on for other people's projects" },
  { key: "availability_pref",   label: "availability rhythm", type: "textarea", placeholder: "heads-down hours, no-meet days, time zone notes" },
  { key: "weekly_intention",    label: "this week's intention", type: "textarea", placeholder: "one concrete thing you want to ship or learn this week" },
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
    } else if (f.type === "textarea") {
      input = `<textarea name="${escAttr(f.key)}" rows="3" placeholder="${escAttr(f.placeholder || "")}">${escHtml(display)}</textarea>`;
    } else {
      input = `<input type="${f.type}" name="${escAttr(f.key)}" value="${escAttr(display)}" placeholder="${escAttr(f.placeholder || "")}" />`;
    }
    const rowCls = (f.type === "textarea") ? "alch-pf-row alch-pf-row-wide" : "alch-pf-row";
    return `<label class="${rowCls}"><span>${escHtml(f.label)}</span>${input}</label>`;
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

// Emit a YAML scalar — quoted on a single line for short strings, or as a
// literal block (`|`) for anything containing a newline. `indent` is the
// number of spaces a continuation line should sit at (the key's column
// + 2). Used for textarea-backed fields like weekly_goals, monthly_milestones,
// and the personal-API fields where multiline content matters.
function yamlScalar(value, indent = 2) {
  if (value == null || value === "") return "null";
  const s = String(value);
  if (!/\n/.test(s)) return quoteYaml(s);
  const pad = " ".repeat(indent);
  // Strip trailing whitespace; rejoin with leading indent. Block-scalar
  // `|` preserves newlines verbatim; we don't strip blank lines because
  // they may be load-bearing in the user's prose.
  const lines = s.replace(/\s+$/, "").split(/\r?\n/).map(l => pad + l);
  return `|\n${lines.join("\n")}`;
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
members_count: ${draft.members_count == null ? "null" : Number(draft.members_count)}
geo: ${quoteYaml(draft.geo || "")}
domain: ${draft.domain || "null"}
shape: ${draft.shape || "null"}
is_mentor: ${draft.is_mentor ? "true" : "false"}
${linksBlock}
paper_basis: ${draft.paper_basis ? quoteYaml(draft.paper_basis) : "null"}
traction: ${draft.traction ? quoteYaml(draft.traction) : "null"}
hackathon_note: ${draft.hackathon_note ? quoteYaml(draft.hackathon_note) : "null"}
success_dimensions: ${yamlScalar(draft.success_dimensions)}
graduation_target: ${yamlScalar(draft.graduation_target)}
monthly_milestones: ${yamlScalar(draft.monthly_milestones)}
weekly_goals: ${yamlScalar(draft.weekly_goals)}
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
comm_style: ${yamlScalar(draft.comm_style)}
contribute_interests: ${yamlScalar(draft.contribute_interests)}
availability_pref: ${yamlScalar(draft.availability_pref)}
weekly_intention: ${yamlScalar(draft.weekly_intention)}
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
    // Top-level key — block-scalar continuation indents 2 spaces.
    lines.push(`${k}: ${formatYamlValue(v, 2)}`);
  }
  for (const [parent, kids] of Object.entries(nested)) {
    lines.push(`${parent}:`);
    for (const [k, v] of Object.entries(kids)) {
      // Nested under `parent:` — continuation indents 4 spaces.
      lines.push(`  ${k}: ${formatYamlValue(v, 4)}`);
    }
  }
  return lines.join("\n");
}
function formatYamlValue(v, indent = 2) {
  if (v == null || v === "") return "null";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return String(v);
  // String. Multiline → block scalar; single-line → quoted.
  return yamlScalar(v, indent);
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

// escAttr lives in @shape-rotator/shape-ui now (imported at the top).

