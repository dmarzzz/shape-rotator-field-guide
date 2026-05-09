// LENSES — grouping methodologies for the visualizer.
//
// Each lens is a complete recipe for how nodes are spatially grouped + visually
// encoded. Adding a lens = registering one object here; no renderer changes.

import { stableHue, accentFor } from "./colors.js";

const TOPIC_COLOR = {
  reconsolidation:    "#FF8A5B",
  "social-cognition": "#4FE6C4",
  "mech-interp":      "#FFD166",
  psychedelics:       "#C768E8",
  psychocognition:    "#5A9EFF",
  background:         "#7D8AAB",
  multi:              "#F0F4FF",
};

const DAY_MS = 86400000;
const HALF_LIFE_DAYS = 14;

const recencyWarmth = (n) => {
  if (!n.last_visited) return 0;
  const dt = Date.now() - new Date(n.last_visited).getTime();
  return Math.exp(-Math.max(0, dt) / (HALF_LIFE_DAYS * DAY_MS));
};

const lensTopic = {
  id: "topic",
  label: "Topic",
  description: "Group by topic-cluster.",
  groupBy: (n) => n.topic || "background",
  edgeWeight: (e) => e.weight,
  chargeStrength: (n) => -90 - Math.sqrt(n.degree || 0) * 8,
  linkDistance: (e) => 24 + (1 / Math.sqrt(Math.max(1, e.weight))) * 18,
  radial: { strength: 0.06, radius: (k, count) => 200 + Math.sqrt(count) * 40 },
  dimensions: {
    color:  { from: "topic",  via: (t) => TOPIC_COLOR[t] || stableHue(t) },
    accent: { from: "topic",  via: (t) => accentFor(TOPIC_COLOR[t] || stableHue(t)) },
    size:   { from: "degree", via: (d) => 16 + Math.sqrt(d || 0) * 7 },
    glow:   { from: "_temp",  via: (n) => recencyWarmth(n) },
    halo:   { from: "degree", via: (d) => 1.0 + Math.sqrt(d || 0) * 0.18 },
  },
};

const lensDomain = {
  id: "domain",
  label: "Domain",
  description: "Group by host.",
  groupBy: (n) => n.host || "(no-host)",
  edgeWeight: (e) => e.weight,
  chargeStrength: (n) => -80,
  linkDistance: (e) => 30 + (1 / Math.sqrt(Math.max(1, e.weight))) * 20,
  radial: { strength: 0.08, radius: (k, count) => 180 + Math.sqrt(count) * 36 },
  dimensions: {
    color:  { from: "host",   via: stableHue },
    accent: { from: "host",   via: (h) => accentFor(stableHue(h)) },
    size:   { from: "degree", via: (d) => 16 + Math.sqrt(d || 0) * 7 },
    glow:   { from: "_temp",  via: recencyWarmth },
    halo:   { from: "degree", via: (d) => 1.0 + Math.sqrt(d || 0) * 0.18 },
  },
};

const lensContributor = {
  id: "contributor",
  label: "Contributor",
  description: "Group by who fetched it.",
  groupBy: (n) => n.primary_contributor || "(orphan)",
  edgeWeight: (e) => e.weight,
  chargeStrength: () => -85,
  linkDistance: (e) => 26 + (1 / Math.sqrt(Math.max(1, e.weight))) * 18,
  radial: { strength: 0.07, radius: (k, count) => 200 + Math.sqrt(count) * 38 },
  dimensions: {
    color:  { from: "primary_contributor", via: (pk) => contribColor(pk) },
    accent: { from: "primary_contributor", via: (pk) => accentFor(contribColor(pk)) },
    size:   { from: "contributors",        via: (cs) => 16 + Math.sqrt((cs?.length || 1)) * 7 },
    glow:   { from: "_temp",               via: recencyWarmth },
    halo:   { from: "degree",              via: (d) => 1.0 + Math.sqrt(d || 0) * 0.18 },
  },
};

// Resolve a peer's color from the live peers map populated by boot.js;
// fall back to a deterministic hash so unknown / pre-load peers still
// get a stable color.
function contribColor(pk) {
  if (!pk) return "#7D8AAB";
  const peers = (globalThis.srwk && globalThis.srwk.peers) || null;
  const meta = peers && peers.get(pk);
  if (meta && meta.signature_color) return meta.signature_color;
  return stableHue(pk);
}

