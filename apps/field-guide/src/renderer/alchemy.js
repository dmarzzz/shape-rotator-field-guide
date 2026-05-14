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
} from "@shape-rotator/shape-ui";
import { getCohortSurface, subscribeToCohortChanges } from "./cohort-source.js";

const ALCHEMY_LS_KEY  = "srwk:alchemy_mode";
const PROFILE_LS_KEY  = "srwk:profile_v1";
const EVENTS_LS_KEY   = "srwk:cohort_events_v1";
const DETAIL_LS_KEY   = "srwk:alchemy_detail_v1";
const ALCHEMY_MODES   = ["feed", "shapes", "pulse", "constellation", "calendar", "profile"];

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
  shapesQuery: "",            // free-text filter applied to the shapes grid
  detailRecordId: null,     // when set, the alchemy canvas renders the full detail page for this team/project
  detailReturnMode: null,   // remembered so the back button knows where to land
  shapeControllers: [],     // active shader-canvas controllers — destroyed before each re-render so GL contexts don't leak
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
        <button class="alch-shapes-chip" data-shapes-filter="works"  type="button" aria-selected="${filter === "works"}">teams <span class="ascn">${nWorks}</span></button>
        <button class="alch-shapes-chip" data-shapes-filter="people" type="button" aria-selected="${filter === "people"}">individuals <span class="ascn">${nPeople}</span></button>
      </nav>
      <div class="alch-shapes-search" role="search">
        <input id="alch-shapes-search-input" type="search" autocomplete="off" spellcheck="false"
               placeholder="search ${filter === "people" ? "individuals" : "teams"} by name, focus, geo…"
               value="${escHtml(state.shapesQuery || "")}" />
      </div>
      <button id="dossier-export-png" class="cal-action" type="button">export dossier (png)</button>
    </div>
  `;
  // Build a parallel array of search blobs so the input can hide non-
  // matching cards in place without re-rendering (preserves focus + caret).
  const blobs = records.map(r => r._kind === "person"
    ? searchBlobForPerson(r)
    : searchBlobForTeam(r, allPeople)
  );
  const cards = records.map((r, idx) => {
    if (r._kind === "person") return personCardHtml(r, idx);
    return teamCardHtml(r, idx);
  }).join("");
  const grid = records.length
    ? `<div class="alch-specimens">${cards}<p class="alch-shapes-empty" hidden>no matches.</p></div>`
    : `<p class="alch-pf-pick">no ${escHtml(filter)} records yet — switch to the <strong>profile</strong> tab and use <strong>add</strong> to create one.</p>`;
  state.canvas.innerHTML = `
    ${chips}
    ${grid}
    <p class="alch-callout"><strong>shapes · v0.1</strong><br/>
    Each card is a team, project or individual in its current shape (week ${WEEK_NOW}). Teams render as their starting domain shape; projects share the team vocabulary with a stitched rim; individuals render as a portrait medallion.</p>
  `;
  // Attach the search blob to each card so the filter doesn't have to
  // re-derive it on every keystroke.
  const cardEls = state.canvas.querySelectorAll(".alch-specimens > .alch-card");
  cardEls.forEach((el, i) => { el.dataset.searchBlob = blobs[i] || ""; });
  applyShapesSearch(state.shapesQuery || "");
  // Wire the kind filter chips.
  for (const btn of state.canvas.querySelectorAll(".alch-shapes-chip[data-shapes-filter]")) {
    btn.addEventListener("click", () => {
      const next = btn.dataset.shapesFilter;
      if (next === state.shapesKindFilter) return;
      state.shapesKindFilter = next;
      renderShapes();
    });
  }
  // Wire the search input.
  const search = document.getElementById("alch-shapes-search-input");
  if (search) {
    search.addEventListener("input", () => applyShapesSearch(search.value));
    search.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && search.value) {
        search.value = "";
        applyShapesSearch("");
      }
    });
  }
  // Wire the dossier export button.
  const dossierBtn = document.getElementById("dossier-export-png");
  if (dossierBtn) dossierBtn.addEventListener("click", exportDossier);
}

function searchBlobForTeam(t, allPeople) {
  const members = (allPeople || []).filter(p =>
    p.team === t.record_id ||
    (Array.isArray(p.secondary_teams) && p.secondary_teams.includes(t.record_id))
  );
  return [
    t.name, t.record_id, t.focus, t.lead, t.geo,
    domainLabel(t.domain), teamKind(t),
    ...members.map(m => m.name || m.record_id),
  ].filter(Boolean).join(" ").toLowerCase();
}

function searchBlobForPerson(p) {
  return [
    p.name, p.record_id, p.role, p.geo, p.team,
    domainLabel(p.domain),
    ...(Array.isArray(p.secondary_teams) ? p.secondary_teams : []),
  ].filter(Boolean).join(" ").toLowerCase();
}

function applyShapesSearch(query) {
  state.shapesQuery = query;
  const q = String(query || "").trim().toLowerCase();
  const cards = state.canvas?.querySelectorAll(".alch-specimens > .alch-card");
  if (!cards) return;
  let visible = 0;
  for (const c of cards) {
    const blob = c.dataset.searchBlob || "";
    const hit = !q || blob.includes(q);
    c.classList.toggle("is-hidden", !hit);
    if (hit) visible++;
  }
  const empty = state.canvas.querySelector(".alch-shapes-empty");
  if (empty) empty.hidden = !(q && visible === 0);
}

function teamCardHtml(t, idx) {
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
  const m = Number(t.members_count) || 0;
  const kind = teamKind(t);
  // People whose primary `team` or `secondary_teams` includes this record.
  const teamPeople = (state.cohort?.people || []).filter(p =>
    p.team === t.record_id || (Array.isArray(p.secondary_teams) && p.secondary_teams.includes(t.record_id))
  );
  const membersRow = teamPeople.length
    ? `<div class="alch-card-meta-row alch-card-members-row">
         <span class="cm-k">${kind === "project" ? "contributors" : "members"}</span>
         <span class="cm-v">${teamPeople.map(p =>
           `<button type="button" class="alch-card-member" data-person="${escHtml(p.record_id)}">${escHtml(p.name || p.record_id)}</button>`
         ).join('<span class="acm-sep">·</span>')}</span>
       </div>`
    : "";
  return `
    <article class="${cardCls}" data-record-id="${escHtml(t.record_id)}" data-display-id="${displayId(idx)}" tabindex="0" role="button" aria-label="${escHtml(t.name)} — open detail">
      <div class="alch-card-tag">
        <span class="ct-id">SHAPE-${displayId(idx)}</span>
        <span class="ct-sep">·</span>
        <span class="ct-kind ct-kind-${escHtml(kind)}">${escHtml(kind)}</span>
        <span class="ct-sep">·</span>
        <span>${escHtml(s ? s.name : domainLabel(t.domain))}</span>
        <span class="ct-sep">·</span>
        <span>${escHtml(domainLabel(t.domain))}</span>
        ${t.is_mentor ? `<span class="ct-sep">·</span><span>mentor</span>` : ""}
      </div>
      <div class="alch-card-shape"><canvas data-shape-fam="${s ? s.fam : 0}" data-shape-kind="${escAttr(kind)}" data-shape-seed="${escAttr(t.record_id)}"></canvas></div>
      <div class="alch-card-name">${escHtml(t.name)}</div>
      <div class="alch-card-rule"></div>
      <div class="alch-card-meta">
        <div class="alch-card-meta-row"><span class="cm-k">focus</span><span class="cm-v">${escHtml(t.focus)}</span></div>
        <div class="alch-card-meta-row"><span class="cm-k">lead</span><span class="cm-v">${escHtml(t.lead)}</span></div>
        <div class="alch-card-meta-row"><span class="cm-k">${kind === "project" ? "contributors" : "team"}</span><span class="cm-v">${m} ${m === 1 ? "person" : "people"}</span></div>
        <div class="alch-card-meta-row"><span class="cm-k">geo</span><span class="cm-v">${escHtml(t.geo)}</span></div>
        ${membersRow}
        ${links.join("")}
      </div>
    </article>`;
}

function personCardHtml(p, idx) {
  // People don't have a shape vocabulary — derive a fam from their
  // record_id hash purely so the per-family rotation/symmetry/specimen
  // varies between individuals. The shader sees u_kind=2 and overrides
  // the silhouette to a circle medallion regardless.
  const fam = Math.abs(hashStr(p.record_id || "_")) % 6;
  const links = [];
  const gh = p?.links?.github;
  const x  = p?.links?.x;
  const w  = p?.links?.website;
  const li = p?.links?.linkedin;
  if (gh) links.push(`<div class="alch-card-meta-row"><span class="cm-k">github</span><span class="cm-v"><a href="https://github.com/${escHtml(gh)}" data-external>${escHtml(gh)}</a></span></div>`);
  if (x)  links.push(`<div class="alch-card-meta-row"><span class="cm-k">x</span><span class="cm-v"><a href="https://x.com/${escHtml(x.replace(/^@/, ""))}" data-external>@${escHtml(x.replace(/^@/, ""))}</a></span></div>`);
  if (w)  links.push(`<div class="alch-card-meta-row"><span class="cm-k">site</span><span class="cm-v"><a href="${escHtml(w.startsWith("http") ? w : `https://${w}`)}" data-external>${escHtml(w.replace(/^https?:\/\//, ""))}</a></span></div>`);
  if (li) links.push(`<div class="alch-card-meta-row"><span class="cm-k">linkedin</span><span class="cm-v"><a href="https://linkedin.com/in/${escHtml(li)}" data-external>${escHtml(li)}</a></span></div>`);
  if (!gh && !x && !w && !li) links.push(`<div class="alch-card-meta-row"><span class="cm-k">links</span><span class="cm-v" style="opacity:0.55">— not yet submitted</span></div>`);
  return `
    <article class="alch-card is-clickable alch-card-person" data-record-id="${escHtml(p.record_id)}" data-display-id="${displayId(idx)}" tabindex="0" role="button" aria-label="${escHtml(p.name)} — open profile">
      <div class="alch-card-tag">
        <span class="ct-id">PERSON-${displayId(idx)}</span>
        <span class="ct-sep">·</span>
        <span class="ct-kind ct-kind-person">individual</span>
        <span class="ct-sep">·</span>
        <span>${escHtml(domainLabel(p.domain))}</span>
      </div>
      <div class="alch-card-shape"><canvas data-shape-fam="${fam}" data-shape-kind="person" data-shape-seed="${escAttr(p.record_id)}"></canvas></div>
      <div class="alch-card-name">${escHtml(p.name)}</div>
      <div class="alch-card-rule"></div>
      <div class="alch-card-meta">
        <div class="alch-card-meta-row"><span class="cm-k">role</span><span class="cm-v">${escHtml(p.role || "—")}</span></div>
        <div class="alch-card-meta-row"><span class="cm-k">team</span><span class="cm-v">${escHtml(p.team || "—")}</span></div>
        <div class="alch-card-meta-row"><span class="cm-k">geo</span><span class="cm-v">${escHtml(p.geo || "—")}</span></div>
        ${links.join("")}
      </div>
    </article>`;
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
function fmtMonth(d) {
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).toLowerCase();
}

function buildCalendarRows(cohort) {
  // Group people by team. Within each group: lead first, then alpha by name.
  // Teams without people are skipped — only show what's populated.
  // "_orphan" group (team: null) renders LAST as "individuals (no team)".
  const teams = cohort.teams || [];
  const people = cohort.people || [];
  const teamById = new Map(teams.map(t => [t.record_id, t]));

  const buckets = new Map();
  for (const p of people) {
    const key = p.team || "_orphan";
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(p);
    // Also list the person under each secondary team they touch. We
    // tag the clone with __secondary so the renderer can render them
    // with reduced emphasis (no "lead" indicator, etc.).
    const sec = Array.isArray(p.secondary_teams) ? p.secondary_teams : [];
    for (const stk of sec) {
      if (!stk) continue;
      if (!buckets.has(stk)) buckets.set(stk, []);
      buckets.get(stk).push({ ...p, __secondary: true, role: p.role === "lead" ? null : p.role });
    }
  }
  for (const arr of buckets.values()) {
    arr.sort((a, b) => {
      const al = a.role === "lead" ? 0 : 1;
      const bl = b.role === "lead" ? 0 : 1;
      if (al !== bl) return al - bl;
      return String(a.name || a.record_id).localeCompare(String(b.name || b.record_id));
    });
  }

  // Order team groups: leads-with-cards first (by team name), orphan last.
  const orderedKeys = Array.from(buckets.keys()).filter(k => k !== "_orphan").sort((a, b) => {
    const ta = teamById.get(a)?.name || a;
    const tb = teamById.get(b)?.name || b;
    return String(ta).localeCompare(String(tb));
  });
  if (buckets.has("_orphan")) orderedKeys.push("_orphan");

  const rows = [];
  for (const key of orderedKeys) {
    const t = key === "_orphan"
      ? { record_id: "_orphan", name: "individuals", kind: null }
      : (teamById.get(key) || { record_id: key, name: key, kind: null });
    rows.push({ type: "team", team: t });
    for (const p of buckets.get(key)) rows.push({ type: "person", person: p, team: t });
  }
  return rows;
}

function renderCalendar() {
  const start = isoToDate(CAL_PROGRAM_START);
  const end   = isoToDate(CAL_PROGRAM_END);
  const numDays = daysBetween(start, end) + 1;
  const rows = buildCalendarRows(state.cohort || {});
  // Compute total height: each team header + each person row.
  let bodyH = 0;
  for (const r of rows) bodyH += (r.type === "team" ? CAL_TEAM_H : CAL_ROW_H);
  const w = CAL_LEFT_W + numDays * CAL_DAY_W + CAL_PAD_R;
  const h = CAL_HEADER_H + bodyH + CAL_FOOTER_H + CAL_PAD_B;

  const numPeople = rows.filter(r => r.type === "person").length;
  const numTeamGroups = rows.filter(r => r.type === "team").length;

  state.canvas.innerHTML = `
    <header class="cal-page-head">
      <div class="cal-page-title">cohort calendar</div>
      <div class="cal-page-sub">${escHtml(fmtShortDate(start))} → ${escHtml(fmtShortDate(end))} · ${numPeople} individuals · ${numTeamGroups} groups</div>
      <div class="cal-page-actions">
        <button id="cal-export-png" class="cal-action" type="button">export png</button>
        <button id="cal-export-pdf" class="cal-action" type="button">export pdf</button>
      </div>
    </header>
    <div class="cal-scroll">
      <canvas id="cal-canvas" width="${w}" height="${h}" style="width:${w}px; height:${h}px;"></canvas>
    </div>
    <p class="alch-callout"><strong>cohort calendar · v0.1</strong><br/>
    each row is one individual. the filled bar is their overall window in the cohort; striped sections are absences (vacations, conferences, remote weeks). a vertical mark shows today. export the full canvas as a PNG to share over messaging — renders inline in iMessage/Slack/Discord.</p>
  `;

  const cnv = document.getElementById("cal-canvas");
  if (!cnv) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  cnv.width  = Math.round(w * dpr);
  cnv.height = Math.round(h * dpr);
  cnv.style.width  = w + "px";
  cnv.style.height = h + "px";
  const ctx = cnv.getContext("2d");
  ctx.scale(dpr, dpr);
  drawCalendar(ctx, w, h, rows, start, end, numDays);
}

function drawCalendar(ctx, W, H, rows, start, end, numDays) {
  // Background.
  ctx.fillStyle = CAL_BG;
  ctx.fillRect(0, 0, W, H);

  const gridX = CAL_LEFT_W;
  const gridY = CAL_HEADER_H;
  const gridW = numDays * CAL_DAY_W;
  // Compute body height from rows.
  let bodyH = 0;
  for (const r of rows) bodyH += (r.type === "team" ? CAL_TEAM_H : CAL_ROW_H);
  const gridH = bodyH;

  // ── Concurrent-headcount strip ─────────────────────────────────────
  // Above the date axis: a 32px-tall area chart of "people on-site per
  // day" — counts every person whose window covers the day AND who is
  // not in an absence for that day. Glance-readable density.
  drawHeadcountStrip(ctx, rows, start, numDays, gridX);

  // ── Month band — italic Iowan, with a thin baseline above
  ctx.strokeStyle = CAL_RULE;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(gridX, CAL_DENSITY_H + 14 + 0.5);
  ctx.lineTo(gridX + numDays * CAL_DAY_W, CAL_DENSITY_H + 14 + 0.5);
  ctx.stroke();
  ctx.font = `italic 22px "Iowan Old Style", "Hoefler Text", Georgia, serif`;
  ctx.fillStyle = CAL_INK_1;
  ctx.textBaseline = "alphabetic";
  let segStart = 0;
  let segDate = new Date(start);
  for (let i = 1; i <= numDays; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    const isLast = i === numDays;
    if (d.getUTCMonth() !== segDate.getUTCMonth() || isLast) {
      const endIdx = isLast ? numDays : i;
      const x = gridX + segStart * CAL_DAY_W;
      const wSeg = (endIdx - segStart) * CAL_DAY_W;
      ctx.fillStyle = CAL_INK_1;
      ctx.globalAlpha = 0.88;
      ctx.fillText(fmtMonth(segDate), x + 6, CAL_DENSITY_H + 12);
      ctx.globalAlpha = 1;
      // Right hairline of month
      ctx.strokeStyle = CAL_RULE_WEEK;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + wSeg + 0.5, CAL_HEADER_H - 28);
      ctx.lineTo(x + wSeg + 0.5, CAL_HEADER_H + gridH);
      ctx.stroke();
      segStart = i;
      segDate = d;
    }
  }

  // ── Week zebra (alternating tint per week) ─────────────────────────
  // Identify Monday boundaries and group days into weeks. Even-numbered
  // weeks get a subtle warm tint behind them so the body reads as a
  // run of 7-day bands rather than a sea of identical day cells.
  // Also tints weekends a touch deeper INSIDE each week.
  let weekIdx = 0;
  let weekStartCol = 0;
  for (let i = 0; i <= numDays; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    const isMonday = i > 0 && d.getUTCDay() === 1;
    const isLast = i === numDays;
    if (isMonday || isLast) {
      const x = gridX + weekStartCol * CAL_DAY_W;
      const w = (i - weekStartCol) * CAL_DAY_W;
      if (weekIdx % 2 === 1) {
        // odd weeks (1, 3, 5, ...) — subtle warm wash
        ctx.fillStyle = "rgba(245, 243, 238, 0.022)";
        ctx.fillRect(x, gridY, w, gridH);
      }
      weekStartCol = i;
      weekIdx++;
    }
  }
  // Weekend deeper tint on top of the zebra so Sat/Sun pop within weeks.
  for (let i = 0; i < numDays; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) {
      const x = gridX + i * CAL_DAY_W;
      ctx.fillStyle = "rgba(0, 0, 0, 0.18)";
      ctx.fillRect(x, gridY, CAL_DAY_W, gridH);
    }
  }

  // ── Week labels (W01, W02, ...) above the day numbers ─────────────
  // Anchored to each Monday's column. Italic Iowan, 16px, near-pure
  // ink — these are the primary horizontal landmarks at any zoom.
  weekIdx = 0;
  for (let i = 0; i < numDays; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    if (i === 0 || d.getUTCDay() === 1) {
      weekIdx++;
      const x = gridX + i * CAL_DAY_W;
      ctx.font = `italic 16px "Iowan Old Style", "Hoefler Text", Georgia, serif`;
      ctx.fillStyle = CAL_INK_1;
      ctx.globalAlpha = 0.90;
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      ctx.fillText(`w${String(weekIdx).padStart(2, "0")}`, x + 6, CAL_HEADER_H - 38);
      ctx.globalAlpha = 1;
    }
  }

  // ── Day-of-week single-letter strip (M T W T F S S) above numbers ─
  // Adds another anchor when scanning the dense grid. Tiny mono.
  ctx.font = `500 8.5px "Geist Mono", ui-monospace, monospace`;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "center";
  const dowLetters = ["S", "M", "T", "W", "T", "F", "S"];
  for (let i = 0; i < numDays; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    const x = gridX + i * CAL_DAY_W;
    const dow = d.getUTCDay();
    const isWeekend = dow === 0 || dow === 6;
    ctx.fillStyle = CAL_INK_1;
    ctx.globalAlpha = isWeekend ? 0.32 : 0.55;
    ctx.fillText(dowLetters[dow], x + CAL_DAY_W / 2, CAL_HEADER_H - 24);
  }
  ctx.globalAlpha = 1;

  // ── Day-number strip + verticals ───────────────────────────────────
  // Numbers bumped to 12.5px monospace; Monday + first-of-month verticals
  // are STRONG (1.5px @ ~0.36 opacity) so weeks separate visibly.
  ctx.font = `500 12.5px "Geist Mono", "Berkeley Mono", ui-monospace, monospace`;
  ctx.textBaseline = "alphabetic";
  for (let i = 0; i < numDays; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    const x = gridX + i * CAL_DAY_W;
    const day = d.getUTCDate();
    const dow = d.getUTCDay();
    const isMonday = dow === 1;
    const isFirstOfMonth = day === 1;
    const isWeekend = dow === 0 || dow === 6;
    ctx.fillStyle = CAL_INK_1;
    ctx.globalAlpha = isMonday || isFirstOfMonth ? 0.95 : (isWeekend ? 0.45 : 0.72);
    ctx.textAlign = "center";
    ctx.fillText(String(day), x + CAL_DAY_W / 2, CAL_HEADER_H - 8);
    ctx.globalAlpha = 1;
    ctx.textAlign = "left";
    // Verticals: STRONG on Monday + first-of-month, faint hairline daily.
    if (isFirstOfMonth) {
      ctx.strokeStyle = "rgba(245, 243, 238, 0.42)";
      ctx.lineWidth = 2;
    } else if (isMonday) {
      ctx.strokeStyle = "rgba(245, 243, 238, 0.36)";
      ctx.lineWidth = 1.5;
    } else {
      ctx.strokeStyle = "rgba(245, 243, 238, 0.05)";
      ctx.lineWidth = 1;
    }
    ctx.beginPath();
    ctx.moveTo(x + 0.5, CAL_HEADER_H - 16);
    ctx.lineTo(x + 0.5, CAL_HEADER_H + gridH);
    ctx.stroke();
  }
  // Closing vertical at the very right edge.
  ctx.strokeStyle = "rgba(245, 243, 238, 0.36)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(gridX + numDays * CAL_DAY_W + 0.5, CAL_HEADER_H - 16);
  ctx.lineTo(gridX + numDays * CAL_DAY_W + 0.5, CAL_HEADER_H + gridH);
  ctx.stroke();

  // ── Body rows ───────────────────────────────────────────────────────
  let y = gridY;
  ctx.textBaseline = "middle";
  for (const r of rows) {
    if (r.type === "team") {
      // Stronger separator above each team — full-width rule + an
      // oxide tick at the left so the group reads as a new section.
      ctx.strokeStyle = CAL_RULE_WEEK;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(W, y + 0.5);
      ctx.stroke();
      // Per-team accent square — 4px wide, hash-derived from team id.
      // Reads as a tiny "flag" before the team name; matches the colour
      // of bars belonging to people on that team so the eye threads
      // group → individuals visually.
      const tcol = personColors(r.team.record_id || r.team.name || "_");
      ctx.fillStyle = hsl(tcol.hue, 0.70, 0.55, 1);
      ctx.fillRect(6, y + 10, 4, CAL_TEAM_H - 20);
      // Team label: MONO 11px UPPERCASE with strong tracking — same
      // chrome-label voice as the rest of the editorial UI. Indents
      // and italic serif are reserved for people rows.
      ctx.font = `500 11px "Geist Mono", "Berkeley Mono", ui-monospace, monospace`;
      ctx.fillStyle = CAL_INK_1;
      ctx.globalAlpha = 0.95;
      ctx.textAlign = "left";
      const label = String(r.team.name || "—").toUpperCase();
      // letter-spacing isn't supported on ctx.fillText directly — fake
      // it by drawing each char and advancing by measureText+track.
      const track = 1.4;          // px of extra tracking per char
      let lx = 18;
      for (const ch of label) {
        ctx.fillText(ch, lx, y + CAL_TEAM_H / 2 + 1);
        lx += ctx.measureText(ch).width + track;
      }
      // "project" subtag rendered in a smaller mono italic at the
      // right of the team name when applicable.
      if (r.team.kind === "project") {
        ctx.font = `italic 9.5px "Geist Mono", ui-monospace, monospace`;
        ctx.globalAlpha = 0.55;
        ctx.fillText("· project", lx + 6, y + CAL_TEAM_H / 2 + 1);
      }
      ctx.globalAlpha = 1;
      y += CAL_TEAM_H;
      continue;
    }
    // Person row
    const p = r.person;
    const colors = personColors(p.record_id || p.name || "_");
    drawPersonRow(ctx, p, colors, gridX, y, gridW, numDays, start, end);
    y += CAL_ROW_H;
  }

  // Bottom hairline of grid
  ctx.strokeStyle = CAL_RULE_WEEK;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, y + 0.5);
  ctx.lineTo(W, y + 0.5);
  ctx.stroke();

  // ── "Today" indicator — column band + line + glow + label puck ────
  // Always painted: if today's within the program window it gets the
  // full vertical band + ink puck at top. If today's BEFORE the window
  // (counting down to start) we render a small "+N days" tag at the
  // very left of the grid header.
  const today = new Date();
  const todayUTC = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
  const dayIdx = daysBetween(start, todayUTC);
  if (dayIdx >= 0 && dayIdx < numDays) {
    const x = gridX + dayIdx * CAL_DAY_W;
    // Full column band — 4% white wash spanning header + grid.
    ctx.fillStyle = "rgba(245, 243, 238, 0.05)";
    ctx.fillRect(x, CAL_HEADER_H - 18, CAL_DAY_W, gridH + 18);
    // Glow stroke around the column edges, soft falloff.
    const grad = ctx.createLinearGradient(x - 6, 0, x + CAL_DAY_W + 6, 0);
    grad.addColorStop(0,   "rgba(196, 64, 37, 0)");
    grad.addColorStop(0.5, "rgba(196, 64, 37, 0.10)");
    grad.addColorStop(1,   "rgba(196, 64, 37, 0)");
    ctx.fillStyle = grad;
    ctx.fillRect(x - 6, CAL_HEADER_H - 18, CAL_DAY_W + 12, gridH + 18);
    // Sharp 1px oxide hairline at center of column.
    const xc = x + CAL_DAY_W / 2;
    ctx.strokeStyle = "rgba(196, 64, 37, 0.85)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(xc, CAL_HEADER_H - 6);
    ctx.lineTo(xc, CAL_HEADER_H + gridH);
    ctx.stroke();
    // "TODAY" puck at the top of the column.
    ctx.fillStyle = CAL_OXIDE;
    const puckW = 50;
    const puckH = 16;
    const puckX = Math.max(gridX, xc - puckW / 2);
    const puckY = CAL_HEADER_H - 18;
    roundRect(ctx, puckX, puckY, puckW, puckH, 8);
    ctx.fill();
    ctx.fillStyle = "#0a0908";
    ctx.font = `600 9px "Geist Mono", "Berkeley Mono", ui-monospace, monospace`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    ctx.fillText("TODAY", puckX + puckW / 2, puckY + puckH / 2 + 0.5);
    ctx.textAlign = "left";
  } else if (dayIdx < 0) {
    // Today is before the program start — show countdown.
    const daysUntil = -dayIdx;
    const label = `T-${daysUntil} day${daysUntil === 1 ? "" : "s"}`;
    ctx.fillStyle = CAL_OXIDE;
    const puckW = ctx.measureText ? Math.max(72, label.length * 8 + 24) : 96;
    const puckH = 16;
    const puckX = gridX + 6;
    const puckY = CAL_HEADER_H - 18;
    roundRect(ctx, puckX, puckY, puckW, puckH, 8);
    ctx.fill();
    ctx.fillStyle = "#0a0908";
    ctx.font = `600 9px "Geist Mono", "Berkeley Mono", ui-monospace, monospace`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    ctx.fillText(label, puckX + puckW / 2, puckY + puckH / 2 + 0.5);
    ctx.textAlign = "left";
  }

  // ── Footer: program span + legend ──────────────────────────────────
  const footerY = CAL_HEADER_H + gridH + 18;
  ctx.font = `400 10px "Geist Mono", ui-monospace, monospace`;
  ctx.fillStyle = CAL_INK_3;
  ctx.globalAlpha = 0.7;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.fillText(`shape rotator · summer 2026 · ${fmtShortDate(start)} – ${fmtShortDate(end)}`, 20, footerY);

  // Legend: filled bar = present · striped = absence · vertical = today
  const legX = 20;
  const legY = footerY + 22;
  ctx.fillStyle = CAL_INK_2;
  // present swatch
  ctx.globalAlpha = 0.75;
  ctx.fillRect(legX, legY - 6, 30, 8);
  ctx.fillStyle = CAL_INK_2;
  ctx.fillText("present", legX + 36, legY);
  // absence swatch — diagonal stripes via pattern
  const absX = legX + 90;
  ctx.save();
  ctx.fillStyle = CAL_INK_4;
  ctx.fillRect(absX, legY - 6, 30, 8);
  ctx.strokeStyle = CAL_INK_2;
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  for (let i = 0; i < 30; i += 4) {
    ctx.moveTo(absX + i, legY + 2);
    ctx.lineTo(absX + i + 8, legY - 6);
  }
  ctx.stroke();
  ctx.restore();
  ctx.fillStyle = CAL_INK_2;
  ctx.fillText("absent", absX + 36, legY);
  // today swatch
  const todX = absX + 90;
  ctx.strokeStyle = CAL_OXIDE;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(todX + 8, legY - 8);
  ctx.lineTo(todX + 8, legY + 4);
  ctx.stroke();
  ctx.fillStyle = CAL_INK_2;
  ctx.fillText("today", todX + 18, legY);
  ctx.globalAlpha = 1;
}

