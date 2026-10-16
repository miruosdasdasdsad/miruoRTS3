import { validateBalance } from './balance.js';
import { validateMatchReport } from './telemetry.js';
import { validateMap } from './map-config.js';

export const BALANCE_KEY = 'prism.balance.v1';
export const REPORT_KEY = 'prism.match.latest.v1';
export const MAP_KEY = 'prism.map.v1';
const MAX_BYTES = 4 * 1024 * 1024;

function read(key, validate) {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (!raw || raw.length > MAX_BYTES) return null;
    const result = validate(JSON.parse(raw));
    return result.ok ? result.value : null;
  } catch { return null; }
}

function save(key, input, validate) {
  const result = validate(input);
  if (!result.ok) throw new Error(result.errors.join('；'));
  const raw = JSON.stringify(result.value);
  if (raw.length > MAX_BYTES) throw new Error('数据超过本地保存上限，请导出 JSON 保留本局。');
  if (!globalThis.localStorage) throw new Error('浏览器本地存储不可用，请使用 JSON 导出。');
  try { globalThis.localStorage.setItem(key, raw); }
  catch { throw new Error('本地存储空间不足或已被禁用，请使用 JSON 导出。'); }
  return result.value;
}

export const readSavedBalance = () => read(BALANCE_KEY, validateBalance);
export const saveBalance = balance => save(BALANCE_KEY, balance, validateBalance);
export const readLatestReport = () => read(REPORT_KEY, validateMatchReport);
export const saveReport = report => save(REPORT_KEY, report, validateMatchReport);
export const readSavedMap = () => read(MAP_KEY, validateMap);
export const saveMap = map => save(MAP_KEY, map, validateMap);
export function clearSavedBalance() {
  if (!globalThis.localStorage) throw new Error('浏览器本地存储不可用。');
  globalThis.localStorage.removeItem(BALANCE_KEY);
}

export function downloadJSON(value, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, value.kind === 'prism-rts-match' ? undefined : 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
