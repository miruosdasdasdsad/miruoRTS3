import test from 'node:test';
import assert from 'node:assert/strict';
import { fieldAction } from '../dist/interaction.js';

const unit={id:1,team:0,kind:'unit',type:'infantry'};
const core={id:2,team:0,kind:'core',type:'core'};
const factory={id:3,team:0,kind:'building',type:'factory',construction:0};
const enemy={id:4,team:1,kind:'unit',type:'tank'};
const cache={id:5,team:-1,kind:'building',type:'cache'};
const droppedCore={id:6,team:-1,kind:'core',type:'core'};
const relay={id:7,team:-1,kind:'capture',type:'relay'};

test('right click cancels every command mode before considering its target',()=>{
  for(const kind of ['build','attack','rally','waypoints'])for(const hit of [null,unit,factory,enemy]){
    assert.equal(fieldAction({right:true,mode:{kind},selection:[unit],hit}).kind,'cancel-mode');
  }
});
test('right click deselects units, cores and factories without issuing orders',()=>{
  for(const selected of [unit,core,factory,enemy])for(const hit of [null,unit,factory,enemy]){
    assert.equal(fieldAction({right:true,selection:[selected],hit}).kind,'deselect');
  }
});
test('left click moves selected units or attacks an enemy, and can switch friendly selection',()=>{
  assert.equal(fieldAction({selection:[unit]}).kind,'command');
  assert.equal(fieldAction({selection:[unit],hit:enemy}).targetId,enemy.id);
  assert.equal(fieldAction({selection:[unit],hit:factory}).kind,'select');
  assert.equal(fieldAction({selection:[unit],hit:unit,shift:true}).append,true);
});
test('selected factory sets its rally with a left ground click and selects objects on object clicks',()=>{
  const result=fieldAction({selection:[factory]});assert.equal(result.kind,'rally');assert.equal(result.building,factory);
  assert.equal(fieldAction({selection:[factory],hit:unit}).kind,'select');
  assert.equal(fieldAction({selection:[factory],hit:enemy}).kind,'select');
});
test('cores retain left-click docking but cannot issue attack orders',()=>{
  assert.equal(fieldAction({selection:[core],hit:factory}).kind,'dock');
  assert.equal(fieldAction({selection:[core],hit:enemy}).kind,'cannot-attack');
  assert.equal(fieldAction({selection:[unit],hit:{...core,team:1}}).kind,'protected-core');
});
test('explicit placement and command modes take priority over friendly selection',()=>{
  for(const kind of ['build','attack','rally','waypoints'])assert.equal(fieldAction({mode:{kind},selection:[unit],hit:factory}).kind,kind);
});

test('neutral structures require an explicit attack command from troops',()=>{
  assert.equal(fieldAction({selection:[unit],hit:cache}).targetId,cache.id);
  assert.equal(fieldAction({selection:[core],hit:cache}).kind,'cannot-attack');
  assert.equal(fieldAction({hit:cache}).kind,'select');
  for(const kind of ['attack','waypoints'])assert.equal(fieldAction({mode:{kind},selection:[unit],hit:cache}).targetId,cache.id);
});

test('troops approach unclaimed cores and capture points without attacking them',()=>{
  for(const hit of [droppedCore,relay]){
    const action=fieldAction({selection:[unit],hit});
    assert.equal(action.kind,'command');assert.equal(action.targetId,null);
    assert.equal(fieldAction({hit}).kind,'select');
    for(const kind of ['attack','waypoints'])assert.equal(fieldAction({mode:{kind},selection:[unit],hit}).targetId,null);
  }
  assert.equal(fieldAction({selection:[core],hit:droppedCore}).kind,'cannot-collect');
  assert.equal(fieldAction({selection:[core],hit:relay}).kind,'cannot-capture');
});

test('cancel modes and deselection continue to override neutral target actions',()=>{
  for(const hit of [cache,droppedCore,relay]){
    assert.equal(fieldAction({right:true,selection:[unit],hit}).kind,'deselect');
    assert.equal(fieldAction({right:true,mode:{kind:'attack'},selection:[unit],hit}).kind,'cancel-mode');
  }
});