const lensTime = {
  id: "time",
  label: "Time",
  description: "Sort along the contribution timeline.",
  // grouping is mostly irrelevant; positions come from the shape (use stream)
  groupBy: (n) => bucketWeek(n.fetched_at),
  edgeWeight: () => 0.0001,        // suppress edges
  chargeStrength: () => -30,
  linkDistance: () => 60,
  radial: { strength: 0.0, radius: () => 0 },
  dimensions: {
    color:  { from: "fetched_at", via: ageColor },
    accent: { from: "fetched_at", via: (t) => accentFor(ageColor(t)) },
    size:   { from: "degree",     via: (d) => 18 + Math.sqrt(d || 0) * 7 },
    glow:   { from: "fetched_at", via: ageGlow },
    halo:   { from: "degree",     via: (d) => 1.0 + Math.sqrt(d || 0) * 0.18 },
  },
};

const lensRecency = {
  id: "recency",
  label: "Recency",
  description: "Distance = time since last touched.",
  groupBy: (n) => recencyBand(n.last_visited),
  edgeWeight: (e) => e.weight,
  chargeStrength: () => -75,
  linkDistance: (e) => 28 + (1 / Math.sqrt(Math.max(1, e.weight))) * 18,
  radial: { strength: 0.10, radius: (k) => RECENCY_RADIUS[k] || 600 },
  dimensions: {
    color:  { from: "_temp", via: (n) => warmthHex(recencyWarmth(n)) },
    accent: { from: "_temp", via: (n) => accentFor(warmthHex(recencyWarmth(n))) },
    size:   { from: "degree", via: (d) => 16 + Math.sqrt(d || 0) * 7 },
    glow:   { from: "_temp",  via: recencyWarmth },
    halo:   { from: "degree", via: (d) => 1.0 + Math.sqrt(d || 0) * 0.18 },
  },
};

const lensChaos = {
  id: "chaos",
  label: "Chaos",
  description: "🌀",
  groupBy: () => Math.floor(Math.random() * 32),
  edgeWeight: () => Math.random() * 0.5,
  chargeStrength: () => -40 - Math.random() * 80,
  linkDistance: () => 40 + Math.random() * 80,
  radial: { strength: 0.0, radius: () => 0 },
  dimensions: {
    color:  { from: "id", via: (s) => stableHue(s + Math.random()) },
    accent: { from: "id", via: (s) => accentFor(stableHue(s + Math.random() + "x")) },
    size:   { from: "id", via: () => 50 + Math.random() * 100 },
    glow:   { from: "id", via: () => Math.random() },
    halo:   { from: "id", via: () => 0.5 + Math.random() * 1.5 },
  },
};

// v0 ships 4 lenses. Time/chaos kept in source for reference but unlisted.
export const LENSES = {
  topic:       lensTopic,
  domain:      lensDomain,
  contributor: lensContributor,
  recency:     lensRecency,
};

export const LENS_LIST = [lensTopic, lensDomain, lensContributor, lensRecency];

// ── helpers ───────────────────────────────────────────────────────────────

function bucketWeek(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  // ISO week-stamp: yyyy-Www
  const start = new Date(d.getFullYear(), 0, 1);
  const wk = Math.ceil((((d - start) / 86400000) + start.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${String(wk).padStart(2, "0")}`;
}

function ageColor(iso) {
  if (!iso) return "#7D8AAB";
  const days = Math.max(0, (Date.now() - new Date(iso).getTime()) / DAY_MS);
  // recent = warm peach, old = cool indigo
  const k = Math.min(1, days / 60);
  return interpolateHex("#FFD8A8", "#5566AA", k);
}
function ageGlow(iso) {
  if (!iso) return 0;
  const days = (Date.now() - new Date(iso).getTime()) / DAY_MS;
  return Math.exp(-Math.max(0, days) / 30);
}
function warmthHex(w) {
  // 0 = cool blue, 1 = hot peach
  return interpolateHex("#5A9EFF", "#FF8A5B", w);
}
function interpolateHex(a, b, t) {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const ar = (pa >> 16) & 255, ag = (pa >> 8) & 255, ab = pa & 255;
  const br = (pb >> 16) & 255, bg = (pb >> 8) & 255, bb = pb & 255;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const b2 = Math.round(ab + (bb - ab) * t);
  return `#${[r, g, b2].map(v => v.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

const RECENCY_BANDS = ["today", "this-week", "this-month", "older", "untouched"];
const RECENCY_RADIUS = { today: 100, "this-week": 280, "this-month": 480, older: 720, untouched: 980 };
function recencyBand(iso) {
  if (!iso) return "untouched";
  const dt = (Date.now() - new Date(iso).getTime()) / DAY_MS;
  if (dt < 1) return "today";
  if (dt < 7) return "this-week";
  if (dt < 30) return "this-month";
  return "older";
}
