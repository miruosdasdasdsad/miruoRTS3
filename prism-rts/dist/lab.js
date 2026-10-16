import { DEFAULT_BALANCE, BALANCE_FIELDS, createBalance, validateBalance } from './balance.js';
import { validateMatchReport } from './telemetry.js';
import { BALANCE_KEY, REPORT_KEY, readSavedBalance, saveBalance, readLatestReport, downloadJSON } from './lab-storage.js';
import { initMapEditor } from './map-editor.js';

const $ = selector => document.querySelector(selector);
window.name = 'prism-lab';
const $$ = selector => [...document.querySelectorAll(selector)];
const escapeHTML = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const clone = value => JSON.parse(JSON.stringify(value));
const get = (object, path) => path.split('.').reduce((value, key) => value?.[key], object);
const set = (object, path, value) => { const keys = path.split('.'); keys.slice(0, -1).reduce((item, key) => item[key], object)[keys.at(-1)] = value; };
const number = (value, digits = 1) => Number.isFinite(value) ? value.toLocaleString('zh-CN', { maximumFractionDigits: digits }) : value === Infinity ? '∞' : '—';
const time = seconds => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
const unitTypes = Object.keys(DEFAULT_BALANCE.units);
const technologyTypes = Object.keys(DEFAULT_BALANCE.buildings).filter(type => DEFAULT_BALANCE.buildings[type].technology);
const fieldsByPath = new Map(BALANCE_FIELDS.map(field => [field.path, field]));
let saved = readSavedBalance();
let draft = createBalance(saved || {});
let rawValues = new Map();
let dirty = false;
let category = 'units';
let selected = { units: unitTypes[0], buildings: 'hq', technology: 'academy' };
let report = null;
let reportSource = 'local';
let reportSignature = '';
let metric = 'energy';
let sampleIndex = 0;
let chartScale = null;
let messageTimer;
const mapEditor = initMapEditor({ notify });

