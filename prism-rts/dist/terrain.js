// Rendering, placement and navigation share these exact terrain footprints.
export const MAP = { w: 3600, h: 2400 };
export const BOUNDS = { left: 105, top: 135, right: MAP.w - 105, bottom: MAP.h - 115 };
export const BASES = [{ x: 420, y: 1200 }, { x: 3180, y: 1200 }];
export const CAPTURE_SITE = { x: 1800, y: 1200, r: 170 };
export const CACHE_SITES = [{ x: 1100, y: 600 }, { x: 2500, y: 600 }, { x: 1100, y: 1800 }, { x: 2500, y: 1800 }];
// Keep a 700-unit open middle lane and broad northern/southern approaches.
// The side caches sit clear of terrain and outside the shortest base-to-base route.
export const OBSTACLES = [
  { x: 620, y: 500, r: 70 }, { x: 2980, y: 1900, r: 70 },
  { x: 920, y: 300, r: 65 }, { x: 2680, y: 2100, r: 65 },
  { x: 2650, y: 300, r: 70 }, { x: 950, y: 2100, r: 70 },
  { x: 1750, y: 300, r: 60 }, { x: 1850, y: 2100, r: 60 }
];
const northLake = [[1490, 440], [1760, 405], [2070, 455], [2180, 595], [2080, 715], [1770, 755], [1540, 695], [1430, 555]];
const northRidge = [[1270, 670], [1420, 705], [1490, 775], [1430, 850], [1270, 835], [1195, 755]];
const mirror = points => points.map(([x, y]) => [MAP.w - x, MAP.h - y]);
export const TERRAIN = [
  { id: 'north-lake', kind: 'water', name: '北部湖泊', points: northLake, label: { x: 1800, y: 575 } },
  { id: 'south-lake', kind: 'water', name: '南部湖泊', points: mirror(northLake), label: { x: 1800, y: 1825 } },
  { id: 'north-ridge', kind: 'ridge', name: '北侧岩壁', points: northRidge, label: { x: 1350, y: 765 } },
  { id: 'south-ridge', kind: 'ridge', name: '南侧岩壁', points: mirror(northRidge), label: { x: 2250, y: 1635 } }
];
const boundsCache = new WeakMap();
export function polygonBounds(points) {
  if (!boundsCache.has(points)) boundsCache.set(points, {
    left: Math.min(...points.map(p => p[0])), right: Math.max(...points.map(p => p[0])),
    top: Math.min(...points.map(p => p[1])), bottom: Math.max(...points.map(p => p[1]))
  });
  return boundsCache.get(points);
}

export function pointSegmentDistanceSq(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length)) : 0;
  return (p.x - a.x - t * dx) ** 2 + (p.y - a.y - t * dy) ** 2;
}
export function pointInPolygon(p, points) {
  const bounds = polygonBounds(points);
  if (p.x < bounds.left || p.x > bounds.right || p.y < bounds.top || p.y > bounds.bottom) return false;
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [ax, ay] = points[i], [bx, by] = points[j];
    if (pointSegmentDistanceSq(p, { x: ax, y: ay }, { x: bx, y: by }) < 1e-10) return true;
    if ((ay > p.y) !== (by > p.y) && p.x < (bx - ax) * (p.y - ay) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}
function cross(a, b, c) { return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x); }
export function segmentDistanceSq(a, b, c, d) {
  const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
  if (((abC > 0 && abD < 0) || (abC < 0 && abD > 0)) && ((cdA > 0 && cdB < 0) || (cdA < 0 && cdB > 0))) return 0;
  return Math.min(pointSegmentDistanceSq(a, c, d), pointSegmentDistanceSq(b, c, d), pointSegmentDistanceSq(c, a, b), pointSegmentDistanceSq(d, a, b));
}
export function circleIntersectsPolygon(p, radius, points) {
  const bounds = polygonBounds(points);
  if (p.x + radius < bounds.left || p.x - radius > bounds.right || p.y + radius < bounds.top || p.y - radius > bounds.bottom) return false;
  if (pointInPolygon(p, points)) return true;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    if (pointSegmentDistanceSq(p, { x: a[0], y: a[1] }, { x: b[0], y: b[1] }) <= radius * radius + 1e-8) return true;
  }
  return false;
}
export function segmentIntersectsPolygon(a, b, radius, points) {
  const bounds = polygonBounds(points);
  if (Math.max(a.x, b.x) + radius < bounds.left || Math.min(a.x, b.x) - radius > bounds.right || Math.max(a.y, b.y) + radius < bounds.top || Math.min(a.y, b.y) - radius > bounds.bottom) return false;
  if (pointInPolygon(a, points) || pointInPolygon(b, points)) return true;
  for (let i = 0; i < points.length; i++) {
    const c = points[i], d = points[(i + 1) % points.length];
    if (segmentDistanceSq(a, b, { x: c[0], y: c[1] }, { x: d[0], y: d[1] }) <= radius * radius + 1e-8) return true;
  }
  return false;
}
export function terrainAt(x, y, terrain = TERRAIN, obstacles = OBSTACLES) {
  const p = { x, y };
  return terrain.find(t => pointInPolygon(p, t.points)) ||
    obstacles.find(o => Math.hypot(o.x - x, o.y - y) <= o.r) || null;
}
