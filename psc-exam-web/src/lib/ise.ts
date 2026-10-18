import type { ExamPaper, IseCategory, IseSettings, Issue, ScoreItem, SectionKey, SectionResult } from '../types';
import { SECTION_MAP } from './sections';
import { base64ToUtf8, buildSignedWsUrl, bytesToBase64, explainXfyunError } from './xfyun';
import { floatToPcm16, normalizePeak, pcm16ToFloat, resampleLinear, wavBlobToPcm } from './wav';

/**
 * 讯飞「语音评测（流式版）」WebAPI —— 普通话发音评测
 *
 * 协议要点（依据附件 ise-api 文档整理）：
 *  wss://ise-api.xfyun.cn/v2/open-ise?authorization=..&host=..&date=..
 *  鉴权：HMAC-SHA256(apiSecret, "host: {host}\ndate: {date}\nGET {path} HTTP/1.1") → base64
 *  帧序列：ssb（参数帧，data.status=0）→ auw（音频帧，aus=1/2/4，首帧 status=1、末帧 status=2）
 *  音频：16kHz / 16bit / 单声道，raw PCM，会话总时长 ≤ 5 分钟
 *  响应：{code, message, sid, data:{status, data: base64(XML)}}，status=2 为最终结果
 */

export const DEFAULT_ISE: IseSettings = {
  appId: '',
  apiKey: '',
  apiSecret: '',
  host: 'ise-api.xfyun.cn',
  path: '/v2/open-ise',
  iatHost: 'iat-api.xfyun.cn',
  iatPath: '/v2/iat',
  ent: 'cn_vip',
  category: 'auto',
  group: 'adult',
  checkType: 'common',
  extraAbility: 'multi_dimension;syll_phone_err_msg',
  rst: 'entirety',
  iseUnite: '1',
  gain: 0.9,
};

export const ISE_CATEGORY_LABEL: Record<Exclude<IseCategory, 'auto'>, string> = {
  read_syllable: '单字朗读 read_syllable',
  read_word: '词语朗读 read_word',
  read_sentence: '句子朗读 read_sentence',
  read_chapter: '篇章朗读 read_chapter',
};

/** 按分项自动选择评测题型（评测类型为 auto 时） */
export function iseCategoryFor(key: SectionKey, settings: IseSettings): Exclude<IseCategory, 'auto'> {
  if (settings.category !== 'auto') return settings.category;
  switch (key) {
    case 'mono':
      return 'read_syllable';
    case 'poly':
      return 'read_word';
    case 'read':
      return 'read_chapter';
    case 'speak':
      return 'read_chapter';
  }
}

/**
 * 组装送评参考文本：
 *  - 单音节：100 个汉字以「，」分隔（文档推荐分隔符，单行 ≤100 字）
 *  - 多音节：词语以「，」分隔
 *  - 朗读短文：取「∥」之前（即大纲规定的 400 音节）的文本，保留标点
 *  - 命题说话：以话题文本作参照（无标准文本，仅供参考；正常应由大模型评分）
 */
export function iseRefText(key: SectionKey, paper: ExamPaper): string {
  switch (key) {
    case 'mono':
      return paper.mono.map((c) => c.c).join('，');
    case 'poly':
      return paper.poly.map((w) => w.w).join('，');
    case 'read': {
      const marker = paper.read.text.indexOf('∥');
      const body = marker >= 0 ? paper.read.text.slice(0, marker) : paper.read.text;
      return body.replace(/\s+/g, '').trim();
    }
    case 'speak':
      return paper.speak[0];
  }
}

export interface IsePhone {
  content: string;
  isYun: boolean;
  perrMsg: number;
  perrLevel: number;
  monoTone: string;
}

export interface IseWord {
  content: string;
  symbol: string;
  dpMessage: number;
  nodeType: string;
  phones: IsePhone[];
}

