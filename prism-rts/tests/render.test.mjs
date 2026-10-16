import test from 'node:test';
import assert from 'node:assert/strict';
import { Renderer, projectPoint, unprojectPoint } from '../dist/render.js';
import { BUILDINGS, UNITS, MAP, BASES, CAPTURE_SITE } from '../dist/engine.js';

function recordingContext() {
  const commands = [];
  const context = { commands, globalAlpha: 1, measureText: text => ({ width: text.length * 7 }) };
  for (const method of ['beginPath', 'closePath', 'moveTo', 'lineTo', 'arc', 'roundRect', 'fill', 'stroke', 'fillRect', 'strokeRect', 'clearRect', 'save', 'restore', 'translate', 'rotate', 'scale', 'setLineDash', 'fillText']) {
    context[method] = (...args) => {
      for (const value of args) if (typeof value === 'number') assert.ok(Number.isFinite(value), `${method} received a non-finite value`);
      commands.push([method, ...args]);
    };
  }
  for (const property of ['fillStyle', 'strokeStyle']) Object.defineProperty(context, property, {
    set(value) { if (typeof value === 'string') assert.match(value, /^#[0-9a-f]{6}([0-9a-f]{2})?$/i); else assert.equal(value.gradient, true); commands.push([property, value]); }
  });
  context.createRadialGradient = (...args) => {
    for (const value of args) assert.ok(Number.isFinite(value));
    commands.push(['createRadialGradient', ...args]);
    return { gradient: true, addColorStop(position, color) { assert.ok(position >= 0 && position <= 1); assert.match(color, /^#[0-9a-f]{8}$/i); } };
  };
  return context;
}

function drawingView(world = {}) {
  return Object.assign(Object.create(Renderer.prototype), {
    ctx: recordingContext(), mc: recordingContext(), width: 1000, height: 650, dpr: 1,
    camera: { x: 900, y: 800, z: .66 }, mini: { width: 200, height: 130 },
    reducedMotion: true, realTime: 0, states: new Map(), selected: new Set(),
    getWorld: () => ({ all: () => [], obstacles: [], terrain: [], constructionHasCore: () => true, technologyActive: () => false, ...world })
  });
}

test('top-down projection preserves equal X/Y distances and round-trips on desktop and phone', () => {
  for (const [width, height] of [[1006, 658], [390, 568]]) {
    for (const z of [.3, .66, 1.7]) {
      const camera = { x: 680, y: 840, z };
      const center = projectPoint(camera, width, height, 370, 800);
      const x = projectPoint(camera, width, height, 470, 800);
      const y = projectPoint(camera, width, height, 370, 900);
      assert.ok(Math.abs((x.x - center.x) - (y.y - center.y)) < 1e-9);
      const restored = unprojectPoint(camera, width, height, center.x, center.y);
      assert.ok(Math.abs(restored.x - 370) < 1e-9);
      assert.ok(Math.abs(restored.y - 800) < 1e-9);
    }
  }
});

test('zoom keeps the pointed-at world position stable and panning uses the same scale on both axes', () => {
  const view = Object.assign(Object.create(Renderer.prototype), { width: 1000, height: 650, camera: { x: 900, y: 800, z: .66 } });
  const before = view.world(450, 270);
  view.zoom(1.2, 450, 270);
  const after = view.world(450, 270);
  assert.ok(Math.hypot(after.x - before.x, after.y - before.y) < 1e-9);
  const camera = { ...view.camera };
  view.pan(50, 50);
  assert.ok(Math.abs((camera.x - view.camera.x) - (camera.y - view.camera.y)) < 1e-9);
});

test('selection follows flat footprints without height offsets and ignores docked cores', () => {
  const building = { id: 1, kind: 'building', x: 370, y: 800, r: 59 };
  const dockedCore = { id: 2, kind: 'core', x: 370, y: 800, r: 15, dock: 1 };
  const unit = { id: 3, kind: 'unit', x: 650, y: 950, r: 10 };
  const view = Object.assign(Object.create(Renderer.prototype), { width: 1000, height: 650, camera: { x: 680, y: 840, z: .66 }, getWorld: () => ({ all: () => [building, dockedCore, unit] }) });
  const a = view.screen(building.x, building.y), b = view.screen(unit.x, unit.y);
  assert.equal(view.hit(a.x, a.y), building);
  assert.equal(view.hit(b.x + 10, b.y + 10), unit);
  assert.equal(view.hit(a.x, a.y - 65), null);
});

test('every unit has a distinct silhouette and renders selection, damage, recoil and team colors at every zoom', () => {
  const silhouettes = new Set();
  for (const [type, d] of Object.entries(UNITS)) {
    const glyph = drawingView(); glyph.unitGlyph(type, 15, '#abcdef');
    silhouettes.add(JSON.stringify(glyph.ctx.commands));
    for (const z of [.3, .66, 1.7]) for (const team of [0, 1]) {
      const view = drawingView(); view.camera.z = z;
      const unit = { id: 1, kind: 'unit', type, team, x: 900, y: 800, r: d.r, hp: d.hp / 2, maxHp: d.hp };
      view.states.set(unit.id, { x: unit.x, y: unit.y, age: 1, select: 1, hit: .2, angle: .7, recoil: 1 });
      view.drawUnit(unit);
      assert.ok(view.ctx.commands.some(([method, color]) => method === 'fillStyle' && color === '#f5faf8'), `${type} has a damage flash`);
      assert.ok(view.ctx.commands.some(([method, color]) => method === 'fillStyle' && color === (team ? '#f48291' : d.color)), `${type} retains its team/unit color`);
    }
  }
  assert.equal(silhouettes.size, Object.keys(UNITS).length, 'unit silhouettes must not silently fall through to one shared shape');
});

test('all building glyphs render visibly in placement previews and minimap uses their configured colors', () => {
  const silhouettes = new Set();
  for (const [type, d] of Object.entries(BUILDINGS)) {
    const view = drawingView(); view.placement = { ok: true };
    view.drawBuilding({ type, x: 900, y: 800, r: d.r, team: 0 }, true);
    assert.ok(view.ctx.commands.some(([method]) => method === 'stroke'), `${type} placement must be visible`);
    const glyph = drawingView(); glyph.glyph(type, 35, '#abcdef');
    silhouettes.add(JSON.stringify(glyph.ctx.commands));
    const map = drawingView({ all: () => [{ kind: 'building', type, x: 900, y: 800, team: 0 }] });
    map.drawMini();
    assert.ok(map.mc.commands.some(([method, color]) => ['fillStyle', 'strokeStyle'].includes(method) && color === d.color), `${type} minimap color`);
  }
  assert.equal(silhouettes.size, Object.keys(BUILDINGS).length);
});

test('technology buildings show timed research and retain their completed badge without a core', () => {
  for (const [type, d] of Object.entries(BUILDINGS).filter(([, d]) => d.technology)) {
    const building = { id: 1, kind: 'building', type, x: 900, y: 800, r: d.r, team: 0, hp: d.hp, maxHp: d.hp, core: 2, powered: true, researchJob: { remaining: 5, total: 10 } };
    const view = drawingView(); view.drawBuilding(building);
    assert.ok(view.ctx.commands.some(([method, text]) => method === 'fillText' && text === '研究 · 5s'));
    building.core = null; view.ctx.commands.length = 0; view.drawBuilding(building);
    assert.ok(view.ctx.commands.some(([method, text]) => method === 'fillText' && text === '研究 · 暂停'));
    building.researchJob = null;
    const unresearched = drawingView(), researched = drawingView({ technologyActive: () => true });
    unresearched.drawBuilding(building); researched.drawBuilding(building);
    assert.ok(researched.ctx.commands.length > unresearched.ctx.commands.length, 'completed badge persists after undocking');
  }
});

test('new weapons show distinct flight and impact effects with valid canvas geometry', () => {
  const signatures = new Set();
  for (const weapon of ['infantry', 'sniper', 'rocketeer', 'artillery']) {
    const view = drawingView();
    view.vfx = [{ type: 'shot', weapon, x: 800, y: 800, tx: 1000, ty: 850, age: .1, duration: .5, color: '#abcdef' }];
    view.drawEffects(); signatures.add(JSON.stringify(view.ctx.commands));
    view.vfx[0].age = .4; view.drawEffects();
    assert.ok(view.ctx.commands.some(([method]) => method === 'arc'), `${weapon} has an impact`);
  }
  assert.equal(signatures.size, 4);
});

test('camera homes on the current base and can show the whole larger map on desktop and phone', () => {
  for (const [width, height] of [[1000, 650], [390, 568]]) {
    const base = { ...BASES[0] }, view = drawingView({ base: () => base });
    view.width = width; view.height = height; view.home();
    const p = view.screen(base.x, base.y);
    assert.ok(p.x > 50 && p.x < width - 50 && p.y > 50 && p.y < height - 50);
    assert.ok(Math.abs(view.camera.y - base.y) < 100, 'home follows the relocated base, not the old map center');
    view.overview();
    for (const [x, y] of [[0, 0], [MAP.w, MAP.h]]) {
      const p = view.screen(x, y);
      assert.ok(p.x >= 0 && p.x <= width && p.y >= 0 && p.y <= height, 'overview fits every corner');
    }
    view.zoom(.001);
    assert.ok(view.camera.z <= .18);
    assert.ok(view.camera.z * MAP.w <= width && view.camera.z * MAP.h <= height);
  }
});

test('relay hit area never steals clicks from a unit, loose core or structure inside it', () => {
  const relay = { id: 1, kind: 'capture', ...CAPTURE_SITE };
  const entities = [relay], view = drawingView({ all: () => entities });
  view.camera.x = relay.x; view.camera.y = relay.y;
  for (const kind of ['unit', 'core', 'building']) {
    const object = { id: 2, kind, x: relay.x + 10, y: relay.y, r: 15 };
    entities.push(object);
    const p = view.screen(relay.x, relay.y);
    assert.equal(view.hit(p.x, p.y), object, kind);
    entities.pop();
  }
  const inside = view.screen(relay.x + relay.r * .8, relay.y), outside = view.screen(relay.x + relay.r + 20, relay.y);
  assert.equal(view.hit(inside.x, inside.y), relay);
  assert.equal(view.hit(outside.x, outside.y), null);
});

test('neutral caches and unclaimed cores stay gold, have actionable labels and never appear as enemy units', () => {
  const cache = { id: 1, kind: 'building', type: 'cache', team: -1, x: 900, y: 800, r: BUILDINGS.cache.r, hp: BUILDINGS.cache.hp, maxHp: BUILDINGS.cache.hp };
  const core = { id: 2, kind: 'core', type: 'core', team: -1, x: 1020, y: 800, r: 15, energy: 0 };
  const view = drawingView({ all: () => [cache, core] });
  view.states.set(cache.id, { age: 1, select: 1, hit: 0 });
  view.states.set(core.id, { x: core.x, y: core.y, select: 0, age: 1 });
  view.drawBuilding(cache); view.drawCore(core); view.drawMini();
  const colors = [...view.ctx.commands, ...view.mc.commands].filter(([method]) => ['fillStyle', 'strokeStyle'].includes(method)).map(([, color]) => color);
  assert.ok(colors.includes(BUILDINGS.cache.color));
  assert.ok(!colors.some(color => typeof color === 'string' && color.startsWith('#f48291')), 'neutral objects are not enemy red');
  assert.ok(view.ctx.commands.some(([method, text]) => method === 'fillText' && text === '无主核心 · 派兵回收'));
  assert.ok(view.ctx.commands.some(([method, text]) => method === 'fillText' && text === '击毁后派兵回收核心'));
  assert.ok(!view.ctx.commands.some(([method, text]) => method === 'fillText' && text === '停电'));
});

test('relay renders neutral, allied, enemy and contested control with a correctly rounded reward timer', () => {
  const relay = { id: 1, kind: 'capture', type: 'relay', team: -1, ...CAPTURE_SITE, duration: 180, progress: 120.2, occupants: [2, 1], contested: false };
  for (const owner of [null, 0, 1]) {
    relay.owner = owner;
    const view = drawingView({ all: () => [relay] }); view.camera.x = relay.x; view.camera.y = relay.y;
    view.drawCapture(relay); view.drawMini();
    const color = owner === 0 ? '#88e6c5' : owner === 1 ? '#f48291' : BUILDINGS.cache.color;
    assert.ok(view.mc.commands.some(([method, value]) => method === 'strokeStyle' && value === color));
    assert.ok(view.ctx.commands.some(([method, text]) => method === 'fillText' && text === (owner == null ? '派兵占领 · 每 03:00 获得核心' : `${owner === 0 ? '我方控制' : '敌方控制'} · 核心 01:00`)));
  }
  relay.contested = true;
  const view = drawingView(); view.camera.x = relay.x; view.camera.y = relay.y;
  view.drawCapture(relay);
  assert.ok(view.ctx.commands.some(([method, text]) => method === 'fillText' && text === '争夺中 · 计时暂停 01:00'));
  assert.ok(view.ctx.commands.some(([method, text]) => method === 'fillText' && text === '我方 2  ·  敌方 1'));
});

test('core light and attached building energy remain valid at every zoom and under reduced motion', () => {
  for (const z of [.18, .66, 1.7]) for (const reducedMotion of [false, true]) for (const team of [-1, 0, 1]) {
    const core = { id: 2, kind: 'core', type: 'core', team, x: 900, y: 800, r: 15, serial: 2, energy: 400 };
    const view = drawingView({ byId: id => id === core.id ? core : null });
    view.camera.z = z; view.reducedMotion = reducedMotion; view.realTime = 1.7;
    view.states.set(core.id, { x: core.x, y: core.y, select: 1 });
    view.drawCore(core);
    assert.ok(view.ctx.commands.some(([method]) => method === 'createRadialGradient'));
    if (team < 0) continue;
    const d = BUILDINGS.barracks, building = { id: 1, type: 'barracks', kind: 'building', team, x: 900, y: 800, r: d.r, hp: d.hp, maxHp: d.hp, core: core.id, powered: true, job: { total: 4, remaining: 2 } };
    view.ctx.commands.length = 0; view.drawBuilding(building);
    assert.ok(view.ctx.commands.some(([method]) => method === 'createRadialGradient'), 'attached structure shows energy light');
    building.core = null; view.ctx.commands.length = 0; view.drawBuilding(building);
    assert.ok(!view.ctx.commands.some(([method]) => method === 'createRadialGradient'), 'unpowered-by-core structures do not imply an occupied slot');
  }
});
