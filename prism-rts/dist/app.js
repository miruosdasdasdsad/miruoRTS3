import { World, MAP, clamp } from './engine.js';
import { Renderer } from './render.js';
import { fieldAction } from './interaction.js';
import { visionRadius } from './fog.js';
import { CORE_HOLD_MS, coreFromHit, previewCoreDrop } from './core-drag.js';
import { productionFacilities, productionOrder, productionUnits } from './production.js';
import { MatchRecorder } from './telemetry.js';
import { DEFAULT_BALANCE } from './balance.js';
import { BALANCE_KEY, MAP_KEY, readSavedBalance, readSavedMap, saveReport, downloadJSON } from './lab-storage.js';
const $ = selector => document.querySelector(selector);
window.name='prism-battle';
const icons = { hq:'▣', power:'ϟ', barracks:'▤', factory:'⬡', tower:'⌖', academy:'⌘', arsenal:'⬟', mobility:'»', infantry:'♟', tank:'⬢', sniper:'⊕', rocketeer:'↟', striker:'»', heavyTank:'⬣', artillery:'⌖', scout:'◇', core:'◈', cache:'▧', relay:'◎' };
const fmt = s => `${String(Math.floor(s/60)).padStart(2,'0')}:${String(Math.floor(s%60)).padStart(2,'0')}`;
let activeSavedBalance=readSavedBalance();
let activeSavedMap=readSavedMap();
let world=new World({balance:activeSavedBalance||{},map:activeSavedMap}),started=false,paused=true,speed=1,mode=null,lastUI=0,accumulator=0,seenEvent=null,resultShown=false;
let BUILDINGS=world.buildings,UNITS=world.units,recorder=new MatchRecorder(world),lastReportSave=-Infinity,reportStorageWarning=false;
const technologyTypes=Object.keys(BUILDINGS).filter(type=>BUILDINGS[type].technology);
let productionTab='buildings',sameType=null,facilityPick={};
const canvas=$('#game'),renderer=new Renderer(canvas,$('#minimap'),()=>world),selection=renderer.selected;
selection.add(world.base(0).id);
let toastTimer,alertTimer;
function toast(message){$('#toast').textContent=message;$('#toast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('show'),3000);}
function alert(message){$('#battle-message').textContent=message;$('#battle-message').classList.add('show');clearTimeout(alertTimer);alertTimer=setTimeout(()=>$('#battle-message').classList.remove('show'),5500);}
function selected(){return [...selection].map(id=>world.byId(id)).filter(entity=>world.canSee(0,entity));}
function select(ids,append=false,toggle=false){if(!append||selected().some(e=>e.kind!=='unit'||e.team!==0))selection.clear();ids.forEach(id=>{if(toggle&&selection.has(id))selection.delete(id);else selection.add(id);});const e=selected()[0];if(e?.team===0&&e.kind==='building'){if(['barracks','factory'].includes(e.type)){productionTab=e.type==='barracks'?'infantry':'vehicles';facilityPick[productionTab]=e.id;}else if(BUILDINGS[e.type].technology)productionTab='technology';}const showObjective=e&&innerWidth<=760&&(e.kind==='capture'||e.team===-1);if(showObjective){$('.sidebar').classList.add('expanded');$('#panel-toggle').textContent='⌄';}sameType=null;cancelMode();updateUI(true);if(showObjective)$('.selection-section').scrollIntoView({block:'nearest'});}
function ensureStarted(){if(!started){toast('先点击“开始作战”进入战役');return false;}if(world.result){toast('本局已结束，可以重新开始');return false;}return true;}
function focus(e){if(e){renderer.camera.x=e.x;renderer.camera.y=e.y;renderer.clampCamera();}}
function focusCapture(){if(world.capturePoint){focus(world.capturePoint);collapseMobile();toast(`中心据点：派部队进入圆环，独占每 ${world.capturePoint.duration} 秒获得 1 个核心`);}}
function captureStatus(point){return point.contested?'双方争夺 · 计时暂停':point.owner===0?'我方独占':point.owner===1?'敌方独占':'无人占领';}
function objectivesUI(){
  const point=world.capturePoint,hud=$('#capture-hud');hud.hidden=!point;$('.battlefield').classList.toggle('has-capture',!!point);if(!point)return;
  if(!world.captureKnown(0)){
    hud.dataset.owner='neutral';$('#capture-status').textContent='视野外 · 待侦察';$('#capture-timer').textContent='--:--';$('#capture-progress').style.width='0%';
    $('#capture-note').textContent=`派兵侦察 · 独占每 ${point.duration} 秒 +1 核心`;
    hud.setAttribute('aria-label','定位中央据点，当前视野外，派兵侦察后查看占领状态；保留选择');return;
  }
  const remaining=Math.max(0,Math.ceil(point.duration-point.progress)),state=captureStatus(point),team=point.contested?'contested':point.owner===0?'friendly':point.owner===1?'hostile':'neutral';
  hud.dataset.owner=team;$('#capture-status').textContent=state;$('#capture-timer').textContent=fmt(remaining);$('#capture-progress').style.width=`${clamp(point.progress/point.duration,0,1)*100}%`;
  $('#capture-note').textContent=point.contested?'清除敌军后继续当前进度':point.owner==null?`派兵进入 · 每 ${point.duration} 秒 +1 核心`:`${paused&&started?'战役暂停 · ':''}${point.owner===0?'我方':'敌方'}下一核心 · 点击定位`;
  hud.setAttribute('aria-label',`定位中心据点，${state}，${point.owner==null?'派兵独占 '+point.duration+' 秒获得核心':'本轮剩余 '+remaining+' 秒'}；只移动视角，保留选择`);
}
function collapseMobile(){if(innerWidth<=760){$('.sidebar').classList.remove('expanded');$('#panel-toggle').textContent='⌃';}}
function setMode(value){mode=value;renderer.placement=null;$('#mode-banner').hidden=!mode;$('#attack-btn').classList.toggle('active',mode?.kind==='attack');canvas.style.cursor=mode?'crosshair':'default';$('#cancel-mode').textContent=mode?.kind==='waypoints'?'结束追加':'取消 ×';$('#deselect-btn').innerHTML=`<span>×</span> ${mode?'取消模式':'取消选择'}`;if(mode)$('#mode-text').textContent=mode.kind==='build'?`${BUILDINGS[mode.type].name}已就绪 · 左键放置 / 右键退出`:mode.kind==='rally'?'左键点空地设置集结点 · 右键取消':mode.kind==='waypoints'?'左键依次追加指令 · 右键结束追加':'左键攻击移动 · 右键取消';}
function cancelMode(){setMode(null);}
function start(){if(started)return;if(JSON.stringify(readSavedBalance())!==JSON.stringify(activeSavedBalance)||JSON.stringify(readSavedMap())!==JSON.stringify(activeSavedMap))reset();const d=$('#difficulty').value;world.config.difficulty=d;world.nextRaid=d==='easy'?180:d==='hard'?80:120;started=true;paused=false;$('#start-card').hidden=true;renderer.home();alert('先建电场与兵营，再按地图布局探索资源、展开进攻。');world.log(`建议先建电场、兵营并接入核心。${world.capturePoint?`独占据点每 ${world.capturePoint.duration} 秒再得一个核心。`:'本地图未设置占领据点。'}`);persistReport(true);updateUI(true);}
function reset(){cancelCoreGesture();persistReport(true);recorder.dispose();activeSavedBalance=readSavedBalance();activeSavedMap=readSavedMap();world=new World({difficulty:$('#difficulty').value,balance:activeSavedBalance||{},map:activeSavedMap});BUILDINGS=world.buildings;UNITS=world.units;recorder=new MatchRecorder(world);lastReportSave=-Infinity;reportStorageWarning=false;started=false;paused=true;accumulator=0;speed=1;resultShown=false;seenEvent=null;productionTab='buildings';sameType=null;facilityPick={};selectionKey='';actionKey='';renderedProduction='';renderedProductionQueue='';selection.clear();selection.add(world.base(0).id);cancelMode();renderer.home();$('#start-card').hidden=false;$('#result-card').hidden=true;$('#game-speed').value='1';$('#energy-rate').value=world.config.rate;$('#ai-enabled').checked=true;$('#god-mode').checked=false;for(const d of document.querySelectorAll('dialog'))d.close();updateBalanceNotice();updateUI(true);}
function persistReport(force=false){
  if(!started||(!force&&world.time-lastReportSave<5))return;
  lastReportSave=world.time;
  try{saveReport(recorder.toJSON(world));reportStorageWarning=false;}
  catch(error){if(!reportStorageWarning){toast(error.message);reportStorageWarning=true;}}
}
function markDebug(label){recorder.markDebug(label,world.time);persistReport(true);}
function updateBalanceNotice(){const pending=readSavedBalance(),baseline=!activeSavedBalance||JSON.stringify(activeSavedBalance)===JSON.stringify(DEFAULT_BALANCE);$('#balance-status').textContent=JSON.stringify(pending)===JSON.stringify(activeSavedBalance)?baseline?'平衡基准已应用 · 双方共用配置':'自定义数值已应用 · 双方共用配置':'已保存新配置 · 下局开始时应用';const nextMap=readSavedMap();$('#sector-name').textContent=activeSavedMap?.name||'棱镜战场';$('#map-status').textContent=JSON.stringify(nextMap)===JSON.stringify(activeSavedMap)?`地图：${activeSavedMap?.name||'棱镜战场'}`:`新地图：${nextMap?.name||'棱镜战场'} · 下局开始时应用`;}
function togglePause(){if(ensureStarted()){paused=!paused;updateUI(true);}}
function startBuild(type,right=false){
  if(!ensureStarted())return;
  const job=world.activeConstruction(world.base(0));
  if(job){
    if(job.type!==type){if(!right)toast('请先放置或取消当前建筑');return;}
    if(right){if(job.paused||job.remaining===0){world.cancelBuilding(0);if(mode?.kind==='build')cancelMode();toast('建筑已取消，已付能量退回原核心');}else{world.toggleBuildingPause(0);toast('建造已暂停，左键图标继续；再次右键取消');}}
    else if(job.remaining===0){setMode({kind:'build',type});collapseMobile();}
    else if(job.paused){world.toggleBuildingPause(0);toast('建造已继续');}
    else toast('建筑正在生产，完成后再次点击放置');
  }else if(!right){const result=world.startBuilding(0,type);toast(result.ok?'已添加建造任务，完成后点击图标放置':result.reason);}
  updateUI(true);
}
function allArmy(){if(!ensureStarted())return;const a=world.all(0,'unit');if(!a.length){toast('还没有部队，请在兵营或战车工厂生产');return;}select(a.map(e=>e.id));collapseMobile();toast(`已选择 ${a.length} 个单位，点地面移动，点敌人攻击`);}
function attackMode(){if(!ensureStarted())return;if(!selected().some(e=>e.kind==='unit'&&e.team===0)){toast('请先选择要攻击移动的部队');return;}setMode(mode?.kind==='attack'?null:{kind:'attack'});collapseMobile();}
function selectType(){const unit=selected().find(e=>e.kind==='unit'&&e.team===0);if(!unit)return;const wholeMap=sameType===unit.type;select(world.all(0,'unit').filter(e=>e.type===unit.type&&(wholeMap||renderer.visible(e.x,e.y,0))).map(e=>e.id));sameType=unit.type;toast(wholeMap?'已选择全地图同类单位':'已选择画面内同类单位，再点一次选择全地图');}
function waypointMode(){if(!ensureStarted())return;if(!selected().some(e=>e.team===0&&e.kind==='unit')){toast('请先选择部队');return;}setMode(mode?.kind==='waypoints'?null:{kind:'waypoints'});collapseMobile();}
function showProduction(id){const b=world.byId(id);if(!b||b.team!==0||b.construction||!['barracks','factory'].includes(b.type))return;productionTab=b.type==='barracks'?'infantry':'vehicles';facilityPick[productionTab]=b.id;updateUI(true);document.querySelector(`[data-factory="${b.id}"]`)?.scrollIntoView({block:'nearest'});}
function produce(id,type,right=false){
  if(!ensureStarted())return;const result=productionOrder(world,id,type,right);toast(result.message||result.reason);
  updateUI(true);
}
function stopSelected(){if(!ensureStarted())return;const ids=selected().filter(e=>e.team===0&&(e.kind==='unit'||e.kind==='core')).map(e=>e.id);cancelMode();if(!ids.length){toast('请先选择己方部队或核心');return;}world.stop(ids);toast('已停止并原地驻守，后续指令已清空');updateUI(true);}
function coresUI(){
  const cores=world.cores(0);
  for(const c of cores){let card=$(`#core-card-${c.id}`);if(!card){card=document.createElement('button');card.id=`core-card-${c.id}`;card.className='core-card';card.dataset.core=c.id;card.innerHTML=`<span class="core-diamond">◈</span><span class="core-detail"><strong>CORE ${String(c.serial).padStart(2,'0')}</strong><small></small></span><span class="core-energy"><span></span><small>ENERGY</small></span>`;$('#cores').append(card);}const b=world.byId(c.dock),target=world.byId(c.targetDock);card.querySelector('.core-detail small').textContent=b?`${BUILDINGS[b.type].name} · 已装载`:target?`前往${BUILDINGS[target.type].name}`:'游离 · 可调度';card.querySelector('.core-energy>span').textContent=c.energy.toLocaleString();card.classList.toggle('selected',selection.has(c.id)||(b&&selection.has(b.id)));card.setAttribute('aria-pressed',String(selection.has(c.id)));card.setAttribute('aria-label',`核心 ${String(c.serial).padStart(2,'0')}，${c.energy} 能量，${b?BUILDINGS[b.type].name:target?'运输中':'游离'}`);}
  for(const card of $('#cores').children)if(world.byId(Number(card.dataset.core))?.team!==0)card.remove();
  $('#core-count').innerHTML=`${cores.length} <em>CORES</em>`;$('#core-total').textContent=String(cores.length).padStart(2,'0');$('#rate-label').textContent=`+${world.config.rate} / 秒 / 核心`;
  if($('#debug-dialog').open){const options=cores.map(c=>`<option value="${c.id}">核心 ${String(c.serial).padStart(2,'0')}</option>`).join(''),picker=$('#debug-core'),previous=picker.value;if(picker.innerHTML!==options){picker.innerHTML=options;if(cores.some(c=>String(c.id)===previous))picker.value=previous;}}
}
let selectionKey='',actionKey='',pointerOnQueue=false,renderedProduction='',renderedProductionQueue='';
function researchState(b){
  const technology=BUILDINGS[b.type].technology,core=world.dockedCore(b),job=b.researchJob,powered=world.grid(b.team).ok;
  if(world.technologyActive(b.team,b.type))return {complete:true,label:'已完成 · 全军永久生效'};
  if(job)return {label:job.paused?'研发已手动暂停':!core?'研发暂停 · 等待接入核心':!powered?'研发暂停 · 电力不足':`研发中 · 剩余 ${Math.ceil(job.remaining)} 秒`};
  const other=world.researchInProgress(b.team,b.type);
  if(other)return {blocked:true,label:`同类研发已在 #${other.id} 进行`};
  if(!core)return {blocked:true,label:'接入核心后可研发'};
  if(!powered)return {blocked:true,label:'电力不足，无法研发'};
  if(core.energy<technology.cost)return {blocked:true,label:`核心还需 ${technology.cost-core.energy} 能量`};
  return {label:'使用此建筑核心能量研发'};
}
function researchPanel(b){
  const d=BUILDINGS[b.type],t=d.technology,state=researchState(b),job=b.researchJob;
  const controls=b.team!==0?'':job?`<div class="production-controls"><button data-research-toggle="${b.id}">${job.paused?'继续研发':'暂停研发'}</button><button data-research-cancel="${b.id}">取消并退款</button></div>`:state.complete?'':`<button class="research-button" data-research="${b.id}" ${state.blocked?'disabled':''}>研发 ${t.name} · ◇ ${t.cost}</button>${!b.core?`<button class="research-core-button" data-choose-core="${b.id}">选择空闲核心</button>`:''}`;
  return `<section class="research-panel ${state.complete?'researched':''}" data-research-building="${b.id}"><div class="research-heading"><strong>${t.name}</strong><span>${state.complete?'✓ 永久科技':`${t.time} 秒`}</span></div><p>${t.description}</p>${job?`<div class="bar"><i style="width:${(1-job.remaining/job.total)*100}%"></i></div>`:''}<small class="research-status">${state.label}</small>${controls}</section>`;
}
function technologySummary(){
  const list=technologyTypes.map(type=>{const d=BUILDINGS[type],done=world.technologyActive(0,type),job=world.researchInProgress(0,type);return `<span class="technology-chip ${done?'active':''}" title="${d.technology.description}">${done?'✓':job?'◷':'○'} ${d.technology.name}</span>`;}).join('');
  const html=`<div class="technology-summary-heading"><span>全军科技</span><button data-production-tab="technology">研发 ›</button></div><div class="technology-chips">${list}</div>`;
  if($('#technology-summary').innerHTML!==html)$('#technology-summary').innerHTML=html;
}
function selectionUI(force){
  const sel=selected(),e=sel[0],count=sel.length;$('#selection-counter').textContent=`${String(count).padStart(2,'0')} SELECTED`;
  if(!e){$('#selection').innerHTML='';selectionKey='';actionsUI(null,force);return;}
  const key=`${count}:${e.id}:${e.core}:${e.dock}:${e.kind}:${e.type}:${e.team}:${e.serial}`;
  if(key!==selectionKey||force){selectionKey=key;const d=BUILDINGS[e.type]||UNITS[e.type],faction=e.team===1?'敌方 · ':e.team===-1?'中立 · ':'',title=count>1?`${count} 个作战单位`:e.kind==='capture'?'中心据点':e.kind==='core'?e.team===-1?'中立 · 待认领核心':`${faction}能量核心 ${String(e.serial).padStart(2,'0')}`:`${faction}${d.name}`;$('#selection').innerHTML=`<div class="selection-head"><div class="unit-emblem" style="color:${e.team===-1?'#e9c779':d?.color||'#79edcc'}">${count>1?'⬡':icons[e.type]}</div><div class="selection-name">${title}<span class="selection-en">${count>1?'COMBAT GROUP':e.kind==='capture'?'CENTRAL CORE RELAY':d?.en||'INDEPENDENT ENERGY CORE'}</span></div></div><div class="health-row"><span>${e.kind==='capture'?'本轮占领进度':e.kind==='core'?'独立存储 / 无上限':'结构完整度'}</span><span id="selection-hp"></span></div><div class="bar"><i id="selection-health"></i></div><div id="selection-slot"></div><p class="status-line" id="selection-status"></p>`;}
  const hp=sel.reduce((s,e)=>s+e.hp,0),maxHp=sel.reduce((s,e)=>s+e.maxHp,0);$('#selection-hp').textContent=e.kind==='capture'?`${Math.floor(e.progress)} / ${e.duration} 秒`:e.kind==='core'?`${e.energy} E`:`${Math.ceil(hp)} / ${maxHp}`;$('#selection-health').style.width=`${e.kind==='capture'?clamp(e.progress/e.duration,0,1)*100:e.kind==='core'?100:hp/maxHp*100}%`;
  let slot='',status='',warn=false;
  if(count>1)status='';
  else if(e.kind==='capture'){
    slot=`<div class="objective-detail"><strong>${captureStatus(e)} · 剩余 ${fmt(Math.max(0,Math.ceil(e.duration-e.progress)))}</strong><span>圈内兵力：我方 ${e.occupants[0]} / 敌方 ${e.occupants[1]}</span><span>累计核心：我方 +${e.rewards[0]} / 敌方 +${e.rewards[1]}</span></div>`;
    status='';warn=e.contested;
  }else if(e.team===-1&&e.kind==='core'){
    const nearby=world.all(null,'unit').filter(u=>Math.hypot(u.x-e.x,u.y-e.y)<=65),contested=nearby.some(u=>u.team===0)&&nearby.some(u=>u.team===1);
    slot='';status=contested?'争夺中':'';warn=contested;
  }else if(e.team===-1&&e.kind==='building'){
    slot='';status='';
  }
  else if(e.kind==='building'){
    const d=BUILDINGS[e.type],core=world.byId(e.core),site=e.type==='hq'?world.activeConstruction(e):null;
    if(site){warn=site.remaining>0&&(site.paused||!world.constructionHasCore(site)||!site.paidCore);status=site.remaining===0?`${BUILDINGS[site.type].name}已就绪`:site.paused?'建造暂停':!world.constructionHasCore(site)?'缺核心':!site.paidCore?'缺能量':`${BUILDINGS[site.type].name} · ${Math.ceil(site.remaining)}s`;}
    else if(d.technology){status=`已解锁 ${d.unlocks.map(type=>UNITS[type].name).join('/')}`;}
    else if(!e.powered){status='电力不足';warn=true;}
    else if(e.type==='power')status='供电 +36';
    else if(e.type==='tower')status='自动防御';
    else if(!core){status='缺核心';warn=true;}
    else if(e.job&&world.all(e.team,'unit').length>=60){status='60 上限';warn=true;}
    else if(e.job)status=e.job.paused?'已暂停':`${UNITS[e.job.type].name} · ${Math.ceil(e.job.remaining)}s`;
    else if(e.queue.length&&world.all(e.team,'unit').length>=60){status='60 上限';warn=true;}
    else if(e.queue.length&&core.energy<UNITS[e.queue[0]].cost){status=`缺 ${UNITS[e.queue[0]].cost-core.energy} 能量`;warn=true;}
    else status='';
    if(d.acceptsCore)slot=`<div class="slot"><span>${core?`◇ 核心 ${String(core.serial).padStart(2,'0')} · ${core.energy} E`:'◇ 空核心插槽'}</span>${e.team?'':core?`<button data-eject="${core.id}">卸载</button>`:`<button data-choose-core="${e.id}">装载</button>`}</div>`;
    if(d.technology&&!e.construction)slot+=researchPanel(e);
  }else if(e.kind==='core'){const b=world.byId(e.dock),t=world.byId(e.targetDock);slot=`<div class="slot"><span>${b?`已装入${BUILDINGS[b.type].name}`:t?`前往${BUILDINGS[t.type].name}`:'游离核心 · 可以移动'}</span>${b&&e.team===0?`<button data-eject="${e.id}">卸载</button>`:''}</div>`;status=e.team===0?`+${world.config.rate} / 秒`:'敌方核心';}else{const stats=world.unitStats(e);status=`${UNITS[e.type].role} · ${Number(stats.damage.toFixed(1))} 伤害 · ${stats.range} 射程 · ${Number(stats.speed.toFixed(1))} 速度${stats.incomingDamage<1?` · ${Math.round((1-stats.incomingDamage)*100)}% 减伤`:''}${e.orders.length?` · ${e.orders.length} 条指令`:''}`;}
  if(count===1&&e.team===0&&e.kind==='unit')status+=` · ${visionRadius(e)} 视野`;
  if($('#selection-slot').innerHTML!==slot)$('#selection-slot').innerHTML=slot;$('#selection-status').textContent=status;$('#selection-status').classList.toggle('warn',warn);actionsUI(e,force);
}
function actionsUI(e,force){
  const owned=e?.team===0,kind=owned?e.kind:'none',type=owned?e.type:'none';
  const buildings=world.all(0,'building').filter(b=>!b.construction).map(b=>`${b.id}:${b.core}`).join(',');
  const key=`${kind}:${type}:${e?.id}:${!!e?.construction}:${mode?.type}:${buildings}`;
  if(key!==actionKey||force){actionKey=key;let html='';
    if(!e||(owned&&type==='hq')){$('#action-heading').textContent='选择与指挥';html='';}
    else if(e.kind==='capture'){$('#action-heading').textContent='中心据点';html=`<button class="action-wide" data-focus-capture>定位中心据点（C）</button><button class="action-wide" data-command="all">选择全军</button>`;}
    else if(e.team===-1){$('#action-heading').textContent='中立目标';html=`<button class="action-wide" data-command="all">选择全军</button><button class="action-wide" data-select-base>返回建造厂</button>`;}
    else if(!owned){$('#action-heading').textContent='敌方情报';html=`<button class="action-wide" data-select-base>返回建造厂</button>`;}
    else if(e.construction){$('#action-heading').textContent='施工管理';html='<button class="action-wide" data-select-base>前往建造厂 · 管理施工核心</button>';}
    else if(kind==='core'){$('#action-heading').textContent='调度核心';html=world.all(0,'building').filter(b=>!b.construction&&BUILDINGS[b.type].acceptsCore).map(b=>{const d=BUILDINGS[b.type],busy=b.core&&b.core!==e.id,reserved=world.cores(0).some(c=>c.targetDock===b.id&&c.id!==e.id);return `<button class="build-card" data-dock="${b.id}" ${reserved||b.core===e.id?'disabled':''} style="--accent:${d.color}"><span class="card-icon">${icons[b.type]}</span><strong>${d.name}</strong><span class="card-cost">${b.core===e.id?'当前装载':reserved?'插槽已预留':busy?e.dock?'交换核心':'替换核心':d.technology?'接入以研发科技':'装入此建筑'}</span></button>`;}).join('');html+='<button class="action-wide" data-select-base>选择建造厂 · 建造建筑</button>';}
    else if(['barracks','factory'].includes(type)){$('#action-heading').textContent='工厂指挥';html=`<button data-rally="${e.id}">设置集结点</button><button data-show-production="${e.id}">查看独立队列</button>`;}
    else if(kind==='unit'){$('#action-heading').textContent='部队指令';html='<button data-command="attack">⌖ 攻击移动</button><button data-command="stop">□ 停止 / 驻守</button><button data-command="type">选择同类</button><button data-command="waypoints">连续指令</button>';}
    else if(BUILDINGS[type]?.technology){$('#action-heading').textContent='科技建筑';html='<button class="action-wide" data-production-tab="technology">查看科技与研发</button>';}
    else{$('#action-heading').textContent='建筑运行';html=`<button class="action-wide" data-select-base>返回建造厂 · 建造建筑</button>`;}
    const actions=document.querySelector('.actions-section');actions.classList.toggle('is-empty',!html);$('#actions').innerHTML=html;
  }
}
function facilityLabel(b,peers){const list=peers||productionFacilities(world,productionUnits(b.type)[0]);return `${BUILDINGS[b.type].name} ${String(list.indexOf(b)+1).padStart(2,'0')}`;}
function productionUI(){
  for(const tab of document.querySelectorAll('[role="tab"][data-production-tab]')){const active=tab.dataset.productionTab===productionTab;tab.classList.toggle('active',active);tab.setAttribute('aria-selected',String(active));}
  let html='',queue='',facilities=[];
  const buildTab=['buildings','defense','technology'].includes(productionTab),hq=world.base(0),buildJob=hq?.buildJob;
  if(buildTab){
    html=(productionTab==='buildings'?['power','barracks','factory']:productionTab==='technology'?technologyTypes:['tower']).map(type=>{
      const d=BUILDINGS[type],job=buildJob?.type===type?buildJob:null;
      const state=job?job.remaining===0?'就绪 · 点击放置':job.paused?'已暂停 · 点击继续':!world.constructionHasCore(job)?'等待核心':!job.paidCore?'等待能量':`建造中 ${Math.ceil(job.remaining)}s`:`${d.time} 秒`;
      return `<button class="build-card ${job?'active':''} ${world.energyFor(hq)<d.cost&&!job?'unaffordable':''}" data-build="${type}" style="--accent:${d.color}" title="${d.name}：左键生产或放置，右键暂停或取消"><span class="card-icon">${icons[type]}</span><strong>${d.name}</strong><span class="card-cost"><b>◇ ${d.cost}</b><em>ϟ ${d.power<0?'+'+-d.power:'−'+d.power}</em></span><small class="production-state">${state}</small></button>`;
    }).join('');
    if(buildJob){const d=BUILDINGS[buildJob.type],ready=buildJob.remaining===0;
      queue=`<div class="queue-title">${d.name} · ${ready?'就绪':`${Math.ceil(buildJob.remaining)} 秒`}</div><div class="bar"><i style="width:${(1-buildJob.remaining/buildJob.total)*100}%"></i></div><div class="production-controls">${ready?`<button data-build="${buildJob.type}">放置建筑</button>`:`<button data-build-toggle>${buildJob.paused?'继续':'暂停'}</button>`}<button data-build-cancel>取消建造</button></div>`;
    }
    if(productionTab==='technology'){
      for(const type of technologyTypes){const d=BUILDINGS[type],buildings=world.all(0,'building').filter(b=>b.type===type&&!b.construction);
        if(buildings.length)queue+=buildings.map(b=>`<div class="technology-building"><div class="factory-heading"><strong>${d.name} #${b.id}</strong><button data-view-producer="${b.id}">定位</button></div>${researchPanel(b)}</div>`).join('');
        else queue+=`<div class="technology-preview"><strong>${d.technology.name} · ◇ ${d.technology.cost} · ${d.technology.time} 秒</strong><p>${d.technology.description}</p><small>${world.technologyActive(0,type)?'✓ 已研发':'未研发'}</small></div>`;
      }
    }
  }else{
    const type=productionTab==='infantry'?'infantry':'tank',d=UNITS[type],types=productionUnits(d.producer),all=productionFacilities(world,type);
    if(all.length){
      let current=all.find(f=>f.id===facilityPick[productionTab]);
      if(!current){current=all[0];facilityPick[productionTab]=current.id;}
      const tabs=all.length>1?`<div class="factory-tabs" role="tablist" aria-label="选择第几座${BUILDINGS[current.type].name}">${all.map((b,i)=>`<button role="tab" data-factory-tab="${b.id}" aria-selected="${b.id===current.id}" class="${b.id===current.id?'active':''}${b.job||b.queue.length?' busy':''}" aria-label="第 ${i+1} 座${BUILDINGS[b.type].name}">${BUILDINGS[b.type].name} ${String(i+1).padStart(2,'0')}</button>`).join('')}</div>`:'';
      const name=facilityLabel(current,all);
      const unitCards=types.map(unitType=>{const unit=UNITS[unitType];return `<button class="build-card" data-produce="${unitType}" data-producer="${current.id}" aria-label="${name}：生产${unit.name}" title="仅对${name}下单；右键减少同兵种等待订单或暂停 / 取消"><span class="card-icon">${icons[unitType]}</span><strong>${unit.name}</strong><span class="card-cost"><b>◇ ${unit.cost}</b><em>${unit.time} 秒</em></span><small class="production-state" data-factory-unit-state="${unitType}"></small></button>`;}).join('');
      html=tabs+`<section class="factory-production" data-factory="${current.id}" aria-label="${name}独立生产"><div class="factory-heading"><strong>${name}</strong><button data-view-producer="${current.id}" aria-label="定位${name}">定位</button></div><div class="factory-resources"><span data-factory-core=""></span><span data-factory-count=""></span></div><div class="factory-unit-grid">${unitCards}</div><span class="queue-item current" data-factory-current="" hidden></span><div class="queue-items" data-factory-orders=""></div><div class="bar" data-factory-progress="" hidden><i></i></div><div class="production-controls" data-factory-job-controls="" hidden><button data-production-toggle="${current.id}">暂停</button><button data-production-cancel="${current.id}" aria-label="取消${name}当前生产">取消</button></div><p class="queue-progress" data-production-status=""></p><div class="production-controls"><button data-rally="${current.id}">集结点</button></div></section>`;
      facilities=[current];
    }else html=`<p class="hint-box">先在“建筑”栏建造并放置${BUILDINGS[d.producer].name}。</p>`;
  }
  if(pointerOnQueue)return;
  if(renderedProduction!==html){$('#production-actions').innerHTML=html;renderedProduction=html;}
  if(renderedProductionQueue!==queue){$('#production-queue').innerHTML=queue;renderedProductionQueue=queue;}
  for(const b of facilities)updateFactoryPanel(b);
}
function updateFactoryPanel(b){
  const panel=document.querySelector(`[data-factory="${b.id}"]`),name=facilityLabel(b),core=world.byId(b.core);
  panel.classList.toggle('selected',selection.has(b.id));
  panel.querySelector('[data-factory-core]').textContent=core?`◇ ${String(core.serial).padStart(2,'0')} · ${core.energy} E`:'无核心';panel.querySelector('[data-factory-core]').setAttribute('aria-label',core?`核心 ${String(core.serial).padStart(2,'0')} · ${core.energy} 能量`:'该建筑未接入核心');
  panel.querySelector('[data-factory-count]').textContent=`${b.queue.length+(b.job?1:0)} / 8`;panel.querySelector('[data-factory-count]').setAttribute('aria-label',`生产队列 ${b.queue.length+(b.job?1:0)} / 8`);
  for(const button of panel.querySelectorAll('[data-produce]')){
    const type=button.dataset.produce,d=UNITS[type],unlocked=world.unitUnlocked(b.team,type),resuming=b.job?.paused&&b.job.type===type,count=b.queue.filter(t=>t===type).length;
    button.disabled=!unlocked;button.classList.toggle('locked',!unlocked);button.classList.toggle('unaffordable',!!core&&core.energy<d.cost);
    button.querySelector('[data-factory-unit-state]').textContent=!unlocked?`需 ${BUILDINGS[d.requires].name}`:resuming?'已暂停':count?`等待 ×${count}`:'';
    button.setAttribute('aria-label',`${name}：${!unlocked?'需要建成'+BUILDINGS[d.requires].name:resuming?'继续生产'+d.name:'生产'+d.name}`);
  }
  const current=panel.querySelector('[data-factory-current]'),progress=panel.querySelector('[data-factory-progress]'),controls=panel.querySelector('[data-factory-job-controls]');
  current.hidden=progress.hidden=controls.hidden=!b.job;
  if(b.job){current.textContent=`${icons[b.job.type]} ${UNITS[b.job.type].name} · ${Math.ceil(b.job.remaining)}s`;progress.firstElementChild.style.width=`${(1-b.job.remaining/b.job.total)*100}%`;const toggle=controls.querySelector('[data-production-toggle]');toggle.textContent=b.job.paused?'继续':'暂停';toggle.setAttribute('aria-label',`${b.job.paused?'继续':'暂停'}${name}生产`);}
  const orders=panel.querySelector('[data-factory-orders]'),key=b.queue.join(',');
  if(orders.dataset.queueKey!==key){orders.innerHTML=b.queue.map((t,i)=>`<button class="queue-item" data-cancel-order="${i}" data-producer="${b.id}" aria-label="取消${name}的第 ${i+1} 个${UNITS[t].name}等待订单" title="取消${UNITS[t].name}等待订单">${icons[t]} ${UNITS[t].name} ×</button>`).join('');orders.dataset.queueKey=key;}
  panel.querySelector('[data-production-status]').textContent=b.job?.paused?'已暂停':!core?'':!b.powered?'电力不足':world.all(0,'unit').length>=60?'60 上限':b.job?`${UNITS[b.job.type].name} · ${Math.ceil(b.job.remaining)}s`:b.queue.length?core.energy<UNITS[b.queue[0]].cost?`缺 ${UNITS[b.queue[0]].cost-core.energy} 能量`:paused?'已暂停':'队列中':'空闲';
}
$('.production-section').addEventListener('pointerdown',()=>pointerOnQueue=true);document.addEventListener('pointerup',()=>pointerOnQueue=false);document.addEventListener('pointercancel',()=>pointerOnQueue=false);
function updateUI(force=false){
  for(const id of selection)if(!world.canSee(0,world.byId(id)))selection.delete(id);
  $('#fog-enabled').checked=world.config.fog;
  $('#fog-status').textContent=world.config.fog?'迷雾开启':'全图可见';
  objectivesUI();
  technologySummary();
  productionUI();
  const g=world.grid(0);$('#power-stat').innerHTML=`${g.demand} <em>/ ${g.supply}</em>`;$('#power-stat').style.color=g.ok?'':'#fa8b9e';$('#army-stat').innerHTML=`${world.all(0,'unit').length} <em>/ 60</em>`;$('#clock').textContent=fmt(world.time);$('#zoom-label').textContent=`${Math.round(renderer.camera.z*100)}%`;$('#phase-chip').textContent=!started?'待命':world.result?'战斗结束':paused?'已暂停':`${speed}× 作战中`;$('#pause-btn').textContent=paused?'▷':'Ⅱ';$('#pause-btn').setAttribute('aria-label',paused?'继续':'暂停');$('#ai-label').textContent=world.config.ai?`${{easy:'休闲',normal:'标准',hard:'进阶'}[world.config.difficulty]} AI`:'AI 已暂停';coresUI();selectionUI(force);
  const visibleEvents=world.events.filter(event=>world.eventVisible(event));
  if(seenEvent!==visibleEvents[0]){seenEvent=visibleEvents[0];$('#event-log').innerHTML=visibleEvents.slice(0,4).map(e=>`<div class="log-entry ${e.level}"><time>${fmt(e.time)}</time><span>${e.text}</span></div>`).join('');if(seenEvent?.level==='danger')alert(seenEvent.text);}
  if($('#debug-dialog').open)$('#debug-stats').textContent=`时间 ${fmt(world.time)} · 我方 ${world.all(0,'unit').length} 单位 / 敌方 ${world.all(1,'unit').length} 单位 · 电网 ${g.demand}/${g.supply} · ${paused?'已暂停':'运行中'}`;
  if(world.result&&!resultShown)showResult();
}
function showResult(){persistReport(true);resultShown=true;cancelMode();const win=world.result==='victory';$('#result-card').innerHTML=`<span class="eyebrow">${win?'MISSION ACCOMPLISHED':'MISSION FAILED'}</span><h1>${win?'棱镜，照亮胜利。':'基地已失守。'}</h1><p>${win?'敌方建造厂已摧毁，你取得了棱镜盆地的控制权。':'你的建造厂已被摧毁。尝试提前部署防御塔，并让生产建筑持续工作。'}</p><div class="result-numbers"><span><b>${fmt(world.time)}</b><small>作战用时</small></span><span><b>${world.stats[0].kills}</b><small>摧毁目标</small></span><span><b>${world.stats[0].produced}</b><small>生产部队</small></span></div><button class="primary full" id="play-again">再来一局</button><a class="result-lab" href="lab.html#reports" target="prism-lab" data-open-lab>查看本局图表与事件 →</a>`;$('#result-card').hidden=false;$('#play-again').onclick=reset;}

document.addEventListener('click',event=>{
  const b=event.target.closest('button');if(!b)return;
  if(b.dataset.close){$('#'+b.dataset.close).close();return;}
  if(b.hasAttribute('data-focus-capture')){focusCapture();return;}
  if(b.dataset.core){const c=world.byId(Number(b.dataset.core));if(c){select([c.id]);focus(c);toast('已选择核心：点己方建筑装入，或点地面移动');}return;}
  if(b.dataset.productionTab){productionTab=b.dataset.productionTab;updateUI(true);return;}
  if(b.dataset.factoryTab){facilityPick[productionTab]=Number(b.dataset.factoryTab);updateUI(true);return;}
  if(b.dataset.build){startBuild(b.dataset.build);return;}
  if(b.hasAttribute('data-build-toggle')){if(ensureStarted()){world.toggleBuildingPause(0);updateUI(true);}return;}
  if(b.hasAttribute('data-build-cancel')){if(ensureStarted()){world.cancelBuilding(0);if(mode?.kind==='build')cancelMode();toast('建筑已取消，已付能量退回原核心');updateUI(true);}return;}
  if(b.dataset.productionToggle){if(ensureStarted()){world.toggleProductionPause(Number(b.dataset.productionToggle));updateUI(true);}return;}
  if(b.dataset.productionCancel){if(ensureStarted()){world.cancelProduction(Number(b.dataset.productionCancel));toast('当前生产已取消，已付能量退回原核心');updateUI(true);}return;}
  if(b.dataset.research){if(ensureStarted()){const id=Number(b.dataset.research),r=world.research(id);toast(r.ok?'已支付能量并开始研发；请保持核心接入和供电':r.reason);updateUI(true);}return;}
  if(b.dataset.researchToggle){if(ensureStarted()){world.toggleResearchPause(Number(b.dataset.researchToggle));updateUI(true);}return;}
  if(b.dataset.researchCancel){if(ensureStarted()){const cancelled=world.cancelResearch(Number(b.dataset.researchCancel));toast(cancelled?'研发已取消，已付能量退回原核心':'当前没有可取消的研发');updateUI(true);}return;}
  if(b.dataset.showProduction){showProduction(Number(b.dataset.showProduction));return;}
  if(b.dataset.viewProducer){const e=world.byId(Number(b.dataset.viewProducer));if(e){select([e.id]);focus(e);}return;}
  if(b.hasAttribute('data-select-base')){const h=world.base(0);if(h){select([h.id]);focus(h);}return;}
  if(b.dataset.eject){if(!ensureStarted())return;const id=Number(b.dataset.eject),builder=world.byId(world.byId(id)?.dock),site=world.activeConstruction(builder),researching=!!builder?.researchJob;world.undock(id);select([id]);toast(site?.remaining>0?'核心已卸载，建造已暂停；接入建造厂后继续':researching?'核心已卸载，研发暂停且进度保留；重新接入后继续':'核心已卸载，能量保留，已完成科技仍永久生效');return;}
  if(b.dataset.chooseCore){const free=world.cores(0).find(c=>!c.dock&&!c.targetDock);if(free)select([free.id]);else toast('没有空闲核心，请先选择一个已装载的核心再转移');return;}
  if(b.dataset.dock){if(!ensureStarted())return;const c=selected()[0],id=Number(b.dataset.dock);if(c?.kind==='core')assignCore(c.id,id);return;}
  if(b.dataset.produce){produce(Number(b.dataset.producer),b.dataset.produce);return;}
  if(b.hasAttribute('data-cancel-order')){if(ensureStarted()){world.cancelQueued(Number(b.dataset.producer),Number(b.dataset.cancelOrder));updateUI(true);}return;}
  if(b.dataset.rally){if(!ensureStarted())return;setMode({kind:'rally',id:Number(b.dataset.rally)});collapseMobile();return;}
  if(b.dataset.command){if(b.dataset.command==='attack')attackMode();if(b.dataset.command==='all')allArmy();if(b.dataset.command==='stop')stopSelected();if(b.dataset.command==='type')selectType();if(b.dataset.command==='waypoints')waypointMode();}
});
$('.sidebar').addEventListener('contextmenu',event=>{event.preventDefault();const b=event.target.closest('button');if(b?.dataset.build)startBuild(b.dataset.build,true);else if(b?.dataset.produce)produce(Number(b.dataset.producer),b.dataset.produce,true);else cancelField();});
function cancelField(){if(cancelCoreGesture())return;if(mode){cancelMode();updateUI(true);}else select([]);}
$('#start-btn').onclick=start;$('#pause-btn').onclick=togglePause;$('#cancel-mode').onclick=cancelMode;$('#select-army').onclick=allArmy;$('#attack-btn').onclick=attackMode;$('#stop-btn').onclick=stopSelected;$('#deselect-btn').onclick=cancelField;
$('#home-btn').onclick=()=>focus(world.base(0));$('#overview-btn').onclick=()=>{renderer.overview();collapseMobile();updateUI(true);};$('#zoom-in').onclick=()=>renderer.zoom(1.2);$('#zoom-out').onclick=()=>renderer.zoom(1/1.2);$('#panel-toggle').onclick=()=>{$('.sidebar').classList.toggle('expanded');$('#panel-toggle').textContent=$('.sidebar').classList.contains('expanded')?'⌄':'⌃';};
$('#help-btn').onclick=()=>{if(started)paused=true;$('#help-dialog').showModal();updateUI(true);};
function syncOrientationButton(){const locked=!!document.fullscreenElement,button=$('#orientation-btn');button.textContent=locked?'⤡':'⛶';button.setAttribute('aria-pressed',String(locked));button.title=locked?'退出全屏横屏':'全屏横屏（锁定方向）';button.setAttribute('aria-label',locked?'退出全屏横屏':'全屏横屏并锁定方向');}
async function toggleOrientationLock(){
  if(document.fullscreenElement){try{await document.exitFullscreen();}catch{}return;}
  try{await document.documentElement.requestFullscreen({navigationUI:'hide'});}catch{toast('浏览器拒绝了全屏请求，请关闭系统自动旋转后横握手机');return;}
  // Orientation lock only applies while fullscreen; browsers without the API stay in fullscreen.
  try{if(!screen.orientation?.lock)throw new Error('unsupported');await screen.orientation.lock('landscape');toast('已进入全屏并锁定横屏，再点一次退出');}
  catch{toast('已进入全屏；此浏览器不支持锁定屏幕方向，请关闭系统自动旋转');}
}
document.addEventListener('fullscreenchange',syncOrientationButton);
$('#orientation-btn').onclick=toggleOrientationLock;syncOrientationButton();
$('#debug-btn').onclick=()=>{$('#debug-core').innerHTML=world.cores(0).map(c=>`<option value="${c.id}">核心 ${String(c.serial).padStart(2,'0')}</option>`).join('');$('#debug-dialog').showModal();updateUI(true);};
$('#game-speed').onchange=e=>speed=Number(e.target.value);$('#energy-rate').onchange=e=>{const n=Number(e.target.value);world.config.rate=clamp(Number.isFinite(n)?Math.round(n):world.balance.economy.rate,0,100);e.target.value=world.config.rate;markDebug(`核心产能改为 ${world.config.rate}/秒`);updateUI(true);};$('#ai-enabled').onchange=e=>{world.config.ai=e.target.checked;markDebug(`AI ${world.config.ai?'开启':'关闭'}`);};$('#god-mode').onchange=e=>{world.config.invincible=e.target.checked;markDebug(`我方无敌${world.config.invincible?'开启':'关闭'}`);};
$('#fog-enabled').onchange=e=>{world.config.fog=e.target.checked;renderer.hover=null;markDebug(`战争迷雾${world.config.fog?'开启':'关闭（全图可见）'}`);updateUI(true);};
$('#add-energy').onclick=()=>{const c=world.byId(Number($('#debug-core').value));if(c){c.energy+=500;markDebug(`核心 ${c.serial} 增加 500 能量`);toast(`核心 ${c.serial} 已增加 500 能量`);updateUI(true);}};$('#empty-energy').onclick=()=>{const c=world.byId(Number($('#debug-core').value));if(c){c.energy=0;markDebug(`核心 ${c.serial} 能量清空`);toast(`核心 ${c.serial} 能量已归零`);updateUI(true);}};
function spawn(type,count,team=0){if(!ensureStarted())return;const h=world.base(team);if(!h)return;const units=[];for(let i=0;i<count&&world.all(team,'unit').length<60;i++){const u=world.addUnit(type,team,h.x+(team?-120:120)+(i%3)*46,h.y+120+Math.floor(i/3)*46);if(u)units.push(u);}if(team){const t=world.base(0);if(t)world.command(units.map(u=>u.id),t.x,t.y,t.id,true);}else select(units.map(u=>u.id));markDebug(`生成 ${units.length} 个${team?'敌方':'我方'}${UNITS[type].name}`);toast(`已生成 ${units.length} 个${team?'敌方':'我方'}${UNITS[type].name}`);updateUI(true);}
$('#spawn-infantry').onclick=()=>spawn('infantry',5);$('#spawn-tank').onclick=()=>spawn('tank',2);$('#spawn-enemy').onclick=()=>spawn('infantry',3,1);$('#debug-unit').innerHTML=Object.entries(UNITS).map(([type,d])=>`<option value="${type}">${d.name}</option>`).join('');$('#spawn-selected').onclick=()=>spawn($('#debug-unit').value,2);$('#export-state').onclick=()=>{const url=URL.createObjectURL(new Blob([JSON.stringify({...world.snapshot(),paused,speed,selected:[...selection]},null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=`prism-battle-${Math.floor(world.time)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('战场状态已导出');};$('#restart-btn').onclick=reset;

function issueCommand(ids,p,targetId,attackMove,append){
  const result=world.command(ids,p.x,p.y,targetId,attackMove,append);
  if(!result.ok)toast(result.reason);
  else if(result.rejected)toast(`${result.accepted} 个单位接受指令，${result.rejected} 个无法到达或队列已满`);
  else if(result.adjusted)toast('目标不可通行，已选择附近陆地');
  else if(result.queued)toast(`已追加后续指令 · Shift 可继续添加`);
  else if(paused)toast('指令已记录，继续战斗后执行');
  updateUI(true);
}
function setRally(b,p){
  if(!b)return false;
  const radius=Math.max(...productionUnits(b.type).map(type=>UNITS[type].r));
  const dest=world.freePosition(p.x,p.y,radius),origin=world.freePosition(b.x+(b.team?-1:1)*(b.r+34),b.y+35,radius);
  if(!dest||!origin||!world.findPath({...origin,r:radius},dest).length){toast('无法到达此集结点，请选择相连的陆地');return false;}
  b.rally=dest;world.effects.push({type:'order',...dest,life:1.2,max:1.2});toast('集结点已更新');return true;
}
function assignCore(coreId,buildingId){
  const result=world.assign(coreId,buildingId,{swap:true});
  toast(!result.ok?result.reason:result.swapped?result.sourceId?'交换指令已下达，两个核心正在互换建筑':'核心正在接入，原核心已卸到建筑旁':'核心正在前往目标建筑');
  if(result.ok){select([buildingId]);collapseMobile();}
  return result;
}
function fieldClick(sx,sy,right=false,shift=false){
  if(right){cancelField();return;}
  if(!ensureStarted())return;
  const p=renderer.world(sx,sy),hit=renderer.hit(sx,sy),sel=selected(),action=fieldAction({mode,selection:sel,hit,shift});
  if(action.kind==='build'){const result=world.deployBuilding(0,mode.type,p.x,p.y);if(result.ok){cancelMode();toast('建筑已放置并开始运行');updateUI(true);}else toast(result.reason);return;}
  if(action.kind==='rally'){if(setRally(action.building||world.byId(mode?.id),p)&&mode?.kind==='rally')cancelMode();return;}
  if(action.kind==='attack'||action.kind==='waypoints'){
    if(hit?.kind==='core'&&hit.team===1){toast('核心不能被武器攻击');return;}
    issueCommand(sel.filter(e=>e.team===0&&e.kind==='unit').map(e=>e.id),hit?.kind==='core'&&hit.team===-1?hit:p,action.targetId,action.kind==='attack',shift||action.kind==='waypoints');if(action.kind==='attack'&&!shift)cancelMode();return;
  }
  if(action.kind==='dock'){assignCore(action.core.id,action.building.id);return;}
  if(action.kind==='select'){select([action.entity.id],action.append,action.append);return;}
  if(action.kind==='protected-core'){toast('核心不能被武器攻击');return;}
  if(action.kind==='cannot-attack'){toast('能量核心没有攻击能力');return;}
  if(action.kind==='cannot-collect'){toast('请派作战部队靠近拾取，能量核心不能认领其他核心');return;}
  if(action.kind==='cannot-capture'){toast('只有作战部队能占领据点，能量核心不计入占领');return;}
  if(action.kind==='command'){issueCommand(action.movers.map(e=>e.id),hit?.kind==='core'&&hit.team===-1?hit:p,action.targetId,false,shift);return;}
  select([]);
}
const pointers=new Map(),cameraKeys=new Set();let gesture=null,pinch=null,multiTouch=false,hoverPosition=null,coreHoldTimer=null;
function pos(e){const r=canvas.getBoundingClientRect();return{x:e.clientX-r.left,y:e.clientY-r.top};}
function clearCorePreview(){clearTimeout(coreHoldTimer);coreHoldTimer=null;renderer.coreHold=null;renderer.coreDrag=null;$('#core-drag-status').hidden=true;}
function cancelCoreGesture(){
  if(!gesture?.coreCandidate&&!gesture?.coreActive)return false;
  clearCorePreview();gesture=null;renderer.box=null;canvas.style.cursor='default';return true;
}
function activateCoreGesture(){
  const g=gesture,c=world.byId(g?.coreCandidate);
  if(!g||!c||!started||world.result||(g.holdRequired&&c.dock!==g.sourceId)){clearCorePreview();return false;}
  clearTimeout(coreHoldTimer);coreHoldTimer=null;g.coreActive=true;g.box=false;renderer.box=null;renderer.coreHold=null;
  select([c.id]);canvas.style.cursor='grabbing';
  $('#core-drag-status').hidden=false;
  updateCorePreview(g.last,true);
  return true;
}
function updateCorePreview(p,force=false){
  if(!gesture?.coreActive)return;
  if(!world.byId(gesture.coreCandidate)||world.result){cancelCoreGesture();return;}
  const previous=renderer.coreDrag,now=performance.now();
  if(!force&&previous&&now-previous.updatedAt<70){previous.pointer=p;return;}
  const inside=p.x>=0&&p.y>=0&&p.x<=renderer.width&&p.y<=renderer.height;
  const point=renderer.world(p.x,p.y),hit=inside?renderer.hit(p.x,p.y):null;
  const preview=inside?previewCoreDrop(world,gesture.coreCandidate,point,hit):{ok:false,label:'移回战场后松手，或取消调度'};
  renderer.coreDrag={coreId:gesture.coreCandidate,pointer:p,preview,updatedAt:now};
  const core=world.byId(gesture.coreCandidate),text=`核心 ${String(core.serial).padStart(2,'0')} · ${gesture.drag?preview.label:'已抓取 · 拖动调度，原地松开仅选中'} · ${gesture.pointerType==='mouse'?'右键 / Esc':'双指'}取消`;
  const status=$('#core-drag-status');if(status.textContent!==text)status.textContent=text;status.dataset.valid=String(preview.ok);
}
function updateCoreGesture(dt){
  if(!gesture?.coreActive)return;
  const p=gesture.last;
  if(gesture.drag&&p.x>=0&&p.y>=0&&p.x<=renderer.width&&p.y<=renderer.height){
    const edge=28,dx=p.x<edge?1-p.x/edge:p.x>renderer.width-edge?-(p.x-renderer.width+edge)/edge:0,dy=p.y<edge?1-p.y/edge:p.y>renderer.height-edge?-(p.y-renderer.height+edge)/edge:0;
    if(dx||dy)renderer.pan(dx*320*dt,dy*320*dt);
  }
  updateCorePreview(p);
}
function updateHover(){
  if(!hoverPosition)return;
  const p=hoverPosition,w=renderer.world(p.x,p.y);renderer.hover=renderer.hit(p.x,p.y);renderer.groundHover=w;
  if(mode?.kind==='build'){const placement=world.placement(0,mode.type,w.x,w.y);renderer.placement={...w,type:mode.type,...placement};}
  const action=fieldAction({mode,selection:selected(),hit:renderer.hover});
  canvas.style.cursor=gesture?.coreActive?'grabbing':gesture?.drag&&!gesture.box?'grabbing':['protected-core','cannot-attack','cannot-collect','cannot-capture'].includes(action.kind)||(action.kind==='dock'&&!BUILDINGS[action.building.type].acceptsCore)?'not-allowed':['build','attack','waypoints','command','rally'].includes(action.kind)?'crosshair':renderer.hover?'pointer':'default';
}
canvas.addEventListener('contextmenu',e=>{e.preventDefault();cancelCoreGesture();});
canvas.addEventListener('pointerdown',e=>{
  e.preventDefault();if(e.button===2&&cancelCoreGesture())return;
  canvas.setPointerCapture(e.pointerId);const p=pos(e);pointers.set(e.pointerId,p);
  if(pointers.size===2){multiTouch=true;const[a,b]=[...pointers.values()];pinch={d:Math.hypot(a.x-b.x,a.y-b.y),x:(a.x+b.x)/2,y:(a.y+b.y)/2};clearCorePreview();renderer.box=null;gesture=null;hoverPosition=null;return;}
  const mouse=e.pointerType==='mouse';
  const hit=renderer.hit(p.x,p.y),core=started&&!world.result&&!mode&&e.button===0?coreFromHit(world,hit):null;
  gesture={id:e.pointerId,start:p,last:p,drag:false,button:e.button,box:mouse&&e.button===0&&!mode,shift:e.shiftKey,pointerType:e.pointerType,coreCandidate:core?.id,sourceId:core?.dock,holdRequired:hit?.kind==='building',coreActive:false};
  if(core){renderer.coreHold={coreId:core.id,entityId:hit.id,startedAt:performance.now(),duration:CORE_HOLD_MS};coreHoldTimer=setTimeout(activateCoreGesture,CORE_HOLD_MS);}
});
canvas.addEventListener('pointermove',e=>{
  // A second mouse button changes buttons on pointermove rather than producing
  // another pointerdown while the primary button is held.
  if((e.buttons&2)&&(gesture?.coreCandidate||gesture?.coreActive)){cancelCoreGesture();return;}
  const p=pos(e);if(e.pointerType==='mouse'){hoverPosition=p;updateHover();}
  if(!pointers.has(e.pointerId))return;pointers.set(e.pointerId,p);
  if(pointers.size>=2){const[a,b]=[...pointers.values()],d=Math.hypot(a.x-b.x,a.y-b.y),x=(a.x+b.x)/2,y=(a.y+b.y)/2;if(pinch){renderer.zoom(d/Math.max(1,pinch.d),x,y);renderer.pan(x-pinch.x,y-pinch.y);}pinch={d,x,y};return;}
  if(!gesture||multiTouch)return;
  if(Math.hypot(p.x-gesture.start.x,p.y-gesture.start.y)>(e.pointerType==='mouse'?5:9)){
    if(gesture.coreCandidate&&!gesture.coreActive){
      if(!gesture.holdRequired)activateCoreGesture();
      else{clearCorePreview();gesture.coreCandidate=null;}
    }
    gesture.drag=true;
  }
  if(gesture.coreActive){gesture.last=p;updateCorePreview(p);return;}
  if(gesture.drag){if(gesture.box)renderer.box={x1:gesture.start.x,y1:gesture.start.y,x2:p.x,y2:p.y};else renderer.pan(p.x-gesture.last.x,p.y-gesture.last.y);}
  gesture.last=p;
});
function pointerEnd(e,cancelled=false){
  const p=pos(e);pointers.delete(e.pointerId);
  if(multiTouch){if(!pointers.size){multiTouch=false;pinch=null;gesture=null;}return;}
  if(gesture?.id===e.pointerId&&!cancelled){
    if(gesture.coreActive){
      if(gesture.drag){updateCorePreview(p,true);const {preview,coreId}=renderer.coreDrag||{};
        if(!preview?.ok)toast(preview?.label||'调度已取消');
        else if(preview.kind==='dock')assignCore(coreId,preview.buildingId);
        else if(preview.kind==='move')issueCommand([coreId],preview.point,null,false,false);
      }
    }
    else if(gesture.drag&&gesture.box){const b=renderer.box;if(b&&started&&!world.result){select(world.all(0,'unit').filter(e=>{const p=renderer.screen(e.x,e.y);return p.x>=Math.min(b.x1,b.x2)&&p.x<=Math.max(b.x1,b.x2)&&p.y>=Math.min(b.y1,b.y2)&&p.y<=Math.max(b.y1,b.y2);}).map(e=>e.id),gesture.shift);}}
    else if(!gesture.drag&&gesture.button!==1)fieldClick(p.x,p.y,gesture.button===2,gesture.shift);
  }
  clearCorePreview();renderer.box=null;gesture=null;updateHover();
}
canvas.addEventListener('pointerup',e=>pointerEnd(e));canvas.addEventListener('pointercancel',e=>pointerEnd(e,true));canvas.addEventListener('wheel',e=>{e.preventDefault();const p=pos(e);renderer.zoom(Math.exp(-e.deltaY*.0014),p.x,p.y);},{passive:false});
canvas.addEventListener('lostpointercapture',e=>{if(pointers.has(e.pointerId))pointerEnd(e,true);});
canvas.addEventListener('pointerleave',()=>{hoverPosition=null;renderer.hover=null;renderer.groundHover=null;if(!gesture)renderer.placement=null;});
canvas.addEventListener('dblclick',e=>{if(!started||mode||e.button!==0)return;const p=pos(e),hit=renderer.hit(p.x,p.y);if(hit?.team===0&&hit.kind==='unit')select(world.all(0,'unit').filter(u=>u.type===hit.type&&renderer.visible(u.x,u.y,0)).map(u=>u.id),e.shiftKey);else if(hit?.team===0&&['barracks','factory'].includes(hit.type))showProduction(hit.id);});
$('#minimap').addEventListener('contextmenu',e=>e.preventDefault());$('#minimap').addEventListener('pointerdown',e=>{e.preventDefault();if(e.button===2){cancelField();return;}if(e.button!==0)return;const r=e.target.getBoundingClientRect();renderer.camera.x=(e.clientX-r.left)/r.width*MAP.w;renderer.camera.y=(e.clientY-r.top)/r.height*MAP.h;renderer.clampCamera();});
document.addEventListener('keydown',e=>{if(/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)||document.querySelector('dialog[open]'))return;const k=e.key.toLowerCase();if(['arrowup','arrowdown','arrowleft','arrowright'].includes(k)){e.preventDefault();cameraKeys.add(k);return;}if(e.repeat||e.ctrlKey||e.metaKey||e.altKey)return;if(k==='escape'){if(!cancelCoreGesture())cancelMode();return;}if(gesture?.coreActive)return;if(k===' '){e.preventDefault();togglePause();return;}if(k==='f')allArmy();if(k==='a')attackMode();if(k==='s')stopSelected();if(k==='h')$('#home-btn').click();if(k==='c')focusCapture();if(k==='+'||k==='=')renderer.zoom(1.15);if(k==='-')renderer.zoom(1/1.15);});
document.addEventListener('keyup',e=>cameraKeys.delete(e.key.toLowerCase()));
window.addEventListener('blur',()=>{clearCorePreview();cameraKeys.clear();pointers.clear();gesture=null;pinch=null;multiTouch=false;renderer.box=null;hoverPosition=null;renderer.hover=null;renderer.groundHover=null;});
document.addEventListener('visibilitychange',()=>{if(document.hidden){cancelCoreGesture();if(started&&!world.result){paused=true;accumulator=0;}persistReport(true);}});
window.addEventListener('pagehide',()=>persistReport(true));
window.addEventListener('storage',event=>{if([BALANCE_KEY,MAP_KEY,null].includes(event.key)){updateBalanceNotice();toast('实验室配置已更新，下局开始时应用。');}});
window.addEventListener('focus',updateBalanceNotice);
document.addEventListener('click',event=>{if(event.target.closest('#open-lab,[data-open-lab]')){if(started)paused=true;persistReport(true);updateUI(true);}});
$('#export-report').onclick=()=>{if(!started){toast('请先开始一局作战以记录图表。');return;}const report=recorder.toJSON(world);downloadJSON(report,`prism-match-${report.matchId}.json`);toast('已导出本局历史、配置和调试标记');};
window.addEventListener('resize',()=>{$('.sidebar').scrollTop=0;});

if(document.modelContext?.registerTool){const lifetime=new AbortController();const definitions=[{name:'read_battle_state',title:'读取战场状态',description:'Read the local RTS simulation, individual core energy, power and selected units.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,untrustedContentHint:false},execute:()=>({...world.snapshot(),paused,speed,selection:[...selection]})},{name:'set_battle_paused',title:'暂停或继续战斗',description:'Pause or resume the already started local battle, using the same control as the pause button.',inputSchema:{type:'object',properties:{paused:{type:'boolean'}},required:['paused'],additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:false},execute:input=>{if(typeof input?.paused!=='boolean')throw new Error('paused must be boolean');if(!started||world.result)throw new Error('No active battle');paused=input.paused;updateUI(true);return{paused};}}];for(const d of definitions){try{Promise.resolve(document.modelContext.registerTool(d,{signal:lifetime.signal})).catch(()=>{});}catch{}}window.addEventListener('pagehide',()=>lifetime.abort(),{once:true});}
let previous=performance.now();
function frame(now){const dt=Math.min(.1,(now-previous)/1000);previous=now;if(cameraKeys.size&&!document.querySelector('dialog[open]')){const dx=Number(cameraKeys.has('arrowleft'))-Number(cameraKeys.has('arrowright')),dy=Number(cameraKeys.has('arrowup'))-Number(cameraKeys.has('arrowdown')),length=Math.hypot(dx,dy)||1;renderer.pan(dx/length*520*dt,dy/length*520*dt);}if(started&&!paused&&!world.result){accumulator+=dt*speed;let steps=0;while(accumulator>=1/30&&steps++<16){world.update(1/30);recorder.update(world);accumulator-=1/30;}}persistReport();updateCoreGesture(dt);updateHover();renderer.draw(dt);if(now-lastUI>160){updateUI();lastUI=now;}requestAnimationFrame(frame);}
$('#energy-rate').value=world.config.rate;updateBalanceNotice();updateUI(true);requestAnimationFrame(frame);
