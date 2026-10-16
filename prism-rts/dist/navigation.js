import { MAP, pointSegmentDistanceSq } from './terrain.js';

const STEP = 32, COLS = Math.ceil(MAP.w / STEP), ROWS = Math.ceil(MAP.h / STEP);
const DIRECTIONS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
const point = k => ({ x: (k % COLS) * STEP + STEP / 2, y: Math.floor(k / COLS) * STEP + STEP / 2 });
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

class MinHeap {
  constructor() { this.items = []; }
  push(item) {
    const items = this.items; let i = items.length; items.push(item);
    while (i > 0) { const parent = (i - 1) >> 1; if (items[parent].f <= item.f) break; items[i] = items[parent]; i = parent; }
    items[i] = item;
  }
  pop() {
    const items = this.items, first = items[0], last = items.pop();
    if (items.length) {
      let i = 0;
      while (i * 2 + 1 < items.length) {
        let child = i * 2 + 1;
        if (child + 1 < items.length && items[child + 1].f < items[child].f) child++;
        if (items[child].f >= last.f) break;
        items[i] = items[child]; i = child;
      }
      items[i] = last;
    }
    return first;
  }
}

export class Navigation {
  constructor(world) { this.world = world; this.cache = new Map(); this.stamp = ''; }
  invalidate() { this.cache.clear(); this.stamp = ''; }
  grid(radius, ignoreId) {
    // Also catches buildings removed or moved by sandbox code, not just normal construction.
    const stamp = this.world.all(null, 'building').map(b => `${b.id}:${b.x}:${b.y}:${b.r}`).join('|');
    if (stamp !== this.stamp) { this.cache.clear(); this.stamp = stamp; }
    const key = `${radius}:${ignoreId ?? ''}`;
    if (!this.cache.has(key)) {
      const free = new Uint8Array(COLS * ROWS);
      for (let k = 0; k < free.length; k++) { const p = point(k); free[k] = this.world.walkable(p.x, p.y, radius, ignoreId) ? 1 : 0; }
      this.cache.set(key, { free, edges: new Uint8Array(free.length), checked: new Uint8Array(free.length) });
    }
    return this.cache.get(key);
  }
  connections(p, grid, canSegment) {
    const result = [], x = Math.floor(p.x / STEP), y = Math.floor(p.y / STEP);
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const nx = x + dx, ny = y + dy, k = ny * COLS + nx;
      if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS || !grid.free[k]) continue;
      const q = point(k);
      if (canSegment(p, q)) result.push({ k, cost: distance(p, q) });
    }
    return result;
  }
  findPath(start, target, ignoreId = null, blockers = []) {
    const w = this.world, radius = start.r ?? 10, goal = w.freePosition(target.x, target.y, radius, ignoreId);
    if (!goal || !w.walkable(start.x, start.y, radius, ignoreId)) return [];
    const canSegment = (a, b) => w.segmentClear(a, b, radius, ignoreId) && blockers.every(o => {
      const clearance = radius + o.r + 3;
      if (pointSegmentDistanceSq(o, a, b) > clearance ** 2) return true;
      // A unit already pressed against a neighbour can leave the overlap moving outward.
      return distance(a, o) <= clearance && distance(b, o) > clearance && (a.x - o.x) * (b.x - a.x) + (a.y - o.y) * (b.y - a.y) > 0;
    });
    if (blockers.some(o => distance(goal, o) <= radius + o.r + 3)) return [];
    if (canSegment(start, goal)) return [goal];
    let grid = this.grid(radius, ignoreId);
    if (blockers.length) {
      // Local traffic is a temporary overlay; it never contaminates the static cache.
      grid = { free: grid.free.slice(), edges: new Uint8Array(grid.free.length), checked: new Uint8Array(grid.free.length) };
      for (const o of blockers) {
        const clearance = radius + o.r + 3;
        for (let y = Math.max(0, Math.floor((o.y - clearance) / STEP)); y <= Math.min(ROWS - 1, Math.floor((o.y + clearance) / STEP)); y++) {
          for (let x = Math.max(0, Math.floor((o.x - clearance) / STEP)); x <= Math.min(COLS - 1, Math.floor((o.x + clearance) / STEP)); x++) {
            const k = y * COLS + x; if (distance(point(k), o) <= clearance) grid.free[k] = 0;
          }
        }
      }
    }
    const starts = this.connections(start, grid, canSegment);
    const ends = new Set(this.connections(goal, grid, canSegment).map(c => c.k));
    if (!starts.length || !ends.size) return [];
    const costs = new Float64Array(grid.free.length).fill(Infinity), parents = new Int32Array(grid.free.length).fill(-1);
    const closed = new Uint8Array(grid.free.length), open = new MinHeap();
    for (const s of starts) { costs[s.k] = s.cost; open.push({ k: s.k, g: s.cost, f: s.cost + distance(point(s.k), goal) }); }
    let found = -1;
    while (open.items.length) {
      const node = open.pop(), k = node.k;
      if (closed[k] || node.g > costs[k]) continue;
      if (ends.has(k)) { found = k; break; }
      closed[k] = 1;
      const x = k % COLS, y = Math.floor(k / COLS), from = point(k);
      for (let i = 0; i < DIRECTIONS.length; i++) {
        const [dx, dy] = DIRECTIONS[i], nx = x + dx, ny = y + dy, next = ny * COLS + nx, bit = 1 << i;
        if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS || !grid.free[next] || closed[next]) continue;
        if (!(grid.checked[k] & bit)) {
          grid.checked[k] |= bit;
          if ((!dx || !dy || (grid.free[y * COLS + nx] && grid.free[ny * COLS + x])) && canSegment(from, point(next))) grid.edges[k] |= bit;
        }
        if (!(grid.edges[k] & bit)) continue;
        const cost = node.g + STEP * (dx && dy ? Math.SQRT2 : 1);
        if (cost >= costs[next]) continue;
        costs[next] = cost; parents[next] = k;
        open.push({ k: next, g: cost, f: cost + distance(point(next), goal) });
      }
    }
    if (found < 0) return [];
    const route = [goal];
    for (let k = found; k >= 0; k = parents[k]) route.unshift(point(k));
    const smooth = []; let from = start, i = 0;
    while (i < route.length) {
      let j = route.length - 1;
      while (j > i && !canSegment(from, route[j])) j--;
      if (!canSegment(from, route[j])) return [];
      smooth.push(route[j]); from = route[j]; i = j + 1;
    }
    return smooth;
  }
}
