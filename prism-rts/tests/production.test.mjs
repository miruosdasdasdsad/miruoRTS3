import test from 'node:test';
import assert from 'node:assert/strict';
import { World, UNITS } from '../dist/engine.js';
import { productionFacilities, productionOrder, productionUnits } from '../dist/production.js';

const advance = (w, seconds) => { for (let i = 0; i < Math.round(seconds * 30); i++) w.update(1 / 30); };
const pair = type => {
  const w = new World({ ai: false, rate: 0, terrain: [], obstacles: [], objectives: false, bases: [{x:370,y:800},{x:2030,y:800}] });
  w.addBuilding('power', 0, 500, 500);
  const buildingType = UNITS[type].producer;
  const a = w.addBuilding(buildingType, 0, 650, 700), b = w.addBuilding(buildingType, 0, 650, 1040);
  const [ca, cb] = w.cores(0).slice(1);
  assert.equal(w.assign(ca.id, a.id).ok, true); assert.equal(w.assign(cb.id, b.id).ok, true);
  advance(w, 8); assert.equal(ca.dock, a.id); assert.equal(cb.dock, b.id);
  return { w, a, b, ca, cb };
};

for (const type of ['infantry', 'tank']) {
  test(`two ${UNITS[type].producer} panels start separate ${type} production and pause independently`, () => {
    const { w, a, b, ca, cb } = pair(type), d = UNITS[type];
    assert.deepEqual(productionFacilities(w, type).map(e => e.id), [a.id, b.id]);
    productionOrder(w, a.id, type); productionOrder(w, b.id, type); advance(w, .5);
    assert.ok(a.job && b.job); assert.notEqual(a.job, b.job);
    assert.equal(ca.energy, 180 - d.cost); assert.equal(cb.energy, 180 - d.cost);
    const remaining = a.job.remaining;
    assert.equal(productionOrder(w, a.id, type, true).ok, true); advance(w, d.time + .2);
    assert.equal(a.job.paused, true); assert.equal(a.job.remaining, remaining);
    assert.equal(b.job, null); assert.equal(w.all(0, 'unit').length, 1);
    productionOrder(w, a.id, type); assert.equal(a.queue.length, 0); advance(w, d.time + .2);
    assert.equal(w.all(0, 'unit').length, 2); assert.equal(ca.energy, 180 - d.cost);
  });
}

test('cancelling one factory refunds its core and preserves the other factory job and orders', () => {
  const { w, a, b, ca, cb } = pair('infantry');
  productionOrder(w, a.id, 'infantry'); productionOrder(w, b.id, 'infantry'); productionOrder(w, b.id, 'infantry'); advance(w, .5);
  const otherJob = structuredClone(b.job), otherQueue = [...b.queue], otherBalance = cb.energy;
  productionOrder(w, a.id, 'infantry', true); productionOrder(w, a.id, 'infantry', true);
  assert.equal(a.job, null); assert.equal(ca.energy, 180);
  assert.deepEqual(b.job, otherJob); assert.deepEqual(b.queue, otherQueue); assert.equal(cb.energy, otherBalance);
  productionOrder(w, b.id, 'infantry', true);
  assert.equal(b.queue.length, 0); assert.deepEqual(b.job, otherJob);
});

test('one factory without a core or enough local energy does not block the other factory', () => {
  for (const blockedBy of ['core', 'energy']) {
    const { w, a, b, cb } = pair('infantry');
    if (blockedBy === 'core') w.undock(cb.id); else cb.energy = UNITS.infantry.cost - 1;
    productionOrder(w, a.id, 'infantry'); productionOrder(w, b.id, 'infantry'); advance(w, 5);
    assert.equal(w.all(0, 'unit').length, 1, blockedBy); assert.equal(b.job, null); assert.equal(b.queue.length, 1);
    assert.equal(productionFacilities(w, 'infantry').length, 2, 'waiting factory must retain its own panel');
  }
});

