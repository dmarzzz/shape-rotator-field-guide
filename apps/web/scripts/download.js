import { fetchLatestRelease } from "./nav.js";

const REPO = "dmarzzz/shape-rotator-field-guide";
const ASSET_FOR = {
  "mac-arm64":   (v) => `ShapeRotatorFieldGuide-${v}-mac-arm64.dmg`,
  "mac-x64":     (v) => `ShapeRotatorFieldGuide-${v}-mac-x64.dmg`,
  "win-x64":     (v) => `ShapeRotatorFieldGuide-${v}-win-x64.exe`,
  "win-arm64":   (v) => `ShapeRotatorFieldGuide-${v}-win-arm64.exe`,
  "linux-x64":   (v) => `ShapeRotatorFieldGuide-${v}-linux-x86_64.AppImage`,
  "linux-arm64": (v) => `ShapeRotatorFieldGuide-${v}-linux-arm64.AppImage`,
};
const LABEL_FOR = {
  "mac-arm64": "macos · arm64", "mac-x64": "macos · x64",
  "win-x64": "windows · x64",   "win-arm64": "windows · arm64",
  "linux-x64": "linux · x64",   "linux-arm64": "linux · arm64",
};

function assetUrl(version, key) {
  return `https://github.com/${REPO}/releases/download/v${version}/${ASSET_FOR[key](version)}`;
}

// Returns a canonical platform key ("mac-arm64" | ... | null if unsure).
async function detectPlatform() {
  try {
    const uad = navigator.userAgentData;
    if (uad) {
      const platform = (uad.platform || "").toLowerCase();
      let arch = "";
      try {
        const hi = await uad.getHighEntropyValues(["architecture", "bitness"]);
        arch = (hi.architecture || "").toLowerCase();
      } catch {}
      if (platform.includes("mac")) return arch === "arm" ? "mac-arm64" : "mac-x64";
      if (platform.includes("win")) return arch === "arm" ? "win-arm64" : "win-x64";
      if (platform.includes("linux")) return arch === "arm" ? "linux-arm64" : "linux-x64";
    }
  } catch {}
  const ua = (navigator.userAgent || "").toLowerCase();
  const isArm = /arm|aarch64/.test(ua);
  if (/mac|iphone|ipad/.test(ua)) return isArm ? "mac-arm64" : "mac-x64";
  if (/windows/.test(ua))         return isArm ? "win-arm64" : "win-x64";
  if (/linux|cros/.test(ua))      return isArm ? "linux-arm64" : "linux-x64";
  return null;
}

(async function init() {
  const rel = await fetchLatestRelease().catch(() => null);
  const version = (rel?.tag_name || "").replace(/^v/, "");
  if (!version) {
    document.querySelector("[data-install-target]").textContent = "release unavailable";
    return;
  }
  // Fill the all-platforms matrix
  document.querySelectorAll("[data-platform-list] [data-asset]").forEach((a) => {
    const key = a.dataset.asset;
    if (!ASSET_FOR[key]) return;
    a.href = assetUrl(version, key);
    a.textContent = ASSET_FOR[key](version);
  });
  // Auto-detect and wire primary CTA
  const key = await detectPlatform();
  const ctaTarget = document.querySelector("[data-install-target]");
  const ctaPrimary = document.querySelector("[data-install-primary]");
  if (key && ASSET_FOR[key]) {
    ctaTarget.textContent = `${LABEL_FOR[key]} · v${version}`;
    ctaPrimary.setAttribute("href", assetUrl(version, key));
    const row = document.querySelector(`.platform-row[data-platform="${key}"]`);
    if (row) row.setAttribute("aria-current", "true");
  } else {
    ctaTarget.textContent = "choose a platform ↓";
  }
})();
