// ATLAS — the fifth tab.
//
// Product intent (the user, paraphrased):
//   "A graph of all my searches and my friends' searches. Constantly on
//    during a multi-week event, projected from a laptop onto a wall.
//    Calm, explorable. Form an opinion."
//
// What this is:
//   A wall map of the corpus. Each peer is a country with a soft
//   watercolor wash and a fixed centroid. Each page the network has
//   fetched is a town placed deterministically inside its country.
//   Cross-peer co-contributions are caravan routes arching between
//   countries. The composition is photographable, the layout is stable
//   across reloads, and the only motion budget is: a 30-second inhale,
//   a 6-second wet-edge ripple on arrivals, and one slow ink-mark
//   surveyor drifting over the continent.
//
// Why a separate tab (and not a new lens on graph/cartography/cosmos):
//   - graph is the 3D analyst's instrument.
//   - cartography is the streamline-flow editorial cut.
//   - cosmos is the gpu-force "let it cool" cut.
//   Atlas is the *artifact* — the thing those instruments are *of*.
//   It's the one the user wants on the wall. The aesthetic inverts
//   the dark cosmic palette of every other tab to a paper-cream
//   ground, which is what photographs.
//
// Stack:
//   Vanilla Canvas2D. No three, no d3-delaunay, no force sim. The
//   borders are a *distance-field wash* drawn at half-resolution to
//   an offscreen canvas: per-pixel nearest-centroid weighted by
//   territory size, with an exponential falloff. That gives organic
//   wet-paper edges without polygon gymnastics. Borders are derived
//   from the wash by a one-pass marching-square-ish edge detect at
//   render time and traced with a single stroke per country.
//
// Determinism / stability:
//   Country centroids placed by a Fibonacci-spiral hash of the
//   pubkey (self at the origin). Town positions placed by a per-page
//   hash within their country. Same dataset → pixel-identical render.
//   New page → previous render + one new dot, nothing moves.
//
// Public API (mirrors graph2 / cosmos):
//   mount(container)          — idempotent
//   setActive(active)         — visibility-hidden friendly; pauses rAF
//   notifyDataChanged()       — debounced rebuild
//   pulseNode(nodeId)         — wet-edge ripple on the page's country
//   unmount()                 — destroy canvas + listeners
//
// Reads from window.srwk.{nodes, edges, peers, selfPubkey}.

import { stableHue } from "./colors.js";

// ─── module state ────────────────────────────────────────────────────────

const state = {
  mounted: false,
  active: false,
  container: null,
  canvas: null,           // foreground canvas (towns, routes, names, surveyor)
  ctx: null,
  washCanvas: null,       // offscreen — L1 (peer-level) wash, kept for legacy paths
  washCtx: null,
  paperCanvas: null,      // offscreen — paper texture (drawn once)
  // Working/composite canvases used to build the per-frame masked
  // paper+world image. We render paper + world + decoration into
  // `composeCanvas`, then apply the deckle mask once at the end so the
  // territory bloom and any other map content NEVER extend past the
  // torn paper edge. `worldCanvas` is the intermediate world layer
  // (wash + sea hatching + foxing + coastlines + caravans + towns +
  // labels + surveyor) used so we can stamp the world on top of the
  // paper with `source-over` and have a single masked composite.
  composeCanvas: null,
  composeCtx: null,
  worldCanvas: null,
  worldCtx: null,
  // Terra incognita: an offscreen "engraved sea" hatching bitmap, sized
  // to match the wash so it composites under the same world transform.
  // Recomputed on data change / resize, blitted per frame.
  seaHatchCanvas: null,
  seaHatchCtx: null,
  // Deckle edge mask — alpha mask sized to the visible viewport, generated
  // once per session and re-used through pan/zoom. Multiplies into the
  // paper layer's alpha channel to give the paper a torn / irregular edge.
  deckleMaskCanvas: null,
  deckleMaskCtx: null,
  deckleMaskW: 0,
  deckleMaskH: 0,
  // Stable session token used as the deterministic-noise / phrase-placement
  // seed. Bumps once per process boot; persisted through the run so caches
  // stay coherent until restart.
  sessionSeed: 0,
  // PR D: three wash bitmaps, one per territorial level. L1 (peers/continents)
  // is the foundation, always drawn; L2 (per-host) and L3 (per-topic-cluster)
  // crossfade in by zoom. Each is recomputed only on data change or resize,
  // so per-frame cost is just a textured drawImage per level.
  washByLevel: [null, null, null],
  washCtxByLevel: [null, null, null],
  // Per-level coastline polylines (each indexed by attractor group, i.e.
  // L1: country idx, L2: region idx, L3: cluster idx). Same structure as
  // the legacy state.coastlines, kept per level so each can stroke at
  // its own weight + color.
  coastlinesByLevel: [null, null, null],
  // Per-level metadata for coastline strokes — color (a representative
  // tint) and the parent country reference (for pulse/halo passes).
  coastMetaByLevel: [null, null, null],
  raf: 0,
  resizeObs: null,
  reducedMotion: false,
  // Layout outputs (rebuilt on data change)
  countries: [],          // [{pk, color, cx, cy, r, towns:[{x,y,id,host,fetched_at}], pageCount, recent24h}]
  countryById: new Map(), // pk -> country
  townById: new Map(),    // page id -> {country, town}
  caravans: [],           // cross-peer edges
  // Pulse state (per-country wet-edge animation)
  pulses: new Map(),      // pk -> { startMs, durationMs }
  // Surveyor
  surveyor: { x: 0, y: 0, vx: 0, vy: 0, t: 0 },
  // Cartouche/legend HTML overlays
  cartouche: null,
  legend: null,
  hoverLabel: null,       // floating panel beside the pointer (PR B)
  resetBtn: null,         // small "· reset" button bottom-right of canvas
  // Composition viewport (world coords mapped to canvas px)
  // PR B: viewport is the user-controlled pan + zoom layered on top of the
  // base world-to-canvas mapping. cur is the rendered state, target is what
  // we're easing toward (~120ms ease-out). tx/ty are CSS pixels in canvas
  // space; scale is multiplicative over the base "fit world to canvas" factor.
  viewport: { tx: 0, ty: 0, scale: 1 },
  viewportTarget: { tx: 0, ty: 0, scale: 1 },
  viewportDirty: false,
  worldRadius: 1100,      // logical world bounds; the camera frames this
  // Visible frame: the rectangle (in canvas device-pixels) where the
  // map is centered, computed from the canvas size minus reservations
  // for the cartouche (top-left) and legend (bottom-right). Recomputed
  // on resize. The camera centers the world in this rectangle and the
  // base "fit world to canvas" projection scales to fit it. Seeded to
  // a non-zero default so worldToScreen is safe to call before the
  // first resize().
  frame: { cx: 1, cy: 1, w: 2, h: 2, span: 2 },
  // Drag state — distinguish click from drag with a 3px movement threshold.
  drag: {
    active: false,
    startX: 0, startY: 0,
    lastX: 0, lastY: 0,
    pixelsMoved: 0,
    pointerDown: false,
    capturedId: 0,
  },
  // Idle / projection-mode reset. Any user interaction resets this; after
  // 60s of no input the view tweens back to home over ~1.6s.
  lastInteractionTs: 0,
  idleReturnAnim: null,   // { startMs, fromTx, fromTy, fromScale, durationMs }
  hoverNodeId: null,      // currently-hovered town id (for ink halo + cursor)
  // PR C: snapshot diff
  lastSeenAt: 0,          // epoch ms — towns newer than this halo
  newSinceLastVisit: 0,   // count of new towns this mount
  diffMountedAt: 0,       // perf.now() at mount, for the 60s pulse window
  // PR C: time-lapse
  timelapse: {
    active: false,
    rangeKey: "7d",
    speedKey: "med",
    nowMs: 0,           // simulated wall-clock during replay
    startSimMs: 0,      // sim time at start of range
    endSimMs: 0,        // sim time at end (real now)
    lastTickPerf: 0,    // perf.now() at last frame for dt
    scrubbing: false,
    scrubber: null,     // host element
    scrubberKnob: null,
  },
  // Bookkeeping
  rebuildPending: false,
  rebuildTimer: 0,
  startTs: 0,
  lastFrameTs: 0,
  sessionStart: Date.now(),
  // Persisted state
  hoverIdx: -1,
};

// PR B: viewport tuning constants.
const VIEW_MIN_SCALE = 0.5;
const VIEW_MAX_SCALE = 16;
// Damping τ for the ease-out toward viewportTarget. Lower = snappier.
// 70ms means a wheel tick visibly resolves in ~150ms (roughly 2τ),
// well under the user's "feels instant" threshold.
const VIEW_DAMP_MS = 70;
const VIEW_IDLE_RESET_MS = 60 * 1000; // 60s before auto-reset begins
const VIEW_IDLE_TWEEN_MS = 1600;      // duration of the slow auto-reset
const DRAG_PIXEL_THRESHOLD = 3;       // movement that distinguishes drag from click
const VIEWPORT_LS_KEY = "srwk:atlas:viewport";

// PR B: zoom-aware label thresholds. Treated as smooth crossfades.
const ZOOM_MID_BAND = [1.0, 1.4];     // territory→sub-region crossfade
const ZOOM_CLOSE_BAND = [3.6, 4.4];   // sub-region→title crossfade

// PR D: scale-aware territories (peers → hosts → topics). Each level has
// its own watercolor wash + coastline; layers crossfade by camera zoom so
// the map gains detail as the camera flies in. Sigmoid math:
//   levelOpacity(zoom, threshold, width) = 1 / (1 + exp(-(zoom - thr) / w))
// Level 1 (peers, "continents")        — opacity 1 always.
// Level 2 (per-host, "countries")      — fades in 1.1 → 1.7 (thr 1.4, w 0.18).
// Level 3 (topic clusters, "provinces") — fades in 3.5 → 4.5 (thr 4.0, w 0.30).
// w is chosen so the sigmoid covers the [0.05, 0.95] range over the listed
// fade window — a natural-feeling 90% transition zone.
const LEVEL_PEER = 0;
const LEVEL_HOST = 1;
const LEVEL_TOPIC = 2;
const L2_THRESHOLD = 1.4;
const L2_WIDTH = 0.18;
const L3_THRESHOLD = 4.0;
const L3_WIDTH = 0.30;
// Above this zoom the L1 peer coastline has done its job and drops to a
// faint hairline so it doesn't fight the L2/L3 detail underneath.
const L1_FADE_TO_HAIRLINE = 4.0;
// TF-IDF clustering caps per host. Hosts smaller than MIN_CLUSTER_PAGES
// keep one cluster (no point fragmenting <8 pages); above we aim for
// ~CLUSTERS_PER_HOST_TARGET clusters.
const MIN_CLUSTER_PAGES = 8;
const CLUSTERS_PER_HOST_MIN = 3;
const CLUSTERS_PER_HOST_MAX = 7;
// Stop-words that appear so often in URLs/titles they tell us nothing.
// We treat this as a single union — used by L2 host naming, L3 cluster
// naming, and the c-TF-IDF concept extractor. Two big buckets:
//   1. Standard English stop words (function words, common verbs).
//   2. A publishing/web blocklist — generic words found in *any* paper,
//      article, or news item that crowd out the actually distinctive
//      concept tokens. These are the words that produce labels like
//      "STUDY" or "RESEARCH" instead of "predictive coding".
const STOPWORDS = new Set([
  // English function words / common verbs
  "the","a","an","of","and","or","to","in","on","for","with","by","at",
  "from","is","are","was","were","be","been","being","this","that","it",
  "as","but","if","then","than","into","onto","over","under","about",
  "after","before","between","through","during","while","when","where",
  "what","who","whom","whose","which","why","how","not","no","yes","do",
  "does","did","done","doing","have","has","had","having","can","could",
  "should","would","may","might","must","will","shall","its","their",
  "them","they","you","your","yours","our","ours","his","her","hers",
  "him","she","he","we","us","i","me","my","mine","one","two","three",
  "four","five","six","seven","eight","nine","ten","also","very","much",
  "many","some","any","all","most","more","less","few","new","old","now",
  "here","there","other","another","such","each","every","just","only",
  "still","yet","ever","never",
  // URL noise / generic web tokens
  "www","com","org","net","io","co","gov","edu","uk","html","htm","php",
  "aspx","jsp","amp","cgi","bin","index","page","pages","main","home",
  "search","login","signup","admin","static","assets","cdn","node",
  "entry","story","viewer","viewdoc","item","items","files","file",
  "data","info","section","subject","content",
  // Publishing / scholarly noise — these crowd the c-TF-IDF
  "paper","papers","article","articles","journal","journals","research",
  "study","studies","review","reviews","preprint","manuscript",
  "abstract","online","download","view","full","text","figure","figures",
  "table","tables","appendix","supplementary","references","citations",
  "doi","isbn","issn","arxiv","pubmed","ncbi","frontiers",
  "post","posts","blog","blogs","news","update","updates","story","stories",
  "topic","topics","abs","pdf",
  // Months + common time words
  "january","february","march","april","may","june","july","august",
  "september","october","november","december",
  "monday","tuesday","wednesday","thursday","friday","saturday","sunday",
  "today","yesterday","tomorrow","week","month","year","years",
  // Year tokens — sweep common spans so 2024/2025 papers don't all label "2024"
  "2018","2019","2020","2021","2022","2023","2024","2025","2026","2027",
  // Misc generic
  "intro","introduction","summary","overview","guide","tutorial","faq",
  "about","contact","privacy","terms","cookies","policy","copyright",
  "article-",
]);

// Issue #42: drop junk-content pages before clustering. Two known
// categories of noise from upstream indexing:
//   • 404 / "Page not found" responses indexed as if they were pages.
//   • Lab / publication landing pages whose <title> is literally
//     "Publications" or "Welcome".
// The right fix is upstream in swf-node (sibling issue filed); this is
// the viz-side mitigation so the cluster naming + layout aren't poisoned
// while the indrex still has those rows.
//
// Match is case-insensitive against the *trimmed* title. We use exact
// equality (after trim/lower) for short labels so we don't accidentally
// drop legitimate pages whose title contains the word — e.g. "Welcome to
// the Jungle (1991 film)" should survive, but a page titled exactly
// "Welcome" should not.
const JUNK_TITLE_EXACT = new Set([
  "404", "404 not found", "not found", "page not found",
  "publications", "welcome", "untitled", "untitled document",
  "loading…", "loading...", "loading",
  "access denied", "forbidden", "403 forbidden",
]);
// Also drop pages whose title is too short to carry signal. Shorter
// than this, the title is almost certainly a placeholder or an HTML-
// entity-stripped fragment.
const JUNK_TITLE_MIN_LEN = 3;

function isJunkTitle(title) {
  if (!title) return true;
  const t = String(title).trim().toLowerCase();
  if (t.length < JUNK_TITLE_MIN_LEN) return true;
  if (JUNK_TITLE_EXACT.has(t)) return true;
  // Pattern: "<n> not found" / "error <n>" — broad enough to catch the
  // long tail without sniping legitimate titles.
  if (/^(error\s+)?[345]\d\d(\s+(not\s+found|forbidden|server\s+error))?$/.test(t)) {
    return true;
  }
  return false;
}

// Issue #42: dominance gate for cluster labels. The c-TF-IDF top token
// is only meaningful when it stands well above the runner-ups; if it's
// barely ahead of the noise, the cluster is genuinely diffuse and a
// confident label would mislead. We compare the winner's score against
// the AVERAGE of the next few non-overlapping candidates (not just the
// single second-best, which can be biased by a near-duplicate). Below
// this ratio, we render "(diffuse)" or no label rather than confidently
// mislabeling.
const DOMINANCE_RATIO = 1.5;
const DOMINANCE_PEERS = 3;

// Issue #42: emit two-token labels ("alignment · rlhf") when there's a
// confident second concept. More honest than a single distinctive token
// when the cluster has more than one strong theme.
const TOP2_MIN_SECOND_RATIO = 0.6;

// PR C: snapshot diff — halo any town whose fetched_at is newer than the
// user's last-seen timestamp. The halo pulses for ~60s after mount, then
// settles to a calm static glow until the user clears it or returns later.
const LAST_SEEN_LS_KEY = "srwk:atlas:lastSeenAt";
const DIFF_PULSE_LOOP_MS = 60 * 1000;   // pulse for 60s, then static
const DIFF_PULSE_PERIOD_MS = 3000;      // 0.4 → 0.15 → 0.4 over 3s

// PR C: time-lapse — `T` toggles cinematic replay of the last N days.
const TIMELAPSE_RANGES = {
  "1d":  86400000,
  "7d":  86400000 * 7,
  "30d": 86400000 * 30,
  "all": Infinity,
};
const TIMELAPSE_SPEED_MS_PER_DAY = {
  slow: 10000,
  med:  5000,
  fast: 3000,
};

// Palette — paper-cream ground, ink for type, soft warm shadow.
const PAPER = "#F2EBDC";
const PAPER_DEEP = "#E7DDC7";
const INK = "#1A1410";
const INK_2 = "#3A2E22";
const INK_3 = "#6A5947";
const INK_4 = "#A89C84";
const HORIZON = "#D9CDB3";

const TAU = Math.PI * 2;
const GOLDEN = (1 + Math.sqrt(5)) / 2;

// ─── public API ──────────────────────────────────────────────────────────

export function mount(container) {
  if (state.mounted) {
    if (state.container !== container) state.container = container;
    return;
  }
  state.container = container;
  state.reducedMotion = !!(window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  state.startTs = performance.now();

  // Permanent crash-trap so per-frame TypeErrors land in /tmp/viz-start.log
  // with a full stack trace, not just the bare "Cannot read properties of
  // undefined" message. The earlier per-frame crash in computeDryEdgesForLevel
  // (fractional cw/ch indexing an Int16Array → undefined → guard slipped →
  // perOwner[undefined].push) was diagnosed by this trap; leaving it
  // installed means the next regression in the wash/render hot path is
  // diagnosable from the log without a redeploy. Gated on a flag so we
  // only install once per page even with re-mounts, and rate-limited so a
  // crashing frame loop doesn't flood the log forever.
  if (!window.__atlasErrTrapInstalled) {
    window.__atlasErrTrapInstalled = true;
    let lastSig = "";
    let sigCount = 0;
    const MAX_SIG = 3;
    window.addEventListener("error", (e) => {
      try {
        const stack = (e && e.error && e.error.stack) ? e.error.stack : (e && e.message) || "(no stack)";
        const sig = stack.split("\n").slice(0, 3).join(" | ");
        if (sig === lastSig) {
          sigCount++;
          if (sigCount > MAX_SIG) return;
        } else {
          lastSig = sig;
          sigCount = 1;
        }
        // eslint-disable-next-line no-console
        console.error("[atlas-trap]", stack);
      } catch {}
    });
    window.addEventListener("unhandledrejection", (e) => {
      try {
        const reason = e && e.reason;
        const stack = (reason && reason.stack) ? reason.stack : String(reason);
        // eslint-disable-next-line no-console
        console.error("[atlas-trap-rejection]", stack);
      } catch {}
    });
  }

  // Surveyor seed-position. We pick a stable starting point so the
  // very first frame doesn't show a wandering mark popping in.
  state.surveyor.x = 0;
  state.surveyor.y = 0;
  state.surveyor.t = 0;

  // ── canvas (foreground) ──────────────────────────────────────────────
  const canvas = document.createElement("canvas");
  canvas.className = "atlas-canvas";
  container.appendChild(canvas);
  state.canvas = canvas;
  state.ctx = canvas.getContext("2d");

  // Offscreen wash + paper canvases. Wash runs at half-resolution for the
  // distance-field pass; the foreground compositing then upscales it with
  // image-smoothing for the wet-paper bleed. Paper is full-res so the
  // grain stays crisp.
  state.washCanvas = document.createElement("canvas");
  // willReadFrequently: true → Canvas2D back-end uses a CPU-side
  // ImageData buffer. We do exactly one putImageData per data change
  // and then composite that buffer onto the foreground every frame, so
  // the CPU path is what we want here.
  state.washCtx = state.washCanvas.getContext("2d", { willReadFrequently: true });
  // PR D: per-level wash canvases. The same dimension / config as
  // washCanvas; the level-0 entry doubles as state.washCanvas.
  for (let i = 0; i < 3; i++) {
    if (i === 0) {
      state.washByLevel[0] = state.washCanvas;
      state.washCtxByLevel[0] = state.washCtx;
    } else {
      const c = document.createElement("canvas");
      state.washByLevel[i] = c;
      state.washCtxByLevel[i] = c.getContext("2d", { willReadFrequently: true });
    }
  }
  state.paperCanvas = document.createElement("canvas");
  // Composite canvases — sized in `resize()` to match canvas device-pixels.
  state.composeCanvas = document.createElement("canvas");
  state.composeCtx = state.composeCanvas.getContext("2d");
  state.worldCanvas = document.createElement("canvas");
  state.worldCtx = state.worldCanvas.getContext("2d");

  // Terra incognita: a sea-hatching bitmap that lives at wash resolution.
  // Painted in `paintSeaHatching()` after each wash repaint so it always
  // matches the current territory layout and zoom-out concentric pattern.
  state.seaHatchCanvas = document.createElement("canvas");
  state.seaHatchCtx = state.seaHatchCanvas.getContext("2d", { willReadFrequently: true });

  // Stable per-session seed for the procedural paper noise + foxing spots
  // + terra-incognita phrase placement. mulberry32 over the boot ts gives a
  // 32-bit hash distinct between reloads but stable through one run.
  state.sessionSeed = (Date.now() ^ 0x9E3779B1) >>> 0;

  // ── overlays (HTML, not canvas) ──────────────────────────────────────
  // Cartouche (top-left): title block + session/day/time.
  const cart = document.createElement("div");
  cart.className = "atlas-cartouche";
  cart.innerHTML = `
    <div class="atl-cart-rule" aria-hidden="true"></div>
    <div class="atl-cart-stack">
      <div class="atl-cart-title">atlas of the world knowledge corpus</div>
      <div class="atl-cart-meta">
        <span class="atl-cart-tag">session</span>
        <span class="atl-cart-val" id="atl-session">·</span>
        <span class="atl-cart-sep">·</span>
        <span class="atl-cart-tag">day</span>
        <span class="atl-cart-val" id="atl-day">·</span>
        <span class="atl-cart-sep">·</span>
        <span class="atl-cart-val atl-cart-time" id="atl-time">—</span>
      </div>
      <div class="atl-cart-coord" id="atl-coord">— · —</div>
      <div class="atl-cart-diff" id="atl-diff" hidden>
        <span class="atl-cart-diff-tag">new since last visit</span>
        <span class="atl-cart-diff-val" id="atl-diff-val">+0</span>
      </div>
    </div>
    <div class="atl-cart-rule" aria-hidden="true"></div>
  `;
  container.appendChild(cart);
  state.cartouche = cart;

  // Legend (bottom-right): per-peer color + page count + 24h delta.
  const legend = document.createElement("div");
  legend.className = "atlas-legend";
  legend.innerHTML = `
    <div class="atl-leg-head">
      <span class="atl-leg-tag">legend</span>
      <span class="atl-leg-sep">·</span>
      <span class="atl-leg-meta" id="atl-leg-total">—</span>
    </div>
    <div class="atl-leg-list" id="atl-leg-list"></div>
    <div class="atl-leg-foot">
      <span class="atl-leg-foot-key">scale</span>
      <span class="atl-leg-foot-rule"></span>
      <span class="atl-leg-foot-val">200 pages</span>
    </div>
    <div class="atl-leg-actions" id="atl-leg-actions" hidden>
      <button class="atl-leg-clear" type="button" id="atl-leg-clear" title="clear the new-since-last-visit halos">
        <span class="atl-leg-clear-dot" aria-hidden="true">·</span><span>clear new</span>
      </button>
    </div>
  `;
  container.appendChild(legend);
  state.legend = legend;
  // Wire the clear-new button. We set up the listener once at mount.
  const clearBtn = legend.querySelector("#atl-leg-clear");
  if (clearBtn) {
    clearBtn.addEventListener("click", () => persistLastSeenNow());
  }

  // Hover read-out (PR B): a small floating panel that follows the pointer
  // when over a town. Shows title / host / peer / degree in the same
  // typographic voice as the cartography hover panel — italic serif title,
  // mono small-caps labels.
  const hov = document.createElement("div");
  hov.className = "atlas-hover";
  hov.hidden = true;
  container.appendChild(hov);
  state.hoverLabel = hov;

  // Reset button (bottom-left of canvas, lowercase italic). Click → snap
  // viewport home. Cmd-0 also bound (see global keydown wiring below).
  const reset = document.createElement("button");
  reset.className = "atlas-reset";
  reset.type = "button";
  reset.innerHTML = `<span class="atl-reset-dot" aria-hidden="true">·</span><span class="atl-reset-label">reset</span>`;
  reset.title = "reset view (⌘0)";
  reset.addEventListener("click", (e) => {
    e.stopPropagation();
    resetViewportNow();
    markInteraction();
  });
  container.appendChild(reset);
  state.resetBtn = reset;

  // ── interactions ────────────────────────────────────────────────────
  // PR B: full pan + zoom + click. Pointer-down captures the pointer so
  // a drag that exits the canvas still keeps us in drag mode; we
  // distinguish click from drag by total pixel travel.
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerCancel);
  canvas.addEventListener("pointerleave", onPointerLeave);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  // Keyboard: Cmd-0 to reset. Bound on document because the canvas
  // itself doesn't take focus (button-less).
  state._onKey = (e) => {
    if (!state.active) return;
    if ((e.metaKey || e.ctrlKey) && e.key === "0") {
      e.preventDefault();
      resetViewportNow();
      markInteraction();
      return;
    }
    // Don't capture single-letter keys when an input/textarea has focus.
    const tag = e.target?.tagName?.toUpperCase();
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (e.target?.isContentEditable) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "t" || e.key === "T") {
      e.preventDefault();
      toggleTimelapse();
    } else if (e.key === "Escape" && state.timelapse.active) {
      e.preventDefault();
      stopTimelapse();
    } else if (e.key === "+" || e.key === "=") {
      // Sprint 2026-05-02: keyboard zoom for screenshot harnesses.
      // `+`/`=` zooms in 2×, `-`/`_` zooms out 2×, both around the
      // canvas centre. Animates via the existing tween.
      e.preventDefault();
      const next = clamp(state.viewportTarget.scale * 1.5, VIEW_MIN_SCALE, VIEW_MAX_SCALE);
      state.viewportTarget.scale = next;
      markInteraction();
    } else if (e.key === "-" || e.key === "_") {
      e.preventDefault();
      const next = clamp(state.viewportTarget.scale / 1.5, VIEW_MIN_SCALE, VIEW_MAX_SCALE);
      state.viewportTarget.scale = next;
      markInteraction();
    }
  };
  document.addEventListener("keydown", state._onKey);

  // Restore persisted viewport. We open at fit-to-view (home) on every
  // mount — a stale persisted scale was making the map look super-
  // zoomed-in on launch and kicking off a glacial wheel-back. The
  // viewport is still persisted on each interaction so the dev hooks
  // and Cmd-0 round-trip works, but cold-start always boots calm.
  // (The legend's `· clear new` reset path lives elsewhere; this just
  // governs initial framing.)
  state.viewport.tx = 0; state.viewport.ty = 0; state.viewport.scale = 1;
  state.viewportTarget.tx = 0; state.viewportTarget.ty = 0; state.viewportTarget.scale = 1;
  try { localStorage.removeItem(VIEWPORT_LS_KEY); } catch {}
  // Sprint 2026-05-02 dev hook: a screenshot harness can set
  //   localStorage.setItem("srwk:atlas:debug-initial-zoom", "2")
  // before launch to land at a non-default zoom on mount. This is a
  // dev-only escape hatch (no UI surfaces it) — production launches
  // always boot at scale 1.
  try {
    const raw = localStorage.getItem("srwk:atlas:debug-initial-zoom");
    const z = raw ? parseFloat(raw) : NaN;
    if (Number.isFinite(z) && z >= VIEW_MIN_SCALE && z <= VIEW_MAX_SCALE) {
      state.viewport.scale = z;
      state.viewportTarget.scale = z;
    }
  } catch {}
  state.lastInteractionTs = performance.now();

  // PR C: snapshot-diff bookkeeping. Read lastSeenAt; any town whose
  // fetched_at is newer halos for ~60 s of pulse + then a static glow.
  // We update lastSeenAt on tab-switch-away (setActive(false)) and on
  // page unload — see those paths below.
  try {
    const raw = localStorage.getItem(LAST_SEEN_LS_KEY);
    state.lastSeenAt = raw ? Number(raw) || 0 : 0;
  } catch { state.lastSeenAt = 0; }
  state.diffMountedAt = performance.now();
  // beforeunload — capture the moment before reload so the next mount
  // has an honest "since last visit" frame of reference.
  state._onBeforeUnload = () => persistLastSeenNow();
  window.addEventListener("beforeunload", state._onBeforeUnload);

  // ── resize ──────────────────────────────────────────────────────────
  resize();
  if (window.ResizeObserver) {
    state.resizeObs = new ResizeObserver(() => resize());
    state.resizeObs.observe(container);
  } else {
    window.addEventListener("resize", resize);
  }

  state.mounted = true;

  // initial build (data may already be in window.srwk.nodes)
  buildFromData();

  // tick clocks once so the cartouche reads correctly on first paint
  updateCartouche();

  // start the loop; setActive will gate it
  if (!state.raf) loop();
}

export function setActive(v) {
  const wasActive = state.active;
  state.active = !!v;
  if (state.active && !wasActive) {
    // entering — refresh the layout cache (the canvas was 0×0 while the
    // section was display:none; resize forces a redraw at the right ratio)
    requestAnimationFrame(() => {
      resize();
      paintWash();
    });
  }
  // PR C: capture lastSeenAt when leaving the atlas tab. The next mount
  // will halo any towns whose fetched_at is newer than this moment.
  if (!state.active && wasActive) {
    persistLastSeenNow();
  }
  if (!state.raf && state.active) loop();
}

export function notifyDataChanged() {
  if (state.rebuildPending) return;
  state.rebuildPending = true;
  if (state.rebuildTimer) clearTimeout(state.rebuildTimer);
  state.rebuildTimer = setTimeout(() => {
    state.rebuildPending = false;
    buildFromData();
    paintWash();
  }, 250);
}

export function pulseNode(nodeId) {
  if (!state.mounted) return;
  const hit = state.townById.get(nodeId);
  if (!hit) return;
  // Wet-edge ripple on the country containing this town. New pages = a
  // brief bloom along the country's perimeter, then it dries back.
  const pk = hit.country.pk;
  state.pulses.set(pk, {
    startMs: performance.now(),
    durationMs: state.reducedMotion ? 1800 : 6000,
  });
  // The wash itself is unaffected — only the dry-edge stroke thickens
  // and saturates. Re-rendered each frame from cached wash data.
}

