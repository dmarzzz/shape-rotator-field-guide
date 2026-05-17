import { renderProfileForm, buildEditPRUrl } from "@shape-rotator/shape-ui";

(async function init() {
  const r = await fetch("/cohort-surface.json").catch(() => null);
  const cohort = r && r.ok ? await r.json() : null;
  const mount = document.getElementById("mount");
  if (!cohort) { mount.innerHTML = '<p class="page-empty">cohort data unavailable</p>'; return; }
  // Picker: type + id select; on change, re-mount form with initialData
  const picker = document.createElement("div");
  picker.className = "profile-picker";
  picker.innerHTML = `
    <label class="profile-picker-row"><span>type</span>
      <select id="picker-type">
        <option value="person">person</option>
        <option value="team">team</option>
      </select>
    </label>
    <label class="profile-picker-row"><span>record</span>
      <select id="picker-id"></select>
    </label>
  `;
  mount.appendChild(picker);
  const formMount = document.createElement("div");
  formMount.id = "form-mount";
  mount.appendChild(formMount);

  const typeSel = picker.querySelector("#picker-type");
  const idSel = picker.querySelector("#picker-id");

  function refreshIdOptions() {
    const t = typeSel.value;
    const list = t === "person" ? (cohort.people || []) : (cohort.teams || []);
    idSel.innerHTML = list.map(r => `<option value="${r.record_id}">${r.name || r.record_id}</option>`).join("");
  }
  function mountForm() {
    formMount.innerHTML = "";
    const t = typeSel.value;
    const id = idSel.value;
    const list = t === "person" ? (cohort.people || []) : (cohort.teams || []);
    const initialData = list.find(r => r.record_id === id) || {};
    try {
      renderProfileForm({
        recordType: t, recordId: id, initialData, container: formMount,
        openExternal: (url) => window.open(url, "_blank"),
      });
    } catch (e) {
      formMount.innerHTML = `<p class="page-empty">profile form failed: ${e.message}</p>`;
    }
  }

  typeSel.addEventListener("change", () => { refreshIdOptions(); mountForm(); });
  idSel.addEventListener("change", mountForm);

  refreshIdOptions();
  mountForm();
})();
