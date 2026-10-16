import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../dist/engine.js';
import { MatchRecorder, validateMatchReport, MAX_MATCH_SAMPLES, MAX_MATCH_EVENTS } from '../dist/telemetry.js';

const world = (options = {}) => new World({ ai: false, objectives: false, terrain: [], obstacles: [],
  bases: [{ x: 370, y: 800 }, { x: 2030, y: 800 }], ...options });
const advance = (w, recorder, seconds) => {
  for (let step = 0; step < Math.round(seconds * 30); step++) { w.update(1 / 30); recorder.update(w); }
};
const valid = report => {
  const result = validateMatchReport(report);
  assert.equal(result.ok, true, result.errors.join('; '));
  return result.value;
};

test('records real team metrics and uses this match balance for army value', () => {
  const w = world({ balance: { economy: { rate: 7 }, units: { tank: { cost: 177 } } } });
  const recorder = new MatchRecorder(w);
  const unit = w.addUnit('tank', 0, 700, 800);
  w.technologies[0].add('academy');
  w.addBuilding('power', 0, 600, 1000);
  advance(w, recorder, 2);
  const report = valid(recorder.toJSON(w)), initial = report.samples[0].teams[0], last = report.samples.at(-1).teams[0];
  assert.equal(initial.army, 0);
  assert.equal(last.army, 1);
  assert.equal(last.armyValue, 177);
  assert.equal(last.unitCounts.tank, 1);
  assert.equal(last.produced, 1);
  assert.equal(last.energy, 540 + 3 * 7 * 2);
  assert.equal(last.income, 21);
  assert.equal(last.powerSupply, 48);
  assert.equal(last.hqHp, w.base(0).hp);
  assert.deepEqual(last.technologies, ['academy']);
  assert.equal(report.balance.units.tank.cost, 177);
  w.damage(unit, 10000, { team: 1 });
  advance(w, recorder, 2);
  const dead = valid(recorder.toJSON(w)).samples.at(-1);
  assert.equal(dead.teams[0].army, 0);
  assert.equal(dead.teams[1].kills, 1);
  recorder.dispose();
});

test('pause never duplicates time and a subinterval battle ending retains the final state', () => {
  const w = world(), recorder = new MatchRecorder(w);
  for (let n = 0; n < 100; n++) recorder.update(w);
  assert.equal(recorder.samples.length, 1);
  advance(w, recorder, .7);
  const live = valid(recorder.toJSON(w));
  assert.deepEqual(live.samples.map(sample => sample.time), [0, .7]);
  assert.equal(recorder.samples.length, 1, 'export tail must not change the regular sampling clock');
  w.damage(w.base(1), 100000, { team: 0 });
  recorder.update(w);
  const ended = valid(recorder.toJSON(w));
  assert.equal(ended.result, 'victory');
  assert.equal(ended.duration, .7);
  assert.equal(ended.samples.at(-1).teams[1].hqHp, 0);
  assert.equal(ended.samples.at(-1).teams[0].kills, 1);
  for (let n = 0; n < 100; n++) recorder.update(w);
  assert.equal(recorder.samples.length, 2);
  recorder.dispose();
});

test('event subscription captures bursts beyond the game HUD window and never duplicates them', () => {
  const w = world(), recorder = new MatchRecorder(w);
  for (let n = 0; n < 90; n++) w.log(`事件 ${n}`);
  assert.equal(w.events.length, 30);
  recorder.update(w);
  recorder.update(w);
  const report = valid(recorder.toJSON(w));
  assert.equal(report.events.length, 91);
  assert.equal(report.events[1].text, '事件 0');
  assert.equal(report.events.at(-1).text, '事件 89');
  recorder.dispose();
  assert.equal(w.eventListeners.size, 0);
  const previous = recorder.events.length;
  w.log('退订后无需继续实时录制');
  assert.equal(recorder.events.length, previous);
});

test('debug changes remain identifiable even when bounded event and marker windows overflow', () => {
  const w = world(), recorder = new MatchRecorder(w);
  for (let n = 0; n < 1020; n++) recorder.markDebug(`增加能量 ${n}`, w.time);
  for (let n = 0; n < MAX_MATCH_EVENTS + 50; n++) w.log(`测试事件 ${n}`);
  const report = valid(recorder.toJSON(w));
  assert.equal(report.debug.used, true);
  assert.equal(report.debug.markers.length, 1000);
  assert.equal(report.sampling.debugMarkersDropped, 20);
  assert.equal(report.events.length, MAX_MATCH_EVENTS);
  assert.equal(report.sampling.eventsDropped, 1071);
  assert.ok(report.events.every(event => event.kind === 'game'));
  recorder.dispose();
});

