// Numeric balance is data. Each match takes a private snapshot; structural rules stay fixed.
const buildings = {
  cache: { name: '中立核心仓库', en: 'NEUTRAL CORE CACHE', hp: 480, r: 48, cost: 0, time: 0, power: 0, acceptsCore: false, buildable: false, color: '#efca78' },
  hq: { name: '建造厂', en: 'CONSTRUCTION YARD', hp: 1800, r: 59, cost: 0, time: 0, power: 0, acceptsCore: true, color: '#88e6c5' },
  power: { name: '电场', en: 'POWER PLANT', hp: 650, r: 42, cost: 120, time: 6, power: -36, acceptsCore: false, color: '#e9c779' },
  barracks: { name: '兵营', en: 'BARRACKS', hp: 800, r: 48, cost: 180, time: 8, power: 8, acceptsCore: true, color: '#aa9ae5' },
  factory: { name: '战车工厂', en: 'WAR FACTORY', hp: 1100, r: 56, cost: 280, time: 11, power: 14, acceptsCore: true, color: '#86b9ed' },
  tower: { name: '防御塔', en: 'DEFENSE TOWER', hp: 750, r: 29, cost: 140, time: 7, power: 10, acceptsCore: false, range: 235, damage: 19, reload: .8, color: '#e598bf' },
  academy: { name: '战术学院', en: 'TACTICAL ACADEMY', hp: 720, r: 43, cost: 200, time: 10, power: 8, acceptsCore: true, color: '#efa576', unlocks: ['sniper', 'rocketeer'], technology: { name: '棱镜火控', description: '', cost: 180, time: 18, stat: 'damage', multiplier: 1.2 } },
  arsenal: { name: '装甲研究所', en: 'ARMOR LAB', hp: 950, r: 49, cost: 260, time: 12, power: 10, acceptsCore: true, color: '#92a9ed', unlocks: ['heavyTank', 'artillery'], technology: { name: '复合装甲', description: '', cost: 220, time: 22, stat: 'incomingDamage', multiplier: .8 } },
  mobility: { name: '动力研究所', en: 'MOBILITY LAB', hp: 700, r: 43, cost: 180, time: 9, power: 6, acceptsCore: true, color: '#73d8d0', unlocks: ['scout', 'striker'], technology: { name: '超导驱动', description: '', cost: 160, time: 16, stat: 'speed', multiplier: 1.2 } }
};
const units = {
  infantry: { name: '棱镜步兵', en: 'PRISM RANGER', hp: 100, r: 10, cost: 45, time: 4, speed: 68, range: 135, damage: 10, reload: .75, vehicleBonus: .6, buildingBonus: .7, producer: 'barracks', color: '#88e6c5' },
  tank: { name: '折光战车', en: 'REFRACTOR', hp: 380, r: 19, cost: 130, time: 8, speed: 46, range: 190, damage: 34, reload: 1.55, vehicleBonus: 1.2, producer: 'factory', color: '#86b9ed' },
  sniper: { name: '狙击手', en: 'SPECTRUM SNIPER', hp: 65, r: 10, cost: 80, time: 6, speed: 57, range: 300, damage: 30, reload: 2, infantryBonus: 1.5, vehicleBonus: .35, buildingBonus: .4, producer: 'barracks', requires: 'academy', color: '#e9c779' },
  rocketeer: { name: '火箭兵', en: 'LANCE ROCKETEER', hp: 110, r: 12, cost: 90, time: 6, speed: 54, range: 215, damage: 24, reload: 1.8, infantryBonus: .55, vehicleBonus: 2.4, buildingBonus: 1.1, producer: 'barracks', requires: 'academy', color: '#efa576' },
  striker: { name: '突击步兵', en: 'PULSE STRIKER', hp: 145, r: 11, cost: 70, time: 5, speed: 88, range: 95, damage: 10, reload: .5, infantryBonus: 1.5, vehicleBonus: .45, buildingBonus: .65, producer: 'barracks', requires: 'mobility', color: '#73d8d0' },
  scout: { name: '侦察车', en: 'GLINT SCOUT', hp: 180, r: 15, cost: 95, time: 5, speed: 100, range: 145, damage: 13, reload: .65, infantryBonus: 1.25, vehicleBonus: .55, buildingBonus: .65, producer: 'factory', requires: 'mobility', color: '#a6e7b0' },
  heavyTank: { name: '重装战车', en: 'BASTION', hp: 680, r: 23, cost: 240, time: 12, speed: 32, range: 180, damage: 52, reload: 1.9, infantryBonus: 1.2, incomingDamage: .85, producer: 'factory', requires: 'arsenal', color: '#b0baf1' },
  artillery: { name: '攻城火炮', en: 'NOVA ARTILLERY', hp: 210, r: 19, cost: 180, time: 10, speed: 35, range: 350, damage: 45, reload: 3.2, splash: 65, vehicleBonus: .8, buildingBonus: 1.4, producer: 'factory', requires: 'arsenal', color: '#f0abbb' }
};
const roles = { infantry: '均衡步兵', tank: '主力反装甲战车', sniper: '远程反步兵', rocketeer: '反装甲支援', striker: '高速近距离突击', scout: '高速侦察与侧翼骚扰', heavyTank: '前排重甲', artillery: '远程范围轰击' };
const number = value => Number(value.toFixed(3));
const percent = factor => `${factor >= 1 ? '+' : '−'}${number(Math.abs(factor - 1) * 100)}%`;

