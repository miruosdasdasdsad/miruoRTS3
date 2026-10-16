import { spawn } from 'node:child_process';
import { writeFile, realpath, rm } from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';

const root = process.cwd(), output = path.resolve(root, '.verification'), profile = path.join(output, 'chrome-map-profile');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const server = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, PORT: '4175' }, windowsHide: true, stdio: 'ignore' });
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--remote-debugging-port=9224', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
let socket, cdp, evaluate, latest;
const checks = [], screenshots = [], errors = [];
const log = (event, data = {}) => console.log(JSON.stringify({ event, ...data }));
try {
  let tabs;
  for (let i = 0; i < 50; i++) {
    try { tabs = await (await fetch('http://127.0.0.1:9224/json/list')).json(); if (tabs.some(t => t.type === 'page')) break; } catch {}
    await wait(200);
  }
  assert.ok(tabs?.length, 'isolated Chrome available');
  socket = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  const pending = new Map(); let next = 0;
  socket.addEventListener('message', event => {
    const m = JSON.parse(event.data);
    if (m.id) { const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = ++next; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  evaluate = async expression => {
    const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const click = selector => evaluate(`(() => {const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw new Error('Unavailable '+${JSON.stringify(selector)});e.click();return true;})()`);
  const state = async () => latest = await evaluate('window.__qaTools.read_battle_state.execute()');
  const pause = paused => evaluate(`window.__qaTools.set_battle_paused.execute({paused:${paused}})`);
  const until = async (predicate, label, limit = 20000) => {
    const end = Date.now() + limit;
    while (Date.now() < end) { const s = await state(); if (predicate(s)) return s; await wait(120); }
    throw new Error(`Timeout: ${label}`);
  };
  const shot = async name => {
    await wait(180);
    const result = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(path.join(output, name), Buffer.from(result.data, 'base64')); screenshots.push(name);
  };
  const canvasClick = async (worldX, worldY, cameraX, cameraY, zoom) => {
    const p = await evaluate(`(() => {const r=document.querySelector('#game').getBoundingClientRect();return{x:r.x+r.width/2+(${worldX}-${cameraX})*${zoom},y:r.y+r.height/2+(${worldY}-${cameraY})*${zoom}};})()`);
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p });
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...p, button: 'left', clickCount: 1 });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p, button: 'left', clickCount: 1 });
  };
  const overview = async () => {
    await click('#overview-btn');
    return evaluate("(()=>{const r=document.querySelector('#game').getBoundingClientRect();return Math.min(.66,r.width/3600*.92,r.height/2400*.92);})()");
  };
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: "window.__qaTools={};Object.defineProperty(document,'modelContext',{value:{registerTool(tool){window.__qaTools[tool.name]=tool;}}});" });
  await cdp('Page.navigate', { url: 'http://127.0.0.1:4175/' });
  for (let i = 0; i < 60; i++) { if (await evaluate('!!window.__qaTools?.read_battle_state')) break; await wait(100); }
  await click('#start-btn'); await click('#debug-btn');
  await evaluate("document.querySelector('#ai-enabled').checked=false;document.querySelector('#ai-enabled').dispatchEvent(new Event('change'));document.querySelector('#game-speed').value='4';document.querySelector('#game-speed').dispatchEvent(new Event('change'));");
  await click('#spawn-infantry'); await click('[data-close="debug-dialog"]');
  let s = await state(); assert.equal(s.config.rate, 6); assert.equal(s.selection.length, 5); assert.equal(s.map.w, 3600); assert.equal(s.map.h, 2400);
  const selectedArmy = [...s.selection], cache = s.entities.find(e => e.type === 'cache' && e.x === 1100 && e.y === 600);
  assert.ok(cache); let zoom = await overview(); assert.deepEqual((await state()).selection, selectedArmy);
  await shot('objectives-overview-desktop.png'); checks.push('full map overview preserves selected army');
  await canvasClick(cache.x, cache.y, 1800, 1200, zoom);
  await until(s => s.entities.filter(e => selectedArmy.includes(e.id)).every(e => e.target === cache.id), 'canvas cache attack accepted');
  s = await until(s => !s.entities.some(e => e.id === cache.id), 'cache destroyed', 22000);
  const neutral = s.entities.find(e => e.kind === 'core' && e.team === -1);
  assert.ok(neutral, 'destroyed cache drops an unclaimed core'); assert.equal(neutral.energy, 0);
  await wait(500); assert.equal((await state()).entities.find(e => e.id === neutral.id).energy, 0);
  checks.push('manual attack destroys cache; unclaimed core stays neutral with zero income'); log('cache-destroyed', { simulationTime: s.time, neutralCore: neutral.id });
  await canvasClick(neutral.x, neutral.y, 1800, 1200, zoom);
  s = await until(s => s.entities.find(e => e.id === neutral.id)?.team === 0, 'loot collected');
  assert.equal(s.entities.filter(e => e.kind === 'core' && e.team === 0).length, 4);
  await until(asyncState => asyncState.entities.find(e => e.id === neutral.id).energy > 0, 'recovered core generates income');
  assert.equal(await evaluate('document.querySelectorAll("#cores .core-card").length'), 4);
  checks.push('moving troops to dropped core claims it and adds fourth producing core card'); log('core-recovered', { simulationTime: s.time, cores: 4 });

  await click('[role="tab"][data-production-tab="buildings"]'); await click('[data-build="barracks"]');
  await until(s => s.entities.find(e => e.team === 0 && e.type === 'hq').buildJob?.remaining === 0, 'barracks ready');
  await click('[data-build="barracks"]'); await click('#home-btn');
  await canvasClick(700, 1200, 420, 1200, zoom);
  s = await until(s => s.entities.some(e => e.team === 0 && e.type === 'barracks'), 'barracks placed');
  const barracks = s.entities.find(e => e.team === 0 && e.type === 'barracks');
  await click(`[data-core="${neutral.id}"]`); await click(`[data-dock="${barracks.id}"]`);
  await until(s => s.entities.find(e => e.id === neutral.id).dock === barracks.id, 'recovered core docked in barracks');
  checks.push('recovered core can be assigned through UI to a constructed barracks');
  await click('#select-army'); const beforeFocus = (await state()).selection;
  await click('#capture-hud'); assert.deepEqual((await state()).selection, beforeFocus);
  await canvasClick(1800, 1200, 1800, 1200, zoom);
  s = await until(s => s.capturePoint.owner === 0 && s.capturePoint.progress > 5, 'central control captured', 22000);
  log('central-captured', { simulationTime: s.time, progress: s.capturePoint.progress, occupants: s.capturePoint.occupants });
  await pause(true); const pausedProgress = (await state()).capturePoint.progress;
  await wait(1200); assert.equal((await state()).capturePoint.progress, pausedProgress);
  checks.push('HUD focuses without changing army selection; troop occupation starts countdown; pause freezes it');
  for (let i = 0; i < 3; i++) await click('#zoom-in');
  await shot('objectives-central-controlled-desktop.png');
  await pause(false);
  let nextLog = Date.now() + 15000;
  const waitForReward = async reward => {
    const end = Date.now() + 60000;
    while (Date.now() < end) {
      const s = await state();
      if (s.capturePoint.rewards[0] >= reward) return s;
      if (Date.now() >= nextLog) { log('holding-central', { simulationTime: s.time, progress: Math.round(s.capturePoint.progress), rewards: s.capturePoint.rewards[0] }); nextLog = Date.now() + 15000; }
      await wait(180);
    }
    throw new Error(`Timed out waiting for naturally simulated reward ${reward}`);
  };
  s = await waitForReward(1); assert.equal(s.entities.filter(e => e.kind === 'core' && e.team === 0).length, 5);
  log('first-central-reward', { simulationTime: s.time, cores: 5, progressReset: s.capturePoint.progress });
  s = await waitForReward(2); assert.equal(s.entities.filter(e => e.kind === 'core' && e.team === 0).length, 6);
  log('second-central-reward', { simulationTime: s.time, cores: 6, progressReset: s.capturePoint.progress });
  checks.push('two successive natural 180-second occupation cycles award fifth and sixth cores without fast-forward or private state mutation');
  await pause(true); await wait(180);
  assert.equal(await evaluate('document.querySelectorAll("#cores .core-card").length'), 6);
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await wait(300); await click('#capture-hud');
  assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true);
  await shot('objectives-mobile-hud.png');
  // Clear the army, then click an unoccupied part of the relay ring to inspect objective details.
  await click('#deselect-btn');
  const mobileZoom = await evaluate("Number(document.querySelector('#zoom-label').textContent.replace('%',''))/100");
  await canvasClick(1800, 1310, 1800, 1200, mobileZoom);
  s = await state(); assert.ok(s.selection.includes(s.capturePoint.id), 'objective selected from its clear ring');
  await wait(200);
  assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true);
  await shot('objectives-mobile-details.png');
  await evaluate("document.querySelector('.core-section').scrollIntoView({block:'center'});");
  await shot('objectives-mobile-six-cores.png');
  assert.equal(await evaluate('document.querySelectorAll("#cores .core-card").length'), 6);
  assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true);
  checks.push('390×844 mobile HUD, objective details and six core cards show without horizontal overflow');
  assert.deepEqual(errors, [], 'no runtime exceptions'); checks.push('no runtime exceptions');
  s = await state();
  const report = { passed: true, checks, screenshots, capturePoint: s.capturePoint, cores: s.entities.filter(e => e.kind === 'core' && e.team === 0).map(e => ({ id: e.id, serial: e.serial, energy: e.energy, dock: e.dock })), simulationTime: s.time, errors };
  await writeFile(path.join(output, 'objectives-browser-report.json'), JSON.stringify(report, null, 2)); log('complete', report);
} catch (error) {
  const report = { passed: false, message: error.message, checks, screenshots, errors, lastState: latest };
  await writeFile(path.join(output, 'objectives-browser-report.json'), JSON.stringify(report, null, 2));
  if (cdp) { try { const r = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); await writeFile(path.join(output, 'objectives-browser-failure.png'), Buffer.from(r.data, 'base64')); } catch {} }
  log('failed', { message: error.message, checks, errors }); process.exitCode = 1;
} finally {
  if (cdp) { try { await cdp('Browser.close'); } catch {} }
  socket?.close(); chrome.kill(); server.kill();
  await wait(500);
  const resolvedOutput = await realpath(output), resolvedProfile = await realpath(profile).catch(() => null);
  if (resolvedProfile && resolvedProfile === path.join(resolvedOutput, 'chrome-map-profile')) {
    await rm(resolvedProfile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
}
