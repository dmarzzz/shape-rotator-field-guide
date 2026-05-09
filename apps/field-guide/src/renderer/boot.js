// BOOT — wires lens + shape + dimension + materialization into a running viz.
//
// What this does:
//  - Fetches /graph from the community server
//  - Builds 3d-force-graph with sprite-per-node rendering
//  - Subscribes to /events SSE for live materialization
//  - Listens to lens/shape dropdown changes → re-applies dimensions + relayouts
//  - Heavy damping; idle camera drift

import * as THREE from "three";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";

import { LENSES, LENS_LIST } from "./lenses.js";
import { SHAPES, SHAPE_LIST, easeOutQuart } from "./shapes.js";
import { applyAllDimensions, applyDimensions } from "./dimensions.js";
import { DAMP, dampPosition } from "./damping.js";
import { materialize } from "./materialize.js";
import { syncLabels, fadeLabelsByDistance } from "./labels.js";
import { stableHue } from "./colors.js";
import {
  toast,
  mountConnectionIndicator,
  setConnectionState,
  noteConnectionEvent,
  registerCommands,
  registerKeyboardShortcuts,
  openCommandPalette,
  openKeyboardOverlay,
  wireGlobalKeyboard,
  toggleManualReducedMotion,
  isReducedMotion,
} from "./ux.js";
import {
  tickNumber,
  morphActiveTab,
  mountTabIndicator,
  updateTabIndicator,
  revealOnce,
  magnetize,
  rotorMarkup,
} from "./motion.js";
import {
  mountLaunchOverlay,
  mountTitlebarMark,
  mountPaletteMark,
  replayLaunch,
} from "./signature.js";
// graph2 + cosmos archived 2026-05-09 — see _archive/experimental/.
// Kept as no-op stubs so existing call sites (all wrapped in try/catch
// already) continue to compile without ceremony.
const Graph2 = { mount() {}, setActive() {}, notifyDataChanged() {}, pulseNode() {} };
const Cosmos = { mount() {}, setActive() {}, notifyDataChanged() {}, pulseNode() {} };
import * as Atlas from "./atlas.js";
import * as Alchemy from "./alchemy.js";

// Shorthand: animate a numeric DOM cell to `n`. We wrap tickNumber so the
// dozens of "el.textContent = …" call sites flip to the animated path
// without ceremony. Pass `fmt` for non-trivial formatters (bytes, %).
function tick(elOrId, n, fmt) {
  const el = (typeof elOrId === "string") ? document.getElementById(elOrId) : elOrId;
  if (!el) return;
  tickNumber(el, n, { format: fmt || ((v) => String(Math.round(v))) });
}

const srwk = {
  G: null,
  scene: null,
  serverUrl: "http://127.0.0.1:7777",  // swf-node default; main.js overrides via env:get
  graph: null,
  nodes: [],
  edges: [],
  peers: new Map(),
  nodeMap: new Map(),
  spriteTex: null, haloTex: null,
  startTime: performance.now(),
  bounds: { radius: 600 },
  lens: LENSES.contributor,       // peer-territory view — most legible default
  shape: SHAPES.cluster,
  shapeTransition: null,         // {start, duration, source: Map, target: Map}
  groupCentroids: new Map(),
  driftBase: { x: 0, y: 0, z: 0 },
  lastUserT: 0,
  lastEventId: 0,                // for SSE replay on reconnect
  eventSource: null,
  clusters: [],                  // server-computed cluster labels
  labelMap: new Map(),           // key → THREE.Sprite
  liveSeen: new Map(),           // pubkey → ms-timestamp of last contribution event
};

const LIVE_WINDOW_MS = 90000;

function refreshLiveCount() {
  const now = performance.now();
  let live = 0;
  for (const [, t] of state_liveSeen()) {
    if (now - t < LIVE_WINDOW_MS) live++;
  }
  tick("live-count", live);
}
function state_liveSeen() { return srwk.liveSeen; }
setInterval(() => refreshLiveCount(), 5000);

// ─── app-update chip (electron-updater + GitHub Releases) ────────────
// Wires the version chip in the top-right of the tab bar. On boot, paints
// `v0.x.y` (or `v0.x.y · dev` in dev). Click checks for updates; if one's
// available, download → install via two confirms. Background "available"
// styling kicks in once we know there's a newer version.
async function wireAppUpdateChip() {
  const chip = document.getElementById("fg-version-chip");
  if (!chip) return;
  let info = null;
  try { info = await window.api.getAppInfo?.(); } catch {}
  if (info) {
    chip.textContent = `v${info.version}${info.isPackaged ? "" : "·dev"}`;
    chip.title = info.isPackaged
      ? `v${info.version} · click to check for updates`
      : `v${info.version} · dev mode (auto-update disabled)`;
  } else {
    chip.textContent = "v?";
  }
  chip.addEventListener("click", checkAppUpdate);
}
async function checkAppUpdate() {
  const chip = document.getElementById("fg-version-chip");
  if (!chip) return;
  const prevTitle = chip.title;
  chip.title = "checking for updates…";
  try {
    const r = await window.api.checkAppUpdate?.();
    if (!r) { chip.title = prevTitle; return; }
    if (!r.ok && r.reason === "dev_mode") {
      chip.title = `dev mode · ${r.detail || "update disabled"}`;
      return;
    }
    if (!r.ok) {
      chip.title = `update check failed: ${r.detail || r.reason}`;
      return;
    }
    if (!r.available) {
      chip.title = `up to date · v${r.current}`;
      chip.removeAttribute("data-update");
      return;
    }
    chip.dataset.update = "available";
    chip.title = `update available · v${r.latest} (you have v${r.current})`;
    const ok = window.confirm(`Update available: v${r.latest} (you have v${r.current}).\n\nDownload now? It will install on next quit.`);
    if (!ok) return;
    chip.title = "downloading update…";
    const dl = await window.api.applyAppUpdate?.();
    if (!dl?.ok) {
      chip.title = `download failed: ${dl?.detail || dl?.reason || "unknown"}`;
      return;
    }
    const restart = window.confirm(`Downloaded v${r.latest}.\n\nRestart now to install?`);
    if (restart) {
      await window.api.applyUpdateAndRestart?.();
    } else {
      chip.title = `v${r.latest} downloaded · will install on next quit`;
    }
  } catch (e) {
    chip.title = `update flow failed: ${e?.message || e}`;
  }
}