export interface IseRawResult {
  /** 引擎总分 0~100 */
  totalScore: number;
  /** 维度分（声韵/调型/流利度/完整度/准确度/整体印象），可能只返回部分 */
  dims: Record<string, number>;
  words: IseWord[];
  issues: Issue[];
  errorCount: number;
  defectCount: number;
  exceptInfo: number;
  isRejected: boolean;
  sid: string;
  xml: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const DP_MESSAGE_LABEL: Record<number, string> = {
  16: '漏读',
  32: '增读',
  64: '回读',
  128: '替换',
};

function num(v: string | null | undefined): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** 解析评测结果 XML（对成人句篇/字词题型的不同返回结构都做兜底） */
export function parseIseXml(xml: string, category: string): IseRawResult {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const parseError = doc.querySelector('parsererror');
  if (parseError) throw new Error('讯飞评测结果解析失败（XML 格式异常）');

  const root = doc.documentElement;
  const outer = (root.querySelector(category) ?? root.querySelector('rec_paper') ?? root) as Element;
  const paper = outer.querySelector('rec_paper') ?? outer;
  const inner =
    (paper.querySelector(category) as Element | null) ??
    (paper.querySelector('read_sentence, read_chapter, read_word, read_syllable') as Element | null) ??
    paper;

  const dims: Record<string, number> = {};
  const dimKeys = [
    'total_score',
    'phone_score',
    'tone_score',
    'fluency_score',
    'integrity_score',
    'accuracy_score',
    'emotion_score',
    'standard_score',
  ];
  for (const k of dimKeys) {
    const v = num(inner.getAttribute(k));
    if (v !== undefined) dims[k.replace('_score', '')] = v;
  }
  // 总分兜底：先找内层 total_score，再找任意节点
  let totalScore: number | undefined = dims.total;
  if (totalScore === undefined) {
    const anyScore = paper.querySelector('[total_score]');
    totalScore = num(anyScore?.getAttribute('total_score'));
  }
  if (totalScore === undefined) throw new Error('讯飞评测结果中没有找到 total_score');

  const issues: Issue[] = [];
  const words: IseWord[] = [];
  let errorCount = 0;
  let defectCount = 0;

  const wordNodes = Array.from(paper.querySelectorAll('word'));
  for (const wNode of wordNodes) {
    const nodeType = wNode.getAttribute('rec_node_type') ?? 'paper';
    if (nodeType === 'fil') continue; // 填充/噪声节点不是真实增读
    const content = wNode.getAttribute('content') ?? '';
    const symbol = wNode.getAttribute('symbol') ?? '';
    const syllNodes = Array.from(wNode.querySelectorAll('syll'));
    const phones: IsePhone[] = [];
    let wordDp = 0;

    for (const sNode of syllNodes) {
      const dp = num(sNode.getAttribute('dp_message')) ?? 0;
      const syllContent = sNode.getAttribute('content') ?? content;
      if (dp !== 0) {
        wordDp = dp;
        errorCount += 1;
        issues.push({
          at: syllContent || content || '（未识别）',
          type: DP_MESSAGE_LABEL[dp] ?? `异常(${dp})`,
          note: `${content}：引擎判定该音节${DP_MESSAGE_LABEL[dp] ?? '异常'}`,
        });
      }
      for (const pNode of Array.from(sNode.querySelectorAll('phone'))) {
        const isYun = pNode.getAttribute('is_yun') === '1';
        const perrMsg = num(pNode.getAttribute('perr_msg')) ?? 0;
        const perrLevel = num(pNode.getAttribute('perr_level_msg')) ?? 0;
        const mono = pNode.getAttribute('mono_tone') ?? '';
        phones.push({
          content: pNode.getAttribute('content') ?? '',
          isYun,
          perrMsg,
          perrLevel,
          monoTone: mono,
        });
        if (perrMsg !== 0 && dp === 0) {
          let type = '发音错误';
          if (!isYun) type = '声母错误';
          else if (perrMsg === 1) type = '韵母错误';
          else if (perrMsg === 2) type = '调型错误';
          else if (perrMsg === 3) type = '韵母与调型错误';
          if (perrLevel >= 3) defectCount += 1;
          else errorCount += 1;
          issues.push({
            at: syllContent || content || '（未识别）',
            type,
            note: `${content} 的音素 ${pNode.getAttribute('content') ?? '?'} ${
              perrLevel >= 3 ? '语音缺陷' : '语音错误'
            }（置信度 ${perrLevel || '-'}）`,
          });
        }
      }
    }
    words.push({ content, symbol, dpMessage: wordDp, nodeType, phones });
  }

  const exceptInfo = num(inner.getAttribute('except_info')) ?? 0;
  const isRejected = (inner.getAttribute('is_rejected') ?? 'false') === 'true';

  return {
    totalScore,
    dims,
    words,
    // 定位明细最多保留 40 条，避免长文本撑爆界面
    issues: issues.slice(0, 40),
    errorCount,
    defectCount,
    exceptInfo,
    isRejected,
    sid: '',
    xml,
  };
}

export interface IseEvaluateOptions {
  wav: Blob;
  refText: string;
  category: Exclude<IseCategory, 'auto'>;
  settings: IseSettings;
  onProgress?: (note: string) => void;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** 调用讯飞 ISE 完成一次评测 */
export async function iseEvaluate(opts: IseEvaluateOptions): Promise<IseRawResult> {
  const { wav, settings, onProgress } = opts;
  const category = opts.category;
  const timeoutMs = opts.timeoutMs ?? 90_000;
  if (!settings.appId.trim() || !settings.apiKey.trim() || !settings.apiSecret.trim()) {
    throw new Error('未配置讯飞 ISE 凭据（AppID / APIKey / APISecret）');
  }
  if (!opts.refText.trim()) throw new Error('缺少评测参考文本');
  if (opts.signal?.aborted) throw new Error('已取消');

  onProgress?.('解析录音…');
  const pcmData = await wavBlobToPcm(wav);
  let samples = pcm16ToFloat(pcmData.pcm);
  if (pcmData.sampleRate !== 16000) {
    samples = resampleLinear(samples, pcmData.sampleRate, 16000);
  }
  if (settings.gain > 0) samples = normalizePeak(samples, Math.min(0.95, settings.gain));
  const pcm = floatToPcm16(samples);

  onProgress?.('建立评测连接…');
  const url = await buildSignedWsUrl({
    host: settings.host.trim() || 'ise-api.xfyun.cn',
    path: settings.path.trim() || '/v2/open-ise',
    apiKey: settings.apiKey.trim(),
    apiSecret: settings.apiSecret.trim(),
  });

  const ws = new WebSocket(url);
  const result = await new Promise<IseRawResult>((resolve, reject) => {
    let settled = false;
    const parts: string[] = [];
    let sid = '';
    let closedByUs = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          closedByUs = true;
          ws.close();
        }
      } catch {
        /* noop */
      }
      fn();
    };

