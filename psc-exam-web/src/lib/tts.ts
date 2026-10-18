import type { TtsSettings } from '../types';

/**
 * 本地 TTS —— 全部考试提示音（考前说明、各项指导语、开始/结束提示、剩余时间播报）
 * 都在本机生成，不依赖任何云端合成服务：
 *   engine = 'builtin' → 浏览器内置 speechSynthesis（Windows/macOS 自带本地语音，完全离线）
 *   engine = 'http'    → 本机运行的 TTS 服务（piper / edge-tts / sherpa-onnx / PaddleSpeech 等），
 *                        URL 与请求体中以 {text} 作为占位符
 *   engine = 'off'     → 关闭提示音
 */

let lastError: Error | null = null;
export const getTtsError = (): Error | null => lastError;
export const clearTtsError = (): void => {
  lastError = null;
};

export const builtinSupported = (): boolean => typeof window !== 'undefined' && 'speechSynthesis' in window;

export interface VoiceOption {
  voiceURI: string;
  name: string;
  lang: string;
  localService: boolean;
}

/** 列出本机可用语音，中文优先 */
export function listVoices(): VoiceOption[] {
  if (!builtinSupported()) return [];
  const voices = window.speechSynthesis.getVoices();
  const zh = voices.filter((v) => v.lang.toLowerCase().startsWith('zh'));
  const others = voices.filter((v) => !v.lang.toLowerCase().startsWith('zh'));
  return [...zh, ...others].map((v) => ({
    voiceURI: v.voiceURI,
    name: v.name,
    lang: v.lang,
    localService: v.localService,
  }));
}

export function hasLocalChineseVoice(): boolean {
  return listVoices().some((v) => v.lang.toLowerCase().startsWith('zh') && v.localService);
}

/** 优先普通话（zh-CN）、其次任意中文的本地语音：安卓上语音列表里常同时有 zh-TW / zh-CN */
export function preferredChineseVoice(): VoiceOption | undefined {
  const all = listVoices();
  const localFirst = [...all.filter((v) => v.localService), ...all.filter((v) => !v.localService)];
  return (
    localFirst.find((v) => /^zh[-_]?cn/i.test(v.lang)) ??
    localFirst.find((v) => /^cmn[-_]?cn/i.test(v.lang)) ??
    localFirst.find((v) => v.lang.toLowerCase().startsWith('zh'))
  );
}

let voicesReady: Promise<void> | null = null;
/** speechSynthesis 的语音列表是异步加载的 */
export function waitForVoices(): Promise<void> {
  if (!builtinSupported()) return Promise.resolve();
  if (window.speechSynthesis.getVoices().length > 0) return Promise.resolve();
  if (!voicesReady) {
    voicesReady = new Promise((resolve) => {
      const done = () => {
        window.speechSynthesis.removeEventListener('voiceschanged', done);
        resolve();
      };
      window.speechSynthesis.addEventListener('voiceschanged', done);
      setTimeout(resolve, 1500);
    });
  }
  return voicesReady;
}

/** 本地合成的“叮”提示音（WebAudio，不消耗任何网络/语音服务） */
export function playBeep(freq = 880, durationMs = 200, volume = 0.32): Promise<void> {
  try {
    const Ctx =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return Promise.resolve();
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(volume, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + durationMs / 1000);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + durationMs / 1000 + 0.05);
    osc.onended = () => ctx.close().catch(() => undefined);
    return new Promise((resolve) => setTimeout(resolve, durationMs + 60));
  } catch {
    return Promise.resolve();
  }
}

/** “嘟—嘟”两短音，用于开考/收卷提示 */
export async function playDoubleBeep(): Promise<void> {
  await playBeep(880, 160, 0.3);
  await new Promise((r) => setTimeout(r, 90));
  await playBeep(1180, 220, 0.3);
}

