// shape-canvas.js — WebGL2 renderer for the cohort shapes.
//
// Each visible shape gets its own <canvas> + WebGL2 context running a
// single shared fragment shader. The fragment shader draws a different
// signed-distance-field (SDF) per shape family and modulates colour by
// hash-of-record-id, so every team gets a unique-but-stable palette.
//
// Browsers cap active WebGL contexts (~16). To stay safe:
//   - mountShape returns a controller with .destroy() that loses the
//     context; alchemy.js calls this on every canvas re-render.
//   - We attach an IntersectionObserver per canvas that pauses the
//     animation loop when the shape scrolls offscreen. The context
//     stays alive (cheap), but rAF stops (saves GPU).
//
// API extension hooks (so we can add detail as the program evolves):
//   - opts.progress (0..1)        — drives shape complexity / inner detail
//   - opts.intensity (0..1)       — modulates glow + accent strength
//   - opts.rotationPhase (0..1)   — for mid-rotation morph between shapes
// Currently each defaults to a sane base; the shader already accepts the
// uniforms so future updates just need to pass them in.

const VERT_SRC = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 outColor;

uniform float u_time;
uniform float u_family;       // 0..5 — torus | scaffold | hex | prism | meridian | plate
uniform float u_hue;          // 0..1 — primary hue, hash-derived
uniform float u_hue2;         // 0..1 — accent hue, hash-derived
uniform float u_phase;        // 0..1 — per-team animation offset
uniform float u_progress;     // 0..1 — reserved for "how far into the cohort" detail
uniform float u_intensity;    // 0..1 — reserved for "live activity" pulse strength
uniform float u_rotationPhase;// 0..1 — reserved for inter-shape morph
uniform float u_aspect;

// --- HSL → RGB ----------------------------------------------------------
vec3 hue2rgb(float h, float s, float l) {
  vec3 k = mod(vec3(0.0, 8.0, 4.0) + h * 12.0, 12.0);
  vec3 a = vec3(s) * min(vec3(l), vec3(1.0 - l));
  return l - a * clamp(min(min(k - 3.0, 9.0 - k), vec3(1.0)), -1.0, 1.0);
}

// --- 2D rotation --------------------------------------------------------
vec2 rot2(vec2 p, float a) {
  float s = sin(a), c = cos(a);
  return mat2(c, -s, s, c) * p;
}

// --- Signed distance functions (negative inside) ------------------------
float sdCircle(vec2 p, float r) { return length(p) - r; }
float sdRing(vec2 p, float r, float t) { return abs(length(p) - r) - t; }
float sdBox(vec2 p, vec2 b) {
  vec2 d = abs(p) - b;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}
float sdHex(vec2 p, float r) {
  // SDF for a regular hexagon (point-up), radius = circumradius
  const vec3 k = vec3(-0.866025404, 0.5, 0.577350269);
  p = abs(p);
  p -= 2.0 * min(dot(k.xy, p), 0.0) * k.xy;
  p -= vec2(clamp(p.x, -k.z * r, k.z * r), r);
  return length(p) * sign(p.y);
}
float sdEqTri(vec2 p, float r) {
  const float k = 1.7320508; // sqrt(3)
  p.x = abs(p.x) - r;
  p.y = p.y + r / k;
  if (p.x + k * p.y > 0.0) p = vec2(p.x - k * p.y, -k * p.x - p.y) / 2.0;
  p.x -= clamp(p.x, -2.0 * r, 0.0);
  return -length(p) * sign(p.y);
}
float sdRhombus(vec2 p, vec2 b) {
  p = abs(p);
  float h = clamp((-2.0 * (p.x * b.x - p.y * b.y) + b.x * b.x - b.y * b.y) / dot(b, b), -1.0, 1.0);
  float d = length(p - 0.5 * b * vec2(1.0 - h, 1.0 + h));
  return d * sign(p.x * b.y + p.y * b.x - b.x * b.y);
}

