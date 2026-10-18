// WAV 编解码 / 重采样 / base64（纯浏览器实现，无第三方依赖）

export interface PcmData {
  /** 16bit 小端单声道 PCM 字节流 */
  pcm: Uint8Array;
  sampleRate: number;
  channels: number;
  durationSec: number;
}

/** Float32 采样 [-1,1] → 16bit PCM 字节 */
export function floatToPcm16(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return out;
}

/** 16bit PCM 字节 → Float32 采样 */
export function pcm16ToFloat(pcm: Uint8Array): Float32Array {
  const count = Math.floor(pcm.byteLength / 2);
  const out = new Float32Array(count);
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  for (let i = 0; i < count; i++) out[i] = view.getInt16(i * 2, true) / 0x8000;
  return out;
}

/** Float32 采样 → WAV Blob（16bit 单声道） */
export function encodeWav(samples: Float32Array, sampleRate: number, channels = 1): Blob {
  const pcm = floatToPcm16(samples);
  const dataSize = pcm.byteLength;
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true); // byte rate
  view.setUint16(32, channels * 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);
  return new Blob([header, pcm.buffer as ArrayBuffer], { type: 'audio/wav' });
}

/** 拼接多段 Float32 */
export function concatFloat32(chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** 线性插值重采样 */
export function resampleLinear(samples: Float32Array, from: number, to: number): Float32Array {
  if (from === to || samples.length === 0) return samples;
  const ratio = to / from;
  const outLen = Math.max(1, Math.round(samples.length * ratio));
  const out = new Float32Array(outLen);
  const last = samples.length - 1;
  for (let i = 0; i < outLen; i++) {
    const pos = i / ratio;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = samples[Math.min(i0, last)];
    const b = samples[Math.min(i0 + 1, last)];
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/** 峰值归一化到目标幅度（默认 0.9），返回新数组 */
export function normalizePeak(samples: Float32Array, target = 0.9): Float32Array {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  if (peak <= 0.0001 || peak >= target) return samples;
  const gain = target / peak;
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] * gain;
  return out;
}

/** 解析 WAV → 16bit 单声道 PCM（多声道混为单声道） */
export async function wavBlobToPcm(blob: Blob): Promise<PcmData> {
  const buf = await blob.arrayBuffer();
  const view = new DataView(buf);
  if (view.byteLength < 44) throw new Error('音频文件过短，不是有效的 WAV');
  const tag = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (tag !== 'RIFF') throw new Error('不是有效的 WAV（缺少 RIFF 头）');

  let offset = 12;
  let sampleRate = 16000;
  let channels = 1;
  let bits = 16;
  let dataStart = -1;
  let dataSize = 0;

  while (offset + 8 <= view.byteLength) {
    const id = String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3),
    );
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      channels = view.getUint16(body + 2, true) || 1;
      sampleRate = view.getUint32(body + 4, true) || 16000;
      bits = view.getUint16(body + 14, true) || 16;
    } else if (id === 'data') {
      dataStart = body;
      dataSize = Math.min(size, view.byteLength - body);
      break;
    }
    offset = body + size + (size % 2);
  }

  if (dataStart < 0) throw new Error('WAV 中未找到 data 段');
  if (bits !== 16) throw new Error(`仅支持 16bit PCM，当前为 ${bits}bit`);

  const frameCount = Math.floor(dataSize / (2 * channels));
  const mono = new Uint8Array(frameCount * 2);
  const outView = new DataView(mono.buffer);
  for (let f = 0; f < frameCount; f++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += view.getInt16(dataStart + (f * channels + c) * 2, true);
    outView.setInt16(f * 2, Math.max(-32768, Math.min(32767, Math.round(sum / channels))), true);
  }
  return { pcm: mono, sampleRate, channels: 1, durationSec: frameCount / sampleRate };
}

/** 生成静音 WAV（用于接口连通性测试） */
export function silenceWav(durationSec = 0.6, sampleRate = 16000): Blob {
  const samples = new Float32Array(Math.round(durationSec * sampleRate));
  return encodeWav(samples, sampleRate);
}

/** 生成一段带轻微人声包络的正弦波 WAV（部分接口拒绝纯静音时用于连通性测试） */
export function toneWav(durationSec = 1.0, sampleRate = 16000, freq = 220): Blob {
  const n = Math.round(durationSec * sampleRate);
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const env = Math.min(1, t / 0.05, (durationSec - t) / 0.1);
    samples[i] = Math.sin(2 * Math.PI * freq * t) * 0.25 * Math.max(0, env);
  }
  return encodeWav(samples, sampleRate);
}

/** Uint8Array → base64（分块，避免大数组触发调用栈溢出） */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(binary);
}

/** base64 → Uint8Array */
export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** ArrayBuffer → base64 */
export const arrayBufferToBase64 = (buf: ArrayBuffer): string => bytesToBase64(new Uint8Array(buf));

/** Blob → data URL */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('读取录音失败'));
    reader.readAsDataURL(blob);
  });
}

/** Blob → 纯 Base64 字符串（去掉 data:audio/wav;base64, 前缀），用于 OpenAI 原生 input_audio */
export async function blobToBase64(blob: Blob): Promise<string> {
  const dataUrl = await blobToDataUrl(blob);
  const comma = dataUrl.indexOf(',');
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

export const fmtBytes = (n: number): string => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.round(n / 1024)}KB`);
