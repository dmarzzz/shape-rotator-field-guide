// signature.js — the visualizer's identity moment.
//
// Three things live here:
//
// 1. mountLaunchOverlay() — first-launch animation. Four dots scattered →
//    converge into the rotor glyph → glyph rotates → glyph anchors next
//    to the wordmark ("SHAPE ROTATOR") which types in mono-to-sans.
//    ~1.8s end-to-end. Skippable on Esc / pointerdown / Enter. Persists
//    `srwk:onboarded` after first run; subsequent launches show a single
//    220ms fade and no glyph dance.
//
// 2. mountTitlebarMark() — the small rotor glyph that lives next to the
//    titlebar "SHAPE ROTATOR" wordmark. Recurring identity, single hand.
//    Hovering rotates it ~30deg (a wink toward the launch sequence).
//
// 3. mountPaletteMark() — patch into the command palette so its header
//    glyph is the rotor instead of the generic search icon. Called by
//    boot.js once the palette has been registered.
//
// Conventions:
//  - localStorage namespace: srwk: (matches PR1/PR2).
//  - prefers-reduced-motion: launch overlay still renders the wordmark
//    + glyph but skips all motion (snap to final state).
//  - No emojis. Inline SVG.

const ONBOARDED_KEY = "srwk:onboarded";

function reducedMotion() {
  if (document.documentElement.dataset.reduceMotion === "1") return true;
  try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; }
  catch { return false; }
}

// ─── glyph geometry ──────────────────────────────────────────────────────
// One source of truth for the rotor glyph — used by the launch overlay,
// the titlebar mark, and the palette mark. The four dots that converge in
// the launch sequence have hardcoded positions that match the corner of
// each rotor square at scale 1; we don't need to recompute them.

const ROTOR_VIEWBOX = "0 0 24 24";
const ROTOR_DOTS = [
  { x: 4,  y: 4  },
  { x: 20, y: 4  },
  { x: 20, y: 20 },
  { x: 4,  y: 20 },
];

export function rotorSvg({ size = 18, withHover = false } = {}) {
  const cls = withHover ? "sig-rotor sig-rotor-hover" : "sig-rotor";
  return `
    <span class="${cls}" style="--sig-size:${size}px" aria-hidden="true">
      <svg viewBox="${ROTOR_VIEWBOX}" width="${size}" height="${size}">
        <g class="sig-rotor-g" transform-origin="12 12">
          <path d="M4 4 L20 4 L20 20 L4 20 Z"
                fill="none" stroke="currentColor" stroke-width="1.5"
                stroke-linejoin="round"/>
          <path d="M4 12 L12 4 L20 12 L12 20 Z"
                fill="none" stroke="currentColor" stroke-width="1.5"
                stroke-linejoin="round" opacity="0.5"/>
        </g>
      </svg>
    </span>
  `;
}

// ─── titlebar mark ───────────────────────────────────────────────────────
// Mount the rotor glyph as a leading element on every titlebar wordmark
// (`.mark`). Selector finds graph + network + search + metrics title-
// bars in one pass since they all share `.mark > .mark-name`.

export function mountTitlebarMark() {
  const groups = document.querySelectorAll(".mark, .net-header-mark, .search-header-mark, .metrics-header-mark");
  for (const g of groups) {
    if (g.querySelector(".sig-rotor")) continue;
    const wrap = document.createElement("span");
    wrap.className = "sig-mark-wrap";
    wrap.innerHTML = rotorSvg({ size: 14, withHover: true });
    // Insert as the first child so the layout reads "[glyph] SHAPE ROTATOR"
    g.insertBefore(wrap, g.firstChild);
  }
}

// ─── command palette mark ────────────────────────────────────────────────
// The palette is mounted on demand by ux.js. We watch for it in the DOM
// and swap the leading magnifier-svg with the rotor. A MutationObserver
// is the right tool: the palette is created and torn down every Cmd-K,
// and our hook runs once per mount.

export function mountPaletteMark() {
  // Replace immediately if already open.
  swapPaletteGlyph();
  const obs = new MutationObserver(() => {
    if (document.querySelector(".ux-cmd-modal .ux-cmd-glyph")) swapPaletteGlyph();
  });
  obs.observe(document.body, { childList: true, subtree: false });
}

