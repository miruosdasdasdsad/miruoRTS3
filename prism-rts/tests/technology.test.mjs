import test from 'node:test';
import assert from 'node:assert/strict';
import { World, BUILDINGS, UNITS, distance } from '../dist/engine.js';

const advance = (world, seconds) => {
  for (let i = 0; i < Math.round(seconds * 30); i++) world.update(1 / 30);
};
const sim = () => new World({ ai: false, rate: 0, terrain: [], obstacles: [], objectives: false, bases: [{x:370,y:800},{x:2030,y:800}] });
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-7, `${message}: ${actual} != ${expected}`);
const unlocks = { academy: ['sniper', 'rocketeer'], arsenal: ['heavyTank', 'artillery'], mobility: ['scout', 'striker'] };
const expectedResearch = { academy: { cost: 180, time: 18 }, arsenal: { cost: 220, time: 22 }, mobility: { cost: 160, time: 16 } };

function researchSite(type = 'academy', world = sim()) {
  const power = world.addBuilding('power', 0, 500, 500);
  const building = world.addBuilding(type, 0, 750, 800);
  const core = world.cores(0)[1];
  core.energy = 1000;
  assert.equal(world.assign(core.id, building.id).ok, true);
  advance(world, 10);
  assert.equal(core.dock, building.id);
  return { world, building, core, power };
}

test('power plants and towers reject cores without ejecting the currently docked core', () => {
  const world = sim(), hq = world.base(0), core = world.byId(hq.core);
  for (const type of ['power', 'tower']) {
    const building = world.addBuilding(type, 0, 600, type === 'power' ? 600 : 1050);
    const result = world.assign(core.id, building.id);
    assert.equal(BUILDINGS[type].acceptsCore, false);
    assert.equal(result.ok, false);
    assert.ok(result.reason);
    assert.equal(core.dock, hq.id);
    assert.equal(core.targetDock, null);
    assert.equal(hq.core, core.id);
    assert.equal(building.core, null);
    assert.equal(core.energy, 180);
  }
  for (const type of ['hq', 'barracks', 'factory', ...Object.keys(unlocks)]) assert.equal(BUILDINGS[type].acceptsCore, true, type);
});

test('only completed technology buildings unlock their faction units, permanently and without a core', () => {
  for (const [type, units] of Object.entries(unlocks)) {
    const world = sim(), hq = world.base(0);
    const producers = {
      barracks: world.addBuilding('barracks', 0, 650, 600),
      factory: world.addBuilding('factory', 0, 650, 1000)
    };
    world.addBuilding(type, 1, 1750, 600);
    const site = world.addBuilding(type, 0, 800, 800, 1, hq.id);
    assert.equal(world.unitUnlocked(0, 'infantry'), true);
    assert.equal(world.unitUnlocked(0, 'tank'), true);
    for (const unit of units) {
      assert.equal(UNITS[unit].requires, type);
      assert.equal(typeof UNITS[unit].role, 'string');
      assert.equal(world.unitUnlocked(0, unit), false);
      assert.equal(world.enqueue(producers[UNITS[unit].producer].id, unit).ok, false);
      assert.equal(world.unitUnlocked(1, unit), true);
    }
    advance(world, 1.1);
    assert.equal(site.core, null);
    for (const unit of units) {
      assert.equal(world.unitUnlocked(0, unit), true);
      assert.equal(world.enqueue(producers[UNITS[unit].producer].id, unit).ok, true);
    }
    world.damage(site, site.maxHp + 1, world.base(1));
    for (const unit of units) {
      assert.equal(world.unitUnlocked(0, unit), true);
      assert.equal(world.enqueue(producers[UNITS[unit].producer].id, unit).ok, true);
    }
    assert.equal(world.technologyActive(0, type), false);
  }
});

test('ready technology buildings do not unlock units until actually placed', () => {
  const world = sim(), hq = world.base(0);
  world.byId(hq.core).energy = 1000;
  assert.equal(world.startBuilding(0, 'academy').ok, true);
  advance(world, BUILDINGS.academy.time + 1);
  assert.equal(hq.buildJob.remaining, 0);
  assert.equal(world.unitUnlocked(0, 'sniper'), false);
  assert.equal(world.deployBuilding(0, 'academy', 650, 600).ok, true);
  assert.equal(world.unitUnlocked(0, 'sniper'), true);
});

