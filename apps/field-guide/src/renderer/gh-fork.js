// gh-fork.js — fork-aware PR URL routing.
//
// Most cohort members don't have push access to dmarzzz/shape-rotator-
// field-guide. GitHub's `/edit/main/<path>?quick_pull=1` URL is *supposed*
// to auto-fork the repo for non-collaborators on click, but that redirect
// is unreliable (silently fails in some browser/account combinations,
// leaves users stuck staring at the canonical repo's editor with no
// commit button enabled).
//
// This module replaces that fragile path with an explicit two-state flow:
//
//   1. The app already knows the user's github handle from their claimed
//      person record (`links.github`).
//   2. Before opening any /edit/ or /new/ URL, we check whether their
//      fork (`<handle>/shape-rotator-field-guide`) exists, via an
//      UNAUTHENTICATED GET to api.github.com/repos/<handle>/<repo>.
//        - 200 → fork exists; open /edit/ or /new/ on the fork directly.
//        - 404 → fork doesn't exist; surface a "create your fork (one
//          click)" prompt that opens `<canonical>/fork`. After they do
//          that one time, every future PR is direct-to-fork.
//   3. The fork-exists result is cached in localStorage with a 24h TTL
//      so we don't hammer the rate-limit (60 req/hr unauth per IP).
//
// No OAuth, no token storage, no in-app sign-in.

const CANONICAL_OWNER = "dmarzzz";
const CANONICAL_REPO  = "shape-rotator-field-guide";
const FORK_CACHE_KEY  = "srfg:gh_fork_cache_v1";
const FORK_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// ── cache ───────────────────────────────────────────────────────────

function loadForkCache() {
  try {
    const raw = localStorage.getItem(FORK_CACHE_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return (obj && typeof obj === "object") ? obj : {};
  } catch { return {}; }
}
function saveForkCache(map) {
  try { localStorage.setItem(FORK_CACHE_KEY, JSON.stringify(map || {})); } catch {}
}
function cachedForkExists(handle) {
  const cache = loadForkCache();
  const entry = cache[handle.toLowerCase()];
  if (!entry) return undefined;
  if (Date.now() - entry.checked_at > FORK_CACHE_TTL_MS) return undefined;
  return entry.exists;
}
function rememberForkExists(handle, exists) {
  const cache = loadForkCache();
  cache[handle.toLowerCase()] = { exists, checked_at: Date.now() };
  saveForkCache(cache);
}
// Public — called by the "you forked, let me try again" retry button so
// the next click rechecks immediately instead of waiting 24h.
export function clearForkCache(handle) {
  if (!handle) {
    try { localStorage.removeItem(FORK_CACHE_KEY); } catch {}
    return;
  }
  const cache = loadForkCache();
  delete cache[handle.toLowerCase()];
  saveForkCache(cache);
}

// ── existence check ─────────────────────────────────────────────────

async function checkForkExists(handle) {
  const cached = cachedForkExists(handle);
  if (cached !== undefined) return cached;
  try {
    const r = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(handle)}/${CANONICAL_REPO}`,
      { headers: { Accept: "application/vnd.github+json" } }
    );
    if (r.status === 200) {
      rememberForkExists(handle, true);
      return true;
    }
    if (r.status === 404) {
      rememberForkExists(handle, false);
      return false;
    }
    // Rate-limited or transient — don't cache. Assume fork doesn't exist
    // (worst case: user sees "create fork" prompt unnecessarily once;
    // safer than dropping them into the canonical /edit/ that's failing
    // for non-collaborators).
    return false;
  } catch {
    return false;
  }
}

// ── URL builders ────────────────────────────────────────────────────

function buildEditUrl(owner, path, branch) {
  return `https://github.com/${owner}/${CANONICAL_REPO}/edit/${branch}/${path}?quick_pull=1`;
}
function buildNewUrl(owner, path, value, branch) {
  let u = `https://github.com/${owner}/${CANONICAL_REPO}/new/${branch}?filename=${encodeURIComponent(path)}&quick_pull=1`;
  if (value != null) u += `&value=${encodeURIComponent(value)}`;
  return u;
}
function buildForkCreateUrl() {
  return `https://github.com/${CANONICAL_OWNER}/${CANONICAL_REPO}/fork`;
}

// ── main resolver ───────────────────────────────────────────────────

/**
 * Resolve the right URL for a PR-creating action.
 *
 * @param {object} opts
 *   - kind:   "edit" | "new"
 *   - path:   "cohort-data/people/dmarz.md" — the file path inside the repo
 *   - value:  optional string — prefilled content (for kind="new")
 *   - branch: optional string — defaults to "main"
 *   - ghHandle: the user's github handle (null/undefined → falls back to canonical URL)
 *
 * @returns {Promise<object>}
 *   - { kind: "ready", url }                    — open this URL directly
 *   - { kind: "needs-fork", canonicalUrl, forkUrl, handle, retryHint }
 *                                              — user has a handle but no fork yet
 *   - { kind: "no-identity", canonicalUrl }    — user hasn't claimed an identity / set links.github
 *
 * Callers handle each kind:
 *   - "ready"        → openExternal(url)
 *   - "needs-fork"   → show CTA: "fork the repo first (one click)" + forkUrl
 *   - "no-identity"  → fall back to the canonical URL (current behavior)
 */
export async function resolvePREndpoint(opts) {
  const { kind, path, value, branch = "main", ghHandle } = opts || {};
  if (!path || (kind !== "edit" && kind !== "new")) {
    throw new Error(`resolvePREndpoint: invalid opts (kind=${kind}, path=${path})`);
  }
  const canonicalBuilder = kind === "edit"
    ? () => buildEditUrl(CANONICAL_OWNER, path, branch)
    : () => buildNewUrl(CANONICAL_OWNER, path, value, branch);

  if (!ghHandle) {
    return { kind: "no-identity", canonicalUrl: canonicalBuilder() };
  }

  const exists = await checkForkExists(ghHandle);
  if (exists) {
    const url = kind === "edit"
      ? buildEditUrl(ghHandle, path, branch)
      : buildNewUrl(ghHandle, path, value, branch);
    return { kind: "ready", url };
  }
  return {
    kind: "needs-fork",
    canonicalUrl: canonicalBuilder(),
    forkUrl: buildForkCreateUrl(),
    handle: ghHandle,
    retryHint: "after the fork finishes (~3 seconds), click submit again — every future edit goes directly to your fork.",
  };
}

// ── identity bridge ─────────────────────────────────────────────────
//
// Convenience: pull the current user's GH handle from their claimed
// identity. The identity module persists a record_id; we read that
// record's `links.github` from the cohort surface.

import { getIdentity } from "./identity.js";
import { getCohortSurface } from "./cohort-source.js";

export async function getCurrentGithubHandle() {
  const id = getIdentity();
  if (!id) return null;
  let cohort;
  try { cohort = await getCohortSurface(); } catch { cohort = null; }
  if (!cohort) return null;
  const collection = id.kind === "person" ? cohort.people : cohort.teams;
  const rec = (collection || []).find(r => r.record_id === id.record_id);
  return rec?.links?.github || null;
}

// Convenience: one-shot resolver that pulls the GH handle internally.
export async function resolvePRForCurrentUser(opts) {
  const ghHandle = await getCurrentGithubHandle();
  return resolvePREndpoint({ ...opts, ghHandle });
}
