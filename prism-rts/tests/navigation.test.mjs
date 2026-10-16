import test from 'node:test';
import assert from 'node:assert/strict';
import { World, TERRAIN, UNITS, distance } from '../dist/engine.js';
import { MAP, BOUNDS, BASES, CAPTURE_SITE, CACHE_SITES, circleIntersectsPolygon, segmentIntersectsPolygon, pointInPolygon } from '../dist/terrain.js';

const world = options => new World({ ai: false, rate: 0, objectives: false, bases: [{ x: 370, y: 800 }, { x: 2030, y: 800 }], ...options });
const advance = (w, seconds, verify = () => {}) => { for (let i = 0; i < seconds * 30; i++) { w.update(1 / 30); verify(); } };
const assertRoute = (w, start, path) => {
  assert.ok(path.length, 'expected a reachable path'); let from = start;
  for (const p of path) { assert.ok(w.segmentClear(from, p, start.r), JSON.stringify({ from, p })); from = p; }
};
const divider = { id: 'divider', kind: 'ridge', name: '测试岩壁', points: [[1099, BOUNDS.top], [1101, BOUNDS.top], [1101, BOUNDS.bottom], [1099, BOUNDS.bottom]] };

test('terrain includes water and cliffs, and their interiors and footprint edges block units and construction', () => {
  const w = world();
  assert.deepEqual(new Set(TERRAIN.map(t => t.kind)), new Set(['water', 'ridge']));
  for (const t of TERRAIN) {
    assert.equal(w.terrainAt(t.label.x, t.label.y), t);
    for (const radius of [0, 10, 15, 19, 56]) assert.equal(w.walkable(t.label.x, t.label.y, radius), false);
  }
  const lake = { id: 'local-lake', kind: 'water', name: '湖泊', points: [[650, 550], [800, 550], [800, 700], [650, 700]] };
  const local = world({ terrain: [lake], obstacles: [] });
  assert.equal(local.placement(0, 'power', 700, 600).ok, false);
  assert.match(local.placement(0, 'power', 605, 600).reason, /不可.*建造/);
  assert.equal(local.placement(0, 'power', 550, 610).ok, true);
});

test('analytic geometry catches thin walls, collinear edges, corner contact and radius clearance', () => {
  const square = [[100, 100], [200, 100], [200, 200], [100, 200]];
  assert.equal(pointInPolygon({ x: 150, y: 100 }, square), true);
  assert.equal(segmentIntersectsPolygon({ x: 50, y: 100 }, { x: 250, y: 100 }, 0, square), true);
  assert.equal(segmentIntersectsPolygon({ x: 50, y: 50 }, { x: 150, y: 150 }, 0, square), true);
  assert.equal(circleIntersectsPolygon({ x: 90, y: 150 }, 10, square), true);
  assert.equal(circleIntersectsPolygon({ x: 89, y: 150 }, 10, square), false);
  const w = world({ terrain: [divider], obstacles: [] });
  assert.equal(w.segmentClear({ x: 1000, y: 805 }, { x: 1300, y: 805 }, 0), false);
});

test('infantry, cores, tanks and heavy tanks can cross the basin through central and outer routes with safe segments', () => {
  const w = world({ bases: BASES });
  for (const r of [10, 15, 19, UNITS.heavyTank.r]) for (const y of [320, CAPTURE_SITE.y, MAP.h - 320]) {
    const start = { x: BASES[0].x + 200, y, r }, goal = { x: BASES[1].x - 200, y };
    assertRoute(w, start, w.findPath(start, goal));
  }
});

test('the expanded battlefield has a wide direct middle lane and clear reachable objective sites', () => {
  const w = world({ bases: BASES });
  assert.equal(MAP.w, 3600);
  assert.equal(MAP.h, 2400);
  assert.ok(MAP.w * MAP.h >= 2400 * 1600 * 2);
  // A heavy vehicle can cross at any of these rows across a 600-unit band.
  for (let y = CAPTURE_SITE.y - 300; y <= CAPTURE_SITE.y + 300; y += 25) {
    assert.equal(w.segmentClear({ x: 650, y }, { x: MAP.w - 650, y }, UNITS.heavyTank.r), true, `lane blocked at ${y}`);
  }
  assert.equal(w.walkable(CAPTURE_SITE.x, CAPTURE_SITE.y, CAPTURE_SITE.r), true);
  assert.equal(CACHE_SITES.length, 4);
  for (const site of CACHE_SITES) {
    assert.equal(w.walkable(site.x, site.y, 60), true);
    assert.ok(Math.abs(site.y - CAPTURE_SITE.y) > CAPTURE_SITE.r + 250, 'cache is off the main combat lane');
    assert.ok(CACHE_SITES.some(other => other.x === MAP.w - site.x && other.y === MAP.h - site.y), 'cache has a symmetric counterpart');
    for (const base of BASES) {
      const start = { x: base.x + (base.x < MAP.w / 2 ? 120 : -120), y: base.y, r: UNITS.heavyTank.r };
      assertRoute(w, start, w.findPath(start, site));
    }
  }
});

