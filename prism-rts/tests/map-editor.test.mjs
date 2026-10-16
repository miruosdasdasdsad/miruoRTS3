import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MAP, MAP_LIMITS, createMap, validateMap, spawnFootprints } from '../dist/map-config.js';
import { mapObjects, mapObjectCenter, moveMapObject } from '../dist/map-editor.js';
import { MAP_KEY, readSavedMap, saveMap } from '../dist/lab-storage.js';
import { MAP, BOUNDS, polygonBounds, pointInPolygon } from '../dist/terrain.js';
import { World } from '../dist/engine.js';

const emptyMap = () => ({ ...createMap(), terrain: [], obstacles: [], caches: [], neutralCores: [], captureSite: null });
const advance = (world, seconds) => { for (let i = 0; i < seconds * 30; i++) world.update(1 / 30); };

test('default map round-trips, retains the battlefield layout, and creates independent editable drafts', () => {
  const draft = createMap();
  assert.deepEqual(draft, DEFAULT_MAP);
  assert.deepEqual(createMap(JSON.parse(JSON.stringify(draft))), draft);
  const world = new World({ ai: false, map: draft });
  assert.deepEqual(world.terrain, new World({ ai: false }).terrain.map(item => ({ ...item, label: draft.terrain.find(t => t.id === item.id).label })));
  assert.equal(world.all(-1, 'building').length, 4);
  assert.equal(world.capturePoint.x, 1800);
  assert.equal(world.cores(0).length, 3);
  draft.terrain[0].points[0][0] += 50;
  draft.bases[0].x = 550;
  assert.equal(world.base(0).x, 420);
  assert.equal(DEFAULT_MAP.bases[0].x, 420);
  assert.notEqual(world.terrain[0].points[0][0], draft.terrain[0].points[0][0]);
  assert.throws(() => { DEFAULT_MAP.bases[0].x = 1; });
});

test('map validation rejects malformed imports, unsupported sizes, nonfinite values and excessive geometry', () => {
  for (const input of [null, [], {}, { kind: 'prism-rts-match', version: 1 }]) assert.equal(validateMap(input).ok, false);
  for (const change of [
    map => { map.version = 2; }, map => { map.size.w = MAP.w + 1; }, map => { map.name = ''; },
    map => { map.bases.pop(); }, map => { map.bases[0].x = NaN; }, map => { map.bases[1] = { ...map.bases[0] }; },
    map => { map.obstacles[0].r = Infinity; }, map => { map.obstacles[0].r = -2; },
    map => { map.obstacles[0].x = BOUNDS.left; }, map => { map.caches[0].id = map.obstacles[0].id; },
    map => { map.caches = Array(MAP_LIMITS.caches + 1).fill(map.caches[0]); },
    map => { map.terrain[0].kind = 'lava'; }, map => { map.captureSite = undefined; }, map => { map.captureSite.r = 401; }
  ]) {
    const draft = createMap(); change(draft);
    assert.equal(validateMap(draft).ok, false, JSON.stringify(draft));
    assert.throws(() => createMap(draft));
  }
});

test('polygon validation catches self intersections, repeated vertices, zero area and off-map points', () => {
  for (const points of [
    [[1300, 1000], [1500, 1200], [1300, 1200], [1500, 1000]],
    [[1300, 1000], [1400, 1000], [1400, 1000], [1300, 1200]],
    [[1300, 1000], [1400, 1000], [1500, 1000]],
    [[0, 1000], [1400, 1000], [1500, 1200]],
    [[1300, 1000], [1400, '1000'], [1500, 1200]]
  ]) {
    const map = emptyMap(); map.terrain.push({ id: 'test', kind: 'ridge', name: '测试岩壁', points });
    assert.equal(validateMap(map).ok, false);
  }
  const map = emptyMap();
  map.terrain.push({ id: 'concave', kind: 'water', name: '凹形湖泊', points: [[1300, 900], [1600, 900], [1600, 1100], [1450, 1000], [1300, 1100]] });
  assert.equal(validateMap(map).ok, true);
});