// PR B: small dev hook for programmatic viewport control. Useful in
// devtools to set zoom/pan from the console:
//   __srwk_atlas.setViewport({ scale: 4, tx: 0, ty: 0 })
//   __srwk_atlas.viewport()
// Not part of the user-facing API; safe to leave because it only mutates
// in-memory state and persists nothing the user wouldn't already produce
// via the canvas interactions.
if (typeof window !== "undefined") {
  window.__srwk_atlas = {
    viewport: () => ({ ...state.viewport, target: { ...state.viewportTarget } }),
    setViewport: ({ tx = 0, ty = 0, scale = 1 } = {}) => {
      const s = clamp(scale, VIEW_MIN_SCALE, VIEW_MAX_SCALE);
      state.viewportTarget.tx = tx;
      state.viewportTarget.ty = ty;
      state.viewportTarget.scale = s;
      state.viewport.tx = tx;
      state.viewport.ty = ty;
      state.viewport.scale = s;
      markInteraction();
      persistViewport();
    },
    reset: () => resetViewportNow(),
    timelapse: () => state.timelapse,
    startTimelapse: (rangeKey, speedKey) => {
      if (rangeKey) state.timelapse.rangeKey = rangeKey;
      if (speedKey) state.timelapse.speedKey = speedKey;
      startTimelapse();
    },
    stopTimelapse: () => stopTimelapse(),
    seekTimelapse: (u01) => {
      const tl = state.timelapse;
      if (!tl.active) return;
      tl.nowMs = tl.startSimMs + (tl.endSimMs - tl.startSimMs) * clamp(u01, 0, 1);
    },
    // Dev/test only — synthesize a wheel event over the canvas centre
    // so a screenshot harness can verify zoom without needing the OS
    // to dispatch a real scroll.
    testWheel: (deltaY = -300) => {
      const c = state.canvas;
      if (!c) return null;
      const r = c.getBoundingClientRect();
      const ev = new WheelEvent("wheel", {
        deltaY,
        deltaMode: 0,
        clientX: r.left + r.width / 2,
        clientY: r.top + r.height / 2,
        bubbles: true, cancelable: true,
      });
      c.dispatchEvent(ev);
      return { vp: { ...state.viewport }, target: { ...state.viewportTarget } };
    },
    persistLastSeenNow: () => persistLastSeenNow(),
    setLastSeenAt: (epochMs) => {
      state.lastSeenAt = +epochMs || 0;
      try { localStorage.setItem(LAST_SEEN_LS_KEY, String(state.lastSeenAt)); } catch {}
      buildFromData();
      paintWash();
    },
    // Dev: synthesize a hover at the centre of the first matching town
    // (helpful for screenshot harness — cursor positioning is unreliable
    // when the OS doesn't render the cursor in screencapture). Returns
    // an object with screen coordinates so a test runner can position
    // the OS cursor too. Pins the panel for `pinMs` ms (default 4000)
    // so the screenshot harness can capture it before it's auto-hidden
    // by a real pointerleave.
    // PR D: peek at the territorial hierarchy. Returns a cheap summary of
    // levels (peer count, sub-region count, cluster count) plus a sample
    // of cluster top-tokens by host so it's easy to verify the TF-IDF
    // pass produced something meaningful. Read-only.
    inspectTerritories: () => {
      const populated = state.populatedCountries || [];
      const sum = {
        peers: populated.length,
        subRegions: 0,
        clusters: 0,
        byHost: {},
      };
      for (const c of populated) {
        for (const r of (c.regions || [])) {
          sum.subRegions++;
          const cls = r.clusters || [];
          sum.clusters += cls.length;
          if (!sum.byHost[r.host]) {
            sum.byHost[r.host] = {
              pages: r.pageCount,
              clusters: cls.map((cl) => ({
                token: cl.topToken,
                size: cl.towns.length,
              })),
            };
          }
        }
      }
      return sum;
    },
    // Dump derived c-TF-IDF concept names so a screenshot harness or a
    // human in devtools can verify the labels actually look like real
    // place names. Returns one entry per peer with peer-level themes
    // and the L2/L3 names attached. console.table-friendly.
    dumpLabels: () => {
      const populated = state.populatedCountries || [];
      const out = [];
      for (const c of populated) {
        out.push({
          peer: c.nickname || c.pk,
          pageCount: c.pageCount,
          peerThemes: c.peerThemes ? c.peerThemes.join(" · ") : null,
          regions: (c.regions || [])
            .filter((r) => r.host && r.host !== "(no host)" && r.host !== "(fields)")
            .map((r) => ({
              host: r.host,
              pages: r.pageCount,
              concept: r.conceptName || null,
              kind: r.conceptKind || null,
              confident: !!r.conceptConfident,
              score: r.conceptScore == null ? null : Number(r.conceptScore.toFixed(4)),
              second: r.conceptSecondScore == null ? null : Number(r.conceptSecondScore.toFixed(4)),
              clusters: (r.clusters || [])
                .filter((cl) => cl.towns && cl.towns.length >= 3)
                .map((cl) => `${cl.topToken || "(none)"}:${cl.towns.length}`),
            })),
        });
      }
      return out;
    },
    // Sprint 2026-05-02: dump topic-cluster summary for cluster-quality
    // verification. Returns one row per cluster with the c-TF-IDF concept
    // label, the page count, and 5 sample titles chosen as the pages
    // CLOSEST to the cluster centroid in SVD space — i.e. the "most
    // representative" pages, not the first 5 in arbitrary order. This
    // gives a much fairer read on whether a cluster is topic-coherent.
    dumpClusters: () => {
      const populated = state.populatedCountries || [];
      const topo = state.topoResult;
      const out = [];
      const idToTitle = new Map();
      for (const c of populated) for (const t of c.towns) idToTitle.set(t.id, t.title || t.id || "");
      for (const c of populated) {
        let samples;
        if (topo && topo.embedding && topo.centroidsNd && topo.pageIds && topo.assignments) {
          // Find the 5 pages assigned to this cluster with the highest
          // cosine similarity to the cluster's Nd centroid (= most
          // representative pages of the cluster).
          const D = TOPIC_SVD_DIMS;
          const cv = topo.centroidsNd[c.clusterId];
          const scored = [];
          // Centroid is unit-normalized; embedding rows are too. So
          // similarity = sum(emb[i] * cv).
          for (let i = 0; i < topo.assignments.length; i++) {
            if (topo.assignments[i] !== c.clusterId) continue;
            let s = 0;
            const off = i * D;
            for (let j = 0; j < D; j++) s += topo.embedding[off + j] * cv[j];
            scored.push({ id: topo.pageIds[i], score: s });
          }
          scored.sort((a, b) => b.score - a.score);
          samples = scored.slice(0, 5).map((s) => idToTitle.get(s.id) || s.id);
        } else {
          samples = (c.towns || []).slice(0, 5).map((t) => t.title || t.id || "");
        }
        out.push({
          id: c.clusterId,
          label: c.conceptName || c.nickname || `cluster ${c.clusterId}`,
          // Issue #42: what the wall actually shows. Differs from
          // `label` when the dominance gate flips on (`(diffuse)`)
          // or when a confident second theme produces "x · y".
          display_label: (c.peerThemes && c.peerThemes[0]) ||
            c.nickname || c.conceptName || `cluster ${c.clusterId}`,
          is_diffuse: !!c.conceptDiffuse,
          page_count: c.pageCount,
          sample_titles: samples,
        });
      }
      return out;
    },
    // Inspect raw topic-clustering output (cluster centroids, perf, etc.).
    inspectTopo: () => {
      const t = state.topoResult || null;
      if (!t) return null;
      return {
        k: t.k,
        perfMs: t.perfMs,
        fromCache: t.fromCache,
        clusterCounts: (t.clusters || []).map((c) => c.pageCount),
      };
    },
    hoverFirstTown: (predicate, pinMs) => {
      const populated = state.populatedCountries || state.countries;
      let chosen = null, chosenC = null;
      outer:
      for (const c of populated) {
        for (const t of c.towns) {
          if (!predicate || predicate(t, c)) { chosen = t; chosenC = c; break outer; }
        }
      }
      if (!chosen) return null;
      const [sx, sy] = worldToScreen(chosen.x, chosen.y);
      // Convert canvas-px (device) back to CSS-px for clientX/Y.
      const rect = state.canvas.getBoundingClientRect();
      const dpr = state.canvas.width / Math.max(1, rect.width);
      const cssX = sx / dpr;
      const cssY = sy / dpr;
      state.hoverNodeId = chosen.id;
      showHoverPanel(rect.left + cssX, rect.top + cssY, chosen, chosenC);
      // Pin: re-set hidden=false on each frame for pinMs ms so a real
      // pointerleave from the cursor exiting the canvas doesn't bury it
      // before the screencapture fires.
      const hold = pinMs == null ? 4000 : pinMs;
      const t0 = performance.now();
      const re = () => {
        if (!state.hoverLabel) return;
        state.hoverLabel.hidden = false;
        state.hoverNodeId = chosen.id;
        if (performance.now() - t0 < hold) requestAnimationFrame(re);
      };
      requestAnimationFrame(re);
      return {
        id: chosen.id, host: chosen.host, title: chosen.title,
        screenX: rect.left + cssX, screenY: rect.top + cssY,
      };
    },
  };
}

export function unmount() {
  if (!state.mounted) return;
  state.active = false;
  cancelAnimationFrame(state.raf);
  state.raf = 0;
  try { state.resizeObs?.disconnect?.(); } catch {}
  if (state._onKey) {
    try { document.removeEventListener("keydown", state._onKey); } catch {}
    state._onKey = null;
  }
  if (state._onBeforeUnload) {
    try { window.removeEventListener("beforeunload", state._onBeforeUnload); } catch {}
    state._onBeforeUnload = null;
  }
  if (state.canvas?.parentElement) state.canvas.parentElement.removeChild(state.canvas);
  if (state.cartouche?.parentElement) state.cartouche.parentElement.removeChild(state.cartouche);
  if (state.legend?.parentElement) state.legend.parentElement.removeChild(state.legend);
  if (state.hoverLabel?.parentElement) state.hoverLabel.parentElement.removeChild(state.hoverLabel);
  if (state.resetBtn?.parentElement) state.resetBtn.parentElement.removeChild(state.resetBtn);
  state.mounted = false;
}

// ─── data → countries + towns ────────────────────────────────────────────

function buildFromData() {
  const srwk = window.srwk;
  if (!srwk || !srwk.nodes) return;

  const nodes = srwk.nodes;
  const peers = srwk.peers || new Map();
  const selfPubkey = srwk.selfPubkey || null;

  // Sprint 2026-05-02: ATLAS countries are now TOPIC clusters, not peers.
  // We compute K=15 topic clusters from page titles via TF-IDF → SVD →
  // k-means → MDS, then turn each cluster into a country. Peers and hosts
  // drop out of layout entirely; they survive as page metadata
  // (hover-panel + legend, both keyed by pubkey).
  //
  // Steps:
  //   1) Collect every page; hash-of-IDs is the cache key for the pipeline.
  //   2) buildTopicClusters(pages) → cluster centroids in 2D world coords,
  //      per-page positions inside their cluster's disk.
  //   3) Build one country per cluster. cx/cy = MDS centroid; r scales
  //      with sqrt(page_count); color from a stable hue derived from the
  //      cluster's hash.
  //   4) Within each cluster, split pages into 2-3 spatial sub-regions
  //      (by quantizing page positions into spatial buckets) so L2 wash +
  //      coastlines still have something to render at mid-zoom.
  //   5) c-TF-IDF cluster naming: each cluster becomes one "territory" and
  //      we name it against the other clusters. Drop the host-aware path
  //      since host is no longer part of the territory definition.
  //   6) Caravans, world bounds, legend, etc. (mostly unchanged).

  const now = Date.now();
  const ONE_DAY = 86400000;

  // 1) Page list. Each page carries id, title, host, primary_contributor,
  // fetched_at. We pass a flat array to buildTopicClusters.
  //
  // Issue #42 mitigation: drop junk-content pages (404s, "Publications"
  // landing pages, etc.) before they pollute the TF-IDF pass. Without
  // this filter two of the 15 dev-corpus clusters were named `found`
  // (25 pages of 404s) and `publications` (17 lab landing pages). The
  // upstream fix lives in swf-node scrape filtering; this is defense
  // in depth for the wall.
  const allPages = nodes.map((n) => ({
    id: n.id,
    title: n.title || n.id || "",
    host: (n.host || "").toLowerCase() || "",
    pk: n.primary_contributor || n.source_pubkey || "(orphan)",
    fetched_at: n.fetched_at || null,
    degree: n.degree | 0,
    raw: n,
  }));
  const pages = allPages.filter((p) => !isJunkTitle(p.title));
  if (typeof window !== "undefined" && !window.__srwk_atlas_silent) {
    const dropped = allPages.length - pages.length;
    if (dropped > 0) {
      try {
        console.log(`[atlas] dropped ${dropped} junk-title page(s) ` +
          `before clustering (404s / publications / placeholders)`);
      } catch {}
    }
  }

  // 2) Run the topic-clustering pipeline. perfMs lets us log the cold/cached
  // numbers; fromCache distinguishes the two.
  const topo = buildTopicClusters(pages);
  if (typeof window !== "undefined" && !window.__srwk_atlas_silent) {
    try {
      console.log(`[atlas] topic clustering: K=${topo.k} N=${pages.length} ` +
        `${topo.fromCache ? "cached" : "cold"} ${topo.perfMs.toFixed(1)}ms`);
    } catch {}
  }
  // Stash the latest result for dumpClusters() and any future inspection.
  state.topoResult = topo;

  // 3) Build countries from clusters. Each cluster is a country.
  const clusters = topo.clusters;
  const pagePositions = topo.pagePositions;
  const countries = [];
  const countryByClusterId = new Map();

  for (let ci = 0; ci < clusters.length; ci++) {
    const cl = clusters[ci];
    if (cl.pageCount === 0) continue;
    // Color: deterministic hue from the cluster's index + (sorted-IDs hash).
    // We mirror stableHue's structure but anchor on cluster id so the
    // palette is stable per data-set.
    const seedKey = `topic_cluster:${ci}:${pages.length}`;
    const seedH = hash32(seedKey) >>> 0;
    const hue = (seedH % 360) / 360;
    const sat = 0.42 + ((seedH >>> 16) % 100) / 100 * 0.18;     // 0.42..0.60
    const lig = 0.46 + ((seedH >>> 8) % 100) / 100 * 0.10;      // 0.46..0.56
    const [r, g, b] = hslToRgb(hue, sat, lig);
    const color = rgbToHex(r, g, b);
    const [ccx, ccy] = cl.centroid2D;
    // Country radius: sqrt(page_count) bounded sensibly. Equal to
    // cl.radius (the disk size we used for page placement) plus a small
    // bleed so the wash wraps around the outermost towns.
    const rCountry = cl.radius + 30;
    const country = {
      pk: `topic_${ci}`,        // synthetic country id (no longer a pubkey)
      clusterId: ci,
      isSelf: false,            // peer identity drops out — no "self" anymore
      color,
      // For the legend / nickname display, we'll show the c-TF-IDF concept
      // name once derived. For now, a placeholder that gets overwritten
      // a few dozen lines down. Keep it short so the cartouche fits.
      nickname: `cluster ${ci}`,
      cx: ccx, cy: ccy,
      r: rCountry,
      towns: [],
      pageCount: 0,
      recent24h: 0,
      regions: [],
    };
    countries.push(country);
    countryByClusterId.set(ci, country);
  }

  // Place every page as a town inside its cluster country. Page positions
  // were already laid out by buildTopicClusters; we just need to attach
  // them to the country and stamp the per-page metadata.
  state.townById = new Map();
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    const ci = topo.assignments[i] | 0;
    const country = countryByClusterId.get(ci);
    if (!country) continue;
    const pos = pagePositions[i] || [country.cx, country.cy];
    const fetchedAt = +new Date(p.fetched_at || now);
    const town = {
      id: p.id,
      host: p.host || "",
      title: p.title || p.id || "untitled",
      pk: p.pk,                 // peer pubkey survives as page metadata
      x: pos[0],
      y: pos[1],
      ageRank: 0,               // recomputed when we sort the cluster
      fetchedAt,
      degree: p.degree | 0,
      isNew: state.lastSeenAt > 0 && fetchedAt > state.lastSeenAt,
    };
    country.towns.push(town);
    country.pageCount++;
    if (now - fetchedAt < ONE_DAY) country.recent24h++;
    state.townById.set(p.id, { country, town, region: null });
  }

  // 4) L2 sub-regions. We split each country into 2-3 spatial sub-regions
  // (by quantizing page positions into buckets) so the renderer's
  // existing L2 wash + coastline pipeline still has something to paint
  // at mid-zoom. Each region inherits the country's hue with a small
  // ±8° drift. Region centroid = mean of its towns; region radius =
  // tight wrap around its towns + small bleed.
  for (const c of countries) {
    if (c.towns.length === 0) continue;
    // Quantize: split by quadrant relative to the country's centroid.
    // 4 quadrants is more than 2-3 but only buckets with ≥ MIN_SUB pages
    // become regions; the rest get folded into the largest sibling. This
    // is a much lighter touch than the old (peer, host) split — at most
    // 4 sub-regions per cluster, often just 1-2 in practice.
    const buckets = [[], [], [], []];
    for (const t of c.towns) {
      const dx = t.x - c.cx;
      const dy = t.y - c.cy;
      const q = (dx >= 0 ? 1 : 0) + (dy >= 0 ? 2 : 0);
      buckets[q].push(t);
    }
    const MIN_SUB = Math.max(3, Math.floor(c.towns.length * 0.10));
    // Find the dominant bucket so we can fold tiny ones into it.
    let bigIdx = 0;
    for (let i = 1; i < 4; i++) if (buckets[i].length > buckets[bigIdx].length) bigIdx = i;
    const finalBuckets = [];
    for (let i = 0; i < 4; i++) {
      if (buckets[i].length >= MIN_SUB) finalBuckets.push(buckets[i]);
      else if (buckets[i].length > 0 && i !== bigIdx) buckets[bigIdx].push(...buckets[i]);
    }
    if (finalBuckets.length === 0) finalBuckets.push(c.towns.slice());
    // Build region objects.
    let i = 0;
    for (const towns of finalBuckets) {
      // Centroid of region.
      let sx = 0, sy = 0;
      for (const t of towns) { sx += t.x; sy += t.y; }
      const rcx = sx / Math.max(1, towns.length);
      const rcy = sy / Math.max(1, towns.length);
      // Spread.
      let maxD = 0;
      for (const t of towns) {
        const d = Math.hypot(t.x - rcx, t.y - rcy);
        if (d > maxD) maxD = d;
      }
      const r = Math.max(40, maxD + 14);
      const hueJ = ((hash32(`${c.pk}::reg${i}::hue`) >>> 0) % 17) - 8;
      const lightJ = ((hash32(`${c.pk}::reg${i}::l`) >>> 0) % 9) - 4;
      const region = {
        host: `(spatial-${i})`,   // synthetic host so the L2 path treats this as a real region
        cx: rcx, cy: rcy, r,
        color: adjustHueLight(c.color, hueJ, lightJ * 0.012),
        towns: towns.slice(),
        pageCount: towns.length,
      };
      // Stamp town.region back-pointer for picking.
      for (const t of towns) {
        const slot = state.townById.get(t.id);
        if (slot) slot.region = region;
      }
      // L3 (intra-region) clusters — we still let the existing TF-IDF-style
      // intra-cluster naming run inside the region for deep zoom labels.
      // This reuses the legacy clusterTowns + layoutClusters path; it's
      // cheap (≤ a few-dozen pages per region in practice) and gives the
      // L3 name-cloud something to draw at z > 5×.
      region.clusters = layoutClusters(region, c, clusterTowns(region.towns));
      c.regions.push(region);
      i++;
    }
  }

  // 5) Drop empty countries (shouldn't happen after the page-driven
  // construction, but defensive).
  const populated = countries.filter((c) => c.pageCount > 0);

  // c-TF-IDF cluster naming. Each cluster country is one territory; we
  // score against the other clusters. The same `cTfIdfNameForTerritory`
  // path is used (since the cluster IS the territory). Hostname blocklist
  // is empty because host is no longer part of the territory definition.
  const allClusterTowns = populated.map((c) => c.towns);
  for (const c of populated) {
    c.peerThemes = null;
    c.conceptName = null;
    c.conceptKind = null;
    c.conceptScore = null;
    c.conceptSecondScore = null;
    c.conceptConfident = false;
    c.conceptDiffuse = false;
    if (c.towns.length === 0) continue;
    const cacheKey = `topicL1:${c.clusterId}:${_territoryCacheKey(c.towns)}`;
    const result = _cachedConcept(cacheKey, () =>
      cTfIdfNameForTerritory(c.towns, allClusterTowns, ""));
    if (!result) continue;
    const formatted = formatConcept(result.concept);
    c.conceptName = formatted;
    c.conceptKind = result.kind;
    c.conceptScore = result.score;
    c.conceptSecondScore = result.secondScore;
    c.conceptConfident = result.score >= CONCEPT_GATE_RATIO * (result.secondScore || 0);
    // Issue #42: dominance gate. If the winner doesn't stand well
    // above the next few peers, the cluster is genuinely diffuse —
    // mark it so the renderer can fall back to "(diffuse)" or no
    // label rather than confidently mislabeling.
    c.conceptDiffuse = (result.dominanceRatio || 0) < DOMINANCE_RATIO;
    // Issue #42: top-2 token labels when a confident second concept
    // exists. "alignment · rlhf" is more honest than just "alignment"
    // when both themes carry weight in the cluster. We only render
    // the second when its score is at least TOP2_MIN_SECOND_RATIO of
    // the leader's; otherwise the second is noise and we drop it.
    let displayLabel = formatted;
    if (!c.conceptDiffuse && result.top2Concept &&
        result.top2Score >= TOP2_MIN_SECOND_RATIO * result.score) {
      const second = formatConcept(result.top2Concept);
      if (second && second !== formatted) {
        displayLabel = `${formatted} · ${second}`;
      }
    } else if (c.conceptDiffuse) {
      displayLabel = "(diffuse)";
    }
    // L1 themes (used by drawPlaceNames as the country's main label).
    c.peerThemes = [displayLabel];
    // Cluster's "topToken" + nickname for the legend.
    c.nickname = displayLabel || c.nickname;
    if (c.regions && c.regions.length === 1) {
      // Single-region cluster: don't draw a redundant L2 label.
      c.regions[0].conceptName = null;
      c.regions[0].conceptConfident = false;
    } else {
      // Multi-region cluster: name each region with its own c-TF-IDF run
      // against sibling regions. Tags on the spatial sub-regions are mostly
      // decorative at mid-zoom; falling through to the existing path keeps
      // the renderer happy.
      const siblings = c.regions.map((r) => r.towns);
      for (const r of c.regions) {
        const rkey = `topicL2:${c.clusterId}:${r.host}:${_territoryCacheKey(r.towns)}`;
        const rresult = _cachedConcept(rkey, () =>
          cTfIdfNameForTerritory(r.towns, siblings, ""));
        r.conceptName = rresult ? formatConcept(rresult.concept) : null;
        r.conceptKind = rresult ? rresult.kind : null;
        r.conceptScore = rresult ? rresult.score : null;
        r.conceptSecondScore = rresult ? rresult.secondScore : null;
        r.conceptConfident = !!(rresult &&
          rresult.score >= CONCEPT_GATE_RATIO * (rresult.secondScore || 0));
      }
    }
  }

  // 6) Caravans (cross-cluster co-contributed edges). Same as before but
  // the "different country" check now means different topic cluster.
  const caravans = [];
  const edges = (window.srwk && window.srwk.edges) || [];
  for (const e of edges) {
    const sId = (typeof e.source === "object") ? e.source.id : e.source;
    const tId = (typeof e.target === "object") ? e.target.id : e.target;
    const a = state.townById.get(sId);
    const b = state.townById.get(tId);
    if (!a || !b) continue;
    if (a.country === b.country) continue;
    caravans.push({
      ax: a.town.x, ay: a.town.y,
      bx: b.town.x, by: b.town.y,
      bornAt: Math.max(a.town.fetchedAt, b.town.fetchedAt),
      jitter: hash32(sId + ":" + tId) % 1000 / 1000,
    });
  }
  caravans.sort((p, q) => {
    const dp = (p.bx - p.ax) ** 2 + (p.by - p.ay) ** 2;
    const dq = (q.bx - q.ax) ** 2 + (q.by - q.ay) ** 2;
    return dq - dp;
  });
  const CARAVAN_CAP = 240;
  state.caravans = caravans.slice(0, CARAVAN_CAP);

  // 7) World bounds.
  let maxR = 0;
  for (const c of populated) {
    const d = Math.hypot(c.cx, c.cy) + c.r;
    if (d > maxR) maxR = d;
  }
  if (populated.length === 1) {
    state.worldRadius = populated[0].r * 1.35;
  } else {
    state.worldRadius = Math.max(800, maxR + 80);
  }

  // Build a stable peer roster for the legend (independent of layout):
  // every contributor that owns at least one page, plus any peers from
  // the peers map. This keeps the right-side roster recognizable even
  // though the map no longer encodes peer identity in position/color.
  const peerRoster = [];
  const peerCounts = new Map();
  for (const p of pages) peerCounts.set(p.pk, (peerCounts.get(p.pk) || 0) + 1);
  const allPeerPks = new Set();
  for (const pk of peerCounts.keys()) allPeerPks.add(pk);
  for (const [pk] of peers) allPeerPks.add(pk);
  for (const pk of allPeerPks) {
    const peer = peers.get ? peers.get(pk) : null;
    const isSelf = pk === selfPubkey;
    peerRoster.push({
      pk,
      isSelf,
      color: (peer && peer.signature_color) || stableHue(pk),
      nickname: (peer && peer.nickname) || (isSelf ? "self" : truncatePk(pk)),
      pageCount: peerCounts.get(pk) || 0,
      recent24h: 0, // not used for the topic legend; set 0 for layout symmetry
    });
  }
  peerRoster.sort((a, b) => {
    if (a.isSelf && !b.isSelf) return -1;
    if (!a.isSelf && b.isSelf) return 1;
    return b.pageCount - a.pageCount;
  });
  state.peerRoster = peerRoster;

  state.countries = countries;            // topic clusters (for legend total + render)
  state.populatedCountries = populated;
  state.countryById = countryByClusterId;
  // One-shot log of derived concept names so devtools / tail-of-log can
  // verify the c-TF-IDF pass produced something meaningful. Only first
  // build to avoid flooding the renderer log on every notifyDataChanged.
  // Set `window.__srwk_atlas_silent = true` before mount to suppress.
  if (!state._loggedConceptNames && !window.__srwk_atlas_silent) {
    try {
      const cdump = (typeof window !== "undefined" && window.__srwk_atlas
        && typeof window.__srwk_atlas.dumpClusters === "function")
        ? window.__srwk_atlas.dumpClusters()
        : null;
      if (cdump) {
        // Topic-cluster summary — id, label, page count, sample titles.
        // Reading this from the log is the fastest cluster-quality check.
        console.log("[atlas] topic-cluster dump:", JSON.stringify(cdump));
      }
    } catch {}
    state._loggedConceptNames = true;
  }
  // PR C: tally new-since-last-visit count. Used by the cartouche +
  // legend chip. We tally over populated countries (orphans don't get
  // halos either way).
  let newCount = 0;
  for (const c of populated) for (const t of c.towns) if (t.isNew) newCount++;
  state.newSinceLastVisit = newCount;
  // Refresh legend once the country list is known.
  renderLegend();
  updateCartouche();
}

// ─── distance-field watercolor wash (offscreen, half-res) ────────────────
// Per pixel, find the distance to each country centroid weighted by the
// country's territory. The "winner" gets the country color; the second-
// place's nearness pulls hue toward it for the wet-bleed look. The whole
// thing is then composited onto the paper texture and stroke-traced for
// the dry-edge.

function paintWash() {
  // PR D: paint all three territorial levels into their own offscreen
  // bitmaps. Per-frame compositing in drawFrame picks each layer's
  // opacity from camera zoom, so we only repaint here on data change /
  // resize. Total cost is ~3× the original distance-field pass, but
  // still well under the 800ms cold-start bar (each level is ~13M ops
  // at default wash resolution).
  paintWashLevel(LEVEL_PEER);
  paintWashLevel(LEVEL_HOST);
  paintWashLevel(LEVEL_TOPIC);
  // The legacy state.edgePoints / state.coastlines field is preserved as
  // the L1 entry — older code paths (pulse halos, etc) keep working.
  state.edgePoints = (state.coastMetaByLevel[0]?.edgePoints) || [];
  state.coastlines = state.coastlinesByLevel[0] || [];
  // Terra incognita: now that the L1 territory layout has settled, repaint
  // the sea-hatching bitmap. Depends on the L1 distance field.
  paintSeaHatching();
}

