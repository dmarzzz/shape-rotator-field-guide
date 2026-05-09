# shape rotator field guide

Local-first Electron app for the Shape Rotator cohort. Four tabs:

- **alchemy** — the cohort view: feed of github activity across team repos, shape grid (every team/project as a card), pulse + constellation visualizations, and a profile editor that submits your edits as PRs against this repo.
- **atlas** — wall-map of every page indexed locally by your swf-node, clustered into territories. Search overlay (`⌘/`) routes through swf-node's `/web_search`.
- **network** — live peer view (LAN + DC-net rounds + receipts) plus a metrics sub-tab pulling from `/metrics/snapshot` + `/metrics/series`.

The app is a viewer over [`swf-node`](https://github.com/dmarzzz/searxng-wth-frnds), the LAN-first peer search daemon. Without swf-node running, atlas + network + search are disabled but alchemy still works (cohort data ships in `cohort-data/`).

## what's in here

```
apps/
  field-guide/        ← the Electron app (main + renderer)

packages/
  shape-ui/           ← shared SHAPES vocabulary + SVG generator

cohort-data/          ← markdown source of truth for the cohort
  schema.yml          ← surface_fields whitelist per record_type
  teams/<slug>.md     ← teams + projects (kind: team | project)
  clusters/<slug>.md  ← synergy clusters across teams

scripts/
  build-bundles.js    ← cohort-data/ → apps/field-guide/src/cohort-surface.json
  publish-bundles.js  ← sign + POST cohort.surface bundles to swf-node
  keys-gen.js         ← generate an Ed25519 alchemist signing key
```

## run it

```bash
npm install
npm run field-guide
```

You'll need swf-node running on `127.0.0.1:7777` (default) for atlas / network / search; alchemy works offline against the bundled cohort fixture.

## edit your record

Open the app → profile tab → pick `EDIT` (existing record) or `ADD` (new). Submit opens a GitHub PR against this repo — once merged, run `npm run publish:cohort` to push the new surface bundles to your swf-node.

The depth fields (status, blockers, decision logs) live only in alchemist worktrees and are encrypted into `cohort.depth` bundles before reaching the wire — they never appear in this repo.

## profile data model

Every record in `cohort-data/` has two layers per [`docs/SHAPE-ROTATOR-OS-SPEC.md` §3.3](https://github.com/dmarzzz/searxng-wth-frnds):

- **surface** — the public fields whitelisted in `schema.yml`. Visible to all cohort participants. What's in this repo.
- **depth** — alchemist-only fields (intake notes, blockers, decisions). Lives in the alchemist worktree, encrypted into `cohort.depth` bundles.

Adding a new public field: add it to the markdown frontmatter + add the key to `schema.yml`. Anything not in the whitelist stays steward-only.