async function boot() {
  const env = await window.api.env();
  srwk.serverUrl = env.serverUrl;

  srwk.spriteTex = makeSpriteTex();
  srwk.haloTex = makeHaloTex();

  // populate dropdowns
  const lensSel = document.getElementById("lens-select");
  for (const l of LENS_LIST) {
    const opt = document.createElement("option");
    opt.value = l.id; opt.textContent = l.label; lensSel.appendChild(opt);
  }
  const shapeSel = document.getElementById("shape-select");
  for (const s of SHAPE_LIST) {
    const opt = document.createElement("option");
    opt.value = s.id; opt.textContent = s.label; shapeSel.appendChild(opt);
  }
  lensSel.value = srwk.lens.id;
  shapeSel.value = srwk.shape.id;
  lensSel.addEventListener("change", () => switchLens(LENSES[lensSel.value]));
  shapeSel.addEventListener("change", () => switchShape(SHAPES[shapeSel.value]));

  // Signature first-launch animation — the rotor glyph assembles from
  // four scattered dots and the SHAPE ROTATOR wordmark resolves. Lives
  // in signature.js. Skippable on Esc / Enter / pointerdown / Space.
  // After the first run the same overlay shows a 220ms quick fade.
  mountLaunchOverlay();
  mountTitlebarMark();
  mountPaletteMark();

  // mount global UX scaffolding before everything else so any boot-time
  // toast / status update lands in the right surface
  mountConnectionIndicator({ serverUrl: srwk.serverUrl });
  setConnectionState({ state: "connecting", serverUrl: srwk.serverUrl });
  wireGlobalKeyboard();
  registerVisualizerShortcutsAndCommands();

  // Identity pill in the top-right of the tab bar + first-launch
  // onboarding modal. Pill is mounted immediately (paints as
  // "claim profile" until cohort loads); modal fires once cohort
  // bundles are available so there's actually something to pick from.
  try {
    const { mountIdentityPill, maybeShowOnboarding } = await import("./identity.js");
    mountIdentityPill(document.getElementById("tab-bar"));
    // Defer onboarding past the boot crunch so it lands on a settled UI.
    setTimeout(() => { maybeShowOnboarding(); }, 1200);
  } catch (e) {
    console.warn("[boot] identity module failed to load:", e?.message || e);
  }

  // App version + auto-update chip (electron-updater + GitHub Releases).
  // Paints "v0.x" in the top-right; click checks for an update and walks
  // the user through download → install. No-op in dev (the IPC handler
  // returns reason: "dev_mode").
  wireAppUpdateChip();

  // Wire tabs + search-overlay FIRST so the UI is navigable even if the
  // swf-node graph fetch fails. Previously a `Failed to fetch` from
  // loadGraph would halt boot before wireTabs ran, leaving the user
  // stuck on whatever data-active-tab the HTML defaults to with no way
  // to switch. Atlas + alchemy don't actually need the graph data to
  // mount; they read from their own sources.
  wireSearchTab();
  const atlasSearchToggle = document.getElementById("atlas-search-toggle");
  if (atlasSearchToggle) atlasSearchToggle.addEventListener("click", () => openAtlasSearch());
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && document.body.dataset.atlasSearch === "open") {
      const inp = document.getElementById("search-input");
      if (document.activeElement === inp) {
        e.preventDefault();
        closeAtlasSearch();
      }
    }
  });
  wireMetricsTab();
  wireTabs();
  wireAtlasOfflinePanel();

  setStatus("composing graph…");
  try {
    await loadGraph();
  } catch (e) {
    // swf-node not running, network problem, etc. Don't kill the UI —
    // surface the state and continue. startConnectionProbe + the SSE
    // subscriber will retry; tabs that don't need the graph keep
    // working in the meantime.
    console.warn("[boot] loadGraph failed; continuing without graph data:", e?.message || e);
    setStatus("offline · swf-node unreachable", true);
    setConnectionState({ state: "disconnected", serverUrl: srwk.serverUrl });
    // Provide enough state for downstream wiring not to NPE.
    srwk.graph = { nodes: [], edges: [], clusters: [], peers: [] };
    srwk.nodes = [];
    srwk.edges = [];
    srwk.clusters = [];
    showAtlasOffline();
  }
  // Clear the "composing graph…" only on success; if the catch fired
  // above, that status message is the one we want to keep visible.
  if (srwk.nodes && srwk.nodes.length > 0) {
    setStatus("");
    hideAtlasOffline();
  }
  try { buildSim(); } catch (e) { console.warn("[boot] buildSim failed:", e); }
  try { subscribeEvents(); } catch (e) { console.warn("[boot] subscribeEvents failed:", e); }
  wirePeersPanel();
  wireEventsPanel();
  wireTrafficPanel();
  wireTicketsPanel();
  wireReceiptsPanel();
  wireRouterPanel();
  wireAnonBadge();
  wireTimeline();
  wireLiveGraph();
  wireSearch();
  wireSourceFilter();
  startGraphReconcile();
  startConnectionProbe();

  // idle drift — only if buildSim succeeded and srwk.G exists.
  const mark = () => { srwk.lastUserT = performance.now(); };
  try {
    const ctrls = srwk.G?.controls?.();
    if (ctrls?.addEventListener) {
      ctrls.addEventListener("start", mark);
      ctrls.addEventListener("change", mark);
    }
  } catch {}
  const graphEl = document.getElementById("graph");
  if (graphEl) graphEl.addEventListener("wheel", mark, { passive: true });

  // animation loop
  let last = performance.now();
  function tick(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    advanceShapeTransition(dt);
    ambientCameraDrift(dt);
    if (srwk.G) {
      // _fadeLabels is the search-aware wrapper installed at module
      // scope; fall back to the plain fadeLabelsByDistance if for any
      // reason the wrapper isn't yet defined (e.g. early boot).
      const fade = srwk._fadeLabels || fadeLabelsByDistance;
      fade(srwk.G.camera(), srwk.labelMap);
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

async function loadGraph() {
  const r = await fetch(`${srwk.serverUrl}/graph?lens=${srwk.lens.id}`);
  if (!r.ok) throw new Error(`graph fetch failed: ${r.status}`);
  srwk.graph = await r.json();
  srwk.nodes = srwk.graph.nodes;
  srwk.edges = srwk.graph.edges;
  srwk.clusters = srwk.graph.clusters || [];
  for (const n of srwk.nodes) srwk.nodeMap.set(n.id, n);
  for (const p of srwk.graph.peers || []) srwk.peers.set(p.pubkey, p);
  // mark-count is a compound string; not amenable to animated-counter.
  document.getElementById("mark-count").textContent =
    `${srwk.nodes.length}n · ${srwk.edges.length}e`;
  tick("node-count", srwk.nodes.length);
  tick("edge-count", srwk.edges.length);
  tick("peer-count", srwk.peers.size);
  pushConnPeers();
  applyAllDimensions(srwk.nodes, srwk.lens);
  if (typeof renderPeersPanel === "function") renderPeersPanel();
}

function buildSim() {
  const container = document.getElementById("graph");
  const G = ForceGraph3D({ controlType: "orbit" })(container)
    .backgroundColor("rgba(10,6,18,1)")
    .showNavInfo(false)
    .nodeId("id")
    .nodeThreeObject((n) => buildNodeObject(srwk.nodeMap.get(n.id) || n))
    .nodeThreeObjectExtend(false)
    .linkSource("source").linkTarget("target")
    .linkColor((l) => _linkColor(l))
    .linkOpacity(0.45)
    .linkWidth((l) => _linkWidth(l))
    .linkCurvature(0.18)                  // gentle bezier — organic, not wire
    .linkCurveRotation(() => Math.random() * Math.PI * 2)
    .linkDirectionalParticles((l) => _linkParticles(l))
    .linkDirectionalParticleSpeed((l) => Math.min(0.012, 0.003 + (l.weight || 1) * 0.0015))
    .linkDirectionalParticleWidth((l) => _linkParticleWidth(l))
    .linkDirectionalParticleColor((l) => _linkParticleColor(l))
    .enableNodeDrag(false)
    .nodeLabel((n) => `<div class="node-tooltip">
        <div class="t-title">${escHtml((n.title || n.id).slice(0, 80))}</div>
        <div class="t-host">${escHtml(n.host || "")}</div>
      </div>`)
    .onNodeClick((n) => onNodeClick(n))
    .d3AlphaDecay(DAMP.alphaDecay)
    .d3VelocityDecay(DAMP.velocityDecay)
    .cooldownTicks(DAMP.cooldownTicks || 600)
    .graphData({ nodes: srwk.nodes, links: srwk.edges });

  applyForcesForLens(G, srwk.lens);
  srwk.G = G;
  srwk.scene = G.scene();

  // ACES filmic tone mapping is the canonical recipe for HDR + bloom
  // scenes. Without it, additive sprite stacks clamp to white in the
  // sRGB OutputPass. With it, values >1 compress gracefully toward white
  // instead of saturating.
  const renderer = G.renderer();
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.85;

  // Bloom amplifies bright pixels; we let it do the glowing rather than
  // multiplying per-sprite intensity. Strength + radius produce the diffuse
  // bleed; threshold lets only halo cores through.
  // strength 0.18 + threshold 0.82 — bloom is barely perceptible, just
  // a faint sheen on the brightest cores. Glow accumulation in dense
  // territories was visually obliterating the underlying structure.
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(container.clientWidth, container.clientHeight),
    0.18, 0.75, 0.82,
  );
  G.postProcessingComposer().addPass(bloom);

  // Volumetric fog — distant nodes recede into haze, gives 3D depth cue
  srwk.scene.fog = new THREE.FogExp2(0x05031a, 0.00038);

  // Ambient dust-mote field. ~3000 particles in a large volume, slow drift.
  // Independent of the data graph — pure atmosphere, sets the "deep space"
  // feel and makes the camera drift legible.
  buildAtmosphere(srwk.scene);

  G.width(container.clientWidth).height(container.clientHeight);
  bloom.setSize(container.clientWidth, container.clientHeight);

  let _densityTick = 0;
  G.onEngineTick(() => {
    // Density is expensive (O(n²)); only refresh every 4th tick.
    _densityTick = (_densityTick + 1) % 4;
    if (_densityTick === 0) updateLocalDensity();
    updateGroupCentroids();
    syncLabels({
      scene: srwk.scene,
      clusterDefs: srwk.clusters,
      labelMap: srwk.labelMap,
      groupCentroids: srwk.groupCentroids,
    });
  });

  // The new shell-radial layout spans ~3600 units across; fit camera once
  // the sim has had time to settle into its territories.
  setTimeout(() => {
    if (srwk.G && typeof srwk.G.zoomToFit === "function") {
      srwk.G.zoomToFit(1600, 80);
    }
  }, 1500);
  setTimeout(() => {
    if (srwk.G && typeof srwk.G.zoomToFit === "function") {
      srwk.G.zoomToFit(1800, 100);
    }
  }, 4500);
}

// ─── edge styling helpers ────────────────────────────────────────────────
// A "bridging" edge is one whose source and target have different
// primary_contributor. Those are the visible threads of cross-peer
// shared knowledge — render brighter, wider, more particles.

function _bridging(l) {
  const s = typeof l.source === "object" ? l.source : srwk.nodeMap.get(l.source);
  const t = typeof l.target === "object" ? l.target : srwk.nodeMap.get(l.target);
  if (!s || !t) return false;
  return s.primary_contributor && t.primary_contributor &&
         s.primary_contributor !== t.primary_contributor;
}
function _linkColor(l) {
  if (_bridging(l)) return "rgba(255, 240, 220, 0.85)";  // warm white for bridges
  return "rgba(180, 200, 255, 0.28)";
}
function _linkWidth(l) {
  const w = l.weight || 1;
  return _bridging(l) ? 1.6 + Math.min(2.4, w * 0.4)
                      : 0.6 + Math.min(1.2, w * 0.2);
}
function _linkParticles(l) {
  const w = l.weight || 1;
  if (_bridging(l)) return Math.min(5, 2 + Math.floor(w / 2));
  return w >= 2 ? 2 : 1;
}
function _linkParticleWidth(l) {
  return _bridging(l) ? 2.4 : 1.2;
}
function _linkParticleColor(l) {
  if (_bridging(l)) return "#FFFFFF";
  return "rgba(180, 220, 255, 0.85)";
}

function applyForcesForLens(G, lens) {
  // Tuned charge: modest, with distanceMax so charge doesn't push every
  // node away from every other node across the whole volume. This lets
  // peer territories actually settle near their anchors instead of all
  // three pushing each other into corners.
  G.d3Force("link")
    .distance((e) => 35 + (1 / Math.sqrt(Math.max(1, e.weight || 1))) * 22)
    .strength((e) => Math.min(0.7, 0.25 + (e.weight || 1) * 0.1));
  const charge = G.d3Force("charge");
  // Mid-range charge (-110) + capped distance so it provides local
  // separation but doesn't fight macro/micro pulls at long range.
  charge.strength((n) => -110 - Math.sqrt(n.degree || 0) * 6);
  if (typeof charge.distanceMax === "function") charge.distanceMax(140);
  if (typeof charge.distanceMax === "function") charge.distanceMax(800);
  if (typeof charge.theta === "function")       charge.theta(0.9);

  // Collide: octree-based hard floor preventing nodes from occupying
  // the same coordinate. This is what stops "all-150-in-bucket stack
  // at the anchor point" — radial pull wants stack, collide forbids it.
  let collide = G.d3Force("collide");
  if (!collide) {
    // 3d-force-graph delegates to d3-force-3d which exposes forceCollide
    // via the forceCollide import. Construct it lazily here.
    collide = _forceCollide3d((n) => Math.max(8, ((n._dims?.size) || 30) * 0.5));
    G.d3Force("collide", collide);
  }
  if (typeof collide.radius === "function") {
    // Larger collide radius forces nodes to spread out more — this is
    // what makes a territory READ as a constellation rather than a tight
    // blob. Each node "owns" a region of size×0.85.
    collide.radius((n) => Math.max(8, ((n._dims?.size) || 18) * 0.75))
           .strength?.(0.95)
           .iterations?.(2);
  }

  // Macro pull — soft point-attraction (gravity well per peer territory).
  // forceCollide stops nodes from stacking at the same coordinate, so
  // we don't need shell-radial. Net effect: each peer's nodes form a
  // solid blob around its vertex with internal sub-cluster structure
  // from the link force.
  computeHierarchicalAnchors(srwk.nodes, lens);
  // kMacro = 0.04 — strong enough that 3 peer territories stay visibly
  // separate (otherwise charge dominates and the whole graph merges into
  // one nebula). Supernova at high macro pull is prevented by forceCollide
  // + density-aware halo fade in the renderer, so we can afford the bump.
  const kMacro = 0.04;
  // macroPull = soft tug toward the peer's territory; microPull =
  // stronger tug toward each sub-cluster's anchor so sub-clusters
  // form visible pockets inside the territory rather than blending.
  G.d3Force("macroPull", (alpha) => {
    const k = kMacro * alpha * 1.5;
    for (const n of srwk.nodes) {
      if (n._macroX == null) continue;
      n.vx = (n.vx || 0) + (n._macroX - n.x) * k;
      n.vy = (n.vy || 0) + (n._macroY - n.y) * k;
      n.vz = (n.vz || 0) + (n._macroZ - n.z) * k;
    }
  });
  // microPull is 8× macroPull and grows quadratically with distance from
  // the sub-cluster anchor — so a node that drifts twice as far gets
  // pulled back four times as hard. This is what actually makes
  // sub-clusters cluster instead of just biasing position.
  G.d3Force("microPull", (alpha) => {
    const k = kMacro * alpha * 8.0;
    for (const n of srwk.nodes) {
      if (n._microX == null) continue;
      const dx = n._microX - n.x, dy = n._microY - n.y, dz = n._microZ - n.z;
      const d = Math.sqrt(dx*dx + dy*dy + dz*dz) || 1;
      const pull = Math.min(1.0, d / 80);  // ramps up over 80 units
      n.vx = (n.vx || 0) + dx * k * pull;
      n.vy = (n.vy || 0) + dy * k * pull;
      n.vz = (n.vz || 0) + dz * k * pull;
    }
  });
  // Note: micro radial pull is intentionally REMOVED. Sub-clustering by
  // host/topic emerges from edge structure + charge + collide, not from
  // a second point-spring. If the data has same-host nodes that aren't
  // edge-linked, they'll still cluster locally via charge interactions
  // within their peer's shell.
}

// Tiny inline forceCollide for 3D — d3-force ships only 2D forceCollide
// and I don't want to pull in d3-force-3d as a separate import. This is
// a simplified Barnes-Hut-free O(N²) version. For 500 nodes that's fine
// (~250k pairs/tick at low alpha).
function _forceCollide3d(radiusFn) {
  let nodes = [];
  let radius = radiusFn || (() => 10);
  let strength = 0.9;
  let iterations = 2;
  function force(alpha) {
    const n = nodes.length;
    for (let iter = 0; iter < iterations; iter++) {
      for (let i = 0; i < n; i++) {
        const a = nodes[i];
        const ra = radius(a);
        for (let j = i + 1; j < n; j++) {
          const b = nodes[j];
          const rb = radius(b);
          const minD = ra + rb;
          let dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
          let d2 = dx*dx + dy*dy + dz*dz;
          if (d2 >= minD * minD || d2 === 0) continue;
          const d = Math.sqrt(d2) || 0.001;
          const overlap = (minD - d) * strength * alpha * 0.5;
          dx = (dx / d) * overlap;
          dy = (dy / d) * overlap;
          dz = (dz / d) * overlap;
          a.vx = (a.vx || 0) - dx; a.vy = (a.vy || 0) - dy; a.vz = (a.vz || 0) - dz;
          b.vx = (b.vx || 0) + dx; b.vy = (b.vy || 0) + dy; b.vz = (b.vz || 0) + dz;
        }
      }
    }
  }
  force.initialize = (ns) => { nodes = ns; };
  force.radius = (fn) => { if (fn === undefined) return radius; radius = typeof fn === "function" ? fn : (() => fn); return force; };
  force.strength = (s) => { if (s === undefined) return strength; strength = s; return force; };
  force.iterations = (i) => { if (i === undefined) return iterations; iterations = i; return force; };
  return force;
}

// Polyhedron vertices: tetrahedron for ≤4 macro groups, octahedron for ≤6,
// cube for ≤8, dodecahedron for ≤12, icosahedron for ≤20. For >20 we fall
// back to a Fibonacci sphere (still better than nothing). Vertices are
// returned at unit radius; caller scales.
function _polyhedronVertices(n) {
  if (n <= 4) {
    // tetrahedron
    return [
      [ 1,  1,  1], [ 1, -1, -1], [-1,  1, -1], [-1, -1,  1],
    ].slice(0, Math.max(2, n)).map(v => {
      const r = Math.hypot(v[0], v[1], v[2]);
      return [v[0]/r, v[1]/r, v[2]/r];
    });
  }
  if (n <= 6) {
    return [
      [1,0,0], [-1,0,0], [0,1,0], [0,-1,0], [0,0,1], [0,0,-1],
    ].slice(0, n);
  }
  if (n <= 8) {
    const s = 1/Math.sqrt(3);
    return [
      [s,s,s], [s,s,-s], [s,-s,s], [s,-s,-s],
      [-s,s,s], [-s,s,-s], [-s,-s,s], [-s,-s,-s],
    ].slice(0, n);
  }
  // 9..20: dodecahedron vertices (20 of them)
  if (n <= 20) {
    const phi = (1 + Math.sqrt(5)) / 2;
    const a = 1, b = 1/phi, c = phi;
    const verts = [
      [a,a,a],[a,a,-a],[a,-a,a],[a,-a,-a],
      [-a,a,a],[-a,a,-a],[-a,-a,a],[-a,-a,-a],
      [0,b,c],[0,b,-c],[0,-b,c],[0,-b,-c],
      [b,c,0],[b,-c,0],[-b,c,0],[-b,-c,0],
      [c,0,b],[c,0,-b],[-c,0,b],[-c,0,-b],
    ];
    return verts.slice(0, n).map(v => {
      const r = Math.hypot(v[0], v[1], v[2]);
      return [v[0]/r, v[1]/r, v[2]/r];
    });
  }
  // >20: Fibonacci sphere fallback
  const out = [];
  const phi2 = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / Math.max(1, n - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const t = phi2 * i;
    out.push([Math.cos(t) * r, y, Math.sin(t) * r]);
  }
  return out;
}

// Pick a micro grouping that won't collapse to "1 group per peer".
// If the lens groups by primary_contributor (same as macro), fall back
// to topic→host so sub-clusters actually exist visually within each
// peer territory.
function _microKeyFor(lens, n) {
  const k = lens.groupBy ? lens.groupBy(n) : null;
  if (lens.id !== "contributor") return k || "(none)";
  return n.topic || n.host || "(none)";
}

function computeHierarchicalAnchors(nodes, lens) {
  // 1) Group by macro = primary_contributor.
  const macroBuckets = new Map();
  for (const n of nodes) {
    const m = n.primary_contributor || "(orphan)";
    if (!macroBuckets.has(m)) macroBuckets.set(m, []);
    macroBuckets.get(m).push(n);
  }
  const macroKeys = [...macroBuckets.keys()];
  const Mn = Math.max(1, macroKeys.length);

  // Macro anchors at polyhedron vertices, scaled into a real volume
  // (not a thin shell). Spacing scales with √N — tighter for few peers,
  // wider for many.
  const macroR = 620 + Math.sqrt(Mn) * 100;
  const verts = _polyhedronVertices(Mn);
  const macroAnchor = new Map();
  macroKeys.forEach((mk, i) => {
    const v = verts[i] || [0, 0, 0];
    macroAnchor.set(mk, { x: v[0] * macroR, y: v[1] * macroR, z: v[2] * macroR });
  });

  // 2) Within each macro bucket, group by micro = lens.groupBy.
  // Place micro anchors on a local sphere around the macro anchor.
  // Sphere radius scales with √N per peer so big peers (e.g. 400 nodes)
  // get a proportionally larger territory and don't pack-saturate the
  // bloom. Without this, alice's 400 nodes pile into the same volume as
  // bob's 30 and the cumulative bloom blows out to white.
  for (const [mk, ns] of macroBuckets) {
    const anchor = macroAnchor.get(mk);
    const microR = Math.max(macroR * 0.32, 70 + Math.sqrt(ns.length) * 22);
    const microGroups = new Map();
    for (const n of ns) {
      const k = _microKeyFor(lens, n);
      n._microKey = k;
      if (!microGroups.has(k)) microGroups.set(k, []);
      microGroups.get(k).push(n);
    }
    const microKeys = [...microGroups.keys()];
    const Mi = Math.max(1, microKeys.length);
    const phi = Math.PI * (3 - Math.sqrt(5));
    microKeys.forEach((mik, i) => {
      const y = Mi === 1 ? 0 : (1 - (i / (Mi - 1)) * 2);
      const r = Math.sqrt(1 - y * y);
      const theta = phi * i;
      // Vary radial depth per micro-group so anchors fill the volume
      // (cube-root distribution = uniform fill of the ball). Without
      // this, all anchors sit on the shell and big peers bloom-flood
      // their hollow center.
      const depth = Mi === 1 ? 0 : Math.cbrt(0.15 + 0.85 * (i / (Mi - 1)));
      const rr = microR * depth;
      const mx = anchor.x + Math.cos(theta) * r * rr;
      const my = anchor.y + y * rr;
      const mz = anchor.z + Math.sin(theta) * r * rr;
      for (const n of microGroups.get(mik)) {
        n._macroX = anchor.x; n._macroY = anchor.y; n._macroZ = anchor.z;
        n._microX = mx;       n._microY = my;       n._microZ = mz;
      }
    });
  }
}

// Cache of CanvasTextures keyed by sorted "color1,color2,..." string.
// Multi-contributor sprites get a procedurally-painted radial gradient
// where each contributor occupies an equal angular slice. Single-contributor
// nodes still use the global solid spriteTex.
const _gradientTexCache = new Map();
function getGradientTex(colors) {
  // colors: array of "#RRGGBB" strings, sorted for cache stability
  const key = colors.join(",");
  if (_gradientTexCache.has(key)) return _gradientTexCache.get(key);
  const SIZE = 256;
  const c = document.createElement("canvas");
  c.width = c.height = SIZE;
  const ctx = c.getContext("2d");
  ctx.clearRect(0, 0, SIZE, SIZE);
  // n equal angular wedges, each tinted by one contributor's color, with
  // a soft radial falloff. Wedges blend at the center via additive blending
  // when the sprite is rendered.
  const cx = SIZE / 2, cy = SIZE / 2;
  const r = SIZE / 2;
  const n = colors.length;
  const sweep = (Math.PI * 2) / n;
  for (let i = 0; i < n; i++) {
    const a0 = -Math.PI / 2 + i * sweep;
    const a1 = a0 + sweep;
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    grad.addColorStop(0,    `${colors[i]}EE`);
    grad.addColorStop(0.10, `${colors[i]}88`);
    grad.addColorStop(0.20, `${colors[i]}22`);
    grad.addColorStop(0.30, `${colors[i]}00`);
    grad.addColorStop(1,    `${colors[i]}00`);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, a0, a1);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  _gradientTexCache.set(key, tex);
  return tex;
}

// Stable hash → small float in [-0.5, 0.5]. Used to derive a per-cluster
// hue offset within a peer's color, so sub-clusters share a family but
// look distinct up close.
function _hashUnit(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return ((h % 10000) / 10000) - 0.5;
}

function buildNodeObject(n) {
  const d = n._dims || applyDimensions(n, srwk.lens);
  const baseColor = new THREE.Color(d.color || "#888");
  // Per-cluster hue offset: ±0.045 (≈ ±16°) and ±5% lightness around the
  // peer's signature color. Same peer reads as one color from far away;
  // sub-clusters separate visually as you zoom in.
  const microKey = n._microKey || "";
  const macroKey = n.primary_contributor || "";
  const seed = `${macroKey}::${microKey}`;
  // ±0.10 hue (≈ ±36°), ±0.18 lightness, ±0.20 saturation: each
  // sub-cluster within a peer reads as a distinct shade — coral vs
  // rose vs salmon under the "pink" umbrella, not a single uniform pink.
  const hueDelta   = _hashUnit(seed) * 0.20;
  const lightDelta = _hashUnit(seed + "L") * 0.36;
  const satDelta   = _hashUnit(seed + "S") * 0.40;
  const hsl = { h: 0, s: 0, l: 0 };
  baseColor.getHSL(hsl);
  baseColor.setHSL(
    (hsl.h + hueDelta + 1) % 1,
    Math.max(0.30, Math.min(1.0, hsl.s + satDelta)),
    Math.max(0.30, Math.min(0.85, hsl.l + lightDelta)),
  );
  const baseSize = d.size || 30;

  // Resolve every contributor's signature_color so we can paint the
  // sprite multi-tone if the page has more than one contributor.
  const contribColors = (n.contributors || [])
    .map((pk) => srwk.peers.get(pk)?.signature_color || stableHue(pk))
    .filter(Boolean);
  const uniqueColors = [...new Set(contribColors)].sort();
  const isMulti = uniqueColors.length >= 2;

  // Core texture: solid for single-contributor, multi-slice for shared.
  const coreTex = isMulti ? getGradientTex(uniqueColors) : srwk.spriteTex;
  // When gradient texture is used, the material color is white (the
  // gradient brings its own color); otherwise we tint by baseColor.
  const coreMatColor = isMulti ? new THREE.Color("#FFFFFF") : baseColor.clone();

  // Core uses NormalBlending — does NOT accumulate when sprites overlap.
  // 100 stacked cores still equal one core. This is what kills the
  // "white sun" pathology. Halos stay additive for the bioluminescent
  // glow effect; only the inner core is non-accumulating.
  const coreMat = new THREE.SpriteMaterial({
    map: coreTex, color: coreMatColor,
    transparent: true, depthWrite: false,
    blending: THREE.NormalBlending, fog: false,
  });
  const haloMat = new THREE.SpriteMaterial({
    map: srwk.haloTex, color: baseColor.clone(),
    transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, fog: false,
  });
  // Third "atmospheric" halo: very large, very dim, gives every node a
  // diffuse field around it. Bioluminescent jellyfish vibe.
  const atmosMat = new THREE.SpriteMaterial({
    map: srwk.haloTex, color: baseColor.clone(),
    transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, fog: false,
  });

  const sizeMultiplier = isMulti ? 1.15 + 0.06 * (uniqueColors.length - 2) : 1.0;
  const coreSize = baseSize * sizeMultiplier;
  const haloSize = baseSize * 3.6 * sizeMultiplier;
  const atmosSize = baseSize * 2.8 * sizeMultiplier;

  const core = new THREE.Sprite(coreMat); core.scale.set(coreSize, coreSize, 1);
  const halo = new THREE.Sprite(haloMat); halo.scale.set(haloSize, haloSize, 1);
  const atmos = new THREE.Sprite(atmosMat); atmos.scale.set(atmosSize, atmosSize, 1);

  const group = new THREE.Group();
  group.add(atmos);
  group.add(halo);
  group.add(core);
  // Per-node breathing period randomized 3-7s (sets ω = 2π/period).
  // Desynced breathing reads as a coral reef; synced reads as a screensaver.
  // Slight skew: more popular nodes breathe a bit faster.
  const period = 3.5 + Math.random() * 3.5;
  const degBoost = Math.min(1.4, 1.0 - Math.sqrt(n.degree || 0) * 0.05);
  const breathOmega = (2 * Math.PI / period) * (1 / Math.max(0.7, degBoost));
  group.userData = {
    n, baseColor, baseSize: coreSize,
    coreMat, haloMat, atmosMat, core, halo, atmos,
    isMulti,
    contribCount: uniqueColors.length,
    phase: Math.random() * Math.PI * 2,
    breathOmega,
  };
  group.onBeforeRender = () => updateNodeRender(group);

  n.__obj = group;
  return group;
}

function updateNodeRender(group) {
  const ud = group.userData;
  const t = (performance.now() - srwk.startTime) / 1000;
  // Per-node ω from period (3-7s); halos breathe slower for organic feel.
  const w = ud.breathOmega || 1.0;
  const breath = 0.84 + 0.16 * Math.sin(t * w + ud.phase);
  const haloBreath = 0.80 + 0.20 * Math.sin(t * w * 0.6 + ud.phase * 0.7);
  const atmosBreath = 0.74 + 0.26 * Math.sin(t * w * 0.35 + ud.phase * 1.3);
  const dims = ud.n._dims || {};
  const glow = (dims.glow || 0);
  // Aggressive density fade. With 30+ neighbors within 90 units, halo
  // drops to ~9% of its lonely value so densest pixels don't accumulate
  // to bloom-threshold-saturation.
  const density = (ud.n._density || 0);
  // Glow is now a faint accent, not the dominant visual. Cores carry
  // the structure; halos just add a touch of warmth at low density and
  // disappear entirely at high density.
  const densityFade = 1.0 / (1.0 + 1.2 * density);
  const haloKill    = density > 6 ? 0 : 1;
  const atmosKill   = density > 3 ? 0 : 1;
  const coreDensityFade = 1.0 / (1.0 + 0.18 * density);
  let coreI  = Math.min(0.80, 0.45 + glow * 0.30) * coreDensityFade;
  let haloI  = Math.min(0.12, 0.06 + glow * 0.06) * densityFade * haloKill;
  let atmosI = Math.min(0.025, 0.012 + glow * 0.012) * densityFade * densityFade * atmosKill;

  // Activity pulse: nodes that arrived in the last 60s get a subtle
  // halo intensity boost decaying with τ=30s, so they read as "freshly
  // ingested" without shouting. Stops contributing entirely past 60s.
  const ingestedAt = ud.n._recentlyIngestedAt;
  if (ingestedAt) {
    const ageMs = Date.now() - ingestedAt;
    if (ageMs < 60000) {
      const boost = 1 + 0.4 * Math.exp(-ageMs / 30000);
      haloI  *= boost;
      atmosI *= boost;
    }
  }

  // Search treatment: sprite-level opacity. We never rebuild the graph,
  // so the sim and breathing keep running undisturbed.
  const search = srwk.search;
  let coreScaleMul = 1.0;
  let haloScaleMul = 1.0;
  let atmosScaleMul = 1.0;
  let coreOpacity = 1.0, haloOpacity = 1.0, atmosOpacity = 1.0;
  if (search && search.active) {
    const matches = search.matchSet;
    const isMatch = matches && matches.has(ud.n.id);
    if (!isMatch) {
      coreOpacity = 0.15;
      haloOpacity = 0;
      atmosOpacity = 0;
    } else {
      // Match boost: scale halo up so the white outline halo reads as a
      // ring around the core. We apply via the existing halo sprite,
      // not a new layer, to keep memory flat.
      haloScaleMul = 1.55;
      haloI = Math.max(haloI, 0.32);
    }
  }

  // Peer-territory pulse: triggered by clicks in the peers panel. Lerps
  // a 1.5× halo scale boost in/out over ~2s using the existing breath
  // machinery so it doesn't fight per-node breathing.
  const pulse = srwk.peerPulse;
  if (pulse && pulse.contributor && ud.n.primary_contributor === pulse.contributor) {
    const elapsed = (performance.now() - pulse.start) / pulse.duration;
    if (elapsed < 1) {
      // 0..0.25 ramp up, 0.25..0.6 hold, 0.6..1 lerp out
      let amt;
      if (elapsed < 0.25) amt = elapsed / 0.25;
      else if (elapsed < 0.6) amt = 1;
      else amt = Math.max(0, 1 - (elapsed - 0.6) / 0.4);
      haloScaleMul *= 1 + 0.5 * amt;
      atmosScaleMul *= 1 + 0.5 * amt;
      haloI = Math.max(haloI, 0.20 * amt);
    }
  }

  ud.core.scale.set(ud.baseSize * breath * coreScaleMul, ud.baseSize * breath * coreScaleMul, 1);
  ud.halo.scale.set(ud.baseSize * 1.8 * haloBreath * haloScaleMul, ud.baseSize * 1.8 * haloBreath * haloScaleMul, 1);
  ud.atmos.scale.set(ud.baseSize * 1.4 * atmosBreath * atmosScaleMul, ud.baseSize * 1.4 * atmosBreath * atmosScaleMul, 1);

  ud.coreMat.opacity = coreOpacity;
  ud.haloMat.opacity = haloOpacity;
  ud.atmosMat.opacity = atmosOpacity;

  if (ud.isMulti) {
    const v = Math.min(1.0, 0.55 + 0.18 * coreI);
    ud.coreMat.color.setRGB(v, v, v);
  } else {
    ud.coreMat.color.setRGB(ud.baseColor.r * coreI, ud.baseColor.g * coreI, ud.baseColor.b * coreI);
  }
  ud.haloMat.color.setRGB(ud.baseColor.r * haloI, ud.baseColor.g * haloI, ud.baseColor.b * haloI);
  ud.atmosMat.color.setRGB(ud.baseColor.r * atmosI, ud.baseColor.g * atmosI, ud.baseColor.b * atmosI);
}

// Density map: per-node count of neighbors within DENSITY_RADIUS.
// Recomputed each engine tick, used by updateNodeRender to fade halos
// in dense regions so they don't sum to white.
const DENSITY_RADIUS = 90;
const DENSITY_RADIUS_SQ = DENSITY_RADIUS * DENSITY_RADIUS;
function updateLocalDensity() {
  const ns = srwk.nodes;
  for (const n of ns) n._density = 0;
  // O(n²) is fine for ~500 nodes (< 250k pairs/tick).
  for (let i = 0; i < ns.length; i++) {
    const a = ns[i];
    if (a.x == null) continue;
    for (let j = i + 1; j < ns.length; j++) {
      const b = ns[j];
      if (b.x == null) continue;
      const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
      const d2 = dx*dx + dy*dy + dz*dz;
      if (d2 < DENSITY_RADIUS_SQ) {
        a._density++; b._density++;
      }
    }
  }
}

function updateGroupCentroids() {
  const counts = new Map();
  const sums = new Map();
  for (const n of srwk.nodes) {
    if (n.x == null) continue;
    const k = srwk.lens.groupBy(n);
    if (!sums.has(k)) { sums.set(k, { x: 0, y: 0, z: 0 }); counts.set(k, 0); }
    const s = sums.get(k);
    s.x += n.x; s.y += n.y; s.z += n.z;
    counts.set(k, counts.get(k) + 1);
  }
  srwk.groupCentroids.clear();
  for (const [k, s] of sums) {
    const c = counts.get(k);
    srwk.groupCentroids.set(k, { x: s.x / c, y: s.y / c, z: s.z / c });
  }
}

// ─── lens / shape switching ───────────────────────────────────────────────

async function switchLens(newLens) {
  if (!newLens || newLens === srwk.lens) return;
  srwk.lens = newLens;
  setStatus("re-grouping…");
  try {
    // re-fetch so server-side recomputes any per-lens fields and we get
    // any pages that arrived since the last snapshot
    const r = await fetch(`${srwk.serverUrl}/graph?lens=${newLens.id}`);
    if (r.ok) {
      const fresh = await r.json();
      mergeFreshGraph(fresh);
    }
  } catch (e) {
    console.warn("[lens] graph refetch failed:", e);
  }
  applyAllDimensions(srwk.nodes, srwk.lens);
  for (const n of srwk.nodes) {
    if (!n.__obj) continue;
    const d = n._dims;
    const ud = n.__obj.userData;
    if (d.color)  ud.baseColor = new THREE.Color(d.color);
    if (d.accent) ud.accent    = new THREE.Color(d.accent);
    if (d.size)   ud.baseSize  = d.size;
  }
  applyForcesForLens(srwk.G, srwk.lens);
  // unpin anything pinned by a previous shape transition
  for (const n of srwk.nodes) { n.fx = n.fy = n.fz = undefined; }
  if (srwk.G && typeof srwk.G.d3ReheatSimulation === "function") srwk.G.d3ReheatSimulation();
  setStatus("");
}

function mergeFreshGraph(fresh) {
  for (const p of fresh.peers || []) srwk.peers.set(p.pubkey, p);
  for (const n of fresh.nodes) {
    if (srwk.nodeMap.has(n.id)) continue;
    srwk.nodeMap.set(n.id, n);
    srwk.nodes.push(n);
  }
  srwk.edges = fresh.edges;
  srwk.clusters = fresh.clusters || [];
  if (srwk.G) {
    srwk.G.graphData({ nodes: srwk.nodes, links: srwk.edges });
  }
  tick("node-count", srwk.nodes.length);
  tick("edge-count", srwk.edges.length);
  document.getElementById("mark-count").textContent =
    `${srwk.nodes.length}n · ${srwk.edges.length}e`;
  tick("peer-count", srwk.peers.size);
  pushConnPeers();
  if (typeof renderPeersPanel === "function") renderPeersPanel();
  // The cartography tab bakes its own buffer geometry from srwk.nodes/edges;
  // give it a debounced poke so it reconciles without rebuilding every tick.
  try { Graph2.notifyDataChanged(); } catch {}
  try { Cosmos.notifyDataChanged(); } catch {}
  try { Atlas.notifyDataChanged(); } catch {}
}

function switchShape(newShape) {
  if (!newShape || newShape === srwk.shape) return;
  const oldId = srwk.shape.id;
  srwk.shape = newShape;
  if (newShape.id === "cluster") {
    // resume sim from current positions
    srwk.shapeTransition = null;
    if (typeof srwk.G.d3ReheatSimulation === "function") srwk.G.d3ReheatSimulation();
    return;
  }
  // pause sim by raising velocity decay temporarily (or just set alpha to 0)
  // and lerp positions to target layout
  const target = newShape.layout(srwk.nodes, srwk.lens, srwk.bounds);
  if (!target) return;
  const source = new Map();
  for (const n of srwk.nodes) source.set(n.id, { x: n.x || 0, y: n.y || 0, z: n.z || 0 });
  srwk.shapeTransition = { start: performance.now(), duration: 1800, source, target };
}

function advanceShapeTransition(dt) {
  if (!srwk.shapeTransition) return;
  const { start, duration, source, target } = srwk.shapeTransition;
  const t = (performance.now() - start) / duration;
  const e = easeOutQuart(Math.min(1, t));
  for (const n of srwk.nodes) {
    const a = source.get(n.id), b = target.get(n.id);
    if (!a || !b) continue;
    n.x = a.x + (b.x - a.x) * e;
    n.y = a.y + (b.y - a.y) * e;
    n.z = a.z + (b.z - a.z) * e;
    if (n.__obj) n.__obj.position.set(n.x, n.y, n.z);
    // pin in sim
    n.fx = n.x; n.fy = n.y; n.fz = n.z;
  }
  if (t >= 1) {
    // freeze positions; sim is paused for non-cluster shapes
    srwk.shapeTransition = null;
  }
}

// ─── camera drift ─────────────────────────────────────────────────────────

function ambientCameraDrift(dt) {
  if (performance.now() - srwk.lastUserT < 2200) return;
  const ctrls = srwk.G?.controls();
  if (!ctrls?.target) return;
  const t = (performance.now() - srwk.startTime) / 1000;
  // 4× amplitude vs the original — the camera should noticeably drift
  // around the volume, not just shimmy. Period unchanged so the motion
  // stays slow and meditative.
  const A = 24, B = 16, C = 20;
  // Bias the drift toward whichever territory had the most recent
  // contribution, so the camera eddies near "where the action is."
  const bias = srwk.recentTerritory || { x: 0, y: 0, z: 0 };
  const bx = bias.x * 0.15, by = bias.y * 0.15, bz = bias.z * 0.15;
  const tx = srwk.driftBase.x + bx + A * Math.sin(t * 0.07);
  const ty = srwk.driftBase.y + by + B * Math.sin(t * 0.05 + 1.1);
  const tz = srwk.driftBase.z + bz + C * Math.sin(t * 0.03 + 2.3);
  const k = Math.min(1, dt * 0.5);
  ctrls.target.x += (tx - ctrls.target.x) * k;
  ctrls.target.y += (ty - ctrls.target.y) * k;
  ctrls.target.z += (tz - ctrls.target.z) * k;
  ctrls.update?.();
}

// ─── SSE event subscription ───────────────────────────────────────────────

function subscribeEvents() {
  // EventSource auto-reconnects on its own; we just feed it `since=` so the
  // server replays any events emitted while we were disconnected.
  if (srwk.eventSource) try { srwk.eventSource.close(); } catch {}
  const url = `${srwk.serverUrl}/events?since=${srwk.lastEventId}`;
  const es = new EventSource(url);
  srwk.eventSource = es;

  const trackId = (ev) => {
    const id = parseInt(ev.lastEventId || "0", 10);
    if (Number.isFinite(id) && id > srwk.lastEventId) srwk.lastEventId = id;
  };

  es.addEventListener("contribution_merged", (ev) => {
    trackId(ev);
    const data = JSON.parse(ev.data);
    const peer = srwk.peers.get(data.contributor) || {
      pubkey: data.contributor, nickname: data.nickname,
      signature_color: data.signature_color || stableHue(data.contributor),
      signature_freq: 440,
    };
    srwk.peers.set(peer.pubkey, peer);
    srwk.liveSeen.set(peer.pubkey, performance.now());
    refreshLiveCount();
    // bias camera drift toward whichever territory just got fresh activity
    const sample = (data.pages || []).map(p => srwk.nodeMap.get(p.url)).find(n => n && n._macroX != null);
    if (sample) srwk.recentTerritory = { x: sample._macroX, y: sample._macroY, z: sample._macroZ };
    handleContributionMerged(data, peer);
    const ev2 = { kind: "contribution_merged", payload: data, ts: Date.now() };
    appendEvent(ev2);
    pushTimelineTick(ev2);
    try { livegraphPushFromEvent(ev2); } catch (e) { console.warn("[livegraph]", e); }
  });
  es.addEventListener("contribution_arrived", trackId);
  es.addEventListener("contribution_rejected", trackId);
  es.addEventListener("page_visited", (ev) => {
    trackId(ev);
    try {
      const data = JSON.parse(ev.data);
      appendEvent({ kind: "page_visited", payload: data, ts: Date.now() });
    } catch { /* page_visited may have minimal/empty payload */ }
  });
  es.addEventListener("peer_trust_changed", trackId);
  es.addEventListener("peer_joined", (ev) => {
    trackId(ev);
    const data = JSON.parse(ev.data);
    srwk.liveSeen.set(data.contributor, performance.now());
    refreshLiveCount();
    // Seed the peer map so the peers panel can show this peer immediately,
    // even before the next /graph snapshot rolls them in.
    if (!srwk.peers.has(data.contributor)) {
      srwk.peers.set(data.contributor, {
        pubkey: data.contributor,
        nickname: data.nickname || `peer-${(data.contributor || "").slice(0, 8)}`,
        signature_color: data.signature_color || stableHue(data.contributor),
        page_count: 0,
      });
      tick("peer-count", srwk.peers.size);
      pushConnPeers();
      if (typeof renderPeersPanel === "function") renderPeersPanel();
    }
    // attribution toast for the new peer
    const el = document.getElementById("incoming-toast");
    if (!el) return;
    const color = stableHue(data.contributor);
    el.querySelector(".t-dot").style.background = color;
    el.querySelector(".t-dot").style.boxShadow = `0 0 12px 2px ${color}`;
    el.querySelector(".t-body").innerHTML =
      `<strong>${escHtml(data.nickname || "anon")}</strong> joined the hive`;
    el.hidden = false;
    el.classList.remove("fade");
    setTimeout(() => el.classList.add("fade"), 4200);
    setTimeout(() => { el.hidden = true; el.classList.remove("fade"); }, 6500);
    appendEvent({ kind: "peer_joined", payload: data, ts: Date.now() });
  });

  es.addEventListener("peer_left", (ev) => {
    trackId(ev);
    const data = JSON.parse(ev.data);
    srwk.liveSeen.delete(data.contributor);
    refreshLiveCount();
    if (typeof renderPeersPanel === "function") renderPeersPanel();
  });
  es.addEventListener("peer_back", (ev) => {
    trackId(ev);
    const data = JSON.parse(ev.data);
    srwk.liveSeen.set(data.contributor, performance.now());
    refreshLiveCount();
    if (typeof renderPeersPanel === "function") renderPeersPanel();
  });

  // ─── traffic events (slice + mdns + zeroconf) ──────────────────────────
  // Server-side agent emits these as separate SSE event names. Each
  // handler is defensive: payload shapes may shift before the SPEC
  // settles, so we never assume any one field exists.
  const TRAFFIC_KINDS = [
    "slice_scraped", "slice_scrape_error", "slice_skipped_self",
    "slice_replay_dropped", "slice_size_rejected",
    "mdns_discovered", "mdns_evicted", "zeroconf_revived",
    // SPEC v0.3 LAN_FRIEND_DCNET event family — see DC-NET CONTRACT comment
    // below for payload shapes. Server emits nothing today; UI is dormant
    // until the protocol ships.
    "dcnet_round_started", "dcnet_round_complete",
    "ticket_issued", "ticket_redeemed",
    "receipt_submitted", "anonymity_set_changed", "epoch_rotated",
    "web_search_completed",
  ];
  for (const kind of TRAFFIC_KINDS) {
    es.addEventListener(kind, (ev) => {
      trackId(ev);
      let data = {};
      try { data = JSON.parse(ev.data || "{}"); } catch {}
      const evt = { kind, payload: data, ts: Date.now() };
      // Track liveness for any peer-bound event so the live counter and
      // timeline lanes light up immediately. `data.peer` may be a struct
      // (slice_scraped) so we go through pickPeerPubkey, which always
      // returns a string.
      const pubkey = pickPeerPubkey(data);
      if (pubkey) {
        srwk.liveSeen.set(pubkey, performance.now());
      }
      // Dispatch DC-net family events into the dedicated panels in
      // addition to the unified traffic feed. Each handler is a no-op
      // until at least one event of the corresponding kind arrives.
      try {
        if (kind === "anonymity_set_changed") onAnonymitySetChanged(data);
        else if (kind === "dcnet_round_started") onDcnetRoundStarted(data);
        else if (kind === "dcnet_round_complete") onDcnetRoundComplete(data);
        else if (kind === "ticket_issued") onTicketIssued(data);
        else if (kind === "ticket_redeemed") onTicketRedeemed(data);
        else if (kind === "receipt_submitted") onReceiptSubmitted(data);
        else if (kind === "epoch_rotated") onEpochRotated(data);
        else if (kind === "web_search_completed") onWebSearchCompleted(data);
      } catch (e) { console.warn("[dcnet handler]", kind, e); }
      appendTrafficEvent(evt);
      pushTimelineTick(evt);
      // Live propagation graph — receives the same event stream and
      // animates a pulse along the appropriate peer↔self edge. Fully
      // self-contained module; no-op when the canvas is hidden.
      try { livegraphPushFromEvent(evt); } catch (e) { console.warn("[livegraph]", e); }
      // First traffic event after boot reveals the timeline so users
      // see the wire activity without hunting for the ◢ toggle.
      maybeAutoShowTimeline();
    });
  }

  es.onerror = () => {
    setStatus("event stream reconnecting…", true);
    setConnectionState({ state: "reconnecting", detail: "SSE error — retrying…" });
    setTimeout(() => {
      if (es.readyState === EventSource.CLOSED) subscribeEvents();
    }, 1500);
  };
  es.onopen = async () => {
    setStatus("");
    setConnectionState({ state: "connected", detail: "" });
    if (!srwk._connectedToastShown) {
      srwk._connectedToastShown = true;
    } else {
      toast({ kind: "success", title: "reconnected", message: "event stream is live again" });
    }
    // Self-heal: refetch the graph so any nodes we missed during the
    // disconnect (e.g. server restart) reappear. Cheap; only runs on (re)open.
    try {
      const r = await fetch(`${srwk.serverUrl}/graph?lens=${srwk.lens.id}`);
      if (r.ok) mergeFreshGraph(await r.json());
    } catch (e) { /* swallow; next event will trigger another try */ }
  };
  // Note any incoming SSE message as a connection liveness signal. Wrapped
  // in a generic listener so all event kinds bump the timestamp.
  es.addEventListener("message", () => noteConnectionEvent());
  for (const k of ["contribution_merged", "peer_joined", "peer_left", "peer_back", "page_visited"]) {
    es.addEventListener(k, () => noteConnectionEvent());
  }
}

// Build the connection-popover peers payload from srwk.peers and push it
// into setConnectionState. Called wherever the peer count changes — keeps
// the "PEERS" row in the conn popover in sync with reality.
//
// The payload is intentionally honest: when the only "peer" is the local
// swf-node (self), we say so explicitly ("1 (self only)") instead of
// implying a peer-network when there isn't one.
function pushConnPeers() {
  const peers = [...srwk.peers.values()].filter((p) => p && p.pubkey);
  const total = peers.length;
  const others = peers
    .filter((p) => p.pubkey !== srwk.selfPubkey)
    .map((p) => p.nickname || `peer-${(p.pubkey || "").slice(0, 6)}`);
  const selfOnly = total <= 1 && others.length === 0;
  setConnectionState({ peers: { total, selfOnly, others } });
}

// Periodic /health probe so the connection popover surfaces current RTT
// even when no SSE event has fired recently. Runs every 5s, super cheap.
function startConnectionProbe() {
  async function probe() {
    const t0 = performance.now();
    try {
      const r = await fetch(`${srwk.serverUrl}/health`, { cache: "no-store" });
      const rttMs = performance.now() - t0;
      if (r.ok) setConnectionState({ rttMs });
      else setConnectionState({ state: "down", detail: `HTTP ${r.status}` });
    } catch (e) {
      setConnectionState({ state: "down", detail: e?.message || "fetch failed" });
    }
  }
  probe();
  setInterval(probe, 5000);
}

// Threshold above which we skip the per-page materialize() animation
// (BufferGeometry + ShaderMaterial + RAF loop per page) and fall back
// to a bulk /graph refetch + merge. Cinematic juice is reserved for
// genuine drips ("alice contributed 3 papers"); a 930-page first
// scrape from a fresh peer goes through the efficient path. The
// server now caps contribution_merged at 64 pages/event so this
// fallback rarely fires under normal operation — it's a safety net
// for older servers, mis-chunked events, or future regressions.
const BIG_BURST_THRESHOLD = 64;

async function handleContributionMerged(data, peer) {
  const pages = data.pages || [];
  const newPages = pages.filter((p) => !srwk.nodeMap.has(p.url));
  if (newPages.length > BIG_BURST_THRESHOLD) {
    // Skip per-page animation. Refetch the snapshot and merge — the
    // graph picks up everything the server-side _apply just persisted,
    // including pages we couldn't have known about from this event
    // alone (e.g. backfilled hosts/topics).
    try {
      const r = await fetch(`${srwk.serverUrl}/graph?lens=${srwk.lens.id}`);
      if (r.ok) mergeFreshGraph(await r.json());
    } catch (e) { console.warn("[contribution_merged] bulk refetch failed:", e); }
    return;
  }
  for (const p of newPages) {
    const node = {
      id: p.url, title: p.title, host: p.host || "", topic: p.topic || "background",
      primary_contributor: peer.pubkey, contributors: [peer.pubkey],
      degree: 0, fetched_at: new Date().toISOString(), last_visited: null,
    };
    applyDimensions(node, srwk.lens);
    materialize({ scene: srwk.scene, srwk, page: node, peer, addPageToGraph });
  }
}

function addPageToGraph(node) {
  if (srwk.nodeMap.has(node.id)) return;
  srwk.nodeMap.set(node.id, node);
  srwk.nodes.push(node);
  // add to graph data
  const data = srwk.G.graphData();
  data.nodes.push(node);
  srwk.G.graphData(data);
  tick("node-count", srwk.nodes.length);
  document.getElementById("mark-count").textContent =
    `${srwk.nodes.length}n · ${srwk.edges.length}e`;
  // pulse the cartography view: pick an edge incident on this node and
  // ride a runner-head along it. Also schedules a debounced rebuild so the
  // new node enters the streamline mesh.
  try {
    Graph2.pulseNode(node.id);
    Graph2.notifyDataChanged();
  } catch {}
  try {
    Cosmos.pulseNode(node.id);
    Cosmos.notifyDataChanged();
  } catch {}
  try {
    Atlas.pulseNode(node.id);
    Atlas.notifyDataChanged();
  } catch {}
}

// ─── periodic /graph reconcile ────────────────────────────────────────────
// SSE event payloads can drift from /graph truth: a contribution_merged
// event might list pages that the server's view-builder later filters out
// (orphan pruning, lens-aware row sets, etc.), so a renderer that only adds
// nodes via SSE accumulates ghosts. Refetch /graph on a slow interval to
// reconcile. materialize() still drives the cinematic per-page animation;
// this just nudges in-memory state back toward server truth.
const RECONCILE_INTERVAL_MS = 30000;

function startGraphReconcile() {
  setInterval(reconcileGraph, RECONCILE_INTERVAL_MS);
  // Kick once early so we don't sit empty for a full interval after a
  // cold-start fetch failure or a swf-node restart.
  setTimeout(() => { reconcileGraph(); }, 1500);
  setTimeout(() => { reconcileGraph(); }, 5000);
}

async function reconcileGraph() {
  try {
    const r = await fetch(`${srwk.serverUrl}/graph?lens=${srwk.lens.id}`);
    if (!r.ok) return;
    const fresh = await r.json();
    // Drop ghosts: nodes in our local set that aren't in the server's
    // current view. Re-attribute mismatches: if the server now says a
    // page belongs to a different primary_contributor, update locally so
    // the panel and visuals match.
    const truthIds = new Set();
    const truthByUrl = new Map();
    for (const n of fresh.nodes) {
      truthIds.add(n.id);
      truthByUrl.set(n.id, n);
    }
    let removed = 0;
    for (let i = srwk.nodes.length - 1; i >= 0; i--) {
      const n = srwk.nodes[i];
      if (!truthIds.has(n.id)) {
        srwk.nodes.splice(i, 1);
        srwk.nodeMap.delete(n.id);
        removed++;
      } else {
        const t = truthByUrl.get(n.id);
        if (t.primary_contributor && n.primary_contributor !== t.primary_contributor) {
          n.primary_contributor = t.primary_contributor;
        }
        if (Array.isArray(t.contributors)) n.contributors = t.contributors;
      }
    }
    // Add any pages we missed.
    let added = 0;
    for (const n of fresh.nodes) {
      if (!srwk.nodeMap.has(n.id)) {
        srwk.nodeMap.set(n.id, n);
        srwk.nodes.push(n);
        added++;
      }
    }
    srwk.edges = fresh.edges;
    srwk.clusters = fresh.clusters || [];
    for (const p of fresh.peers || []) srwk.peers.set(p.pubkey, p);
    if (srwk.G) srwk.G.graphData({ nodes: srwk.nodes, links: srwk.edges });
    tick("node-count", srwk.nodes.length);
    tick("edge-count", srwk.edges.length);
    document.getElementById("mark-count").textContent =
      `${srwk.nodes.length}n · ${srwk.edges.length}e`;
    tick("peer-count", srwk.peers.size);
    pushConnPeers();
    if (typeof renderPeersPanel === "function") renderPeersPanel();
    if (added || removed) {
      console.log(`[reconcile] +${added} -${removed} → ${srwk.nodes.length}n`);
    }
    // Whenever reconcile changes the corpus, poke the atlas (and any
    // other live renderers) so they re-cluster against the new node set.
    // Without this, atlas could miss results the SSE stream didn't
    // already materialize via the per-page path — e.g. when boot's
    // initial loadGraph failed and recovery happens entirely here.
    if (added || removed) {
      try { Atlas.notifyDataChanged(); } catch {}
      try { Graph2.notifyDataChanged(); } catch {}
      try { Cosmos.notifyDataChanged(); } catch {}
      // Recovered from cold-start failure: clear the "offline" status.
      if (srwk.nodes.length > 0) {
        setStatus("");
        setConnectionState({ state: "connected", serverUrl: srwk.serverUrl });
        hideAtlasOffline();
      }
    }
  } catch (e) {
    /* swallow; next tick will retry */
  }
}

// ─── atlas offline panel ─────────────────────────────────────────────
// Visible when swf-node is unreachable. Provides a "command to give
// agent" button that copies a self-explanatory debug prompt — paste
// into Claude / ChatGPT / Cursor and they get full context.
function wireAtlasOfflinePanel() {
  const panel = document.getElementById("atlas-offline");
  if (!panel) return;
  const urlEl  = document.getElementById("ao-server-url");
  const copyBtn = document.getElementById("ao-copy-prompt");
  const retryBtn = document.getElementById("ao-retry");
  if (urlEl) urlEl.textContent = srwk.serverUrl;
  if (copyBtn) {
    copyBtn.addEventListener("click", async () => {
      const prompt = buildOfflineAgentPrompt();
      let ok = false;
      try { await navigator.clipboard.writeText(prompt); ok = true; } catch {}
      if (!ok) {
        try {
          const ta = document.createElement("textarea");
          ta.value = prompt; ta.style.position = "fixed"; ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          document.body.removeChild(ta);
          ok = true;
        } catch {}
      }
      if (ok) {
        const prev = copyBtn.querySelector(".ao-btn-label").textContent;
        copyBtn.dataset.state = "copied";
        copyBtn.querySelector(".ao-btn-label").textContent = "copied — paste to your agent";
        setTimeout(() => {
          delete copyBtn.dataset.state;
          copyBtn.querySelector(".ao-btn-label").textContent = prev;
        }, 1800);
      }
    });
  }
  if (retryBtn) {
    retryBtn.addEventListener("click", async () => {
      const prev = retryBtn.querySelector(".ao-btn-label").textContent;
      retryBtn.querySelector(".ao-btn-label").textContent = "retrying…";
      retryBtn.disabled = true;
      try { await reconcileGraph(); } catch {}
      retryBtn.disabled = false;
      retryBtn.querySelector(".ao-btn-label").textContent = prev;
    });
  }
}
function showAtlasOffline() {
  const panel = document.getElementById("atlas-offline");
  if (panel) panel.hidden = false;
  // Update the URL in case it differs from the default.
  const urlEl = document.getElementById("ao-server-url");
  if (urlEl) urlEl.textContent = srwk.serverUrl;
}
function hideAtlasOffline() {
  const panel = document.getElementById("atlas-offline");
  if (panel) panel.hidden = true;
}
function buildOfflineAgentPrompt() {
  const url = srwk.serverUrl;
  return [
    `Hey — I got this message from inside the Shape Rotator OS field-guide:`,
    ``,
    `> The swf-node daemon isn't reachable at ${url}. The field-guide is read-only —`,
    `> all my indexed pages live in swf-node's local SQLite. Without the daemon`,
    `> running, the atlas / network / metrics tabs can't show anything.`,
    ``,
    `Architecture: swf-node is a LAN-first peer search daemon (the searxng-wth-frnds`,
    `repo). The Electron app I'm using is just a viewer that polls swf-node's HTTP`,
    `endpoints (/graph, /events, /web_search). When swf-node is down, the viewer has`,
    `nothing to render.`,
    ``,
    `Help me get swf-node running. Likely path:`,
    `1. Check if it's installed:    \`which swf-node\`  or  \`pipx list | grep swf\``,
    `2. If installed, start it:      \`swf-node\`        (defaults to ${url})`,
    `3. If not installed, install it from the searxng-wth-frnds repo`,
    `   (check the repo's README for the exact install command — pipx, pip, or source).`,
    `4. Verify it's up:              \`curl -s ${url}/graph?lens=contributor | head\``,
    ``,
    `Spec for context: docs/SHAPE-ROTATOR-OS-SPEC.md in shape-rotator-wrld-knwldge-viz.`,
    `Once the daemon responds, the field-guide auto-recovers within ~5s — no reload`,
    `needed.`,
  ].join("\n");
}

// ─── peers panel ──────────────────────────────────────────────────────────
// Click the peer count → reveal a panel listing each peer: signature
// dot, nickname, truncated pubkey + copy button, page count, last-seen.
// `srwk.peers` is already populated from /graph and kept fresh by the
// SSE peer_joined / peer_back / peer_left handlers; the panel just
// re-renders on toggle and on those same events.

function wirePeersPanel() {
  const btn = document.getElementById("peer-count-btn");
  const panel = document.getElementById("peers-panel");
  const close = document.getElementById("peers-panel-close");
  if (!btn || !panel || !close) return;
  const open = () => {
    btn.setAttribute("aria-expanded", "true");
    panel.hidden = false;
    renderPeersPanel();
  };
  const hide = () => {
    btn.setAttribute("aria-expanded", "false");
    panel.hidden = true;
  };
  btn.addEventListener("click", () => panel.hidden ? open() : hide());
  close.addEventListener("click", hide);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !panel.hidden) hide();
  });
  // Fetch our own pubkey once so we can mark "you" in the list. The
  // .well-known endpoint is unauthenticated and lives on the same origin.
  fetch(`${srwk.serverUrl}/.well-known/indrex`)
    .then((r) => r.ok ? r.json() : null)
    .then((d) => {
      if (d?.pubkey) srwk.selfPubkey = d.pubkey;
      renderPeersPanel();
      // Live graph layout depends on selfPubkey; refresh it now so the
      // self node is correctly excluded from the perimeter once known.
      if (typeof recomputeLayout === "function") {
        try { recomputeLayout(); } catch {}
      }
    })
    .catch(() => {});
  // Refresh every 10s so live/stale tags stay accurate even when the
  // panel is open and idle.
  setInterval(() => { if (!panel.hidden) renderPeersPanel(); }, 10000);
}

