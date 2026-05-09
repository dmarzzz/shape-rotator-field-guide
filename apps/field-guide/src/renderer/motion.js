// motion primitives for the visualizer — spring physics, animated counters,
// view-transition tab morph, chart entrance, magnetic hover. Vanilla JS,
// zero deps. Honors prefers-reduced-motion via the same source-of-truth
// helper that ux.js uses (delegated to the data attribute on <html>).
//
// Why hand-roll this:
//  - Framer Motion / GSAP would dominate the bundle and the design
//    sensibility. The visualizer is small + opinionated. ~200 lines is enough.
//  - View Transitions API is shipping in Chromium 111+; Electron 33 is
//    fine. We feature-detect and fall back to instant.
//  - Spring constants tuned by feel against Sonner / Vaul references:
//    tension 170, friction 26 reads as "thrown but not bouncy."

import { isReducedMotion } from "./ux.js";

// ─── spring ──────────────────────────────────────────────────────────────
// Underdamped spring integrator. Calls `onTick(value)` until at-rest.
// Returns a { cancel } handle. `from/to` can be numbers; for vector use
// run two springs. Dead simple because we don't need much.
//
// Usage:
//   spring({ from: 0, to: 1, onTick: v => el.style.transform = `scale(${v})` });

export function spring(opts) {
  const {
    from = 0,
    to = 1,
    tension = 170,
    friction = 26,
    velocity = 0,
    precision = 0.001,
    onTick,
    onDone,
  } = opts || {};
  if (isReducedMotion()) {
    onTick?.(to);
    onDone?.();
    return { cancel() {} };
  }
  let value = from;
  let v = velocity;
  let raf = 0;
  let last = performance.now();
  let cancelled = false;
  function frame(now) {
    if (cancelled) return;
    const dt = Math.min((now - last) / 1000, 1 / 30); // clamp big jumps
    last = now;
    // F = -k(x - x0) - cV  →  a = (F)/m, m = 1
    const force = -tension * (value - to);
    const damping = -friction * v;
    const a = force + damping;
    v += a * dt;
    value += v * dt;
    onTick?.(value);
    if (Math.abs(v) < precision && Math.abs(value - to) < precision) {
      onTick?.(to);
      onDone?.();
      return;
    }
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);
  return {
    cancel() {
      cancelled = true;
      cancelAnimationFrame(raf);
    },
  };
}

// ─── animated number counter ─────────────────────────────────────────────
// Tween a numeric DOM cell from its previous value to the new one over
// ~280ms. Uses ease-out. Skips when the delta is huge or nonsensical
// (NaN, switching units like "—" → "1.2 GB"); in those cases we just
// snap to the new text. Tabular figures (set in CSS via .num utility)
// keep the digits perfectly aligned during the tween.
//
// Caller passes the formatter so units render correctly per stat.

const TICK_STATE = new WeakMap(); // el → { last: number, anim }

export function tickNumber(el, next, opts = {}) {
  if (!el) return;
  const { format = String, duration = 280 } = opts;
  const prev = TICK_STATE.get(el)?.last;
  if (typeof next !== "number" || !isFinite(next)) {
    el.textContent = format(next);
    TICK_STATE.set(el, { last: undefined });
    return;
  }
  // first paint: just set the value, don't tween
  if (typeof prev !== "number" || !isFinite(prev)) {
    el.textContent = format(next);
    TICK_STATE.set(el, { last: next });
    return;
  }
  if (prev === next) return;
  // cancel a running animation
  TICK_STATE.get(el)?.anim?.cancel?.();
  if (isReducedMotion()) {
    el.textContent = format(next);
    TICK_STATE.set(el, { last: next });
    return;
  }
  const start = performance.now();
  const ease = (t) => 1 - Math.pow(1 - t, 3); // ease-out cubic
  let raf = 0;
  let cancelled = false;
  function frame(now) {
    if (cancelled) return;
    const t = Math.min(1, (now - start) / duration);
    const v = prev + (next - prev) * ease(t);
    el.textContent = format(v);
    if (t >= 1) {
      el.textContent = format(next);
      TICK_STATE.set(el, { last: next });
      return;
    }
    raf = requestAnimationFrame(frame);
  }
  const anim = {
    cancel() {
      cancelled = true;
      cancelAnimationFrame(raf);
    },
  };
  TICK_STATE.set(el, { last: next, anim });
  raf = requestAnimationFrame(frame);
}

