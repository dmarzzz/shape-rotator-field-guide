// identity.js — the local "who am I in this cohort" record. Stored only
// in localStorage (private to this device); nothing here travels to
// swf-node or github. The published cohort record is whatever lives in
// cohort-data/{teams,people}/<slug>.md — this module just remembers
// which one of those records belongs to the user so the app can
// (a) show their team name in the top-right, (b) jump straight to
// their record from the profile editor, and (c) skip the onboarding
// modal on subsequent launches.

import { getCohortSurface, subscribeToCohortChanges } from "./cohort-source.js";

const IDENTITY_LS_KEY = "srwk:identity_v1";

// Listeners fire whenever the identity changes (claim, switch, clear).
// Used by the top-right pill to repaint and by alchemy.js to surface
// the user's record in the editor on demand.
const _listeners = new Set();

let _cached = null;

export function getIdentity() {
  if (_cached) return _cached;
  try {
    const raw = localStorage.getItem(IDENTITY_LS_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object" || !v.record_id || !v.kind) return null;
    _cached = v;
    return v;
  } catch {
    return null;
  }
}

export function setIdentity(record) {
  // Accept either {kind, record_id, display_name} or a raw cohort record.
  const v = {
    kind: record.kind || record.record_type || "person",
    record_id: String(record.record_id),
    display_name: record.display_name || record.name || record.record_id,
    claimed_at: record.claimed_at || new Date().toISOString(),
  };
  _cached = v;
  try { localStorage.setItem(IDENTITY_LS_KEY, JSON.stringify(v)); } catch {}
  for (const cb of _listeners) { try { cb(v); } catch {} }
  return v;
}

export function clearIdentity() {
  _cached = null;
  try { localStorage.removeItem(IDENTITY_LS_KEY); } catch {}
  for (const cb of _listeners) { try { cb(null); } catch {} }
}

export function onIdentityChanged(cb) {
  if (typeof cb !== "function") return () => {};
  _listeners.add(cb);
  return () => _listeners.delete(cb);
}

// Resolve the identity to a *displayable* {label, avatar, kind} bundle.
// Person claims surface their NAME (not team) per UI feedback, with an
// avatar derived from the linked github handle when present. Team/project
// claims still surface the record's name. Falls back to the persisted
// display_name when cohort can't resolve.
export async function resolveIdentityLabel() {
  const id = getIdentity();
  if (!id) return null;
  let cohort;
  try { cohort = await getCohortSurface(); } catch { cohort = null; }
  if (!cohort) {
    return { label: id.display_name, kind: id.kind, record_id: id.record_id, avatar: null };
  }
  if (id.kind === "person") {
    const person = (cohort.people || []).find(p => p.record_id === id.record_id);
    const gh = person?.links?.github || null;
    const avatar = gh ? `https://github.com/${encodeURIComponent(gh)}.png?size=80` : null;
    return {
      label: person?.name || id.display_name,
      kind: "person",
      record_id: id.record_id,
      avatar,
      gh,
    };
  }
  // team / project → look up the live record so renames flow through.
  const t = (cohort.teams || []).find(x => x.record_id === id.record_id);
  const tgh = t?.links?.github || null;
  return {
    label: t?.name || id.display_name,
    kind: id.kind,
    record_id: id.record_id,
    avatar: tgh ? `https://github.com/${encodeURIComponent(tgh)}.png?size=80` : null,
    gh: tgh,
  };
}

// ─── top-right pill ──────────────────────────────────────────────────
// The pill sits in #tab-bar between the search button and the version
// footer. Click → jump to alchemy/profile/edit on the user's record.
// (alchemy.js exposes a window-level helper `__srwkOpenProfile(id)`
// so we can route without importing it and creating a cycle.)

let _pillEl = null;

export function mountIdentityPill(tabBar) {
  if (!tabBar || _pillEl) return;
  const pill = document.createElement("button");
  pill.id = "identity-pill";
  pill.className = "identity-pill";
  pill.type = "button";
  pill.title = "your profile — click to edit";
  pill.innerHTML = `
    <span class="ip-avatar" aria-hidden="true"><span class="ip-glyph">◐</span></span>
    <span class="ip-label">claim profile</span>
  `;
  pill.addEventListener("click", openIdentityFlow);
  // Insert before the version footer (.tab-bar-foot) so it sits to its
  // left; if absent, just append to the end of the tab bar.
  const foot = tabBar.querySelector(".tab-bar-foot");
  if (foot) tabBar.insertBefore(pill, foot);
  else tabBar.appendChild(pill);
  _pillEl = pill;
  paintIdentityPill();
  onIdentityChanged(paintIdentityPill);
  // Cohort changes can rename the team — repaint when bundles arrive.
  subscribeToCohortChanges(() => paintIdentityPill());
}

async function paintIdentityPill() {
  if (!_pillEl) return;
  const id = getIdentity();
  const avatarEl = _pillEl.querySelector(".ip-avatar");
  const labelEl  = _pillEl.querySelector(".ip-label");
  if (!id) {
    _pillEl.dataset.state = "unclaimed";
    labelEl.textContent = "claim profile";
    _pillEl.title = "tell shape rotator who you are";
    // Reset avatar to the glyph fallback.
    avatarEl.innerHTML = `<span class="ip-glyph">◐</span>`;
    return;
  }
  const resolved = await resolveIdentityLabel();
  _pillEl.dataset.state = "claimed";
  _pillEl.dataset.kind = resolved?.kind || id.kind;
  labelEl.textContent = resolved?.label || id.display_name;
  _pillEl.title = `you: ${id.kind} · ${id.record_id}${resolved?.gh ? ` · @${resolved.gh}` : ""}\nclick to edit your record`;
  // Avatar: github profile image when we have a handle, else two-letter
  // initial fallback derived from the display label (helps when a record
  // has no github yet — most still get a meaningful glyph).
  const fallbackInitials = labelInitials(resolved?.label || id.display_name);
  if (resolved?.avatar) {
    avatarEl.innerHTML = "";
    const img = document.createElement("img");
    img.className = "ip-avatar-img";
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    img.loading = "lazy";
    img.src = resolved.avatar;
    // Network failure / 404 → swap in the initials fallback in place.
    img.addEventListener("error", () => {
      avatarEl.innerHTML = `<span class="ip-initials">${escHtml(fallbackInitials)}</span>`;
    }, { once: true });
    avatarEl.appendChild(img);
  } else {
    avatarEl.innerHTML = `<span class="ip-initials">${escHtml(fallbackInitials)}</span>`;
  }
}

function labelInitials(label) {
  const s = String(label || "").trim();
  if (!s) return "·";
  // Take the first letter of each word, up to two; uppercased.
  const parts = s.split(/\s+/).filter(Boolean).slice(0, 2);
  return parts.map(p => p[0]).join("").toUpperCase() || s[0].toUpperCase();
}

// Click on the pill: claimed → jump to the editor on the user's record;
// unclaimed → open the onboarding modal.
function openIdentityFlow() {
  const id = getIdentity();
  if (!id) {
    showOnboardingModal();
    return;
  }
  // Route to alchemy/profile/edit on the user's record. alchemy.js
  // exposes window.__srwkOpenProfile so we don't need a hard import.
  if (typeof window.__srwkOpenProfile === "function") {
    window.__srwkOpenProfile({ kind: id.kind, record_id: id.record_id, mode: "edit" });
  }
}

// ─── onboarding modal ────────────────────────────────────────────────
// First-launch (or when the user clears identity) prompt. Shows the
// existing cohort records they could claim, plus a "create new" path.

let _modalEl = null;

export async function maybeShowOnboarding() {
  if (getIdentity()) return; // already claimed
  // Defer until cohort is available — there's nothing to claim otherwise.
  let cohort = null;
  try { cohort = await getCohortSurface(); } catch {}
  if (!cohort) return;
  showOnboardingModal(cohort);
}

async function showOnboardingModal(cohortHint) {
  if (_modalEl) return; // already open
  const cohort = cohortHint || (await getCohortSurface().catch(() => null));
  const teams    = cohort?.teams    || [];
  const projects = teams.filter(t => (t.kind || "team") === "project");
  const teamsOnly = teams.filter(t => (t.kind || "team") === "team");
  const people   = cohort?.people   || [];

  const overlay = document.createElement("div");
  overlay.className = "identity-modal-backdrop";
  overlay.innerHTML = `
    <div class="identity-modal" role="dialog" aria-labelledby="im-title">
      <header class="im-head">
        <h2 id="im-title" class="im-title">welcome — who are you?</h2>
        <p class="im-sub">tell shape rotator your record so the field-guide can show your team and route the editor straight to you. stored locally on this device only — no PR, no broadcast.</p>
      </header>

      <section class="im-section">
        <h3 class="im-h">i'm already on the cohort</h3>
        <label class="im-row"><span>i am a person</span>
          <select id="im-person">
            <option value="">— pick yourself —</option>
            ${people.map(p => `<option value="${escAttr(p.record_id)}">${escHtml(p.name || p.record_id)}${p.team ? ` · ${escHtml(p.team)}` : ""}</option>`).join("")}
          </select>
        </label>
        <label class="im-row"><span>or claim a team</span>
          <select id="im-team">
            <option value="">— pick a team —</option>
            ${teamsOnly.map(t => `<option value="${escAttr(t.record_id)}">${escHtml(t.name)}</option>`).join("")}
          </select>
        </label>
        ${projects.length ? `
          <label class="im-row"><span>or a project</span>
            <select id="im-project">
              <option value="">— pick a project —</option>
              ${projects.map(t => `<option value="${escAttr(t.record_id)}">${escHtml(t.name)}</option>`).join("")}
            </select>
          </label>
        ` : ""}
      </section>

      <section class="im-section">
        <h3 class="im-h">i'm new</h3>
        <p class="im-sub" style="margin:0 0 10px 0">opens the editor with a blank form — submit a PR to add yourself.</p>
        <div class="im-create-row">
          <button class="im-btn im-create" data-create="person"  type="button">+ new person</button>
          <button class="im-btn im-create" data-create="team"    type="button">+ new team</button>
          <button class="im-btn im-create" data-create="project" type="button">+ new project</button>
        </div>
      </section>

      <footer class="im-foot">
        <button class="im-skip" id="im-skip" type="button">i'll do this later</button>
      </footer>
    </div>
  `;
  document.body.appendChild(overlay);
  _modalEl = overlay;

  const close = () => {
    overlay.remove();
    _modalEl = null;
  };

  // Pickers: claim by record.
  const wirePick = (selId, kind, source) => {
    const sel = overlay.querySelector(`#${selId}`);
    if (!sel) return;
    sel.addEventListener("change", () => {
      const id = sel.value;
      if (!id) return;
      const rec = source.find(r => r.record_id === id);
      if (!rec) return;
      setIdentity({ kind, record_id: rec.record_id, display_name: rec.name || rec.record_id });
      close();
      // Drop the user into their editor so they can verify the record.
      if (typeof window.__srwkOpenProfile === "function") {
        window.__srwkOpenProfile({ kind, record_id: rec.record_id, mode: "edit" });
      }
    });
  };
  wirePick("im-person",  "person",  people);
  wirePick("im-team",    "team",    teamsOnly);
  wirePick("im-project", "project", projects);

  // Create paths: route to alchemy/profile/add — they can claim after PR merges.
  for (const btn of overlay.querySelectorAll(".im-create[data-create]")) {
    btn.addEventListener("click", () => {
      const kind = btn.dataset.create;
      close();
      if (typeof window.__srwkOpenProfile === "function") {
        window.__srwkOpenProfile({ kind, mode: "add" });
      }
    });
  }

  overlay.querySelector("#im-skip")?.addEventListener("click", close);
  // Click outside the card → close (treat as skip).
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
}

function escHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function escAttr(s) { return escHtml(s); }
