import { spawn } from 'node:child_process';
import { mkdir, writeFile, realpath, rm } from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';

const root = process.cwd(), output = path.resolve(root, '.verification');
const profile = path.join(output, `fog-chrome-profile-${process.pid}`);
await mkdir(output, { recursive: true });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const server = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, PORT: '4177' }, windowsHide: true, stdio: 'ignore' });
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--remote-debugging-port=9227', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
const checks = [], screenshots = [], errors = [];
let socket, cdp, evaluate, latest;
try {
  let tabs;
  for (let i = 0; i < 60; i++) {
    try { tabs = await (await fetch('http://127.0.0.1:9227/json/list')).json(); if (tabs.some(tab => tab.type === 'page')) break; } catch {}
    await wait(150);
  }
  assert.ok(tabs?.length, 'isolated Chrome started');
  socket = new WebSocket(tabs.find(tab => tab.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  const pending = new Map(); let sequence = 0;
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id) { const item = pending.get(message.id); if (item) { pending.delete(message.id); message.error ? item.reject(new Error(JSON.stringify(message.error))) : item.resolve(message.result); } }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
  });
  cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  evaluate = async expression => {
    const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const state = async () => latest = await evaluate('window.__qaTools.read_battle_state.execute()');
  const pause = paused => evaluate(`window.__qaTools.set_battle_paused.execute({paused:${paused}})`);
  const until = async (predicate, label, limit = 18000) => {
    const deadline = Date.now() + limit;
    while (Date.now() < deadline) { const snapshot = await state(); if (predicate(snapshot)) return snapshot; await wait(100); }
    throw new Error(`Timeout: ${label}`);
  };
  const screenshot = async name => {
    await wait(200); const result = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(path.join(output, name), Buffer.from(result.data, 'base64')); screenshots.push(name);
  };
  const overview = () => click('#overview-btn');
  const fieldClick = async (x, y) => {
    const point = await evaluate(`(() => {const r=document.querySelector('#game').getBoundingClientRect(),z=Math.min(.66,r.width/3600*.92,r.height/2400*.92);return{x:r.x+r.width/2+(${x}-1800)*z,y:r.y+r.height/2+(${y}-1200)*z};})()`);
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  };
  const miniPixel = (x, y) => evaluate(`(() => {const c=document.querySelector('#minimap');return [...c.getContext('2d').getImageData(Math.floor(${x}/3600*c.width),Math.floor(${y}/2400*c.height),1,1).data];})()`);
  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: "window.__qaTools={};Object.defineProperty(document,'modelContext',{value:{registerTool(tool){window.__qaTools[tool.name]=tool;}}});" });
  await cdp('Page.navigate', { url: 'http://127.0.0.1:4177/' });
  for (let i = 0; i < 60; i++) { if (await evaluate('!!window.__qaTools?.read_battle_state')) break; await wait(100); }
  await click('#start-btn'); await pause(true); await overview();
  let snapshot = await state(), enemy = snapshot.entities.find(entity => entity.team === 1 && entity.type === 'hq');
  assert.equal(snapshot.config.fog, true); assert.equal(snapshot.fog.teams[0].visibleEntityIds.includes(enemy.id), false);
  assert.equal(await evaluate("document.querySelector('#capture-timer').textContent"), '--:--');
  await screenshot('fog-initial-desktop.png');
  assert.deepEqual((await miniPixel(enemy.x, enemy.y)).slice(0, 3), [7, 11, 17]);
  checks.push('opening hides enemy base and capture intelligence on field, minimap and HUD');
  const initialCells = snapshot.fog.teams[0].exploredCells;
  await click('#debug-btn');
  await evaluate("document.querySelector('#ai-enabled').checked=false;document.querySelector('#ai-enabled').dispatchEvent(new Event('change'));document.querySelector('#game-speed').value='4';document.querySelector('#game-speed').dispatchEvent(new Event('change'));document.querySelector('#fog-enabled').checked=false;document.querySelector('#fog-enabled').dispatchEvent(new Event('change'));");
  snapshot = await state(); assert.equal(snapshot.fog.teams[0].visibleEntityIds.includes(enemy.id), true);
  await evaluate("document.querySelector('#fog-enabled').checked=true;document.querySelector('#fog-enabled').dispatchEvent(new Event('change'));");
  assert.equal((await state()).fog.teams[0].exploredCells, initialCells);
  checks.push('debug reveal switches off cleanly without granting permanent exploration');
  await evaluate("document.querySelector('#debug-unit').value='scout'"); await click('#spawn-selected');
  await click('[data-close="debug-dialog"]'); await pause(true); await overview();
  const scouts = (await state()).selection;
  await click('#attack-btn'); await fieldClick(1800, 1280); await pause(false);
  snapshot = await until(s => s.entities.filter(entity => scouts.includes(entity.id)).every(entity => entity.x > 1750), 'scouts explore central lane');
  await pause(true); await wait(220);
  assert.ok(snapshot.fog.teams[0].exploredCells > initialCells);
  assert.notEqual(await evaluate("document.querySelector('#capture-timer').textContent"), '--:--');
  await screenshot('fog-exploration-desktop.png'); checks.push('scouts naturally explore black fog and reveal capture state');
  await fieldClick(2700, 1200); await pause(false);
  await until(s => s.fog.teams[0].visibleEntityIds.includes(enemy.id) && s.entities.filter(entity => scouts.includes(entity.id)).every(entity => entity.x > 2640), 'enemy base discovered');
  await pause(true);
  await fieldClick(1800, 1320); await click('#deselect-btn'); await fieldClick(enemy.x, enemy.y);
  assert.deepEqual((await state()).selection, [enemy.id]);
  await pause(false);
  snapshot = await until(s => !s.fog.teams[0].visibleEntityIds.includes(enemy.id), 'enemy base returns to grey fog');
  assert.equal(snapshot.selection.includes(enemy.id), false);
  await until(s => s.entities.filter(entity => scouts.includes(entity.id)).every(entity => entity.x < 1850), 'scouts retreat');
  await pause(true); await wait(220);
  snapshot = await state();
  assert.ok(snapshot.fog.teams[0].rememberedBuildings.some(entity => entity.id === enemy.id));
  assert.equal(await evaluate("document.querySelector('#selection').textContent.includes('敌方')"), false);
  const greyPixel = await miniPixel(2700, 1200), blackPixel = await miniPixel(3300, 400);
  assert.ok(greyPixel[0] + greyPixel[1] + greyPixel[2] > blackPixel[0] + blackPixel[1] + blackPixel[2]);
  await screenshot('fog-memory-desktop.png');
  checks.push('retreat restores grey fog, keeps building memory, removes live enemy selection and preserves unseen black areas');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await wait(300); await overview();
  assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true);
  await screenshot('fog-mobile.png'); checks.push('390px mobile display and high density minimap render without overflow');
  await click('#debug-btn'); await click('#restart-btn');
  snapshot = await state();
  assert.equal(snapshot.config.fog, true); assert.equal(snapshot.fog.teams[0].exploredCells, initialCells);
  assert.equal(snapshot.fog.teams[0].rememberedBuildings.length, 0);
  assert.deepEqual(errors, []); checks.push('restart resets exploration, memory and debug toggle; no runtime exceptions');
  const report = { passed: true, checks, screenshots, greyPixel, blackPixel, errors };
  await writeFile(path.join(output, 'fog-browser-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  const report = { passed: false, message: error.message, checks, screenshots, errors, lastState: latest };
  await writeFile(path.join(output, 'fog-browser-report.json'), JSON.stringify(report, null, 2));
  if (cdp) { try { const image = await cdp('Page.captureScreenshot', { format: 'png' }); await writeFile(path.join(output, 'fog-failure.png'), Buffer.from(image.data, 'base64')); } catch {} }
  console.error(error.stack); process.exitCode = 1;
} finally {
  if (cdp) { try { await cdp('Browser.close'); } catch {} }
  socket?.close(); chrome.kill(); server.kill(); await wait(600);
  try {
    const resolved = await realpath(profile), allowed = await realpath(output);
    if (path.dirname(resolved).toLowerCase() === allowed.toLowerCase() && path.basename(resolved) === path.basename(profile)) await rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } catch {}
}