    const deadline = window.setTimeout(
      () => finish(() => reject(new Error(`讯飞评测超时（${Math.round(timeoutMs / 1000)} 秒未返回结果）`))),
      timeoutMs,
    );

    opts.signal?.addEventListener('abort', () => finish(() => reject(new Error('已取消'))), { once: true });

    ws.onerror = () => finish(() => reject(new Error('无法连接讯飞评测服务，请检查网络、host 与凭据')));

    ws.onclose = () => {
      if (!settled && !closedByUs) finish(() => reject(new Error('讯飞评测连接被关闭，且未收到最终结果')));
    };

    ws.onopen = async () => {
      try {
        const business: Record<string, unknown> = {
          sub: 'ise',
          ent: settings.ent,
          category,
          cmd: 'ssb',
          text: `\uFEFF${opts.refText}`,
          tte: 'utf-8',
          ttp_skip: true,
          aue: 'raw',
          auf: 'audio/L16;rate=16000',
          rstcd: 'utf8',
          rst: settings.rst,
          ise_unite: settings.iseUnite,
          group: settings.group,
          check_type: settings.checkType,
        };
        if (settings.extraAbility.trim()) business.extra_ability = settings.extraAbility.trim();
        ws.send(
          JSON.stringify({
            common: { app_id: settings.appId.trim() },
            business,
            data: { status: 0 },
          }),
        );

        // 音频分帧：1280 字节 = 40ms @ 16k/16bit/单声道
        const FRAME = 1280;
        const totalFrames = Math.max(1, Math.ceil(pcm.byteLength / FRAME));
        onProgress?.(`上传录音（共 ${Math.round(pcm.byteLength / 32000)} 秒）…`);
        for (let i = 0; i < totalFrames; i++) {
          if (settled) return;
          const isFirst = i === 0;
          const isLast = i === totalFrames - 1;
          const chunk = pcm.subarray(i * FRAME, Math.min((i + 1) * FRAME, pcm.byteLength));
          const aus = isLast ? 4 : isFirst ? 1 : 2;
          ws.send(
            JSON.stringify({
              business: { cmd: 'auw', aus, aue: 'raw' },
              data: { status: isLast ? 2 : 1, data: bytesToBase64(chunk) },
            }),
          );
          if (i % 10 === 9) {
            // 让出事件循环并等待发送缓冲回落，避免大音频把浏览器内存打满
            await sleep(3);
            let guard = 0;
            while (ws.bufferedAmount > 1_500_000 && guard++ < 400 && !settled) await sleep(20);
          }
        }
        onProgress?.('等待评测结果…');
      } catch (err) {
        finish(() => reject(err instanceof Error ? err : new Error(String(err))));
      }
    };