// Combine: each family returns (outerSDF, accentSDF) packed into vec2.
vec2 shapeSDF(int fam, vec2 p) {
  if (fam == 0) {
    // TORUS — concentric ring + inner dot
    return vec2(sdRing(p, 0.55, 0.06), sdCircle(p, 0.16));
  } else if (fam == 1) {
    // SCAFFOLD — square + radiating cross + inner dot
    float box  = sdBox(p, vec2(0.45));
    float cx   = min(sdBox(p, vec2(0.65, 0.025)), sdBox(p, vec2(0.025, 0.65)));
    float outer = min(box, cx);
    return vec2(outer, sdCircle(p, 0.10));
  } else if (fam == 2) {
    // HEX — hexagon outline + inner dot
    return vec2(sdHex(p, 0.55), sdCircle(p, 0.13));
  } else if (fam == 3) {
    // PRISM — three nested triangles
    float outer = sdEqTri(p, 0.55);
    float inner = sdEqTri(p, 0.22);
    return vec2(outer, inner);
  } else if (fam == 4) {
    // MERIDIAN — top arc + bottom arc, like a horizon
    float top    = max(sdCircle(p - vec2(0.0,  0.10), 0.55), -p.y);
    float bottom = max(sdCircle(p - vec2(0.0,  0.18), 0.42),  p.y - 0.05);
    return vec2(min(top, bottom), sdCircle(p - vec2(0.0, -0.04), 0.11));
  } else {
    // PLATE — rotated rhombus (square at 45°), nested
    return vec2(sdRhombus(p, vec2(0.55, 0.55)), sdRhombus(p, vec2(0.18, 0.18)));
  }
}

