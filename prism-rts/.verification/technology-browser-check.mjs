import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';

const root = process.cwd(), output = path.join(root, '.verification');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const server = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, PORT: '4175' }, windowsHide: true, stdio: 'ignore' });
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=9223', `--user-data-dir=${path.join(output, 'chrome-tech-profile')}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
let socket;
try {
  let tabs;
  for (let i = 0; i < 50; i++) {
    try { tabs = await (await fetch('http://127.0.0.1:9223/json/list')).json(); if (tabs.some(t => t.type === 'page')) break; } catch {}
    await wait(200);
  }
  assert.ok(tabs?.length, 'Chrome debugging endpoint available');
  socket = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  const pending = new Map(), errors = []; let next = 0;
  socket.addEventListener('message', event => {
    const m = JSON.parse(event.data);
    if (m.id) { const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  const cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = ++next; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => {
    const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const click = selector => evaluate(`(() => {const e=document.querySelector(${JSON.stringify(selector)}); if(!e||e.disabled)throw new Error('Unavailable: '+${JSON.stringify(selector)});e.click();return true;})()`);
  const state = () => evaluate('window.__qaTools.read_battle_state.execute()');
  const until = async (predicate, message, limit = 15000) => {
    const end = Date.now() + limit;
    while (Date.now() < end) { const s = await state(); if (predicate(s)) return s; await wait(120); }
    throw new Error(`Timeout: ${message}`);
  };
  const screenshot = async name => { const result = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); await writeFile(path.join(output, name), Buffer.from(result.data, 'base64')); };
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  // Capture the game's existing diagnostic interfaces, without exposing or changing simulation internals.
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: "window.__qaTools={};Object.defineProperty(document,'modelContext',{value:{registerTool(tool){window.__qaTools[tool.name]=tool;}}});" });
  await cdp('Page.navigate', { url: 'http://127.0.0.1:4175/' });
  for (let i = 0; i < 60; i++) { if (await evaluate('!!window.__qaTools?.read_battle_state')) break; await wait(100); }
  assert.deepEqual(errors, [], 'initial runtime errors');
  await click('#start-btn'); await click('#debug-btn');
  await evaluate("document.querySelector('#ai-enabled').checked=false;document.querySelector('#ai-enabled').dispatchEvent(new Event('change'));document.querySelector('#game-speed').value='4';document.querySelector('#game-speed').dispatchEvent(new Event('change'));document.querySelector('#energy-rate').value='100';document.querySelector('#energy-rate').dispatchEvent(new Event('change'));");
  await click('[data-close="debug-dialog"]');
  const place = async (type, tab, x, y) => {
    await click(`[role="tab"][data-production-tab="${tab}"]`); await click(`[data-build="${type}"]`);
    await until(s => s.entities.find(e => e.team === 0 && e.type === 'hq').buildJob?.remaining === 0, `${type} ready`);
    await click(`[data-build="${type}"]`); await click('#home-btn');
    const p = await evaluate(`(() => {const r=document.querySelector('#game').getBoundingClientRect();const z=Number(document.querySelector('#zoom-label').textContent.replace('%',''))/100;return {x:r.x+r.width/2+(${x}-370)*z,y:r.y+r.height/2+(${y}-800)*z};})()`);
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...p, button: 'left', clickCount: 1 });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p, button: 'left', clickCount: 1 });
    const s = await until(s => s.entities.some(e => e.team === 0 && e.type === type), `${type} placed`);
    return s.entities.find(e => e.team === 0 && e.type === type);
  };
  const power = await place('power', 'buildings', 490, 580);
  const barracks = await place('barracks', 'buildings', 650, 800);
  await click('[role="tab"][data-production-tab="infantry"]');
  assert.equal(await evaluate('document.querySelector("[data-produce=sniper]").disabled'), true);
  const academy = await place('academy', 'technology', 650, 590);
  await click('[role="tab"][data-production-tab="infantry"]');
  assert.equal(await evaluate('document.querySelector("[data-produce=sniper]").disabled'), false);
  const core = (await state()).entities.find(e => e.team === 0 && e.kind === 'core' && e.serial === 2);
  await click(`[data-core="${core.id}"]`);
  assert.equal(await evaluate(`!!document.querySelector('[data-dock="${power.id}"]')`), false, 'power plant excluded from docking destinations');
  await click(`[data-dock="${academy.id}"]`);
  await until(s => s.entities.find(e => e.id === core.id).dock === academy.id, 'academy core docked');
  await click(`[data-research="${academy.id}"]`);
  let s = await state(); assert.equal(s.technologies[0].includes('academy'), false); assert.ok(s.entities.find(e => e.id === academy.id).researchJob);
  await wait(500);
  await click(`[data-research-toggle="${academy.id}"]`);
  const remaining = (await state()).entities.find(e => e.id === academy.id).researchJob.remaining;
  await wait(400); assert.equal((await state()).entities.find(e => e.id === academy.id).researchJob.remaining, remaining);
  await screenshot('technology-research-desktop.png');
  await click(`[data-research-toggle="${academy.id}"]`);
  await until(s => s.technologies[0].includes('academy'), 'firepower completed');
  await click(`[data-eject="${core.id}"]`);
  assert.ok((await state()).technologies[0].includes('academy'), 'completed technology survives core removal');
  await click(`[data-dock="${barracks.id}"]`);
  await until(s => s.entities.find(e => e.id === core.id).dock === barracks.id, 'barracks core docked');
  await click(`[data-producer="${barracks.id}"][data-produce="sniper"]`);
  await click(`[data-producer="${barracks.id}"][data-produce="rocketeer"]`);
  await until(s => s.entities.some(e => e.team === 0 && e.type === 'sniper') && s.entities.some(e => e.team === 0 && e.type === 'rocketeer'), 'new infantry produced');
  const mobility = await place('mobility', 'technology', 640, 1030);
  const arsenal = await place('arsenal', 'technology', 370, 560);
  const factory = await place('factory', 'buildings', 790, 800);
  const third = (await state()).entities.find(e => e.team === 0 && e.kind === 'core' && e.serial === 3);
  await click(`[data-core="${third.id}"]`); await click(`[data-dock="${factory.id}"]`);
  await until(s => s.entities.find(e => e.id === third.id).dock === factory.id, 'factory core docked');
  for (const type of ['scout', 'heavyTank', 'artillery']) await click(`[data-producer="${factory.id}"][data-produce="${type}"]`);
  await until(s => ['scout','heavyTank','artillery'].every(type => s.entities.some(e => e.team === 0 && e.type === type)), 'all new vehicles produced');
  await click('[role="tab"][data-production-tab="infantry"]'); await click(`[data-producer="${barracks.id}"][data-produce="striker"]`);
  await until(s => s.entities.some(e => e.team === 0 && e.type === 'striker'), 'striker produced');
  await click('[role="tab"][data-production-tab="technology"]');
  await evaluate('window.__qaTools.set_battle_paused.execute({paused:true})'); await wait(200);
  await click('#home-btn'); await screenshot('technology-base-desktop.png');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await wait(200); await click('#panel-toggle'); await wait(200);
  assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true, 'mobile viewport has no horizontal overflow');
  assert.equal(await evaluate('document.querySelectorAll("[role=tab]").length'), 5);
  await screenshot('technology-mobile.png');
  await click('[role="tab"][data-production-tab="vehicles"]'); await wait(200);
  await screenshot('technology-units-mobile.png');
  assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true, 'unit cards have no mobile overflow');
  assert.deepEqual(errors, [], 'no runtime exceptions through full browser flow');
  s = await state();
  const report = { passed: true, checks: ['power excluded from docking UI','unlocked after placed','research countdown and pause','permanent firepower after core removal','new infantry and all vehicles produced','mobile technology/production layout','no runtime exceptions'], technologies: s.technologies, units: s.entities.filter(e => e.team === 0 && e.kind === 'unit').map(e => e.type), screenshots: ['technology-research-desktop.png','technology-base-desktop.png','technology-mobile.png','technology-units-mobile.png'] };
  await writeFile(path.join(output, 'technology-browser-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  await cdp('Browser.close');
} finally {
  socket?.close(); chrome.kill(); server.kill();
}