test('research waits for its duration, charges its own core once, and prevents duplicate research', () => {
  for (const [type, expected] of Object.entries(expectedResearch)) {
    const { world, building, core } = researchSite(type);
    const duplicate = world.addBuilding(type, 0, 850, 550);
    assert.equal(BUILDINGS[type].technology.cost, expected.cost);
    assert.equal(BUILDINGS[type].technology.time, expected.time);
    assert.equal(world.research(building.id).ok, true);
    assert.equal(core.energy, 1000 - expected.cost);
    assert.equal(world.stats[0].spent, expected.cost);
    assert.equal(world.researchInProgress(0, type), building);
    assert.equal(world.research(building.id).ok, false);
    assert.equal(world.research(duplicate.id).ok, false);
    assert.equal(core.energy, 1000 - expected.cost);
    advance(world, expected.time - 0.1);
    assert.equal(world.technologyActive(0, type), false);
    assert.ok(building.researchJob.remaining > 0);
    advance(world, 0.2);
    assert.equal(world.technologyActive(0, type), true);
    assert.equal(world.technologyActive(1, type), false);
    assert.equal(building.researchJob, null);
    assert.equal(world.researchInProgress(0, type), null);
    assert.equal(world.research(building.id).ok, false);
    assert.equal(world.research(duplicate.id).ok, false);
    assert.equal(core.energy, 1000 - expected.cost);
  }
});

test('research rejects unfinished buildings, absent or traveling cores, insufficient local energy, and blackouts without charging', () => {
  const world = sim(), building = world.addBuilding('academy', 0, 750, 800), core = world.cores(0)[1];
  core.energy = 179;
  world.cores(0)[2].energy = 10000;
  const rejected = () => {
    const balances = world.cores().map(c => c.energy), spent = world.stats[0].spent;
    assert.equal(world.research(building.id).ok, false);
    assert.equal(building.researchJob ?? null, null);
    assert.deepEqual(world.cores().map(c => c.energy), balances);
    assert.equal(world.stats[0].spent, spent);
  };
  rejected();
  assert.equal(world.assign(core.id, building.id).ok, true);
  assert.equal(core.dock, null);
  rejected();
  advance(world, 10);
  assert.equal(core.dock, building.id);
  rejected();
  core.energy = 1000;
  building.construction = 1;
  rejected();
  building.construction = 0;
  world.addBuilding('factory', 0, 750, 1100);
  assert.equal(world.grid(0).ok, false);
  rejected();
  assert.equal(world.research(world.base(0).id).ok, false);
  assert.equal(world.research(core.id).ok, false);
  assert.equal(world.research(-1).ok, false);
});

test('core removal, replacement, power shortage and manual pause retain research progress without another payment', () => {
  const { world, building, core, power } = researchSite();
  world.addBuilding('factory', 0, 950, 1050);
  assert.equal(world.research(building.id).ok, true);
  advance(world, 2);
  const remaining = building.researchJob.remaining;
  world.undock(core.id);
  advance(world, 3);
  assert.equal(building.researchJob.remaining, remaining);
  const replacement = world.cores(0)[2];
  replacement.energy = 0;
  assert.equal(world.assign(replacement.id, building.id).ok, true);
  advance(world, 0.1);
  assert.equal(building.researchJob.remaining, remaining);
  advance(world, 10);
  assert.equal(replacement.dock, building.id);
  assert.ok(building.researchJob.remaining < remaining);
  assert.equal(replacement.energy, 0);
  assert.equal(core.energy, 820);
  power.hp = 0;
  const outageRemaining = building.researchJob.remaining;
  advance(world, 2);
  assert.equal(building.researchJob.remaining, outageRemaining);
  power.hp = power.maxHp;
  assert.equal(world.toggleResearchPause(building.id), true);
  advance(world, 2);
  assert.equal(building.researchJob.remaining, outageRemaining);
  assert.equal(world.toggleResearchPause(building.id), true);
  advance(world, outageRemaining + 0.1);
  assert.equal(world.technologyActive(0, 'academy'), true);
  assert.equal(world.stats[0].spent, 180);
  assert.equal(core.energy, 820);
  assert.equal(replacement.energy, 0);
});

