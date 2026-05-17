import { renderAvailabilityMatrix } from "@shape-rotator/shape-ui";

(async function init() {
  const r = await fetch("/cohort-surface.json").catch(() => null);
  const cohort = r && r.ok ? await r.json() : null;
  const mount = document.getElementById("mount");
  if (!cohort?.people?.length) { mount.innerHTML = '<p class="page-empty">cohort data unavailable</p>'; return; }
  try { renderAvailabilityMatrix({ people: cohort.people, container: mount }); }
  catch (e) { mount.innerHTML = `<p class="page-empty">availability render failed: ${e.message}</p>`; }
})();
