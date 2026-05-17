// profile-form.js — minimal cohort profile-edit surface for the web app.
//
// SCOPE: this renders a single-record EDIT form (the common web-app
// case: "show me my record, let me tweak it, open a PR"). The Electron
// renderer still owns the full add/edit/diff/markdown-generation editor
// in alchemy.js because that flow is wired into local profile state,
// cohort-relative pickers, and steward-merge expectations that are out
// of scope for the sibling app.
//
// TODO: when the Electron editor and the web app's editor finally
// converge, lift the add/diff/markdown blocks (alchemy.js ≈2540-3120)
// up to here so both apps share one implementation.

import { escHtml, escAttr } from "./escape.js";
import { buildEditPRUrl } from "./pr-url.js";

// Per-record-type fields shown in the form. Keep the schema close to
// the field-guide's surface model so the produced edits land cleanly.
const PERSON_FIELDS = [
  { key: "name",            label: "name",           type: "text" },
  { key: "role",            label: "role",           type: "text" },
  { key: "geo",             label: "geo",            type: "text" },
  { key: "domain",          label: "domain",         type: "text", placeholder: "crypto | tee | ai | app-ux | bd-gtm | design" },
  { key: "links.github",    label: "github",         type: "text" },
  { key: "links.x",         label: "x",              type: "text" },
  { key: "links.website",   label: "website",        type: "text" },
  { key: "links.linkedin",  label: "linkedin",       type: "text" },
];

const TEAM_FIELDS = [
  { key: "name",            label: "name",           type: "text" },
  { key: "focus",           label: "focus",          type: "text" },
  { key: "members_count",   label: "members count",  type: "number" },
  { key: "geo",             label: "geo",            type: "text" },
  { key: "domain",          label: "domain",         type: "text" },
  { key: "shape",           label: "shape",          type: "text" },
  { key: "links.github",    label: "github",         type: "text" },
  { key: "links.repo",      label: "repo (org/name)", type: "text" },
  { key: "links.x",         label: "x",              type: "text" },
  { key: "links.website",   label: "website",        type: "text" },
];

function fieldsFor(recordType) {
  if (recordType === "person") return PERSON_FIELDS;
  return TEAM_FIELDS;
}

function getNested(obj, path) {
  if (!obj) return undefined;
  return path.split(".").reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}
function setNested(obj, path, value) {
  if (!obj) return;
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (cur[k] == null || typeof cur[k] !== "object") cur[k] = {};
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = value;
}

function coerceInputValue(input) {
  const v = input.value;
  if (input.type === "number") return v === "" ? null : Number(v);
  if (v === "") return null;
  return v;
}

// Render a profile-edit form into `container`. Returns a controller
// with .destroy() (removes the form) and .getDraft() (returns the live
// in-progress object).
//
// options:
//   recordType      "team" | "person" | "cluster"
//   recordId        slug for the record (used in the PR URL)
//   initialData     starting object — mutated in place as the user types
//   container       HTMLElement the form is appended into
//   onSubmit        ({ draft, prUrl, recordType, recordId }) → void
//                   default: opens prUrl via openExternal
//   openExternal    (url) → void — default opens a new tab
export function renderProfileForm({
  recordType,
  recordId,
  initialData,
  container,
  onSubmit,
  openExternal,
}) {
  if (!container) return null;
  const draft = initialData ? JSON.parse(JSON.stringify(initialData)) : {};
  const fields = fieldsFor(recordType);
  const openLink = typeof openExternal === "function"
    ? openExternal
    : (url) => { try { window.open(url, "_blank", "noopener"); } catch {} };

  const rows = fields.map(f => {
    const value = getNested(draft, f.key);
    const display = value == null ? "" : String(value);
    return `<label class="shape-pf-row">
      <span class="shape-pf-label">${escHtml(f.label)}</span>
      <input
        class="shape-pf-input"
        type="${escAttr(f.type)}"
        name="${escAttr(f.key)}"
        value="${escAttr(display)}"
        placeholder="${escAttr(f.placeholder || "")}" />
    </label>`;
  }).join("");

  const wrap = document.createElement("div");
  wrap.className = "shape-profile-form-wrap";
  wrap.innerHTML = `
    <form class="shape-profile-form" autocomplete="off">
      ${rows}
      <div class="shape-profile-submit">
        <button type="submit" class="shape-profile-submit-btn">
          open github editor (PR)
        </button>
        <p class="shape-profile-hint">
          opens <code>cohort-data/${escHtml(recordType === "person" ? "people" : recordType === "cluster" ? "clusters" : "teams")}/${escHtml(recordId)}.md</code>
          in github's web editor with a pre-staged PR.
        </p>
      </div>
    </form>
  `;
  container.appendChild(wrap);

  const form = wrap.querySelector("form");

  // Live-update draft on input so callers / submit handler see the
  // current values without re-reading the form.
  const onChange = (e) => {
    const target = e.target;
    if (!target || !target.name) return;
    setNested(draft, target.name, coerceInputValue(target));
  };
  form.addEventListener("input", onChange);
  form.addEventListener("change", onChange);

  const onSubmitEvent = (e) => {
    e.preventDefault();
    const prUrl = buildEditPRUrl({ recordType, recordId });
    const payload = { draft, prUrl, recordType, recordId };
    if (typeof onSubmit === "function") {
      onSubmit(payload);
    } else {
      openLink(prUrl);
    }
  };
  form.addEventListener("submit", onSubmitEvent);

  return {
    element: wrap,
    getDraft: () => draft,
    destroy: () => {
      form.removeEventListener("input", onChange);
      form.removeEventListener("change", onChange);
      form.removeEventListener("submit", onSubmitEvent);
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
    },
  };
}