test('blocked goal cells resolve to reachable land, and movement never enters the water or cliffs', () => {
  const w = world(), u = w.addUnit('tank', 0, 850, 720), goal = TERRAIN[0].label;
  const result = w.command([u.id], goal.x, goal.y);
  assert.equal(result.ok, true); assert.equal(result.adjusted, true);
  const dest = { ...u.dest }; assert.ok(w.walkable(dest.x, dest.y, u.r)); assertRoute(w, u, u.path);
  advance(w, 30, () => assert.ok(w.walkable(u.x, u.y, u.r)));
  assert.ok(distance(u, dest) < .01); assert.equal(u.path.length, 0);
});

test('unreachable commands preserve current orders and core docking instead of reporting success', () => {
  const w = world({ terrain: [divider], obstacles: [] }), u = w.addUnit('infantry', 0, 700, 700);
  assert.equal(w.command([u.id], 900, 700).ok, true);
  const path = structuredClone(u.path), dest = { ...u.dest };
  const result = w.command([u.id], 1500, 700);
  assert.equal(result.ok, false); assert.equal(result.accepted, 0); assert.deepEqual(u.path, path); assert.deepEqual(u.dest, dest);
  const core = w.cores(0)[0], dock = core.dock;
  const producer = w.addBuilding('barracks', 0, 1500, 700);
  assert.equal(w.assign(core.id, producer.id).ok, false);
  assert.equal(core.dock, dock); assert.equal(w.byId(dock).core, core.id);
});

test('a completely blocked area has no fabricated fallback coordinate', () => {
  const terrain = [{ points: [[BOUNDS.left, BOUNDS.top], [BOUNDS.right, BOUNDS.top], [BOUNDS.right, BOUNDS.bottom], [BOUNDS.left, BOUNDS.bottom]] }];
  const w = world({ terrain, obstacles: [] });
  assert.equal(w.freePosition(1200, 800, 19), null);
  assert.equal(w.addUnit('tank', 0, 1200, 800), null);
  assert.deepEqual(w.findPath({ x: 1200, y: 800, r: 19 }, { x: 1400, y: 800 }), []);
});

test('the last movement step and a large time step cannot tunnel through a thin wall', () => {
  const w = world({ terrain: [divider], obstacles: [] }), u = w.addUnit('tank', 0, 1000, 800);
  u.path = [{ x: 1200, y: 800 }]; u.dest = u.path[0]; u.moveSpeed = 1000; u.repath = 1;
  w.move(u, .2, 1000);
  assert.equal(u.x, 1000); assert.ok(w.walkable(u.x, u.y, u.r));
  assert.equal(u.path.length, 1, 'a blocked final waypoint must not be consumed');
});

test('cached navigation responds to newly constructed and destroyed buildings', () => {
  const w = world({ terrain: [], obstacles: [] }), start = { x: 650, y: 700, r: 19 }, goal = { x: 1100, y: 700 };
  w.addBuilding('factory', 0, 800, 700);
  assertRoute(w, start, w.findPath(start, goal));
  const b = w.addBuilding('factory', 0, 950, 760);
  assertRoute(w, start, w.findPath(start, goal));
  b.hp = 0;
  assertRoute(w, start, w.findPath(start, goal));
});

test('large mixed formations get non-overlapping destinations and all tanks arrive safely', () => {
  const w = world(), units = Array.from({ length: 12 }, (_, i) => w.addUnit(i % 3 ? 'tank' : 'infantry', 0, 750 + i % 3 * 48, 760 + Math.floor(i / 3) * 48));
  const result = w.command(units.map(u => u.id).reverse(), 1540, 820);
  assert.equal(result.accepted, units.length);
  const destinations = units.map(u => ({ ...u.dest, r: u.r }));
  destinations.forEach((p, i) => destinations.slice(i + 1).forEach(q => assert.ok(distance(p, q) >= p.r + q.r + 4 - 1e-6)));
  advance(w, 40, () => units.forEach(u => assert.ok(w.walkable(u.x, u.y, u.r))));
  units.forEach((u, i) => assert.ok(distance(u, destinations[i]) < .1, JSON.stringify({ unit: u.id, position: { x: u.x, y: u.y }, destination: destinations[i] })));
});

test('a full mixed 60-unit army crosses the enlarged central lane without permanent traffic jams', () => {
  const w = world({ bases: BASES });
  w.base(1).hp = 0; // Keep long-range artillery from starting combat near the destination.
  const unitTypes = ['infantry', 'tank', 'heavyTank', 'artillery', 'scout', 'striker'];
  const units = Array.from({ length: 60 }, (_, i) => w.addUnit(unitTypes[i % unitTypes.length], 0, 700 + i % 8 * 62, 1000 + Math.floor(i / 8) * 62));
  assert.equal(w.command(units.map(e => e.id), 2650, CAPTURE_SITE.y).accepted, 60);
  const goals = units.map(e => ({ ...e.dest })); let step = 0;
  advance(w, 110, () => { if (++step % 25 === 0) units.forEach(e => assert.ok(w.walkable(e.x, e.y, e.r))); });
  units.forEach((e, i) => assert.ok(distance(e, goals[i]) < .1, `unit ${e.id} failed to arrive`));
});

