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
uniform float u_kind;         // 0=team (full) | 1=project (stitched rim, hollow) | 2=person (medallion)
uniform float u_hue;          // 0..1 — primary hue, hash-derived
uniform float u_hue2;         // 0..1 — accent hue, hash-derived
uniform float u_phase;        // 0..1 — per-team animation + composition offset
uniform float u_progress;     // 0..1 — reserved for "how far into the cohort" detail
uniform float u_intensity;    // 0..1 — reserved for "live activity" pulse strength
uniform float u_rotationPhase;// 0..1 — reserved for inter-shape morph
uniform float u_aspect;

// ── 2D rotation ─────────────────────────────────────────────────────────
vec2 rot2(vec2 p, float a) {
  float s = sin(a), c = cos(a);
  return mat2(c, -s, s, c) * p;
}

// ── iquilezles cosine palette — tuned to a full-saturation rainbow
// (R/G/B phases shifted by 1/3 each), so the inner fractal cycles
// through the entire spectrum as t advances rather than oscillating
// between two muted complements.
// https://iquilezles.org/articles/palettes/
vec3 iqPal(float t) {
  vec3 a = vec3(0.5);
  vec3 b = vec3(0.5);
  vec3 c = vec3(1.0);
  vec3 d = vec3(0.00, 0.33, 0.67);     // ← full rainbow phase
  return a + b * cos(6.28318 * (c * t + d));
}
// Direct hue → RGB via the same cosine palette, used for the iridescent
// rim + the rainbow central glow so every "alive" element drifts through
// the same coherent spectrum.
vec3 rainbow(float h) {
  vec3 a = vec3(0.5);
  vec3 b = vec3(0.5);
  vec3 c = vec3(1.0);
  vec3 d = vec3(0.00, 0.33, 0.67);
  return a + b * cos(6.28318 * (c * h + d));
}

// ── Kandinsky palette — bold primaries we hash-pick 3 from per team.
//    Crimson · Azure · Mustard · Burnt Orange · Deep Green · Ink · Bg
//    K_BG is the canvas backdrop; flipped to deep black so the shapes
//    integrate with the editorial dark UI surrounding them.
const vec3 K_CRIMSON = vec3(0.92, 0.18, 0.18);
const vec3 K_AZURE   = vec3(0.20, 0.42, 0.95);
const vec3 K_MUSTARD = vec3(1.00, 0.82, 0.12);
const vec3 K_BURNT   = vec3(1.00, 0.55, 0.15);
const vec3 K_GREEN   = vec3(0.28, 0.85, 0.55);
const vec3 K_INK     = vec3(0.04, 0.04, 0.05);
const vec3 K_PAPER   = vec3(0.040, 0.040, 0.045);  /* near-black canvas */
vec3 kandinsky(float t) {
  float h = fract(t);
  if (h < 0.166) return K_CRIMSON;
  if (h < 0.333) return K_AZURE;
  if (h < 0.500) return K_MUSTARD;
  if (h < 0.666) return K_BURNT;
  if (h < 0.833) return K_GREEN;
  return K_INK;
}

// ── SDFs (negative inside) ──────────────────────────────────────────────
float sdCircle(vec2 p, float r) { return length(p) - r; }
float sdRing(vec2 p, float r, float t) { return abs(length(p) - r) - t; }
float sdBox(vec2 p, vec2 b) {
  vec2 d = abs(p) - b;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}
float sdHex(vec2 p, float r) {
  const vec3 k = vec3(-0.866025404, 0.5, 0.577350269);
  p = abs(p);
  p -= 2.0 * min(dot(k.xy, p), 0.0) * k.xy;
  p -= vec2(clamp(p.x, -k.z * r, k.z * r), r);
  return length(p) * sign(p.y);
}
float sdEqTri(vec2 p, float r) {
  const float k = 1.7320508;
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
float sdSegment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}

// Outer silhouette per shape family — this is the big shape that holds
// the composition; every other layer is masked to its interior.
float silhouette(int fam, vec2 p) {
  if (fam == 0) return sdCircle(p, 0.62);                    // TORUS — disc
  if (fam == 1) return sdBox(p, vec2(0.55));                 // SCAFFOLD — square
  if (fam == 2) return sdHex(p, 0.62);                       // HEX
  if (fam == 3) return sdEqTri(p, 0.66);                     // PRISM — triangle
  if (fam == 4) {                                            // MERIDIAN — half-disc
    return max(sdCircle(p, 0.62), -p.y - 0.0);
  }
  return sdRhombus(p, vec2(0.62, 0.62));                     // PLATE — diamond
}