// PR D: paint one level's watercolor wash into its dedicated offscreen
// canvas + compute that level's per-attractor coastlines.
//
// Levels:
//   LEVEL_PEER  — one attractor per peer (country). Owner index = countryIdx.
//   LEVEL_HOST  — one attractor per (peer, host) region. Owner = regionIdx.
//   LEVEL_TOPIC — one attractor per topic cluster. Owner = clusterIdx.
//
// Each level has its own owner-space (so coastline lookups can be done by
// level). `coastMetaByLevel[level]` carries: owners array (parallel to
// the polyline list), color per owner, parent country index per owner.
function paintWashLevel(level) {
  if (!state.mounted) return;
  const washCanvas = state.washByLevel[level];
  const washCtx = state.washCtxByLevel[level];
  if (!washCanvas || !washCtx) return;
  const populated = state.populatedCountries || [];
  if (!populated.length) {
    washCtx.clearRect(0, 0, washCanvas.width, washCanvas.height);
    state.coastlinesByLevel[level] = [];
    state.coastMetaByLevel[level] = { owners: [], colors: [], parents: [], edgePoints: [] };
    return;
  }

  const W = washCanvas.width;
  const H = washCanvas.height;
  if (W <= 0 || H <= 0) return;

  const img = washCtx.createImageData(W, H);
  const data = img.data;

  // Build the attractor list for this level. Each attractor is positioned
  // in wash-pixel space, has an "ownerIdx" used by the marching-squares
  // coastline pass, and an RGB color used by the per-pixel blend.
  // World→wash projection: world-radius r in wash-px is r * k * sx where
  // k = f.span*0.45/worldRadius (matches worldToScreen) and sx = W /
  // canvas.width (the wash-downscale factor).
  const f = state.frame;
  const k = (f.span * 0.45) / state.worldRadius;
  const sxFac = W / Math.max(1, state.canvas.width);
  const radPx = (rWorld) => rWorld * k * sxFac;

  // owners[i]    : the owner-index of attractor i (level-specific)
  // ownerColors[i]: the canonical color of owner i (for coastline strokes)
  // ownerParents[i]: countryIdx of the country owner i sits in (for pulse halos)
  const cps = [];
  const ownerColors = [];
  const ownerParents = [];
  let ownerCount = 0;
  if (level === LEVEL_PEER) {
    // L1: one attractor per peer = country. Use the country centroid +
    // its full territory radius. Coastlines wrap each peer.
    for (let ci = 0; ci < populated.length; ci++) {
      const c = populated[ci];
      const ownerIdx = ci;
      ownerColors[ownerIdx] = c.color;
      ownerParents[ownerIdx] = ci;
      // Use the country centroid + full radius. Even when sub-regions
      // exist, this gives a single peer-level blob with the canonical
      // hue across its whole territory — the "from across the room" read.
      const [px, py] = worldToWash(c.cx, c.cy, W, H);
      const pr = radPx(c.r);
      const rgb = hexToRgb(c.color);
      cps.push({ ownerIdx, px, py, pr, r: rgb[0], g: rgb[1], b: rgb[2] });
    }
    ownerCount = populated.length;
  } else if (level === LEVEL_HOST) {
    // L2: one attractor per (peer, host) region. Each region gets its
    // own coastline — sub-territories within each peer.
    for (let ci = 0; ci < populated.length; ci++) {
      const c = populated[ci];
      const regs = c.regions || [];
      if (!regs.length) {
        const ownerIdx = ownerCount++;
        ownerColors[ownerIdx] = c.color;
        ownerParents[ownerIdx] = ci;
        const [px, py] = worldToWash(c.cx, c.cy, W, H);
        const pr = radPx(c.r);
        const rgb = hexToRgb(c.color);
        cps.push({ ownerIdx, px, py, pr, r: rgb[0], g: rgb[1], b: rgb[2] });
        continue;
      }
      for (const reg of regs) {
        const ownerIdx = ownerCount++;
        ownerColors[ownerIdx] = reg.color;
        ownerParents[ownerIdx] = ci;
        reg._level2OwnerIdx = ownerIdx; // kept so labels etc can map back
        const [px, py] = worldToWash(reg.cx, reg.cy, W, H);
        const pr = radPx(reg.r);
        const rgb = hexToRgb(reg.color);
        cps.push({ ownerIdx, px, py, pr, r: rgb[0], g: rgb[1], b: rgb[2] });
      }
    }
  } else {
    // L3: one attractor per topic cluster. Each cluster gets its own
    // coastline. Skip clusters that ended up trivially small (just one
    // page in a region with one cluster) — they already read at L2.
    for (let ci = 0; ci < populated.length; ci++) {
      const c = populated[ci];
      const regs = c.regions || [];
      for (const reg of regs) {
        const cls = reg.clusters || [];
        for (const cl of cls) {
          if (cl.r <= 0 || cl.towns.length === 0) continue;
          const ownerIdx = ownerCount++;
          ownerColors[ownerIdx] = cl.color;
          ownerParents[ownerIdx] = ci;
          cl._level3OwnerIdx = ownerIdx;
          const [px, py] = worldToWash(cl.cx, cl.cy, W, H);
          const pr = radPx(cl.r);
          const rgb = hexToRgb(cl.color);
          cps.push({ ownerIdx, px, py, pr, r: rgb[0], g: rgb[1], b: rgb[2] });
        }
      }
    }
  }
  // No attractors → empty bitmap is fine.
  if (cps.length === 0) {
    washCtx.clearRect(0, 0, W, H);
    state.coastlinesByLevel[level] = [];
    state.coastMetaByLevel[level] = { owners: [], colors: [], parents: [], edgePoints: [] };
    return;
  }

  // Two-step: for each pixel, find best+second-best country by *weighted*
  // distance d/r. Below 1.0 we're firmly inside; 1.0..1.6 is the bleed
  // zone (wet edge); >1.6 we're paper.
  const PAPER_RGB = hexToRgb(PAPER);
  const PAPER_DEEP_RGB = hexToRgb(PAPER_DEEP);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let bestK = Infinity, bestI = -1, secondK = Infinity, secondI = -1;
      for (let i = 0; i < cps.length; i++) {
        const cp = cps[i];
        const dx = x - cp.px;
        const dy = y - cp.py;
        const d = Math.sqrt(dx * dx + dy * dy);
        const k = d / cp.pr;            // weighted distance, dimensionless
        if (k < bestK) {
          secondK = bestK; secondI = bestI;
          bestK = k; bestI = i;
        } else if (k < secondK) {
          secondK = k; secondI = i;
        }
      }

      // Color blend.
      // - inside region (bestK < 1): country color, slight darkening near
      //   centroid (concentration of pigment).
      // - bleed (1 < bestK < 1.6): cross-fade with paper, biased toward
      //   the winner.
      // - paper (bestK >= 1.6): TRANSPARENT, so the paper texture
      //   underneath shows through unchanged. PR B made this transparent
      //   (was paper-cream) so when the user zooms out, the wash bitmap
      //   doesn't print a hard rectangle of "fake paper" against the
      //   live paper texture.
      const offset = (y * W + x) * 4;
      let r = 0, g = 0, b = 0, a = 0;
      if (bestI >= 0) {
        const win = cps[bestI];
        const k = bestK;
        if (k < 1.0) {
          // Inside. Darker near centroid, lighter near rim — Stamen's
          // "wet wash settles thickest at the edges" reads even better
          // when we *invert* it for our metaphor: the *core* of the
          // country is the user's recent activity, so we pull the core
          // toward saturation.
          // mix(white-paper, color) by t = 0.55 + 0.45 * (1 - k)
          const t = 0.55 + 0.45 * (1 - k);
          r = Math.round(PAPER_RGB[0] * (1 - t) + win.r * t);
          g = Math.round(PAPER_RGB[1] * (1 - t) + win.g * t);
          b = Math.round(PAPER_RGB[2] * (1 - t) + win.b * t);
          a = 255;
        } else if (k < 1.6) {
          // Wet edge — fall off to paper, with a touch of the second
          // color leaking in (the bleed). t goes 0.55 -> 0.0 across the
          // bleed band.
          const u = (k - 1.0) / 0.6;       // 0 at rim, 1 at paper
          const t = 0.55 * (1 - u) * (1 - u); // ease out
          // bleed mix-in (when there's a near-second country)
          const second = secondI >= 0 ? cps[secondI] : null;
          let blendR = win.r, blendG = win.g, blendB = win.b;
          if (second) {
            const sk = secondK;
            if (sk < 2.2) {
              const mix = clamp(0.6 - (sk - bestK) * 0.7, 0, 0.5);
              blendR = win.r * (1 - mix) + second.r * mix;
              blendG = win.g * (1 - mix) + second.g * mix;
              blendB = win.b * (1 - mix) + second.b * mix;
            }
          }
          r = Math.round(PAPER_RGB[0] * (1 - t) + blendR * t);
          g = Math.round(PAPER_RGB[1] * (1 - t) + blendG * t);
          b = Math.round(PAPER_RGB[2] * (1 - t) + blendB * t);
          // Soft alpha falloff at the bleed edge so paper transparency
          // takes over smoothly.
          a = Math.round(255 * (0.65 + 0.35 * (1 - u)));
        } else if (secondI >= 0) {
          // Just past the bleed: a whisper of warm paper-deep where two
          // countries' outer fields overlap (the "ocean shadow" between
          // continents). Use a small alpha so paper still reads through.
          const overlap = Math.max(0, 1.0 - (secondK - 1.6) / 1.5);
          if (overlap > 0.05) {
            const warm = overlap * 0.42;
            r = PAPER_DEEP_RGB[0]; g = PAPER_DEEP_RGB[1]; b = PAPER_DEEP_RGB[2];
            a = Math.round(255 * warm);
          }
        }
      }

      data[offset + 0] = r;
      data[offset + 1] = g;
      data[offset + 2] = b;
      data[offset + 3] = a;
    }
  }

  washCtx.putImageData(img, 0, 0);

  // Now: trace the dry edge. We do a cheap edge-detect on the wash —
  // walk pixels and stamp a single 1-pixel ink dot wherever a pixel's
  // dominant owner differs from its neighbor. Stored as a path so the
  // foreground can stroke it (and pulses can re-stroke a country
  // selectively). One marching-squares pass per owner.
  computeDryEdgesForLevel(level, cps, ownerCount, ownerColors, ownerParents);
}

// PR D: per-level marching-squares coastline computation. cps[i] carries
// an `ownerIdx`; we group output polylines by owner. ownerCount tells us
// how many owners to allocate, ownerColors / ownerParents are passed
// through so the renderer can stroke per-owner without re-deriving them.
function computeDryEdgesForLevel(level, cps, ownerCount, ownerColors, ownerParents) {
  const washCanvas = state.washByLevel[level];
  const W = washCanvas.width;
  const H = washCanvas.height;
  if (W <= 0 || H <= 0) {
    state.coastlinesByLevel[level] = [];
    state.coastMetaByLevel[level] = { owners: [], colors: [], parents: [], edgePoints: [] };
    return;
  }
  const STEP = 2;
  // cw/ch MUST be integers — they're the inner stride of the owners[]
  // typed array. With odd wash dimensions (washW = Math.round(canvas.w *
  // 0.30) is often odd), `W / STEP + 1` is fractional, which makes
  // `gy * cw + gx` fractional, which makes `owners[fractional]` return
  // undefined (typed arrays only honor integer indices). `undefined`
  // then slides past `o < 0 || o >= ownerCount` (both NaN comparisons
  // are false) and crashes at `perOwner[undefined].push(...)` per frame.
  // Take the floor: we lose at most a half-cell of edge resolution, which
  // doesn't matter — the wash is rendered to W×H and edges fall on the
  // step grid anyway.
  const cw = (W / STEP + 1) | 0;
  const ch = (H / STEP + 1) | 0;

  // Ownership grid: per cell corner, the owner index of the closest
  // attractor (or -1 if no attractor wins, k >= 1.0).
  const owners = new Int16Array(cw * ch);
  for (let gy = 0; gy < ch; gy++) {
    for (let gx = 0; gx < cw; gx++) {
      const x = gx * STEP;
      const y = gy * STEP;
      let bestK = Infinity, bestOwner = -1;
      for (let i = 0; i < cps.length; i++) {
        const cp = cps[i];
        const dx = x - cp.px;
        const dy = y - cp.py;
        const k = (dx * dx + dy * dy) / (cp.pr * cp.pr);
        if (k < bestK) { bestK = k; bestOwner = cp.ownerIdx; }
      }
      owners[gy * cw + gx] = bestK < 1.0 ? bestOwner : -1;
    }
  }

  // Per-owner edge-points list (used by older pulse halo paths if needed).
  const perOwner = Array.from({ length: ownerCount }, () => []);
  for (let gy = 1; gy < ch - 1; gy++) {
    for (let gx = 1; gx < cw - 1; gx++) {
      const o = owners[gy * cw + gx];
      if (o < 0 || o >= ownerCount) continue;
      const right = owners[gy * cw + (gx + 1)];
      const down  = owners[(gy + 1) * cw + gx];
      if (right !== o || down !== o) {
        perOwner[o].push(gx * STEP, gy * STEP);
      }
    }
  }

  // Marching-squares pass per owner. Same lookup table as the legacy
  // implementation — duplicated here so the level-specific path doesn't
  // alias state.coastlines mid-build.
  const segs = Array.from({ length: ownerCount }, () => []);
  for (let oi = 0; oi < ownerCount; oi++) {
    const segArr = segs[oi];
    for (let gy = 0; gy < ch - 1; gy++) {
      for (let gx = 0; gx < cw - 1; gx++) {
        const tl = owners[gy * cw + gx]             === oi ? 1 : 0;
        const tr = owners[gy * cw + (gx + 1)]       === oi ? 1 : 0;
        const br = owners[(gy + 1) * cw + (gx + 1)] === oi ? 1 : 0;
        const bl = owners[(gy + 1) * cw + gx]       === oi ? 1 : 0;
        const code = (tl << 3) | (tr << 2) | (br << 1) | bl;
        if (code === 0 || code === 15) continue;
        const x0 = gx * STEP, x1 = x0 + STEP;
        const y0 = gy * STEP, y1 = y0 + STEP;
        const tx = (x0 + x1) * 0.5;
        const ty = y0;
        const rx = x1;
        const ry = (y0 + y1) * 0.5;
        const bx = (x0 + x1) * 0.5;
        const by = y1;
        const lx = x0;
        const ly = (y0 + y1) * 0.5;
        switch (code) {
          case 1:  segArr.push(lx, ly, bx, by); break;
          case 2:  segArr.push(bx, by, rx, ry); break;
          case 4:  segArr.push(tx, ty, rx, ry); break;
          case 8:  segArr.push(lx, ly, tx, ty); break;
          case 3:  segArr.push(lx, ly, rx, ry); break;
          case 6:  segArr.push(tx, ty, bx, by); break;
          case 12: segArr.push(lx, ly, rx, ry); break;
          case 9:  segArr.push(tx, ty, bx, by); break;
          case 14: segArr.push(lx, ly, bx, by); break;
          case 13: segArr.push(bx, by, rx, ry); break;
          case 11: segArr.push(tx, ty, rx, ry); break;
          case 7:  segArr.push(lx, ly, tx, ty); break;
          case 5:  segArr.push(tx, ty, rx, ry, lx, ly, bx, by); break;
          case 10: segArr.push(lx, ly, tx, ty, bx, by, rx, ry); break;
          default: break;
        }
      }
    }
  }
  const coastlines = segs.map((s) => stitchSegments(s));
  state.coastlinesByLevel[level] = coastlines;
  state.coastMetaByLevel[level] = {
    owners: ownerCount,
    colors: ownerColors,
    parents: ownerParents,
    edgePoints: perOwner,
  };
}

// PR D: the old single-level `computeDryEdges(cps)` was retired in favor
// of `computeDryEdgesForLevel(level, cps, ownerCount, …)` above, which
// produces per-owner coastlines for any of the three territorial levels.

// PR C: stitch a flat segment array (x1,y1,x2,y2,...) into polylines.
// Uses a simple endpoint hash; segments share endpoints exactly because
// the marching-squares grid is integer-aligned. Open polylines stay open
// (the algorithm produces closed loops at country interiors but partial
// chains at the canvas edge — stroking either is fine).
function stitchSegments(segs) {
  if (segs.length === 0) return [];
  const N = segs.length / 4;
  const adj = new Map(); // key = "x,y" → list of {seg, end}
  function k(x, y) { return (x | 0) + "," + (y | 0); }
  const consumed = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const ax = segs[4 * i + 0], ay = segs[4 * i + 1];
    const bx = segs[4 * i + 2], by = segs[4 * i + 3];
    const ka = k(ax, ay), kb = k(bx, by);
    if (!adj.has(ka)) adj.set(ka, []);
    if (!adj.has(kb)) adj.set(kb, []);
    adj.get(ka).push({ seg: i, end: 0 });
    adj.get(kb).push({ seg: i, end: 1 });
  }
  // pickNext returns an unconsumed segment touching (x,y), or null.
  function pickNext(x, y) {
    const list = adj.get(k(x, y));
    if (!list) return null;
    for (const ent of list) {
      if (!consumed[ent.seg]) return ent;
    }
    return null;
  }
  const polys = [];
  for (let start = 0; start < N; start++) {
    if (consumed[start]) continue;
    consumed[start] = 1;
    // poly is a flat [x0,y0, x1,y1, ...] in order from tail to head.
    const poly = [];
    poly.push(segs[4 * start + 0], segs[4 * start + 1]);
    poly.push(segs[4 * start + 2], segs[4 * start + 3]);
    // walk forward from the head
    while (true) {
      const hx = poly[poly.length - 2], hy = poly[poly.length - 1];
      const nxt = pickNext(hx, hy);
      if (!nxt) break;
      consumed[nxt.seg] = 1;
      const other = nxt.end === 0 ? 2 : 0;
      poly.push(segs[4 * nxt.seg + other], segs[4 * nxt.seg + other + 1]);
    }
    // walk backward from the tail
    while (true) {
      const tx = poly[0], ty = poly[1];
      const nxt = pickNext(tx, ty);
      if (!nxt) break;
      consumed[nxt.seg] = 1;
      const other = nxt.end === 0 ? 2 : 0;
      poly.unshift(segs[4 * nxt.seg + other], segs[4 * nxt.seg + other + 1]);
    }
    if (poly.length >= 4) polys.push(chaikinSmooth(poly));
  }
  return polys;
}

// PR C: Chaikin smoothing — a single pass yields a slightly softer line
// without losing the marching-squares fidelity. We're conservative —
// only smooth chains long enough to benefit, and only one pass.
function chaikinSmooth(poly) {
  const n = poly.length / 2;
  if (n < 4) return poly;
  const out = [];
  // Keep first vertex
  out.push(poly[0], poly[1]);
  for (let i = 0; i < n - 1; i++) {
    const x0 = poly[2 * i], y0 = poly[2 * i + 1];
    const x1 = poly[2 * i + 2], y1 = poly[2 * i + 3];
    // Q = 0.75 P0 + 0.25 P1, R = 0.25 P0 + 0.75 P1
    out.push(0.75 * x0 + 0.25 * x1, 0.75 * y0 + 0.25 * y1);
    out.push(0.25 * x0 + 0.75 * x1, 0.25 * y0 + 0.75 * y1);
  }
  out.push(poly[poly.length - 2], poly[poly.length - 1]);
  return out;
}

// ─── render loop ─────────────────────────────────────────────────────────

function loop() {
  state.raf = requestAnimationFrame(loop);
  if (!state.active) return;

  const now = performance.now();
  const dt = state.lastFrameTs === 0 ? 16 : Math.min(64, now - state.lastFrameTs);
  state.lastFrameTs = now;

  // PR C: time-lapse advance, before drawing, so the visibility gate in
  // drawTowns sees the correct nowMs.
  advanceTimelapse(now);
  // Surveyor pauses during time-lapse per spec — the user explicitly
  // opted into a cinematic mode, so the wandering ink-mark is silent.
  if (!state.timelapse.active) advanceSurveyor(dt);
  drawFrame(now, dt);
  updateCartouche();
}

function drawFrame(now, dt) {
  const ctx = state.ctx;
  const cw = state.canvas.width;
  const ch = state.canvas.height;
  ctx.clearRect(0, 0, cw, ch);

  // PR B: ease the viewport toward its target. Idle return tween wins
  // when active; otherwise we damp toward viewportTarget over ~120ms.
  advanceViewport(now, dt);

  // Inhale — the whole world scales 1.000 ↔ 1.012 over 30s. CSS transform
  // would be cheaper but re-rendering with a tiny scale is exact and
  // doesn't induce a layout pass on the wrapper.
  let breath = 1.0;
  if (!state.reducedMotion) {
    const phase = ((now - state.startTs) / 30000) % 1;
    breath = 1.0 + 0.012 * Math.sin(phase * TAU);
  }

  // ── World layer (panning/zooming content) ────────────────────────────
  // Render the entire world — wash, sea hatching, foxing, coastlines,
  // caravans, towns, labels, surveyor — into worldCanvas. We then stamp
  // worldCanvas on top of the paper with source-over and apply the
  // deckle mask ONCE over the combined paper + world composition. This
  // is what makes the territory bloom stop precisely at the torn paper
  // edge.
  const wctx = state.worldCtx;
  const wc = state.worldCanvas;
  if (!wctx || !wc || wc.width !== cw || wc.height !== ch) {
    // Defensive — shouldn't happen because resize() keeps them in sync,
    // but bail rather than crash if the canvas hasn't been sized yet.
    return;
  }
  wctx.clearRect(0, 0, cw, ch);

  // Foxing dots — drawn in world space so they pan/zoom with the
  // territory (per user feedback: "the dirt sports should also be an
  // artifact of the map and not stay where they are when we zoom in").
  // Drawn BEFORE the wash so the wash bleeds over them inside territories
  // — same way real foxing sits behind ink on aged paper.
  drawFoxing(wctx, breath);

  // Sea hatching — engraved concentric rings around coastlines. World
  // transform so the rings stay anchored to coastlines as the camera moves.
  if (state.seaHatchCanvas && state.seaHatchCanvas.width > 0) {
    wctx.save();
    applyWorldTransform(wctx, breath);
    wctx.imageSmoothingEnabled = true;
    wctx.imageSmoothingQuality = "high";
    wctx.globalAlpha = 0.92;
    wctx.drawImage(state.seaHatchCanvas, -state.frame.cx, -state.frame.cy, cw, ch);
    wctx.globalAlpha = 1;
    wctx.restore();
  }

  // Watercolor wash — three crossfaded levels by zoom (peer / host / topic).
  // PR D regression fix: when the world layer was moved into an offscreen
  // canvas (the deckle-masked composite work in 89b187b), the wash
  // compositing kept its `multiply` blend mode. `multiply` against the
  // previously-paper destination produced rich darkening that read as
  // distinct sub-territories; against a transparent offscreen it simply
  // stamps the source, and L2/L3 (which share hue family with L1) get
  // visually swallowed by L1's bigger blob — the user reported "all one
  // blue area" at zoom ~3×. We now paint L1 with source-over to stamp
  // the peer territories, then L2/L3 with source-over at their crossfade
  // alphas so each sub-territory's hue (rotateHue ±12° from peer) reads
  // clearly. The wctx is then drawImage'd over paperCanvas in compose,
  // which gives the wash its on-paper feel via simple alpha blending —
  // no need for canvas-level multiply against a transparent target.
  wctx.save();
  applyWorldTransform(wctx, breath);
  wctx.imageSmoothingEnabled = true;
  wctx.imageSmoothingQuality = "high";

  const f0 = state.frame;
  const z = state.viewport.scale;

  // L1 — peer (continent) wash. Always present; carries the from-across-
  // the-room peer color identity.
  wctx.globalAlpha = 0.92;
  wctx.drawImage(state.washByLevel[LEVEL_PEER], -f0.cx, -f0.cy, cw, ch);

  // L2 — per-host sub-territories. Crossfade in around z=1.4. Source-over
  // so the L2 hue (peer color rotated ±12°) overlays L1 directly and the
  // "different blue pockets" inside one peer continent become visible.
  const a2 = levelOpacity(z, L2_THRESHOLD, L2_WIDTH);
  if (a2 > 0.02) {
    wctx.globalAlpha = 0.92 * a2;
    wctx.drawImage(state.washByLevel[LEVEL_HOST], -f0.cx, -f0.cy, cw, ch);
  }

  // L3 — topic clusters. Crossfade in around z=4.0. Same logic as L2 —
  // overlay the clusters' distinct hues on top of L1+L2.
  const a3 = levelOpacity(z, L3_THRESHOLD, L3_WIDTH);
  if (a3 > 0.02) {
    wctx.globalAlpha = 0.86 * a3;
    wctx.drawImage(state.washByLevel[LEVEL_TOPIC], -f0.cx, -f0.cy, cw, ch);
  }

  wctx.globalAlpha = 1.0;
  wctx.restore();

  // Vector world layers — coastlines, caravans, towns, labels, surveyor.
  // These all use worldToScreen() which composes the viewport transform
  // internally, so they go onto wctx without applyWorldTransform.
  drawDryEdges(wctx, now, breath);
  drawCaravans(wctx);
  drawTowns(wctx, now);
  drawPlaceNames(wctx);
  drawSurveyor(wctx);

  // ── Compose paper + world + clouds, then apply deckle mask once ───
  const cmp = state.composeCtx;
  const cmpCanvas = state.composeCanvas;
  if (!cmp || !cmpCanvas || cmpCanvas.width !== cw || cmpCanvas.height !== ch) {
    return;
  }
  cmp.clearRect(0, 0, cw, ch);
  // 1) paper underlay (no deckle baked in any more — see paintPaper)
  cmp.drawImage(state.paperCanvas, 0, 0, cw, ch);
  // 2) world layer on top
  cmp.drawImage(wc, 0, 0, cw, ch);
  // 3) clip the entire composite by the deckle alpha mask. Anything
  //    outside the torn edge becomes fully transparent → the dark
  //    cosmic chrome shows through. Cumulus cloud puffs and corner
  //    ink-scroll flourishes were removed per user feedback — the deckle
  //    edge alone now does the corner / margin work.
  applyDeckleMask(cmp, cw, ch);

  // 4) blit the masked composite to the live canvas.
  ctx.drawImage(cmpCanvas, 0, 0, cw, ch);

  // ── Decoration above the deckle (chrome) ─────────────────────────────
  // Vignette, compass — these sit above the paper and don't get clipped
  // by the deckle. (Vignette especially: it backs the cartouche/legend.)
  drawVignette(ctx);
  drawCompass(ctx);
}

// PR B: combined breath + viewport transform. The wash bitmap uses this
// directly (via ctx.translate/scale); the vector layers go through
// worldToScreen() which composes the same transform with the world →
// canvas projection. Both paths land on identical pixels.
function applyWorldTransform(ctx, breath) {
  const f = state.frame;
  // Center the world in the visible frame (cartouche/legend reservations
  // already excluded by computeFrame). Apply breath inhale then the
  // user's pan + zoom. The wash bitmap is drawn separately by
  // drawWashBitmap() under this transform — it expects world (0,0) at
  // the current origin, with k = f.span * 0.45 / worldRadius.
  ctx.translate(f.cx, f.cy);
  ctx.scale(breath, breath);
  ctx.scale(state.viewport.scale, state.viewport.scale);
  ctx.translate(state.viewport.tx, state.viewport.ty);
}

