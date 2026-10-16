import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../dist/engine.js';
import { MatchRecorder } from '../dist/telemetry.js';
import { BALANCE_KEY, REPORT_KEY, readSavedBalance, saveBalance, readLatestReport, saveReport, clearSavedBalance } from '../dist/lab-storage.js';

test('saved numeric profiles round-trip and cannot change an existing match', () => {
  const data = new Map();
  globalThis.localStorage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
  const original = new World({ ai: false });
  const saved = saveBalance({ economy: { rate: 9 }, units: { infantry: { cost: 60, hp: 125 } } });
  assert.equal(readSavedBalance().units.infantry.cost, 60);
  const next = new World({ ai: false, balance: readSavedBalance() });
  assert.equal(next.units.infantry.hp, 125);
  assert.equal(next.config.rate, 9);
  assert.equal(original.units.infantry.cost, 45);
  assert.throws(() => saveBalance({ units: { infantry: { reload: 0 } } }));
  assert.deepEqual(readSavedBalance(), saved, 'invalid writes preserve the previous profile');
  clearSavedBalance();
  assert.equal(readSavedBalance(), null);
  data.set(BALANCE_KEY, '{broken');
  assert.equal(readSavedBalance(), null);
  delete globalThis.localStorage;
});

test('latest match report round-trips and rejects snapshots without corrupting saved data', () => {
  const data = new Map();
  globalThis.localStorage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  const world = new World({ ai: false });
  const recorder = new MatchRecorder(world);
  for(let i=0;i<5;i++)world.update(.2); recorder.update(world);
  const report = recorder.toJSON(world);
  saveReport(report);
  assert.equal(readLatestReport().matchId, report.matchId);
  assert.equal(readLatestReport().duration, 1);
  assert.throws(() => saveReport(world.snapshot()));
  assert.equal(readLatestReport().matchId, report.matchId);
  data.set(REPORT_KEY, 'null');
  assert.equal(readLatestReport(), null);
  recorder.dispose();
  delete globalThis.localStorage;
});

test('blocked browser storage fails visibly on writes and safely on reads', () => {
  globalThis.localStorage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('quota'); } };
  assert.equal(readSavedBalance(), null);
  assert.equal(readLatestReport(), null);
  assert.throws(() => saveBalance({}), /本地存储/);
  delete globalThis.localStorage;
});
