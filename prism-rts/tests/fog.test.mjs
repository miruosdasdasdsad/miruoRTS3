import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../dist/engine.js';
import { FogOfWar, visionRadius } from '../dist/fog.js';
import { Renderer } from '../dist/render.js';

const world = options => new World({ ai: false, rate: 0, objectives: false, terrain: [], obstacles: [], ...options });
const advance = (w, seconds) => { for (let i = 0; i < Math.round(seconds * 30); i++) w.update(1 / 30); };
const relocate = (w, entity, x, y) => { entity.x = x; entity.y = y; w.refreshVisibility(); };

test('new matches reveal each own base, with independent unexplored enemy and center cells', () => {
  const w = world();
  assert.equal(w.config.fog, true);
  for (const team of [0, 1]) {
    assert.equal(w.canSee(team, w.base(team)), true);
    assert.equal(w.canSee(team, w.base(1 - team)), false);
    assert.equal(w.fog.stateAt(team, 1800, 1200), 0);
    assert.equal(w.fog.stateAt(team, w.base(1 - team).x, w.base(1 - team).y), 0);
    assert.equal(w.fog.stateAt(team, w.base(team).x, w.base(team).y), 2);
  }
});

test('exploration follows moving scouts, retains grey terrain, and resets with a new match', () => {
  const w = world(), scout = w.addUnit('scout', 0, 1800, 1200);
  assert.equal(w.visibleAt(0, 1800, 1200), true);
  assert.equal(w.fog.stateAt(1, 1800, 1200), 0);
  relocate(w, scout, 1100, 1200);
  assert.equal(w.fog.stateAt(0, 1800, 1200), 1);
  assert.equal(w.fog.stateAt(0, 1100, 1200), 2);
  assert.equal(world().fog.stateAt(0, 1800, 1200), 0);
});

test('scouts see farther than infantry; neutral objects and docked cores supply no extra vision', () => {
  const w = world(), infantry = w.addUnit('infantry', 0, 1700, 1200);
  w.refreshVisibility(); assert.equal(w.visibleAt(0, 2150, 1200), false);
  const scout = w.addUnit('scout', 0, 1700, 1250);
  assert.equal(w.visibleAt(0, 2150, 1200), true);
  assert.ok(visionRadius(scout) > visionRadius(infantry));
  assert.equal(visionRadius(w.byId(w.base(0).core)), 0);
  const neutral = w.addCore(-1, 1700, 2200);
  assert.equal(w.visibleAt(0, neutral.x, neutral.y), false);
  assert.equal(w.visibleAt(1, neutral.x, neutral.y), false);
});

test('loose cores reveal during travel, and destroyed revealers immediately leave explored fog', () => {
  const w = world(), core = w.cores(0)[1];
  relocate(w, core, 1600, 2100);
  assert.equal(w.visibleAt(0, core.x, core.y), true);
  assert.equal(w.visibleAt(0, core.x + 220, core.y), false);
  const scout = w.addUnit('scout', 0, 1800, 1000);
  assert.equal(w.visibleAt(0, 1800, 1000), true);
  w.damage(scout, 10000, { team: 1 });
  assert.equal(w.visibleAt(0, 1800, 1000), false);
  assert.equal(w.fog.stateAt(0, 1800, 1000), 1);
});

test('hidden buildings retain only immutable discovered footprints, including unseen destruction until rescouted', () => {
  const w = world(), enemy = w.addBuilding('barracks', 1, 1800, 1200), scout = w.addUnit('scout', 0, 1600, 1200);
  assert.equal(w.canSee(0, enemy), true);
  relocate(w, scout, 700, 1500);
  const memory = w.fog.rememberedBuildings(0).find(e => e.id === enemy.id);
  assert.ok(memory); assert.equal(memory.hp, undefined); assert.equal(memory.core, undefined); assert.equal(memory.job, undefined);
  assert.equal(Object.isFrozen(memory), true);
  w.damage(enemy, 10000, { team: 0 }); w.refreshVisibility();
  assert.ok(w.fog.rememberedBuildings(0).some(e => e.id === enemy.id), 'hidden destruction is not revealed');
  assert.equal(w.eventVisible(w.events[0]), false);
  relocate(w, scout, 1600, 1200);
  assert.equal(w.fog.teams[0].buildings.has(enemy.id), false);
});

