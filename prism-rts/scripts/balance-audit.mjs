// Reproducible combat samples using the real engine, not an independent DPS model.
// Run: node scripts/balance-audit.mjs [budget=900] [--json]
import { pathToFileURL } from 'node:url';
import { World } from '../dist/engine.js';
import { DEFAULT_BALANCE } from '../dist/balance.js';

export function skirmish(leftType, rightType, { budget = 900, balance = DEFAULT_BALANCE, maxSeconds = 120 } = {}) {
  const world = new World({ ai: false, rate: 0, objectives: false, terrain: [], obstacles: [], balance });
  const types = [leftType, rightType], counts = types.map(type => Math.max(1, Math.min(60, Math.floor(budget / world.units[type].cost))));
  const spent = types.map((type, team) => counts[team] * world.units[type].cost);
  for (let team = 0; team < 2; team++) {
    const ids = [], type = types[team];
    for (let i = 0; i < counts[team]; i++) {
      const x = team ? 2200 + Math.floor(i / 5) * 60 : 1400 - Math.floor(i / 5) * 60;
      const y = 1200 + (i % 5 - (Math.min(5, counts[team]) - 1) / 2) * 60;
      ids.push(world.addUnit(type, team, x, y).id);
    }
    world.command(ids, 1800, 1200, null, true);
  }
  while (world.time < maxSeconds && world.all(0, 'unit').length && world.all(1, 'unit').length) world.update(.05);
  const survivors = [0, 1].map(team => world.all(team, 'unit').length);
  const remainingValue = [0, 1].map(team => world.all(team, 'unit').reduce((sum, unit) => sum + world.units[unit.type].cost * unit.hp / unit.maxHp, 0));
  return { types, counts, spent, seconds: Number(world.time.toFixed(2)), survivors, remainingValue: remainingValue.map(value => Number(value.toFixed(1))), winner: !survivors[0] ? rightType : !survivors[1] ? leftType : 'timeout' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const budgetArg = process.argv.slice(2).find(argument => argument !== '--json');
  const budget = budgetArg === undefined ? 900 : Number(budgetArg);
  if (!Number.isFinite(budget) || budget < 240 || budget > 2700) throw new RangeError('预算范围为 240–2700');
  const pairs = [['rocketeer', 'tank'], ['tank', 'striker'], ['sniper', 'infantry'], ['striker', 'infantry'], ['tank', 'heavyTank'], ['infantry', 'rocketeer'], ['scout', 'sniper']];
  const results = pairs.flatMap(([a, b]) => [skirmish(a, b, { budget }), skirmish(b, a, { budget })]);
  if (process.argv.includes('--json')) console.log(JSON.stringify({ kind: 'prism-balance-audit', version: 1, method: {
    budgetCeiling: budget, terrain: 'open', technology: false, micro: false, step: .05, swappedSides: true,
    note: '双方受同一预算上限约束，整兵购买使实际开支不同。剩余价值按生命比例计算；不代表地图实战胜率。'
  }, balance: DEFAULT_BALANCE, results }, null, 2));
  else {
    console.log(`空旷地面、每方预算上限 ${budget}、无科技、无微操、50 ms 步进；双方交换出生侧与实体更新先后顺序。`);
    console.log('实际开支受整兵购买影响；剩余价值按存活生命比例计算。用于发现明显克制问题，不代表地图实战胜率。');
    console.table(results.map(result => ({
      左方: `${result.types[0]} ×${result.counts[0]}`, 右方: `${result.types[1]} ×${result.counts[1]}`,
      实际开支: result.spent.join(' / '), 胜方: result.winner, 秒: result.seconds,
      存活数量: result.survivors.join(' / '), 剩余价值: result.remainingValue.join(' / ')
    })));
  }
}