void main() {
  vec2 uv = v_uv * 2.0 - 1.0;
  uv.x *= u_aspect;

  // Slow, hash-offset rotation so every team's shape moves to its own beat.
  float t = u_time + u_phase * 6.2831;
  vec2 p = rot2(uv, t * 0.06);

  int fam = int(u_family + 0.5);
  vec2 sdf = shapeSDF(fam, p);
  float outer  = sdf.x;
  float accent = sdf.y;

  // Anti-aliased fills via fwidth() smoothstep.
  float aa = fwidth(outer) * 1.5;
  // Outline: shade a band at outer ≈ 0
  float outlineWidth = 0.012 + 0.006 * sin(t * 0.7) * u_intensity;
  float outline = smoothstep(outlineWidth + aa, outlineWidth, abs(outer));
  // Inside fill: outer < 0
  float fill = smoothstep(aa, -aa, outer);
  // Accent (inner shape) fill
  float accentFill = smoothstep(aa, -aa, accent);

  // Hash-derived palette: paper-warm interior with a hue-tinted glow.
  vec3 paper   = vec3(0.946, 0.926, 0.879);
  vec3 ink     = vec3(0.075, 0.063, 0.039);
  vec3 primary = hue2rgb(u_hue,  0.62, 0.46);
  vec3 accentC = hue2rgb(u_hue2, 0.78, 0.55);

  // Inside the shape, mix paper → primary based on radial gradient.
  float r = length(p);
  float radial = 1.0 - smoothstep(0.0, 0.7, r);
  vec3 interior = mix(paper, primary, radial * 0.55 + 0.10);

  // Soft outer halo: extends past the boundary, fades out.
  float halo = exp(-max(outer, 0.0) * 12.0) * (0.45 + 0.35 * sin(t * 1.1 + u_phase * 9.4) * u_intensity);

  // Compose layers back-to-front.
  vec3 col = paper;                                // background = paper colour
  col = mix(col, primary * 0.85, halo * 0.55);     // outer halo
  col = mix(col, interior, fill);                  // shape interior
  col = mix(col, accentC * 0.90, accentFill * 0.85); // accent overlay
  col = mix(col, ink, outline);                    // outline

  // Subtle film grain so the surface doesn't feel sterile against paper.
  float grain = (fract(sin(dot(uv, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) * 0.025;
  col += grain;

  outColor = vec4(col, 1.0);
}`;

// ── shared GL program (per <canvas> we still need a fresh context, but
// the shader source is reused so compile cost is amortised by the GPU).

function compileShader(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`shape-ui shader compile failed: ${log}`);
  }
  return sh;
}

function buildProgram(gl) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, VERT_SRC);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error(`shape-ui program link failed: ${log}`);
  }
  // Fullscreen quad (two triangles).
  const verts = new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "a_pos");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  return {
    prog,
    uniforms: {
      time:          gl.getUniformLocation(prog, "u_time"),
      family:        gl.getUniformLocation(prog, "u_family"),
      hue:           gl.getUniformLocation(prog, "u_hue"),
      hue2:          gl.getUniformLocation(prog, "u_hue2"),
      phase:         gl.getUniformLocation(prog, "u_phase"),
      progress:      gl.getUniformLocation(prog, "u_progress"),
      intensity:     gl.getUniformLocation(prog, "u_intensity"),
      rotationPhase: gl.getUniformLocation(prog, "u_rotationPhase"),
      aspect:        gl.getUniformLocation(prog, "u_aspect"),
    },
  };
}

// ── hash helpers ────────────────────────────────────────────────────────
// FNV-1a over the record_id (or any string). Returns three numbers in
// [0,1) — primary hue, accent hue, animation phase — so two teams with
// different ids get visually distinct shapes deterministically.
export function hashColors(seed) {
  let h = 2166136261 >>> 0;
  const s = String(seed || "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  // Pull three independent 8-bit slices.
  const a =  h         & 0xff;
  const b = (h >>> 8)  & 0xff;
  const c = (h >>> 16) & 0xff;
  return {
    hue:   a / 255,
    hue2: (a / 255 + 0.33 + (b / 255) * 0.34) % 1, // analogous-to-complementary offset
    phase: c / 255,
  };
}

// ── public mount API ────────────────────────────────────────────────────
// canvas: an HTMLCanvasElement already in the DOM.
// opts.family:  0..5
// opts.seed:    string (e.g. record_id) — drives colour + phase
// opts.size:    optional CSS px (square); defaults to canvas.clientWidth
// opts.progress / .intensity / .rotationPhase: optional 0..1 reserved
// returns { destroy(), update(opts), pause(), resume() }
export function mountShape(canvas, opts = {}) {
  const gl = canvas.getContext("webgl2", { antialias: true, alpha: false, premultipliedAlpha: false });
  if (!gl) {
    return { destroy() {}, update() {}, pause() {}, resume() {} };
  }
  let prog;
  try { prog = buildProgram(gl); }
  catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[shape-ui]", e.message);
    return { destroy() {}, update() {}, pause() {}, resume() {} };
  }

  const colors = hashColors(opts.seed);
  let family        = Number(opts.family) || 0;
  let progress      = opts.progress      != null ? +opts.progress      : 0.25;
  let intensity     = opts.intensity     != null ? +opts.intensity     : 0.6;
  let rotationPhase = opts.rotationPhase != null ? +opts.rotationPhase : 0;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  function resize() {
    const cssW = canvas.clientWidth  || 120;
    const cssH = canvas.clientHeight || 120;
    canvas.width  = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));
    gl.viewport(0, 0, canvas.width, canvas.height);
  }
  resize();
  const ro = (typeof ResizeObserver !== "undefined") ? new ResizeObserver(resize) : null;
  if (ro) ro.observe(canvas);

  let raf = 0;
  let running = true;
  let started = performance.now();
  function frame(now) {
    if (!running) { raf = 0; return; }
    const t = (now - started) / 1000;
    gl.useProgram(prog.prog);
    gl.uniform1f(prog.uniforms.time, t);
    gl.uniform1f(prog.uniforms.family, family);
    gl.uniform1f(prog.uniforms.hue, colors.hue);
    gl.uniform1f(prog.uniforms.hue2, colors.hue2);
    gl.uniform1f(prog.uniforms.phase, colors.phase);
    gl.uniform1f(prog.uniforms.progress, progress);
    gl.uniform1f(prog.uniforms.intensity, intensity);
    gl.uniform1f(prog.uniforms.rotationPhase, rotationPhase);
    gl.uniform1f(prog.uniforms.aspect, canvas.width / canvas.height);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    raf = requestAnimationFrame(frame);
  }
  function pause() { if (!running) return; running = false; if (raf) cancelAnimationFrame(raf); raf = 0; }
  function resume() { if (running) return; running = true; started = performance.now(); raf = requestAnimationFrame(frame); }

  // Pause when the canvas isn't visible to keep the GPU calm.
  let io = null;
  if (typeof IntersectionObserver !== "undefined") {
    io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) resume();
        else pause();
      }
    });
    io.observe(canvas);
  }

  raf = requestAnimationFrame(frame);

  return {
    destroy() {
      pause();
      if (ro) try { ro.disconnect(); } catch {}
      if (io) try { io.disconnect(); } catch {}
      // Free the WebGL context proactively so we don't bump the per-page cap.
      const lose = gl.getExtension("WEBGL_lose_context");
      if (lose) try { lose.loseContext(); } catch {}
    },
    update(next = {}) {
      if (next.family       != null) family        = Number(next.family) || 0;
      if (next.progress     != null) progress      = +next.progress;
      if (next.intensity    != null) intensity     = +next.intensity;
      if (next.rotationPhase != null) rotationPhase = +next.rotationPhase;
    },
    pause,
    resume,
  };
}

// ── shared overlay (one GL context, N shapes) ───────────────────────────
// Browsers cap us to ~16 active WebGL contexts; with 14 cards in the
// shapes grid + the detail-page hero + any other live GL context (the
// 3d-force-graph view, the atlas lens, etc.) we blow past it. Instead
// of one context per shape, we mount ONE overlay canvas inside the
// alchemy host and draw every visible shape from it.
//
// Each shape stays in the DOM as a `<canvas data-shape-fam>` placeholder
// (no GL context — just a layout anchor). Every frame, the overlay reads
// each placeholder's bounding rect and renders the shader into that
// rect via gl.viewport + gl.scissor, so per-card positioning + sizing
// come "for free" from the existing CSS layout.
//
// Returns a single controller — alchemy.js destroys it on every render
// before remounting so the GL state matches the new DOM.
export function mountShapesIn(container) {
  if (!container) return [];
  // Find or create the overlay canvas. Single one per container.
  let overlay = container.querySelector(":scope > canvas.alch-shape-overlay");
  if (!overlay) {
    overlay = document.createElement("canvas");
    overlay.className = "alch-shape-overlay";
    overlay.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:1;";
    // Container needs to be positioned for the overlay's inset:0 to anchor.
    const cs = getComputedStyle(container);
    if (cs.position === "static") container.style.position = "relative";
    container.appendChild(overlay);
  }
  const ctrl = mountSharedOverlay(overlay, container);
  return [ctrl];
}

function mountSharedOverlay(overlay, host) {
  const gl = overlay.getContext("webgl2", { antialias: true, alpha: true, premultipliedAlpha: false });
  if (!gl) return { destroy() {} };
  let prog;
  try { prog = buildProgram(gl); }
  catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[shape-ui]", e.message);
    return { destroy() {} };
  }
  gl.enable(gl.SCISSOR_TEST);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.clearColor(0, 0, 0, 0);

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  function resize() {
    const cssW = overlay.clientWidth  || host.clientWidth  || 1;
    const cssH = overlay.clientHeight || host.clientHeight || 1;
    overlay.width  = Math.max(1, Math.round(cssW * dpr));
    overlay.height = Math.max(1, Math.round(cssH * dpr));
  }
  resize();
  const ro = (typeof ResizeObserver !== "undefined") ? new ResizeObserver(resize) : null;
  if (ro) { ro.observe(overlay); ro.observe(host); }

  // Cache placeholder lookups; rebuild on every frame is fine for up to
  // a few dozen shapes but we only need to query the DOM when it changes.
  let placeholders = [];
  function refreshPlaceholders() {
    placeholders = Array.from(host.querySelectorAll("canvas[data-shape-fam]"))
      .filter(p => p !== overlay)
      .map(p => ({
        el: p,
        family: Number(p.dataset.shapeFam) || 0,
        colors: hashColors(p.dataset.shapeSeed || ""),
      }));
  }
  refreshPlaceholders();
  // Watch for placeholder additions/removals (rendering re-runs in the
  // host container during mode switches).
  const mo = (typeof MutationObserver !== "undefined") ? new MutationObserver(refreshPlaceholders) : null;
  if (mo) mo.observe(host, { childList: true, subtree: true });

  let raf = 0;
  let running = true;
  let started = performance.now();
  function frame(now) {
    if (!running) { raf = 0; return; }
    const t = (now - started) / 1000;
    // Clear once at full canvas extent.
    gl.viewport(0, 0, overlay.width, overlay.height);
    gl.scissor(0, 0, overlay.width, overlay.height);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const overlayRect = overlay.getBoundingClientRect();
    gl.useProgram(prog.prog);

    for (const p of placeholders) {
      // Skip if placeholder is detached from DOM.
      if (!p.el.isConnected) continue;
      const r = p.el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      // Convert CSS rect → GL pixel rect inside the overlay (origin
      // bottom-left in GL, top-left in CSS — flip Y).
      const x  = Math.round((r.left - overlayRect.left) * dpr);
      const yT = Math.round((r.top  - overlayRect.top)  * dpr);
      const w  = Math.max(1, Math.round(r.width  * dpr));
      const h  = Math.max(1, Math.round(r.height * dpr));
      const yB = overlay.height - yT - h;
      // Cull viewports that fall fully outside the overlay.
      if (x + w < 0 || yB + h < 0 || x >= overlay.width || yB >= overlay.height) continue;
      gl.viewport(x, yB, w, h);
      gl.scissor(x, yB, w, h);
      gl.uniform1f(prog.uniforms.time, t);
      gl.uniform1f(prog.uniforms.family, p.family);
      gl.uniform1f(prog.uniforms.hue, p.colors.hue);
      gl.uniform1f(prog.uniforms.hue2, p.colors.hue2);
      gl.uniform1f(prog.uniforms.phase, p.colors.phase);
      gl.uniform1f(prog.uniforms.progress, 0.25);
      gl.uniform1f(prog.uniforms.intensity, 0.6);
      gl.uniform1f(prog.uniforms.rotationPhase, 0);
      gl.uniform1f(prog.uniforms.aspect, w / h);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    raf = requestAnimationFrame(frame);
  }
  function pause() { if (!running) return; running = false; if (raf) cancelAnimationFrame(raf); raf = 0; }
  function resume() { if (running) return; running = true; started = performance.now(); raf = requestAnimationFrame(frame); }

  // Pause when the host scrolls offscreen (cheap save when user is on
  // a different tab inside the same Electron window).
  let io = null;
  if (typeof IntersectionObserver !== "undefined") {
    io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) resume();
        else pause();
      }
    });
    io.observe(host);
  }

  raf = requestAnimationFrame(frame);

  return {
    destroy() {
      pause();
      if (ro) try { ro.disconnect(); } catch {}
      if (mo) try { mo.disconnect(); } catch {}
      if (io) try { io.disconnect(); } catch {}
      const lose = gl.getExtension("WEBGL_lose_context");
      if (lose) try { lose.loseContext(); } catch {}
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    },
    pause,
    resume,
  };
}
