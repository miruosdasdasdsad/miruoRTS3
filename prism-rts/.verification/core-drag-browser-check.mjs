import { spawn } from 'node:child_process';
import { mkdir, writeFile, realpath, rm } from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';

const root = process.cwd(), output = path.resolve(root, '.verification'), profile = path.join(output, 'chrome-core-drag-profile');
await mkdir(output, { recursive: true });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const server = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, PORT: '4176' }, windowsHide: true, stdio: 'ignore' });
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--remote-debugging-port=9226', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
let socket, cdp, evaluate, latest;
const checks = [], screenshots = [], errors = [];
const log = (event, data = {}) => console.log(JSON.stringify({ event, ...data }));
try {
  let tabs;
  for (let i = 0; i < 50; i++) {
    try { tabs = await (await fetch('http://127.0.0.1:9226/json/list')).json(); if (tabs.some(t => t.type === 'page')) break; } catch {}
    await wait(200);
  }
  assert.ok(tabs?.length, 'isolated browser available');
  socket = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  const pending = new Map(); let next = 0;
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id) { const item = pending.get(message.id); if (item) { pending.delete(message.id); message.error ? item.reject(new Error(JSON.stringify(message.error))) : item.resolve(message.result); } }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
  });
  cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = ++next; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  evaluate = async expression => {
    const response = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    return response.result.value;
  };
  const click = selector => evaluate(`(() => {const element=document.querySelector(${JSON.stringify(selector)});if(!element||element.disabled)throw new Error('Unavailable '+${JSON.stringify(selector)});element.click();return true;})()`);
  const state = async () => latest = await evaluate('window.__qaTools.read_battle_state.execute()');
  const pause = paused => evaluate(`window.__qaTools.set_battle_paused.execute({paused:${paused}})`);
  const until = async (predicate, label, limit = 18000) => {
    const end = Date.now() + limit;
    while (Date.now() < end) { const current = await state(); if (predicate(current)) return current; await wait(100); }
    throw new Error(`Timeout: ${label}`);
  };
  const shot = async name => {
    await wait(150);
    const result = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(path.join(output, name), Buffer.from(result.data, 'base64')); screenshots.push(name);
  };
  let camera = { x: 420, y: 1200, z: .66 };
  const point = entity => evaluate(`(() => {const r=document.querySelector('#game').getBoundingClientRect();return{x:r.x+r.width/2+(${entity.x}-${camera.x})*${camera.z},y:r.y+r.height/2+(${entity.y}-${camera.y})*${camera.z}};})()`);
  const mouse = (type, p, button = 'left', buttons) => cdp('Input.dispatchMouseEvent', { type, ...p, button, clickCount: 1, ...(buttons === undefined ? {} : { buttons }) });
  const mouseClick = async entity => { const p = await point(entity); await mouse('mousePressed', p); await mouse('mouseReleased', p); };
  const hold = async entity => { const p = await point(entity); await mouse('mousePressed', p); await wait(480); return p; };
  const dragTo = async entity => { const p = await point(entity); await mouse('mouseMoved', p, 'left', 1); await wait(100); return p; };
  const allocation = snapshot => snapshot.entities.filter(e => e.team === 0 && e.kind === 'core').map(({ id, dock, targetDock, energy, x, y, dest, orders }) => ({ id, dock, targetDock, energy, x, y, dest, orders }));
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: "window.__qaTools={};Object.defineProperty(document,'modelContext',{value:{registerTool(tool){window.__qaTools[tool.name]=tool;}}});" });
  await cdp('Page.navigate', { url: 'http://127.0.0.1:4176/' });
  for (let i = 0; i < 60; i++) { if (await evaluate('!!window.__qaTools?.read_battle_state')) break; await wait(100); }
  await click('#start-btn'); await click('#debug-btn');
  await evaluate("document.querySelector('#ai-enabled').checked=false;document.querySelector('#ai-enabled').dispatchEvent(new Event('change'));document.querySelector('#game-speed').value='4';document.querySelector('#game-speed').dispatchEvent(new Event('change'));document.querySelector('#energy-rate').value='0';document.querySelector('#energy-rate').dispatchEvent(new Event('change'));");
  await click('#add-energy'); await click('#add-energy'); await click('[data-close="debug-dialog"]');
  const hq = (await state()).entities.find(e => e.team === 0 && e.type === 'hq');
  camera = { x: hq.x, y: hq.y, z: .66 };
  const place = async (type, x, y) => {
    await click(`[data-production-tab="${['academy', 'arsenal', 'mobility'].includes(type) ? 'technology' : 'buildings'}"]`);
    await click(`[data-build="${type}"]`);
    await until(s => s.entities.find(e => e.id === hq.id).buildJob?.remaining === 0, `${type} ready`);
    await click(`[data-build="${type}"]`); await click('#home-btn');
    await mouseClick({ x, y });
    return (await until(s => s.entities.some(e => e.team === 0 && e.type === type), `${type} placed`)).entities.find(e => e.team === 0 && e.type === type);
  };
  const power = await place('power', hq.x + 200, hq.y - 200);
  const barracks = await place('barracks', hq.x + 320, hq.y - 20);
  const factory = await place('factory', hq.x + 320, hq.y + 230);
  const academy = await place('academy', hq.x + 540, hq.y);
  const cores = (await state()).entities.filter(e => e.team === 0 && e.kind === 'core');
  for (const [core, building] of [[cores[1], barracks], [cores[2], factory]]) {
    await click(`[data-core="${core.id}"]`); await click(`[data-dock="${building.id}"]`);
    await until(s => s.entities.find(e => e.id === core.id).dock === building.id, 'initial core docked');
  }
  await pause(true); await click('#home-btn');
  assert.deepEqual(errors, []); log('fixture-ready', { buildings: [hq.id, barracks.id, factory.id, academy.id] });
  await mouseClick(hq);
  assert.deepEqual((await state()).selection, [hq.id]);
  const initial = allocation(await state()), p0 = await hold(hq);
  assert.deepEqual((await state()).selection, [cores[0].id]);
  assert.deepEqual(allocation(await state()), initial, 'holding alone never undocks');
  await mouse('mouseReleased', p0);
  assert.deepEqual(allocation(await state()), initial, 'releasing in place only selects the core');
  checks.push('desktop short click selects building; long press selects its core without interrupting production');

  await hold(hq); let release = await dragTo(barracks);
  assert.equal(await evaluate('document.querySelector("#core-drag-status").textContent.includes("交换核心")'), true);
  assert.deepEqual(allocation(await state()), initial, 'swap preview does not mutate simulation');
  await shot('core-drag-swap-preview-desktop.png');
  await mouse('mouseReleased', release);
  let current = await state();
  assert.equal(current.entities.find(e => e.id === cores[0].id).targetDock, barracks.id);
  assert.equal(current.entities.find(e => e.id === cores[1].id).targetDock, hq.id);
  assert.equal(current.entities.find(e => e.id === hq.id).core, null);
  await pause(false); await until(s => s.entities.find(e => e.id === cores[0].id).dock === barracks.id && s.entities.find(e => e.id === cores[1].id).dock === hq.id, 'both swapped cores arrive'); await pause(true);
  checks.push('desktop drop swaps and reserves both slots; cores travel and dock at their new buildings');

  const beforeCancel = allocation(await state());
  await hold(barracks); release = await dragTo(power); await mouse('mouseReleased', release);
  assert.deepEqual(allocation(await state()), beforeCancel, 'no-slot drop leaves original tasks untouched');
  await hold(barracks); release = await dragTo(hq);
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await mouse('mouseReleased', release);
  assert.deepEqual(allocation(await state()), beforeCancel, 'Escape cancels pending swap');
  await hold(barracks); release = await dragTo(hq);
  await mouse('mousePressed', release, 'right', 3); await mouse('mouseReleased', release, 'right', 1); await mouse('mouseReleased', release, 'left', 0);
  assert.deepEqual(allocation(await state()), beforeCancel, 'right click cancels pending swap');
  checks.push('invalid targets, Escape and right-click cancellation preserve both core allocations and balances');

  await hold(factory); release = await dragTo({ x: hq.x + 540, y: hq.y + 230 }); await mouse('mouseReleased', release);
  assert.equal((await state()).entities.find(e => e.id === factory.id).core, null);
  await pause(false); current = await until(s => !s.entities.find(e => e.id === cores[2].id).dest, 'ground move completed'); await pause(true);
  const loose = current.entities.find(e => e.id === cores[2].id), loosePoint = await point(loose);
  await mouse('mousePressed', loosePoint); release = await dragTo(barracks);
  assert.equal(await evaluate('document.querySelector("#core-drag-status").textContent.includes("原核心卸在建筑旁")'), true);
  await mouse('mouseReleased', release);
  current = await state();
  assert.equal(current.entities.find(e => e.id === cores[0].id).dock, null);
  assert.equal(current.entities.find(e => e.id === cores[0].id).targetDock, null);
  await pause(false); await until(s => s.entities.find(e => e.id === cores[2].id).dock === barracks.id, 'loose replacement arrived'); await pause(true);
  checks.push('core can leave a building for the ground; loose cores drag immediately and replace occupied slots');

  // The original card/button flow now offers the same replacement command.
  await click(`[data-core="${cores[0].id}"]`);
  assert.equal(await evaluate(`document.querySelector('[data-dock="${barracks.id}"]').disabled`), false);
  await click(`[data-dock="${barracks.id}"]`);
  await pause(false); await until(s => s.entities.find(e => e.id === cores[0].id).dock === barracks.id, 'panel replacement arrived'); await pause(true); await click('#home-btn');
  checks.push('existing core cards and destination buttons also support direct replacement');
  await shot('core-energy-lights-desktop.png');

  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await wait(200); await click('#home-btn'); await click('#zoom-out'); await click('#zoom-out');
  camera.z = .66 / 1.2 / 1.2;
  const touch = (type, positions) => cdp('Input.dispatchTouchEvent', { type, touchPoints: positions.map((p, i) => ({ ...p, id: i + 1, radiusX: 3, radiusY: 3, force: 1 })) });
  const a = await point(hq), b = await point(barracks);
  const beforeTouch = allocation(await state());
  await touch('touchStart', [a]); await wait(480);
  await touch('touchMove', [b]); await wait(100);
  assert.equal(await evaluate('document.querySelector("#core-drag-status").textContent.includes("交换核心")'), true);
  assert.deepEqual(allocation(await state()), beforeTouch);
  await shot('core-drag-swap-preview-mobile.png');
  await touch('touchEnd', []);
  current = await state();
  const hqCore = beforeTouch.find(c => c.dock === hq.id), barracksCore = beforeTouch.find(c => c.dock === barracks.id);
  assert.equal(current.entities.find(e => e.id === hqCore.id).targetDock, barracks.id);
  assert.equal(current.entities.find(e => e.id === barracksCore.id).targetDock, hq.id);
  await pause(false); await until(s => s.entities.find(e => e.id === hqCore.id).dock === barracks.id && s.entities.find(e => e.id === barracksCore.id).dock === hq.id, 'mobile swap arrived'); await pause(true);
  checks.push('390×844 trusted touch long press, preview and swap operate without camera drag or horizontal overflow');

  const beforePinch = allocation(await state());
  await touch('touchStart', [a]); await wait(480); await touch('touchMove', [b]);
  await touch('touchStart', [b, { x: a.x, y: a.y + 60 }]);
  await touch('touchEnd', []);
  assert.deepEqual(allocation(await state()), beforePinch, 'second finger cancels without dispatching');
  assert.equal(await evaluate('document.querySelector("#core-drag-status").hidden'), true);
  await touch('touchStart', [a]); await wait(480); await touch('touchMove', [b]); await touch('touchCancel', []);
  assert.deepEqual(allocation(await state()), beforePinch, 'pointer interruption cancels the pending order');
  await touch('touchStart', [a]); await touch('touchMove', [{ x: a.x + 65, y: a.y + 30 }]); await touch('touchEnd', []);
  assert.deepEqual(allocation(await state()), beforePinch, 'movement before the hold threshold pans without moving any core');
  await click('#home-btn');
  assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true);
  checks.push('two-finger cancellation, pointer cancellation and pre-hold camera panning preserve all original assignments');
  await shot('core-energy-lights-mobile.png');
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  assert.deepEqual(errors, [], 'no browser runtime exceptions');
  checks.push('no browser runtime exceptions');
  await writeFile(path.join(output, 'core-drag-browser-report.json'), JSON.stringify({ passed: true, checks, screenshots, errors }, null, 2));
  log('complete', { passed: true, checks, screenshots });
} catch (error) {
  await writeFile(path.join(output, 'core-drag-browser-report.json'), JSON.stringify({ passed: false, message: error.message, stack: error.stack, checks, screenshots, errors, lastState: latest }, null, 2));
  if (cdp) { try { const result = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); await writeFile(path.join(output, 'core-drag-browser-failure.png'), Buffer.from(result.data, 'base64')); } catch {} }
  log('failed', { message: error.message, stack: error.stack, checks, errors }); process.exitCode = 1;
} finally {
  if (cdp) { try { await cdp('Browser.close'); } catch {} }
  socket?.close(); chrome.kill(); server.kill(); await wait(600);
  const resolvedOutput = await realpath(output), resolvedProfile = await realpath(profile).catch(() => null);
  if (resolvedProfile && resolvedProfile === path.join(resolvedOutput, 'chrome-core-drag-profile') && resolvedProfile.startsWith(path.resolve(root) + path.sep)) await rm(resolvedProfile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
