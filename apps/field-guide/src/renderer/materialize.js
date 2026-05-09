// MATERIALIZE — animation for new contributions arriving via SSE.
//
// When the server says "alice contributed a paper," this module:
//  1. Spawns particles streaming from a portal to the destination cluster
//  2. Fades in the node sprite at the destination
//  3. Triggers an attribution toast in the contributor's signature color
//  4. (Optional) plays a chime keyed to the contributor's signature_freq

import * as THREE from "three";

export function materialize({ scene, srwk, page, peer, addPageToGraph }) {
  // 1. Compute a portal position at the canvas edge in the contributor's color
  const cam = srwk.G.camera();
  const camDir = cam.getWorldDirection(new THREE.Vector3());
  const right = new THREE.Vector3().crossVectors(camDir, new THREE.Vector3(0, 1, 0)).normalize();
  const portalPos = cam.position.clone().add(right.multiplyScalar(srwk.bounds.radius * 0.9));

  // 2. Compute destination = lens.groupBy centroid for the new page's group
  const groupKey = srwk.lens.groupBy(page);
  const dest = srwk.groupCentroids.get(groupKey) || { x: 0, y: 0, z: 0 };

  // 3. Add the node to the data set immediately but at portalPos with alpha 0
  page.x = portalPos.x; page.y = portalPos.y; page.z = portalPos.z;
  page._materializingFrom = portalPos;
  page._materializeStart = performance.now() / 1000;
  page._materializeDuration = 1.4;
  page._materializeTarget = dest;
  // Mark as freshly ingested so updateNodeRender can give it a brief
  // ambient halo boost for the first ~30s on top of the materialize
  // animation. Node will glow noticeably warmer than its older neighbors.
  page._recentlyIngestedAt = Date.now();
  addPageToGraph(page);

  // 4. Particle stream
  spawnParticles(scene, portalPos, dest, peer.signature_color || "#FFFFFF", srwk.startTime);

  // 5. Toast
  showAttributionToast(peer, page);
}

function spawnParticles(scene, from, to, color, t0) {
  const N = 10;
  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array(N * 3);
  const aT = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    positions[i * 3 + 0] = from.x;
    positions[i * 3 + 1] = from.y;
    positions[i * 3 + 2] = from.z;
    aT[i] = i * 0.06;
  }
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("aT",       new THREE.BufferAttribute(aT, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(color) } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `
      attribute float aT; uniform float uTime;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = 12.0 * (1.0 - aT) * (260.0 / max(0.001, -mv.z));
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      precision highp float; uniform vec3 uColor;
      void main() {
        vec2 p = gl_PointCoord * 2.0 - 1.0;
        float r = dot(p, p); if (r > 1.0) discard;
        float core = exp(-r * 5.0);
        gl_FragColor = vec4(uColor * core * 2.0, core);
      }
    `,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  scene.add(points);

  const start = performance.now();
  const duration = 1100;
  function tick() {
    const t = (performance.now() - start) / duration;
    if (t >= 1.2) { scene.remove(points); geo.dispose(); mat.dispose(); return; }
    const pos = geo.attributes.position;
    for (let i = 0; i < N; i++) {
      const off = aT[i];
      const lt = Math.max(0, Math.min(1, t - off));
      // quadratic bezier: from → mid (lifted) → to
      const mid = {
        x: (from.x + to.x) / 2 + (Math.random() - 0.5) * 30,
        y: (from.y + to.y) / 2 + 60,
        z: (from.z + to.z) / 2 + (Math.random() - 0.5) * 30,
      };
      const p = bezier(from, mid, to, lt);
      pos.setXYZ(i, p.x, p.y, p.z);
    }
    pos.needsUpdate = true;
    mat.uniforms.uTime.value = (performance.now() - start) / 1000;
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

function bezier(a, b, c, t) {
  const u = 1 - t;
  return {
    x: u * u * a.x + 2 * u * t * b.x + t * t * c.x,
    y: u * u * a.y + 2 * u * t * b.y + t * t * c.y,
    z: u * u * a.z + 2 * u * t * b.z + t * t * c.z,
  };
}

function showAttributionToast(peer, page) {
  const el = document.getElementById("incoming-toast");
  if (!el) return;
  el.querySelector(".t-dot").style.background = peer.signature_color || "#FFF";
  el.querySelector(".t-dot").style.boxShadow = `0 0 12px 2px ${peer.signature_color || "#FFF"}`;
  el.querySelector(".t-body").innerHTML =
    `→ <strong>${peer.nickname || peer.pubkey?.slice(0, 8) || "anon"}</strong> · ${(page.title || page.id).slice(0, 70)}`;
  el.hidden = false;
  el.classList.remove("fade");
  setTimeout(() => { el.classList.add("fade"); }, 4200);
  setTimeout(() => { el.hidden = true; el.classList.remove("fade"); }, 6500);
}