function renderPeersPanel() {
  // Render the network-tab peers list whenever the popup peers list
  // refreshes — same data, two surfaces.
  if (typeof renderNetPeersList === "function") renderNetPeersList();
  // Issue #43 PR D: source-filter chip bar shares the peers map.
  // Rebuild chips on every peers refresh so newly-discovered peers
  // pick up a chip without a page reload.
  if (typeof renderSourceFilterChips === "function") {
    try { renderSourceFilterChips(); } catch {}
  }
  // The live propagation graph is also keyed off the peers map; recompute
  // its layout so newly-discovered peers slot into the perimeter. Cheap.
  if (typeof recomputeLayout === "function") {
    try { recomputeLayout(); } catch {}
  }
  const list = document.getElementById("peers-panel-list");
  if (!list) return;
  list.innerHTML = "";
  const peers = [...srwk.peers.values()];
  if (peers.length === 0) {
    const empty = document.createElement("div");
    empty.className = "peers-empty";
    empty.textContent = "no peers yet — the network is quiet.";
    list.appendChild(empty);
    return;
  }
  // Derive page count from the live node set so it tracks materialize()
  // additions, not just the last /graph snapshot's stale value.
  const liveCounts = new Map();
  for (const n of srwk.nodes) {
    const pk = n.primary_contributor;
    if (!pk) continue;
    liveCounts.set(pk, (liveCounts.get(pk) || 0) + 1);
  }
  // Sort: self first, then by live page count desc, then by nickname.
  peers.sort((a, b) => {
    const aSelf = a.pubkey === srwk.selfPubkey ? 1 : 0;
    const bSelf = b.pubkey === srwk.selfPubkey ? 1 : 0;
    if (aSelf !== bSelf) return bSelf - aSelf;
    const ap = liveCounts.get(a.pubkey) ?? a.page_count ?? 0;
    const bp = liveCounts.get(b.pubkey) ?? b.page_count ?? 0;
    if (ap !== bp) return bp - ap;
    return (a.nickname || "").localeCompare(b.nickname || "");
  });
  const now = performance.now();
  for (const p of peers) {
    list.appendChild(buildPeerRow(p, now, liveCounts));
  }
}

function buildPeerRow(p, now, liveCounts) {
  const row = document.createElement("div");
  row.className = "peer-row";
  row.dataset.pubkey = p.pubkey || "";
  row.tabIndex = 0;
  row.addEventListener("click", (e) => {
    // Don't fly when the user clicked the copy button — that's a
    // utility action, not a navigation intent.
    if (e.target.closest(".p-copy")) return;
    selectPeerRow(row, p);
  });
  row.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      selectPeerRow(row, p);
    }
  });
  const color = p.signature_color || stableHue(p.pubkey);
  const dot = document.createElement("span");
  dot.className = "p-dot";
  dot.style.background = color;
  dot.style.boxShadow = `0 0 10px 1px ${color}`;
  const mid = document.createElement("div");
  mid.className = "p-mid";
  const nick = document.createElement("span");
  nick.className = "p-nick";
  if (p.pubkey === srwk.selfPubkey) nick.classList.add("is-self");
  nick.textContent = p.nickname || `peer-${(p.pubkey || "").slice(0, 8)}`;
  const pkRow = document.createElement("span");
  pkRow.className = "p-pubkey";
  const pkText = document.createElement("span");
  const pk = p.pubkey || "";
  pkText.textContent = pk ? `${pk.slice(0, 12)}…${pk.slice(-6)}` : "—";
  pkText.title = pk;
  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "p-copy";
  copyBtn.textContent = "copy";
  copyBtn.title = "copy full pubkey";
  copyBtn.addEventListener("click", () => {
    if (!pk) return;
    navigator.clipboard?.writeText(pk).then(() => {
      copyBtn.textContent = "copied";
      copyBtn.classList.add("copied");
      setTimeout(() => {
        copyBtn.textContent = "copy";
        copyBtn.classList.remove("copied");
      }, 1400);
    }).catch(() => {});
  });
  pkRow.append(pkText, copyBtn);
  mid.append(nick, pkRow);
  const meta = document.createElement("div");
  meta.className = "p-meta";
  const pages = document.createElement("span");
  pages.className = "p-pages";
  const livePc = liveCounts ? liveCounts.get(p.pubkey) : undefined;
  pages.textContent = `${(livePc ?? p.page_count ?? 0)}p`;
  const liveTs = srwk.liveSeen.get(p.pubkey);
  const live = document.createElement("span");
  if (liveTs && now - liveTs < LIVE_WINDOW_MS) {
    live.className = "p-live";
    live.textContent = "live";
  } else {
    live.className = "p-stale";
    live.textContent = "idle";
  }
  meta.append(pages, live);
  row.append(dot, mid, meta);
  return row;
}

// ─── events panel ─────────────────────────────────────────────────────────
// Realtime activity log on the left sidebar. Subscribes to the same SSE
// stream as the rest of the UI; the SSE handlers above call appendEvent()
// for kinds we render. Design constraints:
//   • cap at MAX_ROWS rendered DOM rows (older rows are evicted)
//   • batch DOM writes via rAF when events come faster than ~30/sec
//   • collapsed-by-default, persisted in localStorage
//   • header "events · N" counter pulses briefly when new events arrive
//   • peer signature_color sourced from srwk.peers, with a stableHue
//     fallback so we render before the peer is fully known.

const EVENTS_LS_KEY = "srwk:events:collapsed";
const EVENTS_MAX_ROWS = 50;
const EVENTS_AGED_AFTER = 15;       // rows past this index get the "aged" tint
const eventsState = {
  pending: [],                      // queued events awaiting the next rAF flush
  flushScheduled: false,
  total: 0,                         // monotonic count for the header
  pulseTimer: null,
  collapsed: true,
};

function wireEventsPanel() {
  const panel = document.getElementById("events-panel");
  const head = document.getElementById("events-panel-head");
  const list = document.getElementById("events-panel-list");
  if (!panel || !head || !list) return;
  let collapsed = true;
  try {
    const v = localStorage.getItem(EVENTS_LS_KEY);
    if (v === "false") collapsed = false;
  } catch { /* localStorage may be unavailable */ }
  const apply = () => {
    eventsState.collapsed = collapsed;
    panel.dataset.collapsed = collapsed ? "true" : "false";
    head.setAttribute("aria-expanded", collapsed ? "false" : "true");
  };
  apply();
  if (!list.firstChild) {
    const empty = document.createElement("div");
    empty.className = "events-empty";
    empty.id = "events-empty";
    empty.textContent = "nothing on the wire.";
    list.appendChild(empty);
  }
  head.addEventListener("click", () => {
    collapsed = !collapsed;
    try { localStorage.setItem(EVENTS_LS_KEY, collapsed ? "true" : "false"); } catch {}
    apply();
  });
}

function appendEvent(evt) {
  eventsState.pending.push(evt);
  // Hard ceiling on the queue itself in case we get a flood the rAF can't drain.
  if (eventsState.pending.length > EVENTS_MAX_ROWS * 4) {
    eventsState.pending.splice(0, eventsState.pending.length - EVENTS_MAX_ROWS * 4);
  }
  if (!eventsState.flushScheduled) {
    eventsState.flushScheduled = true;
    requestAnimationFrame(flushEvents);
  }
}

function flushEvents() {
  eventsState.flushScheduled = false;
  const batch = eventsState.pending;
  eventsState.pending = [];
  if (!batch.length) return;
  const list = document.getElementById("events-panel-list");
  if (!list) return;
  const empty = document.getElementById("events-empty");
  if (empty) empty.remove();
  // Insert newest-first. We preserve incoming order within the batch by
  // walking it forward but each row prepends — net effect: newest at top.
  for (const evt of batch) {
    const row = buildEventRow(evt);
    if (!row) continue;
    list.insertBefore(row, list.firstChild);
    // Trigger the enter transition on the next frame.
    requestAnimationFrame(() => row.classList.remove("enter"));
  }
  // Trim to MAX_ROWS, evicting from the bottom.
  while (list.childElementCount > EVENTS_MAX_ROWS) {
    list.removeChild(list.lastElementChild);
  }
  // Re-tag aged rows. Cheap: walks at most MAX_ROWS nodes.
  const rows = list.children;
  for (let i = 0; i < rows.length; i++) {
    rows[i].classList.toggle("aged", i >= EVENTS_AGED_AFTER);
  }
  // Header counter + pulse.
  eventsState.total += batch.length;
  const counter = document.getElementById("events-panel-count");
  if (counter) {
    counter.textContent = String(eventsState.total);
    counter.classList.add("pulse");
    if (eventsState.pulseTimer) clearTimeout(eventsState.pulseTimer);
    eventsState.pulseTimer = setTimeout(() => counter.classList.remove("pulse"), 480);
  }
}

function buildEventRow(evt) {
  const row = document.createElement("div");
  row.className = `events-row enter kind-${evt.kind}`;
  const dot = document.createElement("span");
  dot.className = "e-dot";
  const body = document.createElement("span");
  body.className = "e-body";
  const ts = formatEventTs(evt.ts);
  const p = evt.payload || {};
  const pubkey = p.contributor || "";
  const peer = srwk.peers.get(pubkey);
  const color = peer?.signature_color || (pubkey ? stableHue(pubkey) : "rgba(220,232,255,0.42)");
  dot.style.background = color;
  dot.style.boxShadow = `0 0 6px ${color}`;
  const nick = peer?.nickname || p.nickname || (pubkey ? `peer-${pubkey.slice(0, 6)}` : "—");

  if (evt.kind === "contribution_merged") {
    const pages = Array.isArray(p.pages) ? p.pages : [];
    const pc = p.page_count ?? pages.length;
    const sr = p.result_count ?? 0;
    const titles = pages
      .map((pg) => pg && (pg.title || pg.host || pg.url))
      .filter(Boolean)
      .slice(0, 3)
      .map((t) => String(t).length > 32 ? String(t).slice(0, 32) + "…" : String(t));
    const tail = titles.length ? `  ·  ${titles.join(", ")}` : "";
    body.innerHTML =
      `<span class="e-ts">${escHtml(ts)}</span>` +
      `<span class="e-actor">${escHtml(nick)}</span> → ` +
      `<span class="e-meta">+${pc}p +${sr}sr</span>` +
      `<span class="e-tail">${escHtml(tail)}</span>`;
  } else if (evt.kind === "peer_joined") {
    const trust = p.trust_level || "untrusted";
    body.innerHTML =
      `<span class="e-ts">${escHtml(ts)}</span>` +
      `<span class="e-actor">${escHtml(nick)}</span> joined  ·  ` +
      `<span class="e-meta">trust=${escHtml(trust)}</span>`;
  } else if (evt.kind === "page_visited") {
    const target = p.url || p.host || "";
    const short = String(target).replace(/^https?:\/\//, "").slice(0, 48);
    body.innerHTML =
      `<span class="e-ts">${escHtml(ts)}</span>` +
      `<span class="e-actor">${escHtml(nick)}</span> clicked  ` +
      `<span class="e-tail">${escHtml(short || "—")}</span>`;
  } else {
    return null;
  }
  row.append(dot, body);
  row.dataset.eventKind = evt.kind;
  row.tabIndex = 0;
  row.addEventListener("click", () => selectEventRow(row, evt));
  row.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      selectEventRow(row, evt);
    }
  });
  return row;
}

function selectEventRow(row, evt) {
  const list = document.getElementById("events-panel-list");
  // Click-the-selected-row-again toggles off.
  if (row.classList.contains("selected")) {
    row.classList.remove("selected");
    clearDetail();
    return;
  }
  if (list) {
    for (const sib of list.querySelectorAll(".events-row.selected")) {
      sib.classList.remove("selected");
    }
  }
  row.classList.add("selected");
  renderEventDetail(evt);
}

function clearDetail() {
  const el = document.getElementById("detail");
  if (!el) return;
  el.innerHTML = "";
  const list = document.getElementById("events-panel-list");
  if (list) {
    for (const sib of list.querySelectorAll(".events-row.selected")) {
      sib.classList.remove("selected");
    }
  }
}

// Esc closes whatever's in the detail pane.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    const el = document.getElementById("detail");
    if (el && el.innerHTML.trim()) clearDetail();
  }
});

function _wireCloseButton(el) {
  el.querySelector(".ed-close")?.addEventListener("click", () => clearDetail());
}

function renderEventDetail(evt) {
  const el = document.getElementById("detail");
  if (!el) return;
  const p = evt.payload || {};
  const pubkey = p.contributor || "";
  const peer = srwk.peers.get(pubkey);
  const color = peer?.signature_color || (pubkey ? stableHue(pubkey) : "#7D8AAB");
  const nick = peer?.nickname || p.nickname || (pubkey ? `peer-${pubkey.slice(0, 8)}` : "—");
  const ts = new Date(evt.ts).toLocaleString();
  const pkShort = pubkey ? `${pubkey.slice(0, 14)}…${pubkey.slice(-6)}` : "—";

  if (evt.kind === "contribution_merged") {
    const pages = Array.isArray(p.pages) ? p.pages : [];
    const pc = p.page_count ?? pages.length;
    const sr = p.result_count ?? 0;
    const pageRows = pages.length
      ? pages.map((pg) => {
          const url = pg?.url || "";
          const title = (pg?.title || url).slice(0, 120);
          const host = pg?.host || "";
          return `<li class="ed-page">
            <a href="#" class="ed-page-link" data-url="${escHtml(url)}" title="${escHtml(url)}">${escHtml(title)}</a>
            <span class="ed-page-host">${escHtml(host)}</span>
          </li>`;
        }).join("")
      : '<li class="ed-empty">no pages — search-results-only slice</li>';
    el.innerHTML = `
      <button class="ed-close" type="button" aria-label="close" title="close (Esc)">✕</button>
      <div class="d-title">${escHtml(nick)} merged a slice</div>
      <div class="d-host">${escHtml(ts)}</div>
      <div class="d-grid">
        <span class="k">peer</span>
        <span class="v"><span class="d-dot" style="background:${color};box-shadow:0 0 8px ${color}"></span>${escHtml(nick)}</span>
        <span class="k">pubkey</span><span class="v" title="${escHtml(pubkey)}"><code style="font-size:10px">${escHtml(pkShort)}</code></span>
        <span class="k">pages</span><span class="v">+${pc}</span>
        <span class="k">results</span><span class="v">+${sr}</span>
      </div>
      <div class="ed-section-title">pages in slice</div>
      <ul class="ed-page-list">${pageRows}</ul>
    `;
    el.querySelectorAll(".ed-page-link").forEach((a) => {
      a.addEventListener("click", (e) => {
        e.preventDefault();
        const url = a.dataset.url;
        if (!url) return;
        if (window.api?.openExternal) window.api.openExternal(url);
        else window.open(url, "_blank");
      });
    });
    _wireCloseButton(el);
  } else if (evt.kind === "peer_joined") {
    const trust = p.trust_level || "untrusted";
    const freq = peer?.signature_freq;
    el.innerHTML = `
      <button class="ed-close" type="button" aria-label="close" title="close (Esc)">✕</button>
      <div class="d-title">${escHtml(nick)} joined</div>
      <div class="d-host">${escHtml(ts)}</div>
      <div class="d-grid">
        <span class="k">peer</span>
        <span class="v"><span class="d-dot" style="background:${color};box-shadow:0 0 8px ${color}"></span>${escHtml(nick)}</span>
        <span class="k">pubkey</span><span class="v" title="${escHtml(pubkey)}"><code style="font-size:10px">${escHtml(pkShort)}</code></span>
        <span class="k">trust</span><span class="v">${escHtml(trust)}</span>
        <span class="k">color</span><span class="v"><code style="color:${color}">${escHtml(color)}</code></span>
        ${freq ? `<span class="k">tone</span><span class="v">${freq.toFixed(1)} Hz</span>` : ""}
      </div>
    `;
    _wireCloseButton(el);
  } else if (evt.kind === "page_visited") {
    const url = p.url || "";
    const host = p.host || (() => { try { return new URL(url).host; } catch { return ""; } })();
    el.innerHTML = `
      <button class="ed-close" type="button" aria-label="close" title="close (Esc)">✕</button>
      <div class="d-title">${escHtml(nick)} clicked</div>
      <div class="d-host">${escHtml(host)}</div>
      <div class="d-actions">
        <button class="d-btn primary" data-act="open">open ↗</button>
        <button class="d-btn" data-act="copy-url">copy url</button>
      </div>
      <div class="d-grid">
        <span class="k">when</span><span class="v">${escHtml(ts)}</span>
        <span class="k">url</span><span class="v" style="word-break:break-all">${escHtml(url)}</span>
      </div>
    `;
    el.querySelector('[data-act="open"]')?.addEventListener("click", () => {
      if (window.api?.openExternal) window.api.openExternal(url);
      else window.open(url, "_blank");
    });
    el.querySelector('[data-act="copy-url"]')?.addEventListener("click", () => {
      navigator.clipboard?.writeText(url).catch(() => {});
    });
    _wireCloseButton(el);
  }
}

function formatEventTs(ms) {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

// "10s ago", "2m ago", "yesterday" — terse, lowercase, are.na-flavored.
function formatPeerLastSeen(secsAgo) {
  if (!isFinite(secsAgo) || secsAgo < 0) return "—";
  if (secsAgo < 5) return "just now";
  if (secsAgo < 60) return `${Math.round(secsAgo)}s ago`;
  if (secsAgo < 3600) return `${Math.round(secsAgo / 60)}m ago`;
  if (secsAgo < 86400) return `${Math.round(secsAgo / 3600)}h ago`;
  if (secsAgo < 86400 * 2) return "yesterday";
  return `${Math.round(secsAgo / 86400)}d ago`;
}

// ─── interaction ──────────────────────────────────────────────────────────

function onNodeClick(n) {
  n.last_visited = new Date().toISOString();
  applyDimensions(n, srwk.lens);
  renderDetailPanel(n);
  if (n.x != null && srwk.G) {
    const d = 90;
    const len = Math.hypot(n.x, n.y, n.z) || 1;
    const r = 1 + d / len;
    srwk.G.cameraPosition({ x: n.x * r, y: n.y * r, z: n.z * r }, n, 1100);
  }
}

function renderDetailPanel(n) {
  const el = document.getElementById("detail");
  if (!el) return;
  const cid = n.content_cid || null;
  const visited = n.last_visited ? new Date(n.last_visited).toLocaleString() : "—";

  // Resolve every contributor and build a multi-dot row.
  const contribIds = (n.contributors && n.contributors.length)
    ? n.contributors
    : (n.primary_contributor ? [n.primary_contributor] : []);
  const contribsHtml = contribIds.length
    ? contribIds.map((pk) => {
        const p = srwk.peers.get(pk);
        const color = p?.signature_color || stableHue(pk);
        const label = p?.nickname || pk.slice(0, 10);
        const isPrimary = pk === n.primary_contributor;
        return `<span class="d-contrib${isPrimary ? " primary" : ""}" title="${escHtml(label)}${isPrimary ? " · first to contribute" : ""}">
          <span class="d-dot" style="background:${color};box-shadow:0 0 8px ${color}"></span>
          ${escHtml(label)}
        </span>`;
      }).join("")
    : '<span class="v">—</span>';
  const overlapBadge = contribIds.length >= 2
    ? `<div class="d-overlap">↔ shared by ${contribIds.length} peers</div>`
    : "";

  // Issue #43 PR D: "scraped from" row. When the page came from a
  // peer pull, show who and color it with their signature_color.
  // Self-fetched rows get a neutral cyan dot + "self" label. The
  // server emits is_self / source_pubkey / source_label per node.
  let scrapedHtml = "";
  if (n.is_self === true) {
    scrapedHtml = `<div class="d-scraped is-self">
      <span class="sc-dot" style="background:#5AE6E6;color:#5AE6E6"></span>
      <span>self</span>
    </div>`;
  } else if (n.source_pubkey) {
    const peer = srwk.peers?.get(n.source_pubkey);
    const color = peer?.signature_color || stableHue(n.source_pubkey);
    const label = n.source_label || peer?.nickname ||
                  n.source_pubkey.slice(0, 12);
    const scrapedAt = n.scraped_at
      ? new Date(n.scraped_at).toLocaleString() : "";
    scrapedHtml = `<div class="d-scraped" title="${escHtml(scrapedAt || n.source_pubkey)}">
      <span class="sc-dot" style="background:${color};color:${color}"></span>
      <span>scraped from ${escHtml(label)}</span>
    </div>`;
  }

  el.innerHTML = `
    <div class="d-title" title="${escHtml(n.title || n.id)}">${escHtml((n.title || n.id).slice(0, 160))}</div>
    <div class="d-host">${escHtml(n.host || "")}</div>
    ${scrapedHtml}
    <div class="d-actions">
      <button class="d-btn primary" data-act="open">open ↗</button>
      <button class="d-btn" data-act="copy-url">copy url</button>
      ${cid ? `<button class="d-btn" data-act="copy-cid">copy cid</button>` : ""}
    </div>
    <div class="d-grid">
      <span class="k">topic</span><span class="v">${escHtml(n.topic || "—")}</span>
      <span class="k">degree</span><span class="v">${n.degree || 0}</span>
      <span class="k">contrib</span>
      <span class="v d-contrib-list">${contribsHtml}</span>
      <span class="k">last seen</span><span class="v">${escHtml(visited)}</span>
    </div>
    ${overlapBadge}
    ${cid ? `<div class="d-cid"><span class="k">cid</span><code class="v" title="${cid}">${cid.slice(0, 14)}…${cid.slice(-6)}</code></div>` : ""}
  `;
  el.querySelector('[data-act="open"]')?.addEventListener("click", () => {
    if (window.api?.openExternal) window.api.openExternal(n.id);
    else window.open(n.id, "_blank");
  });
  el.querySelector('[data-act="copy-url"]')?.addEventListener("click", () => {
    navigator.clipboard?.writeText(n.id).catch(() => {});
  });
  el.querySelector('[data-act="copy-cid"]')?.addEventListener("click", () => {
    if (cid) navigator.clipboard?.writeText(cid).catch(() => {});
  });
}

// ─── procedural textures ──────────────────────────────────────────────────

function makeSpriteTex() {
  // Hard core + soft falloff. The opaque inner disc is what the eye locks
  // onto on a large display — without it, bloom looks like fog. This is
  // the Pixar/teamLab/Refik recipe: a 1-2px solid white pixel at the
  // center, with a Gaussian-soft falloff around it.
  const SIZE = 256;
  const c = document.createElement("canvas"); c.width = c.height = SIZE;
  const ctx = c.getContext("2d");
  // Tight pinpoint core. The previous version had a wide soft falloff
  // (alpha 0.18 at 30% radius) which meant overlapping cores in dense
  // regions blended into a soft glow. Now: hard 8% disc + extremely
  // narrow falloff that drops to zero by 22% radius, so 400 packed
  // sprites read as 400 distinct dots instead of one cyan blob.
  const g = ctx.createRadialGradient(SIZE/2, SIZE/2, 0, SIZE/2, SIZE/2, SIZE/2);
  g.addColorStop(0,    "rgba(255,255,255,0.85)");
  g.addColorStop(0.08, "rgba(255,255,255,0.55)");
  g.addColorStop(0.18, "rgba(255,255,255,0.10)");
  g.addColorStop(0.28, "rgba(255,255,255,0.00)");
  g.addColorStop(1,    "rgba(255,255,255,0.00)");
  ctx.fillStyle = g; ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.fillStyle = "rgba(255,255,255,1.0)";
  ctx.beginPath();
  ctx.arc(SIZE/2, SIZE/2, SIZE * 0.08, 0, Math.PI * 2);
  ctx.fill();
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
function makeHaloTex() {
  const SIZE = 512;
  const c = document.createElement("canvas"); c.width = c.height = SIZE;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(SIZE/2, SIZE/2, 0, SIZE/2, SIZE/2, SIZE/2);
  g.addColorStop(0,    "rgba(255,255,255,0.32)");
  g.addColorStop(0.15, "rgba(255,255,255,0.18)");
  g.addColorStop(0.40, "rgba(255,255,255,0.06)");
  g.addColorStop(0.75, "rgba(255,255,255,0.02)");
  g.addColorStop(1,    "rgba(255,255,255,0.00)");
  ctx.fillStyle = g; ctx.fillRect(0, 0, SIZE, SIZE);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ─── atmospheric dust-mote field ──────────────────────────────────────────
// 3000 particles in a large volume around the graph. Slow rotation. The
// motes are very dim and very small individually; together they produce
// the perception of "this knowledge sits inside a larger deep-space field"
// rather than "this graph floats in a flat indigo void."

function buildAtmosphere(scene) {
  const N = 3000;
  const RADIUS = 4500;
  const positions = new Float32Array(N * 3);
  const phases    = new Float32Array(N);
  const sizes     = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    // sample inside a sphere (cube-root for uniform volume distribution)
    const u = Math.random();
    const r = RADIUS * Math.cbrt(u);
    const theta = Math.random() * Math.PI * 2;
    const phi   = Math.acos(2 * Math.random() - 1);
    positions[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = r * Math.cos(phi);
    phases[i] = Math.random() * Math.PI * 2;
    sizes[i]  = 0.6 + Math.random() * 1.6;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("aPhase", new THREE.BufferAttribute(phases, 1));
  geo.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime:       { value: 0 },
      uPixelRatio: { value: window.devicePixelRatio || 1 },
    },
    vertexShader: `
      attribute float aPhase;
      attribute float aSize;
      uniform float uTime;
      uniform float uPixelRatio;
      varying float vTwinkle;
      void main() {
        vTwinkle = 0.55 + 0.45 * sin(uTime * 0.4 + aPhase);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * uPixelRatio * (220.0 / max(0.001, -mv.z));
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      precision highp float;
      varying float vTwinkle;
      void main() {
        vec2 p = gl_PointCoord * 2.0 - 1.0;
        float r = dot(p, p);
        if (r > 1.0) discard;
        float core = exp(-r * 5.0);
        vec3 col = vec3(0.42, 0.55, 0.95) * core * vTwinkle;
        gl_FragColor = vec4(col, core * vTwinkle * 0.42);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  pts.renderOrder = -10;
  scene.add(pts);
  srwk.atmosphere = { points: pts, mat };
  // animate via requestAnimationFrame so it drifts even when sim is paused
  const t0 = performance.now();
  function tick() {
    const t = (performance.now() - t0) / 1000;
    mat.uniforms.uTime.value = t;
    pts.rotation.y = t * 0.012;
    pts.rotation.x = Math.sin(t * 0.005) * 0.05;
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// ─── tiny helpers ─────────────────────────────────────────────────────────

function escHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Coerce a (possibly object) SSE field into something a detail row can safely
// render. Without this, anywhere we did `escHtml(p.foo)` would emit
// `[object Object]` when the server changed a field from a string to a
// structured block (e.g. `peer` on slice_scraped). Behaviour:
//   primitives     → String(v) (or em-dash for null/undefined)
//   arrays/objects → JSON.stringify (compact form, used as inline tooltip
//                    text or for the generic dump path)
function formatValue(v) {
  if (v == null) return "—";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try { return JSON.stringify(v); } catch { return String(v); }
}

// Pull a "pubkey-ish" identifier from the heterogeneous peer-id fields the
// server emits. `slice_scraped` carries a `peer` object; `contribution_merged`
// carries `contributor` (string); `peer_joined` carries `contributor` too;
// `mdns_*` events have neither. Always returns a string (possibly empty).
function pickPeerPubkey(p) {
  if (!p) return "";
  if (typeof p.contributor === "string" && p.contributor) return p.contributor;
  if (p.peer && typeof p.peer === "object" && typeof p.peer.pubkey === "string") return p.peer.pubkey;
  if (typeof p.peer === "string") return p.peer;
  if (typeof p.pubkey === "string") return p.pubkey;
  if (p.peer && typeof p.peer === "object" && typeof p.peer.contributor === "string") return p.peer.contributor;
  return "";
}

// Pull a human-friendly nickname from heterogeneous payloads. Falls through
// to the peers map by pubkey, then to a short-pubkey label.
function pickPeerNickname(p, pubkey, peer) {
  if (peer?.nickname) return peer.nickname;
  if (p?.nickname) return p.nickname;
  if (p?.peer && typeof p.peer === "object" && typeof p.peer.nickname === "string") return p.peer.nickname;
  if (pubkey) return `peer-${String(pubkey).slice(0, 8)}`;
  return "system";
}

// Pull a signature_color when the server piggybacked one onto the event.
function pickPeerColor(p) {
  if (p?.peer && typeof p.peer === "object" && typeof p.peer.signature_color === "string") {
    return p.peer.signature_color;
  }
  if (typeof p?.signature_color === "string") return p.signature_color;
  return "";
}
function setStatus(text, error = false) {
  const el = document.getElementById("status");
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("error", !!error);
  el.style.opacity = text ? "1" : "0";
}

// ─── traffic panel (separate from events panel) ──────────────────────────
// Subscribes to the same SSE stream but renders only the protocol/network
// kinds (slice_*, mdns_*, zeroconf_*). Filter chips at the top scope the
// visible rows. Click a row → render the kind-specific detail in the
// shared .detail pane (same pattern as the events panel).

const TRAFFIC_LS_KEY = "srwk:traffic:collapsed";
const TRAFFIC_MAX_ROWS = 50;
const TRAFFIC_AGED_AFTER = 15;
const trafficState = {
  pending: [],
  flushScheduled: false,
  total: 0,
  pulseTimer: null,
  collapsed: true,
  filter: "all",
};

// Map kind → filter category. Used by the chips and to give every row a
// graceful fallback dot color.
const TRAFFIC_KIND_GROUP = {
  slice_scraped: "slice",
  slice_scrape_error: "slice",
  slice_skipped_self: "slice",
  slice_replay_dropped: "slice",
  slice_size_rejected: "slice",
  mdns_discovered: "mdns",
  mdns_evicted: "mdns",
  zeroconf_revived: "mdns",
  contribution_merged: "ingest",
  // DC-net protocol family (SPEC v0.3 §17, §27)
  dcnet_round_started: "dcnet",
  dcnet_round_complete: "dcnet",
  anonymity_set_changed: "dcnet",
  // Ticket family (SPEC v0.3 §27, QUERY_TICKET_V1 / RECEIPT_TICKET_V1)
  ticket_issued: "tickets",
  ticket_redeemed: "tickets",
  epoch_rotated: "tickets",
  // Anonymous receipts (SPEC v0.3 §27.29)
  receipt_submitted: "receipts",
  // Router (SPEC v0.3 §11 SearchResponse)
  web_search_completed: "router",
};
function trafficGroupFor(kind) { return TRAFFIC_KIND_GROUP[kind] || "ingest"; }
function trafficIsError(kind) {
  return kind === "slice_scrape_error" || kind === "slice_size_rejected";
}

// Color for the leading dot per kind. These are tuned to match the CSS
// .e-meta tints so the row reads as a single hue at a glance.
const TRAFFIC_DOT = {
  slice_scraped: null, // peer color
  slice_scrape_error: "#FF7BD0",
  slice_skipped_self: "rgba(220,232,255,0.42)",
  slice_replay_dropped: "#FFD16A",
  slice_size_rejected: "#FF7BD0",
  mdns_discovered: "#7CFFAA",
  mdns_evicted: "#FFA960",
  zeroconf_revived: "#C798FF",
  dcnet_round_started: "#C798FF",
  dcnet_round_complete: "#C798FF",
  anonymity_set_changed: "#5AF0FF",
  ticket_issued: "#FFD16A",
  ticket_redeemed: "#FFD16A",
  receipt_submitted: "#7CFFAA",
  epoch_rotated: "#FF4FE6",
  web_search_completed: "#FF4FE6",
};

function wireTrafficPanel() {
  const panel = document.getElementById("traffic-panel");
  const head = document.getElementById("traffic-panel-head");
  const list = document.getElementById("traffic-panel-list");
  const bar = document.getElementById("traffic-filter-bar");
  if (!panel || !head || !list || !bar) return;
  let collapsed = true;
  try {
    const v = localStorage.getItem(TRAFFIC_LS_KEY);
    if (v === "false") collapsed = false;
  } catch {}
  const apply = () => {
    trafficState.collapsed = collapsed;
    panel.dataset.collapsed = collapsed ? "true" : "false";
    head.setAttribute("aria-expanded", collapsed ? "false" : "true");
  };
  apply();
  if (!list.firstChild) {
    const empty = document.createElement("div");
    empty.className = "events-empty";
    empty.id = "traffic-empty";
    empty.textContent = "the wire is quiet.";
    list.appendChild(empty);
  }
  head.addEventListener("click", () => {
    collapsed = !collapsed;
    try { localStorage.setItem(TRAFFIC_LS_KEY, collapsed ? "true" : "false"); } catch {}
    apply();
  });
  bar.addEventListener("click", (e) => {
    const btn = e.target.closest(".traffic-chip");
    if (!btn) return;
    const f = btn.dataset.filter || "all";
    trafficState.filter = f;
    for (const c of bar.querySelectorAll(".traffic-chip")) {
      c.classList.toggle("selected", c.dataset.filter === f);
    }
    applyTrafficFilter();
  });
}

function applyTrafficFilter() {
  const list = document.getElementById("traffic-panel-list");
  if (!list) return;
  const f = trafficState.filter;
  for (const row of list.children) {
    if (!row.dataset || !row.dataset.eventKind) continue;
    const kind = row.dataset.eventKind;
    let show = false;
    if (f === "all") show = true;
    else if (f === "error") show = trafficIsError(kind);
    else show = trafficGroupFor(kind) === f;
    row.style.display = show ? "" : "none";
  }
}

function appendTrafficEvent(evt) {
  trafficState.pending.push(evt);
  if (trafficState.pending.length > TRAFFIC_MAX_ROWS * 4) {
    trafficState.pending.splice(0, trafficState.pending.length - TRAFFIC_MAX_ROWS * 4);
  }
  if (!trafficState.flushScheduled) {
    trafficState.flushScheduled = true;
    requestAnimationFrame(flushTrafficEvents);
  }
}

function flushTrafficEvents() {
  trafficState.flushScheduled = false;
  const batch = trafficState.pending;
  trafficState.pending = [];
  if (!batch.length) return;
  const list = document.getElementById("traffic-panel-list");
  if (!list) return;
  const empty = document.getElementById("traffic-empty");
  if (empty) empty.remove();
  for (const evt of batch) {
    const row = buildTrafficRow(evt);
    if (!row) continue;
    list.insertBefore(row, list.firstChild);
    requestAnimationFrame(() => row.classList.remove("enter"));
  }
  while (list.childElementCount > TRAFFIC_MAX_ROWS) {
    list.removeChild(list.lastElementChild);
  }
  const rows = list.children;
  for (let i = 0; i < rows.length; i++) {
    rows[i].classList.toggle("aged", i >= TRAFFIC_AGED_AFTER);
  }
  trafficState.total += batch.length;
  const counter = document.getElementById("traffic-panel-count");
  if (counter) {
    counter.textContent = String(trafficState.total);
    counter.classList.add("pulse");
    if (trafficState.pulseTimer) clearTimeout(trafficState.pulseTimer);
    trafficState.pulseTimer = setTimeout(() => counter.classList.remove("pulse"), 480);
  }
  applyTrafficFilter();
}

function buildTrafficRow(evt) {
  const row = document.createElement("div");
  row.className = `events-row enter kind-${evt.kind}`;
  const dot = document.createElement("span");
  dot.className = "e-dot";
  const body = document.createElement("span");
  body.className = "e-body";
  const ts = formatEventTs(evt.ts);
  const p = evt.payload || {};
  // SSE event payload shapes vary: `slice_scraped` ships a `peer` OBJECT
  // (pubkey/nickname/signature_color), while `contribution_merged` ships a
  // flat `contributor` string. pickPeerPubkey collapses both into a string.
  const pubkey = pickPeerPubkey(p);
  const peer = pubkey ? srwk.peers.get(pubkey) : null;
  let dotColor = TRAFFIC_DOT[evt.kind];
  if (dotColor === null || dotColor === undefined) {
    dotColor = peer?.signature_color
      || pickPeerColor(p)
      || (pubkey ? stableHue(pubkey) : "rgba(220,232,255,0.42)");
  }
  dot.style.background = dotColor;
  dot.style.boxShadow = `0 0 6px ${dotColor}`;
  const nick = pickPeerNickname(p, pubkey, peer);

  let summaryHtml = "";
  let bar = null;
  if (evt.kind === "slice_scraped") {
    const np = p.pages_added ?? p.page_count ?? 0;
    const sr = p.results_added ?? p.result_count ?? 0;
    const took = p.took_ms ?? p.duration_ms ?? 0;
    summaryHtml =
      `<span class="e-meta">+${np}p +${sr}sr</span>` +
      ` · <span class="e-tail">${took}ms</span> · ` +
      `<span class="e-actor">${escHtml(nick)}</span>`;
    bar = document.createElement("span");
    bar.className = "e-bar";
    // log scale: 500ms full width = 60px
    const px = Math.max(4, Math.min(60, Math.log10(Math.max(1, took)) / Math.log10(500) * 60));
    bar.style.width = `${px}px`;
  } else if (evt.kind === "slice_scrape_error") {
    const errType = p.error_type || p.kind || "error";
    const consec = p.consecutive_errors ?? p.errors ?? 1;
    summaryHtml =
      `<span class="e-meta">${escHtml(errType)}</span> · ` +
      `<span class="e-actor">${escHtml(nick)}</span> · ` +
      `<span class="e-tail">err #${consec}</span>`;
  } else if (evt.kind === "slice_skipped_self") {
    const url = p.url || p.peer_url || "";
    summaryHtml =
      `<span class="e-meta">self-loop</span> · ` +
      `<span class="e-tail">${escHtml(String(url).slice(0, 56))}</span>`;
  } else if (evt.kind === "slice_replay_dropped") {
    const root = p.slice_root || p.slice_root_prefix || "";
    const prefix = String(root).slice(0, 12);
    const merged = p.existing_merged_at ? Date.parse(p.existing_merged_at) : null;
    const ageMs = merged ? Math.max(0, Date.now() - merged) : null;
    const ageStr = ageMs == null ? "" : `${Math.round(ageMs / 60000)}m ago`;
    summaryHtml =
      `<span class="e-meta">replay</span> · ` +
      `<span class="e-tail">${escHtml(prefix)}${ageStr ? ` · merged ${escHtml(ageStr)}` : ""}</span>`;
  } else if (evt.kind === "slice_size_rejected") {
    // Server emits pages_count + cap_hit (not page_count / cap); accept
    // both spellings so older payloads still render.
    const pages = p.pages_count ?? p.page_count ?? p.pages ?? "?";
    const cap = p.cap_hit ?? p.cap ?? p.limit ?? "—";
    summaryHtml =
      `<span class="e-meta">size cap</span> · ` +
      `<span class="e-tail">${escHtml(String(pages))} pages · ${escHtml(String(cap))}</span>`;
  } else if (evt.kind === "mdns_discovered") {
    const name = p.name || p.nickname || "—";
    const url = p.url || p.endpoint || "";
    summaryHtml =
      `<span class="e-meta">+ ${escHtml(name)}</span> · ` +
      `<span class="e-tail">${escHtml(String(url).replace(/^https?:\/\//, "").slice(0, 36))}</span>`;
  } else if (evt.kind === "mdns_evicted") {
    const name = p.name || p.nickname || "—";
    const errs = p.consecutive_errors ?? p.errors ?? 0;
    summaryHtml =
      `<span class="e-meta">− ${escHtml(name)}</span> · ` +
      `<span class="e-tail">after ${errs} err${errs === 1 ? "" : "s"}</span>`;
  } else if (evt.kind === "zeroconf_revived") {
    const silent = p.silent_for_secs ?? p.silent_secs ?? 0;
    summaryHtml =
      `<span class="e-meta">rebuilt</span> · ` +
      `<span class="e-tail">after ${escHtml(String(silent))}s silent</span>`;
  } else if (evt.kind === "dcnet_round_started") {
    const setSize = p.anonymity_set_size ?? "?";
    const min = p.min_set_met === false ? " ⚠" : "";
    summaryHtml =
      `<span class="e-meta">round ▶ ${escHtml(String(setSize))}${escHtml(min)}</span> · ` +
      `<span class="e-tail">${escHtml(String(p.qid || "").slice(0, 12))}</span>`;
  } else if (evt.kind === "dcnet_round_complete") {
    const took = p.took_ms ?? 0;
    const status = p.status || "ok";
    summaryHtml =
      `<span class="e-meta">round ${escHtml(status)} ${escHtml(String(took))}ms</span> · ` +
      `<span class="e-tail">${escHtml(String(p.responder_count ?? 0))} responders</span>`;
  } else if (evt.kind === "ticket_issued") {
    summaryHtml =
      `<span class="e-meta">+${escHtml(String(p.count ?? 0))} ${escHtml(formatValue(p.family || "tickets"))}</span> · ` +
      `<span class="e-tail">epoch ${escHtml(formatValue(p.epoch_id || "?"))}</span>`;
  } else if (evt.kind === "ticket_redeemed") {
    const ok = p.accepted === false ? "rejected" : "redeemed";
    // formatValue collapses a structured `scope` ({circle_id,qhash}) into
    // a JSON snippet instead of "[object Object]".
    summaryHtml =
      `<span class="e-meta">${escHtml(formatValue(p.family || "ticket"))} ${escHtml(ok)}</span> · ` +
      `<span class="e-tail">scope=${escHtml(formatValue(p.scope ?? "—"))}</span>`;
  } else if (evt.kind === "receipt_submitted") {
    summaryHtml =
      `<span class="e-meta">${escHtml(formatValue(p.receipt_class || "receipt"))}</span> · ` +
      `<span class="e-tail">${escHtml(formatValue(p.delivery || "—"))} · ${escHtml(formatValue(p.provider_pubkey_short || "—"))}</span>`;
  } else if (evt.kind === "anonymity_set_changed") {
    const met = p.met === true;
    summaryHtml =
      `<span class="e-meta">circle ${escHtml(String(p.active_peer_count ?? "?"))}/${escHtml(String(p.min_anonymity_set ?? "?"))} ${met ? "✓" : "⚠"}</span>`;
  } else if (evt.kind === "epoch_rotated") {
    summaryHtml =
      `<span class="e-meta">epoch ▶ ${escHtml(String(p.new_epoch_id || "?"))}</span> · ` +
      `<span class="e-tail">q=${escHtml(String(p.query_quota ?? 0))} r=${escHtml(String(p.receipt_quota ?? 0))}</span>`;
  } else if (evt.kind === "web_search_completed") {
    const dp = p.delivery_path || "—";
    const att = Array.isArray(p.attempts) ? p.attempts.length : 0;
    summaryHtml =
      `<span class="e-meta">${escHtml(dp)}</span> · ` +
      `<span class="e-tail">${escHtml(String(att))} attempt${att === 1 ? "" : "s"}</span>`;
  } else {
    summaryHtml =
      `<span class="e-meta">${escHtml(evt.kind)}</span>`;
  }

  body.innerHTML = `<span class="e-ts">${escHtml(ts)}</span>` + summaryHtml;
  row.append(dot, body);
  if (bar) row.append(bar);
  row.dataset.eventKind = evt.kind;
  row.tabIndex = 0;
  row.addEventListener("click", () => selectTrafficRow(row, evt));
  row.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      selectTrafficRow(row, evt);
    }
  });
  return row;
}