test('direct hidden attack IDs become ground orders and do not follow hidden movement', () => {
  const w = world(), attacker = w.addUnit('tank', 0, 1100, 1200), target = w.addUnit('tank', 1, 2200, 1200);
  assert.equal(w.canSee(0, target), false);
  assert.equal(w.command([attacker.id], target.x, target.y, target.id, true).ok, true);
  assert.equal(attacker.target, null);
  const lastKnown = { ...attacker.dest };
  relocate(w, target, 2900, 1600); advance(w, 1);
  assert.deepEqual(attacker.dest, lastKnown);
});

test('visible targets can be locked, but leaving shared vision stops live tracking and fire', () => {
  const w = world(), attacker = w.addUnit('tank', 0, 1400, 1200), target = w.addUnit('tank', 1, 1600, 1200);
  assert.equal(w.command([attacker.id], target.x, target.y, target.id).ok, true);
  assert.equal(attacker.target, target.id);
  w.stop([target.id]); relocate(w, target, 2400, 1200);
  const hp = target.hp; w.update(.1);
  assert.equal(attacker.target, null); assert.equal(target.hp, hp);
});

test('queued attack orders recheck sight at execution and retain only their original destination', () => {
  const w = world(), attacker = w.addUnit('tank', 0, 1400, 1200), target = w.addUnit('tank', 1, 1600, 1200);
  w.command([attacker.id], 1450, 1350);
  w.command([attacker.id], target.x, target.y, target.id, true, true);
  assert.equal(attacker.orders[0].targetId, target.id);
  relocate(w, target, 2400, 1200);
  attacker.path = []; attacker.dest = null; attacker.target = null;
  w.nextOrder(attacker);
  assert.equal(attacker.target, null); assert.ok(attacker.dest.x < 1800);
});

test('long range weapons on either team require shared sight and accept a forward spotter', () => {
  for (const team of [0, 1]) {
    const w = world({ balance: { units: { artillery: { range: 1000 } } } });
    const gun = w.addUnit('artillery', team, 1400, 1200), target = w.addUnit('heavyTank', 1 - team, 2100, 1200);
    w.stop([gun.id, target.id]); advance(w, .2);
    assert.equal(target.hp, target.maxHp, 'range alone grants no sight');
    w.addUnit('scout', team, 1900, 1500); advance(w, .2);
    assert.ok(target.hp < target.maxHp, 'shared scout sight enables the shot');
  }
});

test('attack move explores black fog without requiring a visible target', () => {
  const w = world(), scout = w.addUnit('scout', 0, 1100, 1200);
  w.command([scout.id], 1800, 1200, null, true); advance(w, 8);
  assert.equal(w.fog.stateAt(0, 1800, 1200), 2);
  assert.ok(w.fog.summary(0).exploredCells > world().fog.summary(0).exploredCells);
});

test('reveal debug mode changes observation without permanently exploring the whole map', () => {
  const w = world();
  const before = w.fog.summary(0).exploredCells;
  w.config.fog = false;
  assert.equal(w.canSee(0, w.base(1)), true); advance(w, 1);
  assert.equal(w.fog.summary(0).exploredCells, before);
  w.config.fog = true;
  assert.equal(w.canSee(0, w.base(1)), false);
  assert.equal(w.fog.stateAt(0, w.base(1).x, w.base(1).y), 0);
});

test('enemy objective events and live ownership are unavailable outside sight', () => {
  const w = world({ objectives: true }), point = w.capturePoint;
  const enemy = w.addUnit('infantry', 1, point.x, point.y);
  w.stop([enemy.id]); w.update(.1);
  assert.equal(w.captureKnown(0), false); assert.equal(w.captureKnown(1), true);
  const captureEvent = w.events.find(event => event.text.includes('开始控制'));
  assert.ok(captureEvent); assert.equal(w.eventVisible(captureEvent, 0), false); assert.equal(w.eventVisible(captureEvent, 1), true);
  const player = w.addUnit('scout', 0, point.x - 450, point.y);
  assert.equal(w.captureKnown(0), true);
  assert.equal(w.canSee(0, enemy), true);
  relocate(w, player, 700, 1500); assert.equal(w.captureKnown(0), false);
});