test('long matches compact bounded history while retaining the first and latest real sample', () => {
  const w = world(), recorder = new MatchRecorder(w);
  // Drive the recorder clock directly: this test checks retention, not AI/navigation.
  for (let time = 2; time <= 8000; time += 2) {
    w.time = time;
    w.cores(0)[0].energy = time;
    recorder.update(w);
  }
  const report = valid(recorder.toJSON(w));
  assert.ok(report.samples.length <= MAX_MATCH_SAMPLES);
  assert.equal(report.samples[0].time, 0);
  assert.equal(report.samples[0].teams[0].energy, 540);
  assert.equal(report.samples.at(-1).time, 8000);
  assert.equal(report.samples.at(-1).teams[0].energy, 8360);
  assert.equal(report.sampling.compactions, 2);
  assert.equal(report.sampleInterval, 8);
  recorder.dispose();
});

test('full capacity valid reports fit validation work and size budgets', () => {
  const w = world(), recorder = new MatchRecorder(w), report = recorder.toJSON(w);
  const first = report.samples[0];
  report.samples = Array.from({ length: MAX_MATCH_SAMPLES }, (_, index) => ({ ...structuredClone(first), time: index * 2 }));
  report.duration = report.samples.at(-1).time;
  report.events = Array.from({ length: MAX_MATCH_EVENTS }, (_, index) => ({ id: index + 1, time: index,
    text: '对局事件'.repeat(60), level: 'info', kind: 'game' }));
  report.debug = { used: true, markers: Array.from({ length: 1000 }, (_, index) => ({ time: index, label: '调试操作'.repeat(40) })) };
  assert.equal(valid(JSON.stringify(report)).samples.length, MAX_MATCH_SAMPLES);
  assert.ok(JSON.stringify(report).length < 4 * 1024 * 1024);
  recorder.dispose();
});

test('rejects old snapshots, unsafe content, malformed metrics and oversized inputs', () => {
  const w = world(), recorder = new MatchRecorder(w), report = recorder.toJSON(w);
  const reject = mutate => {
    const changed = structuredClone(report); mutate(changed);
    const result = validateMatchReport(changed);
    assert.equal(result.ok, false);
    assert.ok(result.errors[0].length > 0);
    assert.equal(result.value, null);
  };
  assert.equal(validateMatchReport(w.snapshot()).ok, false);
  assert.equal(validateMatchReport('{broken json').ok, false);
  assert.equal(validateMatchReport(' '.repeat(4 * 1024 * 1024 + 1)).ok, false);
  reject(r => { r.duration = NaN; });
  reject(r => { r.samples[0].teams[0].energy = Infinity; });
  reject(r => { r.samples[0].teams[0].spent = -1; });
  reject(r => { r.samples.push(structuredClone(r.samples[0])); });
  reject(r => { r.samples[0].teams.pop(); });
  reject(r => { r.samples[0].teams[0].unitCounts.tank = 3; });
  reject(r => { r.events[0].text = '<img src=x onerror=alert(1)>'; });
  reject(r => { r.balance.units.infantry.role = '<script>danger</script>'; });
  reject(r => { r.samples[0].teams[0].payload = 'unknown'; });
  reject(r => { r.balance = { economy: { rate: 6 } }; });
  reject(r => { r.debug.used = true; });
  reject(r => { r.samples = Array.from({ length: 2001 }, () => r.samples[0]); });
  const dangerous = JSON.parse('{"__proto__":{"polluted":true}}');
  assert.equal(validateMatchReport(dangerous).ok, false);
  let accessorRead = false;
  const accessor = { get samples() { accessorRead = true; return []; } };
  assert.equal(validateMatchReport(accessor).ok, false);
  assert.equal(accessorRead, false);
  recorder.dispose();
});

test('accepted reports are detached and rebuild derived balance descriptions', () => {
  const w = world(), recorder = new MatchRecorder(w), report = recorder.toJSON(w);
  report.balance.units.infantry.role = '过期的兵种说明';
  const accepted = valid(report);
  assert.equal(accepted.balance.units.infantry.role, w.balance.units.infantry.role);
  accepted.samples[0].teams[0].energy = 0;
  assert.equal(report.samples[0].teams[0].energy, 540);
  report.balance.economy.rate = 10;
  assert.equal(recorder.toJSON(w).balance.economy.rate, 6);
  assert.throws(() => recorder.update(world()), /不能跨对局/);
  recorder.dispose();
});
