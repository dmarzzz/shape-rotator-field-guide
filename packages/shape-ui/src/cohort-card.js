// cohort-card.js — shared renderer for the cohort "specimen" cards used
// across the alchemy view and the sibling web app. Each card shows a
// shape glyph plus the surface fields (focus, lead, links, members).
//
// Two API styles are exported:
//   - renderTeamCard / renderPersonCard / renderCohortCard
//     → return real HTMLElement nodes (preferred for web app code).
//   - teamCardHtml / personCardHtml
//     → return HTML string (kept so the Electron renderer can keep its
//       existing innerHTML batching flow without per-card append cost).
//
// Both styles share the same markup. The HTML-string form is the
// "implementation"; the element form wraps it via a detached div.

import { escHtml, escAttr } from "./escape.js";
import { shapeForTeam, domainLabel } from "./index.js";

// Display id "SHAPE-NN" / "PERSON-NN" from index. Kept module-local
// because callers always have an index handy.
function displayId(idx) {
  return String(idx + 1).padStart(2, "0");
}

// 32-bit string hash. Mirrors alchemy.js's hashStr so per-person card
// hues / fams match what the rest of the surface already shows.
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  }
  return h;
}

function teamKind(t) { return (t && t.kind) || "team"; }

const GH_REPO_RE = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;

// ── HTML-string renderers ──────────────────────────────────────────────

export function teamCardHtml(t, idx, ctx = {}) {
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
  const allPeople = Array.isArray(ctx.people) ? ctx.people : [];
  const teamPeople = allPeople.filter(p =>
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

export function personCardHtml(p, idx) {
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

// ── HTMLElement renderers (preferred for web app code) ─────────────────
// Each wraps its HTML-string sibling in a detached <div> and lifts out
// the <article> child so callers can append directly into the DOM and
// attach event listeners.

function htmlToElement(html) {
  const wrap = document.createElement("div");
  wrap.innerHTML = String(html).trim();
  return wrap.firstElementChild;
}

function attachOnClick(el, onClick) {
  if (!el || typeof onClick !== "function") return el;
  el.addEventListener("click", (e) => onClick(e, el));
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onClick(e, el);
    }
  });
  return el;
}

export function renderTeamCard(team, options = {}) {
  const idx = Number.isFinite(options.idx) ? options.idx : 0;
  const ctx = { people: options.people || [] };
  const el = htmlToElement(teamCardHtml(team, idx, ctx));
  return attachOnClick(el, options.onClick);
}

export function renderPersonCard(person, options = {}) {
  const idx = Number.isFinite(options.idx) ? options.idx : 0;
  const el = htmlToElement(personCardHtml(person, idx));
  return attachOnClick(el, options.onClick);
}

// Dispatcher — uses record_type to pick the renderer. Falls back to
// kind ("team" | "project") when record_type isn't on the record.
export function renderCohortCard(record, options = {}) {
  if (!record) return null;
  const t = record.record_type || (record.kind === "person" ? "person" : "team");
  if (t === "person") return renderPersonCard(record, options);
  return renderTeamCard(record, options);
}