function drawPersonRow(ctx, person, colors, gridX, rowY, gridW, numDays, start, end) {
  // Left label — name on top, role/email tiny underneath
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  // Italic Iowan for names — smaller than the team header (which is
  // 11px mono CAPS in white) + indented further so each row reads as
  // "child of the team group above it" rather than competing with it.
  ctx.font = `italic 13.5px "Iowan Old Style", "Hoefler Text", Georgia, serif`;
  ctx.fillStyle = CAL_INK_1;
  ctx.globalAlpha = 0.85;
  const name = person.name || person.record_id || "—";
  ctx.fillText(name, 34, rowY + CAL_ROW_H / 2);
  ctx.globalAlpha = 1;

  // Lane background — subtle dark fill across the whole grid for this row
  ctx.fillStyle = CAL_BG_LANE;
  ctx.fillRect(gridX, rowY + 4, gridW, CAL_ROW_H - 8);

  // Window: dates_start..dates_end clipped to [start, end]
  const pStart = isoToDate(person.dates_start);
  const pEnd   = isoToDate(person.dates_end);
  if (!pStart || !pEnd) return;
  const winStartIdx = Math.max(0, daysBetween(start, pStart));
  const winEndIdx   = Math.min(numDays - 1, daysBetween(start, pEnd));
  if (winEndIdx < winStartIdx) return;
  const winX = gridX + winStartIdx * CAL_DAY_W;
  const winW = (winEndIdx - winStartIdx + 1) * CAL_DAY_W;

  // Filled window bar — hash-derived gradient using the person's two hues
  const grad = ctx.createLinearGradient(winX, rowY, winX + winW, rowY);
  grad.addColorStop(0, hsl(colors.hue, 0.68, 0.52, 0.85));
  grad.addColorStop(1, hsl(colors.hue2, 0.72, 0.56, 0.85));
  ctx.fillStyle = grad;
  ctx.fillRect(winX, rowY + 6, winW, CAL_ROW_H - 12);

  // Inner glow line at top + bottom for the editorial sheen
  ctx.fillStyle = "rgba(255,255,255,0.10)";
  ctx.fillRect(winX, rowY + 6, winW, 1);
  ctx.fillStyle = "rgba(0,0,0,0.18)";
  ctx.fillRect(winX, rowY + CAL_ROW_H - 7, winW, 1);

  // ── Absences: overlay striped pattern on each absence range ────────
  const absences = Array.isArray(person.absences) ? person.absences : [];
  for (const ab of absences) {
    const aS = isoToDate(ab.start);
    const aE = isoToDate(ab.end);
    if (!aS || !aE) continue;
    const aStartIdx = Math.max(winStartIdx, daysBetween(start, aS));
    const aEndIdx   = Math.min(winEndIdx, daysBetween(start, aE));
    if (aEndIdx < aStartIdx) continue;
    const aX = gridX + aStartIdx * CAL_DAY_W;
    const aW = (aEndIdx - aStartIdx + 1) * CAL_DAY_W;
    // Knock out the present color
    ctx.fillStyle = CAL_BG_LANE;
    ctx.fillRect(aX, rowY + 6, aW, CAL_ROW_H - 12);
    // Diagonal stripe overlay so it reads as "scheduled absence" not gap
    ctx.save();
    ctx.beginPath();
    ctx.rect(aX, rowY + 6, aW, CAL_ROW_H - 12);
    ctx.clip();
    ctx.strokeStyle = `rgba(245, 243, 238, 0.18)`;
    ctx.lineWidth = 0.8;
    const stripeSpacing = 6;
    const rowTop = rowY + 6;
    const rowBot = rowY + CAL_ROW_H - 6;
    const h = rowBot - rowTop;
    ctx.beginPath();
    for (let sx = aX - h; sx < aX + aW + h; sx += stripeSpacing) {
      ctx.moveTo(sx, rowBot);
      ctx.lineTo(sx + h, rowTop);
    }
    ctx.stroke();
    ctx.restore();
    // Faint outline at the gap edges
    ctx.strokeStyle = `rgba(245, 243, 238, 0.18)`;
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(aX + 0.5, rowY + 6);
    ctx.lineTo(aX + 0.5, rowY + CAL_ROW_H - 6);
    ctx.moveTo(aX + aW - 0.5, rowY + 6);
    ctx.lineTo(aX + aW - 0.5, rowY + CAL_ROW_H - 6);
    ctx.stroke();
  }
}

