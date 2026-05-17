import { renderCohortCalendar } from "@shape-rotator/shape-ui";

(async function init() {
  const r = await fetch("/cohort-surface.json").catch(() => null);
  const cohort = r && r.ok ? await r.json() : null;
  const mount = document.getElementById("mount");
  if (!cohort) { mount.innerHTML = '<p class="page-empty">cohort data unavailable</p>'; return; }
  try { renderCohortCalendar({ container: mount, cohort }); }
  catch (e) { mount.innerHTML = `<p class="page-empty">calendar render failed: ${e.message}</p>`; }
})();