function selectTrafficRow(row, evt) {
  const list = document.getElementById("traffic-panel-list");
  if (row.classList.contains("selected")) {
    row.classList.remove("selected");
    clearDetail();
    return;
  }
  if (list) {
    for (const sib of list.querySelectorAll(".events-row.selected")) {
      sib.classList.remove("selected");
    }
  }
  // Also clear selection in the events panel since they share the detail pane.
  const eList = document.getElementById("events-panel-list");
  if (eList) {
    for (const sib of eList.querySelectorAll(".events-row.selected")) {
      sib.classList.remove("selected");
    }
  }
  row.classList.add("selected");
  renderTrafficDetail(evt);
}

function renderTrafficDetail(evt) {
  const el = document.getElementById("detail");
  if (!el) return;
  const p = evt.payload || {};
  // Use the same field-shape resolver as buildTrafficRow so the detail
  // panel never inherits a stringified `[object Object]` for `peer`.
  const pubkey = pickPeerPubkey(p);
  const peer = pubkey ? srwk.peers.get(pubkey) : null;
  const color = peer?.signature_color
    || pickPeerColor(p)
    || (pubkey ? stableHue(pubkey) : "#7D8AAB");
  const nick = pickPeerNickname(p, pubkey, peer);
  const ts = new Date(evt.ts).toLocaleString();
  const pkShort = pubkey ? `${String(pubkey).slice(0, 14)}…${String(pubkey).slice(-6)}` : "—";
  const closeBtn = `<button class="ed-close" type="button" aria-label="close" title="close (Esc)">✕</button>`;

  // Per-kind layouts; everything else falls through to the generic dump.
  if (evt.kind === "slice_scraped") {
    const url = p.url || "";
    const np = p.pages_added ?? p.page_count ?? 0;
    const sr = p.results_added ?? p.result_count ?? 0;
    const took = p.took_ms ?? p.duration_ms ?? 0;
    const pageMax = p.page_max ?? p.page_max_cursor ?? "—";
    const srMax = p.sr_max ?? p.sr_max_cursor ?? "—";
    el.innerHTML = `
      ${closeBtn}
      <div class="d-title">slice scraped</div>
      <div class="d-host">${escHtml(ts)}</div>
      <div class="d-grid">
        <span class="k">peer</span><span class="v"><span class="d-dot" style="background:${color};box-shadow:0 0 8px ${color}"></span>${escHtml(nick)}</span>
        <span class="k">pubkey</span><span class="v" title="${escHtml(pubkey)}"><code style="font-size:10px">${escHtml(pkShort)}</code></span>
        <span class="k">url</span><span class="v" style="word-break:break-all">${escHtml(url)}</span>
        <span class="k">pages</span><span class="v">+${np}</span>
        <span class="k">results</span><span class="v">+${sr}</span>
        <span class="k">duration</span><span class="v">${took}ms</span>
        <span class="k">page max</span><span class="v"><code style="font-size:10px">${escHtml(String(pageMax))}</code></span>
        <span class="k">sr max</span><span class="v"><code style="font-size:10px">${escHtml(String(srMax))}</code></span>
      </div>
    `;
  } else if (evt.kind === "slice_scrape_error") {
    const url = p.url || "";
    const errType = p.error_type || p.kind || "error";
    // Server emits error_msg; older debug code emitted error/message. Accept
    // all three so a payload-shape change doesn't blank the detail row.
    const msg = p.error_msg || p.error || p.message || p.msg || "";
    const consec = p.consecutive_errors ?? p.errors ?? 1;
    el.innerHTML = `
      ${closeBtn}
      <div class="d-title">scrape error</div>
      <div class="d-host">${escHtml(ts)}</div>
      <div class="d-grid">
        <span class="k">peer</span><span class="v"><span class="d-dot" style="background:${color};box-shadow:0 0 8px ${color}"></span>${escHtml(nick)}</span>
        <span class="k">type</span><span class="v">${escHtml(errType)}</span>
        <span class="k">consec</span><span class="v">#${escHtml(String(consec))}</span>
        <span class="k">url</span><span class="v" style="word-break:break-all">${escHtml(url)}</span>
        ${msg ? `<span class="k">msg</span><span class="v" style="word-break:break-word">${escHtml(msg)}</span>` : ""}
      </div>
    `;
  } else if (evt.kind === "slice_replay_dropped") {
    const root = p.slice_root || p.slice_root_prefix || "—";
    const merged = p.existing_merged_at;
    const mergedFmt = merged ? new Date(merged).toLocaleString() : "—";
    el.innerHTML = `
      ${closeBtn}
      <div class="d-title">replay dropped</div>
      <div class="d-host">${escHtml(ts)}</div>
      <div class="d-grid">
        <span class="k">peer</span><span class="v"><span class="d-dot" style="background:${color};box-shadow:0 0 8px ${color}"></span>${escHtml(nick)}</span>
        <span class="k">slice root</span><span class="v" style="word-break:break-all"><code style="font-size:10px">${escHtml(root)}</code></span>
        <span class="k">merged</span><span class="v">${escHtml(mergedFmt)}</span>
      </div>
      <div class="ed-section-title">why</div>
      <div class="ed-empty">slice already merged earlier; replay suppressed to avoid double-counting.</div>
    `;
  } else if (evt.kind === "mdns_discovered" || evt.kind === "mdns_evicted") {
    const name = p.name || p.nickname || "—";
    const url = p.url || p.endpoint || "—";
    const errs = p.errors ?? p.consecutive_errors ?? 0;
    const verb = evt.kind === "mdns_discovered" ? "discovered" : "evicted";
    el.innerHTML = `
      ${closeBtn}
      <div class="d-title">mdns ${escHtml(verb)}</div>
      <div class="d-host">${escHtml(ts)}</div>
      <div class="d-grid">
        <span class="k">name</span><span class="v">${escHtml(name)}</span>
        <span class="k">url</span><span class="v" style="word-break:break-all">${escHtml(url)}</span>
        ${evt.kind === "mdns_evicted" ? `<span class="k">errors</span><span class="v">${errs}</span>` : ""}
      </div>
    `;
  } else if (evt.kind === "zeroconf_revived") {
    const silent = p.silent_for_secs ?? p.silent_secs ?? 0;
    const wiped = p.peers_wiped ?? p.wiped ?? 0;
    el.innerHTML = `
      ${closeBtn}
      <div class="d-title">zeroconf revived</div>
      <div class="d-host">${escHtml(ts)}</div>
      <div class="d-grid">
        <span class="k">silent</span><span class="v">${escHtml(String(silent))}s</span>
        <span class="k">wiped</span><span class="v">${escHtml(String(wiped))} peer${wiped === 1 ? "" : "s"}</span>
      </div>
    `;
  } else if (evt.kind === "dcnet_round_started" || evt.kind === "dcnet_round_complete") {
    el.innerHTML = `${closeBtn}` + renderDcnetRoundDetail(evt);
  } else if (evt.kind === "web_search_completed") {
    el.innerHTML = `${closeBtn}` + renderWebSearchDetail(p, ts);
  } else if (evt.kind === "ticket_issued" || evt.kind === "ticket_redeemed") {
    // Wrap every potentially-non-string field in formatValue so a
    // structured `scope` (e.g. {circle, qid}) renders as JSON instead of
    // the literal "[object Object]" we used to emit.
    el.innerHTML = `
      ${closeBtn}
      <div class="d-title">${escHtml(evt.kind === "ticket_issued" ? "tickets issued" : "ticket redeemed")}</div>
      <div class="d-host">${escHtml(ts)}</div>
      <div class="d-grid">
        <span class="k">family</span><span class="v">${escHtml(formatValue(p.family))}</span>
        <span class="k">epoch</span><span class="v">${escHtml(formatValue(p.epoch_id))}</span>
        ${p.count != null ? `<span class="k">count</span><span class="v">${escHtml(formatValue(p.count))}</span>` : ""}
        ${p.qid ? `<span class="k">qid</span><span class="v"><code>${escHtml(String(formatValue(p.qid)).slice(0, 24))}</code></span>` : ""}
        ${p.scope != null ? `<span class="k">scope</span><span class="v">${escHtml(formatValue(p.scope))}</span>` : ""}
        ${p.accepted != null ? `<span class="k">accepted</span><span class="v">${p.accepted ? "yes" : "no"}</span>` : ""}
        ${p.issuer_key_id_short ? `<span class="k">issuer</span><span class="v"><code>${escHtml(formatValue(p.issuer_key_id_short))}</code></span>` : ""}
      </div>
    `;
  } else if (evt.kind === "receipt_submitted") {
    el.innerHTML = `${closeBtn}` + renderReceiptDetail(p, ts);
  } else if (evt.kind === "anonymity_set_changed" || evt.kind === "epoch_rotated") {
    el.innerHTML = `
      ${closeBtn}
      <div class="d-title">${escHtml(evt.kind.replace(/_/g, " "))}</div>
      <div class="d-host">${escHtml(ts)}</div>
      <pre class="ed-empty" style="white-space:pre-wrap;word-break:break-word;font-family:var(--font-mono);font-size:10.5px;color:var(--light-3)">${escHtml((() => { try { return JSON.stringify(p, null, 2); } catch { return String(p); } })())}</pre>
    `;
  } else {
    // Generic payload dump
    let dump = "";
    try { dump = JSON.stringify(p, null, 2); } catch { dump = String(p); }
    el.innerHTML = `
      ${closeBtn}
      <div class="d-title">${escHtml(evt.kind)}</div>
      <div class="d-host">${escHtml(ts)}</div>
      <pre class="ed-empty" style="white-space:pre-wrap;word-break:break-word;font-family:var(--font-mono);font-size:10.5px;color:var(--light-3)">${escHtml(dump)}</pre>
    `;
  }
  _wireCloseButton(el);
}

// ─── DC-net-aware UI ──────────────────────────────────────────────────────
//
// SPEC v0.3 LAN_FRIEND_DCNET event-kind contract (consumed from /events SSE).
// `swf-node` does not emit any of these today; every panel below shows its
// empty state until the protocol ships. When events DO arrive, the matching
// state machine takes over the panel rendering. Documenting verbatim so a
// future grep on "dcnet_round_started" finds the consumer.
//
//   dcnet_round_started      {circle_id, epoch_id, round_id, qid, query_hmac,
//                              anonymity_set_size, min_set_met, ts}
//   dcnet_round_complete     {round_id, status (ok|timeout|malformed|insufficient_set),
//                              responder_count, took_ms, results_count}
//   ticket_issued            {family (QUERY_TICKET_V1|RECEIPT_TICKET_V1),
//                              epoch_id, count, issuer_key_id_short}
//   ticket_redeemed          {family, epoch_id, qid, scope, accepted}
//   receipt_submitted        {provider_pubkey_short, receipt_class,
//                              delivery (local_only|direct_provider|
//                                        receipt_board|dcnet_receipt_round),
//                              epoch_id}
//   anonymity_set_changed    {circle_id, active_peer_count, min_anonymity_set, met}
//   epoch_rotated            {circle_id, old_epoch_id, new_epoch_id,
//                              query_quota, receipt_quota}
//   web_search_completed     full SearchResponse (SPEC §11): {qid, query_hmac,
//                              delivery_path, attempts[], privacy_level,
//                              privacy_downgrade?, confirmation_required?,
//                              anonymous_ticket?, active_circle?, ...}
//
// Partial payloads are tolerated everywhere; missing fields → "—".

const ROUTER_LS_KEY = "srwk:router:collapsed";
const TICKETS_LS_KEY = "srwk:tickets:collapsed";
const RECEIPTS_LS_KEY = "srwk:receipts:collapsed";

// Cross-panel state. Each Map is keyed in the obvious way; trimming is light
// because real-world emission rates are low (rounds happen on user query).
const dcnetState = {
  rounds: new Map(),                // round_id → {started, completed, qid, ...}
  responderTicks: new Map(),        // round_id → array of timestamps (currently unused; filled if responder events appear)
  lastSet: null,                    // most recent anonymity_set_changed payload
  lastSetTs: 0,
  lastEpoch: null,                  // most recent epoch_rotated payload
};
const ticketsState = {
  // Track tallies via issued count − redeemed count, scoped to current epoch.
  byFamily: { QUERY_TICKET_V1: { issued: 0, redeemed: 0, quota: 0 },
              RECEIPT_TICKET_V1: { issued: 0, redeemed: 0, quota: 0 } },
  recent: [],                       // ring of last ~30 events for sub-list
  selected: null,                   // family currently expanded into detail pane
};
const receiptsState = {
  byProvider: new Map(),            // pubkey_short → {classes:Map, total, lastTs}
  total: 0,
};
const routerState = {
  recent: [],                       // ring of last 50 web_search_completed
  selected: null,
};

// Stable color palette for receipt providers based on hashed pubkey.
function _providerHue(pkShort) {
  if (!pkShort) return "rgba(220, 232, 255, 0.55)";
  const peer = [...srwk.peers.values()].find(p =>
    typeof p.pubkey === "string" && p.pubkey.startsWith(pkShort));
  return peer?.signature_color || stableHue(pkShort);
}

// ─── anonymity-set indicator ──────────────────────────────────────────────
function wireAnonBadge() {
  const badge = document.getElementById("anon-badge");
  const popover = document.getElementById("anon-popover");
  if (!badge || !popover) return;
  const open = () => {
    badge.setAttribute("aria-expanded", "true");
    popover.hidden = false;
    renderAnonPopover();
  };
  const close = () => {
    badge.setAttribute("aria-expanded", "false");
    popover.hidden = true;
  };
  badge.addEventListener("click", () => popover.hidden ? open() : close());
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !popover.hidden) close();
  });
  // Light /health poll to seed the popover with active_circle data when no
  // SSE event has arrived yet. Skipped if we already received a fresh
  // anonymity_set_changed.
  setInterval(async () => {
    if (Date.now() - dcnetState.lastSetTs < 30000) return;
    try {
      const r = await fetch(`${srwk.serverUrl}/health`);
      if (!r.ok) return;
      const h = await r.json();
      if (h && h.active_circle) {
        // The shape is best-effort; degrade gracefully.
        const ac = h.active_circle;
        if (ac.active_peer_count != null && ac.min_anonymity_set != null) {
          onAnonymitySetChanged({
            circle_id: ac.circle_id,
            active_peer_count: ac.active_peer_count,
            min_anonymity_set: ac.min_anonymity_set,
            met: ac.met ?? (ac.active_peer_count >= ac.min_anonymity_set),
            _from_health: true,
          });
        }
      }
    } catch { /* swallow */ }
  }, 15000);
}

function onAnonymitySetChanged(p) {
  dcnetState.lastSet = p;
  dcnetState.lastSetTs = Date.now();
  renderAnonBadge();
  // Re-render popover live if it's open.
  const pop = document.getElementById("anon-popover");
  if (pop && !pop.hidden) renderAnonPopover();
}

function renderAnonBadge() {
  // Mirror the same state into the prominent network-tab header.
  if (typeof renderNetAnonHeader === "function") renderNetAnonHeader();
  const badge = document.getElementById("anon-badge");
  if (!badge) return;
  const valEl = badge.querySelector(".ab-value");
  const markEl = badge.querySelector(".ab-mark");
  const p = dcnetState.lastSet;
  if (!p || (p.active_peer_count == null && p.min_anonymity_set == null)) {
    badge.dataset.state = "idle";
    if (valEl) valEl.textContent = "idle";
    if (markEl) markEl.textContent = "";
    badge.title = "no DC-net round in flight";
    return;
  }
  const a = p.active_peer_count ?? 0;
  const m = p.min_anonymity_set ?? 0;
  const met = (p.met === true) || (a >= m && m > 0);
  badge.dataset.state = met ? "met" : "unmet";
  if (valEl) valEl.textContent = `${a}/${m}`;
  if (markEl) markEl.textContent = met ? "✓" : "⚠";
  badge.title = met
    ? `LAN_FRIEND_DCNET active · ${a} peers in circle (min ${m})`
    : `LAN_FRIEND_DCNET cannot be reported until min anonymity set is reached (${a}/${m})`;
}

function renderAnonPopover() {
  const pop = document.getElementById("anon-popover");
  if (!pop) return;
  const p = dcnetState.lastSet || {};
  const ep = dcnetState.lastEpoch || {};
  const tk = (k) => p[k] != null ? escHtml(String(p[k])) : "—";
  const epoch = ep.new_epoch_id || ep.epoch_id || p.epoch_id || "—";
  const transport = p.transport_kind || "lan_friend_dcnet_round";
  const claim = p.requester_anonymity_claim || "anonymous_within_lan_circle_query_visible";
  const roster = p.member_roster_commitment || p.roster_commitment;
  const rosterShort = roster ? `${String(roster).slice(0, 14)}…` : "—";
  const a = p.active_peer_count, m = p.min_anonymity_set;
  const met = (p.met === true) || (a != null && m != null && a >= m && m > 0);
  pop.innerHTML = `
    <div class="ap-title">active circle</div>
    <div class="ap-grid">
      <span class="k">circle</span><span class="v">${tk("circle_id")}</span>
      <span class="k">epoch</span><span class="v">${escHtml(String(epoch))}</span>
      <span class="k">members</span><span class="v">${a ?? "—"}/${m ?? "—"} ${met ? "✓" : "⚠"}</span>
      <span class="k">roster</span><span class="v"><code>${escHtml(rosterShort)}</code></span>
      <span class="k">transport</span><span class="v">${escHtml(transport)}</span>
      <span class="k">claim</span><span class="v">${escHtml(claim)}</span>
    </div>
    ${met ? "" : `<div class="ap-warn">LAN_FRIEND_DCNET cannot be reported until min anonymity set is reached.</div>`}
  `;
}

// ─── DC-net round tracking (consumed by traffic-row clicks) ──────────────
function onDcnetRoundStarted(p) {
  if (!p || !p.round_id) return;
  dcnetState.rounds.set(p.round_id, {
    started_at: Date.now(),
    completed_at: null,
    qid: p.qid, query_hmac: p.query_hmac, epoch_id: p.epoch_id,
    circle_id: p.circle_id,
    anonymity_set_size: p.anonymity_set_size,
    min_set_met: p.min_set_met,
    status: null, took_ms: null,
    responder_count: null, results_count: null,
    responder_ticks: [],
  });
  // Trim
  if (dcnetState.rounds.size > 100) {
    const firstKey = dcnetState.rounds.keys().next().value;
    if (firstKey) dcnetState.rounds.delete(firstKey);
  }
}

function onDcnetRoundComplete(p) {
  if (!p || !p.round_id) return;
  const r = dcnetState.rounds.get(p.round_id);
  if (!r) {
    // Round_complete arrived without a started — still record what we know.
    dcnetState.rounds.set(p.round_id, {
      started_at: null,
      completed_at: Date.now(),
      status: p.status,
      took_ms: p.took_ms,
      responder_count: p.responder_count,
      results_count: p.results_count,
      responder_ticks: [],
    });
    return;
  }
  r.completed_at = Date.now();
  r.status = p.status;
  r.took_ms = p.took_ms;
  r.responder_count = p.responder_count;
  r.results_count = p.results_count;
  // Synthesize responder ticks if server didn't emit per-responder events:
  // distribute responder_count evenly across [started_at, completed_at].
  if (r.responder_ticks.length === 0 && r.responder_count && r.took_ms) {
    const n = Math.max(0, Math.min(50, r.responder_count));
    for (let i = 0; i < n; i++) {
      r.responder_ticks.push((i + 1) / (n + 1) * r.took_ms);
    }
  }
}

function renderDcnetRoundDetail(evt) {
  const p = evt.payload || {};
  const roundId = p.round_id;
  const r = roundId ? dcnetState.rounds.get(roundId) : null;
  const ts = new Date(evt.ts).toLocaleString();
  const merged = r || {};
  const took = merged.took_ms ?? p.took_ms ?? 0;
  const responders = merged.responder_count ?? p.responder_count ?? 0;
  const results = merged.results_count ?? p.results_count ?? 0;
  const set = merged.anonymity_set_size ?? p.anonymity_set_size ?? "—";
  const status = merged.status ?? p.status ?? (evt.kind === "dcnet_round_started" ? "in flight" : "—");
  const epoch = merged.epoch_id ?? p.epoch_id ?? "—";
  const qid = merged.qid ?? p.qid ?? "—";
  const qh = merged.query_hmac ?? p.query_hmac ?? "";
  const qhShort = qh ? `${String(qh).slice(0, 12)}…` : "—";

  // Mini-timeline marks: started at 0%, broadcast ~5%, responders distributed,
  // decoded ~95%, complete 100%. All as % of usable width.
  const marks = [];
  marks.push({ pct: 0, label: "started", cls: "" });
  marks.push({ pct: 5, label: "broadcast", cls: "" });
  if (Array.isArray(merged.responder_ticks) && took > 0) {
    for (const t of merged.responder_ticks) {
      const pct = Math.max(6, Math.min(94, (t / Math.max(1, took)) * 100));
      marks.push({ pct, label: "", cls: "responder" });
    }
  }
  marks.push({ pct: 95, label: "decoded", cls: "" });
  marks.push({ pct: 100, label: "complete", cls: "complete" });

  const miniHtml = `
    <div class="dcnet-mini">
      <div class="dcnet-mini-track"></div>
      ${marks.map(m => {
        const labelHtml = m.label ? `<div class="dcnet-mini-label" style="left:${m.pct}%">${escHtml(m.label)}</div>` : "";
        return `${labelHtml}<div class="dcnet-mini-mark ${m.cls}" style="left:${m.pct}%"></div>`;
      }).join("")}
      <div class="dcnet-mini-foot" style="left:100%">${escHtml(String(took))}ms</div>
    </div>
  `;

  // Ticket-redeem confirmation if a ticket_redeemed event matched this qid.
  const matchedTicket = ticketsState.recent.find(e =>
    e.kind === "ticket_redeemed" && e.payload && e.payload.qid === qid);
  const ticketHtml = matchedTicket
    ? `<div class="d-overlap" style="color:var(--neon-cyan);background:rgba(90,240,255,0.05);box-shadow:inset 0 0 0 1px rgba(90,240,255,0.30)">ticket redeemed · ${escHtml(matchedTicket.payload.family || "—")} · ${matchedTicket.payload.accepted === false ? "rejected" : "accepted"}</div>`
    : "";

  return `
    <div class="d-title">DC-net round</div>
    <div class="d-host">${escHtml(ts)} · status=${escHtml(String(status))}</div>
    ${miniHtml}
    <div class="d-grid">
      <span class="k">round</span><span class="v"><code>${escHtml(String(roundId || "—").slice(0, 24))}</code></span>
      <span class="k">qid</span><span class="v"><code>${escHtml(String(qid).slice(0, 24))}</code></span>
      <span class="k">query</span><span class="v"><code>${escHtml(qhShort)}</code></span>
      <span class="k">epoch</span><span class="v">${escHtml(String(epoch))}</span>
      <span class="k">set size</span><span class="v">${escHtml(String(set))}</span>
      <span class="k">responders</span><span class="v">${escHtml(String(responders))}</span>
      <span class="k">results</span><span class="v">${escHtml(String(results))}</span>
      <span class="k">duration</span><span class="v">${escHtml(String(took))}ms</span>
    </div>
    ${ticketHtml}
  `;
}

// ─── tickets state ────────────────────────────────────────────────────────
function _ticketsBucket(family) {
  const fam = family || "QUERY_TICKET_V1";
  if (!ticketsState.byFamily[fam]) {
    ticketsState.byFamily[fam] = { issued: 0, redeemed: 0, quota: 0 };
  }
  return ticketsState.byFamily[fam];
}

function onTicketIssued(p) {
  const fam = p.family || "QUERY_TICKET_V1";
  const b = _ticketsBucket(fam);
  b.issued += Number(p.count || 0);
  b.issuer = p.issuer_key_id_short || b.issuer;
  b.lastIssuedAt = Date.now();
  ticketsState.recent.unshift({ kind: "ticket_issued", payload: p, ts: Date.now() });
  if (ticketsState.recent.length > 30) ticketsState.recent.pop();
  renderTicketsPanel();
}

function onTicketRedeemed(p) {
  const fam = p.family || "QUERY_TICKET_V1";
  const b = _ticketsBucket(fam);
  if (p.accepted !== false) b.redeemed += 1;
  ticketsState.recent.unshift({ kind: "ticket_redeemed", payload: p, ts: Date.now() });
  if (ticketsState.recent.length > 30) ticketsState.recent.pop();
  renderTicketsPanel();
}

function onEpochRotated(p) {
  dcnetState.lastEpoch = p;
  // Reset tallies on rotation; SPEC §27 has tickets scoped to epoch.
  for (const f in ticketsState.byFamily) {
    ticketsState.byFamily[f].issued = 0;
    ticketsState.byFamily[f].redeemed = 0;
  }
  if (p.query_quota != null) _ticketsBucket("QUERY_TICKET_V1").quota = p.query_quota;
  if (p.receipt_quota != null) _ticketsBucket("RECEIPT_TICKET_V1").quota = p.receipt_quota;
  // Reset receipts tally too — they're per-epoch.
  receiptsState.byProvider.clear();
  receiptsState.total = 0;
  renderTicketsPanel();
  renderReceiptsPanel();
  renderAnonPopover();
}

function wireTicketsPanel() {
  const panel = document.getElementById("tickets-panel");
  const head = document.getElementById("tickets-panel-head");
  const body = document.getElementById("tickets-panel-body");
  if (!panel || !head || !body) return;
  let collapsed = true;
  try {
    const v = localStorage.getItem(TICKETS_LS_KEY);
    if (v === "false") collapsed = false;
  } catch {}
  const apply = () => {
    panel.dataset.collapsed = collapsed ? "true" : "false";
    head.setAttribute("aria-expanded", collapsed ? "false" : "true");
  };
  apply();
  head.addEventListener("click", () => {
    collapsed = !collapsed;
    try { localStorage.setItem(TICKETS_LS_KEY, collapsed ? "true" : "false"); } catch {}
    apply();
  });
  renderTicketsPanel();
}