// ─── tab indicator morph ─────────────────────────────────────────────────
// One absolutely-positioned underline element (#tab-indicator) that slides
// + resizes between the active tab buttons. The previous View Transitions
// API approach cross-faded an old/new pair instead of paring them, which
// read as a fade rather than a morph. A single DOM node animated with
// CSS transitions gives the deterministic "underline slides between
// tabs" pattern (Linear / Arc / etc.) and is trivial to reason about.
//
// API:
//   morphActiveTab(tab, applyFn) — kept as the public name for callers
//     (boot.js). Calls applyFn (which mutates aria-selected), then in
//     the *next* frame measures the new active tab and slides the
//     #tab-indicator to it. Honors prefers-reduced-motion (instant).

export function morphActiveTab(tab, applyFn) {
  applyFn();
  // Defer one frame so applyFn's DOM mutation has taken effect (the new
  // active button has aria-selected="true") and the layout is settled
  // before we measure.
  requestAnimationFrame(() => updateTabIndicator());
}

// Move + size the #tab-indicator under the currently-active tab. Safe to
// call from anywhere — repaints, resizes, initial mount. If the
// indicator element isn't present (early boot) or there's no active tab,
// it's a no-op.
export function updateTabIndicator() {
  const bar = document.getElementById("tab-bar");
  if (!bar) return;
  const indicator = bar.querySelector("#tab-indicator");
  if (!indicator) return;
  const active = bar.querySelector('.tab-btn[aria-selected="true"]');
  if (!active) {
    indicator.dataset.mounted = "0";
    return;
  }
  const barRect = bar.getBoundingClientRect();
  const r = active.getBoundingClientRect();
  // Inset the underline a few px from the button edges so it sits under
  // the label (not the full button hit-area). Mirrors the previous
  // ::after which was inset 14px on each side; keep visual continuity.
  const inset = 14;
  const left = (r.left - barRect.left) + inset;
  const width = Math.max(0, r.width - inset * 2);
  indicator.style.transform = `translate3d(${left.toFixed(2)}px, 0, 0)`;
  indicator.style.width = `${width.toFixed(2)}px`;
  // First mount: fade-in the indicator on the next tick once it's
  // already at the correct position (avoids a slide from 0,0).
  if (indicator.dataset.mounted !== "1") {
    requestAnimationFrame(() => { indicator.dataset.mounted = "1"; });
  }
}

// Wire up the indicator: position it for the initial active tab, and
// keep it positioned correctly across window resizes. Call once after
// the tab-bar is in the DOM (boot.js wireTabs).
export function mountTabIndicator() {
  updateTabIndicator();
  const onResize = () => updateTabIndicator();
  window.addEventListener("resize", onResize);
  // Also listen for layout shifts that might affect the bar — fonts
  // loading is the common one (Geist Variable can re-flow tab widths).
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => updateTabIndicator()).catch(() => {});
  }
}

// ─── chart entrance ──────────────────────────────────────────────────────
// Reveals an SVG chart left-to-right via clip-path on first paint. Cheap,
// 60fps, works on any SVG (no axis-aware tween needed). 600ms ease-out.

