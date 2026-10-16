import { MAP, BUILDINGS, UNITS, clamp } from './engine.js';
import { polygonBounds } from './terrain.js';

const TAU = Math.PI * 2;
const COLORS = { ground: '#141a20', outside: '#10151b', grid: '#323b43', text: '#b9c4cd', muted: '#687680', ally: '#88e6c5', enemy: '#f48291', neutral: BUILDINGS.cache?.color || '#e9c779', ...Object.fromEntries(Object.entries(BUILDINGS).map(([type, d]) => [type, d.color])) };
const CORE_COLORS = ['#88e6c5', '#aa9ae5', '#e9c779'];
const teamColor = team => team === 0 ? COLORS.ally : team === 1 ? COLORS.enemy : COLORS.neutral;
const coreColor = e => e.team === -1 ? COLORS.neutral : e.team === 1 ? COLORS.enemy : CORE_COLORS[((e.serial || 1) - 1) % CORE_COLORS.length];
const timerText = seconds => { const rounded = Math.ceil(Math.max(0, seconds)); return `${String(Math.floor(rounded / 60)).padStart(2, '0')}:${String(rounded % 60).padStart(2, '0')}`; };
const easeOut = t => 1 - (1 - clamp(t, 0, 1)) ** 3;
const easeBack = t => { t = clamp(t, 0, 1) - 1; return 1 + 2.3 * t ** 3 + 1.3 * t ** 2; };
const angleLerp = (a, b, t) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;
const alpha = (hex, opacity) => hex + Math.round(clamp(opacity, 0, 1) * 255).toString(16).padStart(2, '0');

// True orthographic top-down projection: X and Y use exactly the same scale.
export function projectPoint(camera, width, height, x, y) {
  return { x: (x - camera.x) * camera.z + width / 2, y: (y - camera.y) * camera.z + height / 2 };
}
export function unprojectPoint(camera, width, height, x, y) {
  return { x: (x - width / 2) / camera.z + camera.x, y: (y - height / 2) / camera.z + camera.y };
}
function polygon(c, points, fill, stroke, lineWidth = 1) {
  c.beginPath(); points.forEach(([x, y], i) => i ? c.lineTo(x, y) : c.moveTo(x, y)); c.closePath();
  if (fill) { c.fillStyle = fill; c.fill(); } if (stroke) { c.strokeStyle = stroke; c.lineWidth = lineWidth; c.stroke(); }
}
function regular(c, x, y, r, sides, fill, stroke, width = 1, rotation = -Math.PI / 2) {
  polygon(c, Array.from({ length: sides }, (_, i) => [x + Math.cos(rotation + i * TAU / sides) * r, y + Math.sin(rotation + i * TAU / sides) * r]), fill, stroke, width);
}
function circle(c, x, y, r, fill, stroke, width = 1) {
  c.beginPath(); c.arc(x, y, Math.max(0, r), 0, TAU);
  if (fill) { c.fillStyle = fill; c.fill(); } if (stroke) { c.strokeStyle = stroke; c.lineWidth = width; c.stroke(); }
}
function segment(c, x1, y1, x2, y2, color, width = 1) {
  c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.strokeStyle = color; c.lineWidth = width; c.stroke();
}
function rounded(c, x, y, width, height, radius, fill, stroke, lineWidth = 1) {
  c.beginPath(); c.roundRect(x, y, width, height, radius);
  if (fill) { c.fillStyle = fill; c.fill(); } if (stroke) { c.strokeStyle = stroke; c.lineWidth = lineWidth; c.stroke(); }
}
function glow(c, x, y, radius, color, strength = .3) {
  if (radius <= 0 || strength <= .001) return;
  const gradient = c.createRadialGradient(x, y, 0, x, y, radius);
  gradient.addColorStop(0, alpha(color, strength));
  gradient.addColorStop(.38, alpha(color, strength * .48));
  gradient.addColorStop(1, alpha(color, 0));
  c.beginPath(); c.arc(x, y, radius, 0, TAU); c.fillStyle = gradient; c.fill();
}