test('temporary traffic detours leave the shared navigation grid usable for later orders', () => {
  const w = world({ terrain: [], obstacles: [] }), start = { x: 650, y: 700, r: 19 }, goal = { x: 1100, y: 700 };
  const path = w.navigation.findPath(start, goal, null, [{ x: 800, y: 700, r: 19 }]);
  assert.ok(path.length > 1); assertRoute(w, start, path);
  assert.deepEqual(w.findPath(start, goal), [goal]);
});

test('Shift orders run in sequence, ordinary orders replace the queue, and stop clears all movement', () => {
  const w = world(), u = w.addUnit('infantry', 0, 600, 1080);
  const goals = [{ x: 730, y: 1080 }, { x: 850, y: 1080 }, { x: 850, y: 950 }];
  w.command([u.id], goals[0].x, goals[0].y);
  for (const p of goals.slice(1)) assert.equal(w.command([u.id], p.x, p.y, null, false, true).queued, 1);
  let seen = 0;
  advance(w, 12, () => { if (seen < goals.length && distance(u, goals[seen]) < .01) seen++; });
  assert.equal(seen, 3); assert.equal(u.orders.length, 0);
  w.command([u.id], 900, 900); w.command([u.id], 1000, 900, null, false, true);
  w.command([u.id], 850, 1000); assert.equal(u.orders.length, 0);
  advance(w, .2); w.stop([u.id]); const stopped = { x: u.x, y: u.y };
  advance(w, 2); assert.equal(distance(u, stopped), 0); assert.equal(u.dest, null); assert.equal(u.path.length, 0); assert.equal(u.moveSpeed, 0);
});

test('command queues are bounded and rejected additions preserve the accepted queue', () => {
  const w = world(), u = w.addUnit('infantry', 0, 600, 1080);
  w.command([u.id], 850, 1080);
  for (let i = 0; i < 12; i++) assert.equal(w.command([u.id], 850, 950, null, false, true).queued, 1);
  assert.equal(w.command([u.id], 850, 950, null, false, true).ok, false); assert.equal(u.orders.length, 12);
  w.stop([u.id]); assert.equal(u.orders.length, 0);
});

test('a queued core move undocks after transport and keeps its energy', () => {
  const w = world(), b = w.addBuilding('barracks', 0, 650, 1000), c = w.cores(0)[1]; c.energy = 317;
  assert.equal(w.assign(c.id, b.id).ok, true);
  assert.equal(w.command([c.id], 850, 1050, null, false, true).queued, 1);
  advance(w, 15);
  assert.equal(c.dock, null); assert.equal(b.core, null); assert.equal(c.energy, 317); assert.ok(distance(c, { x: 850, y: 1050 }) < .01);
});

test('attack move resumes its destination after a skirmish and production spawns on free land', () => {
  const w = world(), u = w.addUnit('infantry', 0, 700, 1020), enemy = w.addUnit('infantry', 1, 850, 1020);
  enemy.stance = 'hold'; w.config.invincible = true;
  w.command([u.id], 1000, 820, null, true); const goal = { ...u.dest };
  advance(w, 35); assert.equal(enemy.hp, 0); assert.ok(distance(u, goal) < .1);
  const producer = w.addBuilding('barracks', 0, 950, 580), c = w.cores(0)[1];
  const corePosition = w.freePosition(producer.x, producer.y + producer.r + 30, c.r); c.x = corePosition.x; c.y = corePosition.y;
  assert.equal(w.assign(c.id, producer.id).ok, true); advance(w, 3); w.enqueue(producer.id, 'infantry'); advance(w, UNITS.infantry.time + 1);
  assert.equal(w.all(0, 'unit').length, 2); w.all(0, 'unit').forEach(e => assert.ok(w.walkable(e.x, e.y, e.r)));
});

test('successive production orders reserve separate destinations around a shared rally point', () => {
  const w = world(), b = w.addBuilding('barracks', 0, 650, 1000), c = w.cores(0)[1]; c.energy = 1000; b.rally = { x: 900, y: 1000 };
  w.assign(c.id, b.id); advance(w, 8);
  for (let i = 0; i < 8; i++) w.enqueue(b.id, 'infantry');
  advance(w, 45); const units = w.all(0, 'unit'); assert.equal(units.length, 8);
  units.forEach((u, i) => {
    assert.equal(u.path.length, 0); assert.ok(distance(u, b.rally) < 150); assert.ok(w.walkable(u.x, u.y, u.r));
    units.slice(i + 1).forEach(other => assert.ok(distance(u, other) >= u.r + other.r + 2 - .01));
  });
});

test('diagnostic exports include the shared map and queued commands', () => {
  const w = world(), u = w.addUnit('tank', 0, 800, 800); w.command([u.id], 1000, 820); w.command([u.id], 1500, 820, null, false, true);
  const snapshot = w.snapshot(); assert.deepEqual(snapshot.map.terrain, TERRAIN); assert.equal(snapshot.entities.find(e => e.id === u.id).orders.length, 1);
});
