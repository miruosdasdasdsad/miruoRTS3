import { MAP, BOUNDS, BASES, CAPTURE_SITE, CACHE_SITES, TERRAIN, OBSTACLES, circleIntersectsPolygon, segmentDistanceSq } from './terrain.js';

export const MAP_KIND = 'prism-rts-map';
export const MAP_VERSION = 1;
export const MAP_LIMITS = Object.freeze({ terrain: 64, obstacles: 128, caches: 32, neutralCores: 32, vertices: 48 });
const clone = value => JSON.parse(JSON.stringify(value));
const finite = value => typeof value === 'number' && Number.isFinite(value);
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const center = points => ({ x: points.reduce((sum, p) => sum + p[0], 0) / points.length, y: points.reduce((sum, p) => sum + p[1], 0) / points.length });
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

export const DEFAULT_MAP = freeze({
  kind: MAP_KIND, version: MAP_VERSION, name: '棱镜战场', size: { ...MAP },
  bases: clone(BASES),
  terrain: TERRAIN.map(item => ({ ...clone(item), label: center(item.points) })),
  obstacles: OBSTACLES.map((item, index) => ({ id: `rock-${index + 1}`, ...item })),
  caches: CACHE_SITES.map((item, index) => ({ id: `cache-${index + 1}`, ...item })),
  neutralCores: [], captureSite: { ...CAPTURE_SITE }
});

export function spawnFootprints(base) {
  return [{ x: base.x, y: base.y, r: 85 }, { x: base.x - 55, y: base.y + 125, r: 27 }, { x: base.x + 35, y: base.y + 155, r: 27 }];
}

