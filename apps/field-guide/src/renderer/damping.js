// DAMPING — keep the visualizer calm.
//
// Two layers of damping:
// 1. Position damping during shape transitions: lerp current → target with
//    eased k = min(1, dt * 4.5). Strong but smooth.
// 2. Camera angular velocity damping: 0.88/frame coefficient on orbit drift.

export const DAMP = {
  shapeLerpRate: 4.5,
  cameraAngularDamp: 0.88,
  // velocityDecay: 0.45 (was 0.65) — let nodes oscillate enough to escape
  //   stacked configurations. With forceCollide doing the close-range work,
  //   we can afford less damping.
  velocityDecay: 0.45,
  // alphaDecay: 0.015 (was 0.020) — give the layout more ticks to relax
  //   the new shell-radial + collide configuration.
  alphaDecay: 0.015,
  cooldownTicks: 0,
  newNodeAlphaJitter: 0.05,
};

export function dampPosition(current, target, dt, rate = DAMP.shapeLerpRate) {
  const k = Math.min(1, dt * rate);
  current.x += (target.x - current.x) * k;
  current.y += (target.y - current.y) * k;
  current.z += (target.z - current.z) * k;
}

export function dampScalar(current, target, dt, rate = DAMP.shapeLerpRate) {
  const k = Math.min(1, dt * rate);
  return current + (target - current) * k;
}

export function applyAngularDamp(velocity, factor = DAMP.cameraAngularDamp) {
  velocity.x *= factor;
  velocity.y *= factor;
  velocity.z *= factor;
}
