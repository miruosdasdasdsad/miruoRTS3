// Actual simulation history only. This module never reads the DOM or manufactures
// historical points from a final snapshot.
import { validateBalance } from './balance.js';

export const MATCH_REPORT_KIND = 'prism-rts-match';
export const MATCH_REPORT_VERSION = 1;
export const MAX_MATCH_SAMPLES = 1801;
export const MAX_MATCH_EVENTS = 2000;
export const MAX_MATCH_REPORT_BYTES = 4 * 1024 * 1024;
const MAX_DEBUG_MARKERS = 1000;
const INITIAL_INTERVAL = 2;
const UNIT_TYPES = ['infantry', 'tank', 'sniper', 'rocketeer', 'striker', 'scout', 'heavyTank', 'artillery'];
const TECHNOLOGIES = ['academy', 'arsenal', 'mobility'];
const TEAM_FIELDS = ['energy', 'income', 'army', 'armyValue', 'cores', 'kills', 'produced', 'spent', 'powerSupply', 'powerDemand', 'hqHp', 'hqMaxHp'];
const INTEGER_FIELDS = new Set(['army', 'cores', 'kills', 'produced']);
const EVENT_LEVELS = ['info', 'good', 'danger', 'warning', 'debug'];
const clone = value => JSON.parse(JSON.stringify(value));
const amount = value => Number.isFinite(value) ? Math.max(0, value) : 0;
const clock = value => Math.round(amount(value) * 1e6) / 1e6;
const plainText = (value, max = 240) => String(value ?? '').replace(/[<>\u0000-\u001f\u007f]/g, '').slice(0, max);
const matchId = () => globalThis.crypto?.randomUUID?.() ?? `match-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

function configuration(world) {
  return { rate: amount(world.config.rate), ai: !!world.config.ai,
    difficulty: world.config.difficulty, invincible: !!world.config.invincible };
}

function sampleWorld(world) {
  return { time: clock(world.time), teams: [0, 1].map(team => {
    const cores = world.cores(team), army = world.all(team, 'unit'), hq = world.base(team), grid = world.grid(team);
    const stats = world.stats[team], unitCounts = Object.fromEntries(UNIT_TYPES.map(type => [type, 0]));
    for (const unit of army) if (Object.hasOwn(unitCounts, unit.type)) unitCounts[unit.type]++;
    return {
      energy: cores.reduce((sum, core) => sum + amount(core.energy), 0),
      income: cores.length * Math.round(amount(world.config.rate)),
      army: army.length,
      armyValue: army.reduce((sum, unit) => sum + amount(world.units?.[unit.type]?.cost), 0),
      cores: cores.length, kills: amount(stats.kills), produced: amount(stats.produced), spent: amount(stats.spent),
      powerSupply: amount(grid.supply), powerDemand: amount(grid.demand),
      hqHp: amount(hq?.hp), hqMaxHp: amount(hq?.maxHp ?? world.buildings?.hq?.hp),
      unitCounts, technologies: TECHNOLOGIES.filter(type => world.technologies?.[team]?.has(type))
    };
  }) };
}

export class MatchRecorder {
  constructor(world) {
    this.world = world;
    this.matchId = matchId();
    this.balance = clone(world.balance);
    this.samples = [sampleWorld(world)];
    this.events = [];
    this.markers = [];
    this.interval = INITIAL_INTERVAL;
    this.compactions = 0;
    this.eventsDropped = 0;
    this.debugMarkersDropped = 0;
    this.nextEventId = 1;
    this.lastGameEventId = 0;
    this.seenEvents = new WeakSet();
    this.finished = false;
    this.coverageStart = this.samples[0].time;
    this.capturePendingEvents(world);
    this.unsubscribe = world.subscribeEvents?.(event => this.captureEvent(event));
    if (world.config.invincible) this.markDebug('对局开始时已启用我方无敌', world.time);
  }

  assertWorld(world) {
    if (world !== this.world) throw new Error('对局记录器不能跨对局复用，请创建新的 MatchRecorder。');
  }

  pushEvent(event) {
    this.events.push({ id: this.nextEventId++, ...event });
    if (this.events.length > MAX_MATCH_EVENTS) {
      this.events.shift();
      this.eventsDropped++;
    }
  }

  captureEvent(event) {
    if (!event || typeof event !== 'object') return;
    if (Number.isSafeInteger(event.id)) {
      if (event.id <= this.lastGameEventId) return;
      this.lastGameEventId = event.id;
    } else {
      if (this.seenEvents.has(event)) return;
      this.seenEvents.add(event);
    }
    this.pushEvent({ time: clock(event.time), text: plainText(event.text) || '游戏事件',
      level: EVENT_LEVELS.includes(event.level) ? event.level : 'info', kind: 'game' });
  }

  capturePendingEvents(world) {
    for (const event of [...(world.events || [])].reverse()) this.captureEvent(event);
  }

  compact() {
    // Reserve one slot for a live export's last point. Preserve both endpoints;
    // after compaction the simulation must advance twice as long to add a point.
    if (this.samples.length <= MAX_MATCH_SAMPLES - 1) return;
    const last = this.samples.at(-1);
    this.samples = this.samples.filter((_, index) => index % 2 === 0);
    if (this.samples.at(-1) !== last) this.samples.push(last);
    this.interval *= 2;
    this.compactions++;
  }

  update(world = this.world) {
    this.assertWorld(world);
    this.capturePendingEvents(world);
    if (this.finished) return;
    const time = clock(world.time), last = this.samples.at(-1);
    if (time < last.time) throw new Error('模拟时间发生回退，请为新对局创建记录器。');
    const ended = !!world.result;
    if (time - last.time + 1e-6 >= this.interval || ended) {
      const sample = sampleWorld(world);
      if (sample.time === last.time) this.samples[this.samples.length - 1] = sample;
      else this.samples.push(sample);
      this.compact();
    }
    if (ended) this.finished = true;
  }

  markDebug(label, time = this.world.time) {
    const marker = { time: Math.min(clock(time), clock(this.world.time)), label: plainText(label, 160) || '调试操作' };
    this.markers.push(marker);
    if (this.markers.length > MAX_DEBUG_MARKERS) {
      this.markers.shift();
      this.debugMarkersDropped++;
    }
    this.pushEvent({ time: marker.time, text: marker.label, level: 'debug', kind: 'debug' });
  }

  toJSON(world = this.world) {
    this.assertWorld(world);
    this.update(world);
    const samples = this.samples.slice(), current = sampleWorld(world);
    if (samples.at(-1).time === current.time) samples[samples.length - 1] = current;
    else samples.push(current);
    return clone({
      schemaVersion: MATCH_REPORT_VERSION, kind: MATCH_REPORT_KIND, matchId: this.matchId,
      balance: this.balance, config: configuration(world), result: world.result ?? null,
      duration: current.time, sampleInterval: this.interval, samples, events: this.events,
      debug: { used: this.markers.length > 0 || this.debugMarkersDropped > 0, markers: this.markers },
      sampling: { initialInterval: INITIAL_INTERVAL, effectiveInterval: this.interval,
        compactions: this.compactions, limit: MAX_MATCH_SAMPLES, eventsDropped: this.eventsDropped,
        debugMarkersDropped: this.debugMarkersDropped, coverageStart: this.coverageStart }
    });
  }

  dispose() { this.unsubscribe?.(); this.unsubscribe = null; }
}

function fail(message) { throw new Error(message); }
function plain(value, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(message);
}
function keys(value, expected, label) {
  plain(value, `${label}必须是对象。`);
  const actual = Object.keys(value);
  if (actual.length !== expected.length || actual.some(key => !expected.includes(key))) fail(`${label}字段不完整或包含未知字段。`);
}
function number(value, label, maximum = 1e12, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > maximum || (integer && !Number.isSafeInteger(value))) fail(`${label}必须是范围内的${integer ? '整数' : '有限数值'}。`);
}
function textValue(value, label, max = 240) {
  if (typeof value !== 'string' || !value.length || value.length > max || /[<>\u0000-\u001f\u007f]/.test(value)) fail(`${label}必须是限定长度的纯文本。`);
}

// Inspect untrusted objects before reading their fields: bound work, disallow
// accessors / prototype keys and reject numbers that JSON would turn into null.
function inspectTree(root) {
  let visited = 0;
  const walk = (value, depth) => {
    if (++visited > 180000 || depth > 12) fail('报告结构过大或嵌套过深。');
    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'number') { if (!Number.isFinite(value)) fail('报告含有非有限数值。'); return; }
    if (typeof value === 'string') {
      if (value.length > 1000) fail('报告文本字段过长。');
      if (/[<>\u0000-\u001f\u007f]/.test(value)) fail('报告文本中不允许 HTML 标记或控制字符。');
      return;
    }
    if (Array.isArray(value)) {
      if (value.length > MAX_MATCH_EVENTS) fail('报告数组超过容量限制。');
      for (const entry of value) walk(entry, depth + 1);
      return;
    }
    plain(value, '报告含有不支持的数据类型。');
    const names = Object.keys(value);
    if (names.length > 64) fail('报告对象包含过多字段。');
    for (const key of names) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) fail('报告包含不安全的对象字段。');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('报告不允许可执行属性。');
      walk(descriptor.value, depth + 1);
    }
  };
  walk(root, 0);
}

function requireFullShape(value, template) {
  if (!template || typeof template !== 'object' || Array.isArray(template)) return;
  keys(value, Object.keys(template), '报告数值配置');
  for (const key of Object.keys(template)) requireFullShape(value[key], template[key]);
}

export function validateMatchReport(input) {
  try {
    let report = input;
    if (typeof input === 'string') {
      if (input.length > MAX_MATCH_REPORT_BYTES) fail('报告超过 4 MB 的导入限制。');
      try { report = JSON.parse(input); } catch { fail('文件不是有效的 JSON 报告。'); }
    }
    inspectTree(report);
    keys(report, ['schemaVersion', 'kind', 'matchId', 'balance', 'config', 'result', 'duration', 'sampleInterval', 'samples', 'events', 'debug', 'sampling'], '对局报告');
    if (report.schemaVersion !== MATCH_REPORT_VERSION || report.kind !== MATCH_REPORT_KIND) fail('只支持本工具生成的版本 1 对局报告；旧战场快照不包含真实历史。');
    if (typeof report.matchId !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(report.matchId)) fail('对局编号格式不正确。');
    const balanceResult = validateBalance(report.balance);
    if (!balanceResult.ok) fail('报告中的数值配置无效。');
    requireFullShape(report.balance, balanceResult.value);
    keys(report.config, ['rate', 'ai', 'difficulty', 'invincible'], '对局配置');
    number(report.config.rate, '核心产能', 100, true);
    if (typeof report.config.ai !== 'boolean' || typeof report.config.invincible !== 'boolean' || !['easy', 'normal', 'hard'].includes(report.config.difficulty)) fail('对局难度或开关配置无效。');
    if (![null, 'victory', 'defeat'].includes(report.result)) fail('对局结果无效。');
    number(report.duration, '对局时长', 1e9);
    number(report.sampleInterval, '采样间隔', 1e9);
    keys(report.sampling, ['initialInterval', 'effectiveInterval', 'compactions', 'limit', 'eventsDropped', 'debugMarkersDropped', 'coverageStart'], '采样说明');
    const sampling = report.sampling;
    number(sampling.compactions, '压缩次数', 29, true);
    if (sampling.initialInterval !== INITIAL_INTERVAL || sampling.limit !== MAX_MATCH_SAMPLES || sampling.effectiveInterval !== report.sampleInterval || report.sampleInterval !== INITIAL_INTERVAL * 2 ** sampling.compactions) fail('采样间隔或容量说明不一致。');
    number(sampling.eventsDropped, '省略事件数', 1e12, true);
    number(sampling.debugMarkersDropped, '省略调试标记数', 1e12, true);
    number(sampling.coverageStart, '历史起点', report.duration);
    if (!Array.isArray(report.samples) || !report.samples.length || report.samples.length > MAX_MATCH_SAMPLES) fail('报告必须包含 1 至 1801 个真实采样点。');
    let previousTime = -1;
    for (const sample of report.samples) {
      keys(sample, ['time', 'teams'], '采样点');
      number(sample.time, '采样时间', report.duration);
      if (sample.time <= previousTime) fail('采样时间必须严格递增，暂停不能产生重复采样。');
      previousTime = sample.time;
      if (!Array.isArray(sample.teams) || sample.teams.length !== 2) fail('每个采样点必须包含两队数据。');
      for (const team of sample.teams) {
        keys(team, [...TEAM_FIELDS, 'unitCounts', 'technologies'], '队伍采样');
        for (const field of TEAM_FIELDS) number(team[field], `队伍 ${field}`, 1e12, INTEGER_FIELDS.has(field));
        keys(team.unitCounts, UNIT_TYPES, '兵种组成');
        for (const count of Object.values(team.unitCounts)) number(count, '兵种数量', 1e6, true);
        if (Object.values(team.unitCounts).reduce((a, b) => a + b, 0) !== team.army) fail('兵种组成与军队总数不一致。');
        if (team.hqHp > team.hqMaxHp) fail('建造厂生命值超过最大值。');
        if (!Array.isArray(team.technologies) || team.technologies.length > 3 || new Set(team.technologies).size !== team.technologies.length || team.technologies.some(type => !TECHNOLOGIES.includes(type))) fail('队伍科技列表无效。');
      }
    }
    if (report.samples[0].time !== sampling.coverageStart || report.samples.at(-1).time !== report.duration) fail('报告首尾采样与时长说明不一致。');
    if (!Array.isArray(report.events) || report.events.length > MAX_MATCH_EVENTS) fail('事件列表超过容量限制。');
    let previousId = 0;
    for (const event of report.events) {
      keys(event, ['id', 'time', 'text', 'level', 'kind'], '对局事件');
      number(event.id, '事件编号', 1e12, true);
      if (event.id <= previousId) fail('事件编号必须严格递增。');
      previousId = event.id;
      number(event.time, '事件时间', report.duration);
      textValue(event.text, '事件内容');
      if (!EVENT_LEVELS.includes(event.level) || !['game', 'debug'].includes(event.kind) || (event.kind === 'debug' && event.level !== 'debug')) fail('事件类型无效。');
    }
    keys(report.debug, ['used', 'markers'], '调试标记');
    if (typeof report.debug.used !== 'boolean' || !Array.isArray(report.debug.markers) || report.debug.markers.length > MAX_DEBUG_MARKERS) fail('调试标记格式或数量无效。');
    for (const marker of report.debug.markers) {
      keys(marker, ['time', 'label'], '调试操作');
      number(marker.time, '调试时间', report.duration);
      textValue(marker.label, '调试说明', 160);
    }
    if (report.debug.used !== (report.debug.markers.length > 0 || sampling.debugMarkersDropped > 0) || (!report.debug.used && report.events.some(event => event.kind === 'debug'))) fail('调试使用标记与操作历史不一致。');
    const encoded = JSON.stringify(report);
    if (encoded.length > MAX_MATCH_REPORT_BYTES) fail('报告超过 4 MB 的导入限制。');
    const value = JSON.parse(encoded);
    value.balance = balanceResult.value;
    return { ok: true, errors: [], value, report: value, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : '无法解析对局报告。';
    return { ok: false, errors: [message], value: null, report: null, error: message };
  }
}
