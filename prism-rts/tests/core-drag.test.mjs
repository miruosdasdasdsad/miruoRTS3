import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../dist/engine.js';
import { coreFromHit, previewCoreDrop } from '../dist/core-drag.js';

const advance = (world, seconds) => { for (let i = 0; i < Math.round(seconds * 30); i++) world.update(1 / 30); };
function fixture() {
  const world = new World({ ai: false, rate: 0, objectives: false, terrain: [], obstacles: [], bases: [{ x: 370, y: 800 }, { x: 2030, y: 800 }] });
  const source = world.base(0), target = world.addBuilding('barracks', 0, 750, 850), [first, second, free] = world.cores(0);
  world.assign(second.id, target.id); advance(world, 10);
  first.energy = 700; second.energy = 300; free.energy = 950;
  return { world, source, target, first, second, free };
}

test('grabbing resolves only owned loose cores and cores actually docked in completed owned buildings', () => {
  const { world, source, first, free } = fixture();
  assert.equal(coreFromHit(world, source), first);
  assert.equal(coreFromHit(world, free), free);
  for (const hit of [null, world.base(1), world.cores(1)[1], world.addCore(-1, 900, 1100, 0), world.addBuilding('power', 0, 500, 1050), world.addBuilding('factory', 0, 900, 1050)]) assert.equal(coreFromHit(world, hit), null);
});

test('holding and previewing a swap leaves both buildings, balances and paid tasks untouched', () => {
  const { world, source, target, first } = fixture();
  world.startBuilding(0, 'power'); world.enqueue(target.id, 'infantry'); advance(world, 1);
  const before = world.snapshot();
  const preview = previewCoreDrop(world, first.id, target, target);
  assert.equal(preview.ok, true); assert.equal(preview.swapped, true); assert.equal(preview.transfers.length, 2);
  assert.deepEqual(world.snapshot(), before);
  assert.equal(previewCoreDrop(world, first.id, source, source).kind, 'stay');
  assert.deepEqual(world.snapshot(), before);
});

test('direct building swaps reserve both slots, travel physically and preserve task progress and original refunds', () => {
  const { world, source, target, first, second, free } = fixture();
  const construction = world.startBuilding(0, 'power').job;
  world.enqueue(target.id, 'infantry'); advance(world, .5);
  const left = [construction.remaining, target.job.remaining], balances = [first.energy, second.energy];
  const result = world.assign(first.id, target.id, { swap: true });
  assert.equal(result.swapped, true);
  assert.equal(source.core, null); assert.equal(target.core, null);
  assert.equal(first.targetDock, target.id); assert.equal(second.targetDock, source.id);
  assert.equal(first.dock, null); assert.equal(second.dock, null);
  assert.equal(world.assign(free.id, source.id, { swap: true }).ok, false);
  assert.equal(world.assign(free.id, target.id, { swap: true }).ok, false);
  advance(world, .5);
  assert.deepEqual([construction.remaining, target.job.remaining], left);
  assert.deepEqual([first.energy, second.energy], balances);
  assert.equal(world.cancelBuilding(0), true); assert.equal(first.energy, balances[0] + 120);
  assert.equal(world.cancelProduction(target.id), true); assert.equal(second.energy, balances[1] + 45);
  advance(world, 15);
  assert.equal(first.dock, target.id); assert.equal(second.dock, source.id);
  assert.equal(source.core, second.id); assert.equal(target.core, first.id);
});

test('a loose core replaces an occupied slot while its previous core stays safely beside that building', () => {
  const { world, source, target, first, second, free } = fixture();
  assert.equal(world.assign(free.id, target.id, { swap: true }).ok, true);
  assert.equal(second.dock, null); assert.equal(second.targetDock, null); assert.equal(second.dest, null);
  assert.ok(world.walkable(second.x, second.y, second.r));
  assert.equal(second.energy, 300); assert.equal(free.energy, 950); assert.equal(source.core, first.id);
  advance(world, 15);
  assert.equal(target.core, free.id); assert.equal(second.dock, null);
});

test('redirecting a traveling core releases its former reservation and treats replacement as a loose-core drop', () => {
  const { world, target, second, free } = fixture(), other = world.addBuilding('factory', 0, 1000, 1100);
  world.assign(free.id, other.id); advance(world, .2);
  assert.equal(world.assign(free.id, target.id, { swap: true }).ok, true);
  assert.equal(second.targetDock, null);
  const extra = world.addCore(0, 700, 1100, 100);
  assert.equal(world.assign(extra.id, other.id).ok, true);
});

test('an invalid reverse route aborts the entire swap before unplugging or changing any orders', () => {
  const { world, target, first, second } = fixture(), exit = world.orderOrigin(second), findPath = world.findPath.bind(world);
  const before = world.snapshot();
  world.findPath = (from, to, ...args) => Math.hypot(from.x - exit.x, from.y - exit.y) < .01 ? [] : findPath(from, to, ...args);
  const result = world.assign(first.id, target.id, { swap: true });
  assert.equal(result.ok, false); assert.match(result.reason, /返回原建筑/);
  assert.deepEqual(world.snapshot(), before);
});

test('invalid, enemy, reserved and impassable drops preserve the original allocation and energy', () => {
  const { world, target, first, free } = fixture(), power = world.addBuilding('power', 0, 550, 1100);
  const before = world.snapshot();
  for (const hit of [power, world.base(1)]) assert.equal(previewCoreDrop(world, first.id, hit, hit).ok, false);
  assert.equal(previewCoreDrop(world, first.id, { x: -100, y: -100 }).ok, false);
  assert.deepEqual(world.snapshot(), before);
  world.undock(world.byId(target.core).id); world.assign(free.id, target.id);
  const reserved = world.snapshot();
  assert.equal(previewCoreDrop(world, first.id, target, target).ok, false);
  assert.deepEqual(world.snapshot(), reserved);
});

test('ground previews do not unplug a core and committed ground moves do', () => {
  const { world, source, first } = fixture();
  const preview = previewCoreDrop(world, first.id, { x: 600, y: 1150 });
  assert.equal(preview.kind, 'move'); assert.equal(preview.ok, true); assert.equal(source.core, first.id);
  assert.equal(world.command([first.id], preview.point.x, preview.point.y).ok, true);
  assert.equal(source.core, null); advance(world, 10);
  assert.ok(Math.hypot(first.x - 600, first.y - 1150) < 1); assert.equal(first.energy, 700);
});

test('destroying one destination during a swap cancels only that journey and leaves the other core recoverable', () => {
  const { world, source, target, first, second } = fixture();
  world.assign(first.id, target.id, { swap: true });
  const enemy = world.addUnit('tank', 1, 1000, 850);
  world.damage(target, target.hp + 1, enemy);
  assert.equal(first.targetDock, null); assert.equal(first.dock, null); assert.equal(first.energy, 700);
  advance(world, 15);
  assert.equal(second.dock, source.id); assert.equal(second.energy, 300);
});
