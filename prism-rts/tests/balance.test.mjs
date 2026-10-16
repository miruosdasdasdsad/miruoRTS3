import test from 'node:test';
import assert from 'node:assert/strict';
import { World, BUILDINGS, UNITS } from '../dist/engine.js';
import { DEFAULT_BALANCE, BALANCE_FIELDS, createBalance, validateBalance } from '../dist/balance.js';

const arena = balance => new World({ ai: false, objectives: false, terrain: [], obstacles: [], balance });
const advance = (world, seconds) => { for (let i = 0; i < Math.round(seconds * 20); i++) world.update(.05); };
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} != ${expected}`);
const dock = (world, building, core = world.cores(0)[1]) => {
  world.undock(core.id); core.dock = building.id; building.core = core.id; core.x = building.x; core.y = building.y;
  return core;
};

test('balance accepts numeric partial overrides and full JSON profiles with fresh derived descriptions', () => {
  const result = validateBalance({ units: { rocketeer: { vehicleBonus: 3 }, heavyTank: { incomingDamage: .7 } }, buildings: { academy: { technology: { multiplier: 1.35 } } } });
  assert.equal(result.ok, true); assert.deepEqual(result.errors, []);
  assert.equal(result.value.units.rocketeer.hp, UNITS.rocketeer.hp);
  assert.match(result.value.units.rocketeer.role, /对战车 ×3/);
  assert.match(result.value.units.heavyTank.role, /受到伤害 −30%/);
  assert.equal(result.value.buildings.academy.technology.description, '全军伤害 +35%');
  const roundTrip = validateBalance(JSON.parse(JSON.stringify(result.value)));
  assert.equal(roundTrip.ok, true); assert.deepEqual(roundTrip.value, result.value);
  assert.notEqual(roundTrip.value.units, result.value.units);
  assert.ok(BALANCE_FIELDS.some(field => field.path === 'units.infantry.vehicleBonus'));
  assert.ok(BALANCE_FIELDS.some(field => field.path === 'buildings.arsenal.technology.multiplier'));
});

test('balance rejects malformed, nonfinite, out-of-range and structural rule edits', () => {
  for (const input of [null, [], { version: 2 }, { economy: { rate: 1.5 } }, { economy: { rate: -1 } },
    { economy: { rate: '6' } }, { units: { tank: { reload: 0 } } }, { units: { tank: { damage: NaN } } },
    { units: { tank: { speed: Infinity } } }, { units: { tank: { cost: -10 } } }, { units: { nope: {} } },
    { units: { tank: { producer: 'barracks' } } }, { buildings: { power: { power: 10 } } },
    JSON.parse('{"__proto__":{"polluted":true}}')]) {
    const result = validateBalance(input);
    assert.equal(result.ok, false, JSON.stringify(input)); assert.equal(result.value, null); assert.ok(result.errors.length);
    assert.throws(() => createBalance(input), RangeError);
  }
  assert.equal({}.polluted, undefined);
});

test('matches own frozen independent profiles and keep exports, other matches and editable drafts isolated', () => {
  const draft = createBalance({ units: { tank: { hp: 777, cost: 222 } }, buildings: { hq: { hp: 3500 } } });
  const a = arena(draft), b = arena();
  assert.equal(a.base(0).maxHp, 3500); assert.equal(a.addUnit('tank', 0, 900, 900).maxHp, 777);
  draft.units.tank.hp = 999; draft.buildings.hq.hp = 999;
  assert.equal(a.units.tank.hp, 777); assert.equal(a.buildings.hq.hp, 3500);
  assert.equal(b.units.tank.hp, UNITS.tank.hp); assert.equal(b.base(0).hp, BUILDINGS.hq.hp);
  assert.notEqual(a.units, b.units); assert.notEqual(b.units, UNITS);
  assert.throws(() => { a.units.tank.hp = 1; }, TypeError);
  assert.throws(() => { DEFAULT_BALANCE.units.tank.hp = 1; }, TypeError);
  const snapshot = a.snapshot(); snapshot.balance.units.tank.hp = 3;
  assert.equal(a.units.tank.hp, 777);
});

test('custom economy sets independent starting energy, income, power, neutral health and reward period', () => {
  const world = new World({ ai: false, terrain: [], obstacles: [], balance: {
    economy: { rate: 8, startingEnergy: 42, basePower: 77, captureDuration: 2 }, buildings: { cache: { hp: 333 } }
  } });
  assert.deepEqual(world.cores(0).map(core => core.energy), [42, 42, 42]);
  advance(world, 1.5); assert.deepEqual(world.cores(0).map(core => core.energy), [50, 50, 50]);
  assert.equal(world.grid(0).supply, 77); assert.equal(world.all(-1, 'building')[0].hp, 333);
  world.addUnit('infantry', 0, world.capturePoint.x, world.capturePoint.y);
  advance(world, 2); assert.equal(world.capturePoint.rewards[0], 1); assert.equal(world.cores(0).length, 4);
  assert.ok(world.events.some(event => event.text.includes('每驻守 2 秒')));
});

test('custom construction and production use configured local costs, durations and hit points', () => {
  const world = arena({ economy: { rate: 0, startingEnergy: 500, basePower: 0 }, buildings: {
    power: { hp: 321, cost: 27, time: .5, power: -19 }, barracks: { hp: 456, power: 7 }
  }, units: { infantry: { hp: 170, cost: 25, time: .4 } } });
  const hq = world.base(0), payer = world.byId(hq.core), build = world.startBuilding(0, 'power').job;
  assert.equal(payer.energy, 473); assert.equal(build.total, .5); assert.equal(build.paidCost, 27);
  advance(world, .6); const power = world.deployBuilding(0, 'power', 640, 1010).entity;
  assert.equal(power.hp, 321); assert.equal(world.grid(0).supply, 19);
  const producer = world.addBuilding('barracks', 0, 650, 1400), core = dock(world, producer);
  assert.equal(producer.hp, 456); assert.equal(world.grid(0).demand, 7);
  world.enqueue(producer.id, 'infantry'); advance(world, .1);
  assert.equal(core.energy, 475); assert.equal(producer.job.total, .4); assert.equal(producer.job.paidCost, 25);
  advance(world, .4); assert.equal(world.all(0, 'unit')[0].hp, 170);
  assert.equal(world.stats[0].spent, 52);
});

test('cancellation uses captured payments despite other profiles and always refunds the original core', () => {
  const world = arena({ economy: { rate: 0, startingEnergy: 1000, basePower: 100 }, buildings: {
    power: { cost: 37 }, academy: { technology: { cost: 41 } }
  }, units: { infantry: { cost: 53 } } });
  const hq = world.base(0), constructionPayer = world.byId(hq.core);
  world.startBuilding(0, 'power'); const buildingJob = hq.buildJob;
  arena({ buildings: { power: { cost: 999 } }, units: { infantry: { cost: 999 } } });
  world.undock(constructionPayer.id); dock(world, hq, world.cores(0)[2]);
  world.cancelBuilding(0); assert.equal(constructionPayer.energy, 1000); assert.equal(buildingJob.paidCost, 0);
  const producer = world.addBuilding('barracks', 0, 700, 900), core = dock(world, producer);
  world.enqueue(producer.id, 'infantry'); advance(world, .1); assert.equal(core.energy, 947);
  world.undock(core.id); world.cancelProduction(producer.id); assert.equal(core.energy, 1000);
  const lab = world.addBuilding('academy', 0, 700, 1500); dock(world, lab, core);
  world.research(lab.id); assert.equal(core.energy, 959); world.undock(core.id); world.cancelResearch(lab.id);
  assert.equal(core.energy, 1000); assert.equal(world.stats[0].spent, 0);
});

test('configured weapons apply target bonuses, splash, defensive multiplier and reload to actual shots', () => {
  const world = arena({ units: {
    infantry: { damage: 17, reload: .4, infantryBonus: 2, vehicleBonus: 3, buildingBonus: 4, splash: 45 },
    tank: { hp: 1000, incomingDamage: .7 }
  } });
  const shooter = world.addUnit('infantry', 0, 900, 900), tank = world.addUnit('tank', 1, 1050, 900);
  const nearby = world.addUnit('infantry', 1, 1080, 935), distant = world.addUnit('infantry', 1, 1300, 900);
  world.shoot(shooter, tank, world.unitStats(shooter));
  near(tank.hp, 1000 - 17 * 3 * .7); near(nearby.hp, nearby.maxHp - 17); near(distant.hp, distant.maxHp);
  near(shooter.cooldown, .4);
  const building = world.addBuilding('tower', 1, 1300, 1300);
  world.shoot(shooter, building, world.unitStats(shooter)); near(building.hp, building.maxHp - 68);
});

test('custom range and speed govern real acquisition and movement', () => {
  const world = arena({ economy: { rate: 0 }, units: { infantry: { range: 80, speed: 140 } } });
  const a = world.addUnit('infantry', 0, 900, 900), b = world.addUnit('infantry', 1, 1000, 900);
  world.stop([a.id, b.id]); b.cooldown = 100; advance(world, .1); assert.equal(b.hp, b.maxHp);
  b.x = 985; advance(world, .05); assert.equal(b.hp, b.maxHp - world.units.infantry.damage);
  b.hp = 0; a.cooldown = 100; world.command([a.id], 1600, 900); advance(world, 2);
  // Acceleration is five times the configured speed, reaching full speed in 0.2 s.
  assert.ok(a.x - 900 > 250 && a.x - 900 < 281);
});

test('custom tower range, damage and interval are used by powered defenses', () => {
  const world = arena({ economy: { rate: 0, basePower: 100 }, buildings: { tower: { range: 90, damage: 7, reload: .2 } } });
  const tower = world.addBuilding('tower', 0, 900, 900), target = world.addUnit('tank', 1, 1015, 900);
  world.stop([target.id]); target.cooldown = 100; advance(world, .1); assert.equal(target.hp, target.maxHp);
  target.x = 1000; advance(world, .05); assert.equal(target.hp, target.maxHp - 7); near(tower.cooldown, .2);
  advance(world, .25); assert.equal(target.hp, target.maxHp - 14);
});

test('custom technology payments, timing and all three multipliers drive research and allied stats', () => {
  for (const [type, stat, multiplier] of [['academy', 'damage', 1.5], ['arsenal', 'incomingDamage', .6], ['mobility', 'speed', 1.7]]) {
    const world = arena({ economy: { rate: 0, basePower: 100 }, buildings: { [type]: { technology: { cost: 23, time: .5, multiplier } } } });
    const lab = world.addBuilding(type, 0, 900, 900), core = dock(world, lab);
    const ally = world.addUnit('infantry', 0, 1300, 900), enemy = world.addUnit('infantry', 1, 2000, 900);
    const original = world.unitStats(ally)[stat];
    assert.equal(world.research(lab.id).ok, true); assert.equal(core.energy, 157);
    advance(world, .4); near(world.unitStats(ally)[stat], original);
    advance(world, .15); near(world.unitStats(ally)[stat], original * multiplier); near(world.unitStats(enemy)[stat], original);
    assert.equal(world.stats[0].spent, 23);
  }
});

test('default roster rewards specialization instead of replacing basic units universally', () => {
  const dps = (type, target) => UNITS[type].damage / UNITS[type].reload * UNITS[type][target] / UNITS[type].cost;
  assert.ok(dps('rocketeer', 'vehicleBonus') > dps('infantry', 'vehicleBonus') * 1.8);
  assert.ok(dps('infantry', 'infantryBonus') > dps('rocketeer', 'infantryBonus'));
  assert.ok(dps('tank', 'vehicleBonus') > dps('heavyTank', 'vehicleBonus'));
  assert.ok(dps('tank', 'vehicleBonus') > dps('striker', 'vehicleBonus'));
  assert.ok(dps('sniper', 'infantryBonus') > dps('sniper', 'vehicleBonus') * 4);
  assert.ok(UNITS.heavyTank.hp / UNITS.heavyTank.incomingDamage / UNITS.heavyTank.cost > UNITS.tank.hp / UNITS.tank.cost);
  assert.ok(UNITS.tank.range > UNITS.heavyTank.range);
});

test('event subscriptions retain every event beyond the short UI log and unsubscribe cleanly', () => {
  const world = arena(), received = [], unsubscribe = world.subscribeEvents(event => received.push(event));
  for (let i = 0; i < 45; i++) world.log(`事件 ${i}`);
  assert.equal(world.events.length, 30); assert.equal(received.length, 45);
  assert.deepEqual(received.map(event => event.id), Array.from({ length: 45 }, (_, i) => i + 2));
  unsubscribe(); world.log('不应接收'); assert.equal(received.length, 45);
});