const splitSentences = (text: string): string[] => {
  const parts = text
    .replace(/\s+/g, ' ')
    .split(/(?<=[。！？；!?;])/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts : [text];
};

function safeJsonObject(text: string): Record<string, string> {
  try {
    const v = JSON.parse(text || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/* ---------------------------- 可中断的播报 ----------------------------
 * 考试里点「继续 / 开始答题 / 下一项」时，正在播报的指导语要立刻停下，
 * 不能盖住录音或让考生等它念完。做法：
 *   - generation：每次 stopSpeaking() 自增，排队中的后续句子直接丢弃；
 *   - cancelHooks：正在播的那一句注册一个「立刻结算」的回调（内置语音/HTTP 音频/请求都适用）；
 *   - 取消属于正常结束（不写 lastError，不抛错给调用方）。
 */
let generation = 0;
const cancelHooks = new Set<() => void>();
let httpAudio: HTMLAudioElement | null = null;
let httpObjectUrl: string | null = null;
/** 串行播放队列，保证提示语按顺序播完 */
let chain: Promise<unknown> = Promise.resolve();

function releaseHttpAudio(): void {
  const audio = httpAudio;
  const url = httpObjectUrl;
  httpAudio = null;
  httpObjectUrl = null;
  if (audio) {
    try {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    } catch {
      /* noop */
    }
  }
  if (url) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      /* noop */
    }
  }
}

/** 立刻停止所有提示音（内置语音 + HTTP TTS 音频），并丢弃排队中的句子 */
export function stopSpeaking(): void {
  generation += 1;
  const hooks = Array.from(cancelHooks);
  cancelHooks.clear();
  for (const fn of hooks) {
    try {
      fn();
    } catch {
      /* noop */
    }
  }
  if (builtinSupported()) {
    try {
      window.speechSynthesis.cancel();
    } catch {
      /* noop */
    }
  }
  releaseHttpAudio();
  chain = Promise.resolve();
}

function speakBuiltin(text: string, s: TtsSettings): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!builtinSupported()) {
      reject(new Error('当前浏览器不支持内置语音合成，请改用本机 HTTP TTS 服务'));
      return;
    }
    const synth = window.speechSynthesis;
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = 'zh-CN';
    const voices = window.speechSynthesis.getVoices();
    const chosen =
      voices.find((v) => v.voiceURI === s.voiceURI) ??
      voices.find((v) => v.lang.toLowerCase().startsWith('zh-cn')) ??
      voices.find((v) => v.lang.toLowerCase().startsWith('zh'));
    if (chosen) utter.voice = chosen;
    utter.rate = s.rate;
    utter.pitch = s.pitch;
    utter.volume = s.volume;

    let settled = false;
    let watchdog = 0;
    let onCancel: () => void = () => undefined;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      cancelHooks.delete(onCancel);
      fn();
    };
    // 被 stopSpeaking() 取消：按正常结束处理（Web 里 canceled/interrupted 也属于可恢复结束）
    onCancel = () => finish(() => resolve());
    cancelHooks.add(onCancel);
    // 少数浏览器不触发 onend，用看门狗兜底，绝不能卡住考试流程
    watchdog = window.setTimeout(() => finish(resolve), Math.max(8000, text.length * 420));
    utter.onend = () => finish(resolve);
    utter.onerror = (e) =>
      finish(() => {
        const err = (e as SpeechSynthesisErrorEvent).error;
        if (err === 'interrupted' || err === 'canceled' || err === 'not-allowed') resolve();
        else reject(new Error(`本地 TTS 播报失败：${err}`));
      });
    synth.speak(utter);
  });
}

async function speakHttp(text: string, s: TtsSettings): Promise<void> {
  if (!s.url.trim()) throw new Error('未配置本机 TTS 服务地址');
  const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const url = s.url.replace('{text}', encodeURIComponent(text));
  const headers: Record<string, string> = { ...safeJsonObject(s.headers) };
  const hasBody = s.method === 'POST' && s.body.trim().length > 0;
  if (hasBody && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = 'application/json;charset=utf-8';
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  const onCancel = () => {
    controller.abort();
    releaseHttpAudio();
  };
  cancelHooks.add(onCancel);
  try {
    const resp = await fetch(url, {
      method: hasBody ? 'POST' : s.method,
      headers,
      body: hasBody ? s.body.replace('{text}', escaped) : undefined,
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`本机 TTS 请求失败：HTTP ${resp.status}`);
    const blob = await resp.blob();
    if (!blob.size) throw new Error('本机 TTS 返回了空音频');
    const objectUrl = URL.createObjectURL(blob);
    httpObjectUrl = objectUrl;
    try {
      await new Promise<void>((resolve, reject) => {
        const audio = new Audio(objectUrl);
        httpAudio = audio;
        let settled = false;
        let onCancelAudio: () => void = () => undefined;
        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          cancelHooks.delete(onCancelAudio);
          fn();
        };
        onCancelAudio = () => {
          try {
            audio.pause();
          } catch {
            /* noop */
          }
          finish(() => resolve());
        };
        cancelHooks.add(onCancelAudio);
        audio.onended = () => finish(resolve);
        audio.onerror = () => finish(() => reject(new Error('本机 TTS 音频解码/播放失败')));
        audio.play().catch((e: unknown) => finish(() => reject(new Error(`播放被浏览器拦截：${(e as Error)?.message ?? e}`))));
      });
    } finally {
      releaseHttpAudio();
    }
  } catch (err) {
    // 被 stopSpeaking() 取消：静默结束，不算失败
    if ((err as Error)?.name === 'AbortError') return;
    throw err;
  } finally {
    clearTimeout(timer);
    cancelHooks.delete(onCancel);
  }
}

export function speak(text: string, s: TtsSettings): Promise<void> {
  if (s.engine === 'off' || !text.trim()) return Promise.resolve();
  const gen = generation;
  const task = chain.then(async () => {
    // 排队期间被取消（用户点了继续/开始答题）：直接跳过，不再出声
    if (gen !== generation) return;
    clearTtsError();
    const pieces = s.engine === 'builtin' ? splitSentences(text) : [text];
    for (const piece of pieces) {
      if (gen !== generation) return;
      if (s.engine === 'http') await speakHttp(piece, s);
      else await speakBuiltin(piece, s);
    }
  });
  chain = task.catch((err: unknown) => {
    // 取消导致的结束不算错误
    if (gen !== generation) return;
    lastError = err instanceof Error ? err : new Error(String(err));
  });
  return task;
}

/** 依次播报多条提示语；TTS 失败不阻断考试 */
export async function speakSequence(items: string[], s: TtsSettings): Promise<void> {
  for (const item of items) {
    try {
      await speak(item, s);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

/** 试听（设置页 / 首页用）：返回是否成功，并记录错误 */
export async function preview(text: string, s: TtsSettings): Promise<string> {
  clearTtsError();
  // 再点一次试听＝立即从头重播，而不是排在前一句后面等它念完
  stopSpeaking();
  try {
    if (s.engine === 'builtin') {
      await waitForVoices();
      await speakBuiltin(text, s);
    } else if (s.engine === 'http') {
      await speakHttp(text, s);
    } else {
      return '提示音已关闭';
    }
    return '试听成功';
  } catch (err) {
    lastError = err instanceof Error ? err : new Error(String(err));
    return lastError.message;
  }
}