// Pseudo-random helpers (cheap fract-of-sin) for hash-positioned accents.
float h11(float n) { return fract(sin(n * 12.9898) * 43758.5453); }
vec2  h21(float n) { return vec2(h11(n), h11(n + 17.13)); }

// ── Per-family motion signature — strategy #3 from research. Each
// family has its own kinematic so motion ALONE differentiates at
// thumbnail size: TORUS spins continuously, HEX is still, PRISM
// wobbles, PLATE snaps in 90° beats, SCAFFOLD sits with rotating
// inner cross, MERIDIAN swings like a pendulum.
float familyRotation(int fam, float t) {
  if (fam == 0) return t * 0.10;                      // TORUS — continuous spin
  if (fam == 1) return 0.0;                           // SCAFFOLD — static
  if (fam == 2) return 0.0;                           // HEX — static
  if (fam == 3) return sin(t * 0.6) * 0.18;           // PRISM — wobble
  if (fam == 4) return sin(t * 0.7) * 0.32;           // MERIDIAN — pendulum
  return floor(t * 0.5) * 1.5707963;                  // PLATE — snap 90° every 2s
}

// ── Per-family rim symmetry — strategy #1. Rim hue is quantized into
// N segments matching the silhouette's rotational order; the rim
// itself becomes a counting cue so a hex reads "6" and a prism reads
// "3" at any size. TORUS stays continuous (rotational symmetry = ∞).
float symmetryN(int fam) {
  if (fam == 0) return 0.0;     // continuous
  if (fam == 1) return 4.0;     // SCAFFOLD — 4 cardinal arms
  if (fam == 2) return 6.0;     // HEX
  if (fam == 3) return 3.0;     // PRISM
  if (fam == 4) return 1.0;     // MERIDIAN — diameter axis only
  return 4.0;                    // PLATE — rotated square
}

// ── Per-family specimen mark — strategy #2. A small diagnostic glyph
// at centre that the eye locks onto first. Field-guide tradition:
// every plate has a key symbol. Returns SDF of the inner mark
// (negative inside).
float specimenSDF(int fam, vec2 p) {
  if (fam == 0) {
    // TORUS — concentric ring at radius 0.18, thickness 0.018
    return abs(length(p) - 0.18) - 0.018;
  }
  if (fam == 1) {
    // SCAFFOLD — small filled square 0.10
    return sdBox(p, vec2(0.10));
  }
  if (fam == 2) {
    // HEX — single dot in centre
    return length(p) - 0.10;
  }
  if (fam == 3) {
    // PRISM — three nested triangles à la LeWitt
    float a = sdEqTri(p, 0.22);
    float b = sdEqTri(p, 0.14);
    float c = sdEqTri(p, 0.07);
    return min(min(abs(a) - 0.012, abs(b) - 0.010), abs(c) - 0.008);
  }
  if (fam == 4) {
    // MERIDIAN — horizontal bar along the diameter
    return sdBox(p, vec2(0.32, 0.012));
  }
  // PLATE — quincunx (4 corner dots + 1 centre)
  float d = length(p) - 0.040;
  d = min(d, length(p - vec2( 0.18,  0.18)) - 0.030);
  d = min(d, length(p - vec2(-0.18,  0.18)) - 0.030);
  d = min(d, length(p - vec2( 0.18, -0.18)) - 0.030);
  d = min(d, length(p - vec2(-0.18, -0.18)) - 0.030);
  return d;
}