// Compass rose — a proper 8-point cartographic star with outer ring,
// degree ticks, center pip and an italic serif `N` label. The star has
// alternating-fill halves on each long point so it reads as a 3D-engraved
// rosette rather than a flat icon. Sits in screen space (top-right) so it
// stays a fixed reference as the user pans/zooms the world.
function drawCompass(ctx) {
  const w = state.canvas.width;
  const dpr = state.canvas.width / Math.max(1, state.container.getBoundingClientRect().width || 1);
  // Outer ring radius. Bumped up from the previous 18 CSS-px to ~46 so the
  // 8-point detail reads at a glance. Total "compass footprint" sits at
  // ~92 CSS px diameter, comfortably away from the cartouche on the left
  // and the legend on the bottom-right.
  const R = 46 * dpr;
  const margin = 64 * dpr;
  const cx = w - margin - R * 0.20;
  const cy = margin + R * 0.20;

  // Star points: long cardinals (N/E/S/W) at ~0.92 R, short intercardinals
  // (NE/SE/SW/NW) at ~0.56 R, and the inset between adjacent triangle sides
  // at ~0.18 R. The star is built as 16 alternating long/short tips around
  // the center; each pair of tips shares an inset radius.
  const longR = R * 0.92;
  const shortR = R * 0.56;
  const insetR = R * 0.18;

  ctx.save();
  ctx.translate(cx, cy);

  // Subtle ink-bleed shadow under the rosette so it feels engraved on
  // paper rather than vector-pasted on top.
  ctx.save();
  ctx.shadowColor = "rgba(26, 20, 16, 0.18)";
  ctx.shadowBlur = 5 * dpr;
  ctx.shadowOffsetY = 0.6 * dpr;

  // ── 8-point star (alternating-fill halves for engraved feel) ──────────
  // We build each of the 8 points individually as a 3-vertex triangle
  // (tip + two adjacent insets), so we can fill some with ink and outline
  // others. The convention chosen: cardinals filled (ink-2), intercardinals
  // outlined-only at a lighter ink. That preserves the "compass arrow"
  // feeling at N/E/S/W and makes the rosette read as 8 points without
  // stomping the cardinals.
  // Angles: tip i at i * (TAU / 8) - TAU/4 (so i=0 → North, going CW).

  // Fill cardinals (long points). We draw each cardinal as two triangles —
  // a "left half" (tip → previous-inset → center) and a "right half" (tip
  // → next-inset → center). Filling only the right half of each gives the
  // engraved-rosette look; the left half is outlined at a lighter weight.
  ctx.lineJoin = "miter";
  ctx.lineCap = "butt";
  for (let i = 0; i < 4; i++) {
    const ang = i * (TAU / 4) - TAU / 4; // N, E, S, W
    const tip = [Math.cos(ang) * longR, Math.sin(ang) * longR];
    const angL = ang - TAU / 8;
    const angR = ang + TAU / 8;
    const insetL = [Math.cos(angL) * insetR, Math.sin(angL) * insetR];
    const insetR2 = [Math.cos(angR) * insetR, Math.sin(angR) * insetR];

    // Right half (filled, ink-2)
    ctx.fillStyle = hexToRgba(INK_2, 0.86);
    ctx.beginPath();
    ctx.moveTo(tip[0], tip[1]);
    ctx.lineTo(insetR2[0], insetR2[1]);
    ctx.lineTo(0, 0);
    ctx.closePath();
    ctx.fill();

    // Left half (outline only, ink-3)
    ctx.strokeStyle = hexToRgba(INK_3, 0.78);
    ctx.lineWidth = 0.9 * dpr;
    ctx.beginPath();
    ctx.moveTo(tip[0], tip[1]);
    ctx.lineTo(insetL[0], insetL[1]);
    ctx.lineTo(0, 0);
    ctx.closePath();
    ctx.stroke();
  }

  // Intercardinal short points (NE/SE/SW/NW). Outlined only — narrower
  // triangles, lighter ink, so they recede behind the cardinals.
  ctx.strokeStyle = hexToRgba(INK_3, 0.62);
  ctx.lineWidth = 0.85 * dpr;
  for (let i = 0; i < 4; i++) {
    const ang = i * (TAU / 4) + TAU / 8 - TAU / 4; // NE, SE, SW, NW
    const tip = [Math.cos(ang) * shortR, Math.sin(ang) * shortR];
    const angL = ang - TAU / 8;
    const angR = ang + TAU / 8;
    const insetL = [Math.cos(angL) * insetR, Math.sin(angL) * insetR];
    const insetR2 = [Math.cos(angR) * insetR, Math.sin(angR) * insetR];
    ctx.beginPath();
    ctx.moveTo(tip[0], tip[1]);
    ctx.lineTo(insetR2[0], insetR2[1]);
    ctx.lineTo(insetL[0], insetL[1]);
    ctx.closePath();
    ctx.stroke();
  }

  ctx.restore(); // drop shadow

  // ── Outer hairline ring with degree ticks ─────────────────────────────
  ctx.lineWidth = 0.8 * dpr;
  ctx.strokeStyle = hexToRgba(INK_3, 0.55);
  ctx.beginPath();
  ctx.arc(0, 0, R, 0, TAU);
  ctx.stroke();

  // Inner subordinate ring — a second hairline at ~0.78 R, lighter, gives
  // the rosette a "two-rule" cartographic ring like classic field compasses.
  ctx.strokeStyle = hexToRgba(INK_4, 0.45);
  ctx.lineWidth = 0.6 * dpr;
  ctx.beginPath();
  ctx.arc(0, 0, R * 0.78, 0, TAU);
  ctx.stroke();

  // Degree ticks: one per 10°, with longer ticks at the eight main
  // directions. Drawn between the outer ring and just inside it.
  ctx.strokeStyle = hexToRgba(INK_3, 0.55);
  for (let deg = 0; deg < 360; deg += 10) {
    const ang = (deg / 360) * TAU - TAU / 4;
    const isMain = (deg % 45) === 0;
    const lw = isMain ? 1.0 : 0.55;
    const inLen = isMain ? 7 : 3.5;
    ctx.lineWidth = lw * dpr;
    const x1 = Math.cos(ang) * R;
    const y1 = Math.sin(ang) * R;
    const x2 = Math.cos(ang) * (R - inLen * dpr);
    const y2 = Math.sin(ang) * (R - inLen * dpr);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  // ── Center pip ────────────────────────────────────────────────────────
  ctx.fillStyle = hexToRgba(INK_2, 0.85);
  ctx.beginPath();
  ctx.arc(0, 0, 2.0 * dpr, 0, TAU);
  ctx.fill();
  // Tiny inner highlight ring for a touch of dimensionality.
  ctx.strokeStyle = hexToRgba(INK_3, 0.45);
  ctx.lineWidth = 0.5 * dpr;
  ctx.beginPath();
  ctx.arc(0, 0, 3.6 * dpr, 0, TAU);
  ctx.stroke();

  // ── `N` cardinal label, italic serif ──────────────────────────────────
  ctx.fillStyle = hexToRgba(INK_2, 0.86);
  ctx.font = `italic 600 ${13 * dpr}px "Source Serif 4", "Source Serif Pro", "Iowan Old Style", Georgia, serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("N", 0, -R - 11 * dpr);

  // ── Optional restrained filigree — two tiny ink dots flanking the rose
  // at E/W on the outer ring's compass-rose level. Restraint per spec.
  ctx.fillStyle = hexToRgba(INK_3, 0.42);
  ctx.beginPath();
  ctx.arc(R + 4.5 * dpr, 0, 1.1 * dpr, 0, TAU);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(-R - 4.5 * dpr, 0, 1.1 * dpr, 0, TAU);
  ctx.fill();

  ctx.restore();
}

function drawDryEdges(ctx, now, breath) {
  // PR D: stroke per-level coastlines. L1 (peer) is always present but
  // thins to a hairline above z≈4 so the L2/L3 detail underneath reads.
  // L2 (per-host) fades in around z=1.4. L3 (topic clusters) fades in
  // around z=4. Each level uses its own per-owner color from the cached
  // coastMetaByLevel structure.
  const W = state.washCanvas.width, H = state.washCanvas.height;
  if (!W || !H) return;
  const cw0 = Math.max(1, state.canvas.width);
  const ch0 = Math.max(1, state.canvas.height);
  const wsx = cw0 / W;
  const wsy = ch0 / H;
  const vScale = state.viewport.scale;
  const zoomNorm = Math.max(0.85, Math.min(1.6, Math.sqrt(vScale)));

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // ── L1 — peer coastlines (always present) ─────────────────────────────
  // Single-pass vector contour, matching the L2 sub-coastline style but
  // slightly heavier so peer territory still reads as the dominant
  // boundary. (Earlier versions stamped a halo+ink double stroke at
  // 1.5–1.7 px which read as a chunky stippled ring near zoom 1×.)
  const linesL1 = state.coastlinesByLevel[LEVEL_PEER] || [];
  const metaL1 = state.coastMetaByLevel[LEVEL_PEER] || { colors: [], parents: [] };
  const populated = state.populatedCountries || [];
  // Above L1_FADE_TO_HAIRLINE the peer coastline drops to a 0.6 px
  // hairline at ~30% alpha so the smaller territorial outlines can carry
  // the read.
  const peerThin = smoothstep(vScale, L1_FADE_TO_HAIRLINE - 0.4, L1_FADE_TO_HAIRLINE + 0.4);
  for (let oi = 0; oi < linesL1.length; oi++) {
    const polys = linesL1[oi] || [];
    if (!polys.length) continue;
    const ownerColor = metaL1.colors[oi] || INK_3;
    const parentIdx = metaL1.parents[oi] | 0;
    const c = populated[parentIdx];
    // Pulse halo (existing wet-edge ripple — peer-level only). Now folded
    // into the single stroke as a small alpha + width bump rather than a
    // separate saturated halo pass.
    let pulse = 0;
    if (c) {
      const p = state.pulses.get(c.pk);
      if (p) {
        const u = (now - p.startMs) / p.durationMs;
        if (u >= 1) state.pulses.delete(c.pk);
        else pulse = (1 - u) * (1 - u);
      }
    }
    // Default-zoom contour — ink-3 mixed with the peer's signature color
    // at ~25%, alpha ~50%, ~1.1 px (vs. L2's 1.05 px so peer still leads).
    if (peerThin < 0.95) {
      const inkW = (1.10 * zoomNorm) + 0.4 * pulse;
      const alpha = (0.50 + 0.20 * pulse) * (1 - peerThin);
      ctx.strokeStyle = mixHex(INK_3, ownerColor, 0.25);
      ctx.globalAlpha = alpha;
      ctx.lineWidth = inkW;
      drawCoastPolys(ctx, polys, wsx, wsy, vScale, W, H);
    }
    // Hairline path at deep zoom — 0.6 px at 30%, single stroke.
    if (peerThin > 0.05) {
      ctx.strokeStyle = INK_4;
      ctx.globalAlpha = 0.30 * peerThin;
      ctx.lineWidth = 0.6 * zoomNorm;
      drawCoastPolys(ctx, polys, wsx, wsy, vScale, W, H);
    }
  }

  // ── L2 — per-host coastlines (fade in 1.1 → 1.7) ──────────────────────
  const a2 = levelOpacity(vScale, L2_THRESHOLD, L2_WIDTH);
  if (a2 > 0.02) {
    const linesL2 = state.coastlinesByLevel[LEVEL_HOST] || [];
    const metaL2 = state.coastMetaByLevel[LEVEL_HOST] || { colors: [], parents: [] };
    // Per-spec: line weight ~0.7× the L1 ink stroke; color is the
    // sub-region's hue mixed with ink at ~25%.
    const inkW = 1.05 * zoomNorm;
    for (let oi = 0; oi < linesL2.length; oi++) {
      const polys = linesL2[oi] || [];
      if (!polys.length) continue;
      const ownerColor = metaL2.colors[oi] || INK_3;
      ctx.strokeStyle = mixHex(ownerColor, INK, 0.25);
      ctx.globalAlpha = 0.66 * a2;
      ctx.lineWidth = inkW;
      drawCoastPolys(ctx, polys, wsx, wsy, vScale, W, H);
    }
  }

  // ── L3 — topic-cluster coastlines (fade in 3.5 → 4.5) ─────────────────
  const a3 = levelOpacity(vScale, L3_THRESHOLD, L3_WIDTH);
  if (a3 > 0.02) {
    const linesL3 = state.coastlinesByLevel[LEVEL_TOPIC] || [];
    const metaL3 = state.coastMetaByLevel[LEVEL_TOPIC] || { colors: [] };
    // Even thinner: provincial-level outlines whisper rather than shout.
    const inkW = 0.7 * zoomNorm;
    for (let oi = 0; oi < linesL3.length; oi++) {
      const polys = linesL3[oi] || [];
      if (!polys.length) continue;
      const ownerColor = metaL3.colors[oi] || INK_3;
      ctx.strokeStyle = mixHex(ownerColor, INK, 0.22);
      ctx.globalAlpha = 0.50 * a3;
      ctx.lineWidth = inkW;
      drawCoastPolys(ctx, polys, wsx, wsy, vScale, W, H);
    }
  }

  ctx.globalAlpha = 1;
  ctx.restore();
}

// PR C: stroke a list of polylines with the active ctx style. Wash-px
// coords are mapped through the same projection as the wash bitmap and
// the vector layers, so a polyline stroke lands pixel-aligned with the
// painted wash beneath it.
//   px_w, py_w  : wash-pixel coords (range [0, W) × [0, H))
//   wsx, wsy   : wash-px → canvas-px factor (canvas.W / W, canvas.H / H)
// Wash pixel (px_w) maps to canvas px (px_w * wsx). After applyWorldTransform
// (translate to f.cx,f.cy then scale by vScale then translate by viewport.tx,ty)
// the screen position is:
//   sx = f.cx + (px_w * wsx - f.cx + viewport.tx) * vScale
//   sy = f.cy + (py_w * wsy - f.cy + viewport.ty) * vScale
function drawCoastPolys(ctx, polys, wsx, wsy, vScale, W, H) {
  const f = state.frame;
  const tx = state.viewport.tx;
  const ty = state.viewport.ty;
  for (const p of polys) {
    if (p.length < 4) continue;
    ctx.beginPath();
    let started = false;
    for (let j = 0; j < p.length; j += 2) {
      const x = f.cx + (p[j] * wsx - f.cx + tx) * vScale;
      const y = f.cy + (p[j + 1] * wsy - f.cy + ty) * vScale;
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

function drawCaravans(ctx) {
  if (!state.caravans.length) return;
  const tlActive = state.timelapse.active;
  const tlNow = state.timelapse.nowMs;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineWidth = 0.6;
  ctx.strokeStyle = "rgba(60, 50, 36, 0.18)";

  for (const cv of state.caravans) {
    if (tlActive && cv.bornAt > tlNow) continue;
    const [ax, ay] = worldToScreen(cv.ax, cv.ay);
    const [bx, by] = worldToScreen(cv.bx, cv.by);
    // Quadratic arc: midpoint pushed perpendicular by ~10% of the chord
    // length, biased by per-edge jitter so a flock of edges between two
    // countries reads as a *braid* rather than a single cable.
    const mx = (ax + bx) / 2;
    const my = (ay + by) / 2;
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (len < 4) continue;
    const nx = -dy / len, ny = dx / len;
    const arc = (0.06 + 0.08 * cv.jitter) * len * (cv.jitter > 0.5 ? 1 : -1);
    const ctlX = mx + nx * arc;
    const ctlY = my + ny * arc;

    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.quadraticCurveTo(ctlX, ctlY, bx, by);
    ctx.stroke();
  }
  ctx.restore();
}

function drawTowns(ctx, now) {
  const ONE_DAY = 86400000;
  const realNow = Date.now();
  const populated = state.populatedCountries || state.countries;
  // PR B: gentle dot scaling with zoom — softer than linear so towns
  // stay calm when zoomed in.
  const vScale = state.viewport.scale;
  const dotK = Math.max(0.85, Math.min(2.4, Math.sqrt(vScale)));
  const hoveredId = state.hoverNodeId;
  // PR C: snapshot-diff pulse intensity. 0.4 → 0.15 → 0.4 over 3s,
  // looping for the first 60s after mount, then settles to a calm
  // static glow at the trough alpha.
  const sinceMount = now - state.diffMountedAt;
  let diffPulseAlpha = 0.18; // settled glow
  if (sinceMount < DIFF_PULSE_LOOP_MS) {
    const phase = (sinceMount / DIFF_PULSE_PERIOD_MS) % 1;
    // 0.4 → 0.15 → 0.4 — a soft cosine sweep
    diffPulseAlpha = 0.275 + 0.125 * Math.cos(phase * TAU);
  }
  // PR C: time-lapse — only towns whose fetched_at <= timelapse.nowMs
  // are visible while replay is active. Past the pin, they appear.
  const tlActive = state.timelapse.active;
  const tlNow = state.timelapse.nowMs;
  for (const c of populated) {
    for (const t of c.towns) {
      // PR C: time-lapse gate.
      if (tlActive && t.fetchedAt > tlNow) continue;
      const [x, y] = worldToScreen(t.x, t.y);
      const isRecent = realNow - t.fetchedAt < ONE_DAY;
      // PR C: snapshot-diff halo — soft glow in the territory color.
      // Drawn under everything else.
      if (t.isNew) {
        ctx.fillStyle = hexToRgba(c.color, diffPulseAlpha);
        ctx.beginPath();
        ctx.arc(x, y, 6 * dotK, 0, TAU);
        ctx.fill();
        // Inner brighter dot of the same color so the halo's centre
        // carries the peer signature even before you read the dot.
        ctx.fillStyle = hexToRgba(c.color, Math.min(0.9, diffPulseAlpha + 0.35));
        ctx.beginPath();
        ctx.arc(x, y, 3.4 * dotK, 0, TAU);
        ctx.fill();
      }
      // Town dot: a small filled circle. Recent towns get a faint halo
      // — calm, not pulsing.
      if (isRecent) {
        ctx.fillStyle = hexToRgba(c.color, 0.36);
        ctx.beginPath();
        ctx.arc(x, y, 4.2 * dotK, 0, TAU);
        ctx.fill();
      }
      // PR B: hover ink halo — subtle, ~2px ring of --ink-1 at 30%.
      if (t.id === hoveredId) {
        ctx.strokeStyle = "rgba(26, 20, 16, 0.30)";
        ctx.lineWidth = 2 * dotK;
        ctx.beginPath();
        ctx.arc(x, y, 6 * dotK, 0, TAU);
        ctx.stroke();
      }
      // A degree-bumped town reads slightly bigger. The base size is
      // tuned for projection — at 1244 px screen width the dot reads
      // as a clear point but doesn't dominate.
      const r = (1.4 + Math.min(1.6, Math.sqrt(t.degree + 1) * 0.55)) * dotK;
      ctx.fillStyle = mixHex(c.color, INK, 0.70);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.fill();
    }
  }
}

// PR B: zoom-aware label layers.
//
//   zoom <  1.2×  →  only territory labels (per-peer nicknames)
//   zoom 1.2–4×   →  + sub-region host names (one per (peer, host) pair)
//   zoom >  4×    →  + individual page titles next to towns
//
// Each layer crossfades smoothly across a small band so the map doesn't
// snap. Labels use AABB collision against already-placed labels at the
// same priority — a higher-degree town wins when two would overlap.
function drawPlaceNames(ctx) {
  const populated = state.populatedCountries || [];
  if (!populated.length) return;
  const z = state.viewport.scale;
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  // Track placed AABBs so each layer can avoid colliding with a more-
  // dominant one underneath. Keep them across layers — territory labels
  // are sacred; sub-regions defer to them; titles defer to both.
  const placed = [];

  // ── 1) Territory labels (always on; the map's bones) ────────────────
  // Per user feedback ("lets only show concepts"), the L1 peer label is
  // *only* the c-TF-IDF themes — no nickname, no page count. Italic serif,
  // top 1-2 themes joined with a `·`. If a peer has no derivable themes
  // (e.g., empty or single-page) we render nothing here; the legend still
  // carries the peer name + count for identification.
  for (const c of populated) {
    const themes = (c.peerThemes || []).slice(0, 2);
    if (themes.length === 0) continue;
    const [x, y] = worldToScreen(c.cx, c.cy);
    const themeText = themes.join("  ·  ");
    ctx.font = `italic 19px "Iowan Old Style", "Hoefler Text", Georgia, "Times New Roman", serif`;
    const w1 = ctx.measureText(themeText).width;
    const aabb = { x: x - w1 / 2 - 4, y: y - 14, w: w1 + 8, h: 26 };
    // Paper shadow, then ink.
    ctx.fillStyle = "rgba(242, 235, 220, 0.85)";
    ctx.fillText(themeText, x + 1, y + 1);
    ctx.fillStyle = INK;
    ctx.fillText(themeText, x, y);
    placed.push(aabb);
  }

  // ── 2) Sub-region labels (one concept per (peer, host) territory) ──
  // Per user feedback ("lets only show concepts"), the host caption has
  // been removed from the map. Each L2 territory renders as a single line:
  //   italic serif, ~13.5px, --ink-2 — the c-TF-IDF concept.
  // Confidence: territories whose top:second ratio cleared CONCEPT_GATE_RATIO
  // render at full opacity; lower-confidence picks render at ~70% so they
  // read as softer place names without ever exposing a URL/host.
  // Crossfade in across [1.0, 1.4]. Skip entirely when zoomed out so the
  // overview reads clean.
  const subAlpha = smoothstep(z, ZOOM_MID_BAND[0], ZOOM_MID_BAND[1]);
  if (subAlpha > 0.02) {
    // Sort all sub-regions by pageCount desc — bigger gets first claim.
    const all = [];
    for (const c of populated) {
      const regions = c.regions || [];
      for (const r of regions) {
        if (!r.host || r.host === "(no host)" || r.host === "(fields)") continue;
        if (!r.conceptName) continue; // no concept → nothing to draw (never a URL)
        all.push({ region: r, country: c });
      }
    }
    all.sort((a, b) => b.region.pageCount - a.region.pageCount);
    for (const { region } of all) {
      const [x, y] = worldToScreen(region.cx, region.cy);
      const conceptTxt = region.conceptName.toLowerCase();
      const confident = !!region.conceptConfident;
      // Confidence-weighted opacity. Confident → full strength; weak →
      // ~70% so it's clearly a softer call but still legible.
      const conf = confident ? 1.0 : 0.7;

      ctx.font = `italic 17px "Iowan Old Style", "Hoefler Text", Georgia, "Times New Roman", serif`;
      ctx.letterSpacing = "0.04em";
      const w = ctx.measureText(conceptTxt).width * 1.04;
      const aabb = { x: x - w / 2 - 4, y: y - 11, w: w + 8, h: 22 };
      if (collides(aabb, placed)) continue;
      // Paper shadow then ink, both modulated by subAlpha and conf.
      ctx.globalAlpha = subAlpha * conf;
      ctx.fillStyle = `rgba(242, 235, 220, 0.85)`;
      ctx.fillText(conceptTxt, x + 0.6, y + 0.6);
      ctx.fillStyle = INK_2;
      ctx.fillText(conceptTxt, x, y);
      placed.push(aabb);
    }
    ctx.letterSpacing = "0";
    ctx.globalAlpha = 1.0;
  }

  // ── 2.5) Topic-cluster labels (L3) ─────────────────────────────────
  // Per spec: small italic mono small-caps label at zoom > 5× listing
  // the top 1-2 distinctive token(s). Crossfade in across [4.5, 5.5] so
  // the cluster *blobs* (which fade in around z=4) read first; the
  // labels arrive a beat later as the user keeps zooming.
  const topicAlpha = smoothstep(z, 4.5, 5.5);
  if (topicAlpha > 0.02) {
    ctx.globalAlpha = topicAlpha;
    ctx.font = `italic 500 11.5px "Berkeley Mono", "JetBrains Mono", ui-monospace, monospace`;
    ctx.letterSpacing = "0.10em";
    // Sort clusters by towns desc so the most prominent claim labels first.
    const allCl = [];
    for (const c of populated) {
      const regs = c.regions || [];
      for (const r of regs) {
        const cls = r.clusters || [];
        for (const cl of cls) {
          if (!cl.topToken) continue;
          if (cl.towns.length < 3) continue; // tiny clusters stay unlabeled
          allCl.push(cl);
        }
      }
    }
    allCl.sort((a, b) => b.towns.length - a.towns.length);
    for (const cl of allCl) {
      const [x, y] = worldToScreen(cl.cx, cl.cy);
      const txt = cl.topToken.toUpperCase();
      const w = ctx.measureText(txt).width;
      const padded = w * 1.10;
      const aabb = { x: x - padded / 2 - 4, y: y - 7, w: padded + 8, h: 14 };
      if (collides(aabb, placed)) continue;
      ctx.fillStyle = `rgba(242, 235, 220, ${0.74 * topicAlpha})`;
      ctx.fillText(txt, x + 0.6, y + 0.6);
      ctx.fillStyle = INK_3;
      ctx.fillText(txt, x, y);
      placed.push(aabb);
    }
    ctx.letterSpacing = "0";
    ctx.globalAlpha = 1.0;
  }

  // ── 3) Individual page titles (close zoom) ──────────────────────────
  // Crossfade in across [3.6, 4.4]. Skip entirely below threshold.
  const closeAlpha = smoothstep(z, ZOOM_CLOSE_BAND[0], ZOOM_CLOSE_BAND[1]);
  if (closeAlpha > 0.02) {
    ctx.globalAlpha = closeAlpha;
    ctx.font = `italic 13px "Iowan Old Style", "Hoefler Text", Georgia, "Times New Roman", serif`;
    // Build a town list sorted by (degree desc, pageCount-of-region desc)
    // so prominent towns get to label first.
    const towns = [];
    for (const c of populated) {
      for (const t of c.towns) {
        towns.push({ t, c, degree: t.degree | 0 });
      }
    }
    towns.sort((a, b) => b.degree - a.degree);
    // We're going to draw a bunch — cap so the close-up doesn't become
    // a wall of italic.
    const TITLE_MAX = 220;
    let drawn = 0;
    for (const { t, c } of towns) {
      if (drawn >= TITLE_MAX) break;
      const [x, y] = worldToScreen(t.x, t.y);
      // Skip off-screen titles fast — both sides + a margin so labels
      // already in-frame don't pop off when their dot is just clipped.
      if (x < -200 || y < -100 || x > state.canvas.width + 200 || y > state.canvas.height + 100) continue;
      const txt = truncTitle(t.title || t.host || t.id || "untitled", 40);
      if (!txt) continue;
      const w = ctx.measureText(txt).width;
      // Position: 8px to the right of the dot, vertically centred.
      const ox = x + 8;
      const oy = y;
      const aabb = { x: ox - 2, y: oy - 7, w: w + 4, h: 14 };
      if (collides(aabb, placed)) continue;
      // 1px hairline connector from dot edge to text baseline-left.
      ctx.strokeStyle = "rgba(60, 50, 36, 0.35)";
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      ctx.moveTo(x + 4, y);
      ctx.lineTo(ox - 2, oy);
      ctx.stroke();
      // text — paper shadow, then ink.
      ctx.textAlign = "left";
      ctx.fillStyle = `rgba(242, 235, 220, ${0.85 * closeAlpha})`;
      ctx.fillText(txt, ox + 0.6, oy + 0.6);
      ctx.fillStyle = INK_2;
      ctx.fillText(txt, ox, oy);
      ctx.textAlign = "center";
      placed.push(aabb);
      drawn++;
    }
    ctx.globalAlpha = 1.0;
  }

  ctx.restore();
}

// PR B: smooth crossfade helper (Hermite smoothstep).
function smoothstep(x, a, b) {
  if (b <= a) return x >= b ? 1 : 0;
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

// PR D: sigmoid-based level opacity. Reads "fade in around `threshold`,
// transition width `width`". A wider width means a softer crossfade.
// At x = threshold the value is 0.5; at threshold ± 3*width it's at the
// asymptotes. So the *visible* fade window is roughly threshold ± 3w.
function levelOpacity(zoom, threshold, width) {
  if (width <= 0) return zoom >= threshold ? 1 : 0;
  return 1 / (1 + Math.exp(-(zoom - threshold) / width));
}

// PR B: trivial AABB overlap test for label collision avoidance.
function collides(a, list) {
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    if (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y) return true;
  }
  return false;
}

// PR B: format a host string for the sub-region label. Drop "www.",
// trim long TLDs the way an atlas would.
function formatHost(host) {
  if (!host) return "";
  let s = String(host).trim().toLowerCase();
  if (s.startsWith("www.")) s = s.slice(4);
  // Cap at 22ch so a packed sub-region doesn't blow the layout.
  if (s.length > 22) s = s.slice(0, 21) + "…";
  return s;
}

// PR B: truncate a page title to N characters, ellipsis at word boundary
// when reasonable, otherwise hard-cut.
function truncTitle(s, n) {
  if (!s) return "";
  s = String(s).trim();
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace > n - 12) return cut.slice(0, lastSpace) + "…";
  return cut + "…";
}

function drawSurveyor(ctx) {
  if (state.reducedMotion) return;
  // The wandering surveyor — a single tiny ink mark drifting over the map.
  // Drawn as a small + with a faint trailing dot, so it reads as
  // "someone making notes" rather than a UI cursor.
  const [sx, sy] = worldToScreen(state.surveyor.x, state.surveyor.y);
  ctx.save();
  ctx.strokeStyle = INK_2;
  ctx.lineWidth = 0.9;
  ctx.globalAlpha = 0.74;
  ctx.beginPath();
  ctx.moveTo(sx - 4, sy);
  ctx.lineTo(sx + 4, sy);
  ctx.moveTo(sx, sy - 4);
  ctx.lineTo(sx, sy + 4);
  ctx.stroke();
  // trailing dot
  ctx.fillStyle = INK_3;
  ctx.beginPath();
  ctx.arc(sx, sy, 1.2, 0, TAU);
  ctx.fill();
  ctx.restore();
}

function drawVignette(ctx) {
  const w = state.canvas.width, h = state.canvas.height;
  // Two passes for the terra-incognita pass: a soft inner radial that
  // matches the previous chrome, layered with a tighter corner-only
  // multiply so the four corners feel page-worn (~5–8% darker than centre)
  // without the whole composition dimming.
  const grad = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.42,
                                        w / 2, h / 2, Math.max(w, h) * 0.66);
  grad.addColorStop(0, "rgba(0,0,0,0)");
  grad.addColorStop(1, "rgba(20, 14, 8, 0.16)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  // Corner-wear overlay — multiply blended so it modulates whatever's
  // beneath rather than stacking on top. Goes from 0 in the centre to
  // ~6% darker at the corners, the spec'd "page wear" amount.
  const prevOp = ctx.globalCompositeOperation;
  ctx.globalCompositeOperation = "multiply";
  const cornerGrad = ctx.createRadialGradient(
    w / 2, h / 2, Math.min(w, h) * 0.55,
    w / 2, h / 2, Math.hypot(w, h) * 0.55
  );
  cornerGrad.addColorStop(0, "rgba(255, 248, 232, 1)");
  cornerGrad.addColorStop(1, "rgba(208, 192, 162, 1)");
  ctx.fillStyle = cornerGrad;
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = prevOp;
}

// ─── surveyor walker ─────────────────────────────────────────────────────
// Slow random walk biased toward the highest-density country. Reframed
// every ~12s so it doesn't get stuck. Speed ~ 30 world-units / second
// (in a world of radius ~1000, that's a slow tour).

function advanceSurveyor(dt) {
  if (state.reducedMotion) return;
  const s = state.surveyor;
  s.t += dt;
  // re-pick a target every 12000ms biased by page count
  if (s.t > 12000 || s.targetX == null) {
    s.t = 0;
    s.targetX = 0; s.targetY = 0;
    if (state.countries.length) {
      const totalPages = state.countries.reduce((acc, c) => acc + c.pageCount, 0);
      if (totalPages > 0) {
        // Use a per-tick deterministic-ish pick (Math.random ok here —
        // surveyor isn't part of the photographic frame guarantees).
        let pick = Math.random() * totalPages;
        for (const c of state.countries) {
          pick -= c.pageCount;
          if (pick <= 0) {
            // jitter inside the country
            const a = Math.random() * TAU;
            const r = c.r * 0.6 * Math.random();
            s.targetX = c.cx + Math.cos(a) * r;
            s.targetY = c.cy + Math.sin(a) * r;
            break;
          }
        }
      }
    }
  }
  // ease toward target
  const k = 0.6 / 1000; // per-ms — extremely soft
  const dx = (s.targetX - s.x) * k * dt;
  const dy = (s.targetY - s.y) * k * dt;
  s.x += dx; s.y += dy;
}

// ─── viewport math ───────────────────────────────────────────────────────

// PR B: world→screen now composes the user's pan + zoom on top of the
// base "fit world to canvas" projection. The viewport tx/ty are CSS-px
// translations applied BEFORE the centring offset; the scale multiplies
// the base k. The vector path uses these so towns/edges/labels stay
// pixel-aligned at every zoom.
function worldToScreen(wx, wy) {
  const f = state.frame;
  // Base "fit world to visible-frame" projection. 0.45 of the frame's
  // smaller dimension matches the wash bitmap's internal projection,
  // so vector layers and the watercolor wash align pixel-for-pixel at
  // every zoom. The frame already excludes the cartouche + legend, so
  // the map sits centered in the unobstructed area.
  const k = (f.span * 0.45) / state.worldRadius;
  const s = state.viewport.scale;
  return [
    f.cx + (wx * k + state.viewport.tx) * s,
    f.cy + (wy * k + state.viewport.ty) * s,
  ];
}

// Wash uses the un-viewportified mapping — the wash bitmap is generated
// in world space at its own resolution, and the live canvas applies the
// viewport transform to the bitmap when it draws. So this conversion is
// only the world → wash-px projection.
//
// As of this PR the wash bitmap covers the entire canvas (not just the
// state.frame square). worldToWash is parameterised so wash-pixel (px,py)
// corresponds 1:1 to canvas-pixel (px / sx, py / sy) where sx/sy are the
// wash-downscale factors. Then the wash is drawn at full canvas extent
// (offset by -f.cx,-f.cy in pre-applyWorldTransform local space) so
// territories near the canvas edges no longer get clipped at the wash
// bitmap boundary. Fixes the hard horizontal cutoff at the top of the
// map the user reported.
function worldToWash(wx, wy, W, H) {
  const f = state.frame;
  const k = (f.span * 0.45) / state.worldRadius;
  const sx = W / Math.max(1, state.canvas.width);
  const sy = H / Math.max(1, state.canvas.height);
  return [(f.cx + wx * k) * sx, (f.cy + wy * k) * sy];
}

function screenToWorld(sx, sy) {
  const f = state.frame;
  const k = (f.span * 0.45) / state.worldRadius;
  const s = state.viewport.scale;
  return [
    ((sx - f.cx) / s - state.viewport.tx) / k,
    ((sy - f.cy) / s - state.viewport.ty) / k,
  ];
}

// Compute the "visible frame" — the area of the canvas the map should
// fit inside. Cartouche occupies the top-left (~280px wide × ~110px
// tall, anchored at left:60px / top:56px). Legend occupies the bottom-
// right (~240px wide × ~140px tall, anchored at right:60px / bottom:
// 56px). The frame sits in the largest balanced rectangle inside the
// canvas that doesn't overlap either, then gets a uniform 8% inner
// pad so the map doesn't kiss its own edges at home zoom.
//
// All output values are in canvas device-pixels (multiplied through
// dpr) because worldToScreen/applyWorldTransform read state.canvas.{
// width,height} which are device-pixels.
function computeFrame(cssW, cssH, dpr) {
  // Reservation rectangles — picked to match the CSS overlays. We
  // give them a 12px breathing margin so the cartouche/legend don't
  // visually touch the country wash. CSS-pixel space.
  const cartW = 320, cartH = 130;
  const cartL = 48,  cartT = 44;
  const legW  = 260, legH  = 160;
  const legR  = 48,  legB  = 44;
  // The frame is the area bounded by:
  //   left  = cartL + cartW + margin (skip past cartouche right edge)
  //   right = cssW - (legR + legW + margin) (skip past legend left edge)
  //   top   = innerPad
  //   bot   = cssH - innerPad
  // But that's overly aggressive — the cartouche only blocks the top-
  // left corner, not the full vertical strip. So we relax: the frame
  // is the whole canvas, but the map's center is shifted toward the
  // unobstructed area by half the asymmetry of the reservations.
  // Effective fit-area dimensions: width minus the *average* horizontal
  // reservation, similar for height.
  const innerPad = 24; // CSS px breathing room around the canvas edge
  const usableW = Math.max(120, cssW - innerPad * 2);
  const usableH = Math.max(120, cssH - innerPad * 2);
  // Center shift: cartouche on left pulls center right; legend on right
  // pulls center left. Net horizontal shift is half the difference of
  // the reservations' inward extents (CSS px → device px via dpr).
  const cartoucheRight = cartL + cartW;
  const legendLeft     = cssW - (legR + legW);
  const cartoucheBot   = cartT + cartH;
  const legendTop      = cssH - (legB + legH);
  // Midpoint of the unobstructed horizontal corridor: avg of cartouche
  // right and legend left, clamped inside the canvas.
  const midX = clamp((cartoucheRight + legendLeft) / 2, innerPad + 60, cssW - (innerPad + 60));
  const midY = clamp((cartoucheBot + legendTop) / 2, innerPad + 60, cssH - (innerPad + 60));
  // Span: smaller of usable width / height. Subtract a further 8% for
  // a comfortable margin around the map at home zoom.
  const span = Math.max(120, Math.min(usableW, usableH) * 0.92);
  state.frame.cx = midX * dpr;
  state.frame.cy = midY * dpr;
  state.frame.w = usableW * dpr;
  state.frame.h = usableH * dpr;
  state.frame.span = span * dpr;
}

// ─── resize ──────────────────────────────────────────────────────────────

function resize() {
  if (!state.canvas) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const rect = state.container.getBoundingClientRect();
  const cssW = Math.max(1, rect.width | 0);
  const cssH = Math.max(1, rect.height | 0);
  state.canvas.style.width = cssW + "px";
  state.canvas.style.height = cssH + "px";
  state.canvas.width = (cssW * dpr) | 0;
  state.canvas.height = (cssH * dpr) | 0;

  // Compute the visible frame — the rectangle inside the canvas where
  // the map is centered, with cartouche (top-left) and legend (bottom-
  // right) reservations subtracted plus a comfortable margin so the
  // map doesn't graze the canvas edges. Sizes here are in canvas
  // device-pixels, so they multiply through dpr.
  computeFrame(cssW, cssH, dpr);

  // Wash at ~30% of canvas resolution for the distance-field pass.
  // The wash is upscaled with image-smoothing to full size, which is
  // desirable here — we *want* the wet-paper bleed, not crisp pixels.
  // 30% × ~2k = ~600 px wide; with 18 region attractors per country
  // and ~2 countries that's ~36 attractors per pixel, i.e. ~13M ops
  // per repaint. Stays under the 800ms cold-start bar.
  const washW = Math.max(160, Math.round(state.canvas.width * 0.30));
  const washH = Math.max(160, Math.round(state.canvas.height * 0.30));
  state.washCanvas.width = washW;
  state.washCanvas.height = washH;
  // PR D: keep all three level-bitmaps in lockstep with the L1 canvas.
  // washByLevel[0] aliases washCanvas, so we only resize the others here.
  for (let i = 1; i < state.washByLevel.length; i++) {
    if (state.washByLevel[i]) {
      state.washByLevel[i].width = washW;
      state.washByLevel[i].height = washH;
    }
  }
  // Sea-hatching bitmap shares the wash dimensions so it composites under
  // exactly the same transform — concentric lines line up with coastlines.
  if (state.seaHatchCanvas) {
    state.seaHatchCanvas.width = washW;
    state.seaHatchCanvas.height = washH;
  }

  // Paper texture full-res — only redrawn on resize.
  state.paperCanvas.width = state.canvas.width;
  state.paperCanvas.height = state.canvas.height;
  paintPaper(state.paperCanvas);

  // Composite + world working canvases — full canvas resolution. These
  // back the per-frame "paper + world + clouds, masked by deckle"
  // composition in drawFrame. No content baked in here, just sized.
  if (state.composeCanvas) {
    state.composeCanvas.width = state.canvas.width;
    state.composeCanvas.height = state.canvas.height;
  }
  if (state.worldCanvas) {
    state.worldCanvas.width = state.canvas.width;
    state.worldCanvas.height = state.canvas.height;
  }

  // Re-wash since the resolution changed.
  paintWash();
}

// ─── paper layer (cached, screen-space) ──────────────────────────────────
// The paper layer is an offscreen bitmap sized to the visible viewport.
// It's painted once per resize / session change and blitted at (0,0) every
// frame. Because the layer never gets transformed by pan/zoom, all of its
// content (fibres, graticule grid, etc) reads as "fixed to the page" — the
// world layer slides over it.
//
// Composition (bottom → top, all baked into the same bitmap):
//   1. cream → warm-amber radial gradient
//   2. multi-octave hash value noise (paper grain)
//   3. embedded fibres (faint warm strokes)
//   4. graticule grid — minor + major lines, screen-aligned
//   5. edge-wear darkening band just inside the deckle
//
// Foxing is drawn separately in world space (see drawFoxing) so it pans
// and zooms with the territory.
//
// The deckle alpha mask is NOT applied here — drawFrame applies it once
// over the combined paper + world + clouds composite so the territory
// wash and other map content also stop at the torn paper edge.

function paintPaper(c) {
  const w = c.width, h = c.height;
  if (w <= 0 || h <= 0) return;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.clearRect(0, 0, w, h);

  // Cream → very faint warm-amber radial underlay. A touch warmer than
  // the previous gradient so the noise reads as paper rather than grey.
  const grad = ctx.createRadialGradient(
    w * 0.5, h * 0.45, Math.min(w, h) * 0.12,
    w * 0.5, h * 0.5, Math.hypot(w, h) * 0.55
  );
  grad.addColorStop(0, "#F7F0DD");
  grad.addColorStop(0.55, "#EFE4C8");
  grad.addColorStop(1, "#E0D2B0");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  // Value-noise pass: per-pixel multi-octave hash noise modulates the
  // base color. We work in ImageData for the noise — it's the only path
  // that's both fast and deterministic at this resolution.
  const seed = (state.sessionSeed >>> 0) || 0xA5A5A5A5;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  // Deckle: faint horizontal fibre warps make the noise feel like
  // pulped paper rather than digital grain. Each row gets a sin-warp
  // offset that's low-amplitude (under 1 octave's contribution).
  const fibrePeriodA = 38;
  const fibrePeriodB = 113;
  const fibreSeedA = hash2_01(seed, 1) * TAU;
  const fibreSeedB = hash2_01(seed, 2) * TAU;
  const baseScale = Math.max(w, h) / 720; // keep noise period roughly constant across DPRs
  for (let y = 0; y < h; y++) {
    // Per-row warp pulls noise sample horizontally so the grain reads
    // as fibres rather than dots.
    const warp = Math.sin(y / fibrePeriodA + fibreSeedA) * 0.7
               + Math.sin(y / fibrePeriodB + fibreSeedB) * 0.4;
    const rowBase = y * w * 4;
    for (let x = 0; x < w; x++) {
      const xs = (x + warp * 6) / baseScale;
      const ys = y / baseScale;
      // 4 octaves of value-noise. Output ∈ [-1, 1]-ish.
      const n = (
        valueNoise2(xs * 0.012, ys * 0.012, seed ^ 0x100) * 0.55 +
        valueNoise2(xs * 0.035, ys * 0.035, seed ^ 0x200) * 0.28 +
        valueNoise2(xs * 0.110, ys * 0.110, seed ^ 0x400) * 0.13 +
        valueNoise2(xs * 0.330, ys * 0.330, seed ^ 0x800) * 0.06
      );
      const i = rowBase + x * 4;
      // Map noise to a small luminance modulation (~±9 RGB). Slight
      // warm-bias on red/green because foxing-prone paper darkens
      // unevenly toward amber; the blue channel moves a touch less.
      const m = n * 11;
      d[i]     = clamp(d[i]     + m,        0, 255);
      d[i + 1] = clamp(d[i + 1] + m * 0.93, 0, 255);
      d[i + 2] = clamp(d[i + 2] + m * 0.78, 0, 255);
    }
  }
  ctx.putImageData(img, 0, 0);

  // (Foxing spots are no longer baked into the paper layer. They are now
  // an artifact of the *map* — drawn in world space in `drawFoxing()` so
  // they pan and zoom with the territory. The paper itself stays as the
  // surface beneath. See `drawFoxing()` for the world-space pass.)

  // Long fibres — a handful of very faint, slightly-curved warm strokes,
  // deterministic from the session seed, that mimic embedded plant
  // matter in handmade paper. Kept low-density so it doesn't compete
  // with the rest of the texture.
  ctx.strokeStyle = "rgba(120, 88, 48, 0.04)";
  ctx.lineWidth = 0.5;
  const FIBRE_COUNT = 160;
  for (let i = 0; i < FIBRE_COUNT; i++) {
    const u = hash2_01(seed, 500 + i * 4);
    const v = hash2_01(seed, 501 + i * 4);
    const a = hash2_01(seed, 502 + i * 4) * TAU;
    const lF = hash2_01(seed, 503 + i * 4);
    const x = u * w;
    const y = v * h;
    const len = (32 + lF * 64) * baseScale;
    const cx = x + Math.cos(a) * len * 0.5 + (hash2_01(seed, 600 + i) - 0.5) * 8;
    const cy = y + Math.sin(a) * len * 0.5 + (hash2_01(seed, 700 + i) - 0.5) * 8;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(cx, cy, x + Math.cos(a) * len, y + Math.sin(a) * len);
    ctx.stroke();
  }

  // Graticule grid — fine cartographic minor + major lines drawn directly
  // into the paper layer so the entire composition reads as "drawn on grid
  // paper". Lines have noise-perturbed alpha along their length so they
  // don't look mechanically perfect; alpha tapers slightly near the edges
  // to suggest the grid was inked onto a piece of paper that's worn at the
  // perimeter.
  paintGraticuleGrid(ctx, w, h, baseScale, seed);

  // Edge-wear darkening band — a soft inner shadow just inside where the
  // deckle mask will end. Handled paper darkens at the edges from oils
  // and wear; this is the visual signature of an old map sheet.
  paintEdgeWearBand(ctx, w, h, baseScale);

  // The deckle alpha mask is no longer applied to the paper layer in
  // isolation — it is applied to the combined paper+world composite in
  // `drawFrame()` so that the territory wash, foxing, sea hatching, and
  // coastlines are all clipped by the same torn edge. Outside the
  // deckle: dark cosmic chrome shows through.
}

// ─── graticule grid ──────────────────────────────────────────────────────
// Cartographic minor + major lines, screen-aligned. Spacings are in CSS
// pixels and converted to canvas device-pixels via the local `dpr` factor.
//
//   Minor: ~0.4px @ INK_4 ~6% alpha, every 64 CSS px.
//   Major: ~0.6px @ INK_4 ~12% alpha, every 5 minor (320 CSS px).
//
// Per-line alpha is multiplied by a low-frequency value-noise sample (80%
// to 120% of the base alpha) so the grid doesn't look mechanical, and by
// a radial edge-fade so it tapers near the canvas perimeter where the
// deckle eats into the paper.
function paintGraticuleGrid(ctx, w, h, baseScale, seed) {
  // baseScale captures the rough device-pixel scaling we used for the
  // paper noise; we use it here to keep stroke widths visually consistent
  // across DPRs. dpr is roughly baseScale * 720 / max(w,h) but we just
  // re-derive it: the canvas is sized in device-pixels, the spec is in
  // CSS pixels, and Math.max(1, devicePixelRatio) is what we want. We
  // can't trust state.canvas at this point if paper is being painted
  // standalone, so we use baseScale as the proxy.
  const dpr = Math.max(1, baseScale * 720 / Math.max(w, h)) || 1;
  // baseScale was chosen as max(w,h)/720, so dpr ≈ 1 — the grid will
  // render at the correct CSS-pixel pitch on any DPR because w/h
  // already include the dpr factor (see resize()).
  const px = (cssPx) => cssPx * baseScale; // CSS-px → canvas-px
  const MINOR_STEP_CSS = 64;
  const MAJOR_EVERY = 5;

  // Edge-fade radius: lines fade to ~30% in the outer 24 CSS-px so the
  // grid feels like it was drawn on paper that has slightly worn edges.
  const FADE_BAND_PX = px(36);

  // Alpha values are intentionally above the spec'd 6% / 12% to
  // compensate for the sub-pixel line widths and the multiply-blended
  // wash that paints over the grid inside territories. At these widths
  // antialiasing eats most of the alpha, so the perceived grid lands
  // at ~6% / 12% even with these source values.
  const baseMinorA = 0.22;  // alpha of minor line over INK_4
  const baseMajorA = 0.34;  // alpha of major line over INK_4

  const minorW = Math.max(0.7, 0.5 * baseScale);
  const majorW = Math.max(1.0, 0.7 * baseScale);

  ctx.save();

  // Vertical lines.
  let minorIdx = 0;
  for (let x = 0; x <= w + 0.5; x += px(MINOR_STEP_CSS), minorIdx++) {
    const isMajor = (minorIdx % MAJOR_EVERY) === 0;
    const baseA = isMajor ? baseMajorA : baseMinorA;
    const lineW = isMajor ? majorW : minorW;
    // Walk the line in segments so we can perturb alpha and apply the
    // edge fade. Twelve segments per line is plenty — the eye reads the
    // variation as ink density rather than discrete steps.
    const SEG = 14;
    const segH = h / SEG;
    for (let s = 0; s < SEG; s++) {
      const y0 = s * segH;
      const y1 = y0 + segH;
      const ymid = (y0 + y1) * 0.5;
      // Noise-perturbed alpha — value-noise at a low frequency along the
      // line gives a 0.8…1.2× modulation of the base alpha.
      const n = valueNoise2(x * 0.013 + 11, ymid * 0.013, seed ^ 0xA17AE);
      const alphaMod = 0.8 + 0.4 * (n * 0.5 + 0.5); // [-1,1] → [0.8, 1.2]
      // Edge fade — lines taper in alpha within FADE_BAND_PX of any edge
      // along their length.
      const edgeY = Math.min(ymid, h - ymid);
      const edgeX = Math.min(x, w - x);
      const edgeMin = Math.min(edgeX, edgeY);
      const fade = clamp(edgeMin / FADE_BAND_PX, 0.45, 1);
      const a = baseA * alphaMod * fade;
      if (a < 0.005) continue;
      ctx.strokeStyle = hexToRgba(INK_4, a);
      ctx.lineWidth = lineW;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, y0);
      ctx.lineTo(x + 0.5, y1);
      ctx.stroke();
    }
  }

  // Horizontal lines — same structure, axes swapped.
  minorIdx = 0;
  for (let y = 0; y <= h + 0.5; y += px(MINOR_STEP_CSS), minorIdx++) {
    const isMajor = (minorIdx % MAJOR_EVERY) === 0;
    const baseA = isMajor ? baseMajorA : baseMinorA;
    const lineW = isMajor ? majorW : minorW;
    const SEG = 14;
    const segW = w / SEG;
    for (let s = 0; s < SEG; s++) {
      const x0 = s * segW;
      const x1 = x0 + segW;
      const xmid = (x0 + x1) * 0.5;
      const n = valueNoise2(xmid * 0.013, y * 0.013 + 11, seed ^ 0xA17AE);
      const alphaMod = 0.8 + 0.4 * (n * 0.5 + 0.5);
      const edgeY = Math.min(y, h - y);
      const edgeX = Math.min(xmid, w - xmid);
      const edgeMin = Math.min(edgeX, edgeY);
      const fade = clamp(edgeMin / FADE_BAND_PX, 0.45, 1);
      const a = baseA * alphaMod * fade;
      if (a < 0.005) continue;
      ctx.strokeStyle = hexToRgba(INK_4, a);
      ctx.lineWidth = lineW;
      ctx.beginPath();
      ctx.moveTo(x0, y + 0.5);
      ctx.lineTo(x1, y + 0.5);
      ctx.stroke();
    }
  }
  // Suppress unused-variable warning while keeping dpr declared for clarity.
  void dpr;

  ctx.restore();
}

// ─── edge-wear darkening band ────────────────────────────────────────────
// A thin band of multiplied warm darkening just inside the deckle edge.
// The way handled paper darkens at the perimeter from oils and wear.
// Strength: ~5–8% darker than base paper. We achieve it with a multiply
// blend of a tan inset, falling off to white toward the centre.
//
// Width is intentionally narrow (≈14 CSS px) so the band only kisses the
// torn edge — the rest of the paper stays open and the graticule grid
// reads cleanly across the whole sheet. The pre-existing radial vignette
// (drawn on top of the world layer) is what handles broad page-wear; this
// band is purely the "oil-darkened edge" of an old map sheet.
function paintEdgeWearBand(ctx, w, h, baseScale) {
  const prevOp = ctx.globalCompositeOperation;
  ctx.save();
  ctx.globalCompositeOperation = "multiply";
  const bandPx = Math.max(10, 14 * baseScale);

  // Build a "frame" gradient using four edge-aligned linear gradients.
  // Each fades from a warm tan at the edge to white (1.0) at `bandPx` in.
  // ~5% darkening at the edge, fading to 0 inside.
  const TAN = "rgba(232, 218, 188, 1)";  // 1 - this ≈ 0.06 darkening
  const WHITE = "rgba(255, 255, 255, 1)";

  // Top
  let g = ctx.createLinearGradient(0, 0, 0, bandPx);
  g.addColorStop(0, TAN);
  g.addColorStop(1, WHITE);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, bandPx);
  // Bottom
  g = ctx.createLinearGradient(0, h, 0, h - bandPx);
  g.addColorStop(0, TAN);
  g.addColorStop(1, WHITE);
  ctx.fillStyle = g;
  ctx.fillRect(0, h - bandPx, w, bandPx);
  // Left
  g = ctx.createLinearGradient(0, 0, bandPx, 0);
  g.addColorStop(0, TAN);
  g.addColorStop(1, WHITE);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, bandPx, h);
  // Right
  g = ctx.createLinearGradient(w, 0, w - bandPx, 0);
  g.addColorStop(0, TAN);
  g.addColorStop(1, WHITE);
  ctx.fillStyle = g;
  ctx.fillRect(w - bandPx, 0, bandPx, h);

  // (Corner radial darkening removed — it read as triangular "tucks"
  // in the rendered output and the user explicitly asked them gone.
  // The deckle edge alone now handles the corner work; the linear
  // edge-wear bands above still kiss the torn edge with warm darkening.)

  ctx.restore();
  ctx.globalCompositeOperation = prevOp;
}

// ─── deckle alpha mask ───────────────────────────────────────────────────
// Generate (or fetch from cache) a torn-edge alpha mask sized to the
// paper layer. Mixes low-frequency (~3–5px wavelength in CSS px) noise
// with higher-frequency on top so the edge has both occasional larger
// pulls/curls and fine-grained ragged variation. Stable per session —
// regenerated only on resize or seed change.
function ensureDeckleMask(w, h) {
  const cacheValid = state.deckleMaskCanvas
    && state.deckleMaskW === w
    && state.deckleMaskH === h;
  if (cacheValid) return state.deckleMaskCanvas;

  if (!state.deckleMaskCanvas) {
    state.deckleMaskCanvas = document.createElement("canvas");
    state.deckleMaskCtx = state.deckleMaskCanvas.getContext("2d", { willReadFrequently: true });
  }
  state.deckleMaskCanvas.width = w;
  state.deckleMaskCanvas.height = h;
  state.deckleMaskW = w;
  state.deckleMaskH = h;

  paintDeckleMask(state.deckleMaskCtx, w, h);
  return state.deckleMaskCanvas;
}

// Paint the deckle mask: opaque-white on the paper interior, transparent
// outside. The boundary is irregular — driven by per-edge noise that
// determines how far the paper extends inward at every pixel along the
// edge. Two-octave noise (low + high frequency) gives both broad pulls
// and fine ragged grain.
function paintDeckleMask(ctx, w, h) {
  ctx.clearRect(0, 0, w, h);
  const seed = (state.sessionSeed >>> 0) || 0xC0FFEE;
  const baseScale = Math.max(w, h) / 720;

  // Noise wavelengths (CSS px). Low for occasional larger pulls/curls,
  // high for fine-grained ragged variation.
  const LOW_FREQ_PX = 90;   // ~big pulls every 90 CSS px
  const HI_FREQ_PX = 8;     // fine ragged grain every 8 CSS px

  // Edge perturbation amplitude (CSS px). Smoother on long edges, larger
  // at corners. Range: 4–12 CSS px (per spec).
  const AMP_LOW_CSS = 8;    // low-freq amplitude
  const AMP_HI_CSS = 4;     // high-freq amplitude
  const AMP_CORNER_BONUS_CSS = 6; // extra corner aggression

  const ampLow = AMP_LOW_CSS * baseScale;
  const ampHi = AMP_HI_CSS * baseScale;
  const ampCornerBonus = AMP_CORNER_BONUS_CSS * baseScale;

  // For every pixel of each edge, compute the inward depth at which the
  // paper edge sits. That gives us four 1D depth-functions; we then
  // construct the mask polygon by sampling each edge densely and joining
  // them. Filling the polygon with white gives the alpha mask in one
  // pass; outside is left clear so destination-in masks the paper.

  // Helper: corner bonus. Linearly ramps from 0 in the middle of the
  // edge to 1 at the corner, smoothed with a power curve so corners
  // really do tear more than the long stretches.
  function cornerWeight(t) {
    // t ∈ [0, 1] along an edge. Returns corner-aggression amount.
    const dToEdge = Math.min(t, 1 - t);
    // dToEdge=0 at corner, 0.5 in middle. Map 0 → 1, 0.5 → 0 with a
    // cubic falloff so most of the edge is calm, only corners spike.
    const u = clamp(1 - dToEdge * 2, 0, 1); // 1 at corner, 0 by mid
    return u * u * u;
  }

  // Sample density along each edge — 1 sample per ~1.5 px is plenty for
  // a smooth mask polygon at any DPR.
  const stepPx = Math.max(1, Math.round(1.5 * baseScale));

  // depthAt(edge, t) — t ∈ [0, 1] along the edge length. Returns inward
  // distance of paper edge from the canvas edge. Each edge has its own
  // noise seed offset so the four sides aren't twins.
  function depthAt(edgeKey, t, edgeLenPx) {
    // Position along the edge in CSS px.
    const s = t * edgeLenPx / baseScale;
    // Low + high freq noise. Edge-key adds a salt so each side differs.
    const sLow = s / LOW_FREQ_PX;
    const sHi = s / HI_FREQ_PX;
    const nLow = valueNoise2(sLow, edgeKey * 17.3, seed ^ 0xDEAD0000);
    const nHi = valueNoise2(sHi, edgeKey * 31.1, seed ^ 0xBEEF0000);
    // n ∈ [-1, 1] roughly. Map to [0, 1] with bias so the paper *always*
    // sits at least a few px inside the canvas edge — never goes negative
    // (which would push the paper off-screen).
    const cw = cornerWeight(t);
    const corner = cw * ampCornerBonus * (0.5 + 0.5 * Math.abs(nHi));
    const depth = ampLow * (0.55 + 0.45 * (nLow * 0.5 + 0.5))
                + ampHi  * (0.40 + 0.60 * (nHi * 0.5 + 0.5))
                + corner;
    return Math.max(0.5 * baseScale, depth);
  }

  // Build polygon. Start at top-left, walk clockwise.
  ctx.save();
  ctx.fillStyle = "rgba(255, 255, 255, 1)";
  ctx.beginPath();

  // Top edge: y depth varies along x.
  let first = true;
  for (let x = 0; x <= w; x += stepPx) {
    const t = x / w;
    const dy = depthAt(0, t, w);
    if (first) { ctx.moveTo(x, dy); first = false; }
    else ctx.lineTo(x, dy);
  }
  // Right edge: x depth = w - depth, varies along y.
  for (let y = 0; y <= h; y += stepPx) {
    const t = y / h;
    const dx = depthAt(1, t, h);
    ctx.lineTo(w - dx, y);
  }
  // Bottom edge: y = h - depth, walking back from x=w to 0.
  for (let x = w; x >= 0; x -= stepPx) {
    const t = x / w;
    const dy = depthAt(2, t, w);
    ctx.lineTo(x, h - dy);
  }
  // Left edge: x = depth, walking back from y=h to 0.
  for (let y = h; y >= 0; y -= stepPx) {
    const t = y / h;
    const dx = depthAt(3, t, h);
    ctx.lineTo(dx, y);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function applyDeckleMask(ctx, w, h) {
  const mask = ensureDeckleMask(w, h);
  if (!mask) return;
  const prev = ctx.globalCompositeOperation;
  ctx.globalCompositeOperation = "destination-in";
  ctx.drawImage(mask, 0, 0, w, h);
  ctx.globalCompositeOperation = prev;
}

// Deterministic hash → [0, 1). Two-input 32-bit Wang/xmur mix.
function hash2_01(s, k) {
  let x = (s ^ (k * 0x9E3779B1)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x7FEB352D) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x846CA68B) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  return x / 4294967296;
}

// 2D value-noise sample with bilinear interpolation and a smoothstep
// fade. Domain is float; output ∈ [-1, 1]. Stable per-seed.
function valueNoise2(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const v00 = hash2_01(seed, ((xi & 0xFFFF) << 16) ^ (yi & 0xFFFF)) * 2 - 1;
  const v10 = hash2_01(seed, (((xi + 1) & 0xFFFF) << 16) ^ (yi & 0xFFFF)) * 2 - 1;
  const v01 = hash2_01(seed, ((xi & 0xFFFF) << 16) ^ ((yi + 1) & 0xFFFF)) * 2 - 1;
  const v11 = hash2_01(seed, (((xi + 1) & 0xFFFF) << 16) ^ ((yi + 1) & 0xFFFF)) * 2 - 1;
  const sx = xf * xf * (3 - 2 * xf);
  const sy = yf * yf * (3 - 2 * yf);
  const a = v00 * (1 - sx) + v10 * sx;
  const b = v01 * (1 - sx) + v11 * sx;
  return a * (1 - sy) + b * sy;
}

// ─── sea hatching (engraved water) ───────────────────────────────────────
// Concentric wavy lines following each territory's coastline at increasing
// offset, like classical engraved seas on a portolan. The geometry is the
// L1 distance field — for every "sea" pixel we sample the weighted distance
// k = d / r (same dimensionless coordinate the wash already uses) and drop
// hairline pixels where floor(K * spacing) flips between neighbours, with
// a sin-jitter on K to take the mechanical edge off. Density falls off
// from coast to ~30% canvas-radius. Drawn into a wash-resolution offscreen
// canvas; per-frame cost is one drawImage.
function paintSeaHatching() {
  const c = state.seaHatchCanvas;
  const ctx = state.seaHatchCtx;
  if (!c || !ctx) return;
  const W = c.width, H = c.height;
  if (W <= 0 || H <= 0) return;
  ctx.clearRect(0, 0, W, H);

  const populated = state.populatedCountries || [];
  if (!populated.length) return;

  // Build the same per-attractor list as paintWashLevel(LEVEL_PEER) so the
  // distance field matches the L1 wash exactly.
  const f = state.frame;
  const k = (f.span * 0.45) / state.worldRadius;
  const sxFac = W / Math.max(1, state.canvas.width);
  const radPx = (rWorld) => rWorld * k * sxFac;
  const cps = [];
  for (const cnt of populated) {
    const [px, py] = worldToWash(cnt.cx, cnt.cy, W, H);
    cps.push({ px, py, pr: radPx(cnt.r), cx: cnt.cx, cy: cnt.cy });
  }

  // Spacing of concentric rings in K (dimensionless). 6 rings between K=1
  // and K≈3 reads as a soft engraved field — anything denser fights the
  // wash for attention; sparser stops feeling like cartography.
  const RING_K_PERIOD = 0.16;
  // Falloff: density goes from 1 at the coast to 0 around K ≈ 3 (~30% of
  // canvas radius for a typical territory). Beyond that we leave it alone
  // so the open quadrants stay calm parchment.
  const FALLOFF_K = 3.4;
  const seed = (state.sessionSeed >>> 0) || 0xDEADBEEF;

  // Pixel-loop: for each sea pixel compute K to the nearest attractor and
  // mark it where the iso-band flips. We compute K once per pixel and
  // compare to a horizontal neighbour — this draws vertical-ish iso edges,
  // and we repeat with a vertical neighbour for the orthogonal direction.
  // Total ops ≈ 2 × W × H × cps.length, safely under the 800ms cold-start
  // bar at 600×250 with ≤16 territories.
  const img = ctx.createImageData(W, H);
  const data = img.data;
  // Pre-convert ink-4 to RGB for the line color
  const INK4 = hexToRgb(INK_4);

  // bestK at (x,y); also returns the angle-from-best-centroid for the sin-
  // jitter so the rings feel hand-engraved.
  function bestKAt(x, y) {
    let bestK = Infinity;
    let bestI = -1;
    for (let i = 0; i < cps.length; i++) {
      const cp = cps[i];
      const dx = x - cp.px;
      const dy = y - cp.py;
      const d = Math.sqrt(dx * dx + dy * dy);
      const kv = d / cp.pr;
      if (kv < bestK) { bestK = kv; bestI = i; }
    }
    return { K: bestK, i: bestI };
  }

  // Cache K per row to halve the work for the horizontal-edge comparison.
  let prevRow = new Float32Array(W);
  let curRow = new Float32Array(W);
  let prevIdx = new Int16Array(W);
  let curIdx = new Int16Array(W);
  // Seed prev row with K at y = -1 by computing K at y=0 then we shift.
  for (let x = 0; x < W; x++) {
    const r = bestKAt(x, 0);
    prevRow[x] = r.K;
    prevIdx[x] = r.i;
  }

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const r = bestKAt(x, y);
      curRow[x] = r.K;
      curIdx[x] = r.i;
    }
    for (let x = 0; x < W; x++) {
      const K = curRow[x];
      // Skip interior of territory (handled by wash) and far ocean.
      if (K < 1.05 || K > FALLOFF_K) continue;

      const ai = curIdx[x];
      const cp = ai >= 0 ? cps[ai] : null;
      // Sin-jitter: angle from territory centroid in wash space →
      // a small per-angle wobble (~0.04 K) so iso rings look hand-cut.
      let jitter = 0;
      if (cp) {
        const dxw = x - cp.px;
        const dyw = y - cp.py;
        const ang = Math.atan2(dyw, dxw);
        jitter = Math.sin(ang * 5 + hash2_01(seed, ai * 17 + 1) * TAU) * 0.018
               + Math.sin(ang * 11 + hash2_01(seed, ai * 17 + 2) * TAU) * 0.008;
      }
      const KK = K + jitter;

      const Kn1 = curRow[x > 0 ? x - 1 : x];
      const Kn2 = prevRow[x];
      // Apply the same jitter to neighbours? Cheap cheat — we just compare
      // against the un-jittered neighbour; the sin-noise on the centre
      // is enough to give the iso band a wavy edge.
      const band = Math.floor(KK / RING_K_PERIOD);
      const band1 = Math.floor(Kn1 / RING_K_PERIOD);
      const band2 = Math.floor(Kn2 / RING_K_PERIOD);
      if (band !== band1 || band !== band2) {
        // Falloff from coast outward: dense near K=1, fading to 0 around K=FALLOFF_K.
        const t = (K - 1.05) / (FALLOFF_K - 1.05);
        const fall = 1 - clamp(t, 0, 1);
        // Quadratic for a natural falloff curve; max alpha ≈ 0.11 of ink-4.
        const a = Math.round(fall * fall * 28);
        if (a > 1) {
          const off = (y * W + x) * 4;
          data[off]     = INK4[0];
          data[off + 1] = INK4[1];
          data[off + 2] = INK4[2];
          data[off + 3] = a;
        }
      }
    }
    // rotate row buffers
    const tmp = prevRow; prevRow = curRow; curRow = tmp;
    const tmpI = prevIdx; prevIdx = curIdx; curIdx = tmpI;
  }

  ctx.putImageData(img, 0, 0);
}

// ─── foxing dots (world space) ───────────────────────────────────────────
// Foxing is an artifact of the *map*, not the page — the user's call. So
// the dots pan and zoom with the territory: when you zoom in, foxing scales
// with everything else; when you pan, foxing pans too. Distribution is
// hash-based so spots are stable through a session, and we scatter across
// the entire visible-frame world rectangle (not just inside territories)
// so foxing happens on land or sea like real aged-paper artifacts.
function drawFoxing(ctx, breath) {
  const seed = ((state.sessionSeed >>> 0) || 0xA5A5A5A5) ^ 0x0F0F0F0F;
  const cw = state.canvas.width, ch = state.canvas.height;
  const dpr = state.canvas.width / Math.max(1, state.container.getBoundingClientRect().width || 1);

  // We seed foxing positions in world coordinates. The world bounds we use
  // span ~2.4× the worldRadius so that even when the camera pans away from
  // the centre, there's foxing populated across the visible frame. The
  // distribution is dense enough that pan never reveals a "blank" patch.
  const WORLD_HALF = state.worldRadius * 1.4;
  const FOXING_COUNT = 28;

  ctx.save();
  applyWorldTransform(ctx, breath);

  // World-to-canvas projection factor (matches worldToScreen): we're
  // already inside applyWorldTransform, so a unit in world coords renders
  // as `k` canvas-pixels at zoom 1, and `k * scale` at zoom S — the
  // ctx.scale baked into applyWorldTransform handles that for us.
  const f = state.frame;
  const k = (f.span * 0.45) / state.worldRadius;
  // Compute a baseline radius in *world* coords from a CSS-px target so
  // the on-screen size at zoom=1 matches what feels right for the page,
  // and zooming in scales them (as the user wants — verified by zoom test).
  // Target ~6-12 CSS px at zoom=1, so world-radius = (cssPx * dpr) / k.
  for (let i = 0; i < FOXING_COUNT; i++) {
    const u = hash2_01(seed, 100 + i * 7);
    const v = hash2_01(seed, 101 + i * 7);
    const s = hash2_01(seed, 102 + i * 7);
    // wx, wy in world coordinates spanning [-WORLD_HALF, +WORLD_HALF].
    const wx = (u - 0.5) * 2 * WORLD_HALF;
    const wy = (v - 0.5) * 2 * WORLD_HALF;
    const cssRadius = 4 + s * 8; // 4–12 CSS px at zoom 1
    const worldR = (cssRadius * dpr) / k;
    // Slightly-irregular warm-brown blob with a soft radial falloff —
    // same recipe as the old paper foxing, but rendered in world space
    // so the camera transform handles pan/zoom.
    const fox = ctx.createRadialGradient(wx, wy, 0, wx, wy, worldR);
    fox.addColorStop(0, "rgba(96, 60, 22, 0.18)");
    fox.addColorStop(0.55, "rgba(96, 60, 22, 0.08)");
    fox.addColorStop(1, "rgba(96, 60, 22, 0.0)");
    ctx.fillStyle = fox;
    ctx.beginPath();
    ctx.arc(wx, wy, worldR, 0, TAU);
    ctx.fill();
  }

  // A few tiny ink-pinpricks (faint dark dots) — the kind of stray
  // pen-flicks you find on old maps. Same hash-seeded set so they're
  // stable through the session. Lower count, smaller, denser ink.
  const PINPRICK_COUNT = 36;
  for (let i = 0; i < PINPRICK_COUNT; i++) {
    const u = hash2_01(seed, 7000 + i * 5);
    const v = hash2_01(seed, 7001 + i * 5);
    const s = hash2_01(seed, 7002 + i * 5);
    const wx = (u - 0.5) * 2 * WORLD_HALF;
    const wy = (v - 0.5) * 2 * WORLD_HALF;
    const cssRadius = 0.5 + s * 1.2;
    const worldR = (cssRadius * dpr) / k;
    ctx.fillStyle = `rgba(46, 32, 16, ${0.18 + s * 0.18})`;
    ctx.beginPath();
    ctx.arc(wx, wy, worldR, 0, TAU);
    ctx.fill();
  }

  ctx.restore();
}

// ─── cartouche & legend ──────────────────────────────────────────────────

function updateCartouche() {
  if (!state.cartouche) return;
  const elDay = document.getElementById("atl-day");
  const elTime = document.getElementById("atl-time");
  const elSession = document.getElementById("atl-session");
  const elCoord = document.getElementById("atl-coord");
  if (!elDay || !elTime || !elSession || !elCoord) return;

  // session: the nearest persistent identifier we have. We use the
  // session-start (boot time of this page) as session N rooted at the
  // user's local "first ever atlas open" — recorded in localStorage.
  const ssn = atlSessionNumber();
  elSession.textContent = String(ssn).padStart(2, "0");

  // day: days since first ever atlas open.
  const day = atlDayNumber();
  elDay.textContent = String(day).padStart(2, "0");

  // time: HH:MM, lowercase, no seconds — ambient piece, not a clock.
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  elTime.textContent = `${hh}:${mm}`;

  // coord: total pages · total countries.
  const total = state.countries.reduce((acc, c) => acc + c.pageCount, 0);
  elCoord.textContent = `${total} pages · ${state.countries.length} territories`;

  // PR C: snapshot diff readout. Only show when we actually have a
  // comparison point (lastSeenAt > 0) AND there's something new.
  const diffEl = document.getElementById("atl-diff");
  const diffVal = document.getElementById("atl-diff-val");
  if (diffEl && diffVal) {
    const show = state.lastSeenAt > 0 && state.newSinceLastVisit > 0;
    diffEl.hidden = !show;
    diffVal.textContent = show ? `+${state.newSinceLastVisit}` : "+0";
  }
}

function atlSessionNumber() {
  const KEY = "srwk:atlas:sessions";
  let n = 0;
  try {
    const raw = localStorage.getItem(KEY);
    n = raw ? parseInt(raw, 10) || 0 : 0;
  } catch {}
  // bump once per process boot
  if (!state._sessionApplied) {
    state._sessionApplied = true;
    n = n + 1;
    try { localStorage.setItem(KEY, String(n)); } catch {}
  }
  return n || 1;
}

function atlDayNumber() {
  // Note: do NOT use `| 0` here — Date.now() exceeds the 32-bit integer
  // range, and `(big | 0)` would silently truncate to a garbage value.
  // We're computing days-since-first-open, so a regular Number is fine.
  const KEY = "srwk:atlas:firstOpen";
  let first = 0;
  try {
    const raw = localStorage.getItem(KEY);
    first = raw ? Number(raw) : 0;
    if (!Number.isFinite(first) || first <= 0) first = 0;
  } catch {}
  if (!first) {
    first = Date.now();
    try { localStorage.setItem(KEY, String(first)); } catch {}
  }
  return Math.max(1, Math.floor((Date.now() - first) / 86400000) + 1);
}

function renderLegend() {
  const list = document.getElementById("atl-leg-list");
  const total = document.getElementById("atl-leg-total");
  if (!list || !total) return;
  // PR C: show the · clear new affordance only when there's something new.
  const acts = document.getElementById("atl-leg-actions");
  if (acts) acts.hidden = !(state.newSinceLastVisit > 0);
  // Sprint 2026-05-02: legend now lists PEERS (not topic clusters), since
  // the layout dropped peer identity. The list is sourced from the
  // peerRoster built in buildFromData.
  const roster = state.peerRoster || [];
  let html = "";
  for (const c of roster) {
    html += `
      <div class="atl-leg-row" data-pk="${escAttr(c.pk)}">
        <span class="atl-leg-swatch" style="background:${escAttr(c.color)}"></span>
        <span class="atl-leg-name">${escHtml(c.nickname)}</span>
        <span class="atl-leg-count">${c.pageCount}</span>
      </div>`;
  }
  list.innerHTML = html;
  const totalPages = roster.reduce((a, c) => a + c.pageCount, 0);
  total.textContent = `${totalPages} pages`;
}

// ─── pointer (PR B) ──────────────────────────────────────────────────────
// Pan: pointerdown → drag tracks delta in CSS px; pointerup with movement
// < 3 px is treated as a click. Hover (without buttons) → floating panel.
// Wheel zooms toward the cursor, not the centre.

function getCanvasPx(ev) {
  // CSS-px coordinates inside the canvas. devicePixelRatio is only baked
  // into canvas.width; clientX/Y are CSS pixels, so we just subtract the
  // bounding-rect offset.
  const rect = state.canvas.getBoundingClientRect();
  return [ev.clientX - rect.left, ev.clientY - rect.top];
}

// Convert CSS px (the input space) to device-px (the canvas space).
function cssToDevice(cssX, cssY) {
  const rect = state.canvas.getBoundingClientRect();
  const dpr = state.canvas.width / Math.max(1, rect.width);
  return [cssX * dpr, cssY * dpr];
}

function onPointerDown(ev) {
  if (!state.mounted) return;
  // We don't capture on right-click / middle-click — only primary.
  if (ev.button !== undefined && ev.button !== 0) return;
  const [cssX, cssY] = getCanvasPx(ev);
  state.drag.active = true;
  state.drag.pointerDown = true;
  state.drag.startX = cssX; state.drag.startY = cssY;
  state.drag.lastX = cssX; state.drag.lastY = cssY;
  state.drag.pixelsMoved = 0;
  state.drag.capturedId = ev.pointerId;
  try { state.canvas.setPointerCapture(ev.pointerId); } catch {}
  markInteraction();
}

function onPointerMove(ev) {
  if (!state.mounted) return;
  const [cssX, cssY] = getCanvasPx(ev);

  if (state.drag.pointerDown) {
    // Active drag — translate the viewport. dx/dy are CSS px; we feed
    // them through the same conversion the wheel uses (device px /
    // viewport.scale) so a drag of N CSS px moves the world N CSS px,
    // regardless of zoom.
    const dxCss = cssX - state.drag.lastX;
    const dyCss = cssY - state.drag.lastY;
    state.drag.lastX = cssX; state.drag.lastY = cssY;
    state.drag.pixelsMoved += Math.hypot(dxCss, dyCss);
    // Convert CSS-px delta into the canvas-space delta the world transform
    // expects (canvas width is dpr-scaled; tx/ty are pre-scale, so a
    // /viewport.scale also enters).
    const rect = state.canvas.getBoundingClientRect();
    const dpr = state.canvas.width / Math.max(1, rect.width);
    const tx = state.viewportTarget.tx + (dxCss * dpr) / state.viewportTarget.scale;
    const ty = state.viewportTarget.ty + (dyCss * dpr) / state.viewportTarget.scale;
    state.viewportTarget.tx = tx;
    state.viewportTarget.ty = ty;
    // For pan, jump the rendered viewport to keep the drag tactile —
    // damping during a drag feels rubbery.
    state.viewport.tx = tx;
    state.viewport.ty = ty;
    markInteraction();
    persistViewport();
    // While dragging we suppress hover; otherwise the tooltip flickers
    // following the pointer.
    if (state.hoverLabel) state.hoverLabel.hidden = true;
    state.hoverNodeId = null;
    state.canvas.style.cursor = "grabbing";
    return;
  }

  // Hover — find the town under the pointer. Convert CSS → device →
  // world; check radius against device-px on screen for stable feel.
  const [devX, devY] = cssToDevice(cssX, cssY);
  const [wx, wy] = screenToWorld(devX, devY);
  const hit = pickTownAt(wx, wy, devX, devY);
  if (hit) {
    state.hoverNodeId = hit.t.id;
    state.canvas.style.cursor = "pointer";
    showHoverPanel(ev.clientX, ev.clientY, hit.t, hit.c);
  } else {
    state.hoverNodeId = null;
    state.canvas.style.cursor = state.drag.pointerDown ? "grabbing" : "grab";
    if (state.hoverLabel) state.hoverLabel.hidden = true;
  }
}

function onPointerUp(ev) {
  if (!state.mounted) return;
  if (!state.drag.pointerDown) return;
  const wasDrag = state.drag.pixelsMoved >= DRAG_PIXEL_THRESHOLD;
  state.drag.pointerDown = false;
  state.drag.active = false;
  try { state.canvas.releasePointerCapture(state.drag.capturedId); } catch {}
  state.canvas.style.cursor = "";
  if (!wasDrag) {
    // Click: open the page in the system browser.
    const [cssX, cssY] = getCanvasPx(ev);
    const [devX, devY] = cssToDevice(cssX, cssY);
    const [wx, wy] = screenToWorld(devX, devY);
    const hit = pickTownAt(wx, wy, devX, devY);
    if (hit && hit.t && hit.t.id) {
      const url = hit.t.id;
      // window.api is the preload-bridge in this Electron app; it routes
      // to shell.openExternal in main.js (only opens http(s) URLs). Fall
      // back to window.open for non-Electron contexts (tests).
      if (/^https?:\/\//i.test(url)) {
        if (window.api?.openExternal) window.api.openExternal(url);
        else window.open(url, "_blank");
      }
    }
  }
  markInteraction();
}

function onPointerCancel() {
  state.drag.pointerDown = false;
  state.drag.active = false;
  state.canvas.style.cursor = "";
}

function onPointerLeave() {
  if (state.hoverLabel) state.hoverLabel.hidden = true;
  state.hoverNodeId = null;
  state.canvas.style.cursor = "";
}

function onWheel(ev) {
  if (!state.mounted) return;
  ev.preventDefault();
  const [cssX, cssY] = getCanvasPx(ev);
  const [devX, devY] = cssToDevice(cssX, cssY);
  // Pre-zoom world coords under cursor.
  const [wxBefore, wyBefore] = screenToWorld(devX, devY);

  // Wheel deltaY varies wildly across drivers. Tuned so a single
  // mouse-wheel notch (~deltaY=100) feels like ~14% per click and a
  // trackpad two-finger gesture feels equally smooth. The previous
  // 0.0018 plus a long damping tau felt glacial when the persisted
  // scale was already deep.
  const delta = ev.deltaY * (ev.deltaMode === 1 ? 18 : 1);
  const factor = Math.exp(-delta * 0.0015);
  let newScale = state.viewportTarget.scale * factor;
  newScale = clamp(newScale, VIEW_MIN_SCALE, VIEW_MAX_SCALE);
  if (newScale === state.viewportTarget.scale) return;

  // To zoom toward the cursor, we want the world point under the cursor
  // to remain under the cursor. Solve the new tx/ty so that
  // worldToScreen(wxBefore, wyBefore) at the new scale lands on (devX, devY).
  // Working with the visible-frame projection:
  //   devX = f.cx + (wx*k + tx_new) * newScale
  //   devY = f.cy + (wy*k + ty_new) * newScale
  // Solve for tx_new / ty_new.
  const f = state.frame;
  const k = (f.span * 0.45) / state.worldRadius;
  const newTx = (devX - f.cx) / newScale - wxBefore * k;
  const newTy = (devY - f.cy) / newScale - wyBefore * k;

  state.viewportTarget.scale = newScale;
  state.viewportTarget.tx = newTx;
  state.viewportTarget.ty = newTy;
  markInteraction();
  persistViewport();
  // Hide hover during a zoom — the panel position is stale.
  if (state.hoverLabel) state.hoverLabel.hidden = true;
  state.hoverNodeId = null;
}

// PR B: town hit-test. Returns {t, c} or null. Pick the nearest town
// within ~14 device-px (scaled with zoom: 14 / sqrt(zoom) so stays
// pickable when zoomed out and doesn't get sticky when zoomed in).
function pickTownAt(wx, wy, devX, devY) {
  const populated = state.populatedCountries || state.countries;
  let bestT = null, bestC = null, bestD = Infinity;
  const z = state.viewport.scale;
  // pixel pick radius — translates back to a world distance.
  const cw = state.canvas.width, ch = state.canvas.height;
  const span = Math.min(cw, ch);
  const k = (span * 0.45) / state.worldRadius;
  const PICK_PX = 14;
  const pickWorld = PICK_PX / (k * z);
  for (const c of populated) {
    for (const t of c.towns) {
      const d = Math.hypot(t.x - wx, t.y - wy);
      if (d < bestD && d < pickWorld) {
        bestD = d; bestT = t; bestC = c;
      }
    }
  }
  return bestT ? { t: bestT, c: bestC } : null;
}

// PR B: floating hover panel. Positioned near the pointer but kept inside
// the container — flips to the left of the cursor near the right edge.
function showHoverPanel(clientX, clientY, town, country) {
  const el = state.hoverLabel;
  if (!el) return;
  const rect = state.container.getBoundingClientRect();
  const px = clientX - rect.left;
  const py = clientY - rect.top;
  const title = (town.title || town.host || town.id || "untitled");
  const truncated = title.length > 60 ? title.slice(0, 59) + "…" : title;
  const host = town.host || "";
  const peer = country?.nickname || "";
  const degree = town.degree | 0;
  const degreeRow = degree > 0
    ? `<span class="atl-hov-row"><span class="atl-hov-key">degree</span><span class="atl-hov-val">${degree}</span></span>`
    : "";
  el.innerHTML = `
    <div class="atl-hov-title">${escHtml(truncated)}</div>
    <div class="atl-hov-rows">
      ${host ? `<span class="atl-hov-row"><span class="atl-hov-key">host</span><span class="atl-hov-val">${escHtml(host)}</span></span>` : ""}
      ${peer ? `<span class="atl-hov-row"><span class="atl-hov-key">peer</span><span class="atl-hov-val">${escHtml(peer)}</span></span>` : ""}
      ${degreeRow}
    </div>
  `;
  // Position offsets: 14 px right + 14 px down of the pointer; flip to
  // the left of the cursor near the right edge.
  const PAD = 14;
  el.hidden = false;
  // Measure after content is set so flipping uses the real width.
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const cw = rect.width;
  const ch = rect.height;
  let lx = px + PAD;
  let ly = py + PAD;
  if (lx + w + 6 > cw) lx = px - w - PAD;
  if (ly + h + 6 > ch) ly = ch - h - 6;
  if (ly < 6) ly = 6;
  el.style.left = lx + "px";
  el.style.top = ly + "px";
}

// ─── viewport tween (PR B) ───────────────────────────────────────────────
// Damp viewport toward viewportTarget over ~120ms (ease-out). Skip damping
// while the user is actively dragging — that path jumps the rendered
// viewport directly so the drag stays tactile. Honors prefers-reduced-
// motion (instant).

function advanceViewport(now, dtIn) {
  // Idle return tween — runs only when no interaction for VIEW_IDLE_RESET_MS.
  if (state.idleReturnAnim) {
    const a = state.idleReturnAnim;
    const u = clamp((now - a.startMs) / a.durationMs, 0, 1);
    const t = u * u * (3 - 2 * u); // smoothstep
    state.viewport.tx = lerp(a.fromTx, 0, t);
    state.viewport.ty = lerp(a.fromTy, 0, t);
    state.viewport.scale = lerp(a.fromScale, 1, t);
    if (u >= 1) {
      state.idleReturnAnim = null;
      state.viewportTarget.tx = 0;
      state.viewportTarget.ty = 0;
      state.viewportTarget.scale = 1;
      persistViewport();
    }
    return;
  }
  // Trigger idle return if quiet for too long.
  if (now - state.lastInteractionTs > VIEW_IDLE_RESET_MS) {
    const dx = state.viewport.tx, dy = state.viewport.ty, ds = state.viewport.scale;
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5 || Math.abs(ds - 1) > 0.005) {
      state.idleReturnAnim = state.reducedMotion
        ? { startMs: now, fromTx: dx, fromTy: dy, fromScale: ds, durationMs: 1 }
        : { startMs: now, fromTx: dx, fromTy: dy, fromScale: ds, durationMs: VIEW_IDLE_TWEEN_MS };
    } else {
      state.lastInteractionTs = now; // pretend we were never idle to skip rechecks
    }
    return;
  }
  // Per-frame ease toward target. Skip if drag is active (jump path).
  if (state.drag.pointerDown) return;
  if (state.reducedMotion) {
    state.viewport.tx = state.viewportTarget.tx;
    state.viewport.ty = state.viewportTarget.ty;
    state.viewport.scale = state.viewportTarget.scale;
    return;
  }
  // Frame-rate-independent exponential damping: alpha = 1 - exp(-dt/tau).
  // Note: loop() updates state.lastFrameTs to `now` BEFORE calling
  // drawFrame → advanceViewport, so reading lastFrameTs here would
  // always give dt=0 and alpha=0 — the viewport would never ease.
  // That was the regression behind "zoom doesn't fire": the wheel
  // handler updated viewportTarget correctly, but the per-frame ease
  // toward target was permanently frozen. We use the dt already
  // measured in loop() instead.
  const tau = VIEW_DAMP_MS;
  const dt = (typeof dtIn === "number" && dtIn > 0) ? Math.min(64, dtIn) : 16;
  const alpha = 1 - Math.exp(-dt / tau);
  state.viewport.tx += (state.viewportTarget.tx - state.viewport.tx) * alpha;
  state.viewport.ty += (state.viewportTarget.ty - state.viewport.ty) * alpha;
  state.viewport.scale += (state.viewportTarget.scale - state.viewport.scale) * alpha;
}

function lerp(a, b, t) { return a + (b - a) * t; }

function markInteraction() {
  state.lastInteractionTs = performance.now();
  if (state.idleReturnAnim) state.idleReturnAnim = null;
}

function resetViewportNow() {
  // Tween smoothly back to home unless reduced motion → instant.
  const now = performance.now();
  state.idleReturnAnim = state.reducedMotion
    ? { startMs: now, fromTx: state.viewport.tx, fromTy: state.viewport.ty, fromScale: state.viewport.scale, durationMs: 1 }
    : { startMs: now, fromTx: state.viewport.tx, fromTy: state.viewport.ty, fromScale: state.viewport.scale, durationMs: 700 };
  state.viewportTarget.tx = 0;
  state.viewportTarget.ty = 0;
  state.viewportTarget.scale = 1;
}

function persistViewport() {
  try {
    localStorage.setItem(VIEWPORT_LS_KEY, JSON.stringify({
      tx: state.viewportTarget.tx,
      ty: state.viewportTarget.ty,
      scale: state.viewportTarget.scale,
    }));
  } catch {}
}

// ─── time-lapse (PR C) ───────────────────────────────────────────────────
// `T` toggles a cinematic replay of the last N days. Towns appear in
// chronological order of fetched_at; the wash + edges follow because
// the existing per-frame draw consults `t.fetchedAt > timelapse.nowMs`
// as a visibility gate. A scrubber appears at the bottom of the canvas
// with day/time tick marks; drag to scrub.

function toggleTimelapse() {
  if (state.timelapse.active) stopTimelapse();
  else startTimelapse();
}

function startTimelapse() {
  if (!state.mounted) return;
  const tl = state.timelapse;
  tl.active = true;
  // Compute range bounds: end = real now, start = end - rangeMs.
  // For "all", clamp start to the earliest fetched_at in the corpus.
  const realNow = Date.now();
  const rangeMs = TIMELAPSE_RANGES[tl.rangeKey] ?? TIMELAPSE_RANGES["7d"];
  let start = realNow - rangeMs;
  if (!Number.isFinite(rangeMs)) {
    let minF = realNow;
    for (const c of state.populatedCountries || []) {
      for (const t of c.towns) if (t.fetchedAt < minF) minF = t.fetchedAt;
    }
    start = minF;
  }
  tl.startSimMs = start;
  tl.endSimMs = realNow;
  tl.nowMs = start;            // begin empty, towns fade in chronologically
  tl.lastTickPerf = performance.now();
  // Pause the wandering surveyor during replay (per spec).
  state._surveyorWasOn = !state.reducedMotion;
  // Mount scrubber UI.
  mountTimelapseUI();
}

function stopTimelapse() {
  const tl = state.timelapse;
  tl.active = false;
  tl.scrubbing = false;
  unmountTimelapseUI();
}

function advanceTimelapse(now) {
  const tl = state.timelapse;
  if (!tl.active || tl.scrubbing) { tl.lastTickPerf = now; return; }
  const dtPerf = Math.min(64, now - tl.lastTickPerf);
  tl.lastTickPerf = now;
  // ms-per-day determines the simulated rate.
  const msPerDay = TIMELAPSE_SPEED_MS_PER_DAY[tl.speedKey] ?? 5000;
  // dtPerf real ms → dtSim sim ms. dtSim = dtPerf * (86400000 / msPerDay).
  const dtSim = dtPerf * (86400000 / msPerDay);
  tl.nowMs += dtSim;
  if (tl.nowMs >= tl.endSimMs) {
    tl.nowMs = tl.endSimMs;
    // Linger at the end for a beat then exit, so the final state reads.
    if (!tl._endAt) tl._endAt = now;
    if (now - tl._endAt > 1500) {
      tl._endAt = 0;
      stopTimelapse();
    }
  } else {
    tl._endAt = 0;
  }
  updateTimelapseScrubber();
}

function mountTimelapseUI() {
  if (state.timelapse.scrubber) return;
  const host = document.createElement("div");
  host.className = "atlas-timelapse";
  host.innerHTML = `
    <div class="atl-tl-row">
      <div class="atl-tl-mode">
        <span class="atl-tl-mode-label">timelapse</span>
        <span class="atl-tl-mode-sep">·</span>
        <div class="atl-tl-range" role="tablist">
          <button class="atl-tl-range-btn" data-range="1d" type="button">1d</button>
          <button class="atl-tl-range-btn" data-range="7d" type="button">7d</button>
          <button class="atl-tl-range-btn" data-range="30d" type="button">30d</button>
          <button class="atl-tl-range-btn" data-range="all" type="button">all</button>
        </div>
        <span class="atl-tl-mode-sep">·</span>
        <div class="atl-tl-speed" role="tablist">
          <button class="atl-tl-speed-btn" data-speed="slow" type="button">slow</button>
          <button class="atl-tl-speed-btn" data-speed="med" type="button">med</button>
          <button class="atl-tl-speed-btn" data-speed="fast" type="button">fast</button>
        </div>
        <span class="atl-tl-mode-sep">·</span>
        <button class="atl-tl-close" type="button" title="exit time-lapse (T or Esc)">
          <span aria-hidden="true">·</span><span>exit</span>
        </button>
      </div>
      <div class="atl-tl-bar">
        <div class="atl-tl-track" id="atl-tl-track">
          <div class="atl-tl-fill" id="atl-tl-fill"></div>
          <div class="atl-tl-knob" id="atl-tl-knob"></div>
        </div>
        <div class="atl-tl-clock" id="atl-tl-clock">—</div>
      </div>
    </div>
  `;
  state.container.appendChild(host);
  state.timelapse.scrubber = host;
  state.timelapse.scrubberKnob = host.querySelector("#atl-tl-knob");
  // Wire mode buttons
  host.querySelector(".atl-tl-range").addEventListener("click", (e) => {
    const b = e.target.closest("[data-range]");
    if (!b) return;
    state.timelapse.rangeKey = b.dataset.range;
    // Restart from the new range start.
    startTimelapse();
  });
  host.querySelector(".atl-tl-speed").addEventListener("click", (e) => {
    const b = e.target.closest("[data-speed]");
    if (!b) return;
    state.timelapse.speedKey = b.dataset.speed;
    syncTimelapseModeButtons();
  });
  host.querySelector(".atl-tl-close").addEventListener("click", () => stopTimelapse());
  // Drag to scrub
  const track = host.querySelector("#atl-tl-track");
  function pickFromX(clientX) {
    const r = track.getBoundingClientRect();
    const u = clamp((clientX - r.left) / r.width, 0, 1);
    const tl = state.timelapse;
    tl.nowMs = tl.startSimMs + (tl.endSimMs - tl.startSimMs) * u;
    updateTimelapseScrubber();
  }
  track.addEventListener("pointerdown", (e) => {
    state.timelapse.scrubbing = true;
    pickFromX(e.clientX);
    track.setPointerCapture(e.pointerId);
  });
  track.addEventListener("pointermove", (e) => {
    if (!state.timelapse.scrubbing) return;
    pickFromX(e.clientX);
  });
  track.addEventListener("pointerup", () => {
    state.timelapse.scrubbing = false;
    state.timelapse.lastTickPerf = performance.now();
  });
  syncTimelapseModeButtons();
  updateTimelapseScrubber();
}

function unmountTimelapseUI() {
  const tl = state.timelapse;
  if (tl.scrubber?.parentElement) tl.scrubber.parentElement.removeChild(tl.scrubber);
  tl.scrubber = null;
  tl.scrubberKnob = null;
}

function syncTimelapseModeButtons() {
  const root = state.timelapse.scrubber;
  if (!root) return;
  for (const b of root.querySelectorAll("[data-range]")) {
    b.setAttribute("aria-selected", b.dataset.range === state.timelapse.rangeKey ? "true" : "false");
  }
  for (const b of root.querySelectorAll("[data-speed]")) {
    b.setAttribute("aria-selected", b.dataset.speed === state.timelapse.speedKey ? "true" : "false");
  }
}

function updateTimelapseScrubber() {
  const tl = state.timelapse;
  if (!tl.scrubber) return;
  const fill = tl.scrubber.querySelector("#atl-tl-fill");
  const knob = tl.scrubber.querySelector("#atl-tl-knob");
  const clock = tl.scrubber.querySelector("#atl-tl-clock");
  const span = Math.max(1, tl.endSimMs - tl.startSimMs);
  const u = clamp((tl.nowMs - tl.startSimMs) / span, 0, 1);
  if (fill) fill.style.width = (u * 100) + "%";
  if (knob) knob.style.left = (u * 100) + "%";
  if (clock) {
    const d = new Date(tl.nowMs);
    const day = String(d.getDate()).padStart(2, "0");
    const mon = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"][d.getMonth()];
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    clock.textContent = `${day} ${mon} · ${hh}:${mm}`;
  }
}

// PR C: snapshot diff — record "the moment the user looked away" so the
// next mount can halo what arrived in between. Called on tab-switch-away,
// on beforeunload, and from the legend's `· clear new` button.
function persistLastSeenNow() {
  const now = Date.now();
  state.lastSeenAt = now;
  try { localStorage.setItem(LAST_SEEN_LS_KEY, String(now)); } catch {}
  // Re-render the legend's "+N new" tag — clears it if we just zeroed.
  state.newSinceLastVisit = 0;
  // Recount on the *next* layout build; the count walks the existing
  // town list so we don't need to rebuild geometry. Stamp the existing
  // towns' "new" flag off.
  if (state.populatedCountries) {
    for (const c of state.populatedCountries) {
      for (const t of c.towns) t.isNew = false;
    }
  }
  updateCartouche();
  renderLegend();
}

// ─── helpers ─────────────────────────────────────────────────────────────

function hash32(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// PR D: tokenize a string into lowercase alphanumeric tokens of length ≥ 3
// that aren't stop-words. Used by both TF-IDF and the path-prefix fallback
// to extract a "distinctive token" label for each cluster. The same
// extended publishing/web blocklist used by the L1/L2 c-TF-IDF pass
// applies here too — that way an L3 cluster doesn't end up labeled
// "STUDY" or "RESEARCH" while L2 cleanly skips those words.
function tokenize(s) {
  if (!s) return [];
  const out = [];
  const lower = String(s).toLowerCase();
  // Match runs of letters/digits. We strip the rest, including hyphens
  // and underscores; pages with `entity-resolution` tokenize to two
  // tokens, which is desirable for topic discrimination.
  const re = /[a-z0-9]{3,}/g;
  let m;
  while ((m = re.exec(lower)) !== null) {
    const t = m[0];
    if (STOPWORDS.has(t)) continue;
    if (CONCEPT_EXTRA_STOPWORDS.has(t)) continue;
    if (/^\d+$/.test(t)) continue; // pure numbers — rarely a topic
    out.push(t);
  }
  return out;
}

// PR D: extract first 1-2 path segments from a URL. Used as the path-prefix
// fallback when TF-IDF can't separate a host's pages. Returns "" if no
// useful prefix can be derived.
function pathPrefix(url, segments = 2) {
  if (!url) return "";
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length === 0) return "";
    return parts.slice(0, segments).join("/");
  } catch {
    // Not a parseable URL — fall back to a hand-rolled split.
    const m = /^https?:\/\/[^/]+(\/.*)?$/i.exec(String(url));
    if (!m || !m[1]) return "";
    const parts = m[1].split("/").filter(Boolean);
    return parts.slice(0, segments).join("/");
  }
}

// ─── c-TF-IDF concept naming for L1 (peer) and L2 (host) territories ─────
//
// The L2 sub-territory labels used to be the bare host string ("arxiv.org",
// "self") which the user (rightly) called flimsy: they don't tell you what
// the territory is *about*. We compute a concept name per territory by
// running classic c-TF-IDF over the page titles inside vs. outside the
// territory, with bigram support so 2-word names ("predictive coding",
// "commander decks") get a fair shake.
//
// The CONCEPT_STOPWORDS set extends STOPWORDS with extra noise words that
// appear in titles often but don't characterize a territory (e.g., "page",
// "site", "official"). We also strip the host's own name + TLD parts so
// "arxiv.org" doesn't get labeled "arxiv".
const CONCEPT_EXTRA_STOPWORDS = new Set([
  "site","official","github","gitlab","wiki","wikipedia","reddit","twitter",
  "youtube","vimeo","facebook","linkedin","medium","substack","dev",
  "open","free","best","top","new","old","first","last","next","previous",
  "part","parts","chapter","chapters","section","sections",
  "list","lists","summary","summaries","note","notes",
  "video","videos","podcast","podcasts","episode","episodes","season",
  // Extra publishing / framing noise observed in the local corpus —
  // generic enough to crowd out distinctive concepts. "Communications"
  // appears in titles like "Nature Communications" (the journal); kept
  // here so the territory's actual subject wins instead.
  "communications","approach","approaches","social","analysis","analyses",
  "framework","frameworks","method","methods","model","theory","theories",
  "effect","effects","factor","factors","function","functional",
  "based","using","via","towards","toward","case","cases",
  "evidence","results","result","conclusion","conclusions","implications",
  "impact","impacts","role","roles","application","applications",
  // Common journal/section names
  "nature","science","plos","cell","brain","neuron","reports","letters",
  "letter","perspective","perspectives","editorial","commentary",
  // Generic scientific filler — recurs across territories without
  // characterizing any of them. "Mechanisms" is a tell here: if the only
  // distinctive token in a territory is "mechanisms", the territory's
  // content is too diverse to label.
  "mechanism","mechanisms","process","processes","system","systems",
  "phenomenon","phenomena","experiment","experiments","behavior","behaviors",
  "behavioural","behavioral","activity","activities","feature","features",
  "phenomenon","phenomena","general","specific","novel","recent",
  // Sprint: empirical filler observed when topic clusters got named in
  // the local 930-page corpus. "moment", "consolidation", "imagery" etc.
  // either show up across multiple unrelated topics or are too abstract
  // to characterize a cluster on their own.
  "moment","effects","effect","consolidation","imagery","recovery",
  "general","social","learning","function","working","dynamic",
  // Venue / publisher / aggregator names — the URL host has already been
  // stripped by tokenizeTitle, but these surface from titles too
  // ("PubMed Central", "PMC11234", "Frontiers in …", "arxiv:2401.…").
  "nature","science","cell","letters","perspectives","frontiers",
  "arxiv","pubmed","pmc","ncbi","nih","gov","springer","elsevier","wiley",
  "oxford","wikipedia","scholar","semanticscholar","researchgate",
  "mtggoldfish","mtg",
]);

// Tokenize a title into unigrams + bigrams suitable for c-TF-IDF naming.
// Strips standard stops, the concept extras, the host's own name, and TLD
// parts. Returns { unigrams: string[], bigrams: string[] } (each token can
// appear multiple times — these are bags, not sets).
function tokenizeTitle(title, hostName) {
  const empty = { unigrams: [], bigrams: [] };
  if (!title) return empty;
  const lower = String(title).toLowerCase();
  // Build a host-derived blocklist: the labels in `arxiv.org` are
  // ["arxiv","org"]; for `pubmed.ncbi.nlm.nih.gov` we get the whole chain
  // so none of those acronyms claim the title.
  const hostBlock = new Set();
  if (hostName) {
    for (const part of String(hostName).toLowerCase().split(/[^a-z0-9]+/)) {
      if (part) hostBlock.add(part);
    }
  }
  const re = /[a-z0-9]{2,}/g;
  const raw = [];
  let m;
  while ((m = re.exec(lower)) !== null) raw.push(m[0]);
  const ok = (t) => {
    if (!t) return false;
    if (t.length < 3) return false;          // single + double-letter noise
    if (/^\d+$/.test(t)) return false;       // pure numbers
    if (STOPWORDS.has(t)) return false;
    if (CONCEPT_EXTRA_STOPWORDS.has(t)) return false;
    if (hostBlock.has(t)) return false;
    return true;
  };
  const unigrams = [];
  for (const t of raw) {
    if (ok(t)) unigrams.push(t);
  }
  // Bigrams: consecutive tokens in the *raw* stream where BOTH pass the
  // filter. Using raw (not the filtered list) avoids splicing a stop word
  // out of the middle and pretending two unrelated terms were adjacent.
  const bigrams = [];
  for (let i = 0; i < raw.length - 1; i++) {
    const a = raw[i], b = raw[i + 1];
    if (!ok(a) || !ok(b)) continue;
    if (a === b) continue; // "the the" style noise
    bigrams.push(`${a} ${b}`);
  }
  return { unigrams, bigrams };
}

// Sum a bag (Map of token → count) into the doc-frequency map (Map of token
// → number-of-docs-the-token-appears-in). Mutates `df` in place.
function _accumulateDF(df, bag) {
  for (const tok of bag.keys()) df.set(tok, (df.get(tok) || 0) + 1);
}

// Build a per-territory token bag: Map of token → tf (count). Returns
// { uni, bi, total } where total is the total token count across the bag,
// used for tf normalization.
function _territoryBags(towns, hostName) {
  const uni = new Map();
  const bi = new Map();
  let totalU = 0, totalB = 0;
  for (const t of towns) {
    const { unigrams, bigrams } = tokenizeTitle(t.title || t.id || "", hostName);
    for (const u of unigrams) { uni.set(u, (uni.get(u) || 0) + 1); totalU++; }
    for (const g of bigrams) { bi.set(g, (bi.get(g) || 0) + 1); totalB++; }
  }
  return { uni, bi, totalU, totalB };
}

// c-TF-IDF concept name for one territory (the towns in this territory)
// against the corpus of all OTHER territories (each represented as one
// "doc" — i.e. its concatenated titles).
//
// `townsByTerritory` is an Array<Array<town>> where one entry IS this
// territory and the rest are siblings. `selfIdx` is the index that points
// at this territory in `townsByTerritory`.
//
// Returns { concept, score, secondScore, kind: 'unigram'|'bigram' } or
// null if no usable token survived the filter (no winner candidate).
//
// Quality gate is applied by the caller (see BuildFromData wiring) — this
// function returns the raw winner so `score` and `secondScore` are
// available for the gate.
function cTfIdfNameForTerritory(territoryTowns, allTerritoriesTowns, hostName, options) {
  const opts = options || {};
  const bigramBonus = opts.bigramBonus == null ? 1.3 : opts.bigramBonus;
  const N = allTerritoriesTowns.length;
  if (N <= 0 || !territoryTowns || territoryTowns.length === 0) return null;
  // Build territory bag.
  const self = _territoryBags(territoryTowns, hostName);
  if (self.uni.size === 0 && self.bi.size === 0) return null;

  // Compute DF across all territories. Each territory is one "doc."
  // We only count DF for the tokens that actually appear in our self
  // bag — no point IDF-ing tokens we'll never score.
  const dfU = new Map();
  const dfB = new Map();
  for (let i = 0; i < N; i++) {
    const { uni, bi } = _territoryBags(allTerritoriesTowns[i], hostName);
    for (const tok of uni.keys()) {
      if (self.uni.has(tok)) dfU.set(tok, (dfU.get(tok) || 0) + 1);
    }
    for (const tok of bi.keys()) {
      if (self.bi.has(tok)) dfB.set(tok, (dfB.get(tok) || 0) + 1);
    }
  }
  // Score each candidate: tf * log(N / (df + 1)).
  // tf is normalized by the territory's own bag total so larger territories
  // don't always win the unigram race.
  const denomU = Math.max(1, self.totalU);
  const denomB = Math.max(1, self.totalB);

  // Collect a unified candidate list with kind tag.
  const cands = []; // { token, kind, score }
  for (const [tok, tf] of self.uni) {
    if (tf < 2) continue; // single-mention noise
    const df = dfU.get(tok) || 1;
    const idf = Math.log(N / (df + 1) + 1); // +1 inside log keeps sign positive
    const score = (tf / denomU) * idf;
    if (score > 0) cands.push({ token: tok, kind: "unigram", score });
  }
  for (const [tok, tf] of self.bi) {
    if (tf < 2) continue; // need at least 2 occurrences to count as a phrase
    const df = dfB.get(tok) || 1;
    const idf = Math.log(N / (df + 1) + 1);
    const score = (tf / denomB) * idf * bigramBonus;
    if (score > 0) cands.push({ token: tok, kind: "bigram", score });
  }
  if (cands.length === 0) return null;
  cands.sort((a, b) => b.score - a.score);
  const best = cands[0];
  // Walk the candidate list and collect the next non-overlapping
  // candidates in score order. The first one is "second" (used for
  // the existing confidence gate); the next DOMINANCE_PEERS-worth
  // feed the dominance ratio (#42 — winner must stand clearly above
  // the runner-up *crowd*, not just the single second-best, which
  // can be biased by a near-duplicate or a sibling concept).
  const winnerTokens = best.token.split(" ");
  const peers = []; // non-overlapping candidates after the winner
  for (let i = 1; i < cands.length; i++) {
    const c = cands[i];
    const cTokens = c.token.split(" ");
    const overlap = cTokens.some((t) => winnerTokens.includes(t));
    if (overlap) continue;
    peers.push(c);
    if (peers.length >= DOMINANCE_PEERS + 1) break;
  }
  const second = peers[0] || cands[1] || null;
  // Issue #42: top-2 — pick the highest non-overlapping peer that's
  // also non-overlapping with itself's own constituents (already
  // guaranteed by the overlap walk above). Same as `second`.
  const top2 = second;
  // Dominance ratio: best.score / mean(next DOMINANCE_PEERS scores).
  // Bigger = more dominant. Below DOMINANCE_RATIO the cluster is
  // diffuse; the caller decides whether to render the label or not.
  let dominanceRatio = Infinity;
  if (peers.length > 0) {
    const slice = peers.slice(0, DOMINANCE_PEERS);
    const sum = slice.reduce((s, c) => s + (c.score || 0), 0);
    const mean = sum / slice.length;
    dominanceRatio = mean > 0 ? best.score / mean : Infinity;
  }
  return {
    concept: best.token,
    kind: best.kind,
    score: best.score,
    secondScore: second ? second.score : 0,
    // #42 additions:
    top2Concept: top2 ? top2.token : "",
    top2Kind: top2 ? top2.kind : "",
    top2Score: top2 ? top2.score : 0,
    dominanceRatio,
  };
}

// c-TF-IDF concept naming for an L1 peer territory. Each (peer, host)
// sub-territory is treated as one "doc" within the peer's corpus, and we
// extract the top 2-3 cross-host concepts. Quality gate applied here too.
//
// `townsByHostInPeer` = Array<Array<town>> — one inner array per host inside
// the peer.
//
// Returns { themes: string[] (1..3), score, secondScore } or null if no
// theme rises above the noise.
function cTfIdfNameForPeer(townsByHostInPeer, options) {
  const opts = options || {};
  const bigramBonus = opts.bigramBonus == null ? 1.3 : opts.bigramBonus;
  const maxThemes = opts.maxThemes == null ? 3 : opts.maxThemes;
  const N = townsByHostInPeer.length;
  if (N === 0) return null;
  if (N === 1) {
    // Only one host — no DF signal to compute. Still try unigrams against
    // a synthetic "all docs" of size 1 → IDF is 0 → no winners. Return
    // null to fall back to nickname display.
    return null;
  }
  // Per-host bags. Strip nothing host-specific here — themes should
  // surface terms that recur across hosts (so "computational psychiatry"
  // appearing in 3 different hosts is the kind of theme we want).
  const bags = [];
  for (let i = 0; i < N; i++) {
    const towns = townsByHostInPeer[i] || [];
    bags.push(_territoryBags(towns, ""));
  }
  // Across-host DF: token → number of hosts that mention it.
  const dfU = new Map();
  const dfB = new Map();
  for (const b of bags) {
    for (const tok of b.uni.keys()) dfU.set(tok, (dfU.get(tok) || 0) + 1);
    for (const tok of b.bi.keys()) dfB.set(tok, (dfB.get(tok) || 0) + 1);
  }
  // Aggregate term frequencies across the whole peer corpus.
  const tfU = new Map();
  const tfB = new Map();
  let totalU = 0, totalB = 0;
  for (const b of bags) {
    for (const [tok, c] of b.uni) { tfU.set(tok, (tfU.get(tok) || 0) + c); totalU += c; }
    for (const [tok, c] of b.bi) { tfB.set(tok, (tfB.get(tok) || 0) + c); totalB += c; }
  }
  if (tfU.size === 0 && tfB.size === 0) return null;
  const denomU = Math.max(1, totalU);
  const denomB = Math.max(1, totalB);

  // Score: prefer themes that span MULTIPLE hosts (df ≥ 2). Tokens that
  // appear in only one host are likely host-specific noise, not themes.
  const cands = [];
  for (const [tok, tf] of tfU) {
    const df = dfU.get(tok) || 1;
    if (df < 2) continue; // must span hosts
    if (tf < 3) continue; // and recur enough to matter
    const idf = Math.log(N / (df + 1) + 1);
    const score = (tf / denomU) * idf;
    if (score > 0) cands.push({ token: tok, kind: "unigram", score });
  }
  for (const [tok, tf] of tfB) {
    const df = dfB.get(tok) || 1;
    if (df < 2) continue;
    if (tf < 2) continue;
    const idf = Math.log(N / (df + 1) + 1);
    const score = (tf / denomB) * idf * bigramBonus;
    if (score > 0) cands.push({ token: tok, kind: "bigram", score });
  }
  if (cands.length === 0) return null;
  cands.sort((a, b) => b.score - a.score);

  // Optional debug — set window.__srwk_atlas_dbg = true to dump the top
  // candidates per peer to the console. Off by default (otherwise each
  // notifyDataChanged would spam the renderer log).
  if (typeof window !== "undefined" && window.__srwk_atlas_dbg) {
    try {
      console.log("[atlas] peer cTF-IDF top candidates:",
        JSON.stringify(cands.slice(0, 10).map((c) => ({
          tok: c.token, kind: c.kind, score: Number(c.score.toFixed(4)),
        }))));
    } catch {}
  }

  // Greedy de-dup: drop any candidate that shares a token with a
  // higher-scoring already-picked candidate. Catches all four overlap
  // cases — bigram vs bigram ("language models" vs "large language"),
  // unigram vs bigram ("predictive coding" subsumes "predictive"), etc.
  // Also drops exact dupes.
  const picked = [];
  const usedTokens = new Set();
  for (const c of cands) {
    const parts = c.token.split(" ");
    let dup = false;
    for (const part of parts) {
      if (usedTokens.has(part)) { dup = true; break; }
    }
    if (dup) continue;
    picked.push(c);
    for (const part of parts) usedTokens.add(part);
    if (picked.length >= maxThemes) break;
  }
  if (picked.length === 0) return null;
  // Quality: top theme must be at least 1.4× the next un-picked candidate.
  const topScore = picked[0].score;
  const secondScore = picked[1] ? picked[1].score : 0;
  return {
    themes: picked.map((p) => p.token),
    kinds: picked.map((p) => p.kind),
    score: topScore,
    secondScore,
  };
}

// Cache key for territory concept naming — sorted town-id hash. Used to
// skip recomputation when the same set of pages is in the same territory
// across `notifyDataChanged` rebuilds. The 50-event session re-evaluation
// hysteresis is tracked via a counter on the cached entry.
function _territoryCacheKey(towns) {
  if (!towns || towns.length === 0) return "empty";
  const ids = towns.map((t) => t.id || "").sort();
  // FNV-1a-ish over the joined string is fine — collisions just mean a
  // recompute, which is cheap.
  let h = 2166136261 >>> 0;
  for (let i = 0; i < ids.length; i++) {
    const s = ids[i];
    for (let j = 0; j < s.length; j++) {
      h ^= s.charCodeAt(j);
      h = Math.imul(h, 16777619) >>> 0;
    }
    h ^= 0x2C; // separator
    h = Math.imul(h, 16777619) >>> 0;
  }
  return `${ids.length}:${h.toString(36)}`;
}

// Process-lifetime concept-name cache. Keyed by territory cache key
// (above). Survives multiple `notifyDataChanged` rebuilds. The hysteresis
// counter is per-entry.
const _conceptCache = new Map();
const CONCEPT_REEVAL_AFTER = 50; // hits before allowing one re-eval per session
const CONCEPT_REEVAL_BEAT_RATIO = 2.0; // new winner must beat cached 2× to flip

// Look up or compute a concept name for an L2 territory, with cache +
// hysteresis. The compute fn produces { concept, kind, score, ... } | null.
function _cachedConcept(key, computeFn) {
  let entry = _conceptCache.get(key);
  if (entry) {
    entry.hits++;
    if (entry.hits < CONCEPT_REEVAL_AFTER || entry.reevaluated) return entry.value;
    // Allow one re-evaluation. Only flip the cached label if the new top
    // scores ≥ 2× the cached one. Hysteresis prevents flicker.
    const fresh = computeFn();
    entry.reevaluated = true;
    if (fresh && entry.value && fresh.score >= entry.value.score * CONCEPT_REEVAL_BEAT_RATIO) {
      entry.value = fresh;
    }
    return entry.value;
  }
  const value = computeFn();
  entry = { value, hits: 1, reevaluated: false };
  _conceptCache.set(key, entry);
  return value;
}

// Quality-gate threshold: top score must beat the next *non-overlapping*
// candidate by this ratio for the c-TF-IDF concept to be honored. Below
// this, the territory's content is too diverse for a confident label and
// we fall back to host-only.
//
// Initially set to 1.4× per spec, but most L2 territories ended up below
// it in the local 930-page corpus (research-paper hosts share a lot of
// vocabulary, so "ketamine" doesn't strictly dominate "memory" by 1.4×).
// Loosened to 1.15× — still demands a clear winner (a 15% lead over the
// next non-overlapping candidate) but lets shared vocabularies still
// produce a recognizable concept name. Hosts whose content is genuinely
// uniform (no winner at all) still cleanly fall back to host-only via
// score==0 / no candidates / true ties (ratio==1.0).
const CONCEPT_GATE_RATIO = 1.15;

// Format a concept token for display: replace underscores with spaces,
// trim, cap at 32 chars (very long concepts collapse to a sensible length
// — "predictive coding" passes; "predictive coding theory framework"
// would clip at the word boundary).
function formatConcept(token, max = 32) {
  if (!token) return "";
  let s = String(token).replace(/_/g, " ").trim();
  if (s.length > max) {
    const cut = s.slice(0, max);
    const sp = cut.lastIndexOf(" ");
    s = (sp > max - 12) ? cut.slice(0, sp) : cut;
  }
  return s;
}

// PR D: cluster the towns of one (peer, host) region into ~k topic clusters.
// Strategy:
//   1. Try TF-IDF over tokenized titles. If we have ≥ MIN_CLUSTER_PAGES and
//      at least k distinct tokens after stop-word removal, project each town
//      to a sparse TF-IDF vector, then to a 2D space via the top-2 IDF axes
//      (cheap, deterministic, no ML deps), and cluster in 2D with k-means.
//   2. Fallback: group by `pathPrefix(url, 2)` (then 1 if 2 yields a single
//      bucket). Each prefix becomes a cluster, top-K by size kept.
// In both paths we attach a `topToken` string to each cluster — the most
// distinctive lowercase tokens in that cluster's title bag — used for
// the small italic label drawn at zoom > 5×.
function clusterTowns(towns) {
  if (!towns || towns.length < MIN_CLUSTER_PAGES) {
    // Single trivial cluster — no point fragmenting tiny hosts. We still
    // return a valid structure so the renderer treats every host the same.
    return [{
      towns: towns ? towns.slice() : [],
      topToken: "",
      cx: 0, cy: 0, r: 0,
    }];
  }
  // Number of clusters scaled by host size, capped to the spec range.
  const k = clamp(Math.round(Math.sqrt(towns.length / 2)),
                  CLUSTERS_PER_HOST_MIN, CLUSTERS_PER_HOST_MAX);

  // ── 1) TF-IDF attempt ─────────────────────────────────────────────────
  // Per-doc token bag.
  const docs = towns.map((t) => tokenize(t.title || t.id || ""));
  const docFreq = new Map();
  for (const bag of docs) {
    const seen = new Set();
    for (const tok of bag) {
      if (seen.has(tok)) continue;
      seen.add(tok);
      docFreq.set(tok, (docFreq.get(tok) || 0) + 1);
    }
  }
  // Need a corpus with at least k distinct tokens that don't appear in
  // every doc — otherwise TF-IDF degenerates and we should fall back.
  let usableTokens = 0;
  for (const [, df] of docFreq) {
    if (df < docs.length) usableTokens++;
  }
  if (usableTokens < k * 2) {
    return clusterByPathPrefix(towns, k);
  }

  // Compute IDF for each token. Standard idf = log(N / (1 + df)).
  const N = docs.length;
  const idf = new Map();
  for (const [tok, df] of docFreq) {
    idf.set(tok, Math.log((N + 1) / (1 + df)));
  }

  // Build a higher-dim feature space: pick the top-D IDF tokens that
  // occur in ≥ 2 docs and < N docs (so they actually discriminate).
  // Each doc becomes a length-D vector of TF-IDF values — sparse-ish
  // but small enough that a full distance computation is fine for
  // hundreds of pages.
  //
  // The earlier 2D projection mostly collapsed every doc to the origin
  // (since titles rarely contain BOTH chosen axis tokens), so k-means
  // produced one giant cluster and tiny outlier singletons. Increasing
  // the dimension fixes that without slowing things down: TF-IDF cluster
  // for 200 docs × 16 dims × 10 iters is well under a millisecond.
  const D_MAX = 16;
  const axes = [...idf.entries()]
    .filter(([tok, _]) => docFreq.get(tok) >= 2 && docFreq.get(tok) < N)
    .sort((a, b) => b[1] - a[1])
    .slice(0, D_MAX)
    .map(([tok]) => tok);
  if (axes.length < 2) {
    return clusterByPathPrefix(towns, k);
  }
  const D = axes.length;
  const axisIdx = new Map();
  axes.forEach((tok, i) => axisIdx.set(tok, i));

  const pts = [];
  for (let i = 0; i < N; i++) {
    const bag = docs[i];
    const v = new Float32Array(D);
    if (bag.length === 0) { pts.push(v); continue; }
    // Per-doc token counts.
    const counts = new Map();
    for (const t of bag) {
      const ai = axisIdx.get(t);
      if (ai === undefined) continue;
      counts.set(ai, (counts.get(ai) || 0) + 1);
    }
    for (const [ai, c] of counts) {
      v[ai] = (c / bag.length) * (idf.get(axes[ai]) || 0);
    }
    pts.push(v);
  }

  // K-means in D dims. Seed centroids with k-means++ for stability;
  // deterministic with a hash-derived RNG so the same data → same
  // clusters across reloads.
  const seed = (towns[0].id || "") + ":" + N;
  const rng = mulberry32(hash32(seed) >>> 0);
  const centroids = kmeansPlusPlusND(pts, k, D, rng);

  let assign = new Array(N).fill(0);
  for (let iter = 0; iter < 10; iter++) {
    let changed = false;
    for (let i = 0; i < N; i++) {
      let best = 0, bestD = Infinity;
      for (let c = 0; c < centroids.length; c++) {
        let d = 0;
        const cv = centroids[c];
        const pv = pts[i];
        for (let j = 0; j < D; j++) {
          const e = pv[j] - cv[j];
          d += e * e;
        }
        if (d < bestD) { bestD = d; best = c; }
      }
      if (assign[i] !== best) { changed = true; assign[i] = best; }
    }
    if (!changed) break;
    // Update centroids.
    const sums = centroids.map(() => new Float32Array(D));
    const counts = new Array(centroids.length).fill(0);
    for (let i = 0; i < N; i++) {
      const c = assign[i];
      counts[c]++;
      const sv = sums[c];
      const pv = pts[i];
      for (let j = 0; j < D; j++) sv[j] += pv[j];
    }
    for (let c = 0; c < centroids.length; c++) {
      if (counts[c] > 0) {
        const sv = sums[c];
        const cv = centroids[c];
        for (let j = 0; j < D; j++) cv[j] = sv[j] / counts[c];
      }
    }
  }

  // Re-balance: TF-IDF on short titles often produces one dominant
  // cluster + a long tail of tiny outliers. If the largest cluster
  // claims > 80% of the docs, the path-prefix structure usually offers
  // a more balanced topic split (e.g. arxiv.org/abs vs /pdf vs /list,
  // or frontiersin.org/articles vs /journals). Fall back to that.
  const counts = new Array(centroids.length).fill(0);
  for (const a of assign) counts[a]++;
  const distinct = counts.filter((c) => c > 0).length;
  const dominant = counts.length ? Math.max(...counts) : 0;
  if (distinct < 2 || dominant / N > 0.80) {
    const pp = clusterByPathPrefix(towns, k);
    // If path-prefix also gave a single cluster, keep the TF-IDF answer
    // (at least it picked SOMETHING) rather than degrading to one fat blob.
    if (pp.length >= 2) return pp;
  }

  return finalizeClusters(towns, docs, assign, centroids.length);
}

// PR D: lay out clusters inside a (peer, host) region. Each cluster gets:
//   cx,cy : centroid position inside the region (deterministic spiral)
//   r     : wash radius scaled with sqrt(town count)
//   color : a slight hue/lightness drift off the region's color
// We DON'T move the towns themselves — they keep the positions assigned
// at first placement. The cluster centroid is computed as the *mean* of
// its towns' positions so the L3 wash actually wraps the towns it owns,
// rather than sitting in some arbitrary spiral slot. The L3 r is sized
// to enclose the towns with a small bleed.
function layoutClusters(region, country, clusters) {
  if (!clusters || clusters.length === 0) return [];
  const out = [];
  // Sort clusters largest first so dominant clusters get the inner slot
  // when ties on visual prominence happen.
  clusters.sort((a, b) => b.towns.length - a.towns.length);
  const maxN = Math.max(1, clusters[0].towns.length);
  for (let i = 0; i < clusters.length; i++) {
    const cl = clusters[i];
    if (cl.towns.length === 0) continue;
    // Centroid = mean of town positions. Bound the r by the spread of
    // towns so the wash blob actually wraps them.
    let sx = 0, sy = 0;
    for (const t of cl.towns) { sx += t.x; sy += t.y; }
    const cx = sx / cl.towns.length;
    const cy = sy / cl.towns.length;
    let maxD = 0;
    for (const t of cl.towns) {
      const d = Math.hypot(t.x - cx, t.y - cy);
      if (d > maxD) maxD = d;
    }
    // r grows with sqrt(N) too — but is also bounded by the actual spread.
    // The minimum gives single-page or tight-cluster rendered visibility.
    const fraction = Math.sqrt(cl.towns.length) / Math.sqrt(maxN);
    const rByCount = Math.max(20, region.r * (0.18 + 0.30 * fraction));
    const rBySpread = maxD + 12;
    const r = Math.min(rByCount, Math.max(20, rBySpread));
    // Color: hue drift ±8° + lightness ±6% based on a stable hash of the
    // cluster's top-token (or fallback to index). Stays a clear sub-shade
    // of the host color so the family resemblance reads.
    const seedKey = `${region.host}::${cl.topToken || `cluster${i}`}`;
    const hueJ = ((hash32(seedKey + "::hue") >>> 0) % 17) - 8;     // -8..+8
    const lightJ = ((hash32(seedKey + "::l") >>> 0) % 11) - 5;     // -5..+5
    const color = adjustHueLight(region.color, hueJ, lightJ * 0.012);
    out.push({
      towns: cl.towns,
      topToken: cl.topToken || "",
      cx, cy, r,
      color,
      pageCount: cl.towns.length,
    });
    // Stamp the cluster reference back onto each town for picking/labels.
    for (const t of cl.towns) t.cluster = out[out.length - 1];
  }
  return out;
}

// PR D: deterministic small-state PRNG — Mulberry32. Used so cluster seeds
// are reproducible across reloads given the same data.
function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t = (t + 0x6D2B79F5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// PR D: k-means++ initial centroid placement (D²-weighted sampling),
// generalized to D-dim Float32Array points. Picks the first centroid
// uniformly, then each subsequent centroid with probability proportional
// to its squared distance to the closest already-picked centroid.
function kmeansPlusPlusND(pts, k, D, rng) {
  if (pts.length <= k) {
    return pts.map((p) => Float32Array.from(p)).slice(0, k);
  }
  const out = [];
  const first = Math.floor(rng() * pts.length);
  out.push(Float32Array.from(pts[first]));
  const dists = new Float64Array(pts.length).fill(Infinity);
  while (out.length < k) {
    let total = 0;
    const last = out[out.length - 1];
    for (let i = 0; i < pts.length; i++) {
      let d = 0;
      const pv = pts[i];
      for (let j = 0; j < D; j++) {
        const e = pv[j] - last[j];
        d += e * e;
      }
      if (d < dists[i]) dists[i] = d;
      total += dists[i];
    }
    if (total === 0) break;
    let r = rng() * total;
    let pick = 0;
    for (let i = 0; i < pts.length; i++) {
      r -= dists[i];
      if (r <= 0) { pick = i; break; }
    }
    out.push(Float32Array.from(pts[pick]));
  }
  return out;
}

// PR D: path-prefix fallback clustering. Group by first 2 path segments
// (drop to 1 if 2 yields a single bucket). Top-K buckets become clusters;
// the long tail is merged into a single "(other)" cluster.
function clusterByPathPrefix(towns, k) {
  let buckets = new Map();
  for (const t of towns) {
    const p = pathPrefix(t.id || "", 2);
    const key = p || "(root)";
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(t);
  }
  if (buckets.size < 2) {
    buckets = new Map();
    for (const t of towns) {
      const p = pathPrefix(t.id || "", 1);
      const key = p || "(root)";
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(t);
    }
  }
  if (buckets.size < 2) {
    // Truly nothing to separate — single cluster.
    return [{
      towns: towns.slice(),
      topToken: "",
      cx: 0, cy: 0, r: 0,
    }];
  }
  // Sort buckets by size desc, keep top k-1, merge the tail.
  const sorted = [...buckets.entries()].sort((a, b) => b[1].length - a[1].length);
  const headCount = Math.min(sorted.length, k);
  const head = sorted.slice(0, headCount);
  // Build assign[] in the order of `towns` so finalizeClusters can compute
  // consistent topTokens per cluster.
  const townToBucket = new Map();
  head.forEach(([key, list], idx) => {
    for (const t of list) townToBucket.set(t, idx);
  });
  // Towns that fell into the long tail go into an "(other)" cluster.
  let hasOther = false;
  for (let i = headCount; i < sorted.length; i++) {
    for (const t of sorted[i][1]) {
      townToBucket.set(t, headCount);
      hasOther = true;
    }
  }
  const numClusters = hasOther ? headCount + 1 : headCount;
  const assign = towns.map((t) => townToBucket.get(t) ?? 0);
  const docs = towns.map((t) => tokenize(t.title || t.id || ""));
  return finalizeClusters(towns, docs, assign, numClusters);
}

// PR D: turn an assign[] of cluster indices into the cluster objects the
// renderer expects. Computes per-cluster top tokens (most distinctive
// terms by tf · (df-in-cluster / total-df)) for the L3 labels.
function finalizeClusters(towns, docs, assign, numClusters) {
  const buckets = Array.from({ length: numClusters }, () => []);
  for (let i = 0; i < towns.length; i++) {
    buckets[assign[i] | 0].push(i);
  }
  // Global doc frequency.
  const globalDF = new Map();
  for (const bag of docs) {
    const seen = new Set();
    for (const t of bag) {
      if (seen.has(t)) continue;
      seen.add(t);
      globalDF.set(t, (globalDF.get(t) || 0) + 1);
    }
  }
  const out = [];
  for (let c = 0; c < buckets.length; c++) {
    const idxs = buckets[c];
    if (idxs.length === 0) continue;
    // Per-cluster doc frequency.
    const localDF = new Map();
    for (const i of idxs) {
      const seen = new Set();
      for (const t of docs[i]) {
        if (seen.has(t)) continue;
        seen.add(t);
        localDF.set(t, (localDF.get(t) || 0) + 1);
      }
    }
    // Score each token by ratio of in-cluster df vs out-of-cluster df,
    // weighted by total in-cluster df. This finds tokens that are
    // *characteristic* of the cluster (high in, low out), which reads
    // better than raw TF-IDF for short titles.
    let bestTok = "", bestScore = -Infinity;
    for (const [tok, dfIn] of localDF) {
      if (dfIn < 2) continue; // single-mention tokens are noise
      const dfTotal = globalDF.get(tok) || dfIn;
      const dfOut = dfTotal - dfIn;
      const score = (dfIn / Math.max(1, idxs.length)) *
                    (dfIn / (dfIn + dfOut + 1));
      if (score > bestScore) { bestScore = score; bestTok = tok; }
    }
    out.push({
      towns: idxs.map((i) => towns[i]),
      topToken: bestTok,
      // cx,cy,r filled in by the layout pass.
      cx: 0, cy: 0, r: 0,
    });
  }
  // If we somehow ended up with zero non-empty buckets, return one fat
  // cluster so the renderer sees a sane structure.
  if (out.length === 0) {
    return [{ towns: towns.slice(), topToken: "", cx: 0, cy: 0, r: 0 }];
  }
  return out;
}

// ─── topic-clustering pipeline ───────────────────────────────────────────
// Sprint (2026-05-02): replace the (peer, host) Fibonacci-spiral layout
// with topic-coherent clusters. Per page → tokens → sparse TF-IDF vector
// → truncated SVD (k=30) → k-means (K=15) → 2D MDS of cluster centroids.
// Each cluster becomes one ATLAS country; the 2D MDS gives the map
// position; TF-IDF-style c-TF-IDF naming (already in this file) provides
// the territory name. Page identity is preserved so peer/host still show
// up in the hover panel + legend.
//
// Constraints:
//   - pure JS, no dependencies, no model download
//   - cold compute under 2s, cached under 300ms
//   - deterministic given the same set of page-IDs (mulberry32 seeded
//     by hash of sorted IDs). Adding a page may shift the layout
//     slightly — that's fine for v1; multi-week stability comes later.
//
// Cache: localStorage `srwk:atlas:topicClusters:v1` keyed on hash of
// sorted page-IDs. Stores { vocabulary, svdMatrix, kmeansAssignments,
// mdsPositions } so a reload skips the SVD + k-means + MDS work.

const TOPIC_K_CLUSTERS = 15;
const TOPIC_SVD_DIMS = 30;
const TOPIC_VOCAB_CAP = 2000;
const TOPIC_KMEANS_ITERS = 25;
const TOPIC_SVD_POWER_ITERS = 4;
const TOPIC_LS_KEY = "srwk:atlas:topicClusters:v1";

// Hash a sorted list of page-IDs into a stable cache + RNG key.
function topicHashOfIds(ids) {
  const sorted = [...ids].sort();
  let h = 2166136261 >>> 0;
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i];
    for (let j = 0; j < s.length; j++) {
      h ^= s.charCodeAt(j);
      h = Math.imul(h, 16777619) >>> 0;
    }
    h ^= 0x2C; h = Math.imul(h, 16777619) >>> 0;
  }
  return ((h >>> 0).toString(36)) + ":" + sorted.length;
}

// Top-level orchestrator.
// Returns { clusters, pagePositions, clusterCentroids2D, perfMs, fromCache }.
//   clusters[i] = { id, pageIndices: [...], centroidNd: Float32Array(D),
//                   centroid2D: [x, y], pageCount, topToken (filled later) }
//   pagePositions[i] = [x, y] in world coords (post-MDS layout)
//   clusterCentroids2D[i] = [x, y] in world coords
function buildTopicClusters(pages) {
  const t0 = (typeof performance !== "undefined" ? performance.now() : Date.now());
  const N = pages.length;
  if (N === 0) {
    return {
      clusters: [], pagePositions: [], clusterCentroids2D: [],
      perfMs: 0, fromCache: false, k: 0,
    };
  }

  const ids = pages.map((p) => p.id || "");
  const hashKey = topicHashOfIds(ids);

  // Cache lookup.
  let cached = null;
  try {
    const raw = localStorage.getItem(TOPIC_LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.hashKey === hashKey) cached = parsed;
    }
  } catch {}

  // Tokenize each title into a unigram+bigram bag using the existing
  // tokenizeTitle helper (which already strips STOPWORDS +
  // CONCEPT_EXTRA_STOPWORDS + the host's own name).
  const docBags = new Array(N);
  for (let i = 0; i < N; i++) {
    const p = pages[i];
    const { unigrams, bigrams } = tokenizeTitle(p.title || p.id || "", p.host || "");
    const bag = new Map();
    for (const t of unigrams) bag.set(t, (bag.get(t) || 0) + 1);
    for (const t of bigrams) bag.set(t, (bag.get(t) || 0) + 1);
    docBags[i] = bag;
  }

  // Document frequency.
  const df = new Map();
  for (const bag of docBags) {
    for (const tok of bag.keys()) df.set(tok, (df.get(tok) || 0) + 1);
  }

  // Vocabulary filter: 2 ≤ df ≤ 0.4 * N. Cap to top TOPIC_VOCAB_CAP by IDF.
  // Smaller df bound is critical — without it `the` survives the stopword
  // filter when titles are unusual. We already strip stopwords in
  // tokenizeTitle; this is belt-and-braces.
  const dfMax = Math.max(2, Math.floor(0.4 * N));
  const vocabPool = [];
  for (const [tok, dfi] of df) {
    if (dfi < 2) continue;
    if (dfi > dfMax) continue;
    const idf = Math.log(N / dfi);
    if (idf <= 0) continue;
    vocabPool.push({ tok, idf, df: dfi });
  }
  vocabPool.sort((a, b) => b.idf - a.idf);
  const vocab = vocabPool.slice(0, TOPIC_VOCAB_CAP);
  const V = vocab.length;
  const tokenIdx = new Map();
  vocab.forEach((v, i) => tokenIdx.set(v.tok, i));
  const idfArr = new Float32Array(V);
  for (let i = 0; i < V; i++) idfArr[i] = vocab[i].idf;

  if (V < TOPIC_K_CLUSTERS * 2) {
    // Vocabulary too thin to cluster. Bail out into a degenerate "single
    // cluster" so the renderer still draws something.
    const out = {
      clusters: [{
        id: 0, pageIndices: pages.map((_, i) => i),
        centroidNd: new Float32Array(1),
        centroid2D: [0, 0], pageCount: N, topToken: "",
        radius: 80,
      }],
      pagePositions: pages.map(() => [0, 0]),
      clusterCentroids2D: [[0, 0]],
      assignments: new Int32Array(N),
      perfMs: 0, fromCache: false, k: 1,
    };
    return out;
  }

  // Sparse TF-IDF rows. row[i] = { idx: Int32Array, val: Float32Array }
  // Pre-normalize to unit L2 length so cosine k-means is just dot product.
  const rows = new Array(N);
  for (let i = 0; i < N; i++) {
    const bag = docBags[i];
    const idxs = [];
    const vals = [];
    for (const [tok, tf] of bag) {
      const ti = tokenIdx.get(tok);
      if (ti === undefined) continue;
      const v = tf * idfArr[ti];
      if (v > 0) {
        idxs.push(ti);
        vals.push(v);
      }
    }
    // L2 normalize.
    let norm = 0;
    for (let j = 0; j < vals.length; j++) norm += vals[j] * vals[j];
    norm = Math.sqrt(norm) || 1;
    const fv = new Float32Array(vals.length);
    for (let j = 0; j < vals.length; j++) fv[j] = vals[j] / norm;
    rows[i] = { idx: Int32Array.from(idxs), val: fv };
  }

  // RNG seeded by hash-of-page-IDs. Used for SVD initialization, k-means++
  // seeding, and per-page jitter.
  const seedInt = (hash32(hashKey) >>> 0);

  let svdMatrix; // N × D dense
  let assignments;
  let centroidsNd;
  let centroids2D;
  let fromCache = false;

  if (cached && cached.svdMatrix && cached.assignments && cached.centroids2D
      && cached.svdMatrix.length === N * TOPIC_SVD_DIMS
      && cached.assignments.length === N
      && cached.centroids2D.length === TOPIC_K_CLUSTERS * 2) {
    svdMatrix = Float32Array.from(cached.svdMatrix);
    assignments = Int32Array.from(cached.assignments);
    centroids2D = new Array(TOPIC_K_CLUSTERS);
    for (let i = 0; i < TOPIC_K_CLUSTERS; i++) {
      centroids2D[i] = [cached.centroids2D[i * 2], cached.centroids2D[i * 2 + 1]];
    }
    // Recompute Nd centroids cheaply from the cached SVD + assignments.
    centroidsNd = computeNdCentroids(svdMatrix, assignments, TOPIC_K_CLUSTERS, TOPIC_SVD_DIMS);
    fromCache = true;
  } else {
    // Truncated SVD via randomized projection + power iteration.
    svdMatrix = randomizedSparseSVD(rows, V, TOPIC_SVD_DIMS, TOPIC_SVD_POWER_ITERS, seedInt);
    // L2 normalize each row of the embedding so k-means with squared
    // Euclidean distance approximates cosine.
    for (let i = 0; i < N; i++) {
      let s = 0;
      const off = i * TOPIC_SVD_DIMS;
      for (let j = 0; j < TOPIC_SVD_DIMS; j++) s += svdMatrix[off + j] * svdMatrix[off + j];
      const inv = s > 0 ? 1 / Math.sqrt(s) : 0;
      for (let j = 0; j < TOPIC_SVD_DIMS; j++) svdMatrix[off + j] *= inv;
    }

    // K-means with K=15 in the 30-dim space (cosine via normalized Euclidean).
    const km = kmeansCosine(svdMatrix, N, TOPIC_SVD_DIMS, TOPIC_K_CLUSTERS,
                            TOPIC_KMEANS_ITERS, seedInt);
    assignments = km.assignments;
    centroidsNd = km.centroids;

    // 2D centroid layout via classical MDS over cosine distances.
    centroids2D = mdsClassical2D(centroidsNd, TOPIC_K_CLUSTERS, TOPIC_SVD_DIMS, seedInt);
  }

  // Scale 2D positions to the world coordinate system. The existing world
  // is centered at origin with a span of ~1500 world units (worldRadius
  // is later derived from the populated bounds, so we just need to put
  // everything in a reasonable range — 800 world-units span is a good
  // default that's slightly wider than the legacy peer-centroid spread
  // so the per-cluster disks don't pile on top of each other).
  const TARGET_HALF_SPAN = 700;
  let cx0 = 0, cy0 = 0;
  for (let i = 0; i < TOPIC_K_CLUSTERS; i++) {
    cx0 += centroids2D[i][0]; cy0 += centroids2D[i][1];
  }
  cx0 /= TOPIC_K_CLUSTERS; cy0 /= TOPIC_K_CLUSTERS;
  let maxAbs = 1e-6;
  for (let i = 0; i < TOPIC_K_CLUSTERS; i++) {
    const dx = centroids2D[i][0] - cx0;
    const dy = centroids2D[i][1] - cy0;
    const m = Math.max(Math.abs(dx), Math.abs(dy));
    if (m > maxAbs) maxAbs = m;
  }
  const scale = TARGET_HALF_SPAN / maxAbs;
  const centroids2DScaled = new Array(TOPIC_K_CLUSTERS);
  for (let i = 0; i < TOPIC_K_CLUSTERS; i++) {
    centroids2DScaled[i] = [
      (centroids2D[i][0] - cx0) * scale,
      (centroids2D[i][1] - cy0) * scale,
    ];
  }

  // Page placement: each page sits in a small disk around its cluster's
  // 2D centroid. Disk radius scales with sqrt(page_count). Per-page angle
  // is deterministic via hash of URL.
  const counts = new Array(TOPIC_K_CLUSTERS).fill(0);
  for (let i = 0; i < N; i++) counts[assignments[i]]++;
  const clusterRadius = new Array(TOPIC_K_CLUSTERS);
  // Radius units chosen so the largest cluster has ~ radius 200 world-units.
  // sqrt(page_count): a 100-page cluster gets r ≈ 200; a 4-page cluster gets ≈ 40.
  const RADIUS_BASE = 18;
  const RADIUS_MIN = 60;
  for (let i = 0; i < TOPIC_K_CLUSTERS; i++) {
    clusterRadius[i] = Math.max(RADIUS_MIN, RADIUS_BASE * Math.sqrt(Math.max(1, counts[i])));
  }
  const pagePositions = new Array(N);
  // Rank within cluster — needed for tanh radius logic (newest near
  // centroid). We sort each cluster's pages by fetched_at desc so the
  // freshest land in the dense core, matching the legacy behavior.
  const perClusterIdx = Array.from({ length: TOPIC_K_CLUSTERS }, () => []);
  for (let i = 0; i < N; i++) perClusterIdx[assignments[i]].push(i);
  for (let c = 0; c < TOPIC_K_CLUSTERS; c++) {
    perClusterIdx[c].sort((a, b) => {
      const fa = +new Date(pages[a].fetched_at || 0);
      const fb = +new Date(pages[b].fetched_at || 0);
      return fb - fa;
    });
    const cx = centroids2DScaled[c][0];
    const cy = centroids2DScaled[c][1];
    const rSize = clusterRadius[c];
    const list = perClusterIdx[c];
    for (let k = 0; k < list.length; k++) {
      const i = list[k];
      const tSeed = hash32(`topic::${c}::${ids[i]}`) >>> 0;
      const angle = (tSeed & 0xFFFF) / 0xFFFF * TAU;
      const jitter = ((tSeed >>> 16) & 0x1F) * 0.003;
      const sat = Math.tanh(0.10 * Math.sqrt(k + 1) + jitter);
      const tR = 0.88 * rSize * sat + 4;
      pagePositions[i] = [cx + Math.cos(angle) * tR, cy + Math.sin(angle) * tR];
    }
  }

  const clusters = new Array(TOPIC_K_CLUSTERS);
  for (let c = 0; c < TOPIC_K_CLUSTERS; c++) {
    clusters[c] = {
      id: c,
      pageIndices: perClusterIdx[c].slice(),
      centroidNd: centroidsNd[c],
      centroid2D: centroids2DScaled[c],
      radius: clusterRadius[c],
      pageCount: counts[c],
      topToken: "", // filled by c-TF-IDF naming downstream
    };
  }

  // Cache (skip if from-cache; nothing to write).
  if (!fromCache) {
    try {
      const blob = {
        hashKey,
        svdMatrix: Array.from(svdMatrix),
        assignments: Array.from(assignments),
        centroids2D: centroids2D.flat(),
      };
      localStorage.setItem(TOPIC_LS_KEY, JSON.stringify(blob));
    } catch {}
  }

  const t1 = (typeof performance !== "undefined" ? performance.now() : Date.now());
  return {
    clusters, pagePositions, clusterCentroids2D: centroids2DScaled,
    perfMs: t1 - t0, fromCache, k: TOPIC_K_CLUSTERS,
    assignments,
    // Stash the SVD embedding + page id list so downstream code (notably
    // dumpClusters) can compute "most representative" pages by ranking
    // assigned pages by their cosine similarity to the cluster centroid.
    embedding: svdMatrix,
    pageIds: ids.slice(),
    centroidsNd,
  };
}

// Compute Nd centroids from the SVD matrix + assignments.
function computeNdCentroids(svdMatrix, assignments, K, D) {
  const cents = new Array(K);
  for (let c = 0; c < K; c++) cents[c] = new Float32Array(D);
  const counts = new Int32Array(K);
  const N = assignments.length;
  for (let i = 0; i < N; i++) {
    const c = assignments[i];
    counts[c]++;
    const off = i * D;
    const cv = cents[c];
    for (let j = 0; j < D; j++) cv[j] += svdMatrix[off + j];
  }
  for (let c = 0; c < K; c++) {
    if (counts[c] > 0) {
      const cv = cents[c];
      for (let j = 0; j < D; j++) cv[j] /= counts[c];
    }
  }
  return cents;
}

// ─── randomized truncated SVD ────────────────────────────────────────────
// Inputs:
//   rows: Array of { idx, val } sparse N rows
//   V:    vocabulary size (column count of the term-doc matrix)
//   D:    target embedding dimension
//   pIters: power iterations (≥ 2 for OK quality, 4 for k-means inputs)
//   seedInt: deterministic RNG seed
// Output:
//   N × D Float32Array (row-major) with the truncated SVD embedding
//   approximating the top-D left singular vectors scaled by singular values.
//
// Algorithm (Halko/Martinsson/Tropp randomized SVD, simplified):
//   1. Build random Gaussian matrix Ω ∈ R^{V × D'}, where D' = D + 5 oversample.
//   2. Y = A · Ω  (N × D')
//   3. Power iterate:  Y = A · (Aᵀ · Y)   (pIters times) — pulls Y toward
//      the dominant left singular subspace.
//   4. Orthonormalize Y via modified Gram-Schmidt → Q (N × D').
//   5. B = Qᵀ · A (D' × V); C = B · Bᵀ (D' × D').
//   6. Eigendecompose C (small D'×D') to get its top-D eigenvectors W.
//   7. Embedding = Q · W · √eigvals  (N × D), the top-D left singular
//      directions scaled by their singular values.
//
// We work entirely with the sparse rows; A is never materialized dense.
function randomizedSparseSVD(rows, V, D, pIters, seedInt) {
  const N = rows.length;
  const Dover = D + 5; // oversample for stability
  const rng = mulberry32(seedInt);

  // Box-Muller for Gaussian draws.
  function gauss() {
    let u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  // Ω: V × Dover, stored row-major for column-fast multiplication.
  // (Each row is one vocab term's projection vector.)
  const omega = new Float32Array(V * Dover);
  for (let i = 0; i < V * Dover; i++) omega[i] = gauss();

  // multAOmega: Y[N × Dover] = A · Ω where A is the sparse N×V doc-term matrix.
  // Row i of Y = sum over (j in idx_i) of val_i[j] * omega[ idx_i[j] ].
  function multAOmega(Om) {
    const Y = new Float32Array(N * Dover);
    for (let i = 0; i < N; i++) {
      const r = rows[i];
      const idx = r.idx, val = r.val;
      const off = i * Dover;
      for (let k = 0; k < idx.length; k++) {
        const v = val[k];
        const omOff = idx[k] * Dover;
        for (let d = 0; d < Dover; d++) Y[off + d] += v * Om[omOff + d];
      }
    }
    return Y;
  }

  // multATY: Z[V × Dover] = Aᵀ · Y. For each doc i, accumulate val[k] * Y[i,:]
  // into row idx[k] of Z.
  function multATY(Y) {
    const Z = new Float32Array(V * Dover);
    for (let i = 0; i < N; i++) {
      const r = rows[i];
      const idx = r.idx, val = r.val;
      const yOff = i * Dover;
      for (let k = 0; k < idx.length; k++) {
        const v = val[k];
        const zOff = idx[k] * Dover;
        for (let d = 0; d < Dover; d++) Z[zOff + d] += v * Y[yOff + d];
      }
    }
    return Z;
  }

  let Y = multAOmega(omega);
  for (let p = 0; p < pIters; p++) {
    const Z = multATY(Y);
    Y = multAOmega(Z);
  }

  // Orthonormalize Y (N × Dover) via modified Gram-Schmidt — column-by-
  // column. Each column is a length-N vector. We need a new matrix Q of
  // the same shape with Qᵀ Q = I.
  const Q = new Float32Array(N * Dover);
  // First, copy Y into Q.
  Q.set(Y);
  // Per-column ops; access strided by Dover.
  for (let c = 0; c < Dover; c++) {
    // Subtract projections onto previously-orthonormalized columns.
    for (let p = 0; p < c; p++) {
      let dot = 0;
      for (let i = 0; i < N; i++) dot += Q[i * Dover + p] * Q[i * Dover + c];
      for (let i = 0; i < N; i++) Q[i * Dover + c] -= dot * Q[i * Dover + p];
    }
    // Normalize column c.
    let norm = 0;
    for (let i = 0; i < N; i++) {
      const v = Q[i * Dover + c];
      norm += v * v;
    }
    norm = Math.sqrt(norm);
    if (norm < 1e-9) {
      // Degenerate column — zero it; the eigendecomp below will treat it
      // as a zero singular value.
      for (let i = 0; i < N; i++) Q[i * Dover + c] = 0;
    } else {
      const inv = 1 / norm;
      for (let i = 0; i < N; i++) Q[i * Dover + c] *= inv;
    }
  }

  // B = Qᵀ · A : Dover × V.
  // Then C = B · Bᵀ : Dover × Dover. We compute C directly without storing B
  // in full (B is V wide; Dover is small so we just need the Dover²
  // outputs). Easier: compute B sparsely on the fly.
  // For clarity: construct B explicitly. Dover × V is at most 35 × 2000 = 70k
  // floats — trivially small.
  const B = new Float32Array(Dover * V);
  for (let i = 0; i < N; i++) {
    const r = rows[i];
    const idx = r.idx, val = r.val;
    for (let d = 0; d < Dover; d++) {
      const qid = Q[i * Dover + d];
      if (qid === 0) continue;
      const bOff = d * V;
      for (let k = 0; k < idx.length; k++) {
        B[bOff + idx[k]] += qid * val[k];
      }
    }
  }
  // C = B · Bᵀ.
  const C = new Float32Array(Dover * Dover);
  for (let a = 0; a < Dover; a++) {
    const aOff = a * V;
    for (let b = 0; b <= a; b++) {
      const bOff = b * V;
      let s = 0;
      for (let v = 0; v < V; v++) s += B[aOff + v] * B[bOff + v];
      C[a * Dover + b] = s;
      C[b * Dover + a] = s;
    }
  }

  // Eigendecompose C via Jacobi rotations (Dover ≤ 35 — fine).
  const W = new Float32Array(Dover * Dover);
  for (let i = 0; i < Dover; i++) W[i * Dover + i] = 1;
  jacobiEigen(C, W, Dover, 80);
  // Eigenvalues sit on C's diagonal after Jacobi. Sort by eigenvalue desc
  // and keep top D.
  const eigs = [];
  for (let i = 0; i < Dover; i++) eigs.push({ idx: i, val: C[i * Dover + i] });
  eigs.sort((a, b) => b.val - a.val);
  // Build embedding = Q · (top-D eigenvectors of C, scaled by sqrt(eigval)).
  // Top-D eigenvectors of C are columns of W indexed by eigs[0..D-1].idx.
  const out = new Float32Array(N * D);
  for (let d = 0; d < D; d++) {
    const e = eigs[d];
    const ev = Math.max(0, e.val);
    const sigma = Math.sqrt(ev);
    // column `e.idx` of W (Dover-tall).
    for (let i = 0; i < N; i++) {
      let s = 0;
      const qOff = i * Dover;
      for (let k = 0; k < Dover; k++) {
        s += Q[qOff + k] * W[k * Dover + e.idx];
      }
      out[i * D + d] = s * sigma;
    }
  }
  return out;
}

// In-place Jacobi eigendecomposition for a symmetric n×n matrix A.
// W starts as identity; on exit the columns of W are the eigenvectors and
// the eigenvalues are A's diagonal entries. Convergence threshold: off-
// diagonals < 1e-9 * max-diagonal, or maxSweeps reached.
function jacobiEigen(A, W, n, maxSweeps) {
  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let off = 0;
    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) off += Math.abs(A[p * n + q]);
    }
    if (off < 1e-9) return;
    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = A[p * n + q];
        if (Math.abs(apq) < 1e-12) continue;
        const app = A[p * n + p];
        const aqq = A[q * n + q];
        const theta = (aqq - app) / (2 * apq);
        let t;
        if (Math.abs(theta) > 1e8) {
          t = 1 / (2 * theta);
        } else {
          const sgn = theta >= 0 ? 1 : -1;
          t = sgn / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        }
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        // Update A.
        A[p * n + p] = app - t * apq;
        A[q * n + q] = aqq + t * apq;
        A[p * n + q] = 0;
        A[q * n + p] = 0;
        for (let i = 0; i < n; i++) {
          if (i !== p && i !== q) {
            const aip = A[i * n + p];
            const aiq = A[i * n + q];
            A[i * n + p] = c * aip - s * aiq;
            A[p * n + i] = A[i * n + p];
            A[i * n + q] = s * aip + c * aiq;
            A[q * n + i] = A[i * n + q];
          }
        }
        // Update W.
        for (let i = 0; i < n; i++) {
          const wip = W[i * n + p];
          const wiq = W[i * n + q];
          W[i * n + p] = c * wip - s * wiq;
          W[i * n + q] = s * wip + c * wiq;
        }
      }
    }
  }
}

// ─── k-means with cosine distance ────────────────────────────────────────
// embedding: N × D Float32Array (rows already L2-normalized by caller).
// Returns { assignments: Int32Array, centroids: Array<Float32Array(D)> }.
function kmeansCosine(embedding, N, D, K, maxIter, seedInt) {
  const rng = mulberry32(seedInt ^ 0xA5A5);
  // k-means++ seeding in cosine space (= angular distance over normalized
  // vectors). With normalized rows, squared Euclidean distance is
  // 2(1 - cos), so we seed by D² weights and minimize squared Euclidean
  // — equivalent to cosine k-means at a fraction of the bookkeeping.
  const centroids = new Array(K);
  // First centroid: a deterministic page near the data centroid (best
  // generic starting point given normalized rows).
  let firstIdx = 0;
  {
    const meanV = new Float32Array(D);
    for (let i = 0; i < N; i++) {
      const off = i * D;
      for (let j = 0; j < D; j++) meanV[j] += embedding[off + j];
    }
    for (let j = 0; j < D; j++) meanV[j] /= N;
    // Find the point closest to the data mean (most central).
    let bestS = -Infinity, best = 0;
    for (let i = 0; i < N; i++) {
      let s = 0;
      const off = i * D;
      for (let j = 0; j < D; j++) s += embedding[off + j] * meanV[j];
      if (s > bestS) { bestS = s; best = i; }
    }
    firstIdx = best;
  }
  centroids[0] = embedding.slice(firstIdx * D, firstIdx * D + D);

  // Subsequent centroids by D²-weighted sampling.
  const dists = new Float32Array(N);
  for (let i = 0; i < N; i++) dists[i] = Infinity;
  for (let c = 1; c < K; c++) {
    const last = centroids[c - 1];
    let total = 0;
    for (let i = 0; i < N; i++) {
      let d = 0;
      const off = i * D;
      for (let j = 0; j < D; j++) {
        const e = embedding[off + j] - last[j];
        d += e * e;
      }
      if (d < dists[i]) dists[i] = d;
      total += dists[i];
    }
    if (total <= 0) {
      // All points coincide with seeded centroids; fill remaining slots
      // with copies of the data mean (degenerate, but defensive).
      for (let cc = c; cc < K; cc++) centroids[cc] = centroids[0].slice();
      break;
    }
    let r = rng() * total;
    let pick = 0;
    for (let i = 0; i < N; i++) {
      r -= dists[i];
      if (r <= 0) { pick = i; break; }
    }
    centroids[c] = embedding.slice(pick * D, pick * D + D);
  }

  // Lloyd iterations.
  const assignments = new Int32Array(N);
  for (let it = 0; it < maxIter; it++) {
    let changed = 0;
    for (let i = 0; i < N; i++) {
      let bestD = Infinity, bestC = 0;
      const off = i * D;
      for (let c = 0; c < K; c++) {
        const cv = centroids[c];
        let d = 0;
        for (let j = 0; j < D; j++) {
          const e = embedding[off + j] - cv[j];
          d += e * e;
        }
        if (d < bestD) { bestD = d; bestC = c; }
      }
      if (assignments[i] !== bestC) { changed++; assignments[i] = bestC; }
    }
    if (changed === 0) break;
    // Update centroids: mean of assigned vectors, then re-normalize so we
    // stay on the unit sphere (cosine-friendly).
    for (let c = 0; c < K; c++) for (let j = 0; j < D; j++) centroids[c][j] = 0;
    const counts = new Int32Array(K);
    for (let i = 0; i < N; i++) {
      const c = assignments[i];
      counts[c]++;
      const off = i * D;
      const cv = centroids[c];
      for (let j = 0; j < D; j++) cv[j] += embedding[off + j];
    }
    for (let c = 0; c < K; c++) {
      if (counts[c] === 0) {
        // Empty cluster: re-seed with a random embedding row (non-empty
        // path is the common case; this is a safety net).
        const idx = Math.floor(rng() * N) % N;
        centroids[c] = embedding.slice(idx * D, idx * D + D);
        continue;
      }
      const cv = centroids[c];
      let s = 0;
      for (let j = 0; j < D; j++) { cv[j] /= counts[c]; s += cv[j] * cv[j]; }
      const inv = s > 0 ? 1 / Math.sqrt(s) : 0;
      for (let j = 0; j < D; j++) cv[j] *= inv;
    }
  }
  return { assignments, centroids };
}

// ─── classical MDS to 2D over cosine distances ───────────────────────────
// centroids: Array<Float32Array(D)> of K cluster centroids.
// Returns Array<[x, y]> length K.
//
// 1. Compute K×K cosine distance matrix d[i,j] = 1 - <ci, cj> / (||ci|| * ||cj||).
// 2. Square and double-center via Young-Householder: B = -0.5 J D² J.
// 3. Power-iterate to get top-2 eigenpairs of B.
// 4. Coordinates = top-2 eigenvectors scaled by sqrt(eigvals).
function mdsClassical2D(centroids, K, D, seedInt) {
  // Pairwise cosine distances.
  const d2 = new Float32Array(K * K);
  const norms = new Float32Array(K);
  for (let i = 0; i < K; i++) {
    let s = 0;
    const cv = centroids[i];
    for (let j = 0; j < D; j++) s += cv[j] * cv[j];
    norms[i] = Math.sqrt(s);
  }
  for (let i = 0; i < K; i++) {
    for (let j = i + 1; j < K; j++) {
      let dot = 0;
      const cvi = centroids[i], cvj = centroids[j];
      for (let k = 0; k < D; k++) dot += cvi[k] * cvj[k];
      const ni = norms[i], nj = norms[j];
      const cos = (ni > 0 && nj > 0) ? dot / (ni * nj) : 0;
      const dist = 1 - cos;
      const sq = dist * dist;
      d2[i * K + j] = sq;
      d2[j * K + i] = sq;
    }
  }
  // Double-center: B[i,j] = -0.5 * (d²[i,j] - row_mean - col_mean + grand_mean).
  const rowMean = new Float32Array(K);
  let grandMean = 0;
  for (let i = 0; i < K; i++) {
    let s = 0;
    for (let j = 0; j < K; j++) s += d2[i * K + j];
    rowMean[i] = s / K;
    grandMean += s;
  }
  grandMean /= (K * K);
  const B = new Float32Array(K * K);
  for (let i = 0; i < K; i++) {
    for (let j = 0; j < K; j++) {
      B[i * K + j] = -0.5 * (d2[i * K + j] - rowMean[i] - rowMean[j] + grandMean);
    }
  }
  // Eigendecompose B (symmetric K×K) via Jacobi.
  const W = new Float32Array(K * K);
  for (let i = 0; i < K; i++) W[i * K + i] = 1;
  // Copy B since jacobiEigen mutates in place.
  const BB = new Float32Array(B);
  jacobiEigen(BB, W, K, 100);
  const eigs = [];
  for (let i = 0; i < K; i++) eigs.push({ idx: i, val: BB[i * K + i] });
  eigs.sort((a, b) => b.val - a.val);
  // Top-2 eigenvectors columns of W; scale by sqrt(max(0, eig)).
  const out = new Array(K);
  const e0 = eigs[0], e1 = eigs[1];
  const s0 = Math.sqrt(Math.max(0, e0.val));
  const s1 = Math.sqrt(Math.max(0, e1.val));
  for (let i = 0; i < K; i++) {
    out[i] = [
      W[i * K + e0.idx] * s0,
      W[i * K + e1.idx] * s1,
    ];
  }
  // Suppress unused-arg warning — seedInt is reserved for a future
  // tie-break on near-degenerate eigenpairs.
  void seedInt;
  return out;
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function hexToRgb(hex) {
  if (!hex) return [180, 180, 180];
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex);
  if (!m) return [180, 180, 180];
  let s = m[1];
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

function hexToRgba(hex, a) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

function mixHex(a, b, t) {
  const A = hexToRgb(a), B = hexToRgb(b);
  const r = Math.round(A[0] * (1 - t) + B[0] * t);
  const g = Math.round(A[1] * (1 - t) + B[1] * t);
  const bl = Math.round(A[2] * (1 - t) + B[2] * t);
  return `rgb(${r},${g},${bl})`;
}

// PR D: adjust a hex color's hue (degrees) and lightness (delta in [0,1]).
// Used by L3 cluster colors to nudge each topic's tint a touch off the
// host's so adjacent clusters within a host read as a *family* of shades.
function adjustHueLight(hex, degrees, lightDelta) {
  const [r, g, b] = hexToRgb(hex);
  const [h, s, l] = rgbToHsl(r, g, b);
  let nh = h + degrees / 360;
  if (nh < 0) nh += 1;
  if (nh >= 1) nh -= 1;
  const nl = clamp(l + lightDelta, 0.18, 0.85);
  const [nr, ng, nb] = hslToRgb(nh, s, nl);
  return rgbToHex(nr, ng, nb);
}

// Rotate a hex color's hue by `degrees` (signed). Used to give each
// (peer, host) sub-region its own slight tint while preserving the
// peer's overall identity color.
function rotateHue(hex, degrees) {
  const [r, g, b] = hexToRgb(hex);
  const [h, s, l] = rgbToHsl(r, g, b);
  let nh = h + degrees / 360;
  if (nh < 0) nh += 1;
  if (nh >= 1) nh -= 1;
  const [nr, ng, nb] = hslToRgb(nh, s, l);
  return rgbToHex(nr, ng, nb);
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn;
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h;
  switch (mx) {
    case r: h = (g - b) / d + (g < b ? 6 : 0); break;
    case g: h = (b - r) / d + 2; break;
    default: h = (r - g) / d + 4;
  }
  return [h / 6, s, l];
}

function hslToRgb(h, s, l) {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  function t(x) {
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  }
  return [Math.round(t(h + 1 / 3) * 255), Math.round(t(h) * 255), Math.round(t(h - 1 / 3) * 255)];
}

function rgbToHex(r, g, b) {
  return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function truncatePk(pk) {
  if (!pk) return "—";
  return pk.length > 10 ? pk.slice(0, 6) + "…" + pk.slice(-3) : pk;
}

function escHtml(s) {
  return String(s == null ? "" : s)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
function escAttr(s) {
  return String(s == null ? "" : s).replaceAll('"', "&quot;");
}
