import type { Issue, LlmSettings, ScoreItem, SectionKey, SectionResult, SectionSpec } from '../types';
import { SECTION_MAP } from './sections';
import { buildScorePrompt, SYSTEM_PROMPT } from './prompts';
import { blobToBase64, blobToDataUrl, encodeWav, normalizePeak, pcm16ToFloat, resampleLinear, wavBlobToPcm } from './wav';

/**
 * 外部大模型评分（当前用于「命题说话」这一无标准文本的分项）：
 *  - direct：把录音作为 input_audio / audio_url 交给多模态大模型，直接听录音按大纲评分
 *  - asr   ：先转写（外部 ASR 接口 或 讯飞语音听写）再由文本模型评分
 * 支持 OpenAI 兼容 Chat Completions 与 Anthropic Messages 两种协议。
 */

export const DEFAULT_LLM: LlmSettings = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: '',
  style: 'openai',
  chatPath: '/chat/completions',
  temperature: 0.2,
  timeoutMs: 120_000,
  audioMode: 'direct',
  audioStyle: 'input_audio',
  asrSource: 'endpoint',
  asrBaseUrl: 'https://api.openai.com/v1',
  asrApiKey: '',
  asrModel: 'whisper-1',
  extraHeaders: '',
  systemPrompt: '',
};

type ContentPart =
  | { type: 'text'; text: string }
  // format 只有 OpenAI 原生需要；百炼/DashScope 用 data URL 且不带 format
  | { type: 'input_audio'; input_audio: { data: string; format?: string } }
  | { type: 'audio_url'; audio_url: { url: string } };

const trimBase = (s: string): string => s.trim().replace(/\/+$/, '');

function joinUrl(baseUrl: string, path: string): string {
  const base = trimBase(baseUrl);
  if (!base) throw new Error('未配置模型接口 Base URL');
  if (/^https?:\/\//i.test(path)) return path;
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${base}${p}`;
}

function parseExtraHeaders(raw: string): Record<string, string> {
  if (!raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('必须是 JSON 对象');
    return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, String(val)]));
  } catch (err) {
    throw new Error(`额外请求头格式错误：${(err as Error).message}`);
  }
}

function buildHeaders(s: LlmSettings): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...parseExtraHeaders(s.extraHeaders) };
  if (s.style === 'anthropic') {
    if (s.apiKey.trim()) headers['x-api-key'] = s.apiKey.trim();
    headers['anthropic-version'] = headers['anthropic-version'] ?? '2023-06-01';
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
  } else if (s.apiKey.trim()) {
    headers.Authorization = `Bearer ${s.apiKey.trim()}`;
  }
  return headers;
}

async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ status: number; ok: boolean; text: string; json: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...init, signal: controller.signal });
    const text = await resp.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: resp.status, ok: resp.ok, text, json };
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw new Error(`模型接口请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
    throw new Error(`无法访问模型接口：${(err as Error).message}（请检查 Base URL、网络与接口是否允许跨域）`);
  } finally {
    clearTimeout(timer);
  }
}

const snippet = (text: string, n = 300): string => (text.length > n ? `${text.slice(0, n)}…` : text);

function extractAssistantText(json: unknown): string {
  const j = json as Record<string, unknown> | null;
  if (!j) return '';
  const content = j.content as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(content)) {
    const text = content
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => String(c.text))
      .join('\n');
    if (text) return text;
  }
  const choices = j.choices as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(choices) && choices.length) {
    const message = choices[0].message as Record<string, unknown> | undefined;
    const c = message?.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      return c
        .map((part) => (typeof part === 'object' && part && 'text' in part ? String((part as { text: unknown }).text) : ''))
        .join('');
    }
    if (typeof choices[0].text === 'string') return String(choices[0].text);
  }
  if (typeof j.output_text === 'string') return j.output_text;
  if (typeof j.response === 'string') return j.response;
  return '';
}

export interface ChatMessage {
  role: 'system' | 'user';
  content: string | ContentPart[];
}

/** 调用对话模型，返回文本 */
export async function callChat(settings: LlmSettings, messages: ChatMessage[]): Promise<string> {
  const url = joinUrl(
    settings.baseUrl,
    settings.chatPath || (settings.style === 'anthropic' ? '/v1/messages' : '/chat/completions'),
  );
  const headers = buildHeaders(settings);
  const model = settings.model.trim();
  if (!model) throw new Error('未配置模型名称（model）');

  let body: Record<string, unknown>;
  if (settings.style === 'anthropic') {
    const system = messages.filter((m) => m.role === 'system').map((m) => (typeof m.content === 'string' ? m.content : ''));
    body = {
      model,
      max_tokens: 2048,
      temperature: settings.temperature,
      system: system.filter(Boolean).join('\n\n') || undefined,
      messages: messages.filter((m) => m.role === 'user').map((m) => ({ role: 'user', content: m.content })),
    };
  } else {
    body = { model, messages, temperature: settings.temperature, stream: false };
  }

  const resp = await fetchJson(url, { method: 'POST', headers, body: JSON.stringify(body) }, settings.timeoutMs);
  if (!resp.ok) {
    const errMsg = (resp.json as { error?: { message?: string } } | null)?.error?.message;
    throw new Error(`模型接口返回 HTTP ${resp.status}${errMsg ? `：${errMsg}` : `：${snippet(resp.text)}`}`);
  }
  const text = extractAssistantText(resp.json);
  if (!text.trim()) throw new Error(`模型接口返回为空：${snippet(resp.text)}`);
  return text;
}

