// Marks current nav link via aria-current and paints the version chip.
// Currently a small module — kept separate so cohort/calendar/availability/profile pages can re-use.
const REPO = "dmarzzz/shape-rotator-field-guide";
const RELEASE_CACHE_KEY = "fg-latest-release";
const RELEASE_CACHE_TTL_MS = 60 * 60 * 1000;

export async function fetchLatestRelease() {
  try {
    const cached = JSON.parse(sessionStorage.getItem(RELEASE_CACHE_KEY) || "null");
    if (cached && Date.now() - cached.t < RELEASE_CACHE_TTL_MS) return cached.r;
  } catch {}
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`);
  if (!r.ok) throw new Error(`release fetch failed: ${r.status}`);
  const json = await r.json();
  try { sessionStorage.setItem(RELEASE_CACHE_KEY, JSON.stringify({ t: Date.now(), r: json })); } catch {}
  return json;
}

export function markCurrentNav() {
  const here = location.pathname.replace(/\/$/, "") || "/";
  document.querySelectorAll(".site-nav-links a").forEach((a) => {
    const href = a.getAttribute("href").replace(/\/$/, "") || "/";
    if (href === here) a.setAttribute("aria-current", "page");
  });
}

export async function paintVersion() {
  const els = document.querySelectorAll("[data-version], [data-version-chip]");
  if (!els.length) return null;
  try {
    const rel = await fetchLatestRelease();
    const v = (rel.tag_name || "").replace(/^v/, "") || "—";
    els.forEach((el) => {
      el.textContent = el.matches("[data-version-chip]") ? `v${v}` : v;
    });
    return rel;
  } catch {
    return null;
  }
}

markCurrentNav();
paintVersion();