// Draws the concurrent-headcount strip above the calendar grid — an
// area chart showing how many people are on-site per day. Counts every
// person whose dates_start..dates_end window covers the day AND who
// isn't in an absence range that day. Glance-readable density.
function drawHeadcountStrip(ctx, rows, start, numDays, gridX) {
  // Build per-day count
  const counts = new Array(numDays).fill(0);
  let maxCount = 0;
  for (const r of rows) {
    if (r.type !== "person") continue;
    const p = r.person;
    const pStart = isoToDate(p.dates_start);
    const pEnd   = isoToDate(p.dates_end);
    if (!pStart || !pEnd) continue;
    const s = Math.max(0, daysBetween(start, pStart));
    const e = Math.min(numDays - 1, daysBetween(start, pEnd));
    const absences = (Array.isArray(p.absences) ? p.absences : [])
      .map(ab => ({ s: isoToDate(ab.start), e: isoToDate(ab.end) }))
      .filter(ab => ab.s && ab.e);
    for (let i = s; i <= e; i++) {
      const day = new Date(start);
      day.setUTCDate(start.getUTCDate() + i);
      // Skip if inside any absence range.
      let absent = false;
      for (const ab of absences) {
        if (day >= ab.s && day <= ab.e) { absent = true; break; }
      }
      if (!absent) counts[i]++;
    }
    if (e >= s && e < numDays) maxCount = Math.max(maxCount, counts[e]);
  }
  for (const c of counts) if (c > maxCount) maxCount = c;
  if (maxCount === 0) return;

  const stripY = 6;
  const stripH = CAL_DENSITY_H - 10;
  // Area chart — step path at top of each day column.
  ctx.save();
  const grad = ctx.createLinearGradient(0, stripY, 0, stripY + stripH);
  grad.addColorStop(0,   "rgba(245, 243, 238, 0.16)");
  grad.addColorStop(1,   "rgba(245, 243, 238, 0.02)");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(gridX, stripY + stripH);
  for (let i = 0; i < numDays; i++) {
    const v = counts[i] / maxCount;
    const top = stripY + (1 - v) * stripH;
    const x0 = gridX + i * CAL_DAY_W;
    const x1 = x0 + CAL_DAY_W;
    ctx.lineTo(x0, top);
    ctx.lineTo(x1, top);
  }
  ctx.lineTo(gridX + numDays * CAL_DAY_W, stripY + stripH);
  ctx.closePath();
  ctx.fill();
  // Top outline at 50% so the silhouette reads sharp.
  ctx.beginPath();
  ctx.strokeStyle = "rgba(245, 243, 238, 0.40)";
  ctx.lineWidth = 1;
  for (let i = 0; i < numDays; i++) {
    const v = counts[i] / maxCount;
    const top = stripY + (1 - v) * stripH;
    const x0 = gridX + i * CAL_DAY_W;
    const x1 = x0 + CAL_DAY_W;
    if (i === 0) ctx.moveTo(x0, top);
    else ctx.lineTo(x0, top);
    ctx.lineTo(x1, top);
  }
  ctx.stroke();
  // Label at the top-left of the strip
  ctx.font = `500 9px "Geist Mono", "Berkeley Mono", ui-monospace, monospace`;
  ctx.fillStyle = "rgba(245, 243, 238, 0.55)";
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(`on-site / day · peak ${maxCount}`, gridX + 6, stripY + 10);
  ctx.restore();
}

