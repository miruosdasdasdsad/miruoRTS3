import { DEFAULT_MAP, MAP_LIMITS, createMap, validateMap, spawnFootprints } from './map-config.js';
import { MAP, BOUNDS, polygonBounds, pointSegmentDistanceSq } from './terrain.js';
import { World } from './engine.js';
import { MAP_KEY, readSavedMap, saveMap, downloadJSON } from './lab-storage.js';

const clone = value => JSON.parse(JSON.stringify(value));
const escapeHTML = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const names = { water: '湖泊', ridge: '岩壁', rock: '岩石', cache: '核心仓库', core: '中立核心', capture: '占领据点', ally: '我方出生点', enemy: '敌方出生点' };

export function mapObjects(map) {
  return [
    ...map.terrain.map(data => ({ key: `terrain:${data.id}`, kind: data.kind, data, label: data.name, group: 'terrain' })),
    ...map.obstacles.map((data, i) => ({ key: `obstacles:${data.id}`, kind: 'rock', data, label: `岩石 ${i + 1}`, group: 'obstacles' })),
    ...map.caches.map((data, i) => ({ key: `caches:${data.id}`, kind: 'cache', data, label: `核心仓库 ${i + 1}`, group: 'caches' })),
    ...map.neutralCores.map((data, i) => ({ key: `neutralCores:${data.id}`, kind: 'core', data, label: `中立核心 ${i + 1}`, group: 'neutralCores' })),
    ...(map.captureSite ? [{ key: 'capture', kind: 'capture', data: map.captureSite, label: names.capture }] : []),
    ...map.bases.map((data, i) => ({ key: `base:${i}`, kind: i ? 'enemy' : 'ally', data, label: i ? names.enemy : names.ally }))
  ];
}

export function mapObjectCenter(object) {
  const p = object.data.points;
  return p ? { x: p.reduce((sum, v) => sum + v[0], 0) / p.length, y: p.reduce((sum, v) => sum + v[1], 0) / p.length } : { x: object.data.x, y: object.data.y };
}