test('AI scouts scenario resource sites instead of tracking undiscovered neutral drops', () => {
  const w = world({ objectives: true });
  for (let i = 0; i < 9; i++) w.addUnit('infantry', 1, 3100, 1100 + i * 28);
  const hiddenCore = w.addCore(-1, 2450, 1200);
  assert.equal(w.canSee(1, hiddenCore), false);
  w.time = 110; w.runObjectiveAI();
  const scavengers = w.all(1, 'unit').filter(unit => unit.aiRole === 'cache');
  assert.equal(scavengers.length, 2);
  for (const unit of scavengers) {
    assert.notEqual(unit.aiObjectiveId, hiddenCore.id);
    assert.equal(unit.target, null); assert.ok(unit.path.length > 0);
  }
});

test('hit tests, hover, selection and render states never expose hidden units or neutral loot', () => {
  const w = world(), enemy = w.addUnit('infantry', 1, 1800, 1200), neutral = w.addCore(-1, 1800, 1500);
  const view = Object.assign(Object.create(Renderer.prototype), { getWorld: () => w, width: 1000, height: 650, camera: { x: 1800, y: 1200, z: .66 },
    selected: new Set([enemy.id]), hover: enemy, states: new Map(), vfx: [], seenShots: new WeakSet(), seenEffects: new WeakSet(), realTime: 0, reducedMotion: true, lastWorld: w });
  assert.equal(view.hit(...Object.values(view.screen(enemy.x, enemy.y))), null);
  const p = view.screen(neutral.x, neutral.y); assert.equal(view.hit(p.x, p.y), null);
  view.sync(w, .1);
  assert.equal(view.selected.size, 0); assert.equal(view.hover, null); assert.equal(view.states.has(enemy.id), false);
  w.addUnit('scout', 0, 1700, 1200);
  const q = view.screen(enemy.x, enemy.y); assert.equal(view.hit(q.x, q.y), enemy);
  relocate(w, enemy, 2900, 1500); view.sync(w, .1);
  assert.equal(view.states.has(enemy.id), false);
});

test('hidden shots, deaths and enemy command markers do not create visual effects', () => {
  const w = world(), enemy = w.addUnit('infantry', 1, 2000, 1200);
  w.command([enemy.id], 1800, 1200);
  w.shots.push({ team: 1, x: 2000, y: 1200, tx: 2100, ty: 1200, weapon: 'infantry' });
  w.effects.push({ type: 'burst', x: 2000, y: 1200, big: true, color: '#ffffff' });
  const view = Object.assign(Object.create(Renderer.prototype), { getWorld: () => w, selected: new Set(), hover: null, states: new Map(), vfx: [], seenShots: new WeakSet(), seenEffects: new WeakSet(), realTime: 0, reducedMotion: true, lastWorld: w });
  view.sync(w, .1); assert.deepEqual(view.vfx, []);
});

test('fog handles map boundaries, invalid coordinates, removed sources, and custom spawns', () => {
  const fog = new FogOfWar(120, 96, 24), source = { id: 1, team: 0, kind: 'core', hp: 1, x: 1, y: 1 };
  fog.update([source]); assert.equal(fog.stateAt(0, 0, 0), 2);
  for (const [x, y] of [[-1, 0], [120, 0], [0, 96], [NaN, 0], [0, Infinity]]) assert.equal(fog.stateAt(0, x, y), 0);
  fog.update([]); assert.equal(fog.stateAt(0, 0, 0), 1);
  const w = world({ bases: [{ x: 800, y: 600 }, { x: 2800, y: 1800 }] });
  assert.equal(w.visibleAt(0, 800, 600), true); assert.equal(w.visibleAt(0, 420, 1200), false);
  assert.equal(w.snapshot().fog.teams[0].visibleEntityIds.includes(w.base(1).id), false);
});
