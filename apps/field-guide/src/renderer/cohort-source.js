// cohort-source.js — the SOLE entry point for cohort data into the
// field-guide app. Per docs/SHAPE-ROTATOR-OS-SPEC.md §4.5.
//
// Phase 4 (current): reads the built cohort.surface JSON straight
// from GitHub `main` so cohort edits propagate as soon as a PR
// merges — no daemon, no republish step. Falls back to the bundled
// cohort-surface.json fixture if GitHub is unreachable so the app
// stays usable offline (with whatever cohort state was bundled at
// build time).
//
// A lightweight polling refresh keeps long-running sessions fresh:
// every REFRESH_MS we re-fetch and, if anything changed, notify
// subscribers so the views can re-render.

const GH_REPO   = "dmarzzz/shape-rotator-field-guide";
const GH_BRANCH = "main";
const GH_PATH   = "apps/field-guide/src/cohort-surface.json";
const GH_URL    = `https://raw.githubusercontent.com/${GH_REPO}/${GH_BRANCH}/${GH_PATH}`;
const REFRESH_MS = 5 * 60 * 1000;

let _cache = null;            // grouped by record_type
let _refreshTimer = null;
const _subscribers = new Set();

function emptyShape() {
  return { teams: [], people: [], clusters: [], program: [], asks: [], cohort_vocab: {} };
}

function normalize(data) {
  return {
    teams:        Array.isArray(data?.teams)    ? data.teams    : [],
    people:       Array.isArray(data?.people)   ? data.people   : [],
    clusters:     Array.isArray(data?.clusters) ? data.clusters : [],
    program:      Array.isArray(data?.program)  ? data.program  : [],
    asks:         Array.isArray(data?.asks)     ? data.asks     : [],
    cohort_vocab: (data?.cohort_vocab && typeof data.cohort_vocab === "object") ? data.cohort_vocab : {},
  };
}

async function loadFromGithub() {
  // ?ts= bypasses both the HTTP cache and any CDN/Electron caching so
  // we always see the latest commit on `main`.
  const url = `${GH_URL}?ts=${Date.now()}`;
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`github cohort fetch failed: HTTP ${r.status}`);
  return normalize(await r.json());
}

async function loadFromFixture() {
  const url = new URL("../cohort-surface.json", import.meta.url);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`cohort-surface fixture failed: HTTP ${r.status}`);
  return normalize(await r.json());
}

// Cheap change signature: counts + sorted record_ids per bucket. Used
// by the refresh loop to skip re-render when GitHub returned identical
// data (the usual case between merges).
function signatureOf(grouped) {
  const sig = (arr) => arr.map(r => r.record_id).sort().join("|");
  // Program-page edits are full-body markdown swaps, not record_id churn —
  // hash a coarse fingerprint of (id + body length) so a content-only change
  // still trips the refresh notifier.
  const progSig = (arr) => arr.map(r => `${r.record_id}:${(r.body_md || "").length}`).sort().join("|");
  // Asks churn fast (5-day expiry) — include status in the signature so the
  // wall re-renders on claim/close.
  const askSig = (arr) => arr.map(r => `${r.record_id}:${r.status || "open"}`).sort().join("|");
  return `${grouped.teams.length}:${sig(grouped.teams)}#${grouped.people.length}:${sig(grouped.people)}#${grouped.clusters.length}:${sig(grouped.clusters)}#${grouped.program.length}:${progSig(grouped.program)}#${grouped.asks.length}:${askSig(grouped.asks)}`;
}

/**
 * Returns latest cohort.surface records grouped by type. Tries
 * GitHub `main` first; falls back to the bundled fixture on any
 * error so the app stays usable offline.
 */
export async function getCohortSurface() {
  if (_cache) return _cache;
  try {
    _cache = await loadFromGithub();
    _cache._source = "github";
    _cache._sig = signatureOf(_cache);
  } catch (e) {
    console.warn("[cohort-source] github unreachable; falling back to fixture:", e?.message || e);
    _cache = await loadFromFixture();
    _cache._source = "fixture";
    _cache._sig = signatureOf(_cache);
  }
  scheduleRefresh();
  return _cache;
}

function scheduleRefresh() {
  if (_refreshTimer) return;
  _refreshTimer = setInterval(async () => {
    try {
      const fresh = await loadFromGithub();
      const sig = signatureOf(fresh);
      if (sig === _cache?._sig) return;  // unchanged
      _cache = { ...fresh, _source: "github", _sig: sig };
      for (const cb of _subscribers) {
        try { cb({ type: "refresh" }); } catch {}
      }
    } catch {
      // Transient network blip — keep the existing cache, try again
      // on the next tick. No-op rather than logging on every miss.
    }
  }, REFRESH_MS);
}

/**
 * Subscribers fire when a polled refresh detects a changed cohort on
 * GitHub. The callback receives a generic `{ type: "refresh" }` —
 * consumers should re-fetch via getCohortSurface() and re-render.
 */
export function subscribeToCohortChanges(cb) {
  if (typeof cb !== "function") return () => {};
  _subscribers.add(cb);
  return () => _subscribers.delete(cb);
}

// Internal — for tests / dev tools to force-refresh the cache.
export function _resetCohortSource() {
  _cache = null;
  _subscribers.clear();
  if (_refreshTimer) { clearInterval(_refreshTimer); _refreshTimer = null; }
}