const shapePaths = {
  infantry: '<path d="m16 4 6 7-6 5-6-5Z"/><path d="m9 28 2-10h10l2 10M16 18v10"/>',
  tank: '<path d="M7 13h18v13H7zM4 13v13M28 13v13M11 13V9h10v4M16 9V2M11 19h10"/>',
  sniper: '<circle cx="16" cy="16" r="9"/><path d="M16 2v9m0 10v9M2 16h9m10 0h9m-17 0h6m-3-3v6"/>',
  rocketeer: '<path d="m19 3 6 6-13 13-6-6ZM16 6l6 6M6 16l-3 9 9-3M13 13l6 6M4 28l6-6"/>',
  striker: '<path d="m18 3-9 14h7l-2 12 11-17h-8ZM5 6h5M3 12h5M3 19h5"/>',
  scout: '<path d="m6 13 10-7 10 7v11H6ZM11 13h10M10 24v4m12-4v4M16 6V2M11 18h10"/>',
  heavyTank: '<path d="M6 12h20v15H6zM3 12v15M29 12v15M10 12V7h12v5M14 7V2m4 5V2M10 18h12M10 22h12"/>',
  artillery: '<path d="M6 19h20v7H6zM3 19v7m26-7v7M11 19l8-15 5 3-7 12M17 8l5 3M11 26v3m10-3v3"/>',
  tower: '<path d="M9 28h14l-3-16h-8ZM8 7h16v5H8zM16 7V2M5 4h5m12 0h5"/>',
  power: '<path d="m18 2-11 17h9l-2 11 12-18h-9Z"/>',
  hq: '<path d="m5 13 11-8 11 8v14H5ZM12 27V17h8v10M16 5V1M8 13h16"/>',
  cache: '<path d="m16 3 12 7v14l-12 7-12-7V10ZM4 10l12 7 12-7M16 17v14"/>',
  barracks: '<path d="m3 13 13-8 13 8M6 12v15h20V12M12 27V17h8v10M8 5h16"/>',
  factory: '<path d="M4 27V14l8-5v5l8-5v5h8v13ZM23 14V4h5v10M9 20h3m5 0h3m4 0h2"/>',
  academy: '<path d="m3 11 13-7 13 7-13 7ZM8 14v9q8 7 16 0v-9M29 11v12"/>',
  arsenal: '<path d="m16 3 11 5v9c0 7-11 12-11 12S5 24 5 17V8ZM11 16l4 4 7-9"/>',
  mobility: '<circle cx="16" cy="16" r="11"/><path d="m18 6-8 12h7l-2 9 8-14h-7M2 16h3m22 0h3"/>'
};
function icon(type, color = DEFAULT_BALANCE.units[type]?.color || DEFAULT_BALANCE.buildings[type]?.color || '#88e6c5') {
  return `<span class="unit-glyph" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none" stroke="${escapeHTML(color)}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${shapePaths[type] || shapePaths.hq}</svg></span>`;
}
function notify(message, error = false) {
  clearTimeout(messageTimer);
  const box = $('#message'); box.textContent = message; box.hidden = false; box.classList.toggle('error', error);
  messageTimer = setTimeout(() => { box.hidden = true; }, error ? 12000 : 6500);
}
function resetDraft(value) {
  draft = createBalance(value);
  rawValues = new Map(BALANCE_FIELDS.map(field => [field.path, String(get(draft, field.path))]));
  renderEditor(); refreshDraft();
}
function parseField(field, raw) {
  if (raw === undefined || raw.trim() === '') return { error: '请填写数值' };
  const value = Number(raw);
  if (!Number.isFinite(value)) return { error: '必须是有限数值' };
  if (value < field.min || value > field.max) return { error: `范围 ${field.min} 至 ${field.max}` };
  if (field.integer && !Number.isInteger(value)) return { error: '必须填写整数' };
  return { value };
}
function currentDraft() {
  const value = clone(draft), errors = [];
  for (const field of BALANCE_FIELDS) {
    const result = parseField(field, rawValues.get(field.path));
    if (result.error) errors.push(`${field.group} / ${field.label}：${result.error}`);
    else set(value, field.path, result.value);
  }
  return errors.length ? { ok: false, errors, value: null } : validateBalance(value);
}
function fieldMarkup(field) {
  const id = `field-${field.path.replaceAll('.', '-')}`;
  const parsed = parseField(field, rawValues.get(field.path));
  return `<div class="field"><label for="${id}">${escapeHTML(field.label)}</label><div class="field-input"><input id="${id}" data-path="${field.path}" type="number" inputmode="decimal" min="${field.min}" max="${field.max}" step="${field.step}" value="${escapeHTML(rawValues.get(field.path) ?? '')}" aria-invalid="${!!parsed.error}" aria-describedby="${id}-default ${id}-error"></div><small class="field-default" id="${id}-default">基准 ${get(DEFAULT_BALANCE, field.path)} · ${field.min}–${field.max}</small><span class="field-error" id="${id}-error">${escapeHTML(parsed.error || '')}</span></div>`;
}
function entityFields() {
  const prefix = category === 'technology' ? `buildings.${selected.technology}.technology.` : `${category}.${selected[category]}.`;
  return BALANCE_FIELDS.filter(field => category === 'economy' ? field.path.startsWith('economy.') : field.path.startsWith(prefix) && (category === 'technology' || !field.path.includes('.technology.')));
}
function renderEditor() {
  const content = $('#editor-content');
  content.setAttribute('aria-labelledby', `tab-${category}`);
  const fields = entityFields();
  if (category === 'economy') {
    content.innerHTML = `<div class="economy-detail"><div class="detail-heading"><span class="brand-mark" aria-hidden="true">◇</span><div><h3>独立核心经济</h3><p>每个核心保留自己的余额，产能不会在建筑之间自动共享。</p></div></div><div class="field-grid">${fields.map(fieldMarkup).join('')}</div><p class="editor-note">双方开局各有 3 个核心，之后取得的新核心从 0 能量开始。基础供电为每方电网固定供电；电场的额外供电在建筑页设置。据点奖励周期使用实际模拟时间。</p></div>`;
    return;
  }
  const types = category === 'units' ? unitTypes : category === 'technology' ? technologyTypes : Object.keys(DEFAULT_BALANCE.buildings);
  const type = selected[category];
  const entities = category === 'units' ? draft.units : draft.buildings;
  const definition = entities[type];
  const details = category === 'technology' ? definition.technology : definition;
  const advanced = fields.filter(field => ['infantryBonus', 'vehicleBonus', 'buildingBonus', 'incomingDamage', 'splash'].includes(field.path.split('.').at(-1)));
  const main = fields.filter(field => !advanced.includes(field));
  const description = category === 'units' ? definition.role : category === 'technology' ? `${details.description} · 研发需要已接入核心且电力充足` : definition.acceptsCore ? '可接入独立能量核心' : type === 'power' ? '提供电力，无需接入核心' : type === 'cache' ? '中立设施 · 摧毁后掉落未认领核心' : '无需接入能量核心';
  content.innerHTML = `<div class="editor-layout"><div class="entity-list" role="group" aria-label="选择${category === 'units' ? '兵种' : category === 'technology' ? '科技' : '建筑'}">${types.map(key => `<button class="entity-button ${key === type ? 'selected' : ''}" data-entity="${key}" aria-pressed="${key === type}">${icon(key)}<span>${escapeHTML(category === 'technology' ? entities[key].technology.name : entities[key].name)}<small class="entity-code">${escapeHTML(entities[key].en)}</small></span></button>`).join('')}</div><div class="entity-detail"><div class="detail-heading">${icon(type)}<div><h3>${escapeHTML(details.name)}</h3><p id="entity-description">${escapeHTML(description)}</p></div><span class="detail-code">${escapeHTML(definition.en)}</span></div><div class="field-grid">${main.map(fieldMarkup).join('')}</div>${advanced.length ? `<details class="advanced" open><summary>克制、减伤与范围伤害</summary><div class="field-grid">${advanced.map(fieldMarkup).join('')}</div></details>` : ''}<div id="entity-derived" class="derived-strip"></div>${category === 'technology' ? '<p class="editor-note">倍率直接作用于对应属性：火控影响伤害、装甲影响承伤、动力影响速度。承伤倍率越小越耐打；低于 1 的伤害或速度倍率会产生削弱。每种科技每方只研究一次。</p>' : ''}</div></div>`;
}
function productionInterval(unit, rate) { return Math.max(unit.time, unit.cost === 0 ? 0 : rate > 0 ? unit.cost / rate : Infinity); }
function refreshDraft() {
  const result = currentDraft();
  const baseline = saved || DEFAULT_BALANCE;
  dirty = BALANCE_FIELDS.some(field => { const parsed = parseField(field, rawValues.get(field.path)); return parsed.error || parsed.value !== get(baseline, field.path); });
  if (result.ok) draft = result.value;
  $('#save-state').textContent = !result.ok ? '存在无效数值' : dirty ? '未保存的草稿' : saved ? '已保存至本浏览器' : '平衡基准';
  $('#save-state').classList.toggle('dirty', dirty || !result.ok);
  $('#draft-status').textContent = !result.ok ? `${result.errors.length} 项数值需要修正` : dirty ? '草稿已修改' : '配置已就绪';
  $('#validation-summary').textContent = !result.ok ? result.errors[0] : dirty ? '保存后在下一局应用，当前局保持原配置。' : '所有改动需手动保存。';
  $('#save-balance').disabled = !result.ok;
  $('#export-balance').disabled = !result.ok;
  const economy = result.ok ? draft.economy : null;
  $('#balance-overview').innerHTML = [
    ['每核心产能', economy ? `+${number(economy.rate)}` : '—', '/ 秒', '3 个开局核心独立产能', '◇'],
    ['开局总储备', economy ? number(economy.startingEnergy * 3, 0) : '—', '能量', '每方 · 分布于 3 个核心', 'ϟ'],
    ['基础电力', economy ? number(economy.basePower, 0) : '—', '供给', '电场额外提供电力', '⌁'],
    ['据点奖励周期', economy ? time(economy.captureDuration) : '—', '', '独占据点 · 每周期 +1 核心', '◎']
  ].map(([label, value, unit, detail, symbol]) => statCard(label, value, unit, detail, symbol)).join('');
  $('#comparison-body').innerHTML = unitTypes.map(type => {
    const unit = draft.units[type], dps = unit.damage / unit.reload;
    const values = result.ok ? [number(dps), unit.cost ? number(dps / unit.cost * 100) : '免费', number(unit.hp / unit.incomingDamage, 0), number(unit.range, 0), `${number(productionInterval(unit, draft.economy.rate))} 秒`] : ['—', '—', '—', '—', '—'];
    return `<tr class="${category === 'units' && type === selected.units ? 'selected' : ''}"><td><span class="unit-name">${icon(type)}${escapeHTML(unit.name)}</span></td>${values.map((value, index) => `<td class="${index === 1 ? 'metric-high' : ''}">${value}</td>`).join('')}</tr>`;
  }).join('');
  const derived = $('#entity-derived');
  if (derived) {
    if (!result.ok) derived.innerHTML = '<span>修正无效数值后，更新派生指标。</span>';
    else if (category === 'units') {
      const unit = draft.units[selected.units], dps = unit.damage / unit.reload;
      derived.innerHTML = [['基础 DPS', number(dps)], ['对步兵 DPS', number(dps * unit.infantryBonus)], ['对战车 DPS', number(dps * unit.vehicleBonus)], ['对建筑 DPS', number(dps * unit.buildingBonus)], ['有效生命', number(unit.hp / unit.incomingDamage, 0)]].map(([label, value]) => `<span>${label}<strong>${value}</strong></span>`).join('');
      $('#entity-description').textContent = unit.role;
    } else if (category === 'buildings') {
      const building = draft.buildings[selected.buildings];
      derived.innerHTML = [['基础生命', number(building.hp, 0)], [building.power < 0 ? '额外供电' : '耗电', number(Math.abs(building.power), 0)], ...(building.damage !== undefined ? [['基础 DPS', number(building.damage / building.reload)]] : [])].map(([label, value]) => `<span>${label}<strong>${value}</strong></span>`).join('');
    } else {
      const technology = draft.buildings[selected.technology].technology;
      derived.innerHTML = `<span>研发后效果<strong>${escapeHTML(technology.description)}</strong></span>`;
      $('#entity-description').textContent = `${technology.description} · 研发需要已接入核心且电力充足`;
    }
  }
}
function statCard(label, value, unit, detail, symbol) { return `<article class="stat-card"><span class="stat-label">${escapeHTML(label)}</span><span class="stat-symbol" aria-hidden="true">${symbol}</span><strong class="stat-value">${value}<small>${escapeHTML(unit)}</small></strong><span class="stat-detail">${escapeHTML(detail)}</span></article>`; }
function changeCategory(next) {
  category = next;
  $$('[data-category]').forEach(button => { const active = button.dataset.category === next; button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1; });
  renderEditor(); refreshDraft();
}
function changeView(view, updateHash = true) {
  $('#balance-view').hidden = view !== 'balance'; $('#report-view').hidden = view !== 'report'; $('#map-view').hidden = view !== 'map';
  $$('[data-view]').forEach(button => { const active = button.dataset.view === view; button.classList.toggle('active', active); if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); });
  if (updateHash) history.replaceState(null, '', view === 'report' ? '#reports' : view === 'map' ? '#map' : '#balance');
}
function reportId(value) { return value ? `${value.matchId}:${value.duration}:${value.samples.length}:${value.events.at(-1)?.id || 0}:${value.debug.markers.length}:${value.result}` : ''; }
function loadLocalReport(force = false) {
  if (reportSource !== 'local' && !force) return;
  const next = readLatestReport();
  if (!force && reportId(next) === reportSignature) return;
  reportSource = 'local'; report = next; reportSignature = reportId(next); sampleIndex = Math.max(0, (next?.samples.length || 1) - 1); renderReport();
}
function renderReport() {
  $('#report-empty').hidden = !!report;
  $('#report-content').hidden = !report;
  $('#export-report').disabled = !report;
  if (!report) return;
  const last = report.samples.at(-1), own = last.teams[0], enemy = last.teams[1];
  const resultLabel = report.result === 'victory' ? '我方胜利' : report.result === 'defeat' ? '我方战败' : '对局快照 · 尚未结束';
  $('#report-title').textContent = resultLabel;
  $('#report-meta').textContent = `${{ easy: '休闲', normal: '标准', hard: '进阶' }[report.config.difficulty] || report.config.difficulty} AI · ${report.config.ai ? 'AI 已启用' : 'AI 已暂停'} · ${report.matchId}`;
  $('#report-source').textContent = reportSource === 'imported' ? '导入报告 · 固定查看' : '本地最新 · 自动同步';
  $('#report-debug').hidden = !report.debug.used;
  $('#report-debug').textContent = `此局使用过调试功能，曲线保留调试造成的变化。${report.debug.markers.length} 条调试记录已标记；请勿将它视为常规对局的平衡结论。`;
  const pair = (a, b) => `${number(a, 0)} <span class="enemy-value">/ ${number(b, 0)}</span>`;
  $('#report-kpis').innerHTML = [
    statCard('已记录时长', time(report.duration), '', `${report.samples.length} 个真实采样点`, '◷'),
    statCard('存活军力 · 我 / 敌', pair(own.army, enemy.army), '', `部队价值 ${number(own.armyValue, 0)} / ${number(enemy.armyValue, 0)}`, '⬡'),
    statCard('累计击杀 · 我 / 敌', pair(own.kills, enemy.kills), '', `累计生产 ${number(own.produced, 0)} / ${number(enemy.produced, 0)}`, '⌖'),
    statCard('核心数量 · 我 / 敌', pair(own.cores, enemy.cores), '', `每秒产能 ${number(own.income)} / ${number(enemy.income)}`, '◇'),
    statCard('建造厂耐久 · 我 / 敌', pair(Math.ceil(own.hqHp), Math.ceil(enemy.hqHp)), '', `累计消耗 ${number(own.spent, 0)} / ${number(enemy.spent, 0)}`, '▣')
  ].join('');
  $('#composition').innerHTML = last.teams.map((team, index) => `<div class="composition-team"><div class="team-heading ${index ? 'enemy' : ''}"><span>${index ? '敌方 / VIOLET' : '我方 / MINT'}</span><small>${team.army} UNITS</small></div><div class="composition-grid">${unitTypes.map(type => `<div class="composition-unit ${team.unitCounts[type] === 0 ? 'zero' : ''}">${icon(type)}<span class="unit-label">${escapeHTML(report.balance.units[type].name)}</span><strong>${team.unitCounts[type]}</strong></div>`).join('')}</div><p class="technology-line">已研究：<span>${team.technologies.length ? team.technologies.map(type => escapeHTML(report.balance.buildings[type].technology.name)).join(' · ') : '暂无'}</span></p></div>`).join('');
  const recentEvents = report.events.slice(-200).reverse();
  $('#events-count').textContent = report.events.length > 200 ? `最近 200 / ${report.events.length} 条` : `${report.events.length} 条记录`;
  $('#events').innerHTML = recentEvents.length ? recentEvents.map(event => `<li class="${escapeHTML(event.level)}"><time>${time(event.time)}</time>${event.kind === 'debug' ? '<span class="event-tag">调试</span>' : ''}${escapeHTML(event.text)}</li>`).join('') : '<li class="no-events">此报告还没有事件。</li>';
  $('#report-balance-note').textContent = `这份报告使用自己的数值快照；${report.sampling.eventsDropped ? `已舍弃 ${report.sampling.eventsDropped} 条早期事件；` : ''}当前草稿不会改写历史。`;
  drawChart();
}
function chartSeries() {
  const colors = ['#88e6c5', '#b3a0e9'];
  if (metric === 'power') return [0, 1].flatMap(team => [
    { team, field: 'powerSupply', label: `${team ? '敌方' : '我方'}供给`, color: colors[team] },
    { team, field: 'powerDemand', label: `${team ? '敌方' : '我方'}需求`, color: colors[team], dashed: true }
  ]);
  return [0, 1].map(team => ({ team, field: metric, label: team ? '敌方' : '我方', color: colors[team] }));
}
function niceMaximum(value) { if (value <= 0) return 1; const base = 10 ** Math.floor(Math.log10(value)); return Math.ceil(value / base * 2) / 2 * base; }
function drawChart() {
  if (!report) return;
  const svg = $('#match-chart'), series = chartSeries(), samples = report.samples;
  const left = 57, right = 933, top = 20, bottom = 261;
  const maximum = niceMaximum(Math.max(...samples.flatMap(sample => series.map(line => sample.teams[line.team][line.field]))));
  const start = samples[0].time, end = Math.max(start + 1, report.duration);
  const x = value => left + (value - start) / (end - start) * (right - left);
  const y = value => bottom - value / maximum * (bottom - top);
  chartScale = { left, right, top, bottom, start, end, x, y, series };
  const grid = Array.from({ length: 5 }, (_, index) => { const value = maximum * index / 4, yy = y(value); return `<line class="chart-grid" x1="${left}" x2="${right}" y1="${yy}" y2="${yy}"/><text class="chart-axis-label" x="${left - 12}" y="${yy + 4}" text-anchor="end">${number(value)}</text>`; }).join('');
  const ticks = Array.from({ length: 6 }, (_, index) => { const value = start + (end - start) * index / 5; return `<text class="chart-axis-label" x="${x(value)}" y="286" text-anchor="middle">${time(value)}</text>`; }).join('');
  const paths = series.map(line => `<path class="chart-path" stroke="${line.color}" ${line.dashed ? 'stroke-dasharray="5 5"' : ''} d="${samples.map((sample, index) => `${index ? 'L' : 'M'}${x(sample.time).toFixed(2)},${y(sample.teams[line.team][line.field]).toFixed(2)}`).join(' ')}"/>`).join('');
  svg.innerHTML = `<title>${{ energy: '核心总能量', army: '存活部队数量', cores: '核心数量', kills: '累计击杀', power: '电力供给与需求' }[metric]}随对局时间变化</title>${grid}${ticks}${paths}<g id="chart-marker"></g>`;
  svg.setAttribute('aria-label', `${report.samples.length} 个真实采样点，${{ energy: '双方核心总能量', army: '双方存活部队数量', cores: '双方核心数量', kills: '双方累计击杀', power: '双方电力供给与需求' }[metric]}随时间变化。使用下方滑块读取具体值。`);
  $('#chart-legend').innerHTML = series.map(line => `<span><i class="${line.team ? 'enemy' : ''} ${line.dashed ? 'dashed' : ''}"></i>${line.label}</span>`).join('');
  $('#sample-position').max = String(Math.max(0, samples.length - 1));
  $('#sample-position').disabled = samples.length < 2;
  const description = { energy: '双方所有核心余额之和；能量在游戏中仍分别储存。', army: '当前存活单位数量，不含建筑和核心；不同单位的战斗价值并不相同。', cores: '当前归属各方的核心数量。', kills: '累计击杀计数，采用游戏实际统计口径。', power: '实线表示供给，虚线表示需求；需求高于供给时，耗电建筑暂停。' }[metric];
  $('#chart-note').textContent = `${description} 采样间隔约 ${number(report.sampleInterval)} 秒${report.sampling.compactions ? `；长局已压缩 ${report.sampling.compactions} 次，保留首末样本` : ''}；折线连接采样点，悬停或拖动滑块可读数。${samples.length === 1 ? '目前仅一个真实采样点，尚无变化趋势。' : ''}`;
  inspectSample(Math.min(sampleIndex, samples.length - 1));
}
function inspectSample(index) {
  if (!report || !chartScale) return;
  sampleIndex = Math.max(0, Math.min(report.samples.length - 1, Math.round(index)));
  const sample = report.samples[sampleIndex], { x, y, top, bottom, series } = chartScale, xx = x(sample.time);
  $('#chart-marker').innerHTML = `<line class="chart-marker" x1="${xx}" x2="${xx}" y1="${top}" y2="${bottom}"/>${series.map(line => `<circle cx="${xx}" cy="${y(sample.teams[line.team][line.field])}" r="3.5" fill="${line.color}" stroke="#172026" stroke-width="2"/>`).join('')}`;
  $('#sample-position').value = String(sampleIndex);
  $('#sample-position').setAttribute('aria-valuetext', `${time(sample.time)}，${series.map(line => `${line.label} ${number(sample.teams[line.team][line.field])}`).join('，')}`);
  $('#sample-time').textContent = time(sample.time);
  $('#sample-values').innerHTML = metric === 'power' ? [0, 1].map(team => `<span class="${team ? 'enemy' : ''}">${team ? '敌' : '我'} ${number(sample.teams[team].powerSupply)} 供 / ${number(sample.teams[team].powerDemand)} 需</span>`).join('') : series.map(line => `<span class="${line.team ? 'enemy' : ''}">${line.label} ${number(sample.teams[line.team][line.field])}</span>`).join('');
}
function nearestSample(seconds) {
  let low = 0, high = report.samples.length - 1;
  while (low < high) { const middle = Math.floor((low + high) / 2); if (report.samples[middle].time < seconds) low = middle + 1; else high = middle; }
  return low > 0 && Math.abs(report.samples[low - 1].time - seconds) < Math.abs(report.samples[low].time - seconds) ? low - 1 : low;
}
async function importFile(input, kind) {
  const file = input.files?.[0]; input.value = '';
  if (!file) return;
  const maximum = kind === 'balance' ? 1024 * 1024 : 4 * 1024 * 1024;
  if (file.size > maximum) { notify(`${kind === 'balance' ? '配置' : '报告'}文件过大，上限为 ${maximum / 1024 / 1024} MB。`, true); return; }
  try {
    const content = await file.text();
    const value = JSON.parse(content);
    const result = kind === 'balance' ? validateBalance(value) : validateMatchReport(value);
    if (!result.ok) throw new Error(result.errors?.join('；') || result.error || '文件格式无效。');
    if (kind === 'balance') { resetDraft(result.value); notify(`已将 ${file.name} 载入草稿。保存后下一局生效。`); }
    else { report = result.value || result.report; reportSource = 'imported'; sampleIndex = report.samples.length - 1; renderReport(); changeView('report'); notify(`已打开 ${file.name}。导入报告固定显示，点击“本地最新”恢复自动同步。`); }
  } catch (error) { notify(`导入失败：${error instanceof SyntaxError ? '不是有效的 JSON 文件。' : error.message}`, true); }
}