function renderTicketsPanel() {
  const body = document.getElementById("tickets-panel-body");
  const epochTag = document.getElementById("tickets-panel-epoch");
  if (!body) return;
  const ep = dcnetState.lastEpoch;
  const epochId = ep?.new_epoch_id || ep?.epoch_id;
  if (epochTag) epochTag.textContent = epochId ? `e${String(epochId).slice(0, 8)}` : "—";
  const q = ticketsState.byFamily.QUERY_TICKET_V1 || { issued: 0, redeemed: 0, quota: 0 };
  const r = ticketsState.byFamily.RECEIPT_TICKET_V1 || { issued: 0, redeemed: 0, quota: 0 };
  const anyData = (q.issued + q.redeemed + r.issued + r.redeemed) > 0 || ticketsState.recent.length > 0;
  if (!anyData && !epochId) {
    body.innerHTML = `<div class="tk-empty">no epoch yet. dc-net has not woken up.</div>`;
    return;
  }
  const buildBar = (b) => {
    const avail = Math.max(0, (b.quota || 0) - b.redeemed);
    const used = b.quota ? Math.min(100, Math.round((b.redeemed / b.quota) * 100)) : 0;
    return { avail, used, quota: b.quota || 0 };
  };
  const qb = buildBar(q);
  const rb = buildBar(r);
  body.innerHTML = `
    <div class="tk-stat" data-family="QUERY_TICKET_V1">
      <div class="tk-stat-head"><span>query tickets</span><span class="tk-stat-val">${qb.avail} / ${qb.quota || "—"}</span></div>
      <div class="tk-bar"><div class="tk-bar-fill" style="width:${qb.used}%"></div></div>
    </div>
    <div class="tk-stat" data-family="RECEIPT_TICKET_V1">
      <div class="tk-stat-head"><span>receipt tickets</span><span class="tk-stat-val">${rb.avail} / ${rb.quota || "—"}</span></div>
      <div class="tk-bar"><div class="tk-bar-fill" style="width:${rb.used}%"></div></div>
    </div>
    <div class="tk-list">
      ${ticketsState.recent.length === 0
        ? `<div class="tk-empty">no ticket events yet</div>`
        : ticketsState.recent.slice(0, 10).map(e => {
            const ts = formatEventTs(e.ts);
            const fam = e.payload?.family || "—";
            const cls = e.kind === "ticket_redeemed" ? "kind-ticket_redeemed" : "kind-ticket_issued";
            const act = e.kind === "ticket_redeemed"
              ? (e.payload?.accepted === false ? "rejected" : "redeemed 1")
              : `+${e.payload?.count ?? 0}`;
            return `<div class="tk-row ${cls}"><span class="tk-row-ts">${escHtml(ts)}</span><span class="tk-row-fam">${escHtml(fam)}</span><span class="tk-row-act">${escHtml(act)}</span></div>`;
          }).join("")
      }
    </div>
  `;
  body.querySelectorAll(".tk-stat").forEach(el => {
    el.addEventListener("click", () => {
      const fam = el.dataset.family;
      ticketsState.selected = fam;
      body.querySelectorAll(".tk-stat").forEach(s => s.classList.toggle("selected", s === el));
      renderTicketDetail(fam);
    });
  });
}

function renderTicketDetail(family) {
  const el = document.getElementById("detail");
  if (!el) return;
  const b = ticketsState.byFamily[family] || {};
  const ep = dcnetState.lastEpoch || {};
  const closeBtn = `<button class="ed-close" type="button" aria-label="close" title="close (Esc)">✕</button>`;
  const lastIssued = b.lastIssuedAt ? new Date(b.lastIssuedAt).toLocaleString() : "—";
  el.innerHTML = `
    ${closeBtn}
    <div class="d-title">${escHtml(family)}</div>
    <div class="d-host">epoch ${escHtml(String(ep.new_epoch_id || ep.epoch_id || "—"))}</div>
    <div class="d-grid">
      <span class="k">issued</span><span class="v">${b.issued ?? 0}</span>
      <span class="k">redeemed</span><span class="v">${b.redeemed ?? 0}</span>
      <span class="k">quota</span><span class="v">${b.quota ?? "—"}</span>
      <span class="k">issuer</span><span class="v"><code>${escHtml(b.issuer || "—")}</code></span>
      <span class="k">last issuance</span><span class="v">${escHtml(lastIssued)}</span>
      <span class="k">retention</span><span class="v">epoch-scoped (rotates with epoch_rotated)</span>
    </div>
  `;
  _wireCloseButton(el);
}

// ─── receipts state ───────────────────────────────────────────────────────
function onReceiptSubmitted(p) {
  const pk = p.provider_pubkey_short || "unknown";
  let bucket = receiptsState.byProvider.get(pk);
  if (!bucket) {
    bucket = { classes: new Map(), total: 0, lastTs: 0, deliveries: new Map(), lastClass: null, lastDelivery: null, lastEpoch: null };
    receiptsState.byProvider.set(pk, bucket);
  }
  bucket.total += 1;
  bucket.lastTs = Date.now();
  const cls = p.receipt_class || "unspecified";
  bucket.classes.set(cls, (bucket.classes.get(cls) || 0) + 1);
  bucket.lastClass = cls;
  if (p.delivery) {
    bucket.deliveries.set(p.delivery, (bucket.deliveries.get(p.delivery) || 0) + 1);
    bucket.lastDelivery = p.delivery;
  }
  bucket.lastEpoch = p.epoch_id ?? bucket.lastEpoch;
  receiptsState.total += 1;
  renderReceiptsPanel();
}

function wireReceiptsPanel() {
  const panel = document.getElementById("receipts-panel");
  const head = document.getElementById("receipts-panel-head");
  const body = document.getElementById("receipts-panel-body");
  if (!panel || !head || !body) return;
  let collapsed = true;
  try {
    const v = localStorage.getItem(RECEIPTS_LS_KEY);
    if (v === "false") collapsed = false;
  } catch {}
  const apply = () => {
    panel.dataset.collapsed = collapsed ? "true" : "false";
    head.setAttribute("aria-expanded", collapsed ? "false" : "true");
  };
  apply();
  head.addEventListener("click", () => {
    collapsed = !collapsed;
    try { localStorage.setItem(RECEIPTS_LS_KEY, collapsed ? "true" : "false"); } catch {}
    apply();
  });
  renderReceiptsPanel();
}

function renderReceiptsPanel() {
  const body = document.getElementById("receipts-panel-body");
  const counter = document.getElementById("receipts-panel-count");
  if (!body) return;
  if (counter) counter.textContent = String(receiptsState.total);
  if (receiptsState.byProvider.size === 0) {
    body.innerHTML = `<div class="tk-empty">no receipts yet. they appear when peers serve receipt-eligible results.</div>`;
    return;
  }
  const rows = [...receiptsState.byProvider.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 20)
    .map(([pk, b]) => {
      const color = _providerHue(pk);
      const classBreakdown = [...b.classes.entries()]
        .map(([c, n]) => `${c}=${n}`).join(" · ");
      const score = b.total; // bounded reputation hint
      return `<div class="rc-row" data-pk="${escHtml(pk)}">
        <span class="rc-dot" style="background:${color};box-shadow:0 0 6px ${color}"></span>
        <div class="rc-mid">
          <span class="rc-pk"><code>${escHtml(pk)}</code></span>
          <span class="rc-classes">${escHtml(classBreakdown || "—")}</span>
        </div>
        <span class="rc-score">${score}</span>
      </div>`;
    });
  body.innerHTML = `
    <div class="rc-totals">epoch total: <span class="rc-total-val">${receiptsState.total}</span> receipt${receiptsState.total === 1 ? "" : "s"}</div>
    ${rows.join("")}
  `;
  body.querySelectorAll(".rc-row").forEach(el => {
    el.addEventListener("click", () => {
      const pk = el.dataset.pk;
      body.querySelectorAll(".rc-row").forEach(r => r.classList.toggle("selected", r === el));
      renderProviderDetail(pk);
    });
  });
}

function renderProviderDetail(pk) {
  const el = document.getElementById("detail");
  if (!el) return;
  const b = receiptsState.byProvider.get(pk);
  if (!b) return;
  const closeBtn = `<button class="ed-close" type="button" aria-label="close" title="close (Esc)">✕</button>`;
  const lastTs = b.lastTs ? new Date(b.lastTs).toLocaleString() : "—";
  const peer = [...srwk.peers.values()].find(p =>
    typeof p.pubkey === "string" && p.pubkey.startsWith(pk));
  const fullPk = peer?.pubkey || pk;
  const classes = [...b.classes.entries()].map(([c, n]) => `${c}=${n}`).join(", ");
  el.innerHTML = `
    ${closeBtn}
    <div class="d-title">provider · ${escHtml(pk)}</div>
    <div class="d-host">${escHtml(lastTs)}</div>
    <div class="d-grid">
      <span class="k">pubkey</span><span class="v"><code style="font-size:10px">${escHtml(fullPk)}</code></span>
      <span class="k">total</span><span class="v">${b.total}</span>
      <span class="k">classes</span><span class="v">${escHtml(classes || "—")}</span>
      <span class="k">last delivery</span><span class="v">${escHtml(b.lastDelivery || "—")}</span>
      <span class="k">last epoch</span><span class="v">${escHtml(String(b.lastEpoch ?? "—"))}</span>
      <span class="k">last accepted</span><span class="v">${escHtml(lastTs)}</span>
      <span class="k">service proof</span><span class="v"><code>—</code></span>
    </div>
    <div class="ap-warn" style="margin-top:12px">anonymous receipts are bounded reputation hints, not proof of correctness</div>
  `;
  _wireCloseButton(el);
}

function renderReceiptDetail(p, ts) {
  // formatValue guards every field — receipts have grown new optional
  // structured sub-blocks (verification, policy) that used to render as
  // "[object Object]" before this hardening.
  return `
    <div class="d-title">receipt submitted</div>
    <div class="d-host">${escHtml(ts)}</div>
    <div class="d-grid">
      <span class="k">provider</span><span class="v"><code>${escHtml(formatValue(p.provider_pubkey_short))}</code></span>
      <span class="k">class</span><span class="v">${escHtml(formatValue(p.receipt_class))}</span>
      <span class="k">delivery</span><span class="v">${escHtml(formatValue(p.delivery))}</span>
      <span class="k">epoch</span><span class="v">${escHtml(formatValue(p.epoch_id))}</span>
      ${p.verification != null ? `<span class="k">verification</span><span class="v"><pre style="white-space:pre-wrap;font-family:var(--font-mono);font-size:10.5px;margin:0">${escHtml(JSON.stringify(p.verification, null, 2))}</pre></span>` : ""}
      ${p.policy != null ? `<span class="k">policy</span><span class="v"><pre style="white-space:pre-wrap;font-family:var(--font-mono);font-size:10.5px;margin:0">${escHtml(JSON.stringify(p.policy, null, 2))}</pre></span>` : ""}
    </div>
    <div class="ap-warn" style="margin-top:12px">anonymous receipts are bounded reputation hints, not proof of correctness</div>
  `;
}

// ─── router panel (replaces v0.3 stub) ───────────────────────────────────
function onWebSearchCompleted(p) {
  routerState.recent.unshift({ payload: p, ts: Date.now() });
  if (routerState.recent.length > 50) routerState.recent.pop();
  renderRouterPanel();
}

function wireRouterPanel() {
  const panel = document.getElementById("router-panel");
  const head = document.getElementById("router-panel-head");
  const body = document.getElementById("router-panel-body");
  if (!panel || !head || !body) return;
  let collapsed = true;
  try {
    const v = localStorage.getItem(ROUTER_LS_KEY);
    if (v === "false") collapsed = false;
  } catch {}
  const apply = () => {
    panel.dataset.collapsed = collapsed ? "true" : "false";
    head.setAttribute("aria-expanded", collapsed ? "false" : "true");
  };
  apply();
  head.addEventListener("click", () => {
    collapsed = !collapsed;
    try { localStorage.setItem(ROUTER_LS_KEY, collapsed ? "true" : "false"); } catch {}
    apply();
  });
  renderRouterPanel();
}

function renderRouterPanel() {
  const body = document.getElementById("router-panel-body");
  const counter = document.getElementById("router-panel-count");
  if (!body) return;
  if (counter) counter.textContent = routerState.recent.length ? String(routerState.recent.length) : "v0.3";
  if (routerState.recent.length === 0) {
    body.innerHTML = `<div class="router-empty">the router is quiet. it will speak once SPEC v0.3 ships.</div>`;
    return;
  }
  body.innerHTML = routerState.recent.slice(0, 12).map((e, idx) => {
    const p = e.payload || {};
    const ts = formatEventTs(e.ts);
    const dp = p.delivery_path || "—";
    const pl = p.privacy_level || "none";
    const att = Array.isArray(p.attempts) ? p.attempts : [];
    const dots = att.slice(0, 6).map(a => {
      const ok = a?.outcome === "delivered" || a?.outcome === "ok" || a?.delivered;
      const fail = a?.outcome === "error" || a?.outcome === "failed" || a?.outcome === "policy_denied";
      const cls = ok ? "ok" : fail ? "fail" : "skip";
      return `<span class="rr-dot ${cls}" title="${escHtml(a?.path_kind || a?.kind || "")}"></span>`;
    }).join("");
    const qh = p.query_hmac ? `${String(p.query_hmac).slice(0, 10)}…` : (p.qid ? `${String(p.qid).slice(0, 10)}…` : "—");
    return `<div class="router-row" data-idx="${idx}">
      <span class="rr-ts">${escHtml(ts)}</span>
      <span class="rr-dots">${dots}</span>
      <span class="rr-q"><code>${escHtml(qh)}</code> · ${escHtml(dp)}</span>
      <span class="rr-badge" data-pl="${escHtml(pl)}">${escHtml(pl.replace(/_/g, " "))}</span>
    </div>`;
  }).join("");
  body.querySelectorAll(".router-row").forEach(el => {
    el.addEventListener("click", () => {
      const idx = parseInt(el.dataset.idx, 10);
      const e = routerState.recent[idx];
      if (!e) return;
      body.querySelectorAll(".router-row").forEach(r => r.classList.toggle("selected", r === el));
      const eldetail = document.getElementById("detail");
      if (eldetail) {
        const closeBtn = `<button class="ed-close" type="button" aria-label="close" title="close (Esc)">✕</button>`;
        const ts = new Date(e.ts).toLocaleString();
        eldetail.innerHTML = `${closeBtn}` + renderWebSearchDetail(e.payload, ts);
        _wireCloseButton(eldetail);
      }
    });
  });
}

function renderWebSearchDetail(p, ts) {
  if (!p) p = {};
  const dp = p.delivery_path || "—";
  const pl = p.privacy_level || "none";
  const att = Array.isArray(p.attempts) ? p.attempts : [];
  // Render the attempt chain as a vertical flow. If no attempts, render a
  // synthetic one-step chain (just the delivery_path) so the structure
  // shows even on partial payloads.
  const steps = att.length ? att : [{ path_kind: dp, outcome: "delivered" }];
  const stepHtml = steps.map((a, i) => {
    const name = a?.path_kind || a?.kind || `step ${i + 1}`;
    const out = a?.outcome || (i === steps.length - 1 ? "delivered" : "skip");
    const ok = out === "delivered" || out === "ok";
    const fail = out === "error" || out === "failed" || out === "policy_denied" || out === "rejected";
    const cls = (ok ? "ok " : fail ? "fail " : "skip ") + (name === dp && i === steps.length - 1 ? "delivered" : "");
    const dur = a?.took_ms ?? a?.duration_ms;
    // `reason` and `error` may arrive as objects (e.g. {code, message}); pass
    // them through formatValue so a structured field never produces literal
    // "[object Object]" text in the chain.
    const reason = formatValue(a?.reason || a?.error || "");
    return `<li class="flow-step ${cls}">
      <span class="fs-icon"></span>
      <span><span class="fs-name">${escHtml(formatValue(name))}</span>${reason && reason !== "—" ? `<br><span class="fs-meta">${escHtml(reason)}</span>` : ""}</span>
      <span class="fs-meta">${dur != null ? `${escHtml(String(dur))}ms` : escHtml(formatValue(out))}</span>
    </li>`;
  }).join("");

  const qh = p.query_hmac ? `${String(p.query_hmac).slice(0, 16)}…` : "—";
  const qid = p.qid ? `${String(p.qid).slice(0, 16)}…` : "—";
  const downgrade = p.privacy_downgrade
    ? `<div class="flow-warn">privacy_downgrade=true · this query was reported with a less-private path than originally claimed</div>`
    : "";
  const confirm = p.confirmation_required
    ? `<div class="flow-confirm">confirmation_required · awaiting user approval before egress (${escHtml(formatValue(p.confirmation_reason || "policy gate"))})</div>`
    : "";
  const ticket = p.anonymous_ticket
    ? `<div class="ed-section-title">anonymous ticket</div>
       <div class="d-grid">
         <span class="k">family</span><span class="v">${escHtml(p.anonymous_ticket.family || "—")}</span>
         <span class="k">epoch</span><span class="v">${escHtml(String(p.anonymous_ticket.epoch_id || "—"))}</span>
         <span class="k">scope</span><span class="v">${escHtml(p.anonymous_ticket.scope || "—")}</span>
       </div>` : "";
  const circle = p.active_circle
    ? `<div class="ed-section-title">active circle</div>
       <div class="d-grid">
         <span class="k">circle</span><span class="v"><code>${escHtml(String(p.active_circle.circle_id || "—"))}</code></span>
         <span class="k">members</span><span class="v">${escHtml(String(p.active_circle.active_peer_count ?? "—"))}/${escHtml(String(p.active_circle.min_anonymity_set ?? "—"))}</span>
         <span class="k">transport</span><span class="v">${escHtml(p.active_circle.transport_kind || "—")}</span>
       </div>` : "";

  return `
    <div class="d-title">web_search_completed</div>
    <div class="d-host">${escHtml(ts)} · ${escHtml(dp)}</div>
    ${downgrade}${confirm}
    <div class="d-grid">
      <span class="k">qid</span><span class="v"><code>${escHtml(qid)}</code></span>
      <span class="k">query</span><span class="v"><code>${escHtml(qh)}</code></span>
      <span class="k">privacy</span><span class="v"><span class="rr-badge" data-pl="${escHtml(pl)}">${escHtml(pl.replace(/_/g, " "))}</span></span>
      <span class="k">delivery</span><span class="v">${escHtml(dp)}</span>
    </div>
    <div class="ed-section-title">attempt chain</div>
    <ul class="flow-chain">${stepHtml}</ul>
    ${ticket}${circle}
  `;
}

// ─── wire-style timeline (bottom of graph) ────────────────────────────────
// Per-peer swimlanes spanning the last 60s of traffic. Each event = a tick
// mark, x-positioned by age (newest on right), y-positioned by lane.
// Ring-buffered to ~500 ticks across all lanes.

const TIMELINE_LS_KEY = "srwk:timeline:visible";
const TIMELINE_WINDOW_MS = 60000;
const TIMELINE_MAX_TICKS = 500;
const SYSTEM_LANE_KEY = "__system__";

const timelineState = {
  visible: true,
  buffer: [],            // ring of {ts, kind, pubkey, payload, color, took}
  rafScheduled: false,
  hoveredEvent: null,
};

function wireTimeline() {
  const strip = document.getElementById("timeline-strip");
  const toggle = document.getElementById("timeline-toggle");
  if (!strip || !toggle) return;
  let visible = true;
  try {
    const v = localStorage.getItem(TIMELINE_LS_KEY);
    if (v === "false") visible = false;
  } catch {}
  const apply = () => {
    timelineState.visible = visible;
    strip.setAttribute("aria-hidden", visible ? "false" : "true");
    toggle.setAttribute("aria-pressed", visible ? "true" : "false");
  };
  apply();
  toggle.addEventListener("click", () => {
    visible = !visible;
    try { localStorage.setItem(TIMELINE_LS_KEY, visible ? "true" : "false"); } catch {}
    apply();
    if (visible) scheduleTimelineRender();
  });
  // Render on every animation frame so ticks march left smoothly.
  function tick() {
    if (timelineState.visible) renderTimeline();
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

function pushTimelineTick(evt) {
  const p = evt.payload || {};
  // `slice_scraped` carries `peer` as an object; pickPeerPubkey + pickPeerColor
  // unify all event shapes so the timeline lane key is always a string and
  // never the literal text "[object Object]".
  const pubkey = pickPeerPubkey(p);
  const peer = pubkey ? srwk.peers.get(pubkey) : null;
  let color;
  if (TRAFFIC_DOT[evt.kind] && evt.kind !== "slice_scraped" && evt.kind !== "contribution_merged") {
    color = TRAFFIC_DOT[evt.kind];
  } else if (peer?.signature_color) {
    color = peer.signature_color;
  } else if (pickPeerColor(p)) {
    color = pickPeerColor(p);
  } else if (pubkey) {
    color = stableHue(pubkey);
  } else {
    color = "rgba(220, 232, 255, 0.55)";
  }
  const took = (evt.kind === "slice_scraped")
    ? (p.took_ms ?? p.duration_ms ?? 0)
    : 0;
  timelineState.buffer.push({
    ts: evt.ts || Date.now(),
    kind: evt.kind,
    pubkey: pubkey || SYSTEM_LANE_KEY,
    payload: p,
    color,
    took,
    evt,
  });
  if (timelineState.buffer.length > TIMELINE_MAX_TICKS) {
    timelineState.buffer.splice(0, timelineState.buffer.length - TIMELINE_MAX_TICKS);
  }
  scheduleTimelineRender();
}

function scheduleTimelineRender() {
  if (timelineState.rafScheduled) return;
  timelineState.rafScheduled = true;
  requestAnimationFrame(() => {
    timelineState.rafScheduled = false;
    if (timelineState.visible) renderTimeline();
  });
}

function renderTimeline() {
  const lanesEl = document.getElementById("timeline-lanes");
  const strip = document.getElementById("timeline-strip");
  if (!lanesEl || !strip) return;
  const now = Date.now();
  const cutoff = now - TIMELINE_WINDOW_MS;
  // Drop expired ticks from the ring buffer.
  while (timelineState.buffer.length && timelineState.buffer[0].ts < cutoff) {
    timelineState.buffer.shift();
  }
  // Compute active lanes (peers with at least one tick in window, +
  // a system lane if any system event is present).
  const laneSet = new Map();      // key → label
  let hasSystem = false;
  for (const t of timelineState.buffer) {
    if (t.pubkey === SYSTEM_LANE_KEY) { hasSystem = true; continue; }
    if (!laneSet.has(t.pubkey)) {
      const peer = srwk.peers.get(t.pubkey);
      const label = peer?.nickname || `peer-${String(t.pubkey).slice(0, 6)}`;
      laneSet.set(t.pubkey, label);
    }
  }
  const peerLanes = [...laneSet.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  if (hasSystem) peerLanes.push([SYSTEM_LANE_KEY, "system"]);
  const laneCount = Math.max(1, peerLanes.length);
  const stripH = strip.clientHeight || 80;
  const stripW = strip.clientWidth || 800;
  const padTop = 6, padBot = 6;
  const usable = stripH - padTop - padBot;
  const laneStep = usable / laneCount;
  // Fast clear; with ≤500 nodes this is cheap.
  lanesEl.innerHTML = "";
  // Lane labels + rules
  peerLanes.forEach(([key, label], i) => {
    const y = padTop + laneStep * (i + 0.5);
    const ruler = document.createElement("div");
    ruler.className = "timeline-lane-rule";
    ruler.style.top = `${padTop + laneStep * (i + 1)}px`;
    if (i < peerLanes.length - 1) lanesEl.appendChild(ruler);
    const labelEl = document.createElement("div");
    labelEl.className = "timeline-lane-label";
    labelEl.textContent = label;
    labelEl.style.top = `${y}px`;
    lanesEl.appendChild(labelEl);
  });
  // Map peer key → lane index for tick placement.
  const laneIndex = new Map();
  peerLanes.forEach(([key], i) => laneIndex.set(key, i));
  const labelGutter = 96;
  const usableW = Math.max(40, stripW - labelGutter - 8);
  for (const t of timelineState.buffer) {
    const lane = laneIndex.get(t.pubkey);
    if (lane == null) continue;
    const ageFrac = (now - t.ts) / TIMELINE_WINDOW_MS;  // 0 = now, 1 = oldest
    const x = labelGutter + usableW * (1 - ageFrac);
    const y = padTop + laneStep * (lane + 0.5);
    const tick = document.createElement("div");
    tick.className = `timeline-tick kind-${t.kind}`;
    tick.style.left = `${x}px`;
    tick.style.top = `${y}px`;
    tick.style.background = t.color;
    tick.style.boxShadow = `0 0 8px ${t.color}`;
    // Width: log-scaled by took_ms for slice_scraped (4-22px); fixed 4 otherwise.
    let w = 4;
    if (t.kind === "slice_scraped" && t.took > 0) {
      w = Math.max(4, Math.min(22, 4 + Math.log10(t.took) * 7));
    } else if (t.kind === "contribution_merged") {
      w = 5;
    }
    tick.style.width = `${w}px`;
    // Fade ticks as they march toward the left edge.
    tick.style.opacity = `${(1 - ageFrac * 0.85).toFixed(3)}`;
    tick.dataset.ts = String(t.ts);
    tick.addEventListener("mouseenter", (e) => showTimelineTooltip(t, e.target));
    tick.addEventListener("mouseleave", hideTimelineTooltip);
    tick.addEventListener("click", () => {
      hideTimelineTooltip();
      // Surface the event in the .detail pane via the same pathway as a
      // traffic-row click. This treats traffic + ingest events uniformly.
      if (t.kind === "contribution_merged") {
        // Reuse the events-panel detail renderer.
        renderEventDetail(t.evt);
        // Clear traffic selection if any.
        for (const sib of document.querySelectorAll("#traffic-panel-list .events-row.selected")) {
          sib.classList.remove("selected");
        }
      } else {
        renderTrafficDetail(t.evt);
      }
    });
    lanesEl.appendChild(tick);
  }
}

function showTimelineTooltip(tick, el) {
  const tip = document.getElementById("timeline-tooltip");
  if (!tip) return;
  const peer = srwk.peers.get(tick.pubkey);
  const nick = peer?.nickname || (tick.pubkey === SYSTEM_LANE_KEY ? "system" : `peer-${String(tick.pubkey).slice(0, 6)}`);
  const ts = formatEventTs(tick.ts);
  tip.innerHTML =
    `<span class="tt-kind">${escHtml(tick.kind)}</span> ` +
    `· <span class="tt-peer">${escHtml(nick)}</span>` +
    `<span class="tt-ts">${escHtml(ts)}</span>`;
  tip.hidden = false;
  // Position above the tick.
  const stripRect = document.getElementById("timeline-strip").getBoundingClientRect();
  const tickRect = el.getBoundingClientRect();
  const xRel = tickRect.left + tickRect.width / 2 - stripRect.left;
  tip.style.left = `${Math.round(xRel)}px`;
}

function hideTimelineTooltip() {
  const tip = document.getElementById("timeline-tooltip");
  if (!tip) return;
  tip.hidden = true;
}

// ─── live propagation mini-graph (Network tab) ───────────────────────────
// Self-contained 2D canvas force-graph showing peers as nodes and animating
// pulses along edges as SSE events flow in. Self node sits in the center,
// peers arrange in a circle around it. This is intentionally vanilla canvas
// — the 3d-force-graph bundle is heavy enough that pulling in another
// graph lib for a 280px panel is bad ROI.
//
// State:
//   livegraphState.pulses    — FIFO queue, capped at LIVEGRAPH_MAX_PULSES
//   livegraphState.mode      — "live" | "replay" — replay reads
//                              trafficState ring + timelineState.buffer and
//                              re-emits edges over LIVEGRAPH_REPLAY_MS.
//   livegraphState.layout    — Map<pubkey, {x, y, ang}>
//
// Dispatch is glued in via a one-line call from the SSE traffic handler in
// subscribeEvents (see `livegraphPushFromEvent`), so adding a new event
// kind to the propagation graph is a single switch-case here.

const LIVEGRAPH_MAX_PULSES = 50;
const LIVEGRAPH_PULSE_DURATION = 850;     // ms — feels alive but not laggy
const LIVEGRAPH_REPLAY_MS = 10000;        // 60s of traffic → 10s replay
const LIVEGRAPH_REPLAY_WINDOW = 60000;    // how far back to replay

const LIVEGRAPH_PULSE_KIND = {
  // dir: "in" → peer→self · "out" → self→peer · "ext" → self→external
  slice_scraped:        { color: "#5CFFAB", dir: "in"  }, // soft green
  contribution_merged:  { color: "#9DFFD8", dir: "in"  }, // bright green
  ingest_arrived:       { color: "#9DFFD8", dir: "in"  },
  ingest_merged:        { color: "#9DFFD8", dir: "in"  },
  slice_scrape_error:   { color: "#FF7BD0", dir: "in"  }, // red/pink
  web_search_completed: { color: "#FFB35C", dir: "out" }, // orange
  web_search_requested: { color: "#FFB35C", dir: "out" },
  page_visited:         { color: "#FFE26B", dir: "out" }, // amber
};

const livegraphState = {
  canvas: null,
  ctx: null,
  tooltip: null,
  empty: null,
  pulses: [],                         // {fromKey,toKey,color,start,duration,ext?,opaqueAt?}
  layout: new Map(),                  // pubkey → {x,y,ang} (logical coords)
  selfPing: 0,                        // performance.now() of last self ping
  peerPings: new Map(),               // pubkey → performance.now() (mdns_discovered)
  mode: "live",
  rafId: 0,
  visible: false,                     // canvas in active tab
  hoveredKey: null,
  replayTokens: [],                   // [{atMs, fn}] — pending replay enqueues
  replayStartedAt: 0,
};

function wireLiveGraph() {
  const canvas = document.getElementById("livegraph-canvas");
  if (!canvas) return;
  livegraphState.canvas = canvas;
  livegraphState.ctx = canvas.getContext("2d");
  livegraphState.tooltip = document.getElementById("livegraph-tooltip");
  livegraphState.empty = document.getElementById("livegraph-empty");
  // Mode toggle
  const head = document.querySelector("#livegraph-panel .livegraph-mode");
  if (head) {
    head.addEventListener("click", (e) => {
      const btn = e.target.closest(".livegraph-mode-btn");
      if (!btn) return;
      const m = btn.dataset.mode;
      if (m !== "live" && m !== "replay") return;
      setLiveGraphMode(m);
    });
  }
  // Hover for tooltip — translate canvas coords back to nearest peer.
  canvas.addEventListener("mousemove", onLiveGraphMove);
  canvas.addEventListener("mouseleave", () => {
    livegraphState.hoveredKey = null;
    if (livegraphState.tooltip) livegraphState.tooltip.hidden = true;
  });
  // Resize observer keeps the canvas backing store in sync with CSS size.
  const ro = new ResizeObserver(() => resizeLiveGraph());
  ro.observe(canvas.parentElement || canvas);
  resizeLiveGraph();
  // Steady tick — runs always (cheap when no pulses); the visibility-aware
  // skip is built into the draw fn.
  const loop = () => {
    drawLiveGraph(performance.now());
    livegraphState.rafId = requestAnimationFrame(loop);
  };
  livegraphState.rafId = requestAnimationFrame(loop);
}

function resizeLiveGraph() {
  const c = livegraphState.canvas;
  if (!c) return;
  const rect = c.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  c.width = Math.max(1, Math.round(rect.width * dpr));
  c.height = Math.max(1, Math.round(rect.height * dpr));
  livegraphState.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  recomputeLayout();
}

function setLiveGraphMode(mode) {
  livegraphState.mode = mode;
  const head = document.querySelector("#livegraph-panel .livegraph-mode");
  if (head) {
    for (const b of head.querySelectorAll(".livegraph-mode-btn")) {
      b.classList.toggle("selected", b.dataset.mode === mode);
    }
  }
  if (mode === "replay") startLiveGraphReplay();
}

function recomputeLayout() {
  const c = livegraphState.canvas;
  if (!c) return;
  const rect = c.getBoundingClientRect();
  const w = rect.width, h = rect.height;
  const cx = w / 2, cy = h / 2;
  const r = Math.max(40, Math.min(cx, cy) - 36);
  const peers = [...srwk.peers.values()].filter(p => p.pubkey);
  // Self always at the center; ranking other peers by stable hash → angle
  // makes the arrangement feel deterministic even as peers come and go.
  livegraphState.layout.clear();
  livegraphState.layout.set("__self__", { x: cx, y: cy, ang: 0, isSelf: true });
  const others = peers.filter(p => p.pubkey !== srwk.selfPubkey);
  const n = Math.max(1, others.length);
  others.forEach((p, i) => {
    const ang = (i / n) * Math.PI * 2 - Math.PI / 2;
    livegraphState.layout.set(p.pubkey, {
      x: cx + Math.cos(ang) * r,
      y: cy + Math.sin(ang) * r,
      ang,
    });
  });
}

function livegraphPushFromEvent(evt) {
  const kind = evt?.kind;
  if (!kind) return;
  // ingest_* alias for any ingest-named event we don't know about specifically
  const cfg = LIVEGRAPH_PULSE_KIND[kind] || (kind.startsWith("ingest_") ? LIVEGRAPH_PULSE_KIND.ingest_arrived : null);
  if (!cfg) {
    // mdns_discovered → enlarge the peer node briefly. No pulse.
    if (kind === "mdns_discovered" || kind === "peer_joined") {
      const p = evt.payload || {};
      const pubkey = pickPeerPubkey(p);
      if (pubkey) livegraphState.peerPings.set(pubkey, performance.now());
      // Recompute layout in case this is a brand new peer
      recomputeLayout();
    }
    return;
  }
  const p = evt.payload || {};
  const pubkey = pickPeerPubkey(p);
  let fromKey, toKey, ext = false;
  if (cfg.dir === "in") {
    fromKey = pubkey || null;
    toKey = "__self__";
  } else if (cfg.dir === "out") {
    fromKey = "__self__";
    toKey = pubkey || null;
    if (!toKey) ext = true;
  } else {
    fromKey = "__self__"; toKey = pubkey || null;
  }
  if (!fromKey || (!toKey && !ext)) return;
  const pulse = {
    fromKey, toKey, ext,
    color: cfg.color,
    start: performance.now(),
    duration: LIVEGRAPH_PULSE_DURATION,
    kind,
  };
  livegraphState.pulses.push(pulse);
  // FIFO drop oldest if we exceed the cap — keeps frame budget bounded
  // when ingest bursts produce dozens of events per second.
  if (livegraphState.pulses.length > LIVEGRAPH_MAX_PULSES) {
    livegraphState.pulses.splice(0, livegraphState.pulses.length - LIVEGRAPH_MAX_PULSES);
  }
  if (cfg.dir === "in") livegraphState.selfPing = performance.now();
  if (cfg.dir === "out" && pubkey) livegraphState.peerPings.set(pubkey, performance.now());
}

function startLiveGraphReplay() {
  // Walk the timeline ring buffer + traffic ring; clear current pulses;
  // re-enqueue them spread across LIVEGRAPH_REPLAY_MS. The animation loop
  // doesn't care about wall-clock — it just consumes pulses as they're
  // pushed.
  const now = Date.now();
  const cutoff = now - LIVEGRAPH_REPLAY_WINDOW;
  const buffer = (timelineState && Array.isArray(timelineState.buffer)) ? timelineState.buffer : [];
  const events = buffer.filter(t => t && t.ts >= cutoff && t.evt).map(t => t.evt);
  livegraphState.pulses = [];
  livegraphState.replayStartedAt = performance.now();
  if (events.length === 0) return;
  const span = Math.max(0, (events[events.length - 1].ts || now) - (events[0].ts || cutoff)) || 1;
  const replayStart = performance.now();
  events.forEach((evt) => {
    const frac = ((evt.ts || cutoff) - (events[0].ts || cutoff)) / span;
    const at = replayStart + frac * LIVEGRAPH_REPLAY_MS;
    setTimeout(() => {
      if (livegraphState.mode !== "replay") return;
      livegraphPushFromEvent(evt);
    }, Math.max(0, at - performance.now()));
  });
}

function onLiveGraphMove(e) {
  const c = livegraphState.canvas;
  if (!c) return;
  const rect = c.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  let bestKey = null, bestDist = 18 * 18; // 18px hit radius
  for (const [key, pos] of livegraphState.layout) {
    if (key === "__self__") continue;
    const dx = pos.x - x, dy = pos.y - y;
    const d = dx * dx + dy * dy;
    if (d < bestDist) { bestDist = d; bestKey = key; }
  }
  // Self has a slightly bigger hit area
  const selfPos = livegraphState.layout.get("__self__");
  if (selfPos) {
    const dx = selfPos.x - x, dy = selfPos.y - y;
    if (dx * dx + dy * dy < 22 * 22) bestKey = "__self__";
  }
  livegraphState.hoveredKey = bestKey;
  const tip = livegraphState.tooltip;
  if (!tip) return;
  if (!bestKey) { tip.hidden = true; return; }
  if (bestKey === "__self__") {
    tip.hidden = false;
    tip.textContent = `self · ${(srwk.selfPubkey || "—").slice(0, 14)}…`;
  } else {
    const peer = srwk.peers.get(bestKey);
    const nick = peer?.nickname || `peer-${bestKey.slice(0, 8)}`;
    const pkShort = `${bestKey.slice(0, 14)}…${bestKey.slice(-6)}`;
    tip.hidden = false;
    tip.textContent = `${nick} · ${pkShort}`;
  }
}

function drawLiveGraph(now) {
  const ctx = livegraphState.ctx;
  const c = livegraphState.canvas;
  if (!ctx || !c) return;
  // Cheap visibility skip — when canvas is offscreen (graph tab) we still
  // tick but skip the draw. The pulses still age and expire so the queue
  // stays bounded.
  const rect = c.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    // Still age pulses
    livegraphState.pulses = livegraphState.pulses.filter(p => now - p.start < p.duration);
    return;
  }
  if (!livegraphState.layout.size || livegraphState.layout.size === 1) {
    recomputeLayout();
  }
  const w = rect.width, h = rect.height;
  ctx.clearRect(0, 0, w, h);

  // Empty state: 0 peers besides self
  const peerCount = livegraphState.layout.size - 1;
  if (livegraphState.empty) {
    livegraphState.empty.style.display = peerCount === 0 ? "" : "none";
  }

  // Faint connecting lines (peer ↔ self)
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(180, 200, 255, 0.10)";
  const selfPos = livegraphState.layout.get("__self__");
  if (selfPos) {
    for (const [key, pos] of livegraphState.layout) {
      if (key === "__self__") continue;
      ctx.beginPath();
      ctx.moveTo(selfPos.x, selfPos.y);
      ctx.lineTo(pos.x, pos.y);
      ctx.stroke();
    }
  }

  // Pulses: drop expired, draw the rest as moving discs along the edge.
  const livePulses = [];
  for (const pul of livegraphState.pulses) {
    const t = (now - pul.start) / pul.duration;
    if (t >= 1) continue;
    livePulses.push(pul);
    const fromPos = livegraphState.layout.get(pul.fromKey);
    let toPos = livegraphState.layout.get(pul.toKey);
    if (!fromPos) continue;
    if (!toPos && pul.ext) {
      // External destination — synthesize a point off the canvas edge along
      // a fixed direction so self→external pulses still read.
      toPos = { x: w - 12, y: 12 };
    }
    if (!toPos) continue;
    const x = fromPos.x + (toPos.x - fromPos.x) * t;
    const y = fromPos.y + (toPos.y - fromPos.y) * t;
    // Trail: short faded segment behind the head
    ctx.strokeStyle = pul.color;
    ctx.lineWidth = 2.5;
    ctx.globalAlpha = 0.55 * (1 - t);
    ctx.beginPath();
    const trailT = Math.max(0, t - 0.18);
    ctx.moveTo(fromPos.x + (toPos.x - fromPos.x) * trailT, fromPos.y + (toPos.y - fromPos.y) * trailT);
    ctx.lineTo(x, y);
    ctx.stroke();
    // Head dot
    ctx.globalAlpha = 1.0;
    ctx.fillStyle = pul.color;
    ctx.shadowColor = pul.color;
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }
  livegraphState.pulses = livePulses;

  // Peer nodes
  for (const [key, pos] of livegraphState.layout) {
    const isSelf = key === "__self__";
    let baseR = isSelf ? 9 : 6;
    let color;
    if (isSelf) {
      color = "#FFFFFF";
      // Briefly brighten self when an "in" pulse just arrived
      const pingDt = now - livegraphState.selfPing;
      if (pingDt < 600) baseR += 3 * (1 - pingDt / 600);
    } else {
      const peer = srwk.peers.get(key);
      color = peer?.signature_color || stableHue(key);
      const pingTs = livegraphState.peerPings.get(key);
      if (pingTs && now - pingTs < 800) {
        const f = 1 - (now - pingTs) / 800;
        baseR += 3 * f;
      }
    }
    // Hover halo
    if (livegraphState.hoveredKey === key) baseR += 1.5;
    // Outer glow ring on self
    if (isSelf) {
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, baseR + 6, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = isSelf ? 14 : 10;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, baseR, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  // Counter (non-canvas) — gentle update; the only DOM write per frame
  const counter = document.getElementById("livegraph-count");
  if (counter) {
    const txt = String(peerCount);
    if (counter.textContent !== txt) counter.textContent = txt;
  }
}

// ─── peer-row selection (camera fly + territory pulse) ──────────────────
// Clicking a peer row in the peers panel flies the camera to that peer's
// territory and pulses their nodes' halos for ~2s. Reuses the same
// camera-fly API as onNodeClick so the motion feels uniform.

function _peerCentroid(pubkey) {
  // Prefer the macro anchor (every node has _macroX/Y/Z assigned at
  // computeHierarchicalAnchors). Fall back to live position centroid if
  // anchors aren't yet computed (e.g. first frame).
  let ax = 0, ay = 0, az = 0, n = 0;
  let hasAnchor = false;
  for (const node of srwk.nodes) {
    if (node.primary_contributor !== pubkey) continue;
    if (node._macroX != null) {
      // All nodes for this peer share the same macro anchor; one
      // sample is enough.
      return { x: node._macroX, y: node._macroY, z: node._macroZ, hasAnchor: true };
    }
    if (node.x == null) continue;
    ax += node.x; ay += node.y; az += node.z; n++;
  }
  if (n === 0) return null;
  return { x: ax / n, y: ay / n, z: az / n, hasAnchor };
}

function selectPeerRow(row, peer) {
  const list = document.getElementById("peers-panel-list");
  if (list) {
    for (const sib of list.querySelectorAll(".peer-row.selected")) {
      sib.classList.remove("selected");
    }
  }
  row.classList.add("selected");
  flyToPeerTerritory(peer.pubkey);
}

function flyToPeerTerritory(pubkey) {
  if (!pubkey || !srwk.G) return;
  const c = _peerCentroid(pubkey);
  if (!c) return;
  // Place the camera slightly outside the centroid, looking at it. Same
  // recipe used in onNodeClick.
  const len = Math.hypot(c.x, c.y, c.z) || 1;
  const offset = 320;
  const r = 1 + offset / len;
  srwk.G.cameraPosition(
    { x: c.x * r, y: c.y * r, z: c.z * r },
    { x: c.x, y: c.y, z: c.z },
    1100,
  );
  // Trigger a 2s territory pulse for this peer's nodes; updateNodeRender
  // reads srwk.peerPulse each frame and lerps halo scale up/down.
  srwk.peerPulse = {
    contributor: pubkey,
    start: performance.now(),
    duration: 2000,
  };
}

// ─── search wiring ────────────────────────────────────────────────────────
// Substring filter against title + host + url. Match → keep color, halo
// boost; non-match → opacity drop. Edges + cluster labels dim too. Cmd/Ctrl-F
// focuses; Esc clears. Counter chip shows "N/total" and cycles matches.

const SEARCH_DEBOUNCE_MS = 150;

function wireSearch() {
  const input = document.getElementById("search");
  const counter = document.getElementById("search-counter");
  if (!input) return;
  srwk.search = {
    active: false,
    query: "",
    matchSet: new Set(),
    matchOrder: [],     // ordered list of matching node ids
    cycleIdx: -1,
    debounceTimer: null,
  };
  const apply = () => applySearch(input.value);
  input.addEventListener("input", () => {
    if (srwk.search.debounceTimer) clearTimeout(srwk.search.debounceTimer);
    srwk.search.debounceTimer = setTimeout(apply, SEARCH_DEBOUNCE_MS);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      input.value = "";
      applySearch("");
      input.blur();
    }
    if (e.key === "Enter" && srwk.search.active && srwk.search.matchOrder.length) {
      e.preventDefault();
      cycleToNextMatch();
    }
  });
  if (counter) {
    counter.addEventListener("click", () => {
      if (!srwk.search.matchOrder.length) return;
      cycleToNextMatch();
    });
  }
  // Global keyboard: Cmd/Ctrl+F focuses. Don't fight when user is in
  // another editable element (we have only the search input today, but
  // future editable surfaces should still take focus precedence).
  document.addEventListener("keydown", (e) => {
    const isModF = (e.metaKey || e.ctrlKey) && (e.key === "f" || e.key === "F");
    if (!isModF) return;
    e.preventDefault();
    input.focus();
    input.select();
  });
  // Esc anywhere on the page clears search if the input has a value.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (srwk.search.active) {
      input.value = "";
      applySearch("");
    }
  });
}