export function validateMap(input) {
  const errors = [];
  const fail = message => { if (errors.length < 16) errors.push(message); };
  const invalid = () => ({ ok: false, value: null, errors });
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.kind !== MAP_KIND || input.version !== MAP_VERSION) {
    fail('请选择版本 1 的棱镜地图 JSON，数值配置和战场快照不能作为地图导入。'); return invalid();
  }
  if (input.size?.w !== MAP.w || input.size?.h !== MAP.h) fail(`地图尺寸必须为 ${MAP.w} × ${MAP.h}。`);
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 60) fail('地图名称需为 1–60 个字符。');
  if (!Array.isArray(input.bases) || input.bases.length !== 2) fail('地图必须保留我方和敌方两个出生点。');
  for (const key of ['terrain', 'obstacles', 'caches', 'neutralCores']) {
    if (!Array.isArray(input[key]) || input[key].length > MAP_LIMITS[key]) fail(`${{ terrain: '地形', obstacles: '岩石', caches: '中立仓库', neutralCores: '中立核心' }[key]}数量上限为 ${MAP_LIMITS[key]}。`);
  }
  if (errors.length) return invalid();
  const ids = new Set();
  const identify = (item, label) => {
    if (!item || typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(item.id) || ids.has(item.id)) fail(`${label}需要唯一的字母、数字或短横线 ID。`);
    else ids.add(item.id);
  };
  const position = (item, radius, label) => {
    if (!item || !finite(item.x) || !finite(item.y) || !finite(radius) ||
      item.x - radius < BOUNDS.left || item.x + radius > BOUNDS.right || item.y - radius < BOUNDS.top || item.y + radius > BOUNDS.bottom) {
      fail(`${label}超出可用战场边界，或坐标无效。`); return false;
    }
    return true;
  };
  const bases = input.bases.map((base, index) => {
    const label = index ? '敌方出生点' : '我方出生点';
    if (position(base, 85, label)) for (const p of spawnFootprints(base).slice(1)) position(p, p.r, `${label}的初始核心`);
    return { x: base?.x, y: base?.y };
  });
  if (distance(bases[0], bases[1]) < 300) fail('双方出生点至少需要相距 300，以留出初始基地和核心空间。');
  const terrain = input.terrain.map((item, index) => {
    const label = `地形 ${index + 1}`;
    identify(item, label);
    if (!['water', 'ridge'].includes(item?.kind)) fail(`${label}类型只能是湖泊或岩壁。`);
    if (typeof item?.name !== 'string' || !item.name.trim() || item.name.length > 60) fail(`${label}名称需为 1–60 个字符。`);
    const points = item?.points;
    if (!Array.isArray(points) || points.length < 3 || points.length > MAP_LIMITS.vertices ||
      points.some(p => !Array.isArray(p) || p.length !== 2 || !finite(p[0]) || !finite(p[1]) || p[0] < BOUNDS.left || p[0] > BOUNDS.right || p[1] < BOUNDS.top || p[1] > BOUNDS.bottom)) {
      fail(`${label}需要 3–${MAP_LIMITS.vertices} 个位于战场边界内的有效顶点。`); return null;
    }
    let twiceArea = 0, malformed = false;
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length];
      twiceArea += a[0] * b[1] - b[0] * a[1];
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 2) malformed = true;
      for (let j = i + 2; j < points.length; j++) {
        if (i === 0 && j === points.length - 1) continue;
        const c = points[j], d = points[(j + 1) % points.length];
        if (segmentDistanceSq({ x: a[0], y: a[1] }, { x: b[0], y: b[1] }, { x: c[0], y: c[1] }, { x: d[0], y: d[1] }) < 1e-8) malformed = true;
      }
    }
    if (Math.abs(twiceArea) < 200 || malformed) fail(`${label}的顶点不能交叉、重合或形成过小的面积。`);
    return { id: item.id, kind: item.kind, name: item.name.trim(), points: points.map(p => [...p]), label: center(points) };
  });
  const circles = (key, radius) => input[key].map((item, index) => {
    const label = `${{ obstacles: '岩石', caches: '中立仓库', neutralCores: '中立核心' }[key]} ${index + 1}`;
    identify(item, label);
    const r = key === 'obstacles' ? item?.r : radius;
    if (key === 'obstacles' && (!finite(r) || r < 15 || r > 300)) fail(`${label}半径需为 15–300。`);
    position(item, r, label);
    return { id: item?.id, x: item?.x, y: item?.y, ...(key === 'obstacles' ? { r } : {}) };
  });
  const obstacles = circles('obstacles');
  const caches = circles('caches', 48);
  const neutralCores = circles('neutralCores', 15);
  let captureSite = null;
  if (input.captureSite !== null) {
    const point = input.captureSite;
    if (!finite(point?.r) || point.r < 65 || point.r > 400) fail('据点半径需为 65–400；不需要据点时可删除。');
    position(point, point?.r, '中立据点');
    captureSite = { x: point?.x, y: point?.y, r: point?.r };
  }
  if (errors.length) return invalid();
  const blocked = p => obstacles.some(o => distance(p, o) <= p.r + o.r) || terrain.some(t => circleIntersectsPolygon(p, p.r, t.points));
  const reserved = [];
  bases.forEach((base, index) => spawnFootprints(base).forEach(p => reserved.push({ ...p, label: `${index ? '敌方' : '我方'}出生区` })));
  caches.forEach((p, index) => reserved.push({ ...p, r: 58, label: `中立仓库 ${index + 1}` }));
  neutralCores.forEach((p, index) => reserved.push({ ...p, r: 25, label: `中立核心 ${index + 1}` }));
  if (captureSite) reserved.push({ ...captureSite, label: '中立据点' });
  for (let i = 0; i < reserved.length; i++) {
    const p = reserved[i];
    if (blocked(p)) fail(`${p.label}与湖泊、岩壁或岩石重叠，请移动物件或地形。`);
    for (let j = 0; j < i; j++) {
      const other = reserved[j];
      if (p.label === other.label) continue;
      if (distance(p, other) < p.r + other.r) { fail(`${p.label}与${other.label}重叠，请留出空间。`); break; }
    }
  }
  if (errors.length) return invalid();
  return { ok: true, errors: [], value: { kind: MAP_KIND, version: MAP_VERSION, name: input.name.trim(), size: { ...MAP }, bases, terrain, obstacles, caches, neutralCores, captureSite } };
}

export function createMap(input = DEFAULT_MAP) {
  const result = validateMap(input);
  if (!result.ok) throw new Error(result.errors.join('；'));
  return result.value;
}