    ws.onmessage = (ev: MessageEvent) => {
      try {
        const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '') as {
          code?: number;
          message?: string;
          sid?: string;
          data?: { status?: number; data?: string };
        };
        if (msg.sid) sid = msg.sid;
        const code = msg.code ?? 0;
        if (code !== 0) {
          finish(() => reject(new Error(explainXfyunError(code, msg.message))));
          return;
        }
        if (msg.data?.data) parts.push(msg.data.data);
        if (msg.data?.status === 2) {
          const xml = parts.map((p) => base64ToUtf8(p)).join('');
          finish(() => {
            try {
              const parsed = parseIseXml(xml, category);
              resolve({ ...parsed, sid });
            } catch (err) {
              reject(err instanceof Error ? err : new Error(String(err)));
            }
          });
        }
      } catch (err) {
        finish(() => reject(err instanceof Error ? err : new Error('讯飞返回数据解析失败')));
      }
    };
  });

  if (result.exceptInfo !== 0 || result.isRejected) {
    const hint =
      result.isRejected || result.exceptInfo === 1
        ? '录音未通过引擎校验（可能存在静音、乱读、截断或噪声过大），本次评测分数仅供参考。'
        : '引擎提示音频存在异常（except_info=' + result.exceptInfo + '），本次评测分数仅供参考。';
    result.issues.unshift({ at: '整段录音', type: '提示', note: hint });
  }
  return result;
}

/** 讯飞原始分（0~100）→ 该项得分（按大纲满分折算） */
export function iseDerivedScore(raw: IseRawResult, key: SectionKey, durationSec: number): number {
  const spec = SECTION_MAP[key];
  let score = (spec.maxScore * Math.max(0, Math.min(100, raw.totalScore))) / 100;

  // 大纲超时规定（字词/朗读：超时 1 分钟内扣 0.5，1 分钟以上扣 1；朗读固定扣 1）
  const overtime = durationSec - spec.limitSec;
  if (overtime > 60) score -= 1;
  else if (overtime > 0) score -= 0.5;

  // 大纲处理「讲话不足」的缺时扣分
  if (key === 'speak') {
    const shortfall = spec.limitSec - durationSec;
    if (durationSec < 30) score = 0;
    else if (shortfall > 60) score -= 4.5;
    else if (shortfall > 0) score -= 2;
  }
  return Math.max(0, Math.min(spec.maxScore, Math.round(score * 10) / 10));
}

/** 把引擎扣分按大纲单价权重分摊成扣分明细（保证明细合计与得分一致） */
function buildItems(
  key: SectionKey,
  raw: IseRawResult,
  finalScore: number,
  durationSec: number,
): ScoreItem[] {
  const spec = SECTION_MAP[key];
  const totalDeduction = Math.round((spec.maxScore - finalScore) * 100) / 100;
  if (totalDeduction <= 0) return [];

  const unit = key === 'mono' ? 0.1 : key === 'poly' ? 0.2 : 0.1;
  const buckets: { item: string; weight: number; reason: string }[] = [];

  const completeness = raw.issues.filter((i) => ['漏读', '增读', '回读', '替换'].includes(i.type)).length;
  const pronunciation = raw.issues.filter((i) => i.type.includes('错误')).length;
  const defects = raw.issues.filter((i) => i.type.includes('缺陷')).length;

  if (pronunciation) {
    buckets.push({
      item: '语音错误（声韵调）',
      weight: pronunciation * unit,
      reason: `引擎定位到 ${pronunciation} 处声母/韵母/调型错误（大纲单价 ${unit} 分/音节）`,
    });
  }
  if (defects) {
    buckets.push({
      item: '语音缺陷',
      weight: defects * (unit / 2),
      reason: `引擎定位到 ${defects} 处语音缺陷（大纲单价 ${unit / 2} 分/音节）`,
    });
  }
  if (completeness) {
    buckets.push({
      item: '漏读/增读/回读',
      weight: completeness * unit,
      reason: `引擎定位到 ${completeness} 处完整性偏差（大纲单价 ${unit} 分/音节）`,
    });
  }
  const overtime = durationSec - spec.limitSec;
  if (overtime > 0) {
    buckets.push({
      item: '超时',
      weight: key === 'read' ? 1 : overtime > 60 ? 1 : 0.5,
      reason: `实际用时超出限时 ${Math.round(overtime)} 秒（大纲：${key === 'read' ? '超时扣 1 分' : '超时 1 分钟内扣 0.5 分，超过扣 1 分'}）`,
    });
  }
  if (key === 'speak') {
    const shortfall = spec.limitSec - durationSec;
    if (durationSec < 30) {
      buckets.push({ item: '说话不足 30 秒', weight: 1, reason: '大纲：说话不满 30 秒，本项成绩计 0 分' });
    } else if (shortfall > 60) {
      buckets.push({ item: '缺时', weight: 4.5, reason: `缺时 ${Math.round(shortfall)} 秒，大纲扣 4~6 分` });
    } else if (shortfall > 0) {
      buckets.push({ item: '缺时', weight: 2, reason: `缺时 ${Math.round(shortfall)} 秒，大纲扣 1~3 分` });
    }
  }
  // 声韵/调型/流利度维度造成的剩余失分
  if (buckets.length === 0) {
    buckets.push({
      item: '综合发音水平',
      weight: 1,
      reason: `引擎综合评分 ${raw.totalScore.toFixed(2)} 分（百分制），按大纲满分折算`,
    });
  } else {
    buckets.push({
      item: '语调/停连/流畅等综合表现',
      weight: Math.max(1, totalDeduction * 2),
      reason: '依据引擎准确度、流利度、完整度等维度综合折算',
    });
  }

  const totalWeight = buckets.reduce((s, b) => s + b.weight, 0);
  const items: ScoreItem[] = buckets.map((b) => ({
    item: b.item,
    deduction: Math.round(((totalDeduction * b.weight) / totalWeight) * 100) / 100,
    reason: b.reason,
  }));
  // 修正四舍五入误差，保证明细合计 = 总扣分
  const sum = items.reduce((s, i) => s + i.deduction, 0);
  const diff = Math.round((totalDeduction - sum) * 100) / 100;
  if (Math.abs(diff) >= 0.01 && items.length) {
    items[items.length - 1].deduction = Math.round((items[items.length - 1].deduction + diff) * 100) / 100;
  }
  return items;
}