test('a full queue in one factory does not reject an order to another factory', () => {
  const { w, a, b } = pair('infantry');
  for (let i = 0; i < 8; i++) assert.equal(productionOrder(w, a.id, 'infantry').ok, true);
  assert.equal(productionOrder(w, a.id, 'infantry').ok, false);
  assert.equal(productionOrder(w, b.id, 'infantry').ok, true);
  assert.equal(a.queue.length, 8); assert.equal(b.queue.length, 1);
});

test('destroyed factory panel is removed and stale commands never transfer to a surviving factory', () => {
  const { w, a, b, ca } = pair('infantry');
  productionOrder(w, a.id, 'infantry'); productionOrder(w, b.id, 'infantry'); advance(w, .5);
  const job = structuredClone(b.job);
  w.damage(a, a.maxHp, { team: 1 });
  assert.equal(ca.dock, null); assert.deepEqual(productionFacilities(w, 'infantry').map(e => e.id), [b.id]);
  assert.equal(productionOrder(w, a.id, 'infantry').ok, false); assert.deepEqual(b.job, job); assert.equal(b.queue.length, 0);
  advance(w, 5); assert.equal(w.all(0, 'unit').length, 1);
});

test('production entries exclude enemies and reject orders for the wrong building type', () => {
  const { w, a } = pair('infantry');
  const tankFactory = w.addBuilding('factory', 0, 900, 600), enemy = w.addBuilding('barracks', 1, 1600, 600);
  assert.deepEqual(productionFacilities(w, 'tank').map(e => e.id), [tankFactory.id]);
  assert.equal(productionFacilities(w, 'infantry').some(e => e.id === enemy.id), false);
  assert.equal(productionOrder(w, a.id, 'tank').ok, false); assert.equal(a.queue.length, 0);
  assert.equal(productionOrder(w, enemy.id, 'infantry').ok, false); assert.equal(enemy.queue.length, 0);
});

test('each producer lists its full roster including locked advanced units', () => {
  assert.deepEqual(productionUnits('barracks').sort(), ['infantry', 'rocketeer', 'sniper', 'striker']);
  assert.deepEqual(productionUnits('factory').sort(), ['artillery', 'heavyTank', 'scout', 'tank']);
  assert.deepEqual(productionUnits('power'), []);
});

test('advanced orders require their unlock and right click cancels only the chosen queued type', () => {
  const { w, a, b } = pair('infantry');
  assert.equal(productionOrder(w, a.id, 'sniper').ok, false);
  w.addBuilding('academy', 0, 1100, 500);
  for (const type of ['infantry', 'sniper', 'infantry', 'sniper']) assert.equal(productionOrder(w, a.id, type).ok, true);
  assert.equal(productionOrder(w, a.id, 'sniper', true).ok, true);
  assert.deepEqual(a.queue, ['infantry', 'sniper', 'infantry']);
  assert.equal(productionOrder(w, a.id, 'rocketeer', true).ok, false);
  assert.deepEqual(a.queue, ['infantry', 'sniper', 'infantry']);
  assert.deepEqual(b.queue, []);
});

test('clicking another unlocked unit adds an order without resuming or cancelling the paused current unit', () => {
  const { w, a } = pair('infantry');
  w.addBuilding('academy', 0, 1100, 500);
  productionOrder(w, a.id, 'infantry'); advance(w, .5);
  productionOrder(w, a.id, 'infantry', true);
  assert.equal(a.job.paused, true);
  assert.equal(productionOrder(w, a.id, 'sniper').ok, true);
  assert.equal(a.job.paused, true); assert.deepEqual(a.queue, ['sniper']);
  assert.equal(productionOrder(w, a.id, 'rocketeer', true).ok, false);
  assert.equal(a.job.paused, true);
  productionOrder(w, a.id, 'infantry');
  assert.equal(a.job.paused, false); assert.deepEqual(a.queue, ['sniper']);
});
