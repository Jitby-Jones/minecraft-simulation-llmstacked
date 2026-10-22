// Plain-object vector math. Kept independent of the `vec3` package so shared code has no mineflayer dependency.

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export function vec(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scale(a: Vec3, k: number): Vec3 {
  return { x: a.x * k, y: a.y * k, z: a.z * k };
}

export function length(a: Vec3): number {
  return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
}

export function distance(a: Vec3, b: Vec3): number {
  return length(sub(a, b));
}

/** Horizontal (XZ-plane) distance. */
export function distanceXZ(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

export function normalize(a: Vec3): Vec3 {
  const len = length(a);
  return len === 0 ? { x: 0, y: 0, z: 0 } : scale(a, 1 / len);
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function floorVec(a: Vec3): Vec3 {
  return { x: Math.floor(a.x), y: Math.floor(a.y), z: Math.floor(a.z) };
}

export function roundVec(a: Vec3, digits = 0): Vec3 {
  const f = 10 ** digits;
  return { x: Math.round(a.x * f) / f, y: Math.round(a.y * f) / f, z: Math.round(a.z * f) / f };
}

export function equalsVec(a: Vec3, b: Vec3, eps = 1e-9): boolean {
  return Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps && Math.abs(a.z - b.z) <= eps;
}

export function formatVec(a: Vec3): string {
  return `${Math.round(a.x)},${Math.round(a.y)},${Math.round(a.z)}`;
}

/** Parses "x,y,z" (spaces allowed). Returns null when malformed. */
export function parseVec(text: string): Vec3 | null {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(text);
  if (!m) return null;
  return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) };
}

/** Yaw in radians from a to b, in mineflayer's convention (same formula as `bot.lookAt`: atan2(-dx, -dz)). */
export function yawTowards(from: Vec3, to: Vec3): number {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  return Math.atan2(-dx, -dz);
}

/** Angle in radians between the facing direction given by yaw and the direction to a target (XZ plane). */
export function angleToTarget(from: Vec3, yaw: number, to: Vec3): number {
  const desired = yawTowards(from, to);
  let diff = desired - yaw;
  while (diff > Math.PI) diff -= 2 * Math.PI;
  while (diff < -Math.PI) diff += 2 * Math.PI;
  return Math.abs(diff);
}

export function centroid(points: readonly Vec3[]): Vec3 | null {
  if (points.length === 0) return null;
  let x = 0;
  let y = 0;
  let z = 0;
  for (const p of points) {
    x += p.x;
    y += p.y;
    z += p.z;
  }
  return { x: x / points.length, y: y / points.length, z: z / points.length };
}