// Replace polygon arrays on every edit: terrain.js caches polygon bounds by array identity.
export function moveMapObject(map, key, dx, dy) {
  const object = mapObjects(map).find(item => item.key === key);
  if (!object || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
  const data = object.data;
  let bounds;
  if (data.points) bounds = polygonBounds(data.points);
  else {
    const circles = object.kind === 'ally' || object.kind === 'enemy' ? spawnFootprints(data) : [{ ...data, r: data.r ?? (object.kind === 'cache' ? 48 : 15) }];
    bounds = { left: Math.min(...circles.map(p => p.x - p.r)), right: Math.max(...circles.map(p => p.x + p.r)), top: Math.min(...circles.map(p => p.y - p.r)), bottom: Math.max(...circles.map(p => p.y + p.r)) };
  }
  dx = clamp(dx, BOUNDS.left - bounds.left, BOUNDS.right - bounds.right);
  dy = clamp(dy, BOUNDS.top - bounds.top, BOUNDS.bottom - bounds.bottom);
  if (data.points) {
    data.points = data.points.map(([x, y]) => [x + dx, y + dy]);
    data.label = mapObjectCenter(object);
  } else { data.x += dx; data.y += dy; }
}

export function initMapEditor({ notify }) {
  const $ = selector => document.querySelector(selector);
  const svg = $('#map-canvas');
  let saved = readSavedMap(), draft = createMap(saved || DEFAULT_MAP);
  let selected = 'base:0', vertex = null, tool = 'select', drag = null;
  let undo = [], redo = [], invalidInputs = new Set(), propertySession = null;
  const isDirty = () => invalidInputs.size > 0 || JSON.stringify(draft) !== JSON.stringify(saved || DEFAULT_MAP);
  const objects = () => mapObjects(draft);
  const selectedObject = () => objects().find(item => item.key === selected);
  const snapshot = () => ({ map: clone(draft), selected, vertex });
  const checkpoint = () => { undo.push(snapshot()); if (undo.length > 60) undo.shift(); redo = []; };
  const invalidateRoutes = () => { $('#map-route-result').hidden = true; };
  function mutate(action) { checkpoint(); action(); invalidInputs.clear(); propertySession = null; invalidateRoutes(); render(); }
  function load(value, message) {
    mutate(() => { draft = createMap(value); selected = 'base:0'; vertex = null; });
    setTool('select'); if (message) notify(message);
  }
  function restore(state) { draft = state.map; selected = state.selected; vertex = state.vertex; invalidInputs.clear(); propertySession = null; invalidateRoutes(); render(); }
  function history(direction) {
    const source = direction === 'undo' ? undo : redo, target = direction === 'undo' ? redo : undo;
    if (drag || !source.length) return;
    target.push(snapshot()); restore(source.pop());
  }
  function setTool(next) {
    tool = next;
    document.querySelectorAll('[data-map-tool]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.mapTool === tool)));
    svg.classList.toggle('placing', tool !== 'select');
    $('#map-tool-hint').textContent = tool === 'select' ? '拖动物件或地形顶点；双击地形边缘增加顶点。' : `点击地图${['ally', 'enemy', 'capture'].includes(tool) ? '设置' : '放置'}${names[tool]}；Esc 返回选择。`;
  }
  function updateStatus() {
    const validation = validateMap(draft), valid = validation.ok && !invalidInputs.size, dirty = isDirty();
    const errors = invalidInputs.size ? ['属性中有未填完或无效的数值，请修正。', ...validation.errors] : validation.errors;
    $('#map-save').disabled = !valid;
    $('#map-export').disabled = !valid;
    $('#map-check-routes').disabled = !valid;
    $('#map-undo').disabled = !undo.length;
    $('#map-redo').disabled = !redo.length;
    const object = selectedObject();
    $('#map-duplicate').disabled = !object?.group;
    $('#map-delete').disabled = !object || ['ally', 'enemy'].includes(object.kind);
    $('#map-save-state').textContent = !valid ? '布局需要修正' : dirty ? '未保存的地图' : saved ? '已保存至本浏览器' : '默认地图';
    $('#map-save-state').classList.toggle('dirty', dirty || !valid);
    $('#map-draft-status').textContent = !valid ? '请先修正地图布局' : dirty ? '地图草稿已修改' : '地图已就绪';
    $('#map-validation').classList.toggle('invalid', !valid);
    $('#map-validation').innerHTML = valid ? `<strong>✓ 布局检查通过</strong><span>${draft.terrain.length} 块地形 · ${draft.obstacles.length} 块岩石 · ${draft.caches.length} 座仓库 · ${draft.neutralCores.length} 个中立核心 · ${draft.captureSite ? '1 个据点' : '无据点'}</span>` : `<strong>请调整布局</strong>${errors.slice(0, 3).map(error => `<span>${escapeHTML(error)}</span>`).join('')}${errors.length > 3 ? `<span>另有 ${errors.length - 3} 项问题，修正后继续检查。</span>` : ''}`;
  }
  function draw() {
    const object = selectedObject(), point = object ? mapObjectCenter(object) : null;
    const output = [
      '<defs><pattern id="map-grid" width="200" height="200" patternUnits="userSpaceOnUse"><path d="M 200 0 H 0 V 200" fill="none" stroke="#26353e" stroke-width="2"/></pattern><pattern id="map-ridge" width="24" height="24" patternUnits="userSpaceOnUse" patternTransform="rotate(40)"><rect width="24" height="24" fill="#383e40"/><path d="M 0 0 V 24" stroke="#6d7776" stroke-width="5"/></pattern></defs>',
      `<rect width="${MAP.w}" height="${MAP.h}" fill="#11191f"/><rect x="${BOUNDS.left}" y="${BOUNDS.top}" width="${BOUNDS.right - BOUNDS.left}" height="${BOUNDS.bottom - BOUNDS.top}" fill="url(#map-grid)" stroke="#46555e" stroke-width="3"/>`,
      '<text x="165" y="100" class="map-grid-label">N ↑</text><text x="3435" y="2345" text-anchor="end" class="map-grid-label">PRISM / MAP WORKSHOP</text>'
    ];
    for (const item of objects().sort((a, b) => (a.kind === 'capture' ? -1 : 0) - (b.kind === 'capture' ? -1 : 0))) {
      const d = item.data, p = mapObjectCenter(item), active = item.key === selected;
      const color = item.kind === 'ally' ? '#88e6c5' : item.kind === 'enemy' ? '#f48291' : '#e9c779';
      output.push(`<g data-map-object="${escapeHTML(item.key)}" class="map-object ${active ? 'selected' : ''}"><title>${escapeHTML(item.label)}</title>`);
      if (d.points) output.push(`<polygon points="${d.points.map(p => p.join(',')).join(' ')}" fill="${item.kind === 'water' ? '#294d61' : 'url(#map-ridge)'}" stroke="${active ? '#e2eee9' : item.kind === 'water' ? '#5489a3' : '#89928b'}" stroke-width="${active ? 7 : 4}"/><text x="${p.x}" y="${p.y + 12}" text-anchor="middle" class="map-object-label">${escapeHTML(item.label)}</text>`);
      else if (item.kind === 'rock') output.push(`<circle cx="${d.x}" cy="${d.y}" r="${d.r}" fill="#414d54" stroke="${active ? '#e2eee9' : '#7c8b92'}" stroke-width="${active ? 7 : 4}"/><path d="M ${d.x - d.r * .4} ${d.y + d.r * .12} L ${d.x - d.r * .1} ${d.y - d.r * .48} L ${d.x + d.r * .45} ${d.y - d.r * .1}" fill="none" stroke="#a8b3b6" stroke-width="4"/>`);
      else if (item.kind === 'capture') output.push(`<circle cx="${d.x}" cy="${d.y}" r="${d.r}" fill="#e9c77909" stroke="${active ? '#f8e5b4' : color}" stroke-width="5" stroke-dasharray="18 12"/><circle cx="${d.x}" cy="${d.y}" r="36" fill="#332f24" stroke="${color}" stroke-width="4"/><text x="${d.x}" y="${d.y + 12}" text-anchor="middle" class="map-marker" fill="${color}">◎</text><text x="${d.x}" y="${d.y + d.r + 45}" text-anchor="middle" class="map-object-label">占领据点</text>`);
      else if (['ally', 'enemy'].includes(item.kind)) {
        output.push(`<circle cx="${d.x}" cy="${d.y}" r="100" fill="${color}0d" stroke="${color}" stroke-dasharray="10 10" stroke-width="3"/><rect x="${d.x - 59}" y="${d.y - 59}" width="118" height="118" rx="14" fill="#1c2d2c" stroke="${active ? '#eef5f3' : color}" stroke-width="6"/><text x="${d.x}" y="${d.y + 15}" text-anchor="middle" class="map-marker" fill="${color}">⚑</text>`);
        for (const core of spawnFootprints(d).slice(1)) output.push(`<path d="M ${core.x} ${core.y - 18} l 18 18 -18 18 -18 -18 Z" fill="${color}" opacity=".65"/>`);
        output.push(`<text x="${d.x}" y="${d.y - 130}" text-anchor="middle" class="map-object-label" fill="${color}">${escapeHTML(item.label)}</text>`);
      } else if (item.kind === 'cache') output.push(`<rect x="${d.x - 48}" y="${d.y - 48}" width="96" height="96" rx="9" fill="#393022" stroke="${active ? '#fff2cf' : color}" stroke-width="5"/><path d="M ${d.x} ${d.y - 27} l 24 27 -24 27 -24 -27 Z" fill="none" stroke="${color}" stroke-width="4"/><text x="${d.x}" y="${d.y + 92}" text-anchor="middle" class="map-object-label">${escapeHTML(item.label)}</text>`);
      else output.push(`<circle cx="${d.x}" cy="${d.y}" r="42" fill="#e9c7790e" stroke="${active ? '#fff2cf' : color}" stroke-width="3"/><path d="M ${d.x} ${d.y - 25} l 23 25 -23 25 -23 -25 Z" fill="${color}"/><text x="${d.x}" y="${d.y + 87}" text-anchor="middle" class="map-object-label">中立核心</text>`);
      output.push('</g>');
    }
    if (object?.data.points) {
      const scale = svg.getScreenCTM()?.a || .2, handleRadius = clamp(5 / scale, 17, 75), hitRadius = clamp(13 / scale, 34, 140);
      object.data.points.forEach(([x, y], index) => output.push(`<circle data-vertex="${index}" cx="${x}" cy="${y}" r="${hitRadius}" fill="transparent" class="map-vertex-hit"/><circle cx="${x}" cy="${y}" r="${handleRadius}" fill="${vertex === index ? '#e9c779' : '#e9f4ef'}" stroke="#14211d" stroke-width="4" pointer-events="none"/>`));
      if (vertex !== null && object.data.points[vertex]) { const p = object.data.points[vertex]; output.push(`<text x="${p[0] + 45}" y="${p[1] - 35}" class="map-object-label">顶点 ${vertex + 1}</text>`); }
    } else if (point) output.push(`<circle cx="${point.x}" cy="${point.y}" r="${(object.data.r ?? (object.kind === 'cache' ? 48 : ['ally', 'enemy'].includes(object.kind) ? 105 : 42)) + 18}" fill="none" stroke="#f0f7f4" stroke-width="3" stroke-dasharray="9 9" pointer-events="none"/>`);
    svg.innerHTML = output.join('');
  }
  function field(key, label, value, min, max, step = 'any') {
    return `<div class="field"><label for="map-prop-${key}">${label}</label><input id="map-prop-${key}" data-map-prop="${key}" type="number" value="${Math.round(value * 100) / 100}" min="${min}" max="${max}" step="${step}" aria-invalid="false"></div>`;
  }
  function renderProperties() {
    const list = objects(), object = selectedObject();
    $('#map-object-list').innerHTML = `<option value="">选择地图物件…</option>${list.map(item => `<option value="${escapeHTML(item.key)}">${escapeHTML(item.label)}</option>`).join('')}`;
    $('#map-object-list').value = object ? selected : '';
    $('#map-object-count').textContent = `${list.length} 项`;
    if (document.activeElement !== $('#map-name')) $('#map-name').value = draft.name;
    if (!object) { $('#map-properties').innerHTML = '<div class="map-property-empty"><span>↖</span><strong>选择一个地图物件</strong><p>点击预览或使用上方列表选择。<br>使用顶部工具添加地形和资源。</p></div>'; return; }
    const d = object.data, p = mapObjectCenter(object), bounds = d.points ? polygonBounds(d.points) : null;
    const vertexPoint = vertex !== null ? d.points?.[vertex] : null;
    $('#map-properties').innerHTML = `<div class="map-property-heading"><span class="eyebrow">${bounds ? 'TERRAIN FOOTPRINT' : ['ally', 'enemy'].includes(object.kind) ? 'START POSITION' : 'MAP OBJECT'}</span><h3>${escapeHTML(object.label)}</h3><small>${bounds ? `${d.points.length} 个顶点 · 不可通行` : object.kind === 'cache' ? '摧毁后掉落 1 个核心' : object.kind === 'core' ? '靠近拾取 · 初始 0 能量' : object.kind === 'capture' ? '驻守奖励沿用经济页的据点周期' : object.kind === 'rock' ? '圆形障碍 · 不可通行' : '1 座建造厂 + 3 个初始核心'}</small></div>
      ${bounds ? `<div class="map-property-name"><label for="map-prop-name">地形名称</label><input id="map-prop-name" data-map-prop="name" type="text" maxlength="60" value="${escapeHTML(d.name)}"><label for="map-prop-kind">地形类型</label><select id="map-prop-kind" data-map-prop="kind"><option value="water" ${d.kind === 'water' ? 'selected' : ''}>湖泊</option><option value="ridge" ${d.kind === 'ridge' ? 'selected' : ''}>岩壁</option></select></div>` : ''}
      <div class="map-property-fields">${field('x', bounds ? '中心 X' : '位置 X', p.x, BOUNDS.left, BOUNDS.right)}${field('y', bounds ? '中心 Y' : '位置 Y', p.y, BOUNDS.top, BOUNDS.bottom)}${bounds ? field('width', '宽度', bounds.right - bounds.left, 20, MAP.w) + field('height', '高度', bounds.bottom - bounds.top, 20, MAP.h) : d.r ? field('r', '半径 / 米', d.r, object.kind === 'rock' ? 15 : 65, object.kind === 'rock' ? 300 : 400) : ''}</div>
      ${bounds ? `<div class="map-vertex-editor"><div><strong>轮廓顶点</strong><small>选择圆点，或在这里精确调整</small></div><label class="sr-only" for="map-vertex-select">选择轮廓顶点</label><select id="map-vertex-select"><option value="">未选择顶点</option>${d.points.map((p, i) => `<option value="${i}" ${vertex === i ? 'selected' : ''}>顶点 ${i + 1} · ${Math.round(p[0])}, ${Math.round(p[1])}</option>`).join('')}</select>${vertexPoint ? `<div class="map-property-fields">${field('vx', '顶点 X', vertexPoint[0], BOUNDS.left, BOUNDS.right)}${field('vy', '顶点 Y', vertexPoint[1], BOUNDS.top, BOUNDS.bottom)}</div>` : ''}<div class="map-vertex-actions"><button id="map-add-vertex" ${d.points.length >= MAP_LIMITS.vertices ? 'disabled' : ''}>插入顶点</button><button id="map-remove-vertex" ${vertexPoint && d.points.length > 3 ? '' : 'disabled'}>删除顶点</button></div></div>` : ''}
      <p class="map-property-tip">${bounds ? '拖动整体移动地形；拖动圆点改变轮廓。双击边缘可加顶点。' : ['ally', 'enemy'].includes(object.kind) ? '虚线标出出生区；下方两个菱形是初始游离核心。为基地扩建预留空地。' : object.kind === 'capture' ? '每张地图最多 1 个据点；删除后可用顶部工具重新放置。' : '可拖动调整位置，也可输入精确坐标。'}</p>`;
  }
  function render() { draw(); renderProperties(); updateStatus(); }
  function select(key, pointIndex = null) { selected = key; vertex = pointIndex; invalidInputs.clear(); propertySession = null; render(); }
  function newId(prefix) {
    const ids = new Set(objects().map(item => item.data.id));
    let index = 1; while (ids.has(`${prefix}-${index}`)) index++;
    return `${prefix}-${index}`;
  }
  function place(point) {
    if (['ally', 'enemy'].includes(tool)) {
      const key = `base:${tool === 'ally' ? 0 : 1}`, object = objects().find(item => item.key === key);
      mutate(() => { moveMapObject(draft, key, point.x - object.data.x, point.y - object.data.y); selected = key; vertex = null; });
      setTool('select'); return;
    }
    if (tool === 'capture') {
      mutate(() => { const r = draft.captureSite?.r ?? 170; draft.captureSite = { x: clamp(point.x, BOUNDS.left + r, BOUNDS.right - r), y: clamp(point.y, BOUNDS.top + r, BOUNDS.bottom - r), r }; selected = 'capture'; vertex = null; });
      setTool('select'); return;
    }
    const group = ['water', 'ridge'].includes(tool) ? 'terrain' : { rock: 'obstacles', cache: 'caches', core: 'neutralCores' }[tool];
    if (!group) return;
    if (draft[group].length >= MAP_LIMITS[group]) { notify(`${names[tool]}数量已达到上限 ${MAP_LIMITS[group]}。`, true); return; }
    const kind = tool;
    mutate(() => {
      const id = newId(kind), x = point.x, y = point.y;
      const data = group === 'terrain' ? { id, kind, name: `${names[kind]} ${draft.terrain.filter(t => t.kind === kind).length + 1}`, points: [[x - 160, y - 80], [x + 80, y - 120], [x + 180, y - 20], [x + 130, y + 100], [x - 100, y + 100], [x - 180, y + 10]] } : { id, x, y, ...(kind === 'rock' ? { r: 70 } : {}) };
      draft[group].push(data); selected = `${group}:${id}`; vertex = null;
      moveMapObject(draft, selected, 0, 0);
    });
  }
  function deleteObject() {
    const object = selectedObject();
    if (!object || ['ally', 'enemy'].includes(object.kind)) return;
    mutate(() => { if (object.group) draft[object.group] = draft[object.group].filter(item => item !== object.data); else draft.captureSite = null; selected = ''; vertex = null; });
  }
  function duplicate() {
    const object = selectedObject();
    if (!object?.group) return;
    if (draft[object.group].length >= MAP_LIMITS[object.group]) { notify('这类物件数量已达到上限。', true); return; }
    mutate(() => {
      const data = clone(object.data); data.id = newId(object.kind); if (data.name) data.name = `${data.name.slice(0, 55)} 副本`;
      draft[object.group].push(data); selected = `${object.group}:${data.id}`; vertex = null;
      moveMapObject(draft, selected, 160, 120);
    });
  }
  function insertVertex(index, point) {
    const object = selectedObject(), points = object?.data.points;
    if (!points || points.length >= MAP_LIMITS.vertices) return;
    const a = points[index], b = points[(index + 1) % points.length];
    mutate(() => { object.data.points = [...points.slice(0, index + 1), point ? [point.x, point.y] : [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], ...points.slice(index + 1)]; object.data.label = mapObjectCenter(object); vertex = index + 1; });
  }
  function removeVertex() {
    const object = selectedObject();
    if (vertex === null || !object?.data.points || object.data.points.length <= 3) return;
    mutate(() => { object.data.points = object.data.points.filter((_, index) => index !== vertex); object.data.label = mapObjectCenter(object); vertex = null; });
  }
  const snap = value => $('#map-snap').checked ? Math.round(value / 10) * 10 : Math.round(value * 10) / 10;
  function pointerPosition(event) {
    const matrix = svg.getScreenCTM();
    if (!matrix) return null;
    const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    return { x: snap(p.x), y: snap(p.y) };
  }
  function endDrag(event, cancelled = false) {
    if (!drag || (event && event.pointerId !== drag.pointerId)) return;
    const previous = drag; drag = null;
    if (cancelled) restore(previous.before);
    else {
      if (JSON.stringify(draft) !== JSON.stringify(previous.before.map)) { undo.push(previous.before); if (undo.length > 60) undo.shift(); redo = []; invalidateRoutes(); }
      render();
    }
    if (svg.hasPointerCapture(previous.pointerId)) svg.releasePointerCapture(previous.pointerId);
  }
  svg.addEventListener('pointerdown', event => {
    if (event.button !== 0 || drag) return;
    const point = pointerPosition(event); if (!point) return;
    event.preventDefault(); svg.focus({ preventScroll: true });
    if (tool !== 'select') { place(point); return; }
    const handle = event.target.closest('[data-vertex]'), hit = event.target.closest('[data-map-object]');
    if (handle && selectedObject()?.data.points) select(selected, Number(handle.dataset.vertex));
    else if (hit) select(hit.dataset.mapObject);
    else { select(''); return; }
    drag = { pointerId: event.pointerId, point, before: snapshot(), key: selected, vertex };
    svg.setPointerCapture(event.pointerId);
  });
  svg.addEventListener('pointermove', event => {
    const point = pointerPosition(event); if (!point) return;
    $('#map-coordinates').textContent = `X ${Math.round(point.x)} / Y ${Math.round(point.y)}`;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dx = point.x - drag.point.x, dy = point.y - drag.point.y;
    draft = clone(drag.before.map);
    const object = selectedObject();
    if (drag.vertex !== null && object?.data.points[drag.vertex]) {
      object.data.points = object.data.points.map((p, i) => i === drag.vertex ? [clamp(p[0] + dx, BOUNDS.left, BOUNDS.right), clamp(p[1] + dy, BOUNDS.top, BOUNDS.bottom)] : p);
      object.data.label = mapObjectCenter(object);
    } else moveMapObject(draft, drag.key, dx, dy);
    draw();
  });
  svg.addEventListener('pointerup', event => endDrag(event));
  svg.addEventListener('pointercancel', event => endDrag(event, true));
  svg.addEventListener('lostpointercapture', event => endDrag(event, true));
  window.addEventListener('blur', () => endDrag(null, true));
  svg.addEventListener('contextmenu', event => { event.preventDefault(); endDrag(null, true); setTool('select'); });
  svg.addEventListener('dblclick', event => {
    if (tool !== 'select' || !selectedObject()?.data.points) return;
    const point = pointerPosition(event), points = selectedObject().data.points;
    const distances = points.map((p, i) => { const next = points[(i + 1) % points.length]; return pointSegmentDistanceSq(point, { x: p[0], y: p[1] }, { x: next[0], y: next[1] }); });
    const index = distances.indexOf(Math.min(...distances)), threshold = 14 / svg.getScreenCTM().a;
    if (distances[index] < threshold ** 2) insertVertex(index, point);
  });
  function applyProperty(input) {
    const object = selectedObject(), key = input.dataset.mapProp;
    if (!object) return;
    const numeric = !['name', 'kind'].includes(key), value = numeric ? Number(input.value) : input.value;
    if (numeric && (input.value.trim() === '' || !Number.isFinite(value) || !input.validity.valid)) {
      invalidInputs.add(key); input.setAttribute('aria-invalid', 'true'); updateStatus(); return;
    }
    invalidInputs.delete(key); input.setAttribute('aria-invalid', 'false');
    if (propertySession !== input) { checkpoint(); propertySession = input; }
    const data = object.data, p = mapObjectCenter(object);
    if (key === 'x' || key === 'y') moveMapObject(draft, selected, key === 'x' ? value - p.x : 0, key === 'y' ? value - p.y : 0);
    else if (key === 'width' || key === 'height') {
      const bounds = polygonBounds(data.points), axis = key === 'width' ? 0 : 1, origin = axis ? p.y : p.x;
      const scale = value / (key === 'width' ? bounds.right - bounds.left : bounds.bottom - bounds.top);
      data.points = data.points.map(point => point.map((v, i) => i === axis ? origin + (v - origin) * scale : v)); data.label = mapObjectCenter(object);
    } else if (key === 'vx' || key === 'vy') {
      data.points = data.points.map((point, i) => i === vertex ? point.map((v, axis) => axis === (key === 'vx' ? 0 : 1) ? value : v) : point); data.label = mapObjectCenter(object);
    } else data[key] = value;
    invalidateRoutes(); draw(); updateStatus();
  }
  $('#map-properties').addEventListener('input', event => { if (event.target.matches('[data-map-prop]')) applyProperty(event.target); });
  $('#map-properties').addEventListener('change', event => {
    if (event.target.id === 'map-vertex-select') { select(selected, event.target.value === '' ? null : Number(event.target.value)); return; }
    if (event.target.matches('select[data-map-prop]')) applyProperty(event.target);
    propertySession = null;
    if (!invalidInputs.size) renderProperties();
  });
  $('#map-properties').addEventListener('click', event => {
    if (event.target.closest('#map-add-vertex')) insertVertex(vertex ?? selectedObject().data.points.length - 1);
    if (event.target.closest('#map-remove-vertex')) removeVertex();
  });
  $('#map-object-list').addEventListener('change', event => select(event.target.value));
  let naming = false;
  $('#map-name').addEventListener('input', event => { if (!naming) { checkpoint(); naming = true; } draft.name = event.target.value; updateStatus(); });
  $('#map-name').addEventListener('change', () => { naming = false; });
  document.querySelectorAll('[data-map-tool]').forEach(button => button.addEventListener('click', () => setTool(button.dataset.mapTool)));
  $('#map-undo').addEventListener('click', () => history('undo'));
  $('#map-redo').addEventListener('click', () => history('redo'));
  $('#map-delete').addEventListener('click', deleteObject);
  $('#map-duplicate').addEventListener('click', duplicate);
  $('#map-restore').addEventListener('click', () => { saved = readSavedMap(); load(saved || DEFAULT_MAP, '已恢复本浏览器保存的地图。'); });
  $('#map-baseline').addEventListener('click', () => load(DEFAULT_MAP, '默认地图已载入草稿；保存后用于下一局。'));
  $('#map-save').addEventListener('click', () => {
    if (invalidInputs.size) return;
    try { saved = saveMap(draft); draft = clone(saved); render(); notify('地图已保存。返回战场，开始新局或重新开始后应用。'); }
    catch (error) { notify(error.message, true); }
  });
  $('#map-export').addEventListener('click', () => {
    const result = validateMap(draft);
    if (result.ok && !invalidInputs.size) downloadJSON(result.value, 'prism-map.json'); else notify(result.errors[0] || '请修正无效属性。', true);
  });
  $('#map-import').addEventListener('click', () => $('#map-file').click());
  $('#map-file').addEventListener('change', async event => {
    const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
    if (file.size > 1024 * 1024) { notify('地图文件过大，上限为 1 MB。', true); return; }
    try { load(createMap(JSON.parse(await file.text())), `已将 ${file.name} 载入地图草稿。保存后用于下一局。`); }
    catch (error) { notify(`地图导入失败：${error instanceof SyntaxError ? '不是有效的 JSON 文件。' : error.message}`, true); }
  });
  $('#map-check-routes').addEventListener('click', () => {
    const result = validateMap(draft); if (!result.ok || invalidInputs.size) return;
    const world = new World({ ai: false, map: result.value }), radius = 23;
    const bases = [0, 1].map(team => { const base = world.base(team), other = world.base(1 - team), angle = Math.atan2(other.y - base.y, other.x - base.x); return world.freePosition(base.x + Math.cos(angle) * 130, base.y + Math.sin(angle) * 130, radius); });
    const connected = bases.every(Boolean) && world.findPath({ ...bases[0], r: radius }, bases[1]).length > 0;
    const unreachable = [];
    for (let team = 0; team < 2; team++) {
      for (const item of objects().filter(item => ['cache', 'core', 'capture'].includes(item.kind))) {
        const target = world.freePosition(item.data.x, item.data.y, radius);
        if (!bases[team] || !target || !world.findPath({ ...bases[team], r: radius }, target).length) unreachable.push(`${team ? '敌方' : '我方'} → ${item.label}`);
      }
    }
    const warnings = [...(!connected ? ['双方出生区之间没有可供重型战车通过的路线。'] : []), ...(unreachable.length ? [`资源通路不可达：${unreachable.slice(0, 5).join('、')}${unreachable.length > 5 ? '…' : ''}。`] : [])];
    const output = $('#map-route-result'); output.hidden = false; output.classList.toggle('warning', warnings.length > 0);
    output.textContent = warnings.length ? `通路提示：${warnings.join('')}仍可保存此布局。` : '通路检查通过：双方出生区相连，且双方均可到达所有中立目标附近。按重装战车半径 23 米检查，不计后续建造的建筑。';
  });
  document.addEventListener('keydown', event => {
    if ($('#map-view').hidden || /INPUT|SELECT|TEXTAREA/.test(event.target.tagName)) return;
    const key = event.key.toLowerCase();
    if (key === 'escape') { endDrag(null, true); setTool('select'); return; }
    if (event.ctrlKey || event.metaKey) {
      if (key === 'z' || key === 'y') { event.preventDefault(); history(key === 'y' || event.shiftKey ? 'redo' : 'undo'); }
      if (key === 'd') { event.preventDefault(); duplicate(); }
      return;
    }
    if (key === 'v') setTool('select');
    if (key === 'delete' || key === 'backspace') { event.preventDefault(); if (vertex !== null) removeVertex(); else deleteObject(); }
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) && selectedObject()) {
      event.preventDefault(); const amount = event.shiftKey ? 50 : $('#map-snap').checked ? 10 : 1;
      const dx = event.key === 'ArrowLeft' ? -amount : event.key === 'ArrowRight' ? amount : 0, dy = event.key === 'ArrowUp' ? -amount : event.key === 'ArrowDown' ? amount : 0;
      mutate(() => { const object = selectedObject(); if (vertex !== null && object.data.points) { object.data.points = object.data.points.map((p, i) => i === vertex ? [clamp(p[0] + dx, BOUNDS.left, BOUNDS.right), clamp(p[1] + dy, BOUNDS.top, BOUNDS.bottom)] : p); object.data.label = mapObjectCenter(object); } else moveMapObject(draft, selected, dx, dy); });
    }
  });
  window.addEventListener('storage', event => {
    if (event.key !== MAP_KEY && event.key !== null) return;
    const hadDraft = isDirty(); saved = readSavedMap();
    if (hadDraft) { updateStatus(); notify('另一个页面更新了地图。当前草稿已保留；“恢复已保存”可读取新版。'); }
    else { draft = createMap(saved || DEFAULT_MAP); undo = []; redo = []; selected = 'base:0'; vertex = null; invalidInputs.clear(); invalidateRoutes(); render(); }
  });
  new ResizeObserver(() => { if (!$('#map-view').hidden) draw(); }).observe(svg);
  render();
  return { isDirty };
}