function describe(balance) {
  for (const [type, unit] of Object.entries(balance.units)) {
    const bonuses = [['infantryBonus', '步兵'], ['vehicleBonus', '战车'], ['buildingBonus', '建筑']]
      .filter(([key]) => unit[key] !== 1).map(([key, label]) => `对${label} ×${number(unit[key])}`);
    if (unit.incomingDamage !== 1) bonuses.push(`受到伤害 ${percent(unit.incomingDamage)}`);
    if (unit.splash > 0) bonuses.push(`溅射半径 ${number(unit.splash)}`);
    unit.role = [roles[type], ...bonuses].join(' · ');
  }
  for (const building of Object.values(balance.buildings)) if (building.technology) {
    const tech = building.technology;
    tech.description = `全军${{ damage: '伤害', incomingDamage: '受到伤害', speed: '移动速度' }[tech.stat]} ${percent(tech.multiplier)}`;
  }
  return balance;
}
export function freezeBalance(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freezeBalance); Object.freeze(value);
  }
  return value;
}
for (const unit of Object.values(units)) {
  for (const [key, value] of Object.entries({ infantryBonus: 1, vehicleBonus: 1, buildingBonus: 1, incomingDamage: 1, splash: 0 })) unit[key] ??= value;
}
export const DEFAULT_BALANCE = freezeBalance(describe({ version: 1, economy: { rate: 6, startingEnergy: 180, basePower: 12, captureDuration: 180 }, buildings, units }));

const fields = [];
const field = (path, label, group, min, max, step = 1, integer = false) => fields.push({ path, label, group, min, max, step, integer });
field('economy.rate', '每核心产能 / 秒', '经济', 0, 100, 1, true);
field('economy.startingEnergy', '每核心初始能量', '经济', 0, 100000, 1, true);
field('economy.basePower', '基础供电', '经济', 0, 1000, 1, true);
field('economy.captureDuration', '据点奖励周期 / 秒', '经济', 1, 3600, 1, true);
for (const [type, d] of Object.entries(buildings)) {
  const group = `建筑 · ${d.name}`, path = `buildings.${type}`;
  field(`${path}.hp`, '生命', group, 1, 100000, 1, true);
  if (!['hq', 'cache'].includes(type)) {
    field(`${path}.cost`, '建造能量', group, 0, 10000, 1, true);
    field(`${path}.time`, '建造时间 / 秒', group, .1, 600, .1);
    field(`${path}.power`, type === 'power' ? '供电（负数表示提供）' : '耗电', group, type === 'power' ? -500 : 0, type === 'power' ? 0 : 500, 1, true);
  }
  if (d.damage !== undefined) {
    field(`${path}.damage`, '单发伤害', group, 0, 10000, .1);
    field(`${path}.reload`, '攻击间隔 / 秒', group, .1, 30, .05);
    field(`${path}.range`, '射程', group, 10, 1500, 1);
  }
  if (d.technology) {
    field(`${path}.technology.cost`, '研发能量', `科技 · ${d.technology.name}`, 0, 10000, 1, true);
    field(`${path}.technology.time`, '研发时间 / 秒', `科技 · ${d.technology.name}`, .1, 600, .1);
    field(`${path}.technology.multiplier`, '属性倍率', `科技 · ${d.technology.name}`, .05, 5, .05);
  }
}
for (const [type, d] of Object.entries(units)) {
  const group = `兵种 · ${d.name}`, path = `units.${type}`;
  field(`${path}.hp`, '生命', group, 1, 100000, 1, true);
  field(`${path}.cost`, '生产能量', group, 0, 10000, 1, true);
  field(`${path}.time`, '生产时间 / 秒', group, .1, 600, .1);
  field(`${path}.damage`, '单发伤害', group, 0, 10000, .1);
  field(`${path}.reload`, '攻击间隔 / 秒', group, .1, 30, .05);
  field(`${path}.range`, '射程', group, 10, 1500, 1);
  field(`${path}.speed`, '移动速度', group, 1, 500, 1);
  field(`${path}.splash`, '溅射半径', group, 0, 500, 1);
  field(`${path}.infantryBonus`, '对步兵伤害倍率', group, .05, 10, .05);
  field(`${path}.vehicleBonus`, '对战车伤害倍率', group, .05, 10, .05);
  field(`${path}.buildingBonus`, '对建筑伤害倍率', group, .05, 10, .05);
  field(`${path}.incomingDamage`, '受到伤害倍率', group, .05, 3, .05);
}
export const BALANCE_FIELDS = freezeBalance(fields);
const byPath = new Map(fields.map(item => [item.path, item]));
const clone = value => JSON.parse(JSON.stringify(value));
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));

