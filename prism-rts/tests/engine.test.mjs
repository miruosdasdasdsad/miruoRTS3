import test from 'node:test';
import assert from 'node:assert/strict';
import {World,BUILDINGS,UNITS,distance} from '../dist/engine.js';
import {TERRAIN,OBSTACLES} from '../dist/terrain.js';
const advance=(w,seconds)=>{for(let i=0;i<Math.round(seconds*30);i++)w.update(1/30);};
// Economy fixtures use a clear local arena, independent of the campaign map layout.
const sim=()=>new World({ai:false,rate:0,objectives:false,terrain:[],obstacles:[],bases:[{x:370,y:800},{x:2030,y:800}]});

test('opening contains only one construction yard and three cores per player',()=>{
  const w=new World();for(const t of [0,1]){assert.equal(w.all(t).length,4);assert.equal(w.cores(t).length,3);assert.equal(w.all(t,'building').length,1);assert.equal(w.all(t,'unit').length,0);assert.equal(w.energyFor(w.base(t)),180);}
});
test('each core produces whole integers independently, including free and attached cores',()=>{
  const w=new World({ai:false});w.cores(0)[1].energy=7;advance(w,3.5);assert.deepEqual(w.cores(0).map(c=>c.energy),[198,25,198]);assert.ok(w.cores().every(c=>Number.isInteger(c.energy)));advance(w,.5);assert.deepEqual(w.cores(0).map(c=>c.energy),[204,31,204]);
});
test('construction cannot borrow energy from other cores or a shared pool',()=>{
  const w=sim(),[c,a,b]=w.cores(0);c.energy=119;a.energy=b.energy=10000;
  const r=w.startBuilding(0,'power');assert.equal(r.ok,true);advance(w,2);
  assert.equal(r.job.remaining,6);assert.equal(r.job.paidCore,null);assert.equal(c.energy,119);
  c.energy=120;advance(w,1);assert.deepEqual([c.energy,a.energy,b.energy],[0,10000,10000]);assert.ok(r.job.remaining<6);
});
test('every building type pauses without its construction yard core and resumes with no second charge',()=>{
  for(const type of ['power','barracks','factory','tower']){
    const w=sim(),hq=w.base(0),c=w.byId(hq.core),cost=BUILDINGS[type].cost;
    c.energy=cost;
    const result=w.startBuilding(0,type);assert.equal(result.ok,true,type);
    const site=result.job;assert.equal(site.builderId,hq.id);assert.equal(c.energy,0);
    advance(w,1);const remaining=site.remaining;assert.ok(remaining<site.total);
    w.undock(c.id);assert.equal(w.constructionHasCore(site),false);
    advance(w,20);assert.equal(site.remaining,remaining,type);assert.equal(w.activeConstruction(hq),site);
    assert.equal(w.startBuilding(0,'power').ok,false);assert.equal(w.all(0,'building').length,1);
    assert.equal(w.deployBuilding(0,type,550,610).ok,false);assert.equal(w.grid(0).supply,12);
    w.command([c.id],370,1120);advance(w,3);assert.equal(site.remaining,remaining);
    w.assign(c.id,hq.id);advance(w,.1);
    assert.equal(c.dock,null);assert.equal(site.remaining,remaining);
    advance(w,BUILDINGS[type].time+3);
    assert.equal(c.dock,hq.id);assert.equal(site.remaining,0,type);assert.equal(w.all(0,'building').length,1);
    assert.equal(c.energy,0);assert.equal(w.stats[0].spent,cost);
    const placed=w.deployBuilding(0,type,550,610);assert.equal(placed.ok,true,type);assert.equal(placed.entity.construction,0);
    assert.equal(hq.buildJob,null);advance(w,5);assert.equal(c.energy,0);
  }
});
test('moving a construction core to a different building cannot continue the original construction',()=>{
  const w=sim(),hq=w.base(0),original=w.byId(hq.core),replacement=w.cores(0)[1];
  const barracks=w.addBuilding('barracks',0,650,1000);
  const site=w.startBuilding(0,'power').job;advance(w,1);const remaining=site.remaining;
  w.assign(original.id,barracks.id);advance(w,8);
  assert.equal(original.dock,barracks.id);assert.equal(site.remaining,remaining);
  replacement.energy=0;w.assign(replacement.id,hq.id);advance(w,10);
  assert.equal(site.remaining,0);assert.equal(replacement.energy,0);assert.equal(original.energy,60);assert.equal(w.stats[0].spent,120);
});
test('idle and paused construction yards never consume energy, and each side uses its own core',()=>{
  const w=new World({ai:false});advance(w,4);
  assert.equal(w.energyFor(w.base(0)),204);assert.equal(w.stats[0].spent,0);
  const player=w.startBuilding(0,'power').job,enemy=w.startBuilding(1,'power').job;
  const c=w.byId(w.base(0).core);w.undock(c.id);advance(w,8);
  assert.equal(player.remaining,6);assert.equal(enemy.remaining,0);assert.equal(w.grid(1).supply,12);
  assert.equal(c.energy,132);assert.equal(w.stats[0].spent,120);
});
test('ready buildings survive invalid placement and core removal, and deploy with no extra charge',()=>{
  const w=sim(),hq=w.base(0),core=w.byId(hq.core),job=w.startBuilding(0,'power').job;advance(w,7);
  assert.equal(job.remaining,0);assert.equal(w.startBuilding(0,'barracks').ok,false);
  const spent=w.stats[0].spent;assert.equal(w.deployBuilding(0,'power',hq.x,hq.y).ok,false);assert.equal(hq.buildJob,job);
  w.undock(core.id);assert.equal(w.deployBuilding(0,'power',550,610).ok,true);
  assert.equal(w.grid(0).supply,48);assert.equal(w.stats[0].spent,spent);assert.equal(core.energy,60);
  assert.equal(w.deployBuilding(0,'power',600,1000).ok,false);
});
test('manual building pause preserves progress and cancellation refunds only the original payer',()=>{
  const w=sim(),hq=w.base(0),original=w.byId(hq.core),replacement=w.cores(0)[1];
  const job=w.startBuilding(0,'power').job;advance(w,1);const remaining=job.remaining;
  assert.equal(w.toggleBuildingPause(0),true);advance(w,10);assert.equal(job.remaining,remaining);
  w.undock(original.id);w.assign(replacement.id,hq.id);advance(w,5);const balance=replacement.energy;
  assert.equal(w.cancelBuilding(0),true);assert.equal(original.energy,180);assert.equal(replacement.energy,balance);
  assert.equal(w.stats[0].spent,0);assert.equal(w.cancelBuilding(0),false);assert.equal(original.energy,180);
  original.energy=0;w.undock(replacement.id);w.assign(original.id,hq.id);advance(w,5);
  assert.equal(w.startBuilding(0,'factory').ok,true);assert.equal(w.cancelBuilding(0),true);assert.equal(original.energy,0);
});
test('manual unit pause resumes without another payment and cancellation refunds the original core',()=>{
  const w=sim(),b=w.addBuilding('barracks',0,620,830),[original,replacement]=w.cores(0).slice(1);
  w.assign(original.id,b.id);advance(w,8);w.enqueue(b.id,'infantry');advance(w,1);
  const remaining=b.job.remaining;assert.equal(original.energy,135);w.toggleProductionPause(b.id);advance(w,5);
  assert.equal(b.job.remaining,remaining);w.toggleProductionPause(b.id);advance(w,.5);assert.ok(b.job.remaining<remaining);assert.equal(original.energy,135);
  w.toggleProductionPause(b.id);w.undock(original.id);w.assign(replacement.id,b.id);advance(w,8);
  assert.equal(w.cancelProduction(b.id),true);assert.equal(original.energy,180);assert.equal(replacement.energy,180);assert.equal(w.stats[0].spent,0);
  assert.equal(w.cancelProduction(b.id),false);assert.equal(original.energy,180);
});
test('core transfer has travel time, preserves energy and enforces slot reservations',()=>{
  const w=sim(),c=w.cores(0)[1],other=w.cores(0)[2],b=w.addBuilding('barracks',0,650,850);c.energy=317;assert.equal(w.assign(c.id,b.id).ok,true);assert.equal(b.core,null);assert.equal(w.assign(other.id,b.id).ok,false);advance(w,8);assert.equal(c.dock,b.id);assert.equal(b.core,c.id);assert.equal(c.energy,317);w.undock(c.id);assert.equal(b.core,null);assert.equal(c.dock,null);assert.equal(c.energy,317);assert.ok(w.walkable(c.x,c.y,c.r));
});
test('production waits for a local core and sufficient energy, then charges exactly once',()=>{
  const w=sim(),b=w.addBuilding('barracks',0,630,820),c=w.cores(0)[1];w.enqueue(b.id,'infantry');advance(w,5);assert.equal(w.all(0,'unit').length,0);assert.equal(b.job,null);w.assign(c.id,b.id);advance(w,8);assert.equal(w.all(0,'unit').length,1);assert.equal(c.energy,180-45);w.enqueue(b.id,'infantry');c.energy=44;advance(w,5);assert.equal(b.job,null);assert.equal(b.queue.length,1);c.energy=45;advance(w,.5);assert.equal(c.energy,0);assert.ok(b.job);advance(w,4);assert.equal(w.all(0,'unit').length,2);assert.equal(c.energy,0);
});
test('removing a core pauses an in-progress order and reattaching resumes without double charge',()=>{
  const w=sim(),b=w.addBuilding('barracks',0,620,830),c=w.cores(0)[1];w.assign(c.id,b.id);advance(w,8);w.enqueue(b.id,'infantry');advance(w,1);const left=b.job.remaining;w.undock(c.id);advance(w,5);assert.equal(b.job.remaining,left);assert.equal(c.energy,135);w.assign(c.id,b.id);advance(w,6);assert.equal(w.all(0,'unit').length,1);assert.equal(c.energy,135);
});
test('power plants have no running energy cost; shortages pause all power consumers',()=>{
  const w=sim(),b=w.addBuilding('factory',0,600,850),c=w.cores(0)[1];w.assign(c.id,b.id);advance(w,8);w.enqueue(b.id,'tank');advance(w,3);assert.equal(w.grid(0).ok,false);assert.equal(b.job,null);assert.equal(c.energy,180);const p=w.addBuilding('power',0,500,600);advance(w,1);assert.ok(b.job);assert.equal(c.energy,50);const remaining=b.job.remaining;p.hp=0;advance(w,4);assert.equal(b.job.remaining,remaining);p.hp=650;advance(w,8);assert.equal(w.all(0,'unit').length,1);assert.equal(c.energy,50);assert.equal(p.core,null);
});
test('tower fires with power and no core, consuming zero core energy',()=>{
  const w=sim(),tower=w.addBuilding('tower',0,600,800),enemy=w.addUnit('infantry',1,760,800);const energies=w.cores(0).map(c=>c.energy);advance(w,2);assert.ok(enemy.hp<100);assert.equal(tower.core,null);assert.deepEqual(w.cores(0).map(c=>c.energy),energies);w.addBuilding('factory',0,430,1100);const hp=enemy.hp;advance(w,2);assert.equal(enemy.hp,hp);
});
test('building destruction ejects the core with its original energy',()=>{
  const w=sim(),hq=w.base(0),c=w.cores(0)[0],enemy=w.addUnit('tank',1,700,800);c.energy=543;w.damage(hq,2000,enemy);assert.equal(w.result,'defeat');assert.equal(c.dock,null);assert.equal(c.energy,543);assert.equal(hq.core,null);assert.ok(distance(c,hq)>hq.r);
});
test('pathfinding routes around crystals and buildings and units arrive',()=>{
  const w=new World({ai:false,rate:0,objectives:false,terrain:TERRAIN,obstacles:OBSTACLES}),u=w.addUnit('tank',0,1050,750);const target={x:1570,y:850};w.command([u.id],target.x,target.y);assert.ok(u.path.length>1);advance(w,25);assert.ok(distance(u,target)<10,JSON.stringify({x:u.x,y:u.y,path:u.path}));
});
test('queue is bounded and the 60 unit cap pauses queued production',()=>{
  const w=sim(),b=w.addBuilding('barracks',0,630,820),c=w.cores(0)[1];w.assign(c.id,b.id);advance(w,8);for(let i=0;i<8;i++)assert.equal(w.enqueue(b.id,'infantry').ok,true);assert.equal(w.enqueue(b.id,'infantry').ok,false);w.cancelQueued(b.id,0);assert.equal(b.queue.length,7);for(let i=0;i<60;i++)w.addUnit('infantry',0,600+i%10*30,1150+Math.floor(i/10)*30);advance(w,1);assert.equal(b.job,null);assert.equal(c.energy,180);
});
test('AI builds a powered base, docks its cores, produces and defeats an undefended opponent fairly',()=>{
  const w=new World({difficulty:'normal'});advance(w,105);for(const type of ['hq','power','barracks','factory','tower'])assert.ok(w.all(1,'building').some(b=>b.type===type),type);assert.ok(w.cores(1).every(c=>c.dock));assert.ok(w.all(1,'unit').length>=5);assert.equal(w.grid(1).ok,true);assert.ok(w.cores().every(c=>Number.isInteger(c.energy)&&c.energy>=0));assert.equal(w.base(0).hp,BUILDINGS.hq.hp);advance(w,180);assert.equal(w.result,'defeat');assert.ok(w.stats[1].spent>1000);
});
test('player combat can destroy the enemy construction yard and end in victory',()=>{
  const w=sim(),target=w.base(1);for(let i=0;i<12;i++){const u=w.addUnit('tank',0,1800,650+i*30);w.command([u.id],target.x,target.y,target.id,true);}advance(w,30);assert.equal(w.result,'victory');assert.equal(w.base(1),undefined);
});
test('two concurrent factories cannot exceed the population cap',()=>{
  const w=sim();w.addBuilding('power',0,460,590);const a=w.addBuilding('barracks',0,630,770),b=w.addBuilding('barracks',0,630,1020);const cs=w.cores(0);w.assign(cs[1].id,a.id);w.assign(cs[2].id,b.id);advance(w,10);for(let i=0;i<59;i++)w.addUnit('infantry',0,900+i%10*28,1100+Math.floor(i/10)*28);w.enqueue(a.id,'infantry');w.enqueue(b.id,'infantry');advance(w,5);assert.equal(w.all(0,'unit').length,60);assert.ok(a.job||b.job);w.all(0,'unit')[0].hp=0;advance(w,.1);assert.equal(w.all(0,'unit').length,60);assert.equal(a.job,null);assert.equal(b.job,null);
});
test('construction cannot trap a free core inside its footprint',()=>{
  const w=sim(),c=w.cores(0)[1];assert.equal(w.placement(0,'power',c.x,c.y).ok,false);assert.equal(w.cores(0)[0].energy,180);
});
