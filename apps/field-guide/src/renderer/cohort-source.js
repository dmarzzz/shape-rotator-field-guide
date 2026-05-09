// cohort-source.js — the SOLE entry point for cohort data into the
// field-guide app. Per docs/SHAPE-ROTATOR-OS-SPEC.md §4.5.
//
// Phase 3 (current): reads cohort.surface bundles from swf-node's
// /bundles HTTP API. Falls back to the bundled cohort-surface.json
// fixture if swf-node is unreachable, so the app stays functional
// offline (with whatever cohort state was bundled at build time).
//
// SSE-backed live updates: subscribes to /bundles/subscribe?kind=
// cohort.surface; on each new bundle, decodes the payload, updates
// the in-memory cache by record_id, and notifies any subscribers.

let _cache = null;            // grouped by record_type
let _serverUrl = null;
let _es = null;               // EventSource handle
const _subscribers = new Set();

async function getServerUrl() {
  if (_serverUrl) return _serverUrl;
  try {
    const env = await window.api?.env?.();
    _serverUrl = (env?.serverUrl || "http://127.0.0.1:7777").replace(/\/+$/, "");
  } catch {
    _serverUrl = "http://127.0.0.1:7777";
  }
  return _serverUrl;
}

function decodeBundle(b) {
  try {
    const binStr = atob(b.payload);
    const bytes = Uint8Array.from(binStr, c => c.charCodeAt(0));
    const text = new TextDecoder("utf-8").decode(bytes);
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function groupByType(records) {
  const out = { teams: [], people: [], clusters: [] };
  for (const r of records) {
    if (!r || !r.record_type) continue;
    if (r.record_type === "team")    out.teams.push(r);
    if (r.record_type === "person")  out.people.push(r);
    if (r.record_type === "cluster") out.clusters.push(r);
  }
  // Stable order by record_id within each group.
  for (const k of Object.keys(out)) {
    out[k].sort((a, b) => String(a.record_id).localeCompare(String(b.record_id)));
  }
  return out;
}

// Walk a list of bundles and keep only the highest-version per record_id.
// swf-node already orders them but we don't trust the wire to have done
// the de-dup for us.
function latestPerRecordId(bundles) {
  const byId = new Map();
  for (const b of bundles) {
    const cur = byId.get(b.record_id);
    if (!cur || b.version > cur.version) byId.set(b.record_id, b);
  }
  return Array.from(byId.values());
}

async function loadFromSwfNode() {
  const base = await getServerUrl();
  const r = await fetch(`${base}/bundles?kind=cohort.surface`, { cache: "no-store" });
  if (!r.ok) throw new Error(`/bundles HTTP ${r.status}`);
  const j = await r.json();
  const list = Array.isArray(j?.bundles) ? j.bundles : [];
  if (list.length === 0) {
    // swf-node is reachable but has no cohort bundles published yet.
    // Treat the same as a fetch failure → fixture fallback. Otherwise
    // a fresh node would show an empty cohort even though we ship one.
    throw new Error("/bundles returned 0 cohort.surface bundles");
  }
  const records = latestPerRecordId(list).map(decodeBundle).filter(Boolean);
  return groupByType(records);
}

async function loadFromFixture() {
  const url = new URL("../cohort-surface.json", import.meta.url);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`cohort-surface fixture failed: HTTP ${r.status}`);
  const data = await r.json();
  return {
    teams:    Array.isArray(data.teams)    ? data.teams    : [],
    people:   Array.isArray(data.people)   ? data.people   : [],
    clusters: Array.isArray(data.clusters) ? data.clusters : [],
  };
}

/**
 * Returns latest cohort.surface records grouped by type. Tries swf-node
 * first; falls back to the bundled fixture on any error so the field-
 * guide stays usable with the daemon offline.
 */
export async function getCohortSurface() {
  if (_cache) return _cache;
  try {
    _cache = await loadFromSwfNode();
    _cache._source = "swf-node";
  } catch (e) {
    console.warn("[cohort-source] swf-node unreachable; falling back to fixture:", e?.message || e);
    _cache = await loadFromFixture();
    _cache._source = "fixture";
  }
  // Open SSE for live updates if we got data from swf-node.
  if (_cache._source === "swf-node" && !_es) openSse().catch(() => {});
  return _cache;
}

async function openSse() {
  const base = await getServerUrl();
  try {
    _es = new EventSource(`${base}/bundles/subscribe?kind=cohort.surface`);
  } catch (e) {
    console.warn("[cohort-source] SSE open failed:", e);
    return;
  }
  _es.addEventListener("bundle", (ev) => {
    try {
      const env = JSON.parse(ev.data);
      const rec = decodeBundle(env);
      if (!rec || !rec.record_type || !rec.record_id) return;
      // Merge into _cache by record_id.
      const bucket = rec.record_type === "team"    ? _cache.teams
                   : rec.record_type === "person"  ? _cache.people
                   : rec.record_type === "cluster" ? _cache.clusters : null;
      if (!bucket) return;
      const idx = bucket.findIndex(r => r.record_id === rec.record_id);
      if (idx >= 0) bucket[idx] = rec; else bucket.push(rec);
      bucket.sort((a, b) => String(a.record_id).localeCompare(String(b.record_id)));
      // Notify subscribers — pass the changed record so renderers can
      // pulse / highlight / refresh just it.
      for (const cb of _subscribers) {
        try { cb({ type: rec.record_type, id: rec.record_id, fields: rec }); } catch {}
      }
    } catch {}
  });
  _es.addEventListener("error", () => {
    // EventSource auto-reconnects; nothing to do.
  });
}

/**
 * SSE-backed live updates. Subscribers fire on every cohort.surface
 * bundle that arrives via swf-node's /bundles/subscribe stream.
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
  if (_es) { try { _es.close(); } catch {} _es = null; }
}