$$('[data-view]').forEach(button => button.addEventListener('click', () => changeView(button.dataset.view)));
$$('[data-category]').forEach(button => button.addEventListener('click', () => changeCategory(button.dataset.category)));
$('.tabs').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const tabs = $$('[data-category]'), index = tabs.indexOf(document.activeElement); if (index < 0) return;
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  event.preventDefault(); tabs[next].focus(); changeCategory(tabs[next].dataset.category);
});
$('#editor-content').addEventListener('click', event => { const button = event.target.closest('[data-entity]'); if (button) { selected[category] = button.dataset.entity; renderEditor(); refreshDraft(); $(`[data-entity="${selected[category]}"]`)?.focus({ preventScroll: true }); } });
$('#editor-content').addEventListener('input', event => {
  const input = event.target.closest('[data-path]'); if (!input) return;
  rawValues.set(input.dataset.path, input.value);
  const parsed = parseField(fieldsByPath.get(input.dataset.path), input.value);
  input.setAttribute('aria-invalid', String(!!parsed.error));
  $(`#${input.id}-error`).textContent = parsed.error || '';
  refreshDraft();
});
$('#save-balance').addEventListener('click', () => {
  const result = currentDraft(); if (!result.ok) { notify(result.errors[0], true); return; }
  try { saved = saveBalance(result.value); resetDraft(saved); notify('配置已保存。返回游戏，开始新局或重新开始以应用这套数值。'); }
  catch (error) { notify(error.message, true); }
});
$('#restore-saved').addEventListener('click', () => { saved = readSavedBalance(); resetDraft(saved || {}); notify(saved ? '已恢复本浏览器保存的配置。' : '尚无已保存配置，已恢复平衡基准。'); });
$('#load-baseline').addEventListener('click', () => { resetDraft({}); notify('平衡基准已载入草稿。点击保存后，下一局使用基准数值。'); });
$('#import-balance').addEventListener('click', () => $('#balance-file').click());
$('#import-report').addEventListener('click', () => $('#report-file').click());
$('#balance-file').addEventListener('change', () => importFile($('#balance-file'), 'balance'));
$('#report-file').addEventListener('change', () => importFile($('#report-file'), 'report'));
$('#export-balance').addEventListener('click', () => { const result = currentDraft(); if (result.ok) downloadJSON(result.value, 'prism-balance.json'); else notify(result.errors[0], true); });
$('#export-report').addEventListener('click', () => { if (report) downloadJSON(report, `prism-match-${report.matchId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 70)}.json`); });
$('#latest-report').addEventListener('click', () => { loadLocalReport(true); notify(report ? '已切换到本地最新对局，自动同步已开启。' : '还没有可读取的本地对局，请先开始一局游戏。'); });
$('#use-report-balance').addEventListener('click', () => { if (report) { resetDraft(report.balance); changeView('balance'); notify('本局配置已载入草稿，保存后用于下一局。'); } });
$$('[data-metric]').forEach(button => button.addEventListener('click', () => { metric = button.dataset.metric; $$('[data-metric]').forEach(item => item.setAttribute('aria-pressed', String(item === button))); drawChart(); }));
$('#sample-position').addEventListener('input', event => inspectSample(Number(event.target.value)));
$('#match-chart').addEventListener('pointermove', event => {
  if (!report || !chartScale) return;
  const rect = event.currentTarget.getBoundingClientRect(), pointerX = (event.clientX - rect.left) / rect.width * 960;
  const { left, right, start, end } = chartScale;
  inspectSample(nearestSample(start + Math.max(0, Math.min(1, (pointerX - left) / (right - left))) * (end - start)));
});
window.addEventListener('hashchange', () => changeView(location.hash === '#reports' ? 'report' : location.hash === '#map' ? 'map' : 'balance', false));
window.addEventListener('beforeunload', event => { if (dirty || mapEditor.isDirty()) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('storage', event => {
  if (event.key === REPORT_KEY || event.key === null) loadLocalReport();
  if (event.key === BALANCE_KEY || event.key === null) {
    const hadDraft = dirty; saved = readSavedBalance();
    if (hadDraft) { refreshDraft(); notify('另一个页面更新了保存配置。当前草稿已保留；点击“恢复已保存”可读取新版。'); }
    else { resetDraft(saved || {}); notify('已同步另一个页面保存的配置。'); }
  }
});
window.addEventListener('focus', () => loadLocalReport());
document.addEventListener('visibilitychange', () => { if (!document.hidden) loadLocalReport(); });
setInterval(() => { if (!document.hidden) loadLocalReport(); }, 2500);
$$('a[href="./"]').forEach(link => {
  link.target = 'prism-battle';
  link.addEventListener('click', event => {
    // A normal named-target navigation would reload a live match. Reuse it
    // without navigation; only a newly created blank window needs the URL.
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const battle = window.open('', 'prism-battle');
    if (!battle) return;
    event.preventDefault();
    try {
      if (battle.location.href === 'about:blank') battle.location.href = new URL('./', location.href).href;
      battle.focus();
    } catch { window.open(new URL('./', location.href).href, 'prism-battle'); }
  });
});
resetDraft(draft);
loadLocalReport(true);
changeView(location.hash === '#reports' ? 'report' : location.hash === '#map' ? 'map' : 'balance', false);
