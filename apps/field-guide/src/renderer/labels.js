// LABELS — render cluster topic names in 3D space at the group centroid.
//
// Major clusters (≥5 pages, ≥1 contributor): big bold label.
// Niche clusters (≥3 pages, ≥2 contributors): smaller dim label.
// Everything else: no label.
//
// The visualizer keeps a Map<key, sprite>. On lens change or cluster refresh,
// we diff: add new labels, remove gone labels, leave existing ones in place.

import * as THREE from "three";

const LABEL_TIERS = {
  major: { font: "500 38px 'Inter', system-ui",   fill: "rgba(255,255,255,0.96)", glow: 22, scale: 260, shadow: "rgba(120,180,255,0.65)" },
  niche: { font: "300 22px 'Inter', system-ui",   fill: "rgba(220,232,255,0.72)", glow: 12, scale: 170, shadow: "rgba(120,180,255,0.45)" },
};

export function buildLabel(text, tier, color = "#FFFFFF") {
  const cfg = LABEL_TIERS[tier] || LABEL_TIERS.niche;
  const W = 1024, H = 256;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  ctx.clearRect(0, 0, W, H);
  ctx.font = cfg.font;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // soft glow underlayer
  ctx.shadowColor = cfg.shadow;
  ctx.shadowBlur = cfg.glow;
  ctx.fillStyle = cfg.fill;
  ctx.fillText(text, W / 2, H / 2, W * 0.94);

  // crisp top layer (no shadow) for legibility
  ctx.shadowBlur = 0;
  ctx.fillStyle = cfg.fill;
  ctx.fillText(text, W / 2, H / 2, W * 0.94);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;

  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthWrite: false,
    depthTest: false,           // labels always on top
    fog: false,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(cfg.scale, cfg.scale * (H / W), 1);
  sprite.renderOrder = 1000;
  sprite.userData = { tier, text, baseScale: cfg.scale };
  return sprite;
}

export function syncLabels({ scene, clusterDefs, labelMap, groupCentroids }) {
  // clusterDefs: array from server [{ key, label, tier, score, ... }]
  // labelMap:    Map<key, sprite> persisted across calls
  const incoming = new Map(clusterDefs.map((c) => [c.key, c]));

  // remove labels whose cluster is gone (or fell below tier)
  for (const [k, sprite] of labelMap) {
    if (!incoming.has(k)) {
      scene.remove(sprite);
      sprite.material.map.dispose();
      sprite.material.dispose();
      labelMap.delete(k);
    }
  }

  // add new ones
  for (const c of clusterDefs) {
    if (labelMap.has(c.key)) {
      // tier may have changed (e.g. niche → major). cheap check.
      const existing = labelMap.get(c.key);
      if (existing.userData.tier !== c.tier || existing.userData.text !== c.label) {
        scene.remove(existing);
        existing.material.map.dispose();
        existing.material.dispose();
        labelMap.delete(c.key);
      } else {
        continue;
      }
    }
    const sprite = buildLabel(c.label, c.tier);
    sprite.userData.key = c.key;
    scene.add(sprite);
    labelMap.set(c.key, sprite);
  }

  // position pass: every label sits at its group centroid (slightly lifted)
  // so it floats above the densest part of the cluster
  for (const [k, sprite] of labelMap) {
    const c = groupCentroids.get(k);
    if (!c) {
      sprite.visible = false;
      continue;
    }
    sprite.visible = true;
    sprite.position.set(c.x, c.y + 30, c.z);
  }
}

export function fadeLabelsByDistance(camera, labelMap) {
  // Hide labels that the camera is too close to (text overlapping the
  // glowing nodes is unreadable). Fade in as camera pulls back.
  for (const sprite of labelMap.values()) {
    const dx = sprite.position.x - camera.position.x;
    const dy = sprite.position.y - camera.position.y;
    const dz = sprite.position.z - camera.position.z;
    const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
    // pleasant readability range: 200..3000 world units
    let alpha = (dist - 200) / 1200;
    alpha = Math.max(0, Math.min(1, alpha));
    sprite.material.opacity = alpha;
  }
}
