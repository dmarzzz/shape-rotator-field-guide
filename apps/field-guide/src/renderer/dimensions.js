// DIMENSIONS — apply a lens's variable→visual mapping to a node sprite.
//
// Each call here rewrites a node's runtime visual attributes (color, accent,
// size, glow, halo) from the data fields, via the active lens's `dimensions`
// recipe. Called whenever the lens changes, or when a node's _temp updates.

export function applyDimensions(node, lens) {
  const D = lens.dimensions;
  // Each dimension is { from: <field>, via: <fn> }
  // The fn receives the field VALUE if `from` resolves to a scalar in the node,
  // or the whole node if `from` starts with "_" (computed).
  function read(spec) {
    if (!spec) return undefined;
    const { from, via } = spec;
    let val;
    if (from.startsWith("_")) {
      val = node;
    } else {
      val = node[from];
    }
    try { return via(val); } catch { return undefined; }
  }
  const out = {
    color:  read(D.color),
    accent: read(D.accent),
    size:   read(D.size),
    glow:   read(D.glow),
    halo:   read(D.halo),
  };
  node._dims = out;
  return out;
}

export function applyAllDimensions(nodes, lens) {
  for (const n of nodes) applyDimensions(n, lens);
}