/** 录音预处理：转为 16k 单声道并做峰值归一化 */
export async function prepareWav(wav: Blob, sampleRate = 16000): Promise<Blob> {
  const pcm = await wavBlobToPcm(wav);
  let samples = pcm16ToFloat(pcm.pcm);
  if (pcm.sampleRate !== sampleRate) samples = resampleLinear(samples, pcm.sampleRate, sampleRate);
  samples = normalizePeak(samples, 0.95);
  return encodeWav(samples, sampleRate);
}

/**
 * 是否阿里云百炼 / DashScope 的 OpenAI 兼容模式端点。
 *
 * 这类端点的多模态音频只收 `input_audio`，且 `data` 必须是 **data URL**
 * （`data:audio/wav;base64,…`）；传裸 base64 会返回
 * 400 "The provided URL does not appear to be valid"，
 * 而 `audio_url` 类型它根本不支持。OpenAI 原生则相反：`input_audio.data` 要裸 base64 + `format`。
 */
export const isDashScopeCompatible = (baseUrl: string): boolean =>
  /dashscope|aliyun|qianwen|bailian|compatible-mode/i.test(baseUrl || '');

async function audioPart(settings: LlmSettings, wav16k: Blob): Promise<ContentPart> {
  if (isDashScopeCompatible(settings.baseUrl)) {
    // 百炼/DashScope：只支持 input_audio + data URL（audio_url 会被拒）
    return { type: 'input_audio', input_audio: { data: await blobToDataUrl(wav16k) } };
  }
  if (settings.audioStyle === 'audio_url') {
    const dataUrl = await blobToDataUrl(wav16k);
    return { type: 'audio_url', audio_url: { url: dataUrl } };
  }
  // OpenAI 原生：整段 WAV 的纯 base64 + format
  return { type: 'input_audio', input_audio: { data: await blobToBase64(wav16k), format: 'wav' } };
}

/** 语音转写（OpenAI 兼容 /audio/transcriptions） */
export async function transcribeWithEndpoint(settings: LlmSettings, wav: Blob): Promise<string> {
  const url = joinUrl(settings.asrBaseUrl.trim() || settings.baseUrl, '/audio/transcriptions');
  const key = settings.asrApiKey.trim() || settings.apiKey.trim();
  const model = settings.asrModel.trim();
  if (!model) throw new Error('未配置 ASR 模型（如 whisper-1）');

  const form = new FormData();
  form.append('file', wav, 'answer.wav');
  form.append('model', model);
  form.append('language', 'zh');
  form.append('response_format', 'json');

  const headers: Record<string, string> = { ...parseExtraHeaders(settings.extraHeaders) };
  if (key) headers.Authorization = `Bearer ${key}`;

  const resp = await fetchJson(url, { method: 'POST', headers, body: form }, settings.timeoutMs);
  if (!resp.ok) {
    const errMsg = (resp.json as { error?: { message?: string } } | null)?.error?.message;
    throw new Error(`语音转写接口返回 HTTP ${resp.status}${errMsg ? `：${errMsg}` : `：${snippet(resp.text)}`}`);
  }
  const text = ((resp.json as { text?: string } | null)?.text ?? '').trim();
  if (!text) throw new Error('语音转写结果为空');
  return text;
}

/** 从模型输出里抠出 JSON（容忍代码块、前后缀文字） */
export function extractJson(text: string): Record<string, unknown> {
  let body = text.trim();
  const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) body = fence[1].trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start >= 0 && end > start) body = body.slice(start, end + 1);
  try {
    const v = JSON.parse(body);
    if (v && typeof v === 'object') return v as Record<string, unknown>;
  } catch {
    /* 落到下面抛错 */
  }
  throw new Error(`模型输出不是有效的 JSON：${snippet(text, 200)}`);
}

