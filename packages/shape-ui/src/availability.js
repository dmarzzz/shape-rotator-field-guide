// @shape-rotator/shape-ui — cohort availability
//
// Pure computation + a small DOM renderer for the cohort availability
// matrix. Lives in shape-ui so the field-guide (Electron) and the
// sibling web app stay pixel-aligned without one importing from the
// other. No chart libs, no framework — plain DOM/CSS and design tokens.
//
// Data shape (from cohort-data/schema.yml + cohort-surface.json):
//   person.record_id     string  — id used as personId everywhere
//   person.name          string
//   person.dates_start   YYYY-MM-DD | ISO datetime  (inclusive)
//   person.dates_end     YYYY-MM-DD | ISO datetime  (inclusive)
//   person.absences?     [{ start, end, note? }]    (inclusive on both ends)
//
// Dates arrive as either "YYYY-MM-DD" (markdown frontmatter) or
// "YYYY-MM-DDT00:00:00.000Z" (the parsed cohort-surface.json). Both are
// normalized to a YYYY-MM-DD string for comparison — string ordering is
// correct on that format and we never have to think about TZs.

// ─── date helpers ────────────────────────────────────────────────────────

// Coerce any of the accepted inputs to "YYYY-MM-DD". We slice the first
// 10 chars rather than going through Date so a "2026-05-18T00:00:00.000Z"
// in a UTC-7 browser doesn't get bumped back to "2026-05-17".
function toDateKey(d) {
  if (d == null) return null;
  if (typeof d === "string") return d.length >= 10 ? d.slice(0, 10) : null;
  if (d instanceof Date) {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  return null;
}

// Parse a YYYY-MM-DD key into a UTC Date (midnight). UTC keeps the
// day-by-day stepping deterministic regardless of the consumer's TZ.
function dateFromKey(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function addDays(date, n) {
  const out = new Date(date.getTime());
  out.setUTCDate(out.getUTCDate() + n);
  return out;
}

// 0 = Sunday … 6 = Saturday
function dayOfWeek(date) {
  return date.getUTCDay();
}

// Walk [startKey, endKey] inclusive, yielding YYYY-MM-DD keys.
function* eachDayKey(startKey, endKey) {
  const end = dateFromKey(endKey);
  let cur = dateFromKey(startKey);
  while (cur.getTime() <= end.getTime()) {
    yield toDateKey(cur);
    cur = addDays(cur, 1);
  }
}

// ─── computation ─────────────────────────────────────────────────────────

// Returns sorted array of:
//   { date: "YYYY-MM-DD", present: [personId, ...] }
// for each day in [rangeStart, rangeEnd] inclusive.
//
// A person is "present" on D iff:
//   D ∈ [person.dates_start, person.dates_end]   (inclusive)
//   AND D ∉ any absences range                   (inclusive)
//
// If rangeStart / rangeEnd are omitted, the range collapses to the
// union of all people's windows.
export function computeAvailability(people, opts = {}) {
  if (!Array.isArray(people) || people.length === 0) return [];

  // Normalize once so the hot loop doesn't re-parse.
  const normalized = people
    .map(p => {
      const start = toDateKey(p.dates_start);
      const end = toDateKey(p.dates_end);
      if (!start || !end) return null;
      const absences = Array.isArray(p.absences)
        ? p.absences
            .map(a => ({ start: toDateKey(a.start), end: toDateKey(a.end) }))
            .filter(a => a.start && a.end)
        : [];
      return {
        id: p.record_id ?? p.id ?? p.name,
        start,
        end,
        absences,
      };
    })
    .filter(Boolean);

  if (normalized.length === 0) return [];

  let rangeStart = toDateKey(opts.rangeStart);
  let rangeEnd = toDateKey(opts.rangeEnd);
  if (!rangeStart) rangeStart = normalized.reduce((m, p) => (p.start < m ? p.start : m), normalized[0].start);
  if (!rangeEnd) rangeEnd = normalized.reduce((m, p) => (p.end > m ? p.end : m), normalized[0].end);
  if (rangeStart > rangeEnd) return [];

  const out = [];
  for (const dateKey of eachDayKey(rangeStart, rangeEnd)) {
    const present = [];
    for (const p of normalized) {
      if (dateKey < p.start || dateKey > p.end) continue;
      let inAbsence = false;
      for (const a of p.absences) {
        if (dateKey >= a.start && dateKey <= a.end) { inAbsence = true; break; }
      }
      if (!inAbsence) present.push(p.id);
    }
    out.push({ date: dateKey, present });
  }
  return out;
}

// ─── rendering ───────────────────────────────────────────────────────────

const COLLAPSE_THRESHOLD = 60; // days; wider ranges auto-collapse to weeks
const MS_PER_DAY = 86_400_000;

function personSortKey(p) {
  return [toDateKey(p.dates_start) ?? "9999-12-31", (p.name ?? p.record_id ?? "").toLowerCase()];
}

function cmpSortKey(a, b) {
  if (a[0] < b[0]) return -1;
  if (a[0] > b[0]) return 1;
  if (a[1] < b[1]) return -1;
  if (a[1] > b[1]) return 1;
  return 0;
}

// Group the day-level availability into ISO-style weeks (Mon-Sun). A
// person counts as "present" for the week if they're present on any
// day inside it.
function groupByWeek(daily) {
  if (daily.length === 0) return [];
  const weeks = [];
  let current = null;
  for (const d of daily) {
    const date = dateFromKey(d.date);
    const dow = dayOfWeek(date); // 0=Sun..6=Sat
    // Monday-anchored week boundary: start a new week when we see Mon
    // (or at the very first day).
    if (current == null || dow === 1) {
      if (current) weeks.push(current);
      current = { date: d.date, present: new Set(d.present) };
    } else {
      for (const id of d.present) current.present.add(id);
    }
  }
  if (current) weeks.push(current);
  return weeks.map(w => ({ date: w.date, present: [...w.present] }));
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// Paints an availability matrix into `container`. See module header for
// data shape; see availability.css for the (token-driven) styles.
//
// Options:
//   people        — array of person records (record_id, name, dates_start, …)
//   container     — DOM element to render into (required)
//   rangeStart    — optional YYYY-MM-DD (defaults to min dates_start)
//   rangeEnd      — optional YYYY-MM-DD (defaults to max dates_end)
//   onPersonClick — (personId) => void, fires on row click / Enter
export function renderAvailabilityMatrix({
  people = [],
  container,
  rangeStart,
  rangeEnd,
  onPersonClick,
} = {}) {
  if (!container) throw new Error("renderAvailabilityMatrix: container is required");
  container.textContent = "";

  if (!Array.isArray(people) || people.length === 0) {
    const empty = el("div", "avail-empty", "no people in range");
    container.appendChild(empty);
    return;
  }

  const daily = computeAvailability(people, { rangeStart, rangeEnd });
  if (daily.length === 0) {
    const empty = el("div", "avail-empty", "no days in range");
    container.appendChild(empty);
    return;
  }

  const numDays = daily.length;
  const collapsed = numDays > COLLAPSE_THRESHOLD;
  const cells = collapsed ? groupByWeek(daily) : daily;

  // Build a present-set per slot for O(1) lookup while painting rows.
  const presentByDate = new Map();
  for (const c of cells) presentByDate.set(c.date, new Set(c.present));

  const sorted = [...people].sort((a, b) => cmpSortKey(personSortKey(a), personSortKey(b)));

  // Root grid
  const root = el("div", "avail");
  root.setAttribute("role", "grid");
  root.setAttribute("aria-label", "Cohort availability matrix");

  // Header row — spacer (above names) + column ticks (months / week-starts)
  const header = el("div", "avail-header");
  header.appendChild(el("div", "avail-header-spacer"));
  const headerCols = el("div", "avail-header-cols");

  // Tick labels: in day-mode, show month abbrev on day-1-of-month and on
  // the first cell. In week-mode, show the Monday's "MMM D" on the first
  // Monday of each month and on the first cell.
  let lastMonth = "";
  cells.forEach((c, i) => {
    const date = dateFromKey(c.date);
    const monthAbbr = date.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
    let label = "";
    if (collapsed) {
      if (i === 0 || monthAbbr !== lastMonth) {
        label = `${monthAbbr} ${date.getUTCDate()}`;
      }
    } else {
      if (i === 0 || date.getUTCDate() === 1) label = monthAbbr;
    }
    lastMonth = monthAbbr;
    const tick = el("div", label ? "avail-tick" : "avail-tick avail-tick--quiet", label || "·");
    headerCols.appendChild(tick);
  });
  header.appendChild(headerCols);
  root.appendChild(header);

  const todayKey = toDateKey(new Date());

  for (const person of sorted) {
    const id = person.record_id ?? person.id ?? person.name;
    const name = person.name ?? id;

    const row = el("div", "avail-row");
    row.setAttribute("role", "row");
    row.dataset.personId = id;

    const nameCell = el("div", "avail-name", name);
    nameCell.setAttribute("role", "rowheader");
    nameCell.setAttribute("tabindex", "0");
    nameCell.title = name;
    if (typeof onPersonClick === "function") {
      const fire = () => onPersonClick(id);
      nameCell.addEventListener("click", fire);
      nameCell.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); fire(); }
      });
    }
    row.appendChild(nameCell);

    const cellsWrap = el("div", "avail-cells");
    cellsWrap.setAttribute("role", "presentation");

    for (const c of cells) {
      const present = presentByDate.get(c.date)?.has(id) ?? false;
      const date = dateFromKey(c.date);
      const dow = dayOfWeek(date);
      // week separator: drawn on the trailing edge of Sunday (or the
      // trailing edge of every week slot in collapsed mode).
      const isWeekEdge = collapsed || dow === 0;
      const cell = el("div", "avail-cell" +
        (present ? " avail-cell--present" : " avail-cell--absent") +
        (isWeekEdge ? " avail-cell--week-edge" : "") +
        (c.date === todayKey ? " avail-cell--today" : ""));
      cell.title = collapsed
        ? `week of ${c.date} — ${present ? "present ≥1 day" : "absent"}`
        : `${c.date} — ${present ? "present" : "absent"}`;
      cellsWrap.appendChild(cell);
    }

    row.appendChild(cellsWrap);
    if (typeof onPersonClick === "function") {
      // Clicking anywhere on the row (including cells) selects the person.
      cellsWrap.addEventListener("click", () => onPersonClick(id));
    }
    root.appendChild(row);
  }

  container.appendChild(root);
}

// Re-export the stylesheet path for convenience — consumers can also
// just `import "@shape-rotator/shape-ui/src/availability.css"` directly
// (the package's main is JS, not CSS, by design).
export const availabilityStylesPath = new URL("./availability.css", import.meta.url).href;
