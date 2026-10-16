import test from 'node:test';
import assert from 'node:assert/strict';
import { World, BUILDINGS, UNITS, BASES, CACHE_SITES, CAPTURE_SITE, CORE_PICKUP_RADIUS, distance } from '../dist/engine.js';

const sim = options => new World({ ai: false, rate: 0, terrain: [], obstacles: [], ...options });
const advance = (world, seconds, dt = 0.1) => {
  for (let i = 0; i < Math.round(seconds / dt); i++) world.update(dt);
};
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} != ${expected}`);
const cacheFor = world => world.all(-1, 'building').find(building => building.type === 'cache');
function dropCore(world) {
  const cache = cacheFor(world);
  world.damage(cache, cache.hp, world.base(0));
  return world.cores(-1).at(-1);
}

test('default battlefield contains four neutral caches and a nonblocking central capture point', () => {
  const world = new World({ ai: false }), caches = world.all(-1, 'building'), point = world.capturePoint;
  assert.equal(caches.length, 4);
  assert.deepEqual(caches.map(({ x, y }) => ({ x, y })), CACHE_SITES);
  for (const cache of caches) {
    assert.equal(cache.type, 'cache');
    assert.equal(cache.hp, 480);
    assert.equal(cache.core, null);
    assert.equal(world.assign(world.cores(0)[1].id, cache.id).ok, false);
  }
  assert.equal(BUILDINGS.cache.buildable, false);
  assert.equal(BUILDINGS.cache.acceptsCore, false);
  assert.equal(world.startBuilding(0, 'cache').ok, false);
  assert.equal(world.placement(0, 'cache', 750, 1000).ok, false);
  assert.equal(world.byId(point.id), point);
  assert.equal(point.kind, 'capture');
  assert.equal(point.team, -1);
  assert.deepEqual({ x: point.x, y: point.y, r: point.r }, CAPTURE_SITE);
  assert.equal(point.owner, null);
  assert.equal(point.duration, 180);
  assert.equal(point.progress, 0);
  assert.equal(point.contested, false);
  assert.deepEqual(point.occupants, [0, 0]);
  assert.deepEqual(point.rewards, [0, 0]);
  assert.equal(world.walkable(point.x, point.y, UNITS.heavyTank.r), true);
  assert.equal(world.segmentClear({ x: point.x - 250, y: point.y }, { x: point.x + 250, y: point.y }, UNITS.heavyTank.r), true);
  const isolated = sim({ objectives: false, bases: [{ x: 500, y: 1000 }, { x: 3000, y: 1400 }] });
  assert.equal(isolated.capturePoint, null);
  assert.equal(isolated.all(-1).length, 0);
  assert.equal(isolated.base(0).x, 500);
  assert.equal(isolated.base(1).y, 1400);
});

test('destroying a cache drops exactly one safe neutral zero-energy core without kills or victory', () => {
  const world = sim({ rate: 6 }), cache = cacheFor(world), attacker = world.base(0);
  world.damage(cache, 479, attacker);
  assert.equal(cache.hp, 1);
  assert.equal(world.cores(-1).length, 0);
  world.damage(cache, 1, attacker);
  const [core] = world.cores(-1);
  assert.ok(core);
  assert.equal(core.energy, 0);
  assert.equal(core.team, -1);
  assert.equal(core.dock, null);
  assert.equal(world.walkable(core.x, core.y, core.r), true);
  assert.ok(distance(core, cache) < 70);
  world.damage(cache, 1000, attacker);
  advance(world, 3);
  assert.equal(world.cores(-1).length, 1);
  assert.equal(core.energy, 0);
  assert.equal(world.stats[0].kills, 0);
  assert.equal(world.result, null);
  assert.equal(world.cores(0).length, 3);
  assert.equal(world.cores(1).length, 3);
});

test('intact neutral caches are not auto-attacked and can be explicitly attacked then physically looted on the actual map', () => {
  const world = new World({ ai: false, rate: 0 }), cache = cacheFor(world);
  const tank = world.addUnit('tank', 0, cache.x - 140, cache.y);
  advance(world, 3);
  assert.equal(cache.hp, 480);
  assert.equal(world.cores(-1).length, 0);
  const command = world.command([tank.id], cache.x, cache.y, cache.id, true);
  assert.equal(command.ok, true);
  for (let i = 0; i < 500 && cache.hp > 0; i++) world.update(0.1);
  assert.equal(cache.hp, 0);
  const [core] = world.cores(-1);
  assert.ok(core, 'a ranged attacker must walk to the dropped core');
  assert.equal(world.command([tank.id], core.x, core.y).ok, true);
  advance(world, 5);
  assert.equal(core.team, 0);
  assert.equal(world.cores(0).length, 4);
  assert.equal(core.energy, 0);
  assert.equal(world.stats[0].coresRecovered, 1);
});

test('neutral core pickup requires an uncontested combat unit within range and works for either faction', () => {
  for (const team of [0, 1]) {
    const world = sim({ rate: 6 }), core = dropCore(world);
    const unit = world.addUnit('infantry', team, core.x - CORE_PICKUP_RADIUS - 0.1, core.y);
    world.updateObjectives(0);
    assert.equal(core.team, -1);
    unit.x = core.x - CORE_PICKUP_RADIUS;
    const enemy = world.addUnit('infantry', 1 - team, core.x + 30, core.y);
    world.updateObjectives(0);
    assert.equal(core.team, -1, 'both teams contest pickup');
    enemy.hp = 0;
    world.updateObjectives(0);
    assert.equal(core.team, team);
    assert.equal(core.serial, 4);
    assert.equal(core.energy, 0);
    assert.equal(world.stats[team].coresRecovered, 1);
    advance(world, 1);
    assert.equal(core.energy, 6);
    world.updateObjectives(0);
    assert.equal(world.stats[team].coresRecovered, 1);
  }
});

test('buildings, other cores, dead units and troops behind a wall cannot recover a neutral core', () => {
  const wall = { id: 'pickup-wall', kind: 'ridge', points: [[1119, 550], [1121, 550], [1121, 650], [1119, 650]] };
  const world = sim({ terrain: [wall] }), core = dropCore(world);
  world.addCore(0, core.x, core.y, 100);
  const dead = world.addUnit('infantry', 0, core.x - 20, core.y);
  dead.hp = 0;
  world.addUnit('infantry', 0, core.x + 45, core.y);
  world.updateObjectives(1);
  assert.equal(core.team, -1);
  const building = world.addBuilding('power', 0, core.x - 60, core.y);
  world.updateObjectives(1);
  assert.equal(core.team, -1);
  assert.equal(building.core, null);
});

test('a captured core can travel, fund production and later pay for timed research from its own energy', () => {
  const world = sim({ rate: 6 }), core = dropCore(world);
  world.addUnit('infantry', 0, core.x - 30, core.y);
  world.updateObjectives(0);
  const producer = world.addBuilding('barracks', 0, core.x - 200, core.y + 200);
  assert.equal(world.assign(core.id, producer.id).ok, true);
  assert.equal(core.dock, null);
  advance(world, 8);
  assert.equal(core.dock, producer.id);
  const balance = core.energy, otherBalances = world.cores(0).filter(other => other !== core).map(other => other.energy);
  world.config.rate = 0;
  assert.equal(world.enqueue(producer.id, 'infantry').ok, true);
  advance(world, 0.1);
  assert.equal(core.energy, balance - UNITS.infantry.cost);
  assert.deepEqual(world.cores(0).filter(other => other !== core).map(other => other.energy), otherBalances);
  advance(world, UNITS.infantry.time);
  assert.equal(world.all(0, 'unit').length, 2);
  world.addBuilding('power', 0, 750, 1100);
  const academy = world.addBuilding('academy', 0, 1100, 1000);
  world.config.rate = 6;
  assert.equal(world.assign(core.id, academy.id).ok, true);
  advance(world, 30);
  assert.equal(core.dock, academy.id);
  world.config.rate = 0;
  const researchBalance = core.energy;
  assert.equal(world.research(academy.id).ok, true);
  assert.equal(core.energy, researchBalance - BUILDINGS.academy.technology.cost);
  assert.equal(world.technologyActive(0, 'academy'), false);
  advance(world, BUILDINGS.academy.technology.time + 0.1);
  assert.equal(world.technologyActive(0, 'academy'), true);
  assert.equal(world.stats[0].spent, UNITS.infantry.cost + BUILDINGS.academy.technology.cost);
});

test('the capture point ignores cores, buildings, dead units and units whose center is outside its radius', () => {
  const world = sim(), point = world.capturePoint;
  world.addCore(0, point.x, point.y, 0);
  world.addBuilding('power', 0, point.x, point.y - 80);
  const dead = world.addUnit('infantry', 0, point.x - 80, point.y);
  dead.hp = 0;
  const unit = world.addUnit('infantry', 0, point.x + point.r + 0.1, point.y);
  world.updateObjectives(1);
  assert.equal(point.owner, null);
  assert.equal(point.progress, 0);
  assert.deepEqual(point.occupants, [0, 0]);
  unit.x = point.x + point.r;
  world.updateObjectives(0.1);
  assert.equal(point.owner, 0);
  assert.deepEqual(point.occupants, [1, 0]);
  near(point.progress, 0.1);
  world.damage(point, 10000, unit);
  assert.equal(point.hp, 1);
  assert.equal(world.byId(point.id), point);
  assert.equal(world.result, null);
});

test('uncontested capture awards one zero-energy core exactly at 180 seconds and repeats without duplicate payouts', () => {
  for (const team of [0, 1]) {
    const world = sim({ rate: 6 }), point = world.capturePoint;
    const guard = world.addUnit('infantry', team, point.x, point.y);
    world.stop([guard.id]);
    advance(world, 179.9);
    assert.equal(point.owner, team);
    assert.equal(world.cores(team).length, 3);
    assert.equal(point.rewards[team], 0);
    near(point.progress, 179.9);
    world.update(0.1);
    const first = world.cores(team).at(-1);
    assert.equal(world.cores(team).length, 4);
    assert.equal(point.rewards[team], 1);
    assert.equal(first.energy, 0);
    assert.equal(first.team, team);
    assert.equal(world.walkable(first.x, first.y, first.r), true);
    assert.ok(distance(first, guard) >= first.r + guard.r + 4);
    near(point.progress, 0);
    advance(world, 179.9);
    assert.equal(world.cores(team).length, 4);
    world.update(0.1);
    const second = world.cores(team).at(-1);
    assert.equal(world.cores(team).length, 5);
    assert.equal(point.rewards[team], 2);
    assert.equal(second.energy, 0);
    assert.ok(distance(first, second) >= first.r + second.r + 4);
    assert.equal(world.stats[team].coresRecovered, 2);
    world.update(0.1);
    assert.equal(world.cores(team).length, 5);
    near(point.progress, 0.1);
  }
});

test('contesting freezes capture, resuming preserves it, but vacancy and enemy takeover reset it', () => {
  const world = sim(), point = world.capturePoint;
  const ally = world.addUnit('infantry', 0, point.x - 100, point.y);
  world.updateObjectives(40);
  assert.equal(point.owner, 0);
  assert.equal(point.progress, 40);
  const enemy = world.addUnit('infantry', 1, point.x + 100, point.y);
  world.updateObjectives(30);
  assert.equal(point.contested, true);
  assert.equal(point.owner, 0);
  assert.equal(point.progress, 40);
  assert.deepEqual(point.occupants, [1, 1]);
  enemy.x = point.x + point.r + 100;
  world.updateObjectives(2);
  assert.equal(point.contested, false);
  assert.equal(point.progress, 42);
  ally.x = point.x - point.r - 100;
  world.updateObjectives(2);
  assert.equal(point.owner, null);
  assert.equal(point.progress, 0);
  ally.x = point.x - 100;
  world.updateObjectives(10);
  enemy.x = point.x + 100;
  world.updateObjectives(20);
  assert.equal(point.progress, 10);
  ally.hp = 0;
  world.updateObjectives(0.1);
  assert.equal(point.owner, 1);
  near(point.progress, 0.1);
  assert.deepEqual(point.rewards, [0, 0]);
});

test('capture rewards follow simulation time and diagnostic JSON preserves neutral objects and objective progress', () => {
  const world = sim(), point = world.capturePoint, core = dropCore(world);
  world.addUnit('scout', 0, point.x, point.y);
  world.update(1000);
  near(point.progress, 0.2);
  const snapshot = world.snapshot(), json = JSON.parse(JSON.stringify(snapshot));
  assert.equal(json.capturePoint.id, point.id);
  assert.equal(json.capturePoint.owner, 0);
  near(json.capturePoint.progress, 0.2);
  assert.equal(json.entities.find(entity => entity.id === core.id).team, -1);
  assert.equal(json.entities.filter(entity => entity.type === 'cache').length, 3);
  assert.equal(json.entities.find(entity => entity.id === point.id).kind, 'capture');
  snapshot.capturePoint.occupants[0] = 99;
  snapshot.capturePoint.rewards[0] = 99;
  assert.deepEqual(point.occupants, [1, 0]);
  assert.deepEqual(point.rewards, [0, 0]);
});

test('AI on the actual enlarged map recovers caches, repeatedly holds the point and completes research with surplus cores', () => {
  const world = new World({ difficulty: 'normal', invincible: true });
  assert.equal(world.base(0).x, BASES[0].x);
  assert.equal(world.base(1).x, BASES[1].x);
  advance(world, 600, 0.2);
  assert.ok(world.all(-1, 'building').length < CACHE_SITES.length, 'AI attacks neutral caches');
  assert.ok(world.capturePoint.rewards[1] >= 2, 'AI holds the point for multiple full cycles');
  assert.ok(world.cores(1).length > 3 + world.capturePoint.rewards[1], 'AI also physically collects cache cores');
  assert.ok(world.cores(1).every(core => !core.aiResearchTarget), 'completed research does not strand a borrowed core');
  for (const type of ['academy', 'mobility', 'arsenal']) assert.equal(world.technologyActive(1, type), true, type);
  assert.equal(world.grid(1).ok, true);
  assert.ok(world.cores(1).every(core => core.energy >= 0 && Number.isInteger(core.energy)));
});