test('validation protects both initial cores, neutral resources and capture space from overlaps', () => {
  const testOverlap = change => { const map = emptyMap(); change(map); assert.equal(validateMap(map).ok, false, JSON.stringify(map)); };
  testOverlap(map => { map.obstacles.push({ id: 'blocked-base', ...map.bases[0], r: 40 }); });
  testOverlap(map => { const core = spawnFootprints(map.bases[1])[2]; map.obstacles.push({ id: 'blocked-core', x: core.x, y: core.y, r: 40 }); });
  testOverlap(map => { map.caches.push({ id: 'bad-cache', ...map.bases[0] }); });
  testOverlap(map => { map.caches.push({ id: 'cache', x: 1300, y: 1200 }); map.neutralCores.push({ id: 'core', x: 1305, y: 1205 }); });
  testOverlap(map => { map.captureSite = { x: 1600, y: 1200, r: 170 }; map.caches.push({ id: 'cache', x: 1600, y: 1200 }); });
  testOverlap(map => { map.bases[0].y = BOUNDS.bottom - 100; });
  testOverlap(map => { map.terrain.push({ id: 'water', name: '湖泊', kind: 'water', points: [[1200, 1000], [1400, 1000], [1400, 1200], [1200, 1200]] }); map.caches.push({ id: 'cache', x: 1300, y: 1100 }); });
});

test('moving a footprint invalidates cached polygon bounds and clamps complete shapes and spawn cores to the battlefield', () => {
  const map = createMap(), polygon = map.terrain[0], key = `terrain:${polygon.id}`;
  const oldPoints = polygon.points, bounds = { ...polygonBounds(oldPoints) }, center = mapObjectCenter(mapObjects(map).find(item => item.key === key));
  moveMapObject(map, key, 200, 100);
  assert.notEqual(polygon.points, oldPoints);
  assert.equal(polygonBounds(polygon.points).left, bounds.left + 200);
  assert.equal(pointInPolygon({ x: center.x + 200, y: center.y + 100 }, polygon.points), true);
  moveMapObject(map, key, -10000, 10000);
  assert.equal(polygonBounds(polygon.points).left, BOUNDS.left);
  assert.equal(polygonBounds(polygon.points).bottom, BOUNDS.bottom);
  moveMapObject(map, 'base:0', -10000, 10000);
  for (const p of spawnFootprints(map.bases[0])) {
    assert.ok(p.x - p.r >= BOUNDS.left && p.x + p.r <= BOUNDS.right);
    assert.ok(p.y - p.r >= BOUNDS.top && p.y + p.r <= BOUNDS.bottom);
  }
  const rock = map.obstacles[0]; moveMapObject(map, `obstacles:${rock.id}`, 10000, -10000);
  assert.equal(rock.x + rock.r, BOUNDS.right);
  assert.equal(rock.y - rock.r, BOUNDS.top);
});

test('a custom map controls actual spawns, collision, construction and pathfinding without affecting other worlds', () => {
  const map = emptyMap();
  map.bases = [{ x: 500, y: 1500 }, { x: 3050, y: 1100 }];
  map.terrain = [{ id: 'lake', kind: 'water', name: '测试湖泊', points: [[680, 1400], [900, 1400], [900, 1600], [680, 1600]] }, { id: 'wall', kind: 'ridge', name: '隔断', points: [[1600, BOUNDS.top], [1640, BOUNDS.top], [1640, BOUNDS.bottom], [1600, BOUNDS.bottom]] }];
  const world = new World({ ai: false, map });
  assert.equal(world.base(0).x, 500); assert.equal(world.base(1).y, 1100);
  assert.equal(world.cores(0)[1].y, 1625);
  assert.equal(world.walkable(750, 1500, 15), false);
  assert.equal(world.placement(0, 'power', 750, 1500).ok, false);
  assert.deepEqual(world.findPath({ x: 1000, y: 1200, r: 23 }, { x: 2200, y: 1200 }), []);
  assert.equal(world.all(-1).length, 0);
  assert.equal(world.capturePoint, null);
  assert.equal(new World({ ai: false }).base(0).x, 420);
  assert.equal(world.snapshot().map.profile.name, map.name);
});