// Partial numeric overrides and full exported profiles share the same strict whitelist.
// Derived text is discarded and rebuilt, so imported descriptions cannot contradict numbers.
export function validateBalance(input = {}) {
  const value = clone(DEFAULT_BALANCE), errors = [];
  function merge(source, target, path = '') {
    if (!plainObject(source)) { errors.push(`${path || '配置'} 必须是对象`); return; }
    for (const [key, candidate] of Object.entries(source)) {
      const name = path ? `${path}.${key}` : key;
      if (!Object.hasOwn(target, key) || ['__proto__', 'prototype', 'constructor'].includes(key)) { errors.push(`${name} 是未知字段`); continue; }
      const rule = byPath.get(name);
      if (rule) {
        if (typeof candidate !== 'number' || !Number.isFinite(candidate)) errors.push(`${name} 必须是有限数值`);
        else if (candidate < rule.min || candidate > rule.max || (rule.integer && !Number.isInteger(candidate))) errors.push(`${name} 必须为 ${rule.min}–${rule.max}${rule.integer ? ' 的整数' : ' 之间的数值'}`);
        else target[key] = candidate;
      } else if (plainObject(target[key])) merge(candidate, target[key], name);
      else if (key === 'role' || key === 'description') {
        if (typeof candidate !== 'string') errors.push(`${name} 必须是文本`);
      } else if (JSON.stringify(candidate) !== JSON.stringify(target[key])) errors.push(`${name} 为固定规则，不可修改`);
    }
  }
  merge(input, value);
  return { ok: errors.length === 0, errors, value: errors.length ? null : describe(value) };
}
export function createBalance(input = {}) {
  const result = validateBalance(input);
  if (!result.ok) throw new RangeError(`无效平衡配置：${result.errors.join('；')}`);
  return result.value;
}

export const BALANCE_NOTES = freezeBalance([
  '保留每核心 6 能量/秒、180 初始能量与原建筑/科技经济节奏；独立核心和本地支付规则不变。',
  '突击步兵基础 DPS 从 28.95 降为 20，对步兵 ×1.5、对战车 ×0.45：保留高速近距离突击，限制全目标高性价比。',
  '基础步兵对战车 ×0.6，火箭兵对战车 ×2.4、对步兵 ×0.55；让反装甲投资有明确收益和代价。',
  '狙击手对战车 ×0.35、对建筑 ×0.4；侦察车对步兵 ×1.25、对战车 ×0.55，强化专精与侧翼角色。',
  '主坦对战车 ×1.2；重坦 240 能量、180 射程、对步兵 ×1.2，保留 680 生命与 15% 减伤，承担前排而非全面替代主坦。',
  '攻城火炮保留远程溅射与对建筑 ×1.4，对战车 ×0.8；需要前排保护。'
]);
