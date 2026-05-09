// Color helpers shared by lenses + the renderer.

export function stableHue(s) {
  if (!s) return "#7D8AAB";
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  const hue = (Math.abs(h) % 360) / 360;
  return hslHex(hue, 0.78, 0.62);
}

export function accentFor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return "#FF4FE6";
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  if (r > b + 25) return "#5AF0FF";          // warm → cyan accent
  if (b > r + 25) return "#FF4FE6";          // cool → magenta accent
  if (g > r && g > b) return "#FF4FE6";      // green → magenta accent
  return "#5AF0FF";
}

export function hslHex(h, s, l) {
  if (s === 0) {
    const v = Math.round(l * 255).toString(16).padStart(2, "0");
    return `#${v}${v}${v}`;
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  function t(x) {
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return Math.round((p + (q - p) * 6 * x) * 255);
    if (x < 1 / 2) return Math.round(q * 255);
    if (x < 2 / 3) return Math.round((p + (q - p) * (2 / 3 - x) * 6) * 255);
    return Math.round(p * 255);
  }
  return "#" + [t(h + 1/3), t(h), t(h - 1/3)]
    .map(v => v.toString(16).padStart(2, "0")).join("").toUpperCase();
}