function applySearch(rawQuery) {
  const q = (rawQuery || "").trim().toLowerCase();
  const counter = document.getElementById("search-counter");
  if (!q) {
    srwk.search.active = false;
    srwk.search.query = "";
    srwk.search.matchSet = new Set();
    srwk.search.matchOrder = [];
    srwk.search.cycleIdx = -1;
    if (counter) counter.hidden = true;
    applyEdgeAndLabelDimming();
    return;
  }
  const matches = new Set();
  const order = [];
  for (const n of srwk.nodes) {
    const hay = `${n.title || ""} ${n.host || ""} ${n.id || ""}`.toLowerCase();
    if (hay.includes(q)) {
      matches.add(n.id);
      order.push(n.id);
    }
  }
  srwk.search.active = true;
  srwk.search.query = q;
  srwk.search.matchSet = matches;
  srwk.search.matchOrder = order;
  srwk.search.cycleIdx = -1;
  if (counter) {
    counter.hidden = false;
    counter.textContent = `${order.length} / ${srwk.nodes.length}`;
    counter.classList.toggle("zero", order.length === 0);
  }
  applyEdgeAndLabelDimming();
}

function applyEdgeAndLabelDimming() {
  const G = srwk.G;
  const search = srwk.search;
  // Re-install the search-aware link color callback. 3d-force-graph
  // re-evaluates per-link colors when an accessor is set, so this is
  // how we get edges to refresh. searchAwareLinkColor returns the
  // unmodified base when search is inactive.
  if (G && typeof G.linkColor === "function") {
    G.linkColor((l) => searchAwareLinkColor(l));
  }
  // Labels: dim non-match cluster labels. We compare the cluster's
  // groupKey to whether any matched node belongs to that group.
  const labelMap = srwk.labelMap;
  if (labelMap) {
    let matchGroups = null;
    if (search.active) {
      matchGroups = new Set();
      for (const n of srwk.nodes) {
        if (!search.matchSet.has(n.id)) continue;
        const k = srwk.lens.groupBy(n);
        if (k) matchGroups.add(k);
      }
    }
    for (const [key, sprite] of labelMap) {
      // labels.js fadeLabelsByDistance overrides opacity each frame, so
      // we encode the search dim factor into a userData multiplier and
      // wrap the fade logic. Simpler: just stash a flag, applied below
      // via a frame hook injected in boot's tick.
      sprite.userData._searchDim = matchGroups ? !matchGroups.has(key) : false;
    }
  }
}

function searchAwareLinkColor(l) {
  const base = _linkColor(l);
  const search = srwk.search;
  const sourceFilter = srwk.sourceFilter;
  const searchActive = search && search.active;
  const sourceActive = sourceFilter && sourceFilter.mode !== "all";
  if (!searchActive && !sourceActive) return base;
  const sId = typeof l.source === "object" ? l.source.id : l.source;
  const tId = typeof l.target === "object" ? l.target.id : l.target;
  // A link is "kept" iff its endpoints satisfy BOTH active filters.
  // (When only one filter is active, the other contributes "true" by
  // default — see sourceFilterMatches.)
  const keepBySearch = !searchActive
    || search.matchSet.has(sId) || search.matchSet.has(tId);
  const keepBySource = !sourceActive
    || sourceFilterMatches(sId) || sourceFilterMatches(tId);
  if (keepBySearch && keepBySource) return base;
  if (base.startsWith("rgba(")) return base.replace(/,\s*[0-9.]+\)$/, ", 0.04)");
  if (base.startsWith("rgb("))  return base.replace(/^rgb\(/, "rgba(").replace(/\)$/, ", 0.04)");
  return base;
}

// ─── Issue #43 PR D: source filter (All / Mine / per-peer) ──────────
//
// Source filter is parallel to the search filter: a node passes only
// when BOTH filters keep it. Default state is `mode: "all"` (no-op).
// `mode: "mine"` keeps nodes where `is_self === true` (or, on legacy
// graphs without is_self, where source_pubkey === selfPubkey).
// `mode: "<pubkey>"` keeps nodes from that peer.

function ensureSourceFilterState() {
  if (srwk.sourceFilter) return srwk.sourceFilter;
  srwk.sourceFilter = { mode: "all" };
  return srwk.sourceFilter;
}

function sourceFilterMatches(idOrNode) {
  const sf = srwk.sourceFilter;
  if (!sf || sf.mode === "all") return true;
  const n = (typeof idOrNode === "string")
    ? srwk.nodeMap?.get(idOrNode)
    : idOrNode;
  if (!n) return false;
  if (sf.mode === "mine") {
    if (typeof n.is_self === "boolean") return n.is_self;
    return n.source_pubkey === srwk.selfPubkey ||
           n.primary_contributor === srwk.selfPubkey;
  }
  // mode is a pubkey — match either source_pubkey or primary_contributor.
  return n.source_pubkey === sf.mode || n.primary_contributor === sf.mode;
}

function wireSourceFilter() {
  ensureSourceFilterState();
  const bar = document.getElementById("source-filter-bar");
  if (!bar) return;
  bar.addEventListener("click", (e) => {
    const btn = e.target.closest(".source-chip");
    if (!btn) return;
    const mode = btn.dataset.source || "all";
    setSourceFilter(mode);
  });
  // Render per-peer chips whenever the peers map changes. Cheap; we
  // call this on the same triggers that drive renderPeersPanel.
  renderSourceFilterChips();
}

function renderSourceFilterChips() {
  const bar = document.getElementById("source-filter-bar");
  if (!bar) return;
  // Drop existing per-peer chips (those past the static "all" + "mine").
  const fixed = bar.querySelectorAll(
    '.source-chip[data-source="all"], .source-chip[data-source="mine"]'
  );
  bar.innerHTML = "";
  fixed.forEach((b) => bar.appendChild(b));
  const peers = (srwk.peers && [...srwk.peers.values()]) || [];
  if (!peers.length) return;
  // Per-peer page counts from the live node set so chips don't show
  // peers with zero pages we've ingested yet.
  const counts = new Map();
  for (const n of (srwk.nodes || [])) {
    const pk = n.source_pubkey || n.primary_contributor;
    if (!pk) continue;
    counts.set(pk, (counts.get(pk) || 0) + 1);
  }
  // Sort: page count desc, then nickname.
  peers.sort((a, b) => {
    if (a.pubkey === srwk.selfPubkey) return -1;  // hide via filter below
    if (b.pubkey === srwk.selfPubkey) return 1;
    const ac = counts.get(a.pubkey) || 0;
    const bc = counts.get(b.pubkey) || 0;
    if (ac !== bc) return bc - ac;
    return (a.nickname || "").localeCompare(b.nickname || "");
  });
  for (const p of peers) {
    if (p.pubkey === srwk.selfPubkey) continue;  // "mine" covers self
    if (!counts.get(p.pubkey)) continue;          // skip empty peers
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "source-chip";
    btn.dataset.source = p.pubkey;
    btn.title = `${p.nickname || p.pubkey.slice(0, 12)}: ${counts.get(p.pubkey)} pages`;
    const dot = document.createElement("span");
    dot.className = "sc-dot";
    dot.style.color = p.signature_color || stableHue(p.pubkey);
    dot.style.background = p.signature_color || stableHue(p.pubkey);
    btn.appendChild(dot);
    btn.appendChild(document.createTextNode(
      (p.nickname || p.pubkey.slice(0, 8)).slice(0, 12)
    ));
    if (srwk.sourceFilter && srwk.sourceFilter.mode === p.pubkey) {
      btn.classList.add("selected");
    }
    bar.appendChild(btn);
  }
}

function setSourceFilter(mode) {
  ensureSourceFilterState();
  srwk.sourceFilter.mode = mode;
  // Reflect selection in the UI.
  const bar = document.getElementById("source-filter-bar");
  if (bar) {
    bar.querySelectorAll(".source-chip").forEach((b) => {
      b.classList.toggle("selected", b.dataset.source === mode);
    });
  }
  // Re-run the dimming pass so non-matching nodes/edges fade out.
  applyEdgeAndLabelDimming();
}

function cycleToNextMatch() {
  const order = srwk.search.matchOrder;
  if (!order.length || !srwk.G) return;
  srwk.search.cycleIdx = (srwk.search.cycleIdx + 1) % order.length;
  const id = order[srwk.search.cycleIdx];
  const n = srwk.nodeMap.get(id);
  if (!n || n.x == null) return;
  const len = Math.hypot(n.x, n.y, n.z) || 1;
  const r = 1 + 90 / len;
  srwk.G.cameraPosition({ x: n.x * r, y: n.y * r, z: n.z * r }, n, 900);
  const counter = document.getElementById("search-counter");
  if (counter) {
    counter.textContent = `${srwk.search.cycleIdx + 1} / ${order.length}`;
  }
}

// Hook into the per-frame label fade pass: if a label was tagged
// _searchDim, multiply its computed opacity by 0.18. Keeps labels.js
// blissfully unaware of search.
const _labelFadeOrig = fadeLabelsByDistance;
function fadeLabelsWithSearch(camera, labelMap) {
  _labelFadeOrig(camera, labelMap);
  if (!srwk.search || !srwk.search.active) return;
  for (const sprite of labelMap.values()) {
    if (sprite.userData?._searchDim) {
      sprite.material.opacity *= 0.18;
    }
  }
}
// Replace the global handle used by tick() to point at our wrapped fn.
// (boot's tick imports fadeLabelsByDistance directly, so we install a
// shim by overriding srwk's tick path: re-bind at the call site.)
srwk._fadeLabels = fadeLabelsWithSearch;

// ─── timeline auto-show on first traffic event ───────────────────────────
// First traffic SSE event after boot auto-shows the timeline, but only
// if the user has never explicitly toggled it (LS key absent). Also
// fades a one-time toast above the toggle so people know what just
// appeared.

const TIMELINE_TOAST_KEY = "srwk:timeline:autoshown";

function maybeAutoShowTimeline() {
  if (srwk._timelineAutoShown) return;
  srwk._timelineAutoShown = true;
  let pref = null;
  try { pref = localStorage.getItem(TIMELINE_LS_KEY); } catch {}
  // Already explicitly set (true or false) → respect it. Only auto-show
  // when the user has never expressed a preference.
  if (pref === "true" || pref === "false") return;
  const strip = document.getElementById("timeline-strip");
  const toggle = document.getElementById("timeline-toggle");
  if (!strip || !toggle) return;
  timelineState.visible = true;
  strip.setAttribute("aria-hidden", "false");
  toggle.setAttribute("aria-pressed", "true");
  try { localStorage.setItem(TIMELINE_LS_KEY, "true"); } catch {}
  showTimelineAutoToast();
}

function showTimelineAutoToast() {
  const toast = document.getElementById("timeline-toast");
  if (!toast) return;
  toast.innerHTML = `<span class="tt-dot"></span>live LAN traffic<span class="tt-arrow"></span>`;
  toast.hidden = false;
  toast.classList.remove("fade");
  setTimeout(() => toast.classList.add("fade"), 4000);
  setTimeout(() => { toast.hidden = true; toast.classList.remove("fade"); }, 4800);
}

// ─── tab bar (atlas | alchemy | network | metrics) ─────────
// ATLAS is the primary tab — the production wall map of the corpus, with
// the network search input embedded in it (search is no longer its own
// top-level tab as of 2026-05-09). The three legacy renderers (graph /
// cartography / cosmos) and the EXPERIMENTAL tab were archived; see
// _archive/experimental/.
const TAB_LS_KEY = "srwk:active_tab";
const NET_SUB_LS_KEY = "srwk:network_sub";
const TOP_TABS = new Set(["alchemy", "atlas", "network"]);
const NET_SUBS = new Set(["network", "metrics"]);
// Legacy values older builds wrote to localStorage. Quietly migrate.
function migrateLegacyTab(t) {
  if (t === "graph" || t === "cartography" || t === "cosmos" || t === "experimental") return "atlas";
  if (t === "search") return "atlas";  // search is now a panel inside atlas
  // Metrics moved into the network tab as a sub-view (2026-05-09).
  // Land the user back in the right place + remember the sub-tab.
  if (t === "metrics") {
    try { localStorage.setItem(NET_SUB_LS_KEY, "metrics"); } catch {}
    return "network";
  }
  return null;
}

function wireTabs() {
  const bar = document.getElementById("tab-bar");
  if (!bar) return;
  let initial = "alchemy";
  try {
    const v = localStorage.getItem(TAB_LS_KEY);
    if (v && TOP_TABS.has(v)) {
      initial = v;
    } else if (v) {
      const mig = migrateLegacyTab(v);
      if (mig) {
        initial = mig;
        try { localStorage.setItem(TAB_LS_KEY, mig); } catch {}
      }
    }
  } catch {}
  // Restore the network sub-tab choice so a reload returns to the
  // last sub-view (network or metrics) the user was on.
  try {
    const sub = localStorage.getItem(NET_SUB_LS_KEY);
    if (sub && NET_SUBS.has(sub)) document.body.dataset.netSub = sub;
  } catch {}
  applyActiveTab(initial);
  bar.addEventListener("click", (e) => {
    const btn = e.target.closest(".tab-btn");
    if (!btn) return;
    const t = btn.dataset.tab;
    if (!TOP_TABS.has(t)) return;
    morphActiveTab(t, () => applyActiveTab(t));
    try { localStorage.setItem(TAB_LS_KEY, t); } catch {}
  });

  // Network sub-tab nav (network / metrics). Switches in-place — no
  // morph, since both sub-views share the same grid cell anyway.
  const subBar = document.getElementById("network-subtabs");
  if (subBar) {
    subBar.addEventListener("click", (e) => {
      const btn = e.target.closest(".net-subtab");
      if (!btn) return;
      const sub = btn.dataset.netSub;
      if (!NET_SUBS.has(sub)) return;
      setNetworkSub(sub);
    });
  }

  for (const btn of bar.querySelectorAll(".tab-btn")) {
    magnetize(btn, { strength: 4, dampen: 0.35 });
  }
  mountTabIndicator();
}

// Flip the network sub-view + repaint sub-tab aria-selected state +
// persist + activate the metrics module if appropriate. Safe to call
// regardless of which top-level tab is active.
function setNetworkSub(sub) {
  if (!NET_SUBS.has(sub)) sub = "network";
  document.body.dataset.netSub = sub;
  try { localStorage.setItem(NET_SUB_LS_KEY, sub); } catch {}
  for (const b of document.querySelectorAll("#network-subtabs .net-subtab")) {
    b.setAttribute("aria-selected", b.dataset.netSub === sub ? "true" : "false");
  }
  // Toggle the metrics module's polling on/off so it doesn't churn
  // when hidden.
  if (document.body.dataset.activeTab === "network") {
    if (sub === "metrics" && typeof onMetricsTabActivated === "function") {
      onMetricsTabActivated();
    } else if (typeof onMetricsTabDeactivated === "function") {
      onMetricsTabDeactivated();
    }
    if (sub === "network") {
      requestAnimationFrame(() => {
        if (typeof resizeLiveGraph === "function") {
          try { resizeLiveGraph(); } catch {}
        }
      });
    }
  }
}

// Register the visualizer's app-specific keyboard shortcuts and command-
// palette entries. Called from boot() before subscribeEvents so the palette
// and `?` overlay are immediately functional.
function registerVisualizerShortcutsAndCommands() {
  const focusGraphSearch = () => {
    // No-op since graph2 was archived; left as a stub so any external
    // callers continue to compile.
  };
  // Search is now a panel inside atlas (toggled via openAtlasSearch in
  // boot init). Cmd+/ from anywhere lands on atlas + opens the panel.
  const focusSearchTabInput = () => {
    if (document.body.dataset.activeTab !== "atlas") {
      morphActiveTab("atlas", () => applyActiveTab("atlas"));
      try { localStorage.setItem(TAB_LS_KEY, "atlas"); } catch {}
    }
    setTimeout(() => {
      try { openAtlasSearch(); } catch {}
      const inp = document.getElementById("search-input");
      if (inp) { inp.focus(); inp.select?.(); }
    }, 80);
  };
  const goTab = (t) => {
    if (!TOP_TABS.has(t)) return;
    morphActiveTab(t, () => applyActiveTab(t));
    try { localStorage.setItem(TAB_LS_KEY, t); } catch {}
  };
  // Expose for cross-module navigation (identity.js routes the user
  // into the profile editor after they claim a record).
  window.__srwkGoTab = goTab;

  registerKeyboardShortcuts([
    {
      title: "Navigation",
      items: [
        { keys: ["⌘", "K"],         label: "Open command palette" },
        { keys: ["?"],              label: "Show this overlay" },
        { keys: ["A"],              label: "Go to Atlas tab" },
        { keys: ["Y"],              label: "Go to Alchemy tab" },
        { keys: ["N"],              label: "Go to Network tab" },
        { keys: ["M"],              label: "Go to Metrics tab" },
        { keys: ["Esc"],            label: "Close popover / clear search" },
      ],
    },
    {
      title: "Search",
      items: [
        { keys: ["/"],              label: "Open the network search panel inside Atlas" },
        { keys: ["⌘", "F"],         label: "Focus the atlas filter input" },
        { keys: ["Enter"],          label: "Run search / cycle to next match" },
      ],
    },
    {
      title: "Atlas",
      items: [
        { keys: ["Drag"],           label: "Pan the map" },
        { keys: ["Scroll"],         label: "Zoom toward cursor" },
        { keys: ["Click"],          label: "Open page in browser" },
        { keys: ["Hover"],          label: "Show town panel" },
        { keys: ["⌘", "0"],          label: "Reset view" },
        { keys: ["T"],              label: "Toggle time-lapse" },
      ],
    },
    {
      title: "System",
      items: [
        { keys: ["⌘", "K"],         label: "Open command palette" },
        { keys: ["⌘", "R"],         label: "Reload window" },
      ],
    },
  ]);

  registerCommands([
    { id: "go.atlas", group: "Go to", label: "Go to Atlas", keys: ["A"], hint: "the wall map",
      keywords: ["tab","atlas","map","cartography","wall","paper","continent","photo"], run: () => goTab("atlas") },
    { id: "go.network", group: "Go to", label: "Go to Network", keys: ["N"], hint: "peers + traffic",
      keywords: ["tab","network","peers","traffic"], run: () => goTab("network") },
    { id: "go.search",  group: "Go to", label: "Open Search (inside Atlas)",  keys: ["/"], hint: "router + web",
      keywords: ["tab","search","find","query","atlas"], run: focusSearchTabInput },
    { id: "go.metrics", group: "Go to", label: "Go to Metrics", keys: ["M"], hint: "swf-node telemetry · network/metrics sub-tab",
      keywords: ["tab","metrics","charts","stats","network"],
      run: () => { goTab("network"); setNetworkSub("metrics"); } },
    { id: "go.alchemy", group: "Go to", label: "Go to Alchemy", keys: ["Y"],
      hint: "cohort sandbox",
      keywords: ["tab","alchemy","cohort","teams","specimens","pulse","constellation","activity","progress"],
      run: () => goTab("alchemy") },
    { id: "atlas.timelapse", group: "Atlas", label: "Atlas: toggle time-lapse",
      keys: ["T"], hint: "cinematic replay of the last N days",
      keywords: ["atlas","timelapse","time-lapse","replay","scrub","cinematic","T"],
      run: () => {
        if (document.body.dataset.activeTab !== "atlas") goTab("atlas");
        // dispatch a 'T' keydown after a frame so the atlas module's
        // own listener catches it. simpler than crossing the boundary.
        setTimeout(() => {
          document.dispatchEvent(new KeyboardEvent("keydown", { key: "t" }));
        }, 250);
      } },
    { id: "atlas.reset", group: "Atlas", label: "Atlas: reset view",
      keys: ["⌘","0"],
      keywords: ["atlas","reset","home","view","viewport","zoom"],
      run: () => {
        if (document.body.dataset.activeTab !== "atlas") goTab("atlas");
        setTimeout(() => {
          if (window.__srwk_atlas) window.__srwk_atlas.reset();
        }, 250);
      } },
    { id: "search.focus.tab",   group: "Search", label: "Focus Search input",
      keywords: ["search","input","focus"], run: focusSearchTabInput },
    { id: "search.focus.graph", group: "Search", label: "Focus Graph filter (search nodes)",
      hint: "filter by title/host", keys: ["⌘","F"], keywords: ["filter","find"], run: focusGraphSearch },
    { id: "ui.shortcuts", group: "Help", label: "Show keyboard shortcuts",
      keys: ["?"], keywords: ["help","keys","shortcuts"],
      run: () => openKeyboardOverlay() },
    { id: "ui.toggle-motion", group: "Display",
      label: () => isReducedMotion() ? "Enable motion" : "Reduce motion",
      hint: "toggle animations",
      keywords: ["motion","reduce","accessibility","a11y","animate"],
      run: () => {
        const on = toggleManualReducedMotion();
        toast({ kind: "info", message: on ? "motion reduced" : "motion enabled" });
      } },
    { id: "ui.toggle-density", group: "Display", label: () => (document.documentElement.dataset.density === "compact" ? "Comfortable density" : "Compact density"),
      keywords: ["density","compact","comfortable","layout"],
      run: () => {
        const cur = document.documentElement.dataset.density === "compact" ? "comfortable" : "compact";
        document.documentElement.dataset.density = cur;
        try { localStorage.setItem("srwk:density", cur); } catch {}
        toast({ kind: "info", message: `${cur} density` });
      } },
    { id: "events.clear", group: "Events", label: "Clear events log",
      keywords: ["events","clear","reset","log"],
      run: () => {
        const list = document.getElementById("events-panel-list");
        if (list) list.innerHTML = `<div class="events-empty">no events yet. quiet.</div>`;
        const c = document.getElementById("events-panel-count");
        if (c) c.textContent = "0";
        toast({ kind: "success", message: "events cleared" });
      } },
    { id: "conn.restart", group: "Connection", label: "Restart event stream",
      hint: "reconnect SSE", keywords: ["sse","reconnect","restart","stream"],
      run: () => {
        try { srwk.eventSource?.close?.(); } catch {}
        subscribeEvents();
        toast({ kind: "info", message: "reconnecting to event stream…" });
      } },
    { id: "ui.replay-launch", group: "Display", label: "Replay launch sequence",
      hint: "the rotor glyph and wordmark, again",
      keywords: ["launch","intro","wordmark","rotor","animation","welcome","onboarding"],
      run: () => replayLaunch() },
    { id: "metrics.zoom-rss", group: "Metrics", label: "Expand memory chart",
      keywords: ["chart","zoom","expand","memory","rss"],
      run: () => openChartZoomModal("rss-mem") },
    { id: "metrics.zoom-search-latency", group: "Metrics", label: "Expand search latency chart",
      keywords: ["chart","zoom","expand","search","latency"],
      run: () => openChartZoomModal("search-latency") },
    { id: "conn.reload-graph", group: "Connection", label: "Reload graph from server",
      keywords: ["graph","reload","refresh","reconcile"],
      run: async () => {
        try {
          const r = await fetch(`${srwk.serverUrl}/graph?lens=${srwk.lens.id}`);
          if (r.ok) {
            mergeFreshGraph(await r.json());
            toast({ kind: "success", message: "graph reconciled" });
          } else {
            toast({ kind: "error", message: `reload failed: HTTP ${r.status}` });
          }
        } catch (e) {
          toast({ kind: "error", message: `reload failed: ${e?.message || e}` });
        }
      } },
  ]);

  // Register single-letter tab shortcuts with input-blocking guard.
  // Top-level: A / Y / N / M.
  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    const tag = e.target?.tagName?.toUpperCase();
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (e.target?.isContentEditable) return;
    const k = e.key.toLowerCase();
    if (k === "a") { goTab("atlas"); }
    else if (k === "n") { goTab("network"); setNetworkSub("network"); }
    else if (k === "m") { goTab("network"); setNetworkSub("metrics"); }
    else if (k === "y") { goTab("alchemy"); }
    else if (k === "/") {
      // '/' opens the network search panel inside Atlas.
      e.preventDefault();
      focusSearchTabInput();
    }
    // 's' is intentionally not bound to "search tab" here because in the
    // network tab a peer-row carries its own keybinds; the cmd palette
    // entry "Go to Search" covers it.
  });

  // Ensure compact density persists across reloads
  try {
    const d = localStorage.getItem("srwk:density");
    if (d === "compact") document.documentElement.dataset.density = "compact";
  } catch {}
}