// Tiny helper: rounded rectangle path.
function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
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

function wireCalendar() {
  const pngBtn = document.getElementById("cal-export-png");
  if (pngBtn) pngBtn.addEventListener("click", () => exportCalendar("png"));
  const pdfBtn = document.getElementById("cal-export-pdf");
  if (pdfBtn) pdfBtn.addEventListener("click", () => exportCalendar("pdf"));
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

  // ── Meta strip (LEAD · GEO · #MEMBERS) at bottom-left ─────────────
  // Columns sized to fit the longest expected values; values truncate with ellipsis.
  const colLeadX    = x + 20;
  const colGeoX     = x + 150;
  const colMembersX = x + 305;
  const colLeadW    = (colGeoX - colLeadX) - 10;     // 120
  const colGeoW     = (colMembersX - colGeoX) - 10;  // 145
  const colMembersW = (x + w - 20) - colMembersX;    // ~55

  ctx.font = `500 9.5px "Geist Mono", ui-monospace, monospace`;
  ctx.fillStyle = CAL_INK_1;
  ctx.globalAlpha = 0.42;
  ctx.fillText("LEAD",    colLeadX,    y + h - 70);
  ctx.fillText("GEO",     colGeoX,     y + h - 70);
  ctx.fillText("MEMBERS", colMembersX, y + h - 70);
  ctx.globalAlpha = 0.88;
  ctx.font = `500 12px "Geist Mono", ui-monospace, monospace`;
  ctx.fillText(truncateText(ctx, team.lead || "—", colLeadW), colLeadX, y + h - 52);
  ctx.fillText(truncateText(ctx, team.geo  || "—", colGeoW),  colGeoX,  y + h - 52);
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
  const editUrl = `https://github.com/dmarzzz/shape-rotator-field-guide/edit/main/cohort-data/people/${encodeURIComponent(recordId)}.md?quick_pull=1`;
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