test('cancelled research refunds its original paying core after a replacement is docked', () => {
  const { world, building, core } = researchSite('arsenal');
  world.research(building.id);
  advance(world, 2);
  assert.equal(world.toggleResearchPause(building.id), true);
  world.undock(core.id);
  const replacement = world.cores(0)[2];
  replacement.energy = 7;
  world.assign(replacement.id, building.id);
  advance(world, 10);
  assert.equal(replacement.dock, building.id);
  assert.equal(world.cancelResearch(building.id), true);
  assert.equal(core.energy, 1000);
  assert.equal(replacement.energy, 7);
  assert.equal(world.stats[0].spent, 0);
  assert.equal(world.technologyActive(0, 'arsenal'), false);
  assert.equal(world.researchInProgress(0, 'arsenal'), null);
  assert.equal(world.cancelResearch(building.id), false);
  assert.equal(core.energy, 1000);
});

test('destroying a technology building abandons unfinished research but preserves completed upgrades and unlocked units', () => {
  for (const finished of [false, true]) {
    const { world, building, core } = researchSite();
    assert.equal(world.research(building.id).ok, true);
    advance(world, finished ? 18.1 : 2);
    world.damage(building, building.maxHp + 1, world.base(1));
    assert.equal(core.dock, null);
    assert.equal(core.energy, 820);
    assert.equal(world.unitUnlocked(0, 'sniper'), true);
    assert.equal(world.technologyActive(0, 'academy'), finished);
    assert.equal(world.researchInProgress(0, 'academy'), null);
    advance(world, 30);
    assert.equal(world.technologyActive(0, 'academy'), finished);
  }
});

test('finished research affects every existing and future allied unit permanently without altering enemy units or buildings', () => {
  const effects = { academy: ['damage', 1.2], arsenal: ['incomingDamage', 0.8], mobility: ['speed', 1.2] };
  for (const [type, [field, factor]] of Object.entries(effects)) {
    const { world, building, core } = researchSite(type);
    const existing = Object.keys(UNITS).map((unit, i) => world.addUnit(unit, 0, 800 + i * 90, 1250));
    const opponents = Object.keys(UNITS).map((unit, i) => world.addUnit(unit, 1, 800 + i * 90, 300));
    const before = existing.map(unit => world.unitStats(unit)[field]);
    const enemyBefore = opponents.map(unit => world.unitStats(unit)[field]);
    world.stop([...existing, ...opponents].map(unit => unit.id));
    const tower = world.addBuilding('tower', 0, 600, 1100), towerHp = tower.maxHp;
    assert.equal(world.research(building.id).ok, true);
    existing.forEach((unit, i) => near(world.unitStats(unit)[field], before[i], `${type} must wait`));
    advance(world, expectedResearch[type].time + 0.1);
    existing.forEach((unit, i) => near(world.unitStats(unit)[field], before[i] * factor, `${type} ${unit.type}`));
    opponents.forEach((unit, i) => near(world.unitStats(unit)[field], enemyBefore[i], `${type} enemy ${unit.type}`));
    world.undock(core.id);
    world.damage(building, building.maxHp + 1, world.base(1));
    existing.forEach((unit, i) => near(world.unitStats(unit)[field], before[i] * factor, `${type} persists`));
    Object.keys(UNITS).forEach((unit, i) => {
      const future = world.addUnit(unit, 0, 800 + i * 90, 1450);
      near(world.unitStats(future)[field], before[i] * factor, `${type} future ${unit}`);
    });
    assert.equal(tower.maxHp, towerHp);
    world.damage(tower, 100, world.base(1));
    near(tower.hp, towerHp - 100, 'buildings do not receive armor research');
  }
});