void main() {
  vec2 uv = v_uv * 2.0 - 1.0;
  uv.x *= u_aspect;

  // Per-team beat + per-family motion.
  float t = u_time + u_phase * 6.2831;
  int fam  = int(u_family + 0.5);
  int kind = int(u_kind + 0.5);                       // 0=team 1=project 2=person
  vec2 p = rot2(uv, familyRotation(fam, t));          // family-specific kinematic

  // Per-kind silhouette swap: PERSON renders as a circle medallion
  // regardless of the family — people don't have a shape vocabulary,
  // they're individuals. TEAM + PROJECT both use the team-shape family.
  float silh;
  if (kind == 2) {
    silh = length(p) - 0.55;                          // PERSON — circle medallion
  } else {
    silh = silhouette(fam, p);                        // TEAM / PROJECT — full family
  }
  float aa   = fwidth(silh) * 1.5;
  float inside = smoothstep(aa, -aa, silh);           // 1 inside, 0 outside

  // Backdrop: deep canvas that fills the WHOLE card area. Subtle warm
  // radial vignette toward the centre so each shape feels lit from
  // within — reads as a glowing specimen against the editorial dark UI.
  float vign = 1.0 - smoothstep(0.4, 1.4, length(uv));
  vec3 col = K_PAPER + vec3(0.012, 0.010, 0.020) * vign;

  // ── kishimisu fractal interior (only contributes inside the silhouette)
  // Iterative space-fold using the canonical fract(uv*1.5)-0.5 + bright
  // peak trick: pow(0.01/d, 1.2) — gives the signature glowing rings.
  // Palette base advances faster + each iteration adds more hue offset
  // so the rings visibly walk through the spectrum instead of staying
  // in one colour family.
  vec2 fp = p * 1.6;
  vec2 fp0 = fp;
  vec3 frac = vec3(0.0);
  float palBase = u_hue + t * 0.18;        // ← faster colour drift
  for (int i = 0; i < 4; i++) {
    fp = fract(fp * 1.5) - 0.5;
    float d = length(fp) * exp(-length(fp0));
    vec3  c = iqPal(length(fp0) * 1.2 + float(i) * 0.55 + palBase);
    d = abs(sin(d * 8.0 + t * 1.6) / 8.0);
    d = pow(0.01 / d, 1.2);
    frac += c * d;
  }
  // Stronger contribution — was 0.55, now reads as the dominant inner
  // texture instead of background noise.
  frac *= 0.95;

  // ── Kandinsky accents: 3 hash-picked geometric primitives at hash-
  // picked positions inside the silhouette. Each is a coloured stroke
  // or fill with a thin ink outline so it reads like a hand placement.
  vec3 acc = vec3(0.0);
  float accMask = 0.0;
  for (int i = 0; i < 3; i++) {
    float seed = u_phase * 100.0 + float(i) * 7.31;
    vec2  pos  = (h21(seed) * 2.0 - 1.0) * 0.32;
    float kind = h11(seed + 3.7);
    float spin = (h11(seed + 9.1) - 0.5) * 6.28;
    vec2  q    = rot2(p - pos, spin);
    vec3  kc   = kandinsky(h11(seed + 1.1) + u_hue2 * 0.2);

    float d;
    float fill = 0.0;
    float stroke = 0.0;
    if (kind < 0.34) {
      // small ring
      float r = 0.10 + 0.06 * h11(seed + 4.4);
      d = abs(length(q) - r);
      fill   = smoothstep(0.020 + aa, 0.013, d);
      stroke = smoothstep(0.005 + aa, 0.001, d);
    } else if (kind < 0.67) {
      // line stroke
      vec2 a = vec2(-0.16, 0.0);
      vec2 b = vec2( 0.16, 0.0);
      d = sdSegment(q, a, b);
      fill   = smoothstep(0.015 + aa, 0.009, d);
      stroke = smoothstep(0.003 + aa, 0.0,   d);
    } else {
      // small solid dot
      d = length(q);
      fill   = smoothstep(0.062 + aa, 0.054, d);
      stroke = 0.0;
    }
    acc      = mix(acc, kc, fill);
    acc      = mix(acc, K_INK, stroke);
    accMask  = max(accMask, fill);
  }

  // ── Iridescent rim — a thick rainbow band hugging the silhouette
  // boundary, hue cycling around the perimeter (atan2 angle) AND with
  // time. PER-FAMILY SYMMETRY QUANTIZATION: the rim hue is stepped
  // into N segments matching the silhouette's rotational order so the
  // rim itself becomes a counting cue (HEX→6, PRISM→3, PLATE→4, etc).
  // TORUS keeps continuous (N=0).
  // Per-kind rim width: PERSON gets a thicker portrait frame.
  float rimW   = (kind == 2) ? 0.105 : 0.075;
  float rimD   = abs(silh);
  float rim    = smoothstep(rimW + aa, 0.0, rimD);
  float ang    = atan(p.y, p.x);                          // -π..π
  float aNorm  = ang / 6.28318 + t * 0.18 + u_phase;      // continuous rim
  float N      = symmetryN(fam);
  float aQuant = (N > 0.5) ? floor(aNorm * N) / N : aNorm;
  vec3  rimC   = rainbow(aQuant);
  // PROJECT rim is STITCHED — 24 evenly-spaced gaps so it reads as
  // dashed/blueprint. PERSON rim is solid + slightly muted (medallion).
  // TEAM rim is solid full strength.
  float rimAlpha = rim;
  if (kind == 1) {
    float stitch = step(0.55, fract(ang / 6.28318 * 24.0));
    rimAlpha *= stitch;
  } else if (kind == 2) {
    rimAlpha *= 0.85;
  }

  // ── Specimen mark — per-family diagnostic glyph at centre. Renders
  // as a thin bright band at the SDF zero, tinted from the rainbow
  // palette so it integrates with the rest of the composition.
  float specD = specimenSDF(fam, p);
  float specBand = smoothstep(0.012 + aa, 0.0, abs(specD));
  vec3  specC = rainbow(u_hue + t * 0.4 + u_phase + 0.5);

  // ── Sparkles — small twinkling dots that pop on different rhythms
  // per card. Positions are hash-fixed inside the silhouette, brightness
  // pulses with sin(time*…) so they feel alive without being chaotic.
  float spark = 0.0;
  vec3  sparkC = vec3(0.0);
  for (int i = 0; i < 5; i++) {
    float seed = u_phase * 73.0 + float(i) * 11.91;
    vec2  pos  = (h21(seed) * 2.0 - 1.0) * 0.42;
    float d    = length(p - pos);
    float pulse = 0.55 + 0.45 * sin(t * (1.4 + h11(seed + 5.0)) + h11(seed) * 6.28);
    float s    = pulse * (0.0035 / (d * d + 0.0035));     // tiny bright peak
    spark  += s;
    sparkC += rainbow(h11(seed + 9.0) + t * 0.4) * s;
  }
  // Normalize so sparks contribute as a tinted bright add, not white.
  sparkC = (spark > 0.0001) ? sparkC / spark : vec3(0.0);

  // ── Bright central glow — the .1/abs(sin) trick, tinted from the
  // rainbow palette so the centre also cycles through the spectrum
  // instead of holding a single hue.
  float peak  = 0.04 / (abs(length(p) - 0.06) + 0.04);
  vec3  peakC = rainbow(u_hue + t * 0.25 + u_phase);

  // No ink outline on dark — the deep canvas + rainbow rim do the
  // boundary work without a hard stroke that screamed "paper diagram".

  // Compose the inside-the-silhouette layers — turned up across the
  // board because the dark background absorbs more than paper did.
  // The per-family specimen mark goes between accents and rim so it
  // reads above hash-noise but never competes with the rim itself.
  vec3 interior = K_PAPER;
  interior += frac * 1.10;                          // fractal — louder
  interior  = mix(interior, peakC, peak * 0.55);    // rainbow centre glow
  interior += sparkC * spark * 1.10;                // sparkles
  interior  = mix(interior, acc, accMask);          // hash-placed accents
  interior  = mix(interior, specC, specBand * 0.95);// per-family specimen mark
  interior  = mix(interior, rimC, rimAlpha);        // iridescent rim band

  // Paint the interior only where the silhouette is.
  col = mix(col, interior, inside);

  // Outer halo — same rim hue, soft falloff, so the shape feels lit
  // and not cut out of the dark background.
  float halo = exp(-max(silh, 0.0) * 14.0) * 0.50;
  col += rimC * halo;

  // Subtle film grain so the dark canvas doesn't read as flat digital.
  float grain = fract(sin(dot(uv, vec2(12.9898, 78.233))) * 43758.5453);
  col += (grain - 0.5) * 0.018;

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
      kind:          gl.getUniformLocation(prog, "u_kind"),
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
// Browsers cap us to ~16 active WebGL contexts. We mount ONE canvas
// at position:fixed covering the full viewport, and draw every visible
// shape into that single context via gl.viewport + gl.scissor. Each
// per-card `<canvas data-shape-fam>` is a no-context layout placeholder.
//
// position:fixed (rather than absolute inside the alchemy host) is
// deliberate: the host scrolls internally, so an absolute-positioned
// overlay would scroll WITH the content and only cover the first
// viewport-height of scroll — anything past row 1 would be clipped.
// Fixed-positioning sidesteps that entirely; getBoundingClientRect
// gives viewport-relative coords on every frame, which is exactly
// what the fixed overlay's coordinate system uses.
//
// The overlay element only paints inside each placeholder's rect
// (via scissor); the rest of the canvas is transparent + has
// pointer-events:none so it's invisible over UI chrome. The overlay
// is auto-hidden on non-alchemy tabs via the `.alchemy-only` class
// (relies on the existing tab visibility CSS in styles.css).
export function mountShapesIn(container) {
  if (!container) return [];
  // Single overlay shared across the whole document — re-uses the same
  // canvas element across renders so we don't churn GL contexts.
  let overlay = document.querySelector("body > canvas.alch-shape-overlay");
  if (!overlay) {
    overlay = document.createElement("canvas");
    overlay.className = "alch-shape-overlay alchemy-only";
    // z-index sits above the tab content (#network-view / #atlas-view /
    // alchemy host all use z:3) but BELOW the tab bar (z:6) and any
    // modals (z:99+). pointer-events:none so the canvas is invisible
    // to mouse hits — clicks fall through to the cards underneath.
    overlay.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:5;";
    document.body.appendChild(overlay);
  }
  const ctrl = mountSharedOverlay(overlay);
  return [ctrl];
}

function mountSharedOverlay(overlay) {
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
    const cssW = window.innerWidth;
    const cssH = window.innerHeight;
    overlay.width  = Math.max(1, Math.round(cssW * dpr));
    overlay.height = Math.max(1, Math.round(cssH * dpr));
  }
  resize();
  window.addEventListener("resize", resize);

  let raf = 0;
  let running = true;
  let started = performance.now();

  // Per-frame DOM query — cheap for tens of shapes, and re-querying
  // catches DOM mutations without needing a MutationObserver.
  function placeholderList() {
    const out = [];
    for (const el of document.querySelectorAll("canvas[data-shape-fam]")) {
      if (el === overlay) continue;
      // data-shape-kind: "team" | "project" | "person" → 0|1|2 uniform
      const kindStr = el.dataset.shapeKind || "team";
      const kind = kindStr === "person" ? 2 : kindStr === "project" ? 1 : 0;
      out.push({
        el,
        family: Number(el.dataset.shapeFam) || 0,
        kind,
        colors: hashColors(el.dataset.shapeSeed || ""),
      });
    }
    return out;
  }

  function frame(now) {
    if (!running) { raf = 0; return; }
    const t = (now - started) / 1000;
    gl.viewport(0, 0, overlay.width, overlay.height);
    gl.scissor(0, 0, overlay.width, overlay.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(prog.prog);

    for (const p of placeholderList()) {
      if (!p.el.isConnected) continue;
      // Don't draw if the placeholder is hidden via display:none (the
      // ancestors' getBoundingClientRect comes back zero).
      const r = p.el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      // viewport coord system is bottom-left origin in CSS pixels; the
      // overlay covers the whole window so getBoundingClientRect (which
      // is also viewport-relative) maps 1:1.
      const x  = Math.round(r.left * dpr);
      const yT = Math.round(r.top  * dpr);
      const w  = Math.max(1, Math.round(r.width  * dpr));
      const h  = Math.max(1, Math.round(r.height * dpr));
      const yB = overlay.height - yT - h;
      // Cull rects that fall entirely outside the visible window.
      if (x + w < 0 || yB + h < 0 || x >= overlay.width || yB >= overlay.height) continue;
      gl.viewport(x, yB, w, h);
      gl.scissor(x, yB, w, h);
      gl.uniform1f(prog.uniforms.time, t);
      gl.uniform1f(prog.uniforms.family, p.family);
      gl.uniform1f(prog.uniforms.kind, p.kind);
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

  raf = requestAnimationFrame(frame);

  return {
    destroy() {
      pause();
      window.removeEventListener("resize", resize);
      const lose = gl.getExtension("WEBGL_lose_context");
      if (lose) try { lose.loseContext(); } catch {}
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    },
    pause,
    resume,
  };
}
