// SHAPES — macro layout algorithms.
// Each shape returns Map<nodeId, {x,y,z}>. The renderer lerps current → target
// over ~1.8s. The cluster shape is special: it delegates to the live force sim.

export const SHAPES = {
  cluster: {
    id: "cluster", label: "Cluster", description: "Force-directed.",
    live: true,
    layout(/*nodes, lens, bounds*/) { return null; },  // null → keep current sim positions
  },

  sphere: {
    id: "sphere", label: "Sphere", description: "Fibonacci sphere.",
    layout(nodes, lens, bounds) {
      const sorted = sortByLens(nodes, lens);
      const N = Math.max(1, sorted.length);
      const phi = Math.PI * (3 - Math.sqrt(5));
      const r = bounds.radius;
      const out = new Map();
      for (let i = 0; i < N; i++) {
        const y = 1 - (i / Math.max(1, N - 1)) * 2;
        const rad = Math.sqrt(1 - y * y);
        const t = phi * i;
        out.set(sorted[i].id, {
          x: Math.cos(t) * rad * r,
          y: y * r,
          z: Math.sin(t) * rad * r,
        });
      }
      return out;
    },
  },

  matrix: {
    id: "matrix", label: "Matrix", description: "3D grid.",
    layout(nodes, lens, bounds) {
      const sorted = sortByLens(nodes, lens);
      const N = Math.max(1, Math.ceil(Math.cbrt(sorted.length)));
      const step = (bounds.radius * 2) / N;
      const out = new Map();
      for (let i = 0; i < sorted.length; i++) {
        const x = (i % N) - N / 2;
        const y = (Math.floor(i / N) % N) - N / 2;
        const z = Math.floor(i / (N * N)) - N / 2;
        out.set(sorted[i].id, { x: x * step, y: y * step, z: z * step });
      }
      return out;
    },
  },

  spiral: {
    id: "spiral", label: "Spiral", description: "Phyllotaxis spiral.",
    layout(nodes, lens, bounds) {
      const sorted = sortByLens(nodes, lens);
      const N = sorted.length;
      const r = bounds.radius;
      const goldenAngle = Math.PI * (3 - Math.sqrt(5));
      const out = new Map();
      for (let i = 0; i < N; i++) {
        const t = i / Math.max(1, N - 1);
        const radial = r * Math.sqrt(t);
        const theta = i * goldenAngle;
        const yLift = (t - 0.5) * r * 1.2;
        out.set(sorted[i].id, {
          x: Math.cos(theta) * radial,
          y: yLift,
          z: Math.sin(theta) * radial,
        });
      }
      return out;
    },
  },

  stream: {
    id: "stream", label: "Stream", description: "Horizontal flow.",
    layout(nodes, lens, bounds) {
      // y-band per groupBy, x = sorted by recency/fetched_at, z = small jitter
      const groups = new Map();
      for (const n of nodes) {
        const k = lens.groupBy(n);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(n);
      }
      const groupKeys = [...groups.keys()].sort();
      const r = bounds.radius;
      const yStep = (r * 2) / Math.max(1, groupKeys.length);
      const out = new Map();
      groupKeys.forEach((k, gi) => {
        const arr = groups.get(k).slice().sort((a, b) =>
          (a.fetched_at || "").localeCompare(b.fetched_at || ""));
        const xStep = (r * 2) / Math.max(1, arr.length);
        const y = -r + gi * yStep + yStep / 2;
        arr.forEach((n, i) => {
          const x = -r + i * xStep + (Math.random() - 0.5) * 4;
          const z = (Math.random() - 0.5) * 60;
          out.set(n.id, { x, y, z });
        });
      });
      return out;
    },
  },

  grid: {
    id: "grid", label: "Grid", description: "Uniform lattice.",
    layout(nodes, lens, bounds) {
      const N = Math.max(1, Math.ceil(Math.cbrt(nodes.length)));
      const step = (bounds.radius * 2) / N;
      const out = new Map();
      // hash-based stable position per id, snapped to lattice
      nodes.forEach((n) => {
        const h = djb2(n.id);
        const x = ((h % N) - N / 2) * step;
        const y = (((h >> 8) % N) - N / 2) * step;
        const z = (((h >> 16) % N) - N / 2) * step;
        out.set(n.id, { x, y, z });
      });
      return out;
    },
  },
};

// v0 ships 3 shapes; the rest stay defined for future use.
export const SHAPE_LIST = [SHAPES.cluster, SHAPES.sphere, SHAPES.matrix];

function sortByLens(nodes, lens) {
  return nodes.slice().sort((a, b) => {
    const ka = lens.groupBy(a) ?? "";
    const kb = lens.groupBy(b) ?? "";
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    return (b.degree || 0) - (a.degree || 0);
  });
}

function djb2(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// Eased interpolation for shape transitions.
export function easeOutQuart(t) {
  return 1 - Math.pow(1 - t, 4);
}