function applyActiveTab(tab) {
  if (!TOP_TABS.has(tab)) tab = "alchemy";
  document.body.dataset.activeTab = tab;
  for (const btn of document.querySelectorAll("#tab-bar .tab-btn")) {
    btn.setAttribute("aria-selected", btn.dataset.tab === tab ? "true" : "false");
  }
  // Stale: experimental tab archived 2026-05-09. Variables retained as
  // false so any leftover branches below are no-ops without further edits.
  const expActive = false;
  const expMode   = null;

  // Move the shared #detail element into the right host so the existing
  // detail renderers (renderEventDetail, renderTrafficDetail, render-
  // Receipt/Ticket/Provider/RouterDetail) need no awareness of tabs. The
  // host keeps an .net-detail-empty placeholder as a sibling; CSS only
  // shows it when #detail has no children (`#detail:empty + ...`).
  const detail = document.getElementById("detail");
  if (detail) {
    if (tab === "network") {
      const host = document.getElementById("net-detail-host");
      if (host && detail.parentElement !== host) {
        host.innerHTML = "";
        host.appendChild(detail);
        const empty = document.createElement("div");
        empty.className = "net-detail-empty";
        empty.id = "net-detail-empty";
        empty.textContent = "pick a row to inspect.";  // already terse + lowercase. keep.
        host.appendChild(empty);
      }
    } else {
      const sidebar = document.getElementById("sidebar");
      const events = document.getElementById("events-panel");
      if (sidebar && detail.parentElement !== sidebar) {
        if (events && events.parentElement === sidebar) {
          events.insertAdjacentElement("afterend", detail);
        } else {
          sidebar.appendChild(detail);
        }
        // Restore the placeholder in the network host so it reads as
        // "click a row to inspect" when the user revisits the tab.
        const host = document.getElementById("net-detail-host");
        if (host && !host.querySelector("#net-detail-empty")) {
          host.innerHTML = "";
          const empty = document.createElement("div");
          empty.className = "net-detail-empty";
          empty.id = "net-detail-empty";
          empty.textContent = "pick a row to inspect.";  // already terse + lowercase. keep.
          host.appendChild(empty);
        }
      }
    }
  }
  if (tab === "network") {
    renderNetPeersList();
    renderNetAnonHeader();
    // Default sub-tab when entering network is "network" — but if the
    // user previously switched to metrics, restore that. setNetworkSub
    // also handles activating / deactivating the metrics polling.
    const sub = document.body.dataset.netSub;
    setNetworkSub(NET_SUBS.has(sub) ? sub : "network");
  } else {
    // Leaving the network tab — make sure metrics polling is off.
    if (typeof onMetricsTabDeactivated === "function") onMetricsTabDeactivated();
  }
  // Whenever we leave atlas, close the inline search panel.
  if (tab !== "atlas") closeAtlasSearch();
  // Atlas tab — the wall map. Pure Canvas2D, no force sim. Lazy mount,
  // pause when inactive. The module owns its own rAF loop and wash
  // offscreen-canvas; we just toggle setActive.
  if (tab === "atlas") {
    requestAnimationFrame(() => {
      const stage = document.getElementById("atlas-stage");
      if (!stage) return;
      try {
        Atlas.mount(stage);
        Atlas.setActive(true);
        requestAnimationFrame(() => Atlas.notifyDataChanged());
      } catch (e) {
        console.error("[atlas] mount failed:", e);
      }
    });
  } else {
    try { Atlas.setActive(false); } catch {}
  }

  // Alchemy tab — cohort sandbox. Same lazy-mount pattern as atlas.
  if (tab === "alchemy") {
    requestAnimationFrame(() => {
      const stage = document.getElementById("alchemy-view");
      if (!stage) return;
      try {
        Alchemy.mount(stage);
        Alchemy.setActive(true);
        requestAnimationFrame(() => Alchemy.notifyDataChanged());
      } catch (e) {
        console.error("[alchemy] mount failed:", e);
      }
    });
  } else {
    try { Alchemy.setActive(false); } catch {}
  }
}

// ─── search tab ──────────────────────────────────────────────────────────
const SEARCH_LS_KEY = "srwk:search";
const SEARCH_RECENT_LS_KEY = "srwk:search:recent";
const SEARCH_RECENT_MAX = 10;
const SEARCH_EXAMPLES = [
  "papers on rotational symmetry",
  "how do hash collisions work?",
  "ed25519 vs schnorr signatures",
  "shoegaze albums 1991",
  "DC-net anonymity protocol",
];
const searchState = {
  q: "",
  policy: "default",
  topK: 10,
  confirmEgress: false,
  inFlight: null,
  lastResponse: null,
  lastQuery: "",
  startedAt: 0,
  selectedIdx: -1,
  recents: [],
};

function loadRecentSearches() {
  try {
    const raw = localStorage.getItem(SEARCH_RECENT_LS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter(s => typeof s === "string").slice(0, SEARCH_RECENT_MAX) : [];
  } catch { return []; }
}
function saveRecentSearches() {
  try { localStorage.setItem(SEARCH_RECENT_LS_KEY, JSON.stringify(searchState.recents)); } catch {}
}
function pushRecentSearch(q) {
  if (!q) return;
  const trimmed = q.trim();
  if (!trimmed) return;
  searchState.recents = [trimmed, ...searchState.recents.filter(s => s !== trimmed)].slice(0, SEARCH_RECENT_MAX);
  saveRecentSearches();
  renderRecentChips();
}
function renderRecentChips() {
  const wrap = document.getElementById("search-recents");
  if (!wrap) return;
  if (!searchState.recents.length) { wrap.innerHTML = ""; wrap.hidden = true; return; }
  wrap.hidden = false;
  const chips = searchState.recents.map(q => {
    const safe = escHtml(q);
    return `<button class="search-recent-chip" type="button" data-q="${safe}" title="re-run: ${safe}">${safe}</button>`;
  }).join("");
  wrap.innerHTML = `<span class="search-recents-label">recent</span>${chips}<button class="search-recent-chip search-recent-chip-clear" type="button" data-clear="1" title="clear recent queries">clear</button>`;
  for (const btn of wrap.querySelectorAll(".search-recent-chip")) {
    btn.addEventListener("click", () => {
      if (btn.dataset.clear) {
        searchState.recents = [];
        saveRecentSearches();
        renderRecentChips();
        return;
      }
      const inp = document.getElementById("search-input");
      if (inp) inp.value = btn.dataset.q;
      runSearch(btn.dataset.q);
    });
  }
}

// Search now lives as an inline panel inside Atlas (was its own tab pre
// 2026-05-09). Open/close toggle the body attribute `data-atlas-search`
// — CSS pins #search-view as a positioned overlay above the atlas
// canvas while it's "open", and hides it otherwise.
function openAtlasSearch() {
  document.body.dataset.atlasSearch = "open";
  requestAnimationFrame(() => {
    const inp = document.getElementById("search-input");
    if (inp) { inp.focus(); inp.select?.(); }
  });
}
function closeAtlasSearch() {
  if (document.body.dataset.atlasSearch === "open") {
    delete document.body.dataset.atlasSearch;
  }
}

function wireSearchTab() {
  const form = document.getElementById("search-form");
  const input = document.getElementById("search-input");
  const policy = document.getElementById("search-policy");
  const topk = document.getElementById("search-topk");
  const confirm = document.getElementById("search-confirm-egress");
  if (!form || !input) return;
  // Close the search panel on Esc when it has focus.
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeAtlasSearch();
    }
  });
  try {
    const saved = JSON.parse(localStorage.getItem(SEARCH_LS_KEY) || "null");
    if (saved && typeof saved === "object") {
      if (typeof saved.policy === "string") searchState.policy = saved.policy;
      if (typeof saved.topK === "number") searchState.topK = saved.topK;
      if (typeof saved.confirmEgress === "boolean") searchState.confirmEgress = saved.confirmEgress;
    }
  } catch {}
  if (policy) policy.value = searchState.policy;
  if (topk) topk.value = String(searchState.topK);
  if (confirm) confirm.checked = !!searchState.confirmEgress;

  // Mount the recent-queries strip + initial render of empty-state with examples.
  searchState.recents = loadRecentSearches();
  installSearchRecentStrip();
  installSearchEmptyExamples();
  // Keyboard navigation through results
  installSearchResultsKbdNav(input);

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = (input.value || "").trim();
    if (!q) return;
    runSearch(q);
  });
  // Magnetic hover on the GO button — same calibration as the tabs.
  const submitBtn = document.getElementById("search-submit");
  if (submitBtn) magnetize(submitBtn, { strength: 6, dampen: 0.4 });
  if (policy) policy.addEventListener("change", () => {
    searchState.policy = policy.value;
    persistSearchPrefs();
  });
  if (topk) topk.addEventListener("change", () => {
    const n = parseInt(topk.value, 10);
    searchState.topK = Number.isFinite(n) ? n : 10;
    persistSearchPrefs();
  });
  if (confirm) confirm.addEventListener("change", () => {
    searchState.confirmEgress = !!confirm.checked;
    persistSearchPrefs();
  });
  const askBtn = document.getElementById("search-ask-agent");
  if (askBtn) {
    const onAsk = async () => {
      const q = (input.value || "").trim();
      const prompt = buildAskAgentPrompt(q);
      let ok = false;
      try { await navigator.clipboard.writeText(prompt); ok = true; }
      catch { try { window.api?.clipboardWrite?.(prompt); ok = true; } catch {} }
      if (ok) {
        const prev = askBtn.textContent;
        askBtn.dataset.state = "copied";
        askBtn.textContent = "copied — paste to your agent";
        setTimeout(() => {
          delete askBtn.dataset.state;
          askBtn.textContent = prev;
        }, 1600);
      }
    };
    askBtn.addEventListener("click", onAsk);
    document.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "a" || e.key === "A")) {
        const sv = document.getElementById("search-view");
        if (sv && !sv.hidden) { e.preventDefault(); onAsk(); }
      }
    });
  }
  if (searchState.lastResponse) {
    input.value = searchState.lastQuery;
    renderSearchMeta(searchState.lastResponse);
    renderSearchResults(searchState.lastResponse);
  }
}

function buildAskAgentPrompt(q) {
  const url = `${srwk.serverUrl}/web_search`;
  const body = {
    q: q || "<paste your query here>",
    policy: searchState.policy,
    top_k: searchState.topK,
    confirm_public_egress: !!searchState.confirmEgress,
  };
  const policyLine = searchState.confirmEgress
    ? "User has authorized public web egress for this query."
    : "User has NOT authorized public web egress; egress will be refused if the policy requires confirmation.";
  return [
    `You are an agent helping me search my local swf-node (Self-sovereign LAN-first peer search) instance.`,
    ``,
    `Make this HTTP request and summarize the results for me:`,
    ``,
    `  POST ${url}`,
    `  Content-Type: application/json`,
    ``,
    `  ${JSON.stringify(body, null, 2).replace(/\n/g, "\n  ")}`,
    ``,
    `Notes:`,
    `- ${policyLine}`,
    `- Response is SPEC v0.3: top-level fields include status, delivery_path, origin_paths, privacy_level, network_used_this_request, public_egress_used_this_request, attempts[], results[], fallbacks_tried, debug.`,
    `- Each item in results[] has at least: title, url, snippet, host, provider_pubkey (when from a peer), origin_path.`,
    `- If status is "confirmation_required", report that back to me — don't retry with confirm_public_egress=true on your own.`,
    `- The endpoint is on my loopback (${url.replace(/\/web_search$/, "")}); it is not reachable from the public internet, so curl/fetch from your sandbox may fail. If you can't reach it, just print the curl I should run.`,
    ``,
    `Then give me a concise digest: top results (title + host + 1-line why-relevant), and the route that delivered them (delivery_path).`,
  ].join("\n");
}

function installSearchRecentStrip() {
  // Always-visible chip strip under the controls (similar to Raycast/Linear
  // command-bar history). The strip hides itself when there are no recents
  // — the empty-state has its own example queries to start from.
  const form = document.getElementById("search-form");
  if (!form) return;
  let strip = document.getElementById("search-recents");
  if (!strip) {
    strip = document.createElement("div");
    strip.id = "search-recents";
    strip.className = "search-recents";
    strip.hidden = true;
    form.appendChild(strip);
  }
  renderRecentChips();
}

function installSearchEmptyExamples() {
  // Mutate the initial empty-state to include example-query buttons. Only
  // applies the first time before any search has run; renderSearchResults
  // already produces its own no-results empty.
  const list = document.getElementById("search-results");
  if (!list) return;
  const empty = list.querySelector(".search-empty");
  if (!empty) return;
  if (empty.dataset.examplesMounted === "1") return;
  empty.dataset.examplesMounted = "1";
  const examples = document.createElement("div");
  examples.className = "search-empty-examples";
  for (const ex of SEARCH_EXAMPLES) {
    const btn = document.createElement("button");
    btn.className = "search-empty-example";
    btn.type = "button";
    btn.textContent = ex;
    btn.addEventListener("click", () => {
      const inp = document.getElementById("search-input");
      if (inp) inp.value = ex;
      runSearch(ex);
    });
    examples.appendChild(btn);
  }
  empty.appendChild(examples);
}

function installSearchResultsKbdNav(input) {
  // Arrow up/down moves visual selection; Enter opens; Cmd-Enter opens in
  // background (currently no concept of "background tab" in Electron, so we
  // just open in default external browser without focusing the visualizer).
  const moveSelection = (dir) => {
    const list = document.getElementById("search-results");
    if (!list) return;
    const rows = list.querySelectorAll(".search-result");
    if (!rows.length) return;
    let next = searchState.selectedIdx + dir;
    if (next < 0) next = rows.length - 1;
    if (next >= rows.length) next = 0;
    searchState.selectedIdx = next;
    rows.forEach((r, i) => r.classList.toggle("kbd-selected", i === next));
    rows[next].scrollIntoView({ block: "nearest" });
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); moveSelection(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); moveSelection(-1); }
    else if (e.key === "Enter") {
      const list = document.getElementById("search-results");
      const rows = list?.querySelectorAll(".search-result");
      if (rows?.length && searchState.selectedIdx >= 0) {
        e.preventDefault();
        const a = rows[searchState.selectedIdx]?.querySelector(".search-result-title");
        if (a) {
          if (e.metaKey || e.ctrlKey) {
            // Cmd-Enter: open without focusing the new window (best-effort)
            const url = a.dataset.url;
            if (url) {
              if (window.api?.openExternal) window.api.openExternal(url);
              else window.open(url, "_blank", "noopener");
            }
          } else {
            a.click();
          }
        }
      }
    }
  });
}

function persistSearchPrefs() {
  try {
    localStorage.setItem(SEARCH_LS_KEY, JSON.stringify({
      policy: searchState.policy,
      topK: searchState.topK,
      confirmEgress: searchState.confirmEgress,
    }));
  } catch {}
}

async function runSearch(q) {
  if (searchState.inFlight) {
    try { searchState.inFlight.abort(); } catch {}
    searchState.inFlight = null;
  }
  const ctrl = new AbortController();
  searchState.inFlight = ctrl;
  searchState.q = q;
  searchState.lastQuery = q;
  searchState.startedAt = performance.now();
  searchState.selectedIdx = -1;
  setSearchStatus("loading", `searching for ${q}.`);
  hideSearchMeta();
  clearSearchResults();
  showSearchSkeletons();
  pushRecentSearch(q);
  appendEvent({
    kind: "web_search_requested",
    payload: { q, policy: searchState.policy, top_k: searchState.topK },
    ts: Date.now(),
  });
  // The live propagation graph wants this too — represents an outbound
  // search from self before the swf-node /web_search round-trips.
  try {
    livegraphPushFromEvent({
      kind: "web_search_requested",
      payload: { q },
      ts: Date.now(),
    });
  } catch {}
  let resp;
  try {
    const r = await fetch(`${srwk.serverUrl}/web_search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({
        q,
        policy: searchState.policy,
        top_k: searchState.topK,
        confirm_public_egress: searchState.confirmEgress,
      }),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      throw new Error(`HTTP ${r.status}: ${text || r.statusText}`);
    }
    resp = await r.json();
  } catch (err) {
    if (ctrl.signal.aborted) return;
    setSearchStatus("error", `search failed. ${err && err.message ? err.message : String(err)}`);
    searchState.inFlight = null;
    return;
  }
  if (ctrl.signal.aborted) return;
  searchState.inFlight = null;
  searchState.lastResponse = resp;
  const elapsed = Math.max(0, performance.now() - searchState.startedAt);
  resp.__client_latency_ms = Math.round(elapsed);
  appendEvent({ kind: "web_search_completed", payload: resp, ts: Date.now() });
  if (typeof onWebSearchCompleted === "function") {
    try { onWebSearchCompleted(resp); } catch {}
  }
  if (resp.status && resp.status !== "ok" && resp.status !== "partial") {
    const reason = resp.fallback_reason || resp.status;
    setSearchStatus("info", `status: ${resp.status}${reason && reason !== resp.status ? ` · ${reason}` : ""}`);
  } else {
    hideSearchStatus();
  }
  renderSearchMeta(resp);
  renderSearchResults(resp);
}

function setSearchStatus(kind, msg) {
  const el = document.getElementById("search-status");
  if (!el) return;
  el.hidden = false;
  el.dataset.kind = kind;
  // Replace the generic spinner with the visualizer's rotor mark — the same
  // glyph that lives next to the wordmark. Loading is a moment to be
  // identity-aware, not generic.
  el.innerHTML = kind === "loading"
    ? `${rotorMarkup({ size: 14, ariaLabel: "searching" })}<span class="ss-msg">${escHtml(msg)}</span>`
    : escHtml(msg);
}
function hideSearchStatus() {
  const el = document.getElementById("search-status");
  if (el) { el.hidden = true; el.removeAttribute("data-kind"); el.textContent = ""; }
}

function hideSearchMeta() {
  const el = document.getElementById("search-meta");
  if (el) el.hidden = true;
}
function renderSearchMeta(resp) {
  const el = document.getElementById("search-meta");
  if (!el) return;
  el.hidden = false;
  const dp = resp.delivery_path || "—";
  const pl = resp.privacy_level || "none";
  const dpEl = document.getElementById("search-meta-delivery");
  if (dpEl) { dpEl.textContent = dp; dpEl.dataset.dp = dp; }
  const plEl = document.getElementById("search-meta-privacy");
  if (plEl) { plEl.textContent = pl.replace(/_/g, " "); plEl.dataset.pl = pl; }
  const netEl = document.getElementById("search-meta-network");
  if (netEl) {
    const v = !!resp.network_used_this_request;
    netEl.textContent = v ? "yes" : "no";
    netEl.dataset.bool = v ? "true" : "false";
  }
  const egEl = document.getElementById("search-meta-egress");
  if (egEl) {
    const v = !!resp.public_egress_used_this_request;
    egEl.textContent = v ? "yes" : "no";
    egEl.dataset.bool = v ? "true" : "false";
  }
  const latEl = document.getElementById("search-meta-latency");
  if (latEl) {
    const serverMs = (typeof resp.completed_ms === "number" && typeof resp.created_ms === "number")
      ? Math.max(0, resp.completed_ms - resp.created_ms) : null;
    const ms = serverMs ?? resp.__client_latency_ms ?? null;
    latEl.textContent = ms != null ? `${ms} ms` : "—";
    // Wrap in a hover popover that shows the per-stage breakdown the
    // server includes (route + per-attempt timing). Only built once per
    // search; subsequent calls just refresh contents.
    let wrap = latEl.parentElement?.classList?.contains("search-meta-latency-wrap")
      ? latEl.parentElement : null;
    if (!wrap) {
      wrap = document.createElement("span");
      wrap.className = "search-meta-latency-wrap";
      latEl.parentElement?.insertBefore(wrap, latEl);
      wrap.appendChild(latEl);
      const pop = document.createElement("div");
      pop.className = "search-latency-popover";
      pop.id = "search-latency-popover";
      wrap.appendChild(pop);
    }
    const pop = wrap.querySelector(".search-latency-popover");
    if (pop) {
      const rows = [];
      rows.push({ k: "client total", v: resp.__client_latency_ms != null ? `${resp.__client_latency_ms} ms` : "—" });
      if (serverMs != null) rows.push({ k: "server total", v: `${serverMs} ms` });
      // Look for an attempts/timings array on the response. swf-node may
      // expose it as resp.attempts (preferred), resp.route, resp.timings
      // — we render whichever is present.
      const attempts = Array.isArray(resp.attempts) ? resp.attempts
                     : Array.isArray(resp.route) ? resp.route
                     : Array.isArray(resp.timings) ? resp.timings : [];
      for (const a of attempts) {
        const k = a.path || a.origin || a.name || "stage";
        const v = (a.duration_ms != null ? `${Math.round(a.duration_ms)} ms` : null)
               ?? (a.took_ms != null ? `${Math.round(a.took_ms)} ms` : null)
               ?? (a.elapsed_ms != null ? `${Math.round(a.elapsed_ms)} ms` : null)
               ?? (a.status ? String(a.status) : "—");
        rows.push({ k, v });
      }
      if (typeof resp.completed_ms === "number") rows.push({ k: "completed", v: new Date(resp.completed_ms).toLocaleTimeString() });
      pop.innerHTML = rows.map(r => `<div class="slp-row"><span class="k">${escHtml(r.k)}</span><span class="v">${escHtml(String(r.v))}</span></div>`).join("");
    }
  }
  const cEl = document.getElementById("search-meta-count");
  if (cEl) cEl.textContent = String((resp.results || []).length);
}

function clearSearchResults() {
  const list = document.getElementById("search-results");
  if (!list) return;
  list.innerHTML = "";
}

function showSearchSkeletons() {
  const list = document.getElementById("search-results");
  if (!list) return;
  list.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "search-skeleton-list";
  for (let i = 0; i < 3; i++) {
    const s = document.createElement("div");
    s.className = "search-skeleton";
    s.innerHTML = `
      <div class="search-skeleton-line short"></div>
      <div class="search-skeleton-line host"></div>
      <div class="search-skeleton-line snippet"></div>
      <div class="search-skeleton-line snippet-2"></div>
    `;
    wrap.appendChild(s);
  }
  list.appendChild(wrap);
}

function highlightHits(text, query) {
  if (!query || !text) return escHtml(text || "");
  // Tokenize on whitespace, ignore tokens shorter than 2 chars to avoid
  // wrapping every single char.
  const toks = query.split(/\s+/).map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).filter(t => t.length >= 2);
  if (!toks.length) return escHtml(text);
  const re = new RegExp(`(${toks.join("|")})`, "ig");
  // Escape THEN apply <mark>; safe because the match capture is back into
  // the already-escaped string (we replace on the unescaped, then escape
  // each chunk to avoid breaking the highlight pattern).
  const parts = text.split(re);
  return parts.map(part => {
    if (re.test(part)) {
      // Reset lastIndex for global regex: needed because re.test modifies it.
      re.lastIndex = 0;
      return `<mark class="hit">${escHtml(part)}</mark>`;
    }
    return escHtml(part);
  }).join("");
}

function renderSearchResults(resp) {
  const list = document.getElementById("search-results");
  if (!list) return;
  list.innerHTML = "";
  searchState.selectedIdx = -1;
  const results = Array.isArray(resp.results) ? resp.results : [];
  if (results.length === 0) {
    const empty = document.createElement("div");
    empty.className = "search-empty";
    const reason = resp.fallback_reason || (resp.status === "no_results" ? "no_results" : "");
    // Pull diagnostic detail from the per-attempt log so the user sees
    // *why* each route failed instead of a generic "nothing came back".
    const attempts = Array.isArray(resp.attempts) ? resp.attempts : [];
    const indrexAttempt = attempts.find(a => a.path === "LOCAL_INDREX");
    const egressAttempt = attempts.find(a => a.path === "SELF_PUBLIC_EGRESS");

    // Three actionable cases, ordered by how reversible they are:
    //   (a) public egress wasn't confirmed → flip checkbox + retry
    //   (b) searxng (local egress proxy) is unreachable → tell the user
    //       the daemon needs a searxng instance running
    //   (c) local index returned weak matches that didn't pass the
    //       sufficiency gate → show count so the user knows the search
    //       *did* hit something, just not strongly enough
    const needsConfirm = resp.status === "confirmation_required"
      || /public_egress_requires_confirmation/i.test(reason);
    const searxngDown = egressAttempt?.reason === "searxng_unreachable";
    const indrexWeak  = indrexAttempt?.reason?.startsWith("insufficient")
      && indrexAttempt.results_count > 0;

    let title, sub, ctaHtml = "";
    if (needsConfirm) {
      title = "public egress is off.";
      sub = `your local index didn't have a strong-enough match for <em>${escHtml(searchState.q || "this query")}</em>.
             flip the toggle below to also search the public web (via swf-node's egress proxy), then retry.`;
      ctaHtml = `<button id="search-empty-enable-egress" class="search-empty-cta" type="button">enable public egress + retry</button>`;
    } else if (searxngDown) {
      title = "public web search unreachable.";
      sub = `swf-node tried public egress but its searxng instance didn't answer.
             ${indrexWeak ? `your local index had ${indrexAttempt.results_count} weak matches but none passed the sufficiency gate.` : ""}
             check that searxng is running on the swf-node host, then retry.`;
    } else if (indrexWeak) {
      title = "weak local matches only.";
      sub = `local index found ${indrexAttempt.results_count} candidates but none scored high enough to surface.
             enable public egress for a wider net, or refine your query.`;
      ctaHtml = `<button id="search-empty-enable-egress" class="search-empty-cta" type="button">enable public egress + retry</button>`;
    } else {
      title = "nothing came back.";
      sub = reason ? `reason: ${escHtml(reason)}` : "the router exhausted every path it was allowed to take.";
    }
    empty.innerHTML = `
      <div class="search-empty-glyph" aria-hidden="true">
        <svg viewBox="0 0 64 64" width="56" height="56" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="32" cy="32" r="22"/>
          <path d="M16 16l32 32"/>
        </svg>
      </div>
      <div class="search-empty-title">${escHtml(title)}</div>
      <div class="search-empty-sub">${sub}</div>
      ${ctaHtml}
      <div class="search-empty-sub" style="opacity:0.7;margin-top:8px;">or try one of these:</div>
    `;
    const examples = document.createElement("div");
    examples.className = "search-empty-examples";
    for (const ex of SEARCH_EXAMPLES) {
      const btn = document.createElement("button");
      btn.className = "search-empty-example";
      btn.type = "button";
      btn.textContent = ex;
      btn.addEventListener("click", () => {
        const inp = document.getElementById("search-input");
        if (inp) inp.value = ex;
        runSearch(ex);
      });
      examples.appendChild(btn);
    }
    empty.appendChild(examples);
    list.appendChild(empty);
    // Wire the egress CTA — flip the toggle and re-run the same query.
    const egressCta = empty.querySelector("#search-empty-enable-egress");
    if (egressCta) {
      egressCta.addEventListener("click", () => {
        const cb = document.getElementById("search-confirm-egress");
        if (cb) cb.checked = true;
        searchState.confirmEgress = true;
        try { localStorage.setItem(SEARCH_LS_KEY, JSON.stringify({ policy: searchState.policy, topK: searchState.topK, confirmEgress: true })); } catch {}
        if (searchState.q) runSearch(searchState.q);
      });
    }
    return;
  }
  for (const r of results) {
    list.appendChild(buildSearchResultRow(r, searchState.q));
  }
}

function buildSearchResultRow(r, query) {
  const row = document.createElement("div");
  row.className = "search-result";
  row.setAttribute("role", "listitem");
  const url = r.canonical_url || r.url || r.display_url || "";
  const display = r.display_url || hostFromUrl(url) || url;
  const title = r.title || display || "untitled";
  const snippet = r.snippet || "";
  const origin = r.origin_path || r.delivery_path || "";
  const score = (typeof r.score === "number") ? r.score.toFixed(3) : "";
  const provider = (r.provider && (r.provider.provider_label || r.provider.provider_pubkey)) || r.source || "";
  // Hit-highlight title + snippet against the active query
  const titleHtml = highlightHits(title, query || "");
  const snippetHtml = snippet ? highlightHits(snippet, query || "") : "";
  // are.na block layout:
  //   ┌─────────────────────────────────────────────┬──────────┐
  //   │ HOST                                        │ ORIGIN   │
  //   │ Title (display weight)                      │ score    │
  //   │ snippet body voice…                         │ provider │
  //   │ foot                                        │          │
  //   └─────────────────────────────────────────────┴──────────┘
  // The right column is a margin note — origin tag + score + provider,
  // right-aligned, mono caption type. Stays out of the way of the body.
  const provShort = String(provider).slice(0, 24);
  row.innerHTML = `
    <div class="search-result-head">
      <a class="search-result-title" data-url="${escHtml(url)}" href="#">${titleHtml}</a>
      <span class="search-result-host">${escHtml(display)}</span>
    </div>
    ${snippetHtml ? `<div class="search-result-snippet">${snippetHtml}</div>` : ""}
    <div class="search-result-foot"></div>
    <aside class="search-result-margin" aria-label="result metadata">
      ${origin ? `<span class="search-result-origin" data-op="${escHtml(origin)}">${escHtml(origin)}</span>` : ""}
      ${score ? `<span class="search-result-score">score ${escHtml(score)}</span>` : ""}
      ${provider ? `<span class="search-result-provider">${escHtml(provShort)}</span>` : ""}
    </aside>
  `;
  const a = row.querySelector(".search-result-title");
  if (a) {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      if (!url) return;
      if (window.api && typeof window.api.openExternal === "function") {
        window.api.openExternal(url);
      } else {
        window.open(url, "_blank", "noopener");
      }
    });
  }
  // Mouse hover sets the kbd selection too so arrow-keys + mouse stay in sync.
  row.addEventListener("mouseenter", () => {
    const list = document.getElementById("search-results");
    const rows = list?.querySelectorAll(".search-result");
    if (!rows) return;
    rows.forEach((r2, i) => {
      if (r2 === row) {
        searchState.selectedIdx = i;
        r2.classList.add("kbd-selected");
      } else {
        r2.classList.remove("kbd-selected");
      }
    });
  });
  return row;
}

function hostFromUrl(u) {
  if (!u) return "";
  try { return new URL(u).host; } catch { return ""; }
}

// ─── network-tab peers list ──────────────────────────────────────────────
// Promotes the sidebar peers panel to a full column on the network tab.
// Kept in lockstep with the same data the popup peers panel reads from
// (srwk.peers + srwk.nodes + srwk.liveSeen), so SSE updates render here
// too via the existing renderPeersPanel call sites.
function renderNetPeersList() {
  const list = document.getElementById("net-peers-list");
  const counter = document.getElementById("net-peers-count");
  if (!list) return;
  const peers = [...srwk.peers.values()];
  if (counter) counter.textContent = String(peers.length);
  list.innerHTML = "";
  if (peers.length === 0) {
    const empty = document.createElement("div");
    empty.className = "net-peers-empty";
    empty.textContent = "no peers yet — the network is quiet.";
    list.appendChild(empty);
    return;
  }
  const liveCounts = new Map();
  for (const n of srwk.nodes) {
    const pk = n.primary_contributor;
    if (!pk) continue;
    liveCounts.set(pk, (liveCounts.get(pk) || 0) + 1);
  }
  peers.sort((a, b) => {
    const aSelf = a.pubkey === srwk.selfPubkey ? 1 : 0;
    const bSelf = b.pubkey === srwk.selfPubkey ? 1 : 0;
    if (aSelf !== bSelf) return bSelf - aSelf;
    const ap = liveCounts.get(a.pubkey) ?? a.page_count ?? 0;
    const bp = liveCounts.get(b.pubkey) ?? b.page_count ?? 0;
    if (ap !== bp) return bp - ap;
    return (a.nickname || "").localeCompare(b.nickname || "");
  });
  const now = performance.now();
  for (const p of peers) list.appendChild(buildNetPeerCard(p, now, liveCounts));
}

function buildNetPeerCard(p, now, liveCounts) {
  // Block-style are.na unit. The card itself is the typesetting:
  //   ┌────────────────────────────────────┐
  //   │ ▌  little-fern              · live │  ← swatch + display title + live tag
  //   │    pk-9eaa…3f01                    │  ← smallcaps caption
  //   │                                    │
  //   │ 32 pages              10s ago      │  ← tabular foot + margin note
  //   └────────────────────────────────────┘
  // The signature_color appears as a thin left-edge frame, not a glowing
  // dot. Hover lifts 2px without scaling. Click pins.
  const card = document.createElement("article");
  card.className = "net-peer-card";
  card.dataset.pubkey = p.pubkey || "";
  card.tabIndex = 0;
  card.addEventListener("click", () => {
    for (const sib of document.querySelectorAll(".net-peer-card.selected")) {
      sib.classList.remove("selected");
    }
    card.classList.add("selected");
    flyToPeerTerritory(p.pubkey);
  });
  card.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      card.click();
    }
  });
  const color = p.signature_color || stableHue(p.pubkey);
  // Left signature frame — a 3px stripe in the peer's color, the way
  // are.na blocks use a thin border to hint at category.
  card.style.setProperty("--peer-color", color);

  const head = document.createElement("header");
  head.className = "npc-head";
  const nick = document.createElement("span");
  nick.className = "npc-nick";
  if (p.pubkey === srwk.selfPubkey) nick.classList.add("is-self");
  nick.textContent = p.nickname || `peer-${(p.pubkey || "").slice(0, 8)}`;
  head.appendChild(nick);

  const liveTs = srwk.liveSeen.get(p.pubkey);
  const isLive = liveTs && now - liveTs < LIVE_WINDOW_MS;
  const liveTag = document.createElement("span");
  liveTag.className = `npc-live-tag ${isLive ? "is-live" : "is-idle"}`;
  liveTag.textContent = isLive ? "live" : "idle";
  head.appendChild(liveTag);

  const pkRow = document.createElement("div");
  pkRow.className = "npc-pk";
  const pk = p.pubkey || "";
  pkRow.textContent = pk ? `${pk.slice(0, 10)}…${pk.slice(-6)}` : "—";
  pkRow.title = pk;

  const foot = document.createElement("footer");
  foot.className = "npc-foot";
  const livePc = liveCounts ? liveCounts.get(p.pubkey) : undefined;
  const pages = document.createElement("span");
  pages.className = "npc-pages";
  const pageCount = livePc ?? p.page_count ?? 0;
  pages.innerHTML = `<span class="npc-num">${pageCount}</span> <span class="npc-unit">pages</span>`;

  // The margin-note: last-seen, right-aligned in a tight column. Calmer
  // than the glowing "live" dot we used to render.
  const last = document.createElement("span");
  last.className = "npc-last";
  if (liveTs) {
    const dt = (Date.now() / 1000) - (liveTs / 1000);
    last.textContent = formatPeerLastSeen(dt);
  } else if (p.last_seen) {
    const dt = (Date.now() / 1000) - p.last_seen;
    last.textContent = formatPeerLastSeen(dt);
  } else {
    last.textContent = "—";
  }
  foot.append(pages, last);

  card.append(head, pkRow, foot);
  return card;
}