export function revealOnce(el, opts = {}) {
  if (!el || el.dataset.revealed === "1") return;
  el.dataset.revealed = "1";
  if (isReducedMotion()) return;
  const { duration = 600, delay = 0 } = opts;
  el.style.clipPath = "inset(0 100% 0 0)";
  el.style.opacity = "1";
  el.style.willChange = "clip-path";
  // double-rAF so the initial clip is committed before the transition
  requestAnimationFrame(() => requestAnimationFrame(() => {
    el.style.transition = `clip-path ${duration}ms cubic-bezier(0.16, 1, 0.3, 1) ${delay}ms`;
    el.style.clipPath = "inset(0 0 0 0)";
    el.addEventListener("transitionend", () => {
      el.style.willChange = "";
      el.style.transition = "";
      el.style.clipPath = "";
    }, { once: true });
  }));
}

// ─── magnetic hover ──────────────────────────────────────────────────────
// Subtle cursor-relative pull. Inspired by Vercel/Arc — the element shifts
// up to ±strength px toward the cursor while the cursor is inside its
// bounding box. We avoid translate over rotation (a tilt feels gimmicky
// in a tool); pure 2D translation reads as "responsive to your hand."
//
// Returns a teardown fn; call it to unbind on element removal.

export function magnetize(el, opts = {}) {
  if (!el) return () => {};
  const { strength = 6, dampen = 0.45 } = opts;
  if (isReducedMotion()) return () => {};
  let raf = 0;
  let target = { x: 0, y: 0 };
  let current = { x: 0, y: 0 };
  let active = false;
  function loop() {
    current.x += (target.x - current.x) * dampen;
    current.y += (target.y - current.y) * dampen;
    el.style.transform = `translate3d(${current.x.toFixed(2)}px, ${current.y.toFixed(2)}px, 0)`;
    if (active || Math.abs(current.x - target.x) > 0.05 || Math.abs(current.y - target.y) > 0.05) {
      raf = requestAnimationFrame(loop);
    } else {
      el.style.transform = "";
      raf = 0;
    }
  }
  function onMove(e) {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const dx = e.clientX - cx;
    const dy = e.clientY - cy;
    // normalize by half-extent so a small button doesn't outpace a big one
    target.x = (dx / (r.width / 2)) * strength;
    target.y = (dy / (r.height / 2)) * strength;
    if (!raf) raf = requestAnimationFrame(loop);
  }
  function onEnter() { active = true; }
  function onLeave() {
    active = false;
    target.x = 0; target.y = 0;
    if (!raf) raf = requestAnimationFrame(loop);
  }
  el.addEventListener("pointerenter", onEnter);
  el.addEventListener("pointerleave", onLeave);
  el.addEventListener("pointermove", onMove);
  return () => {
    el.removeEventListener("pointerenter", onEnter);
    el.removeEventListener("pointerleave", onLeave);
    el.removeEventListener("pointermove", onMove);
    if (raf) cancelAnimationFrame(raf);
    el.style.transform = "";
  };
}

// ─── rotor loader ────────────────────────────────────────────────────────
// Replaces generic skeleton boxes with the visualizer's signature mark mid-
// rotation. A 16px square SVG that morphs through 4 corner-cut states,
// 380ms each, looped. We render it once and let CSS animate the inner
// path's d-attribute via a class swap — keyframes can't tween path d,
// but we can tween transform on a fixed shape, which is the actual move.
//
// Caller mounts via mountRotor(host) and unmount returns the host to its
// previous content. We also expose a class-only variant `rotorMarkup()`
// for callers that just need the inline HTML.

export function rotorMarkup({ size = 18, ariaLabel = "loading" } = {}) {
  return `
    <span class="rotor" role="status" aria-label="${ariaLabel}" style="--rotor-size:${size}px">
      <svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">
        <g class="rotor-shape" transform-origin="12 12">
          <path d="M4 4 L20 4 L20 20 L4 20 Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
          <path d="M4 12 L12 4 L20 12 L12 20 Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" opacity="0.55"/>
        </g>
      </svg>
    </span>
  `;
}