const DIM_LABEL: Record<string, string> = {
  phone: '声韵',
  tone: '调型',
  fluency: '流利度',
  integrity: '完整度',
  accuracy: '准确度',
  emotion: '整体印象',
  standard: '标准度',
};

export function iseDimLabel(key: string): string {
  return DIM_LABEL[key] ?? key;
}

/** 讯飞评测结果 → 单项成绩 */
export function iseScoreSection(key: SectionKey, raw: IseRawResult, durationSec: number): SectionResult {
  const spec = SECTION_MAP[key];
  const score = iseDerivedScore(raw, key, durationSec);
  const items = buildItems(key, raw, score, durationSec);
  const dimsText = Object.entries(raw.dims)
    .filter(([k]) => k !== 'total')
    .map(([k, v]) => `${iseDimLabel(k)} ${v.toFixed(1)}`)
    .join('、');

  const parts: string[] = [`讯飞 ISE 发音评测得分 ${raw.totalScore.toFixed(2)}/100（百分制）`];
  if (dimsText) parts.push(`维度：${dimsText}`);
  parts.push(`按本项满分 ${spec.maxScore} 分折算为 ${score.toFixed(1)} 分`);
  if (raw.errorCount || raw.defectCount) {
    parts.push(`引擎定位语音错误 ${raw.errorCount} 处、语音缺陷 ${raw.defectCount} 处`);
  }
  if (durationSec < 1) parts.push('（录音时长过短，结果不可靠）');

  const warnings: string[] = [];
  if (durationSec < spec.limitSec * 0.3) warnings.push('录音时长明显短于本项要求，可能未读完题目。');
  if (raw.isRejected) warnings.push('引擎判定录音不合格（可能静音或噪声过大）。');

  return {
    key,
    title: spec.name,
    maxScore: spec.maxScore,
    score,
    limitSec: spec.limitSec,
    durationSec,
    comment: parts.join('；') + '。',
    items,
    issues: raw.issues.map((i) => ({ ...i })),
    engine: 'ise',
    rawScore: Math.round(raw.totalScore * 100) / 100,
    dims: raw.dims,
    warnings: warnings.length ? warnings : undefined,
  };
}

/** 连通性/凭据测试：用一段合成音频请求评测，只要能拿到 code=0 即视为连通 */
export async function testIse(settings: IseSettings): Promise<string> {
  const { toneWav } = await import('./wav');
  const raw = await iseEvaluate({
    wav: toneWav(1.0, 16000, 220),
    refText: '啊',
    category: 'read_syllable',
    settings,
    timeoutMs: 30_000,
  });
  return `讯飞 ISE 连通正常：返回总分 ${raw.totalScore.toFixed(2)}（合成音测试，分数无参考价值${
    raw.isRejected ? '；引擎提示音频不合格，属正常现象' : ''
  }）`;
}

