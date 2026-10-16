import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../dist/engine.js';

const advance = (world, seconds) => { for (let i = 0; i < Math.round(seconds * 5); i++) world.update(.2); };

test('AI builds and researches every technology, trains specialists, and returns its borrowed core', () => {
  const world = new World({ difficulty: 'normal', invincible: true, objectives: false });
  advance(world, 600);
  for (const type of ['academy', 'mobility', 'arsenal']) assert.equal(world.technologyActive(1, type), true, type);
  assert.ok(world.all(1, 'unit').some(unit => !['infantry', 'tank'].includes(unit.type)));
  assert.ok(world.cores(1).every(core => core.dock && !core.aiResearchTarget));
  assert.equal(world.grid(1).ok, true);
  assert.ok(world.cores(1).every(core => Number.isInteger(core.energy) && core.energy >= 0));
});

test('AI recalls a research core to rebuild destroyed power and resumes the prepaid research', () => {
  const world = new World({ difficulty: 'normal', invincible: true, objectives: false });
  let lab;
  for (let i = 0; i < 1500; i++) {
    world.update(.2);
    lab = world.researchInProgress(1, 'academy');
    if (lab?.core) break;
  }
  assert.ok(lab?.core, 'research has physically started');
  const research = lab.researchJob;
  const power = world.all(1, 'building').find(b => b.type === 'power');
  world.damage(power, power.hp, world.base(0));
  assert.equal(world.grid(1).ok, false);
  advance(world, 1.2);
  assert.equal(lab.researchJob, research, 'power recovery preserves the paid research');
  advance(world, 240);
  assert.equal(world.grid(1).ok, true);
  assert.equal(world.technologyActive(1, 'academy'), true, 'interrupted research eventually finishes');
  assert.ok(world.all(1, 'building').some(b => b.type === 'power'));
});
