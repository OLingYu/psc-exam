import { concatFloat32, encodeWav } from './wav';

export interface RecordingResult {
  wav: Blob;
  durationSec: number;
  sampleRate: number;
  peak: number;
}

export interface MicDevice {
  deviceId: string;
  label: string;
}

const BUFFER_SIZE = 4096;

/**
 * 麦克风录音：采集单声道 PCM 并编码为 WAV。
 * 默认以 16kHz 采集（讯飞 ISE 要求 16k/16bit/单声道），浏览器不支持时退回原生采样率，
 * 送评前再做一次重采样。
 */
export class Recorder {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private silent: GainNode | null = null;
  private chunks: Float32Array[] = [];
  private level = 0;
  private peak = 0;
  private startedAt = 0;
  private rawMic = false;

  readonly supported =
    typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia) && typeof AudioContext !== 'undefined';

  getLevel(): number {
    return this.level;
  }

  getPeak(): number {
    return this.peak;
  }

  get elapsedSec(): number {
    return this.startedAt ? (Date.now() - this.startedAt) / 1000 : 0;
  }

  get recording(): boolean {
    return Boolean(this.stream);
  }

  /** 列出可用麦克风（需要先获得一次权限，否则 label 为空） */
  static async listDevices(): Promise<MicDevice[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === 'audioinput')
      .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `麦克风 ${i + 1}` }));
  }

  /** 试音：申请权限并返回设备名 */
  async probe(deviceId?: string): Promise<string> {
    if (!this.supported) throw new Error('当前环境不支持麦克风采集（需要 HTTPS 或 127.0.0.1 访问）');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      video: false,
    });
    const track = stream.getAudioTracks()[0];
    const label = track?.label || '默认麦克风';
    track?.stop();
    return label;
  }

  async start(deviceId?: string, rawMic = false): Promise<void> {
    if (!this.supported) throw new Error('当前环境不支持麦克风采集（需要 HTTPS 或 127.0.0.1 访问）');
    if (this.stream) await this.stop();
    this.rawMic = rawMic;

    const constraints: MediaStreamConstraints = {
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        // rawMic=true 时关闭浏览器音效处理，尽量保留原始音质（真实评测更偏好）
        echoCancellation: !rawMic,
        noiseSuppression: !rawMic,
        autoGainControl: !rawMic,
        channelCount: 1,
      },
      video: false,
    };
    this.stream = await navigator.mediaDevices.getUserMedia(constraints);

    try {
      this.ctx = new AudioContext({ sampleRate: 16000 });
    } catch {
      this.ctx = new AudioContext();
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.processor = this.ctx.createScriptProcessor(BUFFER_SIZE, 1, 1);
    this.silent = this.ctx.createGain();
    this.silent.gain.value = 0; // 只采集不回放，避免啸叫

    this.chunks = [];
    this.level = 0;
    this.peak = 0;

    this.processor.onaudioprocess = (ev: AudioProcessingEvent) => {
      const input = ev.inputBuffer.getChannelData(0);
      const copy = new Float32Array(input.length);
      copy.set(input);
      this.chunks.push(copy);

      let sum = 0;
      let absMax = 0;
      for (let i = 0; i < input.length; i++) {
        const v = input[i];
        sum += v * v;
        const a = Math.abs(v);
        if (a > absMax) absMax = a;
      }
      const rms = Math.sqrt(sum / input.length);
      this.level = this.level * 0.7 + rms * 0.3;
      if (absMax > this.peak) this.peak = absMax;
    };

    this.source.connect(this.processor);
    this.processor.connect(this.silent);
    this.silent.connect(this.ctx.destination);
    this.startedAt = Date.now();
  }

  async stop(): Promise<RecordingResult> {
    const ctx = this.ctx;
    const stream = this.stream;
    const sampleRate = ctx?.sampleRate ?? 16000;

    try {
      if (this.processor) this.processor.onaudioprocess = null;
      this.processor?.disconnect();
      this.source?.disconnect();
      this.silent?.disconnect();
    } catch {
      /* noop */
    }
    stream?.getTracks().forEach((t) => t.stop());
    this.ctx = null;
    this.stream = null;
    this.processor = null;
    this.source = null;
    this.silent = null;

    const samples = concatFloat32(this.chunks);
    this.chunks = [];
    const durationSec = samples.length / sampleRate;
    const peak = this.peak;
    this.startedAt = 0;
    this.level = 0;

    if (ctx && ctx.state !== 'closed') {
      try {
        await ctx.close();
      } catch {
        /* noop */
      }
    }
    return { wav: encodeWav(samples, sampleRate), durationSec, sampleRate, peak };
  }

  cancel(): void {
    try {
      if (this.processor) this.processor.onaudioprocess = null;
      this.processor?.disconnect();
      this.source?.disconnect();
      this.silent?.disconnect();
    } catch {
      /* noop */
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => undefined);
    this.chunks = [];
    this.startedAt = 0;
    this.level = 0;
    this.ctx = null;
    this.stream = null;
    this.processor = null;
    this.source = null;
    this.silent = null;
  }

  get rawMicMode(): boolean {
    return this.rawMic;
  }
}