test('attack and armor upgrades change actual combat damage immediately after research completes', () => {
  const { world, building } = researchSite();
  world.research(building.id);
  advance(world, 18.1);
  const attacker = world.addUnit('infantry', 0, 1000, 1200), enemy = world.addUnit('infantry', 1, 1100, 1200);
  world.stop([attacker.id, enemy.id]);
  enemy.cooldown = 100;
  advance(world, 1 / 30);
  near(enemy.hp, UNITS.infantry.hp - UNITS.infantry.damage * 1.2, 'upgraded weapon shot');
  const armor = world.addBuilding('arsenal', 0, 800, 550), core = world.cores(0)[2];
  core.energy = 1000;
  world.assign(core.id, armor.id);
  world.stop([attacker.id]);
  attacker.cooldown = enemy.cooldown = 100;
  advance(world, 10);
  assert.equal(world.research(armor.id).ok, true);
  advance(world, 22.1);
  const allyHp = attacker.hp, enemyHp = enemy.hp;
  world.damage(attacker, 20, enemy);
  world.damage(enemy, 20, attacker);
  near(attacker.hp, allyHp - 16, 'upgraded armor');
  near(enemy.hp, enemyHp - 20, 'enemy armor unchanged');
});

test('mobility research increases movement of already deployed units while enemy movement remains unchanged', () => {
  const control = researchSite('mobility'), upgraded = researchSite('mobility');
  const armies = [control, upgraded].map(({ world }) => [world.addUnit('infantry', 0, 800, 1200), world.addUnit('infantry', 1, 800, 300)]);
  upgraded.world.research(upgraded.building.id);
  advance(control.world, 16.1);
  advance(upgraded.world, 16.1);
  for (const [i, { world }] of [control, upgraded].entries()) {
    for (const unit of armies[i]) assert.equal(world.command([unit.id], 1300, unit.y).ok, true);
    advance(world, 1);
  }
  const alliedTravel = armies.map(units => distance(units[0], { x: 800, y: 1200 }));
  const enemyTravel = armies.map(units => distance(units[1], { x: 800, y: 300 }));
  assert.ok(alliedTravel[1] > alliedTravel[0] * 1.15);
  near(enemyTravel[1], enemyTravel[0], 'enemy movement unchanged');
});

test('new infantry and vehicle roles have distinct battlefield strengths', () => {
  assert.ok(UNITS.sniper.range > UNITS.infantry.range);
  assert.ok(UNITS.striker.speed > UNITS.infantry.speed);
  assert.ok(UNITS.striker.range < UNITS.infantry.range);
  assert.ok(UNITS.scout.speed > UNITS.tank.speed);
  assert.ok(UNITS.heavyTank.hp > UNITS.tank.hp);
  assert.ok(UNITS.artillery.range > UNITS.tank.range);
  assert.ok(UNITS.artillery.speed < UNITS.tank.speed);
  const world = sim(), heavy = world.addUnit('heavyTank', 0, 1000, 1100), ordinary = world.addUnit('tank', 0, 1100, 1100);
  world.damage(heavy, 100, world.base(1));
  world.damage(ordinary, 100, world.base(1));
  assert.ok(heavy.maxHp - heavy.hp < ordinary.maxHp - ordinary.hp);
});

test('snipers excel against infantry and rocketeers excel against armored vehicles', () => {
  function damageAgainst(attackerType, targetType) {
    const world = sim(), attacker = world.addUnit(attackerType, 0, 900, 1100), target = world.addUnit(targetType, 1, 1100, 1100);
    const hp = target.hp;
    world.shoot(attacker, target, world.unitStats(attacker));
    return hp - target.hp;
  }
  assert.ok(damageAgainst('sniper', 'infantry') > damageAgainst('sniper', 'tank'));
  assert.ok(damageAgainst('rocketeer', 'tank') > damageAgainst('rocketeer', 'infantry'));
});

test('artillery splash hurts nearby enemies while sparing allies, cores and distant enemies', () => {
  const world = sim(), artillery = world.addUnit('artillery', 0, 900, 1100);
  const primary = world.addUnit('infantry', 1, 1100, 1100), nearby = world.addUnit('infantry', 1, 1135, 1100);
  const ally = world.addUnit('infantry', 0, 1100, 1135), distant = world.addUnit('infantry', 1, 1400, 1100);
  const enemyCore = world.addCore(1, 1115, 1115, 73);
  world.shoot(artillery, primary, world.unitStats(artillery));
  assert.ok(primary.hp < primary.maxHp);
  assert.ok(nearby.hp < nearby.maxHp);
  assert.equal(ally.hp, ally.maxHp);
  assert.equal(distant.hp, distant.maxHp);
  assert.equal(enemyCore.hp, enemyCore.maxHp);
  assert.equal(enemyCore.energy, 73);
});
