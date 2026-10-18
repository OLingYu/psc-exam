import type { IseSettings } from '../types';
import { buildSignedWsUrl, bytesToBase64, explainXfyunError } from './xfyun';
import { floatToPcm16, normalizePeak, pcm16ToFloat, resampleLinear, wavBlobToPcm } from './wav';

/**
 * 讯飞「语音听写（流式版）」WebAPI —— 把录音转成文字
 *
 * 协议要点（依据官方 https://www.xfyun.cn/doc/asr/voicedictation/API.html）：
 *  wss://iat-api.xfyun.cn/v2/iat?authorization=..&host=..&date=..
 *  鉴权：与 ISE 相同的 HMAC-SHA256 签名（host + date + request-line）
 *  首帧带 common/business，后续帧只带 data：status=0 首帧 / 1 中间 / 2 结束
 *  音频：16k、16bit、单声道 raw PCM，每帧 1280 字节，建议间隔 40ms
 *  单次会话最长 60 秒 → 长录音按 ≤55 秒切片并发识别，再按顺序拼接
 *
 * 用途：命题说话没有参考文本，讯飞中文评测又不支持自由说，
 * 因此先把录音转写成文字，再用这段文字作为 ISE 的参考文本做发音评测。
 */

const IAT_HOST = 'iat-api.xfyun.cn';
const IAT_PATH = '/v2/iat';
const FRAME_BYTES = 1280;
const MAX_CHUNK_SEC = 55;
/** 发送间隔（毫秒）。官方建议 40ms，实测 20ms 仍可稳定识别，能明显缩短等待 */
const PACE_MS = 20;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface TranscribeOptions {
  settings: IseSettings;
  onProgress?: (note: string) => void;
  /** 单段超时 */
  timeoutMs?: number;
}

interface ChunkResult {
  index: number;
  text: string;
}

/** 识别一段 PCM（≤60 秒） */
function transcribeChunk(
  pcm: Uint8Array,
  appId: string,
  index: number,
  settings: IseSettings,
  timeoutMs: number,
): Promise<ChunkResult> {
  return new Promise<ChunkResult>((resolve, reject) => {
    void (async () => {
      let settled = false;
      const words: { sn: number; text: string }[] = [];
      let ws: WebSocket;
      let timer = 0;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
        } catch {
          /* noop */
        }
        fn();
      };

      try {
        const url = await buildSignedWsUrl({
          host: settings.iatHost.trim() || IAT_HOST,
          path: settings.iatPath.trim() || IAT_PATH,
          apiKey: settings.apiKey.trim(),
          apiSecret: settings.apiSecret.trim(),
        });
        ws = new WebSocket(url);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      timer = window.setTimeout(
        () => finish(() => reject(new Error(`语音听写超时（第 ${index + 1} 段，${Math.round(timeoutMs / 1000)} 秒）`))),
        timeoutMs,
      );

      ws.onerror = () => finish(() => reject(new Error('无法连接讯飞语音听写服务，请检查网络与凭据')));

      ws.onclose = () => {
        if (!settled) finish(() => reject(new Error(`语音听写连接中断（第 ${index + 1} 段）`)));
      };

      ws.onopen = async () => {
        try {
          const totalFrames = Math.max(1, Math.ceil(pcm.length / FRAME_BYTES));
          for (let i = 0; i < totalFrames; i++) {
            if (settled) return;
            const chunk = pcm.subarray(i * FRAME_BYTES, Math.min((i + 1) * FRAME_BYTES, pcm.length));
            const isFirst = i === 0;
            const isLast = i === totalFrames - 1;
            const frame: Record<string, unknown> = {
              data: {
                status: isLast ? 2 : isFirst ? 0 : 1,
                format: 'audio/L16;rate=16000',
                encoding: 'raw',
                audio: bytesToBase64(chunk),
              },
            };
            if (isFirst) {
              frame.common = { app_id: appId };
              frame.business = {
                language: 'zh_cn',
                domain: 'iat',
                accent: 'mandarin',
                eos: 3000,
                ptt: 1,
                nunum: 1,
                ltc: 1,
              };
            }
            ws.send(JSON.stringify(frame));
            await sleep(PACE_MS);
          }
          // 数据结束标识
          ws.send(JSON.stringify({ data: { status: 2 } }));
        } catch (err) {
          finish(() => reject(err instanceof Error ? err : new Error(String(err))));
        }
      };

      ws.onmessage = (ev: MessageEvent) => {
        try {
          const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '') as {
            code?: number;
            message?: string;
            data?: {
              status?: number;
              result?: { sn?: number; ls?: boolean; ws?: { cw?: { w?: string }[] }[] };
            };
          };
          const code = msg.code ?? 0;
          if (code !== 0) {
            finish(() => reject(new Error(explainXfyunError(code, msg.message))));
            return;
          }
          const result = msg.data?.result;
          if (result?.ws?.length) {
            const sn = result.sn ?? words.length;
            const text = result.ws.map((w) => (w.cw ?? []).map((c) => c.w ?? '').join('')).join('');
            words.push({ sn, text });
          }
          if (msg.data?.status === 2) {
            const text = words
              .slice()
              .sort((a, b) => a.sn - b.sn)
              .map((w) => w.text)
              .join('');
            finish(() => resolve({ index, text }));
          }
        } catch (err) {
          finish(() => reject(err instanceof Error ? err : new Error('听写结果解析失败')));
        }
      };
    })();
  });
}

