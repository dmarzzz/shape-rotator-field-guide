import { renderCohortCard } from "@shape-rotator/shape-ui";

(async function init() {
  const r = await fetch("/cohort-surface.json").catch(() => null);
  const cohort = r && r.ok ? await r.json() : null;
  const mount = document.getElementById("mount");
  if (!cohort) { mount.innerHTML = '<p class="page-empty">cohort data unavailable</p>'; return; }
  const grid = document.createElement("div");
  grid.className = "cohort-grid";
  const records = [...(cohort.teams || []), ...(cohort.people || [])];
  for (const rec of records) {
    try {
      const card = renderCohortCard(rec, { onClick: () => {} });
      if (card instanceof Node) grid.appendChild(card);
    } catch (e) { console.warn("[cohort] card render failed:", rec.record_id, e); }
  }
  mount.appendChild(grid);
})();