function swapPaletteGlyph() {
  const target = document.querySelector(".ux-cmd-modal .ux-cmd-glyph");
  if (!target || target.dataset.sigPatched === "1") return;
  target.innerHTML = rotorSvg({ size: 14 });
  target.dataset.sigPatched = "1";
}

// ─── launch overlay ──────────────────────────────────────────────────────

export function mountLaunchOverlay() {
  const onboarded = localStorage.getItem(ONBOARDED_KEY) === "1";
  const reduced = reducedMotion();
  const overlay = document.createElement("div");
  overlay.className = "sig-launch";
  overlay.setAttribute("aria-hidden", "true");
  overlay.innerHTML = `
    <div class="sig-launch-stage">
      <svg class="sig-launch-svg" viewBox="-30 -30 60 60" width="160" height="160" aria-hidden="true">
        <g class="sig-launch-group">
          <circle class="sig-launch-dot sig-launch-dot-0" r="1.6"></circle>
          <circle class="sig-launch-dot sig-launch-dot-1" r="1.6"></circle>
          <circle class="sig-launch-dot sig-launch-dot-2" r="1.6"></circle>
          <circle class="sig-launch-dot sig-launch-dot-3" r="1.6"></circle>
          <g class="sig-launch-rotor" opacity="0">
            <path d="M-8 -8 L8 -8 L8 8 L-8 8 Z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
            <path d="M-8 0 L0 -8 L8 0 L0 8 Z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" opacity="0.55"/>
          </g>
        </g>
      </svg>
      <div class="sig-launch-word" data-text="SHAPE ROTATOR">
        <span class="sig-launch-word-inner">SHAPE ROTATOR</span>
      </div>
      <div class="sig-launch-sub">world knowledge</div>
    </div>
  `;
  document.body.appendChild(overlay);

  let torndown = false;
  // Single teardown path — fade overlay AND remove the global listener.
  // Earlier versions only faded the overlay (skip()) and left the keydown
  // listener leaked on `window`, which silently swallowed every Space /
  // Enter / Escape press across the whole app — typing into form inputs
  // would intermittently lose characters because preventDefault() ran
  // before the input could consume them.
  const skip = () => {
    if (torndown) return;
    torndown = true;
    window.removeEventListener("keydown", onKey);
    overlay.classList.add("sig-launch-leaving");
    const cleanup = () => {
      overlay.remove();
      try { localStorage.setItem(ONBOARDED_KEY, "1"); } catch {}
    };
    if (reduced) cleanup();
    else setTimeout(cleanup, 380);
  };

  // Reduced motion or already onboarded: snap to final pose, fade out
  // quick. We still show the wordmark briefly so the user gets a beat
  // of identity.
  if (reduced || onboarded) {
    overlay.classList.add("sig-launch-quick");
    requestAnimationFrame(() => overlay.classList.add("sig-launch-shown"));
    setTimeout(skip, onboarded ? 380 : 220);
  } else {
    requestAnimationFrame(() => overlay.classList.add("sig-launch-running"));
    setTimeout(skip, 1900);  // slightly past the final beat for a clean fade
  }

  // Skippable on Esc / pointerdown / Enter — the visualizer is a tool, not a
  // movie. Don't trap the user. Belt-and-braces: also bail when the user
  // is typing in a real input so a forgotten cleanup can never eat keys.
  const onKey = (e) => {
    const t = e.target;
    const tag = t?.tagName?.toUpperCase();
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t?.isContentEditable) return;
    if (e.key === "Escape" || e.key === "Enter" || e.key === " ") {
      e.preventDefault(); skip();
    }
  };
  const onPointer = () => skip();
  window.addEventListener("keydown", onKey, { once: false });
  overlay.addEventListener("pointerdown", onPointer, { once: true });
  return skip;
}

// Force a re-launch (Easter-egg / debug command). Resets the onboarded
// flag and re-mounts the overlay. Wired via the command palette as
// "replay launch animation."
export function replayLaunch() {
  try { localStorage.removeItem(ONBOARDED_KEY); } catch {}
  // Remove any stray overlay first
  for (const el of document.querySelectorAll(".sig-launch")) el.remove();
  mountLaunchOverlay();
}