test('relocated neutral caches, loose cores and an optional capture point use the existing resource rules', () => {
  const map = emptyMap();
  map.caches.push({ id: 'cache-a', x: 900, y: 900 });
  map.neutralCores.push({ id: 'loose-a', x: 1300, y: 1300 });
  map.captureSite = { x: 2000, y: 1300, r: 120 };
  const world = new World({ ai: false, rate: 0, map, balance: { economy: { captureDuration: 10 } } });
  assert.equal(world.all(-1, 'building').length, 1);
  assert.equal(world.capturePoint.r, 120);
  const loose = world.cores(-1)[0];
  assert.equal(loose.energy, 0);
  world.addUnit('infantry', 0, loose.x + 35, loose.y);
  advance(world, .2);
  assert.equal(loose.team, 0); assert.equal(world.cores(0).length, 4);
  const cache = world.all(-1, 'building')[0];
  world.damage(cache, cache.hp, world.base(0));
  assert.equal(world.cores(-1).length, 1);
  world.addUnit('infantry', 0, 2000, 1300);
  advance(world, 10.2);
  assert.equal(world.capturePoint.rewards[0], 1);
  assert.equal(world.cores(0).length, 5);
  const isolated = new World({ ai: false, map, objectives: false });
  assert.equal(isolated.all(-1).length, 0); assert.equal(isolated.capturePoint, null);
});

test('AI still dispatches resource scavengers when a custom map has no capture point', () => {
  const map = emptyMap(); map.caches.push({ id: 'cache', x: 2500, y: 1200 });
  const world = new World({ ai: false, map }); world.time = 110;
  for (let i = 0; i < 10; i++) world.addUnit('infantry', 1, 2800 + (i % 3) * 45, 1100 + Math.floor(i / 3) * 45);
  world.runObjectiveAI();
  assert.equal(world.all(1, 'unit').filter(unit => unit.aiRole === 'cache').length, 2);
  assert.equal(world.all(1, 'unit').filter(unit => unit.aiRole === 'capture').length, 0);
});

test('AI expands and produces from a relocated corner spawn even when all preferred power plots are outside the map', () => {
  const map = emptyMap(); map.bases = [{ x: 3100, y: 1900 }, { x: 190, y: 220 }];
  const world = new World({ map, rate: 100, difficulty: 'easy' });
  advance(world, 100);
  for (const type of ['power', 'barracks', 'factory']) assert.ok(world.all(1, 'building').some(building => building.type === type), type);
  assert.ok(world.stats[1].produced > 0);
  assert.ok(world.grid(1).ok);
});

test('saved maps round-trip, reject corrupt imports without overwriting saved work, and leave running matches unchanged', () => {
  const data = new Map();
  globalThis.localStorage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  try {
    const original = new World({ ai: false });
    const draft = emptyMap(); draft.name = '自定义战场'; draft.bases[0] = { x: 550, y: 1400 };
    saveMap(draft);
    assert.deepEqual(readSavedMap(), createMap(draft));
    const next = new World({ ai: false, map: readSavedMap() });
    assert.equal(next.base(0).x, 550); assert.equal(original.base(0).x, 420);
    draft.bases[0].x = 0;
    assert.throws(() => saveMap(draft)); assert.equal(readSavedMap().bases[0].x, 550);
    data.set(MAP_KEY, '{bad'); assert.equal(readSavedMap(), null);
    data.set(MAP_KEY, JSON.stringify({ ...DEFAULT_MAP, version: 99 })); assert.equal(readSavedMap(), null);
    globalThis.localStorage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('quota'); } };
    assert.equal(readSavedMap(), null); assert.throws(() => saveMap(DEFAULT_MAP), /本地存储/);
  } finally { delete globalThis.localStorage; }
});