/**
 * 长录音转写：切片 → 并发识别 → 按顺序拼接
 * （单段上限 55 秒，避开讯飞 60 秒会话限制）
 */
export async function transcribeWav(wav: Blob, opts: TranscribeOptions): Promise<string> {
  const { settings, onProgress } = opts;
  if (!settings.appId.trim() || !settings.apiKey.trim() || !settings.apiSecret.trim()) {
    throw new Error('未配置讯飞凭据（AppID / APIKey / APISecret）');
  }
  const timeoutMs = opts.timeoutMs ?? 90_000;

  const pcmData = await wavBlobToPcm(wav);
  let samples = pcm16ToFloat(pcmData.pcm);
  if (pcmData.sampleRate !== 16000) samples = resampleLinear(samples, pcmData.sampleRate, 16000);
  samples = normalizePeak(samples, 0.95);
  const pcm = floatToPcm16(samples);

  const bytesPerChunk = MAX_CHUNK_SEC * 32000; // 16k * 16bit = 32000 B/s
  const chunkCount = Math.max(1, Math.ceil(pcm.byteLength / bytesPerChunk));
  onProgress?.(`语音转写：共 ${chunkCount} 段，正在识别…`);

  const tasks: Promise<ChunkResult>[] = [];
  for (let i = 0; i < chunkCount; i++) {
    const slice = pcm.subarray(i * bytesPerChunk, Math.min((i + 1) * bytesPerChunk, pcm.byteLength));
    tasks.push(transcribeChunk(slice, settings.appId.trim(), i, settings, timeoutMs));
  }

  let done = 0;
  const results = await Promise.all(
    tasks.map((p) =>
      p.then((r) => {
        done += 1;
        onProgress?.(`语音转写：${done}/${chunkCount} 段完成`);
        return r;
      }),
    ),
  );

  const text = results
    .sort((a, b) => a.index - b.index)
    .map((r) => r.text.trim())
    .filter(Boolean)
    .join('');

  if (!text) throw new Error('语音听写没有识别出任何文字（录音可能为静音或噪声过大）');
  return text;
}

/** 中文文本 → 去掉标点后的纯汉字数（用于判断转写是否可用） */
export function countHanzi(text: string): number {
  return (text.match(/[\u4e00-\u9fa5]/g) ?? []).length;
}

export { MAX_CHUNK_SEC };