export class Renderer {
  constructor(canvas, mini, getWorld) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.mini = mini; this.mc = mini.getContext('2d'); this.getWorld = getWorld;
    this.camera = { x: 680, y: 820, z: .66 }; this.width = 1; this.height = 1;
    this.selected = new Set(); this.hover = null; this.groundHover = null; this.placement = null; this.box = null; this.realTime = 0; this.coreHold = null; this.coreDrag = null;
    this.states = new Map(); this.vfx = []; this.seenShots = new WeakSet(); this.seenEffects = new WeakSet(); this.lastWorld = null;
    this.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.resize(); this.home(); new ResizeObserver(() => this.resize()).observe(canvas);
  }
  resize() {
    const r = this.canvas.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2);
    this.width = Math.max(1, r.width); this.height = Math.max(1, r.height); this.dpr = dpr;
    this.canvas.width = Math.round(this.width * dpr); this.canvas.height = Math.round(this.height * dpr);
    const mr = this.mini.getBoundingClientRect(); this.mini.width = Math.max(1, Math.round(mr.width * dpr)); this.mini.height = Math.max(1, Math.round(mr.height * dpr));
  }
  screen(x, y) { return projectPoint(this.camera, this.width, this.height, x, y); }
  world(x, y) { return unprojectPoint(this.camera, this.width, this.height, x, y); }
  home() {
    const base = this.getWorld().base?.(0) || { x: MAP.w * .116667, y: MAP.h / 2 };
    this.camera.x = base.x + (this.width < 600 ? 160 : 310); this.camera.y = base.y + 40; this.camera.z = this.width < 600 ? .5 : .66; this.clampCamera();
  }
  minZoom() { return Math.min(.18, this.width / MAP.w * .92, this.height / MAP.h * .92); }
  overview() { this.camera.x = MAP.w / 2; this.camera.y = MAP.h / 2; this.camera.z = Math.min(.66, this.width / MAP.w * .92, this.height / MAP.h * .92); }
  zoom(factor, x = this.width / 2, y = this.height / 2) {
    const before = this.world(x, y); this.camera.z = clamp(this.camera.z * factor, this.minZoom(), 1.7);
    const after = this.world(x, y); this.camera.x += before.x - after.x; this.camera.y += before.y - after.y; this.clampCamera();
  }
  clampCamera() { this.camera.x = clamp(this.camera.x, 80, MAP.w - 80); this.camera.y = clamp(this.camera.y, 100, MAP.h - 80); }
  pan(dx, dy) { this.camera.x -= dx / this.camera.z; this.camera.y -= dy / this.camera.z; this.clampCamera(); }
  visible(x, y, margin = 100) { const p = this.screen(x, y); return p.x > -margin && p.y > -margin && p.x < this.width + margin && p.y < this.height + margin; }
  entityVisible(w, entity) { return w.canSee?.(0, entity) ?? true; }
  emit(effect) { if (this.vfx.length < 240) this.vfx.push({ age: 0, ...effect }); }
  particles(x, y, color, count = 8, strength = 45) {
    if (this.reducedMotion) return;
    for (let i = 0; i < count; i++) {
      const angle = i * 2.39996 + this.realTime, speed = strength * (.4 + (i % 5) / 6);
      this.emit({ type: 'particle', x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, size: i % 3 === 0 ? 3 : 1.8, color, duration: .35 + (i % 4) * .11 });
    }
  }
  sync(w, dt) {
    if (this.lastWorld !== w) { this.states.clear(); this.vfx = []; this.seenShots = new WeakSet(); this.seenEffects = new WeakSet(); this.lastWorld = w; }
    const smoothing = this.reducedMotion ? 1 : 1 - Math.exp(-24 * dt);
    const all = w.all().filter(entity => this.entityVisible(w, entity)), live = new Set(all.map(e => e.id));
    for (const id of this.selected) if (!live.has(id)) this.selected.delete(id);
    if (this.hover && !live.has(this.hover.id)) this.hover = null;
    for (const e of all) {
      let s = this.states.get(e.id);
      if (!s) {
        s = { x: e.x, y: e.y, angle: e.angle || 0, age: 0, select: 0, core: e.core, dock: e.dock, construction: e.construction, hp: e.hp, hit: 0, recoil: 0, trail: [], trailClock: 0, energyPresence: e.core ? 1 : 0, energyCore: w.byId(e.core) };
        this.states.set(e.id, s);
        if (e.kind === 'unit') this.emit({ type: 'ring', x: e.x, y: e.y, radius: 34, color: teamColor(e.team), duration: .65 });
        if (e.kind === 'building' && e.deployed) { this.emit({ type: 'ring', x: e.x, y: e.y, radius: e.r + 65, color: e.team === 1 ? COLORS.enemy : COLORS[e.type], duration: .8 }); this.particles(e.x, e.y, COLORS[e.type], 10, e.r + 30); }
      }
      s.age += dt; s.x += (e.x - s.x) * smoothing; s.y += (e.y - s.y) * smoothing; s.angle = angleLerp(s.angle, e.angle || 0, 1 - Math.exp(-18 * dt));
      s.select += ((this.selected.has(e.id) ? 1 : 0) - s.select) * (1 - Math.exp(-17 * dt));
      s.hit = Math.max(0, s.hit - dt); s.recoil = Math.max(0, s.recoil - dt * 7);
      if (e.hp < s.hp) s.hit = .22;
      if (s.construction > 0 && e.construction === 0) {
        this.emit({ type: 'ring', x: e.x, y: e.y, radius: e.r + 65, color: COLORS[e.type], duration: .8 });
        this.particles(e.x, e.y, COLORS[e.type], 10, e.r + 30);
      }
      if (e.kind === 'core' && e.dock && e.dock !== s.dock) {
        const b = w.byId(e.dock);
        if (b) { this.emit({ type: 'ring', x: b.x, y: b.y, radius: b.r + 25, color: coreColor(e), duration: .65 }); this.particles(b.x, b.y, teamColor(e.team), 6, 45); }
      }
      if (e.kind === 'building') {
        const core = w.dockedCore(e);
        if (s.core && !core && s.energyCore) this.emit({ type: 'ring', x: e.x, y: e.y, radius: e.r + 16, color: coreColor(s.energyCore), duration: .4 });
        s.energyPresence += ((core ? 1 : 0) - s.energyPresence) * (this.reducedMotion ? 1 : 1 - Math.exp(-9 * dt));
        if (core) s.energyCore = core;
        s.core = e.core;
      }
      s.trailClock += dt;
      if (e.kind !== 'building' && !e.dock && e.path?.length && s.trailClock > .045) {
        const p = s.trail[s.trail.length - 1]; if (!p || Math.hypot(e.x - p.x, e.y - p.y) > 3) s.trail.push({ x: e.x, y: e.y, life: .36 }); s.trailClock = 0;
      }
      for (const p of s.trail) p.life -= dt; s.trail = s.trail.filter(p => p.life > 0).slice(-9);
      s.hp = e.hp; s.construction = e.construction; s.dock = e.dock;
    }
    for (const id of this.states.keys()) if (!live.has(id)) this.states.delete(id);
    for (const shot of w.shots) if (!this.seenShots.has(shot)) {
      this.seenShots.add(shot);
      if (w.visibleAt && (!w.visibleAt(0, shot.x, shot.y) || !w.visibleAt(0, shot.tx, shot.ty))) continue;
      const color = shot.team === 1 ? '#fba8ae' : UNITS[shot.weapon]?.color || '#baf4d6';
      const duration = shot.weapon === 'sniper' ? .2 : shot.weapon === 'artillery' ? .5 : shot.weapon === 'rocketeer' ? .4 : shot.heavy ? .32 : .23;
      this.emit({ type: 'shot', x: shot.x, y: shot.y, tx: shot.tx, ty: shot.ty, color, heavy: shot.heavy, weapon: shot.weapon, duration });
      this.particles(shot.x, shot.y, color, 3, 32);
      for (const e of all) if (e.team === shot.team && Math.hypot(e.x - shot.x, e.y - shot.y) < 2) { const s = this.states.get(e.id); if (s) s.recoil = 1; }
    }
    for (const effect of w.effects) if (!this.seenEffects.has(effect)) {
      this.seenEffects.add(effect);
      if ((effect.type === 'order' || effect.type === 'blocked-order') && effect.team === 1) continue;
      if (effect.type === 'burst' && w.visibleAt && !w.visibleAt(0, effect.x, effect.y)) continue;
      if (effect.type === 'order') this.emit({ type: 'order', x: effect.x, y: effect.y, radius: 32, color: effect.attack ? COLORS.enemy : COLORS.ally, duration: .7 });
      else if (effect.type === 'blocked-order') this.emit({ type: 'blocked-order', x: effect.x, y: effect.y, color: COLORS.enemy, duration: .6 });
      else if (effect.type === 'burst') {
        this.emit({ type: 'ring', x: effect.x, y: effect.y, radius: effect.big ? 120 : 48, color: effect.color, duration: effect.big ? .85 : .5 });
        this.emit({ type: 'flash', x: effect.x, y: effect.y, radius: effect.big ? 40 : 17, color: '#eef8ef', duration: .2 });
        this.particles(effect.x, effect.y, effect.color, effect.big ? 22 : 10, effect.big ? 150 : 85);
      }
    }
    for (const e of this.vfx) e.age += dt; this.vfx = this.vfx.filter(e => e.age < e.duration);
  }
  label(text, x, y, color = COLORS.text, size = 11) {
    const c = this.ctx; c.font = `500 ${size}px 'Segoe UI','Microsoft YaHei',sans-serif`; c.textAlign = 'center'; c.textBaseline = 'middle';
    const width = c.measureText(text).width;
    rounded(c, x - width / 2 - 6, y - 9, width + 12, 18, 4, '#141a20e8'); c.fillStyle = color; c.fillText(text, x, y);
  }
  drawGround() {
    const c = this.ctx, z = this.camera.z;
    c.fillStyle = COLORS.outside; c.fillRect(0, 0, this.width, this.height);
    const a = this.screen(105, 135), b = this.screen(MAP.w - 105, MAP.h - 115);
    rounded(c, a.x, a.y, b.x - a.x, b.y - a.y, 16 * z, COLORS.ground, '#313a43', 1);
    const lo = this.world(0, 0), hi = this.world(this.width, this.height), step = 100;
    c.fillStyle = '#414b554d';
    for (let x = Math.max(200, Math.ceil(lo.x / step) * step); x < Math.min(MAP.w - 100, hi.x); x += step) {
      for (let y = Math.max(200, Math.ceil(lo.y / step) * step); y < Math.min(MAP.h - 100, hi.y); y += step) { const p = this.screen(x, y); c.fillRect(p.x, p.y, 1, 1); }
    }
    const w = this.getWorld();
    for (const o of w.obstacles) {
      if (!this.visible(o.x, o.y)) continue; const p = this.screen(o.x, o.y);
      circle(c, p.x, p.y, o.r * z, '#282d33', '#535b63', 1);
      const r = Math.min(4, 5 * z); segment(c, p.x - r, p.y - r, p.x + r, p.y + r, '#7c858a80'); segment(c, p.x - r, p.y + r, p.x + r, p.y - r, '#7c858a80');
    }
    for (const t of w.terrain) {
      const bounds = polygonBounds(t.points), a = this.screen(bounds.left, bounds.top), b = this.screen(bounds.right, bounds.bottom);
      if (b.x < 0 || b.y < 0 || a.x > this.width || a.y > this.height) continue;
      const water = t.kind === 'water', points = t.points.map(([x, y]) => { const p = this.screen(x, y); return [p.x, p.y]; });
      polygon(c, points, water ? '#172b36' : '#332e30', water ? '#436477' : '#796a68', 1.3);
      c.save(); polygon(c, points); c.clip();
      if (water) {
        for (let y = a.y + 16 * z, row = 0; y < b.y; y += 30 * z, row++) {
          for (let x = a.x + (row % 2) * 28 * z; x < b.x; x += 65 * z) {
            c.beginPath(); c.moveTo(x, y); c.quadraticCurveTo(x + 10 * z, y - 4 * z, x + 20 * z, y); c.quadraticCurveTo(x + 27 * z, y + 3 * z, x + 34 * z, y);
            c.strokeStyle = '#52768a38'; c.lineWidth = 1; c.stroke();
          }
        }
      } else {
        for (let x = a.x - (b.y - a.y); x < b.x; x += 22 * z) segment(c, x, b.y, x + b.y - a.y, a.y, '#a38d7b20');
      }
      c.restore();
      if (water && z > .42) { const p = this.screen(t.label.x, t.label.y); this.label(t.name + ' · 不可通行', p.x, p.y, '#799dad', 10); }
    }
  }
  ringProgress(x, y, r, fraction, color, width = 2) {
    const c = this.ctx; circle(c, x, y, r, null, alpha(color, .12), width);
    c.beginPath(); c.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + TAU * clamp(fraction, 0, 1)); c.strokeStyle = color; c.lineWidth = width; c.lineCap = 'round'; c.stroke();
  }
  selectionRing(x, y, r, strength, color) {
    if (strength < .01) return;
    const c = this.ctx; c.save(); c.globalAlpha *= strength;
    const radius = r + 8 + (1 - strength) * 14;
    circle(c, x, y, radius, null, alpha(color, .52), 1);
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2 + Math.PI / 4;
      c.beginPath(); c.arc(x, y, radius + 1, a - .11, a + .11); c.strokeStyle = color; c.lineWidth = 2; c.stroke();
    }
    c.restore();
  }
  glyph(type, radius, color, angle = 0, recoil = 0) {
    const c = this.ctx, r = radius;
    c.lineCap = 'round'; c.lineJoin = 'round';
    if (type === 'hq') {
      rounded(c, -r * .72, -r * .72, r * 1.44, r * 1.44, 5, alpha(color, .09), color, 1.7);
      const k = r * .15;
      for (const [x, y] of [[-k * 2.3, -k * 2.3], [k * .3, -k * 2.3], [-k * 2.3, k * .3], [k * .3, k * .3]]) rounded(c, x, y, k * 2, k * 2, 1.5, color);
    } else if (type === 'power') {
      regular(c, 0, 0, r * .85, 6, alpha(color, .09), color, 1.6, 0);
      polygon(c, [[2, -r * .43], [-r * .29, r * .04], [-2, r * .04], [-2, r * .43], [r * .3, -r * .07], [2, -r * .07]], color);
    } else if (type === 'barracks') {
      rounded(c, -r * .72, -r * .66, r * 1.44, r * 1.32, 4, alpha(color, .09), color, 1.6);
      for (let i = -1; i <= 1; i++) rounded(c, i * r * .3 - r * .075, -r * .31, r * .15, r * .62, 1.5, color);
    } else if (type === 'factory') {
      regular(c, 0, 0, r * .9, 8, alpha(color, .09), color, 1.6, Math.PI / 8);
      rounded(c, -r * .38, -r * .29, r * .76, r * .58, 3, color);
      segment(c, -r * .33, -r * .4, r * .33, -r * .4, color, 2); segment(c, -r * .33, r * .4, r * .33, r * .4, color, 2);
      segment(c, 0, 0, r * .64, 0, color, 3);
    } else if (type === 'academy') {
      rounded(c, -r * .74, -r * .74, r * 1.48, r * 1.48, 5, alpha(color, .09), color, 1.6);
      polygon(c, [[0, -r * .47], [r * .42, -r * .06], [r * .26, r * .1], [0, -r * .15], [-r * .26, r * .1], [-r * .42, -r * .06]], color);
      polygon(c, [[-r * .3, r * .19], [0, r * .38], [r * .3, r * .19], [r * .3, r * .34], [0, r * .53], [-r * .3, r * .34]], color);
    } else if (type === 'arsenal') {
      regular(c, 0, 0, r * .9, 8, alpha(color, .09), color, 1.6, Math.PI / 8);
      polygon(c, [[-r * .36, -r * .4], [r * .36, -r * .4], [r * .31, r * .13], [0, r * .48], [-r * .31, r * .13]], alpha(color, .23), color, 1.8);
      segment(c, 0, -r * .23, 0, r * .25, color, 2);
      segment(c, -r * .17, -.02 * r, r * .17, -.02 * r, color, 2);
    } else if (type === 'mobility') {
      regular(c, 0, 0, r * .9, 6, alpha(color, .09), color, 1.6, Math.PI / 6);
      for (const x of [-.34, 0, .34]) {
        segment(c, (x - .13) * r, -r * .28, (x + .1) * r, 0, color, 2.5);
        segment(c, (x + .1) * r, 0, (x - .13) * r, r * .28, color, 2.5);
      }
    } else if (type === 'cache') {
      rounded(c, -r * .74, -r * .66, r * 1.48, r * 1.32, 3, alpha(color, .07), color, 1.6);
      for (const x of [-.74, .48]) rounded(c, r * x, -r * .66, r * .26, r * 1.32, 1, alpha(color, .17), color, 1);
      regular(c, 0, 0, r * .36, 4, alpha(color, .16), color, 1.6);
      regular(c, 0, 0, r * .12, 4, color);
    } else if (type === 'tower') {
      circle(c, 0, 0, r * .8, alpha(color, .09), color, 1.6);
      c.save(); c.rotate(angle); segment(c, -r * .1 - recoil * 3, 0, r * 1.03 - recoil * 3, 0, color, 4); circle(c, 0, 0, r * .33, color); c.restore();
    }
  }
  drawBuilding(e, ghost = false) {
    if (!this.visible(e.x, e.y, 150)) return;
    const c = this.ctx, z = this.camera.z, s = this.states.get(e.id), p = this.screen(e.x, e.y), r = e.r * z;
    const color = ghost ? (this.placement?.ok ? COLORS.ally : COLORS.enemy) : e.team === -1 ? COLORS.neutral : e.team === 1 ? COLORS.enemy : COLORS[e.type];
    const born = !s || this.reducedMotion ? 1 : easeBack(s.age / .42);
    const underConstruction = e.construction > 0, active = underConstruction && this.getWorld().constructionHasCore(e);
    const core = this.getWorld().byId?.(e.core), energyPresence = s?.energyPresence ?? (e.core ? 1 : 0);
    const energyColor = coreColor(core || s?.energyCore || { team: e.team, serial: 1 });
    const job = e.buildJob || e.job || e.researchJob;
    const working = !!(core && job && job.remaining > 0 && !job.paused && (e.buildJob ? this.getWorld().constructionHasCore(job) && job.paidCore : e.powered));
    const powered = e.powered !== false, energyPulse = this.reducedMotion ? 1 : .9 + Math.sin(this.realTime * 2.6 + (core?.serial || 0)) * .1;
    const energyStrength = energyPresence * (working ? .9 : powered ? .53 : .25) * energyPulse;
    if (!ghost && !underConstruction && BUILDINGS[e.type].acceptsCore && energyPresence > .01) glow(c, p.x, p.y, r * 1.85 + 12, energyColor, energyStrength * .43);
    if (s) this.selectionRing(p.x, p.y, r, Math.max(s.select, this.selected.has(e.core) ? .9 : 0), color);
    if (e.type === 'tower' && s?.select > .1 && !underConstruction) circle(c, p.x, p.y, (this.getWorld().buildings || BUILDINGS).tower.range * z, null, alpha(color, .11 * s.select), 1);
    c.save(); c.translate(p.x, p.y); c.scale(born, born);
    c.globalAlpha = ghost ? .6 : underConstruction ? .42 : 1;
    this.glyph(e.type, r, s?.hit > 0 ? '#edf8f3' : color, s?.angle || 0, s?.recoil || 0); c.restore();
    if (ghost) return;
    if (underConstruction) {
      this.ringProgress(p.x, p.y, r + 8, 1 - e.construction / e.buildTime, active ? color : '#e9c779', 2);
      if (active && !this.reducedMotion) {
        const a = this.getWorld().time * 2 - Math.PI / 2;
        circle(c, p.x + Math.cos(a) * (r + 8), p.y + Math.sin(a) * (r + 8), 2, color);
      }
      this.label(active ? `${Math.ceil(e.construction)}s` : '暂停 · 建造厂缺核心', p.x, p.y + r + 24, active ? COLORS.text : '#e9c779', 11);
    } else if (e.buildJob || e.job || e.researchJob) {
      const job = e.buildJob || e.job || e.researchJob, running = !job.paused && (e.buildJob ? this.getWorld().constructionHasCore(job) && job.paidCore : e.powered && e.core);
      this.ringProgress(p.x, p.y, r + 6, 1 - job.remaining / job.total, running ? color : '#e9c779', 2);
      if (e.buildJob) this.label(job.remaining === 0 ? '就绪 · 点击侧栏放置' : `${BUILDINGS[job.type].name} · ${running ? Math.ceil(job.remaining) + 's' : '暂停'}`, p.x, p.y + r + 34, job.remaining === 0 ? color : COLORS.text, 10);
      if (e.researchJob) this.label(`研究 · ${running ? Math.ceil(job.remaining) + 's' : '暂停'}`, p.x, p.y + r + 34, running ? color : '#e9c779', 10);
    }
    if (!underConstruction && BUILDINGS[e.type].acceptsCore && energyPresence > .01) {
      const phase = this.reducedMotion || !working ? 0 : this.realTime * .65;
      c.save();
      circle(c, p.x, p.y, r * .96 + 3, null, alpha(energyColor, energyStrength * .48), 1.4);
      for (let i = 0; i < 4; i++) {
        const a = i * TAU / 4 + Math.PI / 4, inner = r * .27, outer = r * .76;
        segment(c, p.x + Math.cos(a) * inner, p.y + Math.sin(a) * inner, p.x + Math.cos(a) * outer, p.y + Math.sin(a) * outer, alpha(energyColor, energyStrength * .62), 1.4);
        const flow = .27 + ((phase + i * .25) % 1) * .49;
        circle(c, p.x + Math.cos(a) * r * flow, p.y + Math.sin(a) * r * flow, working ? 2 : 1.3, alpha(energyColor, energyStrength));
      }
      const beaconY = p.y - r * .83 - 8;
      glow(c, p.x, beaconY, 22, energyColor, energyStrength * .75);
      regular(c, p.x, beaconY, 5.7, 4, alpha(energyColor, Math.max(.22, energyStrength)), energyColor, 1.2);
      regular(c, p.x, beaconY, 2, 4, alpha('#f1fff8', energyPresence * .9));
      c.restore();
    }
    if (!underConstruction && BUILDINGS[e.type].technology && this.getWorld().technologyActive(e.team, e.type)) {
      const x = p.x + r * .62, y = p.y + r * .64;
      circle(c, x, y, 6, COLORS.ground, color, 1);
      segment(c, x - 2.5, y, x - .5, y + 2, color, 1.5); segment(c, x - .5, y + 2, x + 3, y - 2.5, color, 1.5);
    }
    if (e.type === 'cache') this.label(s?.select > .2 ? '击毁后派兵回收核心' : BUILDINGS[e.type].name, p.x, p.y + r + 17, COLORS.neutral, 11);
    else if (!e.powered && !underConstruction) this.label('停电', p.x, p.y + r + 17, '#e9c779');
    else if (!underConstruction && (s?.select > .2 || e.type === 'hq')) this.label(BUILDINGS[e.type].name, p.x, p.y + r + 17, e.team === 1 ? '#f1a2ac' : COLORS.text, 11);
    if (e.hp < e.maxHp || s?.select > .2) {
      const width = Math.max(28, r * 1.05), top = p.y - r - 13;
      rounded(c, p.x - width / 2, top, width, 2, 1, '#333c44'); rounded(c, p.x - width / 2, top, width * e.hp / e.maxHp, 2, 1, color);
    }
  }
  drawCore(e) {
    if (e.dock || !this.visible(e.x, e.y)) return;
    const c = this.ctx, s = this.states.get(e.id); if (!s) return;
    const p = this.screen(s.x, s.y), z = this.camera.z, color = coreColor(e);
    const pulse = this.reducedMotion ? 1 : 1 + Math.sin(this.realTime * 2.6 + e.id) * .045;
    const radius = Math.max(6.5, 12 * z) * pulse;
    this.selectionRing(p.x, p.y, 15 * z, s.select, color);
    this.drawCoreLight(p.x, p.y, radius, color, e.team === -1 ? .55 : 1, e.id);
    if (e.team === -1) {
      c.save(); c.setLineDash([2, 5]); circle(c, p.x, p.y, Math.max(radius + 8, 24 * z), null, alpha(color, .5)); c.restore();
      this.label('无主核心 · 派兵回收', p.x, p.y + radius + 17, color, 10);
    } else if (s.select > .2 || !e.path?.length) this.label(String(e.serial).padStart(2, '0'), p.x, p.y + radius + 15, COLORS.muted, 10);
  }
  drawCoreLight(x, y, radius, color, strength = 1, seed = 0) {
    const c = this.ctx, phase = this.reducedMotion ? .3 : this.realTime * .85 + seed;
    glow(c, x, y, radius * 4.1, color, .36 * strength);
    circle(c, x, y, radius * 1.62, null, alpha(color, .24 * strength), 1);
    c.save();
    c.translate(x, y); c.rotate(phase * .3); c.setLineDash([radius * .8, radius * .7]);
    circle(c, 0, 0, radius * 2, null, alpha(color, .42 * strength), 1); c.restore();
    regular(c, x, y, radius, 4, alpha(color, .2), color, 1.8);
    regular(c, x, y, radius * .59, 4, color, null);
    regular(c, x, y, radius * .27, 4, '#f1fff8', null);
  }
  drawCoreInteraction() {
    const c = this.ctx, w = this.getWorld(), drag = this.coreDrag;
    if (this.coreHold) {
      const hold = this.coreHold, entity = w.byId(hold.entityId), core = w.byId(hold.coreId);
      if (entity && core) {
        const p = this.screen(entity.x, entity.y), radius = Math.max(21, entity.r * this.camera.z + 12), progress = clamp((performance.now() - hold.startedAt) / hold.duration, 0, 1), color = coreColor(core);
        circle(c, p.x, p.y, radius, null, alpha(color, .22), 3);
        this.ringProgress(p.x, p.y, radius, progress, color, 3);
        if (progress > .15) this.label('长按抓取核心', p.x, p.y - radius - 17, color, 10);
      }
    }
    if (!drag) return;
    const core = w.byId(drag.coreId); if (!core) return;
    const { preview, pointer } = drag, color = preview.ok ? coreColor(core) : COLORS.enemy;
    const routes = preview.transfers || (preview.path ? [{ core, origin: preview.origin, path: preview.path }] : []);
    c.save(); c.setLineDash([5, 7]); c.lineDashOffset = this.reducedMotion ? 0 : -this.realTime * 24;
    for (const route of routes) {
      if (!route.path.length) continue;
      const start = this.screen(route.core.x, route.core.y); c.beginPath(); c.moveTo(start.x, start.y);
      for (const point of [route.origin, ...route.path]) { const p = this.screen(point.x, point.y); c.lineTo(p.x, p.y); }
      if (route.building) { const p = this.screen(route.building.x, route.building.y); c.lineTo(p.x, p.y); }
      c.strokeStyle = alpha(coreColor(route.core), .85); c.lineWidth = 2; c.stroke();
    }
    c.restore();
    if (preview.kind === 'dock' && preview.point) {
      const p = this.screen(preview.point.x, preview.point.y), radius = preview.point.r * this.camera.z + 12;
      glow(c, p.x, p.y, radius * 1.7, color, .25);
      circle(c, p.x, p.y, radius, null, color, 2.5);
      if (preview.swapped) circle(c, p.x, p.y, radius + 5, null, alpha(color, .45), 1);
    }
    const x = clamp(pointer.x, 18, this.width - 18), y = clamp(pointer.y - 29, 20, this.height - 20);
    c.save(); c.globalAlpha = .88; this.drawCoreLight(x, y, 10, color); c.restore();
    circle(c, pointer.x, pointer.y, 6, null, color, 1.5);
    this.label(preview.label, clamp(x, Math.min(135, this.width / 2), Math.max(this.width - 135, this.width / 2)), Math.max(15, y - 33), color, 11);
  }
  drawCapture(e) {
    if (!e || !this.visible(e.x, e.y, e.r * this.camera.z + 70)) return;
    const c = this.ctx, p = this.screen(e.x, e.y), r = e.r * this.camera.z, color = teamColor(e.owner);
    const progress = clamp(e.progress / e.duration, 0, 1), selected = this.states.get(e.id)?.select || 0;
    circle(c, p.x, p.y, r, alpha(color, .035));
    c.save(); c.setLineDash([6, 8]); circle(c, p.x, p.y, r, null, alpha(color, e.contested ? .75 : .4), 1.5); c.restore();
    this.ringProgress(p.x, p.y, r + 5, progress, color, 2.5);
    if (selected > .01) this.selectionRing(p.x, p.y, r + 5, selected, color);
    const iconRadius = Math.max(9, 20 * this.camera.z);
    regular(c, p.x, p.y, iconRadius, 6, COLORS.ground, color, 1.5, Math.PI / 6);
    regular(c, p.x, p.y, iconRadius * .38, 4, color);
    const labelY = p.y - r - 22;
    this.label('中央中继站', p.x, labelY, color, 11);
    const remaining = timerText(e.duration - e.progress);
    const status = e.contested ? `争夺中 · 计时暂停 ${remaining}` : e.owner == null ? `派兵占领 · 每 ${timerText(e.duration)} 获得核心` : `${e.owner === 0 ? '我方控制' : '敌方控制'} · 核心 ${remaining}`;
    this.label(status, p.x, p.y + r + 23, color, 11);
    if (e.contested || selected > .2) this.label(`我方 ${e.occupants?.[0] || 0}  ·  敌方 ${e.occupants?.[1] || 0}`, p.x, p.y + r + 44, COLORS.text, 10);
  }
  unitGlyph(type, r, color, fill = color, recoil = 0) {
    const c = this.ctx;
    if (type === 'sniper') {
      polygon(c, [[r * .65, 0], [-r * .65, -r * .54], [-r * .93, 0], [-r * .65, r * .54]], fill);
      segment(c, -recoil * 2, 0, r * 1.65 - recoil * 3, 0, fill, 1.6);
      circle(c, r * .55, -r * .16, Math.max(1.2, r * .13), COLORS.ground, color, 1);
    } else if (type === 'rocketeer') {
      polygon(c, [[r * .78, 0], [-r * .68, -r * .73], [-r * .43, 0], [-r * .68, r * .73]], fill);
      rounded(c, -r * .35 - recoil * 2, -r * .72, r * 1.4, r * .37, 1.5, COLORS.ground, fill, 1.5);
      polygon(c, [[r * 1.1 - recoil * 2, -r * .81], [r * 1.4 - recoil * 2, -r * .54], [r * 1.1 - recoil * 2, -r * .27]], fill);
    } else if (type === 'striker') {
      for (const offset of [-.38, .38]) polygon(c, [[r * (offset + .69), 0], [r * (offset - .12), -r * .63], [r * (offset - .4), -r * .63], [r * (offset + .2), 0], [r * (offset - .4), r * .63], [r * (offset - .12), r * .63]], fill);
    } else if (type === 'scout') {
      for (const x of [-.6, .45]) for (const y of [-.72, .72]) rounded(c, r * (x - .18), r * (y - .12), r * .36, r * .24, 1.5, color);
      polygon(c, [[r * 1.12, 0], [r * .4, -r * .48], [-r * .8, -r * .42], [-r * .95, 0], [-r * .8, r * .42], [r * .4, r * .48]], alpha(color, .2), color, 1.3);
      polygon(c, [[r * .45, 0], [-r * .25, -r * .25], [-r * .25, r * .25]], fill);
      segment(c, r * .1, 0, r * 1.1 - recoil * 3, 0, fill, 2);
    } else if (type === 'heavyTank') {
      rounded(c, -r * .88, -r * .83, r * 1.72, r * 1.66, 3, alpha(color, .2), color, 1.7);
      for (const y of [-.65, .65]) {
        rounded(c, -r * .77, r * (y - .13), r * 1.48, r * .26, 1.5, color);
        for (const x of [-.52, -.1, .32]) segment(c, x * r, r * (y - .13), x * r, r * (y + .13), COLORS.ground, 1);
      }
      polygon(c, [[r * .52 - recoil * 2, 0], [r * .25 - recoil * 2, -r * .4], [-r * .43 - recoil * 2, -r * .33], [-r * .52 - recoil * 2, r * .25], [r * .25 - recoil * 2, r * .4]], fill);
      segment(c, 0, 0, r * 1.43 - recoil * 4, 0, fill, 4.2);
      segment(c, r * 1.32 - recoil * 4, -r * .12, r * 1.32 - recoil * 4, r * .12, fill, 2.5);
    } else if (type === 'artillery') {
      for (const y of [-.58, .58]) rounded(c, -r * .9, r * (y - .15), r * 1.5, r * .3, 2, alpha(color, .2), color, 1.5);
      polygon(c, [[r * .65, 0], [-r * .3, -r * .45], [-r * .75, 0], [-r * .3, r * .45]], fill);
      segment(c, -r * .65, -r * .25, -r * 1.08, -r * .85, color, 2);
      segment(c, -r * .65, r * .25, -r * 1.08, r * .85, color, 2);
      rounded(c, -recoil * 4, -r * .12, r * 1.65, r * .24, 1.5, fill);
      segment(c, r * 1.58 - recoil * 4, -r * .22, r * 1.58 - recoil * 4, r * .22, fill, 2);
    } else if (type === 'tank') {
      rounded(c, -r * .8, -r * .8, r * 1.6, r * 1.6, 3, alpha(color, .15), color, 1.3);
      segment(c, -r * .5, -r * .56, r * .5, -r * .56, color, 2);
      segment(c, -r * .5, r * .56, r * .5, r * .56, color, 2);
      rounded(c, -r * .35 - recoil * 3, -r * .31, r * .8, r * .62, 2, fill);
      segment(c, 0, 0, r * 1.35 - recoil * 4, 0, fill, 2.8);
    } else polygon(c, [[r * 1.2, 0], [-r * .8, -r * .73], [-r * .43, 0], [-r * .8, r * .73]], fill);
  }
  drawUnit(e) {
    const s = this.states.get(e.id); if (!s || !this.visible(s.x, s.y)) return;
    const c = this.ctx, z = this.camera.z, p = this.screen(s.x, s.y), vehicle = UNITS[e.type]?.producer === 'factory';
    const color = e.team ? COLORS.enemy : UNITS[e.type]?.color || COLORS.ally;
    const r = Math.max(vehicle ? 8 : 4.5, e.r * z);
    this.selectionRing(p.x, p.y, r, s.select, color);
    c.save(); c.translate(p.x, p.y); c.rotate(s.angle);
    const born = this.reducedMotion ? 1 : easeBack(s.age / .3); c.scale(born, born);
    this.unitGlyph(e.type, r, color, s.hit > 0 ? '#f5faf8' : color, s.recoil);
    c.restore();
    if (e.hp < e.maxHp || s.select > .2) {
      const width = vehicle ? 24 : 16;
      rounded(c, p.x - width / 2, p.y - r - 10, width, 2, 1, '#333c44'); rounded(c, p.x - width / 2, p.y - r - 10, width * e.hp / e.maxHp, 2, 1, color);
    }
  }
  drawRoutes(w) {
    const c = this.ctx;
    for (const e of w.all()) {
      if (!this.entityVisible(w, e)) continue;
      if (e.kind === 'building' && this.selected.has(e.id) && e.rally) {
        const p = this.screen(e.rally.x, e.rally.y); circle(c, p.x, p.y, 11, null, alpha(COLORS.ally, .65));
        segment(c, p.x, p.y + 4, p.x, p.y - 13, COLORS.ally, 1.5);
        polygon(c, [[p.x, p.y - 13], [p.x + 10, p.y - 9], [p.x, p.y - 5]], COLORS.ally);
        this.label('集结点', p.x, p.y + 23, COLORS.ally, 10);
      }
      const s = this.states.get(e.id); if (!s || e.dock || e.kind === 'building' || e.kind === 'capture') continue;
      const color = e.kind === 'core' ? coreColor(e) : e.team === 1 ? COLORS.enemy : UNITS[e.type]?.color || COLORS.ally;
      if (!this.reducedMotion && s.trail.length > 1) {
        for (let i = 1; i < s.trail.length; i++) { const a = this.screen(s.trail[i - 1].x, s.trail[i - 1].y), b = this.screen(s.trail[i].x, s.trail[i].y); segment(c, a.x, a.y, b.x, b.y, alpha(color, s.trail[i].life / .36 * (e.kind === 'core' ? .72 : .15)), e.kind === 'core' ? 4 : UNITS[e.type]?.producer === 'factory' ? 5 : 2); }
      }
      if (!this.selected.has(e.id) || e.team) continue;
      if (e.orders?.length && (this.selected.size <= 12 || e.id === this.selected.values().next().value)) {
        e.orders.forEach((order, i) => { const p = this.screen(order.x, order.y); circle(c, p.x, p.y, 8, COLORS.ground, alpha(color, .5)); this.label(String(i + 1), p.x, p.y, color, 10); });
      }
      if (!e.path?.length) continue;
      c.save(); c.setLineDash([3, 9]); c.lineDashOffset = this.reducedMotion ? 0 : -this.realTime * 18;
      c.beginPath(); const start = this.screen(s.x, s.y); c.moveTo(start.x, start.y);
      for (const point of e.path) { const p = this.screen(point.x, point.y); c.lineTo(p.x, p.y); }
      c.strokeStyle = alpha(color, .27); c.lineWidth = 1; c.stroke(); c.restore();
      const dest = e.path[e.path.length - 1], p = this.screen(dest.x, dest.y); circle(c, p.x, p.y, 3, null, alpha(color, .5), 1);
    }
  }
  drawEffects() {
    const c = this.ctx, z = this.camera.z, w = this.getWorld();
    for (const e of this.vfx) {
      if (w.visibleAt && !['order', 'blocked-order'].includes(e.type)) {
        const drag = e.type === 'particle' ? (1 - Math.exp(-3 * e.age)) / 3 : 0;
        if (!w.visibleAt(0, e.x + (e.vx || 0) * drag, e.y + (e.vy || 0) * drag) || e.type === 'shot' && !w.visibleAt(0, e.tx, e.ty)) continue;
      }
      const t = e.age / e.duration, p = this.screen(e.x, e.y); c.save();
      if (e.type === 'particle') {
        const drag = (1 - Math.exp(-3 * e.age)) / 3;
        const q = this.screen(e.x + e.vx * drag, e.y + e.vy * drag);
        c.globalAlpha = (1 - t) ** 1.5; c.translate(q.x, q.y); c.rotate(t * 2);
        const r = e.size * z; c.fillStyle = e.color; c.fillRect(-r, -r, r * 2, r * 2);
      } else if (e.type === 'blocked-order') {
        c.globalAlpha = 1 - t; const r = (7 + t * 4) * z;
        segment(c, p.x - r, p.y - r, p.x + r, p.y + r, e.color, 2); segment(c, p.x - r, p.y + r, p.x + r, p.y - r, e.color, 2);
      } else if (e.type === 'ring' || e.type === 'order') {
        const r = (5 + easeOut(t) * e.radius) * z; c.globalAlpha = (1 - t) ** 1.4;
        circle(c, p.x, p.y, r, null, e.color, 1.5 - t * .5);
        if (e.type === 'order') { circle(c, p.x, p.y, (2 + t * 10) * z, null, e.color, 1); circle(c, p.x, p.y, 2 * z, e.color); }
      } else if (e.type === 'flash') {
        c.globalAlpha = (1 - t) ** 2; circle(c, p.x, p.y, e.radius * z * (.4 + easeOut(t)), e.color);
      } else if (e.type === 'shot') {
        const flight = clamp(t / .62, 0, 1), trail = Math.max(0, flight - .24), target = this.screen(e.tx, e.ty);
        const rocket = e.weapon === 'rocketeer', shell = e.weapon === 'artillery';
        if (e.weapon === 'sniper' && flight < 1) {
          c.globalAlpha = (1 - flight) * .8;
          segment(c, p.x, p.y, target.x, target.y, e.color, 1.8);
          circle(c, target.x, target.y, 2.5 * z, '#effcf6');
        } else if (flight < 1) {
          const hx = p.x + (target.x - p.x) * flight, hy = p.y + (target.y - p.y) * flight;
          const tx = p.x + (target.x - p.x) * trail, ty = p.y + (target.y - p.y) * trail;
          segment(c, tx, ty, hx, hy, alpha(e.color, rocket || shell ? .4 : .65), rocket || shell ? 3 : e.heavy ? 2.1 : 1.1);
          if (rocket) {
            c.save(); c.translate(hx, hy); c.rotate(Math.atan2(target.y - p.y, target.x - p.x));
            polygon(c, [[4, 0], [-2, -2.5], [-2, 2.5]], '#effcf6');
            segment(c, -3, 0, -8, 0, e.color, 2); c.restore();
          } else {
            circle(c, hx, hy, shell ? 3.7 : e.heavy ? 2.5 : 1.5, '#effcf6');
            if (shell) circle(c, hx, hy, 6, null, alpha(e.color, .45), 1);
          }
        } else {
          const impact = (t - .62) / .38; c.globalAlpha = 1 - impact;
          const radius = shell ? 44 : rocket ? 22 : e.heavy ? 13 : 7;
          circle(c, target.x, target.y, (3 + easeOut(impact) * radius) * z, null, e.color, 1.3);
          if (shell) circle(c, target.x, target.y, (3 + easeOut(impact) * radius * .6) * z, alpha(e.color, .1), e.color, 1);
          if (impact < .5) circle(c, target.x, target.y, 3 * z * (1 - impact), '#f4fbef');
        }
      }
      c.restore();
    }
  }
  draw(dt) {
    this.realTime += dt; const c = this.ctx, w = this.getWorld(), z = this.camera.z;
    this.sync(w, dt); c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); c.lineCap = 'round'; c.lineJoin = 'round'; c.globalAlpha = 1;
    this.drawGround();
    if (!w.captureKnown || w.captureKnown(0)) this.drawCapture(w.capturePoint);
    for (const memory of w.config?.fog ? w.fog.rememberedBuildings(0) : []) this.drawRememberedBuilding(memory);
    this.drawRoutes(w);
    if (this.placement && w.base(0)) {
      const h = w.base(0), p = this.screen(h.x, h.y); c.save(); c.setLineDash([3, 8]); circle(c, p.x, p.y, 560 * z, null, '#88e6c547', 1); c.restore();
    }
    for (const e of w.all(null, 'building')) if (this.entityVisible(w, e)) this.drawBuilding(e);
    for (const e of w.all(null, 'unit')) if (this.entityVisible(w, e)) this.drawUnit(e);
    for (const e of w.cores()) if (this.entityVisible(w, e)) this.drawCore(e);
    if (this.hover && !this.hover.dock && !this.selected.has(this.hover.id) && w.byId(this.hover.id) && this.entityVisible(w, this.hover)) {
      const p = this.screen(this.hover.x, this.hover.y), color = this.hover.kind === 'capture' ? teamColor(this.hover.owner) : teamColor(this.hover.team);
      circle(c, p.x, p.y, Math.max(12, this.hover.r * z) + 5, null, alpha(color, .5));
    }
    this.drawEffects();
    this.drawFog(c, false);
    if (w.capturePoint && w.captureKnown && !w.captureKnown(0)) {
      const point = w.capturePoint, p = this.screen(point.x, point.y);
      circle(c, p.x, p.y, Math.max(7, 12 * z), null, '#7c8279', 1);
      this.label('中央据点 · 待侦察', p.x, p.y + 23, '#8c948e', 10);
    }
    this.drawCoreInteraction();
    if (this.placement) {
      const { x, y, type, ok } = this.placement; this.drawBuilding({ x, y, type, r: BUILDINGS[type].r, team: 0 }, true);
      const p = this.screen(x, y); this.label(ok ? '点击建造' : this.placement.reason || '位置不可用', p.x, p.y + BUILDINGS[type].r * z + 20, ok ? COLORS.ally : COLORS.enemy);
    } else if (this.groundHover && !this.hover) {
      const t = w.terrainAt(this.groundHover.x, this.groundHover.y);
      if (t && (!w.visibleAt || w.visibleAt(0, this.groundHover.x, this.groundHover.y)) && [...this.selected].some(id => w.byId(id)?.kind !== 'building')) {
        const p = this.screen(this.groundHover.x, this.groundHover.y); this.label((t.name || '岩石') + ' · 不可通行', p.x, p.y - 24, '#c69b91', 11);
      }
    }
    if (this.box) {
      const { x1, y1, x2, y2 } = this.box; c.fillStyle = '#88e6c510'; c.strokeStyle = '#88e6c5aa'; c.lineWidth = 1;
      c.fillRect(x1, y1, x2 - x1, y2 - y1); c.strokeRect(x1, y1, x2 - x1, y2 - y1);
    }
    this.drawMini();
  }
  drawRememberedBuilding(e) {
    if (!this.visible(e.x, e.y)) return;
    const c = this.ctx, p = this.screen(e.x, e.y), radius = e.r * this.camera.z;
    c.save(); c.setLineDash([4, 5]); circle(c, p.x, p.y, radius + 5, null, '#b6c0bd', 1); c.setLineDash([]);
    c.translate(p.x, p.y); this.glyph(e.type, radius * .72, '#b6c0bd'); c.restore();
    if (this.camera.z > .4) this.label(`${BUILDINGS[e.type].name} · 上次发现`, p.x, p.y + radius + 18, '#a6b2ad', 10);
  }
  drawFog(c, minimap) {
    const w = this.getWorld(); if (!w.config?.fog || !w.fog) return;
    const fog = w.fog;
    if (!this.fogLayer || this.fogWorld !== w) {
      this.fogLayer = document.createElement('canvas'); this.fogLayer.width = fog.cols; this.fogLayer.height = fog.rows;
      this.fogContext = this.fogLayer.getContext('2d'); this.fogPixels = this.fogContext.createImageData(fog.cols, fog.rows);
      this.fogOpacity = new Uint8Array(fog.cols * fog.rows);
      this.fogWorld = w; this.fogRevision = -1;
    }
    if (this.fogRevision !== fog.revision) {
      const { visible, explored } = fog.teams[0], pixels = this.fogPixels.data;
      for (let i = 0; i < visible.length; i++) this.fogOpacity[i] = visible[i] ? 0 : explored[i] ? 156 : 255;
      for (let i = 0; i < visible.length; i++) {
        const p = i * 4; pixels[p] = 7; pixels[p + 1] = 11; pixels[p + 2] = 17;
        // A small weighted blur softens cell steps without changing simulation sight.
        const col = i % fog.cols, row = Math.floor(i / fog.cols);
        let opacity = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const sample = clamp(row + dy, 0, fog.rows - 1) * fog.cols + clamp(col + dx, 0, fog.cols - 1);
          opacity += this.fogOpacity[sample] * (dx === 0 ? 2 : 1) * (dy === 0 ? 2 : 1);
        }
        pixels[p + 3] = Math.round(opacity / 16);
      }
      this.fogContext.putImageData(this.fogPixels, 0, 0); this.fogRevision = fog.revision;
    }
    c.save(); c.imageSmoothingEnabled = true;
    if (minimap) c.drawImage(this.fogLayer, 0, 0, this.mini.width, this.mini.height);
    else { const origin = this.screen(0, 0); c.drawImage(this.fogLayer, origin.x, origin.y, MAP.w * this.camera.z, MAP.h * this.camera.z); }
    c.restore();
  }
  drawMini() {
    const c = this.mc, w = this.getWorld(), width = this.mini.width, height = this.mini.height, sx = width / MAP.w, sy = height / MAP.h;
    c.clearRect(0, 0, width, height); c.fillStyle = '#151b22'; c.fillRect(0, 0, width, height);
    c.strokeStyle = '#313b45'; c.lineWidth = this.dpr; c.strokeRect(105 * sx, 135 * sy, (MAP.w - 210) * sx, (MAP.h - 250) * sy);
    for (const o of w.obstacles) circle(c, o.x * sx, o.y * sy, o.r * sx, '#48515a');
    for (const t of w.terrain) polygon(c, t.points.map(([x, y]) => [x * sx, y * sy]), t.kind === 'water' ? '#365769' : '#6d605c');
    for (const memory of w.config?.fog ? w.fog.rememberedBuildings(0) : []) {
      c.strokeStyle = '#a6b2ad'; c.lineWidth = this.dpr; c.strokeRect(memory.x * sx - 2 * this.dpr, memory.y * sy - 2 * this.dpr, 4 * this.dpr, 4 * this.dpr);
    }
    for (const e of w.all()) {
      if (e.dock || !this.entityVisible(w, e)) continue;
      if (e.kind === 'capture') {
        const color = teamColor(e.owner);
        circle(c, e.x * sx, e.y * sy, e.r * Math.min(sx, sy), alpha(color, .1), color, this.dpr);
        regular(c, e.x * sx, e.y * sy, 3 * this.dpr, 4, color);
        continue;
      }
      if (e.type === 'cache') {
        regular(c, e.x * sx, e.y * sy, 3.5 * this.dpr, 4, '#151b22', COLORS.neutral, this.dpr, Math.PI / 4);
        continue;
      }
      c.fillStyle = e.team === -1 ? COLORS.neutral : e.team === 1 ? COLORS.enemy : e.kind === 'core' ? coreColor(e) : e.kind === 'building' ? COLORS[e.type] : UNITS[e.type]?.color || COLORS.ally;
      const size = (e.kind === 'building' ? 3.5 : 2) * this.dpr; c.fillRect(e.x * sx - size / 2, e.y * sy - size / 2, size, size);
    }
    this.drawFog(c, true);
    if (w.capturePoint && w.captureKnown && !w.captureKnown(0)) regular(c, w.capturePoint.x * sx, w.capturePoint.y * sy, 3 * this.dpr, 4, '#7c8279');
    const a = this.world(0, 0), b = this.world(this.width, this.height); c.strokeStyle = '#aab9c480'; c.lineWidth = this.dpr;
    c.strokeRect(a.x * sx, a.y * sy, (b.x - a.x) * sx, (b.y - a.y) * sy);
  }
  hit(x, y) {
    let best = null, nearest = Infinity, objective = null, objectiveDistance = Infinity;
    const w = this.getWorld();
    for (const e of w.all()) {
      if (!this.entityVisible(w, e)) continue;
      if (e.dock) continue; const p = this.screen(e.x, e.y), distance = Math.hypot(x - p.x, y - p.y);
      if (e.kind === 'capture') {
        if (distance <= e.r * this.camera.z && distance < objectiveDistance) { objective = e; objectiveDistance = distance; }
        continue;
      }
      const radius = Math.max(e.kind === 'building' ? 22 : 18, e.r * this.camera.z);
      if (distance <= radius && distance < nearest) { nearest = distance; best = e; }
    }
    return best || objective;
  }
}