function normalizeResult(
  raw: Record<string, unknown>,
  spec: SectionSpec,
  durationSec: number,
): { score: number; items: ScoreItem[]; comment: string; issues: Issue[]; warnings: string[] } {
  const scoreRaw = Number(raw.score ?? raw.total ?? NaN);
  if (!Number.isFinite(scoreRaw)) throw new Error('模型返回的 JSON 中缺少有效的 score 字段');
  const raw0 = Math.max(0, Math.min(spec.maxScore, Math.round(scoreRaw * 10) / 10));
  // 大纲：命题说话不满 30 秒，本项计 0 分
  const score = spec.key === 'speak' && durationSec < 30 ? 0 : raw0;

  const items: ScoreItem[] = Array.isArray(raw.items)
    ? (raw.items as Array<Record<string, unknown>>).slice(0, 12).map((it) => ({
        item: String(it.item ?? it.name ?? '扣分项'),
        count: Number.isFinite(Number(it.count)) ? Number(it.count) : undefined,
        deduction: Number.isFinite(Number(it.deduction ?? it.deduct)) ? Number(it.deduction ?? it.deduct) : 0,
        reason: String(it.reason ?? it.note ?? ''),
      }))
    : [];

  const issues: Issue[] = Array.isArray(raw.issues)
    ? (raw.issues as Array<Record<string, unknown>>).slice(0, 40).map((it) => ({
        at: String(it.at ?? it.position ?? ''),
        type: String(it.type ?? '问题'),
        note: String(it.note ?? it.reason ?? ''),
      }))
    : [];

  const comment = String(raw.comment ?? '').trim() || '（模型未给出评语）';
  const warnings: string[] = [];
  const overtime = durationSec - spec.limitSec;
  if (overtime > 0 && !items.some((i) => i.item.includes('超时'))) {
    items.push({
      item: '超时',
      deduction: spec.key === 'read' || overtime > 60 ? 1 : 0.5,
      reason: `实际用时 ${durationSec.toFixed(0)} 秒，超出限时 ${Math.round(overtime)} 秒`,
    });
  }
  if (spec.key === 'speak') {
    if (durationSec < 30) warnings.push('说话不足 30 秒，按大纲本项应计 0 分。');
    else if (durationSec < spec.limitSec - 60) warnings.push('说话未满 2 分钟，按大纲需扣缺时分。');
  }
  return { score, items, comment, issues, warnings };
}

export interface LlmScoreOptions {
  key: SectionKey;
  /** 参考文本（命题说话为话题名称，不做逐字比对） */
  refText: string;
  wav: Blob;
  durationSec: number;
  settings: LlmSettings;
  /** 已转写好的文本（走「先转写再评分」时由调用方提供） */
  transcript?: string;
  onProgress?: (note: string) => void;
  signal?: AbortSignal;
}

/** 由外部大模型给某一分项评分 */
export async function llmScoreSection(opts: LlmScoreOptions): Promise<SectionResult> {
  const { key, refText, wav, durationSec, settings, onProgress } = opts;
  const spec = SECTION_MAP[key];
  if (opts.signal?.aborted) throw new Error('已取消');

  onProgress?.('准备录音…');
  const prepared = await prepareWav(wav);
  let transcript = opts.transcript;

  if (settings.audioMode === 'asr' && !transcript) {
    onProgress?.('语音转写中…');
    transcript = await transcribeWithEndpoint(settings, prepared);
  }
  const useAudio = settings.audioMode === 'direct';
  if (useAudio && settings.style === 'anthropic') {
    throw new Error('Anthropic Messages 接口不支持音频输入，请把「命题说话评分方式」改为「先转写再评分」');
  }

  const prompt = buildScorePrompt({ spec, refText, durationSec, transcript, audioAttached: useAudio });
  const content: ContentPart[] = [{ type: 'text', text: prompt }];
  if (useAudio) content.push(await audioPart(settings, prepared));

  onProgress?.(useAudio ? '提交录音给大模型评分…' : '提交转写文本给大模型评分…');
  const text = await callChat(settings, [
    { role: 'system', content: settings.systemPrompt.trim() || SYSTEM_PROMPT },
    { role: 'user', content: useAudio ? content : prompt },
  ]);

  const normalized = normalizeResult(extractJson(text), spec, durationSec);
  return {
    key,
    title: spec.name,
    maxScore: spec.maxScore,
    score: normalized.score,
    limitSec: spec.limitSec,
    durationSec,
    comment: normalized.comment,
    items: normalized.items,
    issues: normalized.issues,
    engine: 'llm',
    rawScore: normalized.score,
    transcript,
    warnings: normalized.warnings.length ? normalized.warnings : undefined,
  };
}

/** 测试对话接口连通性 */
export async function testLlm(settings: LlmSettings): Promise<string> {
  const text = await callChat(settings, [{ role: 'user', content: '这是一条连通性测试，请只回复：OK' }]);
  return `对话接口连通正常（模型返回：${snippet(text, 40)}）`;
}

/** 测试外部 ASR 接口 */
export async function testAsr(settings: LlmSettings): Promise<string> {
  const { toneWav } = await import('./wav');
  const text = await transcribeWithEndpoint(settings, toneWav(0.8, 16000, 220));
  return `语音转写接口连通正常（返回：${snippet(text, 40)}）`;
}
