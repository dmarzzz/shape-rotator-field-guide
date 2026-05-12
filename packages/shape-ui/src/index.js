// @shape-rotator/shape-ui
// The shared shape vocabulary used by both apps. Both the field-guide
// (cohort participant) and the alchemist app render team specimens with
// the same six shapes — keeping them aligned matters more than DRY-ing
// every component, so this is the one piece extracted into a shared
// package on day one.

// The shape vocabulary. Each shape has a fam (drives the SVG generator),
// a name, a one-line meaning, and a `rotates_to` hint — where teams in
// this shape most often rotate during the program. The hints encode the
// cohort's observed gravity from the kickoff lopsidedness analysis: most
// shapes pull toward SCAFFOLD because almost every team flagged GTM as
// the missing skill.
const SHAPES = [
  { key: "torus",    fam: 0, name: "TORUS",    domain: "crypto", meaning: "closed loop · identity · feedback",          rotates_to: "scaffold" },
  { key: "hex",      fam: 2, name: "HEX",      domain: "tee",    meaning: "packed lattice · systems · infrastructure",  rotates_to: "meridian" },
  { key: "prism",    fam: 5, name: "PRISM",    domain: "ai",     meaning: "refraction · multiplexing · agents",         rotates_to: "scaffold" },
  { key: "meridian", fam: 4, name: "MERIDIAN", domain: "app-ux", meaning: "throughput · interface · edge",              rotates_to: "scaffold" },
  { key: "scaffold", fam: 1, name: "SCAFFOLD", domain: "bd-gtm", meaning: "distribution · go-to-market · adoption",     rotates_to: "torus"    },
  { key: "plate",    fam: 3, name: "PLATE",    domain: "design", meaning: "surface · craft · canvas",                   rotates_to: "meridian" },
];
const SHAPE_BY_DOMAIN = Object.fromEntries(SHAPES.map(s => [s.domain, s]));
const SHAPE_BY_KEY    = Object.fromEntries(SHAPES.map(s => [s.key, s]));

function shapeForTeam(t) {
  return t.shape ? SHAPE_BY_KEY[t.shape] : SHAPE_BY_DOMAIN[t.domain];
}

function domainLabel(d) {
  return ({ crypto: "crypto", tee: "tee · systems", ai: "ai · agents", "app-ux": "app · ux", "bd-gtm": "bd · gtm", design: "design" })[d] || d || "—";
}

function classLabel(c) {
  return ({ "team-50k": "team", "individual-25k": "individual", "operator-0": "operator", mentor: "mentor" })[c] || c || "—";
}

// Deterministic SVG glyph keyed by shape family. The team grid passes
// fam from the team's shape; the legend pane passes fam from SHAPES
// directly so the vocabulary itself can render. CSS classes (as-fill,
// as-stroke, as-mute) are applied by the consuming app's stylesheet.
function shapeSvgByFam(fam, rotSeed) {
  const rot = ((rotSeed | 0) * 37) % 360;
  const w = 200, h = 120, cx = w/2, cy = h/2;
  if (fam === 0) {
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet">
      <g transform="rotate(${rot} ${cx} ${cy})">
        <circle cx="${cx}" cy="${cy}" r="44" class="as-mute"/>
        <circle cx="${cx}" cy="${cy}" r="30" class="as-stroke"/>
        <circle cx="${cx}" cy="${cy}" r="14" class="as-fill"/>
      </g>
    </svg>`;
  }
  if (fam === 1) {
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet">
      <g transform="rotate(${rot} ${cx} ${cy})">
        <line x1="${cx-44}" y1="${cy}" x2="${cx+44}" y2="${cy}" class="as-mute"/>
        <line x1="${cx}" y1="${cy-44}" x2="${cx}" y2="${cy+44}" class="as-mute"/>
        <rect x="${cx-22}" y="${cy-22}" width="44" height="44" class="as-stroke"/>
        <circle cx="${cx}" cy="${cy}" r="8" class="as-fill"/>
      </g>
    </svg>`;
  }
  if (fam === 2) {
    const r = 38;
    const pts = [];
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i - Math.PI / 2;
      pts.push(`${(cx + Math.cos(a) * r).toFixed(1)},${(cy + Math.sin(a) * r).toFixed(1)}`);
    }
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet">
      <g transform="rotate(${rot} ${cx} ${cy})">
        <polygon points="${pts.join(" ")}" class="as-stroke"/>
        <circle cx="${cx}" cy="${cy}" r="10" class="as-fill"/>
      </g>
    </svg>`;
  }
  if (fam === 3) {
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet">
      <g transform="rotate(${rot} ${cx} ${cy})">
        <polygon points="${cx},${cy-44} ${cx-38},${cy+22} ${cx+38},${cy+22}" class="as-mute"/>
        <polygon points="${cx},${cy-26} ${cx-22},${cy+14} ${cx+22},${cy+14}" class="as-stroke"/>
        <polygon points="${cx},${cy-10} ${cx-8},${cy+6} ${cx+8},${cy+6}" class="as-fill"/>
      </g>
    </svg>`;
  }
  if (fam === 4) {
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet">
      <g transform="rotate(${rot} ${cx} ${cy})">
        <path d="M ${cx-44} ${cy} A 44 44 0 0 1 ${cx+44} ${cy}" class="as-stroke"/>
        <path d="M ${cx-30} ${cy+8} A 30 30 0 0 0 ${cx+30} ${cy+8}" class="as-mute"/>
        <circle cx="${cx}" cy="${cy-6}" r="9" class="as-fill"/>
      </g>
    </svg>`;
  }
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet">
    <g transform="rotate(${rot} ${cx} ${cy})">
      <polygon points="${cx},${cy-44} ${cx+44},${cy} ${cx},${cy+44} ${cx-44},${cy}" class="as-mute"/>
      <polygon points="${cx},${cy-26} ${cx+26},${cy} ${cx},${cy+26} ${cx-26},${cy}" class="as-stroke"/>
      <circle cx="${cx}" cy="${cy}" r="7" class="as-fill"/>
    </g>
  </svg>`;
}

export {
  SHAPES,
  SHAPE_BY_DOMAIN,
  SHAPE_BY_KEY,
  shapeForTeam,
  shapeSvgByFam,
  domainLabel,
  classLabel,
};
// WebGL2 renderer for the cohort shapes — see shape-canvas.js for the
// full shader. Hash-of-record-id drives a unique-but-stable palette per
// team. Call mountShape(canvas, {family, seed}) on each <canvas>; the
// returned controller's .destroy() releases the GL context (browsers
// cap to ~16, so destroying on re-render is essential).
export { mountShape, mountShapesIn, hashColors } from "./shape-canvas.js";
