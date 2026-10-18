import type { ExamResult, HistoryItem, Settings } from '../types';
import { DEFAULT_ISE } from './ise';
import { DEFAULT_LLM } from './llm';

const SETTINGS_KEY = 'psc.settings.v2';
const HISTORY_KEY = 'psc.history.v2';
const RESULT_PREFIX = 'psc.result.v2.';

export const DEFAULT_SETTINGS: Settings = {
  ise: { ...DEFAULT_ISE },
  llm: { ...DEFAULT_LLM },
  tts: {
    engine: 'builtin',
    voiceURI: '',
    rate: 1,
    pitch: 1,
    volume: 1,
    url: 'http://127.0.0.1:8080/tts?text={text}',
    method: 'GET',
    headers: '',
    body: '{"text":"{text}"}',
  },
  exam: {
    prompts: true,
    warnSeconds: [60, 30, 10],
    countdownSec: 3,
    speakPrepSec: 30,
    rawMic: true,
    showPinyin: false,
  },
};

/** 深合并默认值，兼容旧版本配置 */
function merge<T>(defaults: T, patch: unknown): T {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return defaults;
  const out = { ...(defaults as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const dv = (defaults as Record<string, unknown>)[k];
    if (dv && typeof dv === 'object' && !Array.isArray(dv)) out[k] = merge(dv, v);
    else if (v !== undefined) out[k] = v;
  }
  return out as T;
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return merge(DEFAULT_SETTINGS, JSON.parse(raw));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* 忽略配额错误 */
  }
}

export function loadHistory(): HistoryItem[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as HistoryItem[]) : [];
  } catch {
    return [];
  }
}

export function saveHistory(items: HistoryItem[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, 50)));
  } catch {
    /* 忽略 */
  }
}

export function appendHistory(result: ExamResult): HistoryItem[] {
  const item: HistoryItem = {
    id: result.id,
    createdAt: result.createdAt,
    total: result.total,
    maxTotal: result.maxTotal,
    level: result.level,
    engineLabel: result.engineLabel,
    sections: result.sections.map((s) => ({
      key: s.key,
      title: s.title,
      score: s.score,
      maxScore: s.maxScore,
      durationSec: s.durationSec,
      engine: s.engine,
      comment: s.comment,
      errorMessage: s.errorMessage,
    })),
  };
  const list = [item, ...loadHistory()].slice(0, 50);
  saveHistory(list);
  return list;
}

export function removeHistory(id: string): HistoryItem[] {
  const list = loadHistory().filter((h) => h.id !== id);
  saveHistory(list);
  return list;
}

export function clearHistory(): void {
  try {
    localStorage.removeItem(HISTORY_KEY);
  } catch {
    /* noop */
  }
}

/** 完整成绩（含录音）只保存在内存 + sessionStorage 之外；这里按 id 暂存供成绩页刷新使用 */
export function stashResult(result: ExamResult): void {
  try {
    sessionStorage.setItem(RESULT_PREFIX + result.id, JSON.stringify(result));
    sessionStorage.setItem('psc.lastResultId', result.id);
  } catch {
    /* 超大时忽略 */
  }
}

export function readStashedResult(id: string): ExamResult | null {
  try {
    const raw = sessionStorage.getItem(RESULT_PREFIX + id);
    return raw ? (JSON.parse(raw) as ExamResult) : null;
  } catch {
    return null;
  }
}

export function lastResultId(): string | null {
  try {
    return sessionStorage.getItem('psc.lastResultId');
  } catch {
    return null;
  }
}