// ─── network-tab anonymity header ─────────────────────────────────────────
// Mirrors the same dcnetState the corner badge reads. Kept in sync via a
// shim around onAnonymitySetChanged + renderAnonBadge, plus a manual call
// when the network tab is activated.
function renderNetAnonHeader() {
  const el = document.getElementById("net-anon-header");
  if (!el) return;
  const valEl = el.querySelector(".nah-value");
  const metaEl = el.querySelector(".nah-meta");
  const p = dcnetState.lastSet;
  if (!p || (p.active_peer_count == null && p.min_anonymity_set == null)) {
    el.dataset.state = "idle";
    if (valEl) valEl.textContent = "idle";
    if (metaEl) metaEl.textContent = "no dc-net round in flight.";
    el.title = "no DC-net round in flight";
    return;
  }
  const a = p.active_peer_count ?? 0;
  const m = p.min_anonymity_set ?? 0;
  const met = (p.met === true) || (a >= m && m > 0);
  el.dataset.state = met ? "met" : "unmet";
  if (valEl) valEl.textContent = `${a}/${m} ${met ? "✓" : "⚠"}`;
  const transport = p.transport_kind || "lan_friend_dcnet_round";
  const ep = dcnetState.lastEpoch || {};
  const epoch = ep.new_epoch_id || ep.epoch_id || p.epoch_id || "—";
  if (metaEl) {
    metaEl.textContent = met
      ? `${transport} · epoch ${String(epoch).slice(0, 12)}`
      : `min anonymity-set not yet reached (${a}/${m})`;
  }
  el.title = met
    ? `LAN_FRIEND_DCNET active · ${a} peers in circle (min ${m})`
    : `LAN_FRIEND_DCNET cannot be reported until min anonymity set is reached (${a}/${m})`;
}

// ─── metrics tab ──────────────────────────────────────────────────────────
// Polls swf-node's self-contained /metrics/{snapshot,series} endpoints and
// renders a small dashboard. SVG sparklines (no Chart.js dep). No grafana,
// no prometheus — the time-series database is sqlite on the swf-node side.
//
// Polling cadence: 15s while the metrics tab is visible; suspended when
// the tab is hidden (visibilitychange + tab change).

const METRICS_RANGE_LS_KEY = "srwk:metrics:range";
const METRICS_POLL_MS = 15_000;

const RANGES = {
  "15m": { ms: 15 * 60_000,        defaultStep: 30_000 },
  "1h":  { ms: 60 * 60_000,        defaultStep: 60_000 },
  "6h":  { ms: 6 * 3600_000,       defaultStep: 5 * 60_000 },
  "24h": { ms: 24 * 3600_000,      defaultStep: 15 * 60_000 },
};

// Per-chart name lists. Each chart fetches up to two named series so it
// can plot p50 + p95 (or count-vs-rate) together; the line/area renderer
// handles 1-or-2 series uniformly.
//
// `unit` and `valueFmt` feed the hover tooltip / per-chart value label.
// `subtitle` is a one-line human description used in the chart card head.
const CHARTS = {
  "search-latency":    { names: ["web_search.duration_ms_p50", "web_search.duration_ms_p95"],
                         unit: "ms",   subtitle: "/web_search round-trip", valueFmt: (n) => `${Math.round(n)} ms` },
  "search-throughput": { names: ["web_search.total"], rate: true,
                         unit: "qpm",  subtitle: "queries / minute (per-tick)", valueFmt: (n) => `${n.toFixed(1)} qpm` },
  "scrape-latency":    { names: ["slice_scrape.duration_ms_p50", "slice_scrape.duration_ms_p95"],
                         unit: "ms",   subtitle: "fetch + parse per slice", valueFmt: (n) => `${Math.round(n)} ms` },
  "peers-active":      { names: ["peers.count_active"],
                         unit: "peers", subtitle: "last seen <5 min", valueFmt: (n) => `${Math.round(n)}` },
  "pages-total":       { names: ["pages.count_total"],
                         unit: "pages", subtitle: "graph size",       valueFmt: (n) => `${Math.round(n)}` },
  "rss-mem":           { names: ["process.rss_bytes"], leakWatch: true,
                         unit: "bytes", subtitle: "resident set size", valueFmt: (n) => formatBytes(n) },
  "cpu-percent":       { names: ["process.cpu_percent"],
                         unit: "%",    subtitle: "process CPU",       valueFmt: (n) => `${n.toFixed(1)}%` },
};

const metricsState = {
  range: "1h",
  pollTimer: 0,
  inFlight: null,
  lastSeriesByChart: new Map(),
  lastSnapshot: null,
  active: false,
};

function wireMetricsTab() {
  // Restore range preference
  try {
    const r = localStorage.getItem(METRICS_RANGE_LS_KEY);
    if (r && RANGES[r]) metricsState.range = r;
  } catch {}
  const rangeBar = document.getElementById("metrics-range");
  if (rangeBar) {
    for (const b of rangeBar.querySelectorAll(".metrics-range-btn")) {
      b.classList.toggle("selected", b.dataset.range === metricsState.range);
    }
    rangeBar.addEventListener("click", (e) => {
      const btn = e.target.closest(".metrics-range-btn");
      if (!btn) return;
      const r = btn.dataset.range;
      if (!RANGES[r]) return;
      metricsState.range = r;
      try { localStorage.setItem(METRICS_RANGE_LS_KEY, r); } catch {}
      for (const b of rangeBar.querySelectorAll(".metrics-range-btn")) {
        b.classList.toggle("selected", b.dataset.range === r);
      }
      runMetricsRefresh();
    });
  }
  const refresh = document.getElementById("metrics-refresh");
  if (refresh) refresh.addEventListener("click", () => runMetricsRefresh());

  // Re-evaluate polling when the page becomes hidden
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopMetricsPoll();
    else if (metricsState.active) startMetricsPoll();
  });

  // Inject subtitle + unit into each chart card head (one-time, post-DOM).
  // The HTML scaffold from index.html already gives us .mc-head; we extend
  // it with a subtitle row that PR4 introduces.
  for (const [chartId, cfg] of Object.entries(CHARTS)) {
    const card = document.querySelector(`.metrics-chart[data-chart="${chartId}"]`);
    if (!card) continue;
    let head = card.querySelector(".mc-head");
    if (head && !head.dataset.subtitled) {
      head.dataset.subtitled = "1";
      const sub = document.createElement("div");
      sub.className = "mc-subtitle";
      sub.textContent = cfg.subtitle || "";
      head.appendChild(sub);
    }
    // Ensure each chart SVG has a click-to-zoom affordance + hover overlay
    if (!card.dataset.zoomWired) {
      card.dataset.zoomWired = "1";
      const zoomBtn = document.createElement("button");
      zoomBtn.className = "mc-zoom";
      zoomBtn.type = "button";
      zoomBtn.title = "expand chart";
      zoomBtn.setAttribute("aria-label", "expand chart");
      zoomBtn.innerHTML = `<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.5 2.5h4v4"/><path d="M13.5 2.5l-5 5"/><path d="M6.5 13.5h-4v-4"/><path d="M2.5 13.5l5-5"/></svg>`;
      zoomBtn.addEventListener("click", () => openChartZoomModal(chartId));
      card.appendChild(zoomBtn);
    }
  }
  // Single delegated mousemove + mouseleave per metrics view, dispatched
  // to whichever chart is under the pointer. Cheaper than wiring N x 7
  // chart listeners.
  const mView = document.getElementById("metrics-view");
  if (mView && !mView.dataset.hoverWired) {
    mView.dataset.hoverWired = "1";
    mView.addEventListener("mousemove", onMetricsHover, true);
    mView.addEventListener("mouseleave", () => clearMetricsHover(), true);
  }
}

function onMetricsTabActivated() {
  metricsState.active = true;
  runMetricsRefresh();
  startMetricsPoll();
}

function onMetricsTabDeactivated() {
  metricsState.active = false;
  stopMetricsPoll();
}

function startMetricsPoll() {
  stopMetricsPoll();
  metricsState.pollTimer = setInterval(() => {
    if (document.hidden || !metricsState.active) return;
    runMetricsRefresh();
  }, METRICS_POLL_MS);
}

function stopMetricsPoll() {
  if (metricsState.pollTimer) {
    clearInterval(metricsState.pollTimer);
    metricsState.pollTimer = 0;
  }
}

async function runMetricsRefresh() {
  const status = document.getElementById("metrics-status");
  if (status) status.textContent = "loading.";
  try {
    await Promise.all([fetchMetricsSnapshot(), fetchMetricsCharts()]);
    if (status) status.textContent = `last update ${formatEventTs(Date.now())}`;
  } catch (e) {
    if (status) status.textContent = `error: ${e?.message || String(e)}`;
  }
}

async function fetchMetricsSnapshot() {
  const r = await fetch(`${srwk.serverUrl}/metrics/snapshot`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  metricsState.lastSnapshot = data;
  renderMetricsSnapshot(data);
}

function renderMetricsSnapshot(data) {
  const v = data?.values || {};
  // Animated numeric updates (Stripe-press style) — tickNumber tweens
  // from the previously-rendered value to the new one in 280ms ease-out,
  // then snaps. Tabular figures (set on .ms-value via the .num utility)
  // keep glyph widths fixed during the tween.
  const setStat = (name, fmt) => {
    const el = document.querySelector(`[data-stat="${name}"]`);
    if (!el) return;
    if (v[name] == null) {
      el.textContent = "—";
      return;
    }
    tickNumber(el, v[name], { format: fmt });
  };
  setStat("peers.count_active", (n) => String(Math.round(n)));
  const sub = document.querySelector('[data-stat-sub="peers.count_known"]');
  if (sub && v["peers.count_known"] != null) sub.textContent = `of ${Math.round(v["peers.count_known"])}`;
  setStat("pages.count_total", (n) => String(Math.round(n)));
  setStat("contributions.count_total", (n) => String(Math.round(n)));
  setStat("events.lag_secs", (n) => `${Math.round(n)}s`);
  setStat("process.rss_bytes", formatBytes);
  setStat("process.cpu_percent", (n) => `${(n).toFixed(1)}%`);

  const empty = document.getElementById("metrics-empty");
  if (empty) {
    const hasAny = Object.keys(v).length > 0;
    empty.hidden = hasAny;
  }
}

function formatBytes(n) {
  if (n == null) return "—";
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

async function fetchMetricsCharts() {
  const range = RANGES[metricsState.range];
  if (!range) return;
  const until = Date.now();
  const from = until - range.ms;
  // Aggregate every chart's series names into a single /metrics/series call
  // so we don't fan out N requests per refresh. Server-side bucketing
  // keeps the response small.
  const allNames = [];
  for (const cfg of Object.values(CHARTS)) {
    for (const n of cfg.names) if (!allNames.includes(n)) allNames.push(n);
  }
  const url = `${srwk.serverUrl}/metrics/series?names=${encodeURIComponent(allNames.join(","))}&from=${from}&until=${until}&step=${range.defaultStep}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  // Index series by name
  const byName = new Map();
  for (const row of data.series || []) {
    let arr = byName.get(row.name);
    if (!arr) { arr = []; byName.set(row.name, arr); }
    arr.push(row);
  }
  for (const arr of byName.values()) arr.sort((a, b) => a.ts_ms - b.ts_ms);
  // Render each chart
  for (const [chartId, cfg] of Object.entries(CHARTS)) {
    const card = document.querySelector(`.metrics-chart[data-chart="${chartId}"]`);
    if (!card) continue;
    const svg = card.querySelector(".mc-svg");
    if (!svg) continue;
    const seriesArr = cfg.names.map((n) => byName.get(n) || []);
    let pointsArr;
    if (cfg.rate) {
      // Convert cumulative count → per-minute rate (delta / dt_min)
      pointsArr = seriesArr.map((rows) => toRatePoints(rows, range.defaultStep));
    } else {
      pointsArr = seriesArr.map((rows) => rows.map((r) => ({ x: r.ts_ms, y: r.value })));
    }
    drawSparkline(svg, pointsArr, { from, until, leakWatch: cfg.leakWatch, leakLabelEl: card.querySelector(".mc-leak") });
    // First-paint reveal: clip-path slides left-to-right over 600ms ease-
    // out. revealOnce() is idempotent (data-revealed flag) — re-renders
    // on subsequent refreshes don't re-animate.
    revealOnce(svg, { duration: 620 });
  }
}

function toRatePoints(rows, step_ms) {
  // The metrics collector resets web_search.total per tick; so the value
  // is essentially the per-tick count. Convert to per-minute by scaling
  // by (60_000 / step_ms). When the tick interval is 10s and step is 60s
  // the avg over a bucket is ~the per-10s count; multiplying by 6 makes
  // it per-minute. Good enough for a sparkline.
  const scale = 60_000 / Math.max(1, step_ms);
  return rows.map((r) => ({ x: r.ts_ms, y: r.value * scale }));
}

// Light-weight SVG sparkline. Accepts up to N point-arrays — primary draws
// solid, the rest dashed (used for p95 overlay). All in 280×140 viewBox to
// match the CSS. PR4 adds: anomaly dots, geometry record on the SVG dataset
// for the delegated hover handler, viewBox-aware crosshair group.
function drawSparkline(svg, pointsArr, opts = {}) {
  const W = 280, H = 140, padL = 28, padR = 6, padT = 8, padB = 14;
  // Compute global x/y range
  const xMin = opts.from ?? Math.min(...pointsArr.flat().map(p => p.x));
  const xMax = opts.until ?? Math.max(...pointsArr.flat().map(p => p.x));
  let yMin = Infinity, yMax = -Infinity;
  let totalPts = 0;
  for (const arr of pointsArr) {
    for (const p of arr) {
      if (p.y < yMin) yMin = p.y;
      if (p.y > yMax) yMax = p.y;
      totalPts++;
    }
  }
  if (totalPts === 0) {
    svg.innerHTML = `<text class="mc-empty" x="50%" y="50%" text-anchor="middle" dominant-baseline="middle">no data yet.</text>`;
    delete svg.dataset.geom;
    return;
  }
  // Pad y range a bit; force a non-zero range so flat lines still draw
  if (yMin === yMax) { yMin -= 1; yMax += 1; }
  const yPad = (yMax - yMin) * 0.08;
  yMin -= yPad; yMax += yPad;
  if (yMin < 0 && pointsArr[0]?.[0]?.y >= 0) yMin = 0;

  const sx = (x) => padL + (W - padL - padR) * (xMax > xMin ? (x - xMin) / (xMax - xMin) : 0.5);
  const sy = (y) => padT + (H - padT - padB) * (1 - (y - yMin) / Math.max(1e-9, yMax - yMin));

  const lines = [];
  pointsArr.forEach((arr, i) => {
    if (!arr.length) return;
    const cls = i === 0 ? "mc-line" : "mc-line-p95";
    const d = arr.map((p, j) => `${j === 0 ? "M" : "L"}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(" ");
    lines.push(`<path class="${cls}" d="${d}" />`);
  });
  // Filled area under the primary line
  let area = "";
  if (pointsArr[0]?.length) {
    const arr = pointsArr[0];
    const dStart = `M${sx(arr[0].x).toFixed(1)},${sy(yMin).toFixed(1)}`;
    const dLine = arr.map((p) => `L${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(" ");
    const dEnd = ` L${sx(arr[arr.length - 1].x).toFixed(1)},${sy(yMin).toFixed(1)} Z`;
    area = `<path class="mc-area" d="${dStart} ${dLine}${dEnd}" />`;
  }
  // Anomaly callouts — flag points >2σ from the rolling mean of the primary
  // series. (Strict 3σ rarely fires on a 60-tick sparkline.) Skip for
  // counters that only ever go up — pages_total, contributions_total —
  // because their slope is informative but every point IS the new max.
  let anomalies = "";
  let anomalyList = [];
  if (pointsArr[0]?.length > 6 && !opts.suppressAnomaly) {
    const arr = pointsArr[0];
    const n = arr.length;
    let sum = 0, sumSq = 0;
    for (const p of arr) { sum += p.y; sumSq += p.y * p.y; }
    const mean = sum / n;
    const variance = Math.max(0, sumSq / n - mean * mean);
    const std = Math.sqrt(variance);
    // Don't bother flagging when the spread is genuinely uniform.
    if (std > 0 && std / Math.max(1e-9, Math.abs(mean) + 1) > 0.05) {
      const dots = [];
      for (let i = 0; i < n; i++) {
        const p = arr[i];
        const z = (p.y - mean) / std;
        if (Math.abs(z) >= 2) {
          dots.push(`<circle class="mc-anom" cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="2.6"/>`);
          anomalyList.push({ x: p.x, y: p.y, z });
        }
      }
      anomalies = dots.join("");
    }
  }
  // Y-axis labels
  const fmt = (y) => {
    if (Math.abs(y) >= 1024 * 1024) return `${(y / (1024 * 1024)).toFixed(0)}M`;
    if (Math.abs(y) >= 1024) return `${(y / 1024).toFixed(0)}K`;
    if (Math.abs(y) < 1) return y.toFixed(2);
    if (Math.abs(y) < 10) return y.toFixed(1);
    return Math.round(y).toString();
  };
  const yLabels = [
    `<text x="${padL - 4}" y="${(sy(yMax) + 4).toFixed(1)}" text-anchor="end" font-family="monospace" font-size="9" fill="rgba(220,232,255,0.55)">${fmt(yMax)}</text>`,
    `<text x="${padL - 4}" y="${(sy(yMin) + 1).toFixed(1)}" text-anchor="end" font-family="monospace" font-size="9" fill="rgba(220,232,255,0.55)">${fmt(yMin)}</text>`,
  ];
  // X-axis labels (start + end)
  const tFmt = (ms) => {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };
  const xLabels = [
    `<text x="${padL}" y="${H - 2}" font-family="monospace" font-size="9" fill="rgba(220,232,255,0.55)">${tFmt(xMin)}</text>`,
    `<text x="${W - padR}" y="${H - 2}" text-anchor="end" font-family="monospace" font-size="9" fill="rgba(220,232,255,0.55)">${tFmt(xMax)}</text>`,
  ];

  // Leak watch — linear regression slope (bytes/ms) on the primary series.
  if (opts.leakWatch && opts.leakLabelEl && pointsArr[0]?.length > 4) {
    const arr = pointsArr[0];
    const n = arr.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    for (const p of arr) { sumX += p.x; sumY += p.y; sumXY += p.x * p.y; sumXX += p.x * p.x; }
    const denom = n * sumXX - sumX * sumX;
    const slope = denom !== 0 ? (n * sumXY - sumX * sumY) / denom : 0;
    // Convert slope (bytes/ms) → bytes/hour for legibility
    const bytesPerHour = slope * 3600_000;
    const isLeak = bytesPerHour > 1024 * 1024 * 5;  // > 5 MB/hr = warn
    opts.leakLabelEl.dataset.state = isLeak ? "warn" : "ok";
    const sign = bytesPerHour >= 0 ? "+" : "−";
    opts.leakLabelEl.textContent = `${sign}${formatBytes(Math.abs(bytesPerHour))}/hr`;
  }

  // Crosshair group — initially hidden; revealed by onMetricsHover.
  const cross = `
    <g class="mc-cross" style="display:none">
      <line class="mc-cross-v" y1="${padT}" y2="${H - padB}" />
      <circle class="mc-cross-dot-1" r="3" />
      <circle class="mc-cross-dot-2" r="2.6" />
    </g>
  `;
  svg.innerHTML = area + lines.join("") + anomalies + yLabels.join("") + xLabels.join("") + cross;
  // Stash everything the hover handler needs onto the SVG element.
  svg._geom = {
    W, H, padL, padR, padT, padB,
    xMin, xMax, yMin, yMax,
    series: pointsArr,
    anomalies: anomalyList,
    sx, sy,
  };
}

// ─── metrics chart hover crosshair + tooltip ─────────────────────────────
// Single delegated handler walks up to the .metrics-chart card under the
// pointer, snaps to the nearest x-bucket on the primary series, and
// renders a floating tooltip with value + ts + delta-from-mean + a hot
// "ANOMALY" pill if the point is one of the >2σ outliers we already
// flagged in drawSparkline.

let metricsTooltipEl = null;

function ensureMetricsTooltip() {
  if (metricsTooltipEl && document.body.contains(metricsTooltipEl)) return metricsTooltipEl;
  metricsTooltipEl = document.createElement("div");
  metricsTooltipEl.className = "mc-tooltip";
  metricsTooltipEl.hidden = true;
  document.body.appendChild(metricsTooltipEl);
  return metricsTooltipEl;
}

function clearMetricsHover() {
  if (!metricsTooltipEl) return;
  metricsTooltipEl.hidden = true;
  for (const svg of document.querySelectorAll(".metrics-chart .mc-svg")) {
    const g = svg.querySelector(".mc-cross");
    if (g) g.style.display = "none";
  }
}

function onMetricsHover(e) {
  const card = e.target.closest(".metrics-chart");
  if (!card) { clearMetricsHover(); return; }
  const svg = card.querySelector(".mc-svg");
  if (!svg || !svg._geom) { clearMetricsHover(); return; }
  const geom = svg._geom;
  // Convert pointer position to SVG viewBox coords. SVG viewBox is 280×140;
  // we use getBoundingClientRect for the actual rendered size.
  const rect = svg.getBoundingClientRect();
  const xRatio = (e.clientX - rect.left) / Math.max(1, rect.width);
  const yRatio = (e.clientY - rect.top) / Math.max(1, rect.height);
  const xViewBox = xRatio * geom.W;
  if (xViewBox < geom.padL || xViewBox > geom.W - geom.padR) { clearMetricsHover(); return; }
  // Reverse-map pixel→time
  const t = geom.xMin + (xViewBox - geom.padL) / (geom.W - geom.padL - geom.padR) * (geom.xMax - geom.xMin);
  // Find the closest point on the primary series
  const primary = geom.series[0] || [];
  if (!primary.length) { clearMetricsHover(); return; }
  let nearest = primary[0], ndt = Infinity;
  for (const p of primary) {
    const d = Math.abs(p.x - t);
    if (d < ndt) { ndt = d; nearest = p; }
  }
  // Optional secondary series — pick closest by x
  const secondary = geom.series[1] || [];
  let near2 = null;
  if (secondary.length) {
    let n2dt = Infinity;
    for (const p of secondary) {
      const d = Math.abs(p.x - nearest.x);
      if (d < n2dt) { n2dt = d; near2 = p; }
    }
  }
  // Compute mean of primary series for delta callout
  let sum = 0;
  for (const p of primary) sum += p.y;
  const mean = sum / primary.length;
  const delta = nearest.y - mean;
  const isAnomaly = (geom.anomalies || []).some(a => a.x === nearest.x);

  // Draw crosshair on the SVG
  const g = svg.querySelector(".mc-cross");
  if (g) {
    g.style.display = "";
    const cx = geom.sx(nearest.x);
    const cy1 = geom.sy(nearest.y);
    const v = g.querySelector(".mc-cross-v");
    if (v) { v.setAttribute("x1", cx); v.setAttribute("x2", cx); }
    const dot1 = g.querySelector(".mc-cross-dot-1");
    if (dot1) { dot1.setAttribute("cx", cx); dot1.setAttribute("cy", cy1); }
    const dot2 = g.querySelector(".mc-cross-dot-2");
    if (dot2) {
      if (near2) {
        dot2.setAttribute("cx", cx);
        dot2.setAttribute("cy", geom.sy(near2.y));
        dot2.style.display = "";
      } else {
        dot2.style.display = "none";
      }
    }
  }

  // Position the floating tooltip near the pointer (clamp to viewport)
  const tip = ensureMetricsTooltip();
  const chartId = card.dataset.chart;
  const cfg = CHARTS[chartId] || {};
  const fmt = cfg.valueFmt || ((n) => n.toString());
  const ts = new Date(nearest.x);
  const tsStr = `${String(ts.getHours()).padStart(2, "0")}:${String(ts.getMinutes()).padStart(2, "0")}:${String(ts.getSeconds()).padStart(2, "0")}`;
  const deltaStr = (delta >= 0 ? "+" : "−") + fmt(Math.abs(delta));
  const deltaCls = Math.abs(delta) > Math.abs(mean) * 0.30 ? "mc-tt-delta-warn" : "mc-tt-delta";
  tip.innerHTML = `
    <div class="mc-tt-row mc-tt-title">${escHtml(cfg.subtitle || chartId || "")}</div>
    <div class="mc-tt-row mc-tt-value">${escHtml(fmt(nearest.y))}</div>
    ${near2 != null ? `<div class="mc-tt-row mc-tt-row-2"><span class="mc-tt-k">p95</span><span class="mc-tt-v">${escHtml(fmt(near2.y))}</span></div>` : ""}
    <div class="mc-tt-row"><span class="mc-tt-k">ts</span><span class="mc-tt-v">${tsStr}</span></div>
    <div class="mc-tt-row"><span class="mc-tt-k">δ from mean</span><span class="mc-tt-v ${deltaCls}">${escHtml(deltaStr)}</span></div>
    ${isAnomaly ? `<div class="ux-pill" data-kind="warn" style="margin-top:4px;">anomaly · ≥2σ</div>` : ""}
  `;
  tip.hidden = false;
  // Position
  const tipRect = tip.getBoundingClientRect();
  let tx = e.clientX + 14;
  let ty = e.clientY + 14;
  if (tx + tipRect.width > window.innerWidth - 8) tx = e.clientX - tipRect.width - 14;
  if (ty + tipRect.height > window.innerHeight - 8) ty = e.clientY - tipRect.height - 14;
  tip.style.left = `${Math.max(8, tx)}px`;
  tip.style.top = `${Math.max(8, ty)}px`;
}

// ── click-to-zoom modal — same chart at 2× size, no shared state ──
function openChartZoomModal(chartId) {
  const cfg = CHARTS[chartId];
  if (!cfg) return;
  const sourceCard = document.querySelector(`.metrics-chart[data-chart="${chartId}"]`);
  if (!sourceCard) return;
  const titleEl = sourceCard.querySelector(".mc-title");
  const title = titleEl?.textContent || chartId;
  const subtitle = cfg.subtitle || "";

  const backdrop = document.createElement("div");
  backdrop.className = "ux-modal-backdrop mc-zoom-backdrop";
  backdrop.setAttribute("role", "dialog");
  backdrop.setAttribute("aria-modal", "true");
  backdrop.innerHTML = `
    <div class="ux-modal mc-zoom-modal" role="document">
      <header class="mc-zoom-head">
        <div>
          <div class="mc-zoom-title">${escHtml(title)}</div>
          <div class="mc-zoom-subtitle">${escHtml(subtitle)}</div>
        </div>
        <button class="ux-modal-close mc-zoom-close" type="button" aria-label="close">&times;</button>
      </header>
      <div class="mc-zoom-body">
        <svg class="mc-zoom-svg" viewBox="0 0 280 140" preserveAspectRatio="none"></svg>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);
  requestAnimationFrame(() => backdrop.classList.add("entered"));
  const close = () => {
    backdrop.classList.add("leaving");
    const cleanup = () => backdrop.remove();
    if (isReducedMotion()) cleanup();
    else backdrop.addEventListener("transitionend", cleanup, { once: true });
    setTimeout(cleanup, 400);
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  backdrop.querySelector(".mc-zoom-close").addEventListener("click", close);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
  document.addEventListener("keydown", onKey);

  // Replicate the most-recent series payload onto the modal SVG.
  const sourceSvg = sourceCard.querySelector(".mc-svg");
  const geom = sourceSvg?._geom;
  const modalSvg = backdrop.querySelector(".mc-zoom-svg");
  if (geom && modalSvg) {
    drawSparkline(modalSvg, geom.series, {
      from: geom.xMin, until: geom.xMax,
      leakWatch: cfg.leakWatch, leakLabelEl: null,
    });
    // Wire the same hover handler scoped to the modal SVG so the crosshair
    // still works at 2x size. We attach to the parent so geometry uses the
    // modal's bounding rect.
    const onMove = (e) => {
      const ev = new MouseEvent("mousemove", { clientX: e.clientX, clientY: e.clientY });
      // Fake a target so the existing handler picks the modal's chart card
      Object.defineProperty(ev, "target", { value: modalSvg, writable: false });
      // We don't have a card for the modal SVG; emulate inline:
      onMetricsHoverModal(modalSvg, e);
    };
    modalSvg.addEventListener("mousemove", onMove);
    modalSvg.addEventListener("mouseleave", () => clearMetricsHover());
  }
}

function onMetricsHoverModal(svg, e) {
  // Lighter-weight version — same reverse mapping but uses CHARTS lookup
  // by the chart-id stored on the modal title to pick the unit fmt.
  if (!svg._geom) return;
  // Synthesize an event that the regular delegated handler can use.
  const fakeCard = document.createElement("div");
  fakeCard.className = "metrics-chart";
  // Find the chart id by walking up to the modal head's title text (best-
  // effort; keeps the tooltip generic when the title doesn't match).
  fakeCard.dataset.chart = "";
  // Easier: call the same internal logic by dispatching mousemove on the
  // svg with a synthetic pseudo-card. To avoid plumbing, just invoke
  // onMetricsHover with a fake target.
  const origTarget = e.target;
  Object.defineProperty(e, "target", { value: svg, configurable: true, get: () => svg });
  // Manually find the closest .metrics-chart ancestor — won't exist for
  // the modal, so we wrap minimally:
  const tmp = document.createElement("div");
  tmp.className = "metrics-chart";
  tmp.dataset.chart = svg.dataset.chartId || "";
  tmp.appendChild(svg.cloneNode(false));  // placeholder so .closest works
  // Simpler: just call onMetricsHover with closest ancestor real card or
  // synthesize. For now, call the handler with the real svg and let the
  // closest-up chain miss → it would clearMetricsHover. So instead inline
  // a small clone:
  const card = svg.closest(".mc-zoom-modal");
  if (!card) return;
  const geom = svg._geom;
  const rect = svg.getBoundingClientRect();
  const xRatio = (e.clientX - rect.left) / Math.max(1, rect.width);
  const xViewBox = xRatio * geom.W;
  if (xViewBox < geom.padL || xViewBox > geom.W - geom.padR) { clearMetricsHover(); return; }
  const t = geom.xMin + (xViewBox - geom.padL) / (geom.W - geom.padL - geom.padR) * (geom.xMax - geom.xMin);
  const primary = geom.series[0] || [];
  if (!primary.length) { clearMetricsHover(); return; }
  let nearest = primary[0], ndt = Infinity;
  for (const p of primary) { const d = Math.abs(p.x - t); if (d < ndt) { ndt = d; nearest = p; } }
  const tip = ensureMetricsTooltip();
  let sum = 0; for (const p of primary) sum += p.y; const mean = sum / primary.length;
  const delta = nearest.y - mean;
  const ts = new Date(nearest.x);
  const tsStr = `${String(ts.getHours()).padStart(2, "0")}:${String(ts.getMinutes()).padStart(2, "0")}:${String(ts.getSeconds()).padStart(2, "0")}`;
  const fmt = (n) => Math.abs(n) >= 1024 ? `${Math.round(n)}` : `${n.toFixed(1)}`;
  tip.innerHTML = `
    <div class="mc-tt-row mc-tt-value">${escHtml(fmt(nearest.y))}</div>
    <div class="mc-tt-row"><span class="mc-tt-k">ts</span><span class="mc-tt-v">${tsStr}</span></div>
    <div class="mc-tt-row"><span class="mc-tt-k">δ from mean</span><span class="mc-tt-v">${(delta >= 0 ? "+" : "−") + escHtml(fmt(Math.abs(delta)))}</span></div>
  `;
  tip.hidden = false;
  const tipRect = tip.getBoundingClientRect();
  let tx = e.clientX + 14, ty = e.clientY + 14;
  if (tx + tipRect.width > window.innerWidth - 8) tx = e.clientX - tipRect.width - 14;
  if (ty + tipRect.height > window.innerHeight - 8) ty = e.clientY - tipRect.height - 14;
  tip.style.left = `${Math.max(8, tx)}px`;
  tip.style.top = `${Math.max(8, ty)}px`;
  // Restore target to be safe (no-op for cloned event)
  Object.defineProperty(e, "target", { value: origTarget, configurable: true });
  // Crosshair on modal svg
  const g = svg.querySelector(".mc-cross");
  if (g) {
    g.style.display = "";
    const cx = geom.sx(nearest.x);
    const cy1 = geom.sy(nearest.y);
    const v = g.querySelector(".mc-cross-v"); if (v) { v.setAttribute("x1", cx); v.setAttribute("x2", cx); }
    const dot1 = g.querySelector(".mc-cross-dot-1"); if (dot1) { dot1.setAttribute("cx", cx); dot1.setAttribute("cy", cy1); }
  }
}

window.srwk = srwk;  // expose for devtools
window.__srwk_zoom = openChartZoomModal;  // dev: __srwk_zoom("rss-mem")
// Debug hook so the live-graph state can be inspected from devtools without
// fishing it out of the module closure. Cheap; one reference.
window.__srwk_livegraph = (function() { return livegraphState; })();

// Dev-only: synthetic event injector for visualizing DC-net family without
// a live server. Call from devtools console:
//   __srwk_inject_event("dcnet_round_started", {round_id:"r1", qid:"q-deadbeef", anonymity_set_size:5, min_set_met:true})
// Routed through the same path as a real SSE event so every panel updates.
window.__srwk_inject_event = (kind, payload = {}) => {
  const evt = { kind, payload, ts: Date.now() };
  try {
    if (kind === "anonymity_set_changed") onAnonymitySetChanged(payload);
    else if (kind === "dcnet_round_started") onDcnetRoundStarted(payload);
    else if (kind === "dcnet_round_complete") onDcnetRoundComplete(payload);
    else if (kind === "ticket_issued") onTicketIssued(payload);
    else if (kind === "ticket_redeemed") onTicketRedeemed(payload);
    else if (kind === "receipt_submitted") onReceiptSubmitted(payload);
    else if (kind === "epoch_rotated") onEpochRotated(payload);
    else if (kind === "web_search_completed") onWebSearchCompleted(payload);
  } catch (e) { console.warn("[inject]", e); }
  appendTrafficEvent(evt);
  pushTimelineTick(evt);
  try { livegraphPushFromEvent(evt); } catch (e) { console.warn("[livegraph inject]", e); }
};

boot().catch((e) => {
  console.error("[boot]", e);
  setStatus("boot failed: " + e.message, true);
});
