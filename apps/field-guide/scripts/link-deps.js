// link-deps.js — Run as a postinstall step inside apps/field-guide so the
// renderer's importmap (which uses `../node_modules/<pkg>` paths) resolves
// in dev mode the same way it does in a packaged build.
//
// Why this is needed: npm workspaces hoist shared deps to the repo root
// `/node_modules/`, so `apps/field-guide/node_modules/` ends up empty for
// any package that's also used by another workspace. The renderer's
// `<script type="importmap">` and the static `<script src="../node_modules/...">`
// tag both expect those packages at `apps/field-guide/node_modules/<pkg>`,
// which works inside the packaged .app bundle (electron-builder writes a
// per-app layout) but breaks in a workspace-installed dev tree.
//
// We fix that by symlinking the few packages the renderer pulls directly
// (three, @cosmos.gl, 3d-force-graph) from the per-app node_modules dir
// up to the hoisted copies. Idempotent; safe to re-run.

"use strict";
const fs = require("node:fs");
const path = require("node:path");

const PKGS = ["three", "@cosmos.gl", "3d-force-graph"];

const APP_DIR = path.resolve(__dirname, "..");
const APP_NM  = path.join(APP_DIR, "node_modules");
// Walk up from apps/field-guide/node_modules until we find the workspace
// root that holds the hoisted node_modules. Usually two levels up.
function findRootNodeModules(startDir) {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "node_modules");
    // Skip our own per-app node_modules.
    if (candidate !== APP_NM && fs.existsSync(path.join(candidate, "three"))) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const ROOT_NM = findRootNodeModules(path.dirname(APP_DIR));
if (!ROOT_NM) {
  // No hoisted root with `three` found — likely a packaged build or an
  // unhoisted install. Either way, nothing for us to do.
  process.exit(0);
}

fs.mkdirSync(APP_NM, { recursive: true });

let linked = 0;
for (const pkg of PKGS) {
  const target = path.join(ROOT_NM, pkg);
  const linkPath = path.join(APP_NM, pkg);
  // If the package is already physically present (not a symlink), don't
  // touch it — that means npm de-hoisted it for some reason.
  try {
    const stat = fs.lstatSync(linkPath);
    if (!stat.isSymbolicLink() && stat.isDirectory()) continue;
    fs.unlinkSync(linkPath);
  } catch { /* doesn't exist yet */ }
  if (!fs.existsSync(target)) continue;
  // Symlink with a path RELATIVE to the link's parent so the link works
  // regardless of where the repo lives on disk.
  const relTarget = path.relative(path.dirname(linkPath), target);
  // For nested @scope packages, ensure the @scope dir exists.
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(relTarget, linkPath, "dir");
  linked++;
}
if (linked > 0) {
  process.stderr.write(`[link-deps] linked ${linked} hoisted package(s) into ${path.relative(process.cwd(), APP_NM)}\n`);
}
