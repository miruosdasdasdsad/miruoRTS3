// The simulation has no browser dependencies; energy is always stored on individual cores.
import { MAP, BOUNDS, BASES, CAPTURE_SITE, CACHE_SITES, OBSTACLES, TERRAIN, circleIntersectsPolygon, segmentIntersectsPolygon, pointSegmentDistanceSq, terrainAt } from './terrain.js';
import { Navigation } from './navigation.js';
import { createMap } from './map-config.js';
import { FogOfWar } from './fog.js';
export { MAP, BASES, CAPTURE_SITE, CACHE_SITES, OBSTACLES, TERRAIN };
export const CORE_PICKUP_RADIUS = 65;
import { DEFAULT_BALANCE, createBalance, freezeBalance } from './balance.js';
export const BUILDINGS = DEFAULT_BALANCE.buildings;
export const UNITS = DEFAULT_BALANCE.units;
export const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const living = e => e.hp > 0;

export class World {
  constructor(options = {}) {
    this.nextId = 1; this.nextEventId = 1; this.eventListeners = new Set(); this.time = 0; this.tick = 0; this.entities = []; this.shots = []; this.effects = []; this.events = [];
    const { map = null, objectives = true, balance = {}, ...settings } = options;
    this.map = map ? createMap(map) : null;
    const { terrain = this.map?.terrain ?? TERRAIN, obstacles = this.map?.obstacles ?? OBSTACLES, bases = this.map?.bases ?? BASES, ...config } = settings;
    this.spawnPoints = bases.map(point => ({ ...point }));
    this.cacheSites = objectives ? (this.map?.caches ?? CACHE_SITES).map(point => ({ ...point })) : [];
    this.aiClearedCaches = new Set();
    const profile = createBalance(balance);
    // Legacy rate overrides remain supported, but are reflected in the match profile too.
    if (config.rate !== undefined) profile.economy.rate = config.rate;
    this.balance = freezeBalance(createBalance(profile));
    this.buildings = this.balance.buildings; this.units = this.balance.units;
    this.terrain = terrain; this.obstacles = obstacles; this.entityIndex = new Map(); this.navigation = new Navigation(this);
    this.config = { rate: this.balance.economy.rate, ai: true, difficulty: 'normal', invincible: false, fog: true, ...config };
    this.fog = new FogOfWar(MAP.w, MAP.h); this.visibilityDirty = true;
    this.result = null; this.aiClock = 0; this.nextRaid = this.config.difficulty === 'hard' ? 80 : this.config.difficulty === 'easy' ? 180 : 120;
    this.stats = [{ kills: 0, produced: 0, spent: 0 }, { kills: 0, produced: 0, spent: 0 }];
    this.unlockedUnits = [new Set(), new Set()]; this.technologies = [new Set(), new Set()];
    for (let team = 0; team < 2; team++) {
      const { x, y } = bases[team];
      const hq = this.addBuilding('hq', team, x, y);
      const a = this.addCore(team, x, y);
      a.dock = hq.id; hq.core = a.id;
      this.addCore(team, x - 55, y + 125); this.addCore(team, x + 35, y + 155);
    }
    this.capturePoint = null;
    if (objectives) {
      for (const site of this.map?.caches ?? CACHE_SITES) this.addBuilding('cache', -1, site.x, site.y);
      for (const site of this.map?.neutralCores ?? []) this.addCore(-1, site.x, site.y, 0);
      const capture = this.map ? this.map.captureSite : CAPTURE_SITE;
      if (capture) {
        const point = { id: this.nextId++, kind: 'capture', type: 'relay', team: -1, ...capture, hp: 1, maxHp: 1, owner: null, progress: 0, duration: this.balance.economy.captureDuration, contested: false, occupants: [0, 0], rewards: [0, 0] };
        this.capturePoint = point; this.entities.push(point); this.entityIndex.set(point.id, point);
      }
    }
    this.refreshVisibility();
    this.log('作战开始：3 个独立核心已就绪，派兵探索战争迷雾。', 'info');
  }
  byId(id) { const e = this.entityIndex.get(id); return e && living(e) ? e : undefined; }
  all(team, kind) { return this.entities.filter(e => living(e) && (team == null || e.team === team) && (!kind || e.kind === kind)); }
  base(team) { return this.all(team, 'building').find(e => e.type === 'hq'); }
  cores(team) { return this.all(team, 'core'); }
  refreshVisibility() { this.fog.update(this.entities); this.visibilityDirty = false; }
  canSee(team, entity) {
    if (!entity || entity.hp <= 0) return false;
    if (!this.config.fog || entity.team === team) return true;
    if (this.visibilityDirty) this.refreshVisibility();
    return this.fog.stateAt(team, entity.x, entity.y) === 2;
  }
  visibleAt(team, x, y) {
    if (!this.config.fog) return true;
    if (this.visibilityDirty) this.refreshVisibility();
    return this.fog.stateAt(team, x, y) === 2;
  }
  captureKnown(team = 0) {
    return !!this.capturePoint && (this.canSee(team, this.capturePoint) || this.capturePoint.occupants[team] > 0);
  }
  eventVisible(event, team = 0) { return !this.config.fog || !event.visibleTo || event.visibleTo.includes(team); }
  logAt(text, level, entity) { this.log(text, level, [0, 1].filter(team => this.canSee(team, entity))); }
  addBuilding(type, team, x, y, construction = 0, builderId = null) {
    const d = this.buildings[type];
    const e = { id: this.nextId++, kind: 'building', type, team, x, y, hp: d.hp, maxHp: d.hp, r: d.r, core: null, construction, buildTime: construction, builderId, buildJob: null, queue: [], job: null, researchJob: null, cooldown: 0, angle: 0, rally: null, powered: true };
    this.entities.push(e); this.entityIndex.set(e.id, e); this.visibilityDirty = true;
    if (!construction) this.unlockBuildingUnits(e);
    return e;
  }
  addCore(team, x, y, energy = this.balance.economy.startingEnergy) {
    const serial = team < 0 ? 0 : this.cores(team).length + 1;
    const e = { id: this.nextId++, kind: 'core', type: 'core', team, x, y, r: 15, hp: 1, maxHp: 1, energy: Math.max(0, Math.floor(energy)), serial, dock: null, targetDock: null, dest: null, path: [], angle: 0 };
    e.orders = []; e.moveSpeed = 0;
    this.entities.push(e); this.entityIndex.set(e.id, e); this.visibilityDirty = true; return e;
  }
  addUnit(type, team, x, y) {
    const d = this.units[type];
    const p = this.freePosition(x, y, d.r, null, this.all(null, 'unit'));
    if (!p) return null;
    x = p.x; y = p.y;
    const e = { id: this.nextId++, kind: 'unit', type, team, x, y, hp: d.hp, maxHp: d.hp, r: d.r, dest: null, path: [], target: null, stance: 'guard', cooldown: 0, angle: team ? Math.PI : 0 };
    e.orders = []; e.moveSpeed = 0;
    this.entities.push(e); this.entityIndex.set(e.id, e); this.visibilityDirty = true; this.stats[team].produced++; return e;
  }
  log(text, level = 'info', visibleTo = null) {
    const event = Object.freeze({ id: this.nextEventId++, text, level, time: this.time, ...(visibleTo ? { visibleTo: Object.freeze(visibleTo) } : {}) });
    this.events.unshift(event); this.events.length = Math.min(30, this.events.length);
    for (const listener of this.eventListeners) listener(event);
  }
  subscribeEvents(listener) {
    if (typeof listener !== 'function') throw new TypeError('事件订阅者必须是函数');
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }
  updateObjectives(dt) {
    const army = this.all(null, 'unit');
    for (const core of this.cores(-1)) {
      const teams = [false, false];
      for (const unit of army) if (distance(unit, core) <= CORE_PICKUP_RADIUS && this.segmentClear(unit, core, 1)) teams[unit.team] = true;
      if (teams[0] === teams[1]) continue;
      const team = teams[0] ? 0 : 1;
      core.serial = this.cores(team).length + 1; core.team = team;
      this.stats[team].coresRecovered = (this.stats[team].coresRecovered || 0) + 1;
      this.visibilityDirty = true;
      this.logAt(`${team ? '敌方' : '我方'}回收了一个能量核心。`, team ? 'danger' : 'good', core);
      this.effects.push({ type: 'order', team, x: core.x, y: core.y, life: 1.2, max: 1.2 });
    }
    const point = this.capturePoint;
    if (!point) return;
    point.occupants = [0, 0];
    for (const unit of army) if (distance(unit, point) <= point.r) point.occupants[unit.team]++;
    point.contested = point.occupants[0] > 0 && point.occupants[1] > 0;
    if (point.contested) return;
    const owner = point.occupants[0] ? 0 : point.occupants[1] ? 1 : null;
    if (point.owner !== owner) {
      point.owner = owner; point.progress = 0;
      if (owner !== null) this.logAt(`${owner ? '敌方' : '我方'}开始控制中央据点，每驻守 ${point.duration} 秒可获得一个核心。`, owner ? 'danger' : 'good', point);
    }
    if (owner === null) { point.progress = 0; return; }
    point.progress += dt;
    if (point.progress + 1e-9 >= point.duration) {
      const occupied = this.all().filter(e => ['unit', 'core'].includes(e.kind) && !e.dock);
      const p = this.freePosition(point.x, point.y, 15, null, occupied);
      if (p) {
        this.addCore(owner, p.x, p.y, 0); point.rewards[owner]++;
        this.stats[owner].coresRecovered = (this.stats[owner].coresRecovered || 0) + 1;
        point.progress = Math.max(0, point.progress - point.duration);
        this.logAt(`中央据点为${owner ? '敌方' : '我方'}提供了一个核心；继续驻守可再次获得。`, owner ? 'danger' : 'good', this.cores(owner).at(-1));
        this.effects.push({ type: 'order', team: owner, x: p.x, y: p.y, life: 1.5, max: 1.5 });
      } else point.progress = point.duration;
    }
  }
  grid(team) {
    let supply = this.balance.economy.basePower, demand = 0;
    for (const e of this.all(team, 'building')) if (!e.construction) {
      const p = this.buildings[e.type].power; if (p < 0) supply -= p; else demand += p;
    }
    return { supply, demand, ok: supply >= demand };
  }
  energyFor(b) { const c = this.byId(b?.core); return c?.energy ?? 0; }
  unlockBuildingUnits(b) {
    for (const type of this.buildings[b.type].unlocks || []) this.unlockedUnits[b.team].add(type);
  }
  unitUnlocked(team, type) {
    const d = this.units[type];
    return !!d && (!d.requires || this.unlockedUnits[team]?.has(type));
  }
  technologyActive(team, type) { return this.technologies[team]?.has(type) || false; }
  unitStats(unit) {
    const d = this.units[unit.type], stats = { ...d, incomingDamage: d.incomingDamage ?? 1 };
    for (const type of this.technologies[unit.team]) {
      const tech = this.buildings[type].technology;
      stats[tech.stat] *= tech.multiplier;
    }
    return stats;
  }
  dockedCore(b) {
    const c = this.byId(b?.core);
    return b && c?.kind === 'core' && c.team === b.team && c.dock === b.id ? c : null;
  }
  researchInProgress(team, type) {
    return this.all(team, 'building').find(b => b.researchJob?.type === type) || null;
  }
  research(buildingId) {
    const b = this.byId(buildingId), tech = this.buildings[b?.type]?.technology;
    if (!b || b.kind !== 'building' || b.construction || !tech || this.result) return { ok: false, reason: '此科技建筑不可用' };
    if (this.technologyActive(b.team, b.type)) return { ok: false, reason: '此科技已完成，全军永久生效' };
    if (this.researchInProgress(b.team, b.type)) return { ok: false, reason: '此科技已在研发中' };
    const core = this.dockedCore(b);
    if (!core) return { ok: false, reason: '请先接入能量核心，再开始研发' };
    if (!this.grid(b.team).ok) return { ok: false, reason: '电力不足，无法开始研发' };
    if (core.energy < tech.cost) return { ok: false, reason: `此核心能量不足（需要 ${tech.cost}）` };
    this.spend(b, tech.cost);
    b.researchJob = { type: b.type, remaining: tech.time, total: tech.time, paidCore: core.id, paidCost: tech.cost, paused: false };
    if (!b.team) this.log(`${tech.name}研发开始，需 ${tech.time} 秒；请保持核心接入与供电。`);
    return { ok: true, job: b.researchJob };
  }
  toggleResearchPause(id) {
    const job = this.byId(id)?.researchJob;
    if (!job || this.result) return false;
    job.paused = !job.paused; return true;
  }
  cancelResearch(id) {
    const b = this.byId(id), job = b?.researchJob;
    if (!job || this.result) return false;
    this.refundJob(b, job); b.researchJob = null;
    return true;
  }
  activeConstruction(builder) {
    return builder?.buildJob ?? null;
  }
  constructionHasCore(site) {
    const builder = this.byId(site?.builderId), core = this.byId(builder?.core);
    return !!(builder?.kind === 'building' && builder.type === 'hq' && builder.team === site.team &&
      core?.kind === 'core' && core.team === builder.team && core.dock === builder.id);
  }
  spend(b, cost) {
    const c = this.byId(b?.core);
    if (!c || c.energy < cost) return false;
    c.energy -= cost; this.stats[b.team].spent += cost; return true;
  }
  placement(team, type, x, y) {
    const hq = this.base(team), d = this.buildings[type];
    if (!hq || !d || type === 'hq' || d.buildable === false) return { ok: false, reason: '此建筑不可建造' };
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 140 || x > MAP.w - 140 || y < 170 || y > MAP.h - 160) return { ok: false, reason: '请在陆地内建设' };
    if (distance(hq, { x, y }) > 560) return { ok: false, reason: '超出建造范围（建造厂周围 560 米）' };
    if (!this.visibleAt(team, x, y)) return { ok: false, reason: '请先派兵侦察此处，再放置建筑' };
    if (this.capturePoint && distance(this.capturePoint, { x, y }) < this.capturePoint.r + d.r + 30) return { ok: false, reason: '请为中央据点保留占领空间' };
    if (this.terrain.some(t => circleIntersectsPolygon({ x, y }, d.r + 10, t.points)) || this.obstacles.some(o => distance(o, { x, y }) <= o.r + d.r + 10)) return { ok: false, reason: '不可在湖泊、岩壁或岩石上建造' };
    if (this.all(null, 'building').some(e => distance(e, { x, y }) < e.r + d.r + 22)) return { ok: false, reason: '位置被占用，请换一个位置' };
    if (this.all().some(e => ['unit', 'core'].includes(e.kind) && !e.dock && distance(e, { x, y }) < e.r + d.r + 8)) return { ok: false, reason: '请先移开此处的部队或核心' };
    return { ok: true, reason: '可建造' };
  }
  startBuilding(team, type) {
    const builder = this.base(team), d = this.buildings[type];
    if (!builder || !d || type === 'hq' || d.buildable === false || this.result) return { ok: false, reason: '此建筑不可建造' };
    if (builder.buildJob) return { ok: false, reason: '请先放置或取消当前建筑' };
    const job = { type, team, builderId: builder.id, remaining: d.time, total: d.time, cost: d.cost, paidCore: null, paidCost: 0, paused: false };
    builder.buildJob = job;
    this.payBuilding(builder, job);
    if (team === 0) this.log(`已添加${d.name}建造任务，完成后点击图标放置。`);
    return { ok: true, job };
  }
  payBuilding(builder, job) {
    if (!job.paidCore && this.constructionHasCore(job) && this.spend(builder, job.cost)) { job.paidCore = builder.core; job.paidCost = job.cost; }
  }
  refundJob(builder, job) {
    const core = this.byId(job?.paidCore);
    if (core) { core.energy += job.paidCost; this.stats[builder.team].spent -= job.paidCost; job.paidCost = 0; }
  }
  toggleBuildingPause(team) {
    const job = this.base(team)?.buildJob;
    if (!job || job.remaining <= 0 || this.result) return false;
    job.paused = !job.paused; return true;
  }
  cancelBuilding(team) {
    const builder = this.base(team), job = builder?.buildJob;
    if (!job || this.result) return false;
    this.refundJob(builder, job); builder.buildJob = null;
    return true;
  }
  deployBuilding(team, type, x, y) {
    const builder = this.base(team), job = builder?.buildJob;
    if (this.result || !job || job.type !== type || job.remaining > 0 || !job.paidCore) return { ok: false, reason: '建筑尚未就绪' };
    const placement = this.placement(team, type, x, y);
    if (!placement.ok) return placement;
    const entity = this.addBuilding(type, team, x, y);
    entity.deployed = true; builder.buildJob = null;
    if (team === 0) this.log(`${this.buildings[type].name}已部署并开始运行。`, 'good');
    return { ok: true, entity };
  }
  enqueue(buildingId, type) {
    const b = this.byId(buildingId), d = this.units[type];
    if (!b || !d || d.producer !== b.type || b.construction || this.result) return { ok: false, reason: '此建筑暂时不能生产' };
    if (!this.unitUnlocked(b.team, type)) return { ok: false, reason: `请先建成${this.buildings[d.requires].name}解锁此兵种` };
    if (b.queue.length + (b.job ? 1 : 0) >= 8) return { ok: false, reason: '生产队列已满（8）' };
    b.queue.push(type); return { ok: true };
  }
  cancelQueued(id, index) { const b = this.byId(id); if (b && index >= 0) b.queue.splice(index, 1); }
  toggleProductionPause(id) {
    const job = this.byId(id)?.job;
    if (!job || this.result) return false;
    job.paused = !job.paused; return true;
  }
  cancelProduction(id) {
    const builder = this.byId(id), job = builder?.job;
    if (!job || this.result) return false;
    this.refundJob(builder, job); builder.job = null;
    return true;
  }
  undock(coreId) {
    const c = this.byId(coreId); if (!c || c.kind !== 'core') return;
    // Keep the destroyed building's position long enough to eject its core safely.
    const b = this.entities.find(e => e.id === c.dock);
    if (b) { b.core = null; const p = this.freePosition(b.x, b.y + b.r + 42, c.r); if (p) { c.x = p.x; c.y = p.y; } }
    c.dock = null; c.targetDock = null; c.dest = null; c.path = []; c.orders = []; c.moveSpeed = 0;
  }
  previewCoreAssignment(coreId, buildingId, { swap = false } = {}) {
    const c = this.byId(coreId), b = this.byId(buildingId);
    if (!c || c.kind !== 'core' || c.team < 0 || !b || b.kind !== 'building' || c.team !== b.team || this.result) return { ok: false, reason: '请选择己方建筑' };
    if (!this.buildings[b.type].acceptsCore) return { ok: false, reason: `${this.buildings[b.type].name}没有核心插槽，无需接入核心` };
    if (b.core === c.id) return { ok: false, reason: '核心已在此建筑内' };
    if ((!swap && b.core) || this.cores(b.team).some(a => a.targetDock === b.id && a.id !== c.id)) return { ok: false, reason: '每座建筑只能承载一个核心，目标插槽已占用或已预留' };
    if (b.construction) return { ok: false, reason: '请等待施工完成' };
    const source = this.byId(c.dock), displaced = this.dockedCore(b);
    const origin = this.orderOrigin(c), p = this.freePosition(b.x, b.y + b.r + 20, c.r);
    const path = origin && p ? this.findPath({ ...origin, r: c.r }, p) : [];
    if (!path.length) return { ok: false, reason: '核心无法到达此建筑，请留出通道' };
    const transfers = [{ core: c, building: b, path, origin }];
    if (displaced) {
      const exit = this.orderOrigin(displaced);
      if (!exit) return { ok: false, reason: '目标核心没有安全的卸载位置' };
      let returnPath = [];
      if (source) {
        if (this.cores(c.team).some(a => a.targetDock === source.id && a.id !== displaced.id)) return { ok: false, reason: '原建筑插槽已预留，暂时无法交换' };
        const entry = this.freePosition(source.x, source.y + source.r + 20, displaced.r);
        returnPath = entry ? this.findPath({ ...exit, r: displaced.r }, entry) : [];
        if (!returnPath.length) return { ok: false, reason: '另一核心无法返回原建筑，交换已取消' };
      }
      transfers.push({ core: displaced, building: source || null, path: returnPath, origin: exit });
    }
    return { ok: true, swapped: !!displaced, sourceId: source?.id ?? null, displacedCoreId: displaced?.id ?? null, transfers };
  }
  assign(coreId, buildingId, options) {
    // Validate both routes before unplugging either core. Existing AI callers keep
    // exclusive-slot assignment; player commands opt into direct replacement.
    const plan = this.previewCoreAssignment(coreId, buildingId, options);
    if (!plan.ok) return plan;
    for (const transfer of plan.transfers) this.undock(transfer.core.id);
    for (const { core, building, path, origin } of plan.transfers) {
      core.x = origin.x; core.y = origin.y;
      if (!building) continue;
      core.targetDock = building.id; core.target = null;
      core.dest = path[path.length - 1]; core.path = path; core.stance = 'move';
    }
    return { ok: true, swapped: plan.swapped, sourceId: plan.sourceId, displacedCoreId: plan.displacedCoreId };
  }
  walkable(x, y, radius = 10, ignoreId = null) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < BOUNDS.left + radius || x > BOUNDS.right - radius || y < BOUNDS.top + radius || y > BOUNDS.bottom - radius) return false;
    const p = { x, y };
    if (this.obstacles.some(o => distance(o, p) <= o.r + radius) || this.terrain.some(t => circleIntersectsPolygon(p, radius, t.points))) return false;
    for (const b of this.entities) if (living(b) && b.kind === 'building' && b.id !== ignoreId && distance(b, p) <= b.r + radius + 6) return false;
    return true;
  }
  terrainAt(x, y) { return terrainAt(x, y, this.terrain, this.obstacles); }
  freePosition(x, y, r = 10, ignoreId = null, occupied = []) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    x = clamp(x, BOUNDS.left + r, BOUNDS.right - r); y = clamp(y, BOUNDS.top + r, BOUNDS.bottom - r);
    const available = (px, py) => this.walkable(px, py, r, ignoreId) && !occupied.some(o => distance(o, { x: px, y: py }) < o.r + r + 4);
    if (available(x, y)) return { x, y };
    for (let radius = 16; radius <= 800; radius += 16) {
      const samples = Math.min(128, Math.ceil(Math.PI * 2 * radius / 20));
      for (let i = 0; i < samples; i++) {
        const angle = i * Math.PI * 2 / samples, px = x + Math.cos(angle) * radius, py = y + Math.sin(angle) * radius;
        if (available(px, py)) return { x: px, y: py };
      }
    }
    return null;
  }
  segmentClear(a, b, r = 10, ignoreId = null) {
    if (!this.walkable(a.x, a.y, r, ignoreId) || !this.walkable(b.x, b.y, r, ignoreId)) return false;
    if (this.obstacles.some(o => pointSegmentDistanceSq(o, a, b) <= (o.r + r) ** 2) || this.terrain.some(t => segmentIntersectsPolygon(a, b, r, t.points))) return false;
    for (const e of this.entities) if (living(e) && e.kind === 'building' && e.id !== ignoreId && pointSegmentDistanceSq(e, a, b) <= (e.r + r + 6) ** 2) return false;
    return true;
  }
  findPath(a, target, ignoreId = null) {
    return this.navigation.findPath(a, target, ignoreId);
  }
  orderOrigin(e) {
    const b = this.byId(e.dock);
    return b ? this.freePosition(b.x, b.y + b.r + 42, e.r) : { x: e.x, y: e.y };
  }
  applyOrder(e, order, path) {
    if (e.kind === 'core' && e.dock) this.undock(e.id);
    const target = this.byId(order.targetId);
    e.targetDock = null; e.target = e.kind === 'unit' && target && target.team !== e.team && !['core', 'capture'].includes(target.kind) && this.canSee(e.team, target) ? target.id : null;
    e.stance = e.target || order.attackMove ? 'attack' : 'move';
    e.dest = path[path.length - 1]; e.orderGoal = order.attackMove && !e.target ? e.dest : null;
    e.anchor = e.stance === 'move' && e.kind === 'unit' ? e.dest : null;
    e.avoidClock = 0; e.avoidFrom = null;
    e.chasing = false; e.path = path; e.repath = .5;
  }
  command(ids, x, y, targetId = null, attackMove = false, append = false) {
    if (this.result) return { ok: false, reason: '本局已结束', accepted: 0 };
    const units = [...new Set(ids)].map(id => this.byId(id)).filter(e => e && e.team >= 0 && (e.kind === 'unit' || e.kind === 'core'));
    if (!units.length) return { ok: false, reason: '请先选择部队或核心', accepted: 0 };
    const target = this.byId(targetId), maxR = Math.max(...units.map(e => e.r));
    const center = this.freePosition(x, y, maxR);
    if (!center) return { ok: false, reason: '附近没有可通行的落点', accepted: 0 };
    const centroid = { x: units.reduce((sum, e) => sum + e.x, 0) / units.length, y: units.reduce((sum, e) => sum + e.y, 0) / units.length };
    const angle = Math.atan2(center.y - centroid.y, center.x - centroid.x), width = Math.ceil(Math.sqrt(units.length)), rows = Math.ceil(units.length / width), gap = maxR * 3 + 12;
    const selectedIds = new Set(units.map(e => e.id));
    const occupied = this.all(units[0].team, 'unit').filter(e => !selectedIds.has(e.id)).map(e => ({ ...(e.orders.at(-1) || e.anchor || e.dest || e), r: e.r }));
    const slots = [];
    for (let i = 0; i < units.length; i++) {
      const row = Math.floor(i / width), columns = Math.min(width, units.length - row * width);
      const lateral = (i % width - (columns - 1) / 2) * gap, forward = (row - (rows - 1) / 2) * gap;
      const p = this.freePosition(center.x - Math.sin(angle) * lateral + Math.cos(angle) * forward, center.y + Math.cos(angle) * lateral + Math.sin(angle) * forward, maxR, null, occupied);
      if (p) { const slot = { ...p, r: gap - maxR - 4 }; slots.push(slot); occupied.push(slot); }
    }
    // Assign nearby slots first so a selection's ID order does not cause crossing paths.
    const pairs = [];
    units.forEach((e, i) => slots.forEach((p, j) => pairs.push({ i, j, cost: distance(e, p) })));
    pairs.sort((a, b) => a.cost - b.cost);
    const assignments = new Map(), used = new Set();
    for (const p of pairs) if (!assignments.has(p.i) && !used.has(p.j)) { assignments.set(p.i, p.j); used.add(p.j); }
    let accepted = 0, queued = 0, full = false, marker = null;
    units.forEach((e, i) => {
      const slot = slots[assignments.get(i)]; if (!slot) return;
      const pending = append && (e.dest || e.target || e.targetDock || e.path.length || e.orders.length);
      if (pending && e.orders.length >= 12) { full = true; return; }
      const origin = pending ? e.orders.at(-1) || e.orderGoal || e.dest || this.orderOrigin(e) : this.orderOrigin(e);
      const path = origin ? this.findPath({ ...origin, r: e.r }, slot) : [];
      if (!path.length) return;
      // An unseen target becomes a ground order to the supplied last-known position.
      // Neither a direct nor a queued order can follow its hidden live coordinates.
      const order = { x: slot.x, y: slot.y, targetId: this.canSee(e.team, target) ? targetId : null, attackMove: attackMove || !!target && target.team >= 0 && target.team !== e.team };
      if (pending) { e.orders.push(order); queued++; }
      else { e.orders = []; this.applyOrder(e, order, path); }
      marker ??= path[path.length - 1]; accepted++;
    });
    const adjusted = distance(center, { x, y }) > 1;
    if (accepted) this.effects.push({ type: 'order', team: units[0].team, x: units.length === 1 ? marker.x : center.x, y: units.length === 1 ? marker.y : center.y, life: 1.2, max: 1.2, attack: !!target || attackMove });
    if (!accepted || adjusted) this.effects.push({ type: 'blocked-order', team: units[0].team, x, y, life: .8, max: .8 });
    return { ok: accepted > 0, accepted, rejected: units.length - accepted, adjusted, queued, reason: full ? '后续指令已满（12）' : !accepted ? '无法到达目标，请选择相连的陆地' : '指令已接受' };
  }
  stop(ids) { ids.map(id => this.byId(id)).filter(e => e && e.kind !== 'building').forEach(e => { e.path = []; e.orders = []; e.moveSpeed = 0; e.anchor = null; e.dest = null; e.target = null; e.targetDock = null; e.orderGoal = null; e.chasing = false; e.stance = 'hold'; }); }
  nextOrder(e) {
    if (e.path.length || e.dest || e.target || e.targetDock || !e.orders.length) return;
    const order = e.orders.shift(), pending = e.orders, origin = this.orderOrigin(e);
    const path = origin ? this.findPath({ ...origin, r: e.r }, order) : [];
    if (path.length) { this.applyOrder(e, order, path); e.orders = pending; }
    else if (!e.team) this.log('后续指令无法到达，已跳过。', 'danger');
  }
  move(e, dt, speed, ignoreId = null) {
    if (dt <= 0 || !e.path?.length) { e.moveSpeed = 0; return; }
    const remaining = e.path.reduce((sum, p, i) => sum + distance(i ? e.path[i - 1] : e, p), 0), acceleration = speed * 5;
    e.moveSpeed = Math.min(speed, (e.moveSpeed || 0) + acceleration * dt, Math.sqrt(2 * acceleration * remaining));
    let amount = e.moveSpeed * dt;
    while (amount > 1e-8 && e.path.length) {
      const p = e.path[0], d = distance(e, p), step = Math.min(amount, d);
      const next = d < 1e-8 ? p : { x: e.x + (p.x - e.x) / d * step, y: e.y + (p.y - e.y) / d * step };
      // Check the whole swept circle even on the final step; never snap through terrain.
      if (!this.segmentClear(e, next, e.r, ignoreId)) {
        e.moveSpeed = 0; e.repath = (e.repath || 0) - dt;
        if (e.repath <= 0 && e.dest) {
          e.path = this.findPath(e, e.dest, ignoreId); e.repath = .5;
          if (!e.path.length) { e.dest = null; e.orderGoal = null; e.target = null; e.targetDock = null; }
        }
        return;
      }
      if (d > 1e-8) e.angle = Math.atan2(p.y - e.y, p.x - e.x);
      e.x = next.x; e.y = next.y; amount -= step;
      if (step >= d - 1e-8) e.path.shift();
    }
    if (!e.path.length) { e.dest = null; e.moveSpeed = 0; if (!e.chasing) e.orderGoal = null; if (e.stance === 'move') e.stance = 'guard'; }
  }
  damage(target, amount, attacker) {
    if (!living(target) || ['core', 'capture'].includes(target.kind) || (target.team === 0 && this.config.invincible)) return;
    if (target.kind === 'unit') amount *= this.unitStats(target).incomingDamage;
    const observedBy = [0, 1].filter(team => this.canSee(team, target));
    target.hp -= amount; target.hit = .15;
    if (target.hp > 0) return;
    target.hp = 0;
    this.visibilityDirty = true;
    if (target.team >= 0) this.stats[attacker.team].kills++;
    if (target.core) this.undock(target.core);
    for (const c of this.cores(target.team)) if (c.targetDock === target.id) { c.targetDock = null; c.path = []; c.dest = null; }
    this.effects.push({ type: 'burst', x: target.x, y: target.y, life: .75, max: .75, big: target.kind === 'building', color: target.team < 0 ? '#efca78' : target.team ? '#ff718b' : '#6dffe1' });
    if (target.type === 'cache') {
      const p = this.freePosition(target.x, target.y, 15, null, this.all(null, 'unit'));
      if (p) this.addCore(-1, p.x, p.y, 0);
      this.log('中立仓库被摧毁，派部队靠近地上的核心即可回收。', 'info', observedBy);
      return;
    }
    if (target.kind === 'building') {
      target.researchJob = null;
      this.log(`${target.team ? '敌方' : '我方'}${this.buildings[target.type].name}被摧毁。`, target.team ? 'good' : 'danger', observedBy);
      if (target.type === 'hq') { this.result = target.team === 1 ? 'victory' : 'defeat'; this.log(this.result === 'victory' ? '敌方建造厂已摧毁，战斗胜利。' : '建造厂失守，战斗结束。', this.result === 'victory' ? 'good' : 'danger'); }
    }
  }
  shoot(e, target, d) {
    e.cooldown = d.reload; e.angle = Math.atan2(target.y - e.y, target.x - e.x);
    this.shots.push({ x: e.x, y: e.y, tx: target.x, ty: target.y, life: .16, max: .16, team: e.team, weapon: e.type, heavy: e.kind === 'building' || d.producer === 'factory' || e.type === 'rocketeer' });
    const hit = (victim, scale = 1) => {
      const bonus = victim.kind === 'building' ? d.buildingBonus : this.units[victim.type]?.producer === 'factory' ? d.vehicleBonus : d.infantryBonus;
      this.damage(victim, d.damage * (bonus ?? 1) * scale, e);
    };
    hit(target);
    if (d.splash) {
      for (const other of this.all(1 - e.team)) if (other.id !== target.id && other.kind !== 'core' && distance(other, target) <= d.splash + other.r) hit(other, .5);
      this.effects.push({ type: 'burst', x: target.x, y: target.y, life: .45, max: .45, big: false, color: e.team ? '#ff718b' : '#f0abbb' });
    }
  }
  update(dt) {
    if (this.result) return;
    this.refreshVisibility();
    dt = clamp(dt, 0, .2); this.time += dt; this.tick += dt;
    const seconds = Math.floor(this.tick + 1e-9);
    if (seconds) { this.tick -= seconds; for (const c of this.cores()) if (c.team >= 0) c.energy += Math.round(this.config.rate) * seconds; }
    const grids = [this.grid(0), this.grid(1)];
    for (const e of this.all()) {
      if (e.kind === 'capture' || e.team < 0) continue;
      e.hit = Math.max(0, (e.hit || 0) - dt);
      if (e.kind !== 'building') this.nextOrder(e);
      if (e.kind === 'core') {
        const b = this.byId(e.dock);
        if (b && this.buildings[b.type].acceptsCore) { e.x = b.x; e.y = b.y; continue; }
        if (e.dock) this.undock(e.id);
        const dest = this.byId(e.targetDock);
        if (dest && this.buildings[dest.type].acceptsCore && !dest.construction && !dest.core && distance(e, dest) < dest.r + 37 && this.segmentClear(e, dest, e.r, dest.id)) {
          e.dock = dest.id; dest.core = e.id; e.targetDock = null; e.path = []; e.dest = null; e.x = dest.x; e.y = dest.y;
          if (e.team === 0) this.log(`核心 ${String(e.serial).padStart(2, '0')} 已装入${this.buildings[dest.type].name}。`, 'good');
        } else this.move(e, dt, 105);
        continue;
      }
      e.cooldown = Math.max(0, e.cooldown - dt);
      if (e.kind === 'building') {
        const buildJob = e.buildJob;
        if (buildJob && buildJob.remaining > 0 && !buildJob.paused) {
          this.payBuilding(e, buildJob);
          if (buildJob.paidCore && this.constructionHasCore(buildJob)) {
            buildJob.remaining = Math.max(0, buildJob.remaining - dt);
            if (!buildJob.remaining && !e.team) this.log(`${this.buildings[buildJob.type].name}已就绪，点击生产图标后放置。`, 'good');
          }
        }
        if (e.construction > 0) {
          // Construction was prepaid, but its yard must keep a core physically docked.
          // Pausing/resuming never spends more energy or resets the remaining time.
          if (this.constructionHasCore(e)) {
            e.construction = Math.max(0, e.construction - dt);
            if (!e.construction) {
              this.unlockBuildingUnits(e);
              if (!e.team) this.log(`${this.buildings[e.type].name}建设完成。`, 'good');
            }
          }
          continue;
        }
        e.powered = this.buildings[e.type].power <= 0 || grids[e.team].ok;
        const research = e.researchJob;
        if (research && !research.paused && e.powered && this.dockedCore(e)) {
          research.remaining = Math.max(0, research.remaining - dt);
          if (research.remaining < 1e-9) {
            this.technologies[e.team].add(research.type); e.researchJob = null;
            if (!e.team) this.log(`${this.buildings[research.type].technology.name}研发完成，永久强化现有与后续全军。`, 'good');
          }
        }
        if (e.type === 'barracks' || e.type === 'factory') {
          if (!e.powered || !e.core) continue;
          if (!e.job && e.queue.length && this.all(e.team, 'unit').length < 60) {
            const type = e.queue[0], d = this.units[type];
            if (this.unitUnlocked(e.team, type) && this.spend(e, d.cost)) { e.queue.shift(); e.job = { type, remaining: d.time, total: d.time, paidCore: e.core, paidCost: d.cost, paused: false }; }
          }
          if (e.job && !e.job.paused) {
            e.job.remaining -= dt;
            if (e.job.remaining <= 0 && this.all(e.team, 'unit').length < 60) {
              const p = this.freePosition(e.x + (e.team ? -1 : 1) * (e.r + 34), e.y + 35, this.units[e.job.type].r);
              const u = p && this.addUnit(e.job.type, e.team, p.x, p.y);
              if (u) {
                e.job = null;
                const r = e.rally || { x: e.x + (e.team ? -130 : 130), y: e.y + 100 };
                this.command([u.id], r.x, r.y, null, true);
              }
            }
            if (e.job) e.job.remaining = Math.max(0, e.job.remaining);
          }
        }
        if (e.type !== 'tower' || !e.powered) continue;
      }
      const d = e.kind === 'unit' ? this.unitStats(e) : this.buildings[e.type];
      let target = this.byId(e.target);
      if (target && (target.team === e.team || ['core', 'capture'].includes(target.kind) || !this.canSee(e.team, target))) { target = null; e.target = null; }
      if (!target && e.stance !== 'move') {
        let nearest = d.range + (e.stance === 'hold' || e.kind === 'building' ? 0 : 65);
        for (const other of this.all(1 - e.team)) if (other.kind !== 'core' && this.canSee(e.team, other)) {
          const dist = distance(e, other) - other.r;
          if (dist < nearest) { nearest = dist; target = other; }
        }
      }
      if (target && distance(e, target) <= d.range + target.r) {
        if (e.orderGoal) e.chasing = true;
        e.moveSpeed = 0;
        if (e.cooldown <= 0) this.shoot(e, target, d);
      } else if (e.kind === 'unit') {
        if (!target && e.chasing && e.orderGoal) {
          e.dest = e.orderGoal; e.path = this.findPath(e, e.orderGoal); e.chasing = false;
        }
        if (target && e.stance !== 'hold' && e.stance !== 'move') {
          if (e.orderGoal) e.chasing = true;
          e.repath = (e.repath || 0) - dt;
          if (e.repath <= 0) {
            const a = Math.atan2(e.y - target.y, e.x - target.x), reach = d.range * .82 + target.r;
            e.dest = this.freePosition(target.x + Math.cos(a) * reach, target.y + Math.sin(a) * reach, e.r);
            e.path = e.dest ? this.findPath(e, e.dest) : []; e.repath = .7;
          }
        }
        this.move(e, dt, d.speed);
      }
      if (e.target && !this.byId(e.target)) e.target = null;
    }
    // Gentle collision separation keeps groups legible without changing their orders.
    const army = this.all(null, 'unit');
    for (let i = 0; i < army.length; i++) for (let j = i + 1; j < army.length; j++) {
      const a = army[i], b = army[j], dist = distance(a, b), min = a.r + b.r + 2;
      if (dist < min && dt > 0) {
        const angle = dist < .01 ? (a.id * 2.39996 + b.id) : Math.atan2(a.y - b.y, a.x - b.x);
        const push = Math.min((min - dist) * .55, 65 * dt), dx = Math.cos(angle) * push, dy = Math.sin(angle) * push;
        const aMoving = a.path.length > 0, bMoving = b.path.length > 0;
        const share = aMoving === bMoving ? .5 : aMoving ? (b.stance === 'hold' ? 1 : .85) : (a.stance === 'hold' ? 0 : .15);
        const pa = { x: a.x + dx * share, y: a.y + dy * share }, pb = { x: b.x - dx * (1 - share), y: b.y - dy * (1 - share) };
        if (this.segmentClear(a, pa, a.r)) { a.x = pa.x; a.y = pa.y; }
        if (this.segmentClear(b, pb, b.r)) { b.x = pb.x; b.y = pb.y; }
      }
    }
    // Restore completed formation slots after a passing unit nudges an early arrival.
    for (const e of army) if (e.anchor && !e.path.length && !e.target && !e.orders.length && distance(e, e.anchor) > .05) {
      const path = this.findPath(e, e.anchor);
      if (path.length) { e.dest = e.anchor; e.path = path; e.stance = 'move'; }
      else e.anchor = null;
    }
    // Replan only stalled units around nearby traffic, rather than rebuilding every path every frame.
    for (const e of army) {
      e.avoidClock = (e.avoidClock || 0) + dt;
      if (e.avoidClock < .8) continue;
      if (e.path.length && e.dest && e.avoidFrom && distance(e, e.avoidFrom) < this.unitStats(e).speed * .2) {
        const blockers = army.filter(other => other.id !== e.id && distance(e, other) < 220);
        if (blockers.length) {
          let path = this.navigation.findPath(e, e.dest, null, blockers);
          // A settled formation can seal the coarse traffic grid farther ahead.
          // First escape the immediate blockage; collision separation and later
          // replans still account for units encountered along the new route.
          if (!path.length) {
            const nearby = blockers.filter(other => distance(e, other) < 120);
            if (nearby.length < blockers.length) path = this.navigation.findPath(e, e.dest, null, nearby);
          }
          if (path.length) { e.path = path; e.moveSpeed = 0; }
        }
      }
      e.avoidFrom = { x: e.x, y: e.y }; e.avoidClock = 0;
    }
    for (const e of [...this.shots, ...this.effects]) e.life -= dt;
    this.shots = this.shots.filter(e => e.life > 0); this.effects = this.effects.filter(e => e.life > 0);
    if (!this.result) this.updateObjectives(dt);
    this.refreshVisibility();
    if (this.config.ai && !this.result) { this.aiClock += dt; if (this.aiClock >= 1) { this.aiClock -= 1; this.runAI(); } }
  }
  runAI() {
    const hq = this.base(1); if (!hq) return;
    const buildings = this.all(1, 'building'), cores = this.cores(1);
    const has = type => buildings.some(b => b.type === type);
    // Borrow the yard's core for research, then return it with its remaining energy.
    for (const c of cores) if (c.aiResearchTarget) {
      const lab = this.byId(c.aiResearchTarget);
      if (!lab || this.technologyActive(1, lab.type) || !this.grid(1).ok) {
        if (hq.core && hq.core !== c.id) {
          this.undock(c.id); c.aiResearchTarget = null;
          this.command([c.id], hq.x - 35, hq.y + 280);
        } else if (c.dock === hq.id || this.assign(c.id, hq.id).ok) c.aiResearchTarget = null;
      } else if (c.dock === lab.id && !lab.researchJob) this.research(lab.id);
    }
    if (!hq.core) { const c = cores.find(c => !c.dock && !c.targetDock); if (c) this.assign(c.id, hq.id); }
    const expansion = this.time >= 110 && !has('academy') ? 'academy' : this.time >= 150 && !has('mobility') ? 'mobility' : this.time >= 190 && !has('arsenal') ? 'arsenal' : null;
    const grid = this.grid(1);
    const plan = !has('power') ? 'power' : !has('barracks') ? 'barracks' : !has('factory') ? 'factory' : !has('tower') ? 'tower' : !grid.ok || expansion && grid.supply < grid.demand + this.buildings[expansion].power ? 'power' : expansion;
    const offsets = { power: [100, -205], barracks: [-185, -80], factory: [-100, 180], tower: [-385, 25], academy: [145, 5], mobility: [170, 190], arsenal: [-105, -240] };
    const sites = Object.fromEntries(Object.entries(offsets).map(([type, [x, y]]) => [type, { x: hq.x + x, y: hq.y + y }]));
    if (plan && !hq.buildJob) this.startBuilding(1, plan);
    if (hq.buildJob?.remaining === 0) {
      const type = hq.buildJob.type;
      let p = sites[type]; if (has(type)) p = { x: hq.x + 130, y: hq.y + 310 };
      // Soldiers can occupy the preferred plot; pick another valid nearby plot.
      const choices = [[0,0],[0,-110],[0,110],[100,0],[-100,0],[100,-110],[100,110]];
      for (const [dx, dy] of choices) {
        if (this.deployBuilding(1, type, p.x + dx, p.y + dy).ok) break;
      }
      // Edited spawns may put the default plots outside the map or behind terrain.
      // Search the remaining construction area before leaving a ready building idle.
      if (hq.buildJob) {
        const target = this.spawnPoints[0], facing = Math.atan2(target.y - hq.y, target.x - hq.x);
        search: for (const radius of [150, 230, 320, 420, 510]) for (let i = 0; i < 16; i++) {
          const angle = facing + i * Math.PI / 8;
          if (this.deployBuilding(1, type, hq.x + Math.cos(angle) * radius, hq.y + Math.sin(angle) * radius).ok) break search;
        }
      }
    }
    if (!plan && !hq.buildJob && !cores.some(c => c.aiResearchTarget)) {
      const lab = buildings.find(b => !b.construction && !b.core && this.buildings[b.type].technology && !this.technologyActive(1, b.type));
      const core = cores.find(c => !c.dock && !c.targetDock && (!lab || lab.researchJob || c.energy >= this.buildings[lab.type].technology.cost)) || this.byId(hq.core);
      if (lab && core && (lab.researchJob || core.energy >= this.buildings[lab.type].technology.cost) && this.assign(core.id, lab.id).ok) core.aiResearchTarget = lab.id;
    }
    for (const b of buildings) if (['barracks', 'factory'].includes(b.type) && !b.construction) {
      if (!b.core) { const free = cores.find(c => !c.dock && !c.targetDock); if (free) this.assign(free.id, b.id); }
      const basic = b.type === 'barracks' ? 'infantry' : 'tank';
      const roster = [basic, basic, ...Object.keys(this.units).filter(type => type !== basic && this.units[type].producer === b.type && this.unitUnlocked(1, type))];
      const type = roster[(this.stats[1].produced + b.queue.length) % roster.length];
      if (b.queue.length < 2 && this.all(1, 'unit').length < (this.config.difficulty === 'easy' ? 18 : 40)) this.enqueue(b.id, type);
    }
    this.runObjectiveAI();
    if (this.time >= this.nextRaid) {
      const army = this.all(1, 'unit').filter(e => !e.aiRole), target = this.spawnPoints[0];
      const min = this.config.difficulty === 'easy' ? 7 : 5;
      if (army.length >= min && target) {
        const visibleBase = this.base(0);
        this.command(army.map(e => e.id), target.x + 70, target.y, this.canSee(1, visibleBase) ? visibleBase.id : null, true);
        this.nextRaid = this.time + (this.config.difficulty === 'hard' ? 35 : this.config.difficulty === 'easy' ? 100 : 65);
        if (army.some(unit => this.canSee(0, unit))) this.log('侦察警报：视野内敌方部队正在向基地推进。', 'danger', [0]);
      }
    }
  }
  runObjectiveAI() {
    const point = this.capturePoint;
    if (this.time < 70) return;
    const army = this.all(1, 'unit');
    const defenders = army.filter(e => e.aiRole === 'capture');
    for (const unit of army) if (point && defenders.length < 3 && !unit.aiRole && !unit.target && army.length >= 6) { unit.aiRole = 'capture'; defenders.push(unit); }
    for (const unit of point ? defenders : []) {
      if (distance(unit, point) < point.r * .6) {
        if (unit.stance !== 'hold') this.stop([unit.id]);
      } else if (!unit.path.length && !unit.target) this.command([unit.id], point.x + (unit.id % 3 - 1) * 55, point.y + 35, null, true);
    }
    // A separate small squad opens caches and physically recovers the dropped cores.
    const scavengers = army.filter(e => e.aiRole === 'cache');
    if (this.time >= 100) for (const unit of army) if (scavengers.length < 2 && !unit.aiRole && !unit.target && army.length >= 9) { unit.aiRole = 'cache'; scavengers.push(unit); }
    const loot = this.cores(-1).filter(core => this.canSee(1, core));
    // Scout the scenario's resource sites; hidden live destruction or pickups are unknown.
    const caches = [];
    for (const site of this.cacheSites) {
      const key = `${site.x},${site.y}`;
      if (this.visibleAt(1, site.x, site.y)) {
        const cache = this.all(-1, 'building').find(building => building.type === 'cache' && building.x === site.x && building.y === site.y);
        if (cache) caches.push(cache); else this.aiClearedCaches.add(key);
      } else if (!this.aiClearedCaches.has(key)) caches.push({ ...site, id: null, kind: 'building' });
    }
    const leader = scavengers[0];
    const target = leader && [...loot, ...caches].sort((a, b) => distance(a, leader) - distance(b, leader))[0];
    for (const unit of scavengers) {
      if (!target) { unit.aiRole = null; continue; }
      const attacking = target.kind === 'building', key = target.id ?? `${target.x},${target.y}`;
      if ((attacking && target.id && unit.target === target.id) || ((!attacking || !target.id) && unit.path.length && unit.aiObjectiveId === key)) continue;
      unit.aiObjectiveId = key;
      this.command([unit.id], target.x, target.y, attacking ? target.id : null, !target.id);
    }
  }
  snapshot() {
    if (this.visibilityDirty) this.refreshVisibility();
    return { time: Math.floor(this.time), result: this.result, config: { ...this.config }, balance: createBalance(this.balance), power: this.grid(0),
      fog: { enabled: this.config.fog, cellSize: this.fog.cellSize, teams: [0, 1].map(team => ({ ...this.fog.summary(team), visibleEntityIds: this.all().filter(entity => this.canSee(team, entity)).map(entity => entity.id) })) },
      technologies: this.technologies.map(types => [...types]), unlockedUnits: this.unlockedUnits.map(types => [...types]),
      map: { ...MAP, terrain: this.terrain, obstacles: this.obstacles, ...(this.map ? { profile: createMap(this.map) } : {}) },
      capturePoint: this.capturePoint ? { ...this.capturePoint, occupants: [...this.capturePoint.occupants], rewards: [...this.capturePoint.rewards] } : null,
      entities: this.all().map(e => ({ ...e, path: undefined })), stats: this.stats };
  }
}
