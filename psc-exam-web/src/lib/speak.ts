import type { Issue, IseSettings, ScoreItem, SectionResult } from '../types';
import { SECTION_MAP } from './sections';
import { countHanzi, transcribeWav } from './iat';
import { iseEvaluate } from './ise';

/**
 * 命题说话评分：两步都走讯飞
 *
 *  ① 讯飞「语音听写（流式版）」把说话录音转写成文字（把录音真正送进讯飞）
 *  ② 用这段转写文本作为 ISE 的参考文本，再对同一段录音做一次读音评测
 *
 * 因为参考文本就是应试人自己说的话，ISE 返回的声韵分/调型分/流畅度/完整度
 * 是对真实发音质量的评测（不是与话题文本比对），评分口径按大纲：
 *   语音标准程度 25 分（六档，由讯飞评测分换算）
 *   词汇语法规范程度 10 分（依据讯飞转写文本做用词/口头禅/重复检测）
 *   自然流畅程度 5 分（依据讯飞流畅度、完整度与回读次数）
 *   缺时扣分（按大纲：1 分钟内 1~3 分，1 分钟以上 4~6 分，不足 30 秒计 0 分）
 */

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const round1 = (v: number): number => Math.round(v * 10) / 10;
const round2 = (v: number): number => Math.round(v * 100) / 100;

/** 大纲「语音标准程度」六档（25 分制） */
const VOICE_BANDS = [
  { min: 95, band: 1, lo: 0, hi: 2, label: '一档：语音标准，或极少有失误' },
  { min: 88, band: 2, lo: 3, hi: 4, label: '二档：语音错误在 10 次以下，有方音但不明显' },
  { min: 82, band: 3, lo: 5, hi: 6, label: '三档：方音比较明显，或语音错误在 10~15 次' },
  { min: 75, band: 4, lo: 7, hi: 8, label: '四档：语音错误 10~15 次，方音比较明显' },
  { min: 65, band: 5, lo: 9, hi: 11, label: '五档：语音错误超过 15 次，方音明显' },
  { min: -1, band: 6, lo: 12, hi: 14, label: '六档：语音错误多，方音重' },
];

function voiceStandardDeduction(iseScore: number): { deduction: number; label: string } {
  const idx = VOICE_BANDS.findIndex((b) => iseScore >= b.min);
  const b = VOICE_BANDS[idx < 0 ? VOICE_BANDS.length - 1 : idx];
  const upper = idx <= 0 ? 100 : VOICE_BANDS[idx - 1].min;
  const t = clamp((upper - iseScore) / Math.max(1, upper - b.min), 0, 1);
  return {
    deduction: round1(b.lo + (b.hi - b.lo) * t),
    label: b.label,
  };
}

/** 常见口头禅 / 方言词（只做轻量文本层面的规范度检测） */
const FILLERS = ['然后', '就是', '那个', '这个', '嗯', '呃', '反正', '其实', '怎么说呢', '就是说', '对吧'];
const DIALECT_WORDS = ['俺', '啥子', '咋', '啥', '晓得', '甭', '忒', '得瑟', '忽悠', '嘞', '呗', '啥时候', '咋整'];

interface GrammarCheck {
  deduction: number;
  reasons: string[];
}

/** 词汇语法规范程度（10 分，三档）：基于讯飞转写文本的轻量检测 */
function grammarCheck(transcript: string, hanzi: number): GrammarCheck {
  const reasons: string[] = [];
  if (hanzi < 20) {
    return { deduction: 2, reasons: ['转写文本过短，无法评估词汇语法，按二档给分'] };
  }
  const per100 = 100 / hanzi;
  const fillerHits = FILLERS.reduce((n, f) => n + (transcript.split(f).length - 1), 0);
  const fillerDensity = fillerHits * per100;

  let deduction = 0;
  if (fillerDensity >= 8) {
    deduction += 3;
    reasons.push(`口头禅密度偏高（约 ${round1(fillerDensity)} 处/百字，如「${FILLERS.find((f) => transcript.includes(f)) ?? '然后'}」）`);
  } else if (fillerDensity >= 4) {
    deduction += 2;
    reasons.push(`口头禅较多（约 ${round1(fillerDensity)} 处/百字）`);
  } else if (fillerDensity >= 2) {
    deduction += 1;
    reasons.push(`偶有口头禅（约 ${round1(fillerDensity)} 处/百字）`);
  }

  const dialectHits = DIALECT_WORDS.filter((w) => transcript.includes(w));
  if (dialectHits.length) {
    deduction += Math.min(2, dialectHits.length * 0.5);
    reasons.push(`检出方言词/非规范口语表达：${dialectHits.join('、')}`);
  }

  const repeats = transcript.match(/([\u4e00-\u9fa5]{2,4})\1{2,}/g);
  if (repeats?.length) {
    deduction += Math.min(1.5, repeats.length * 0.5);
    reasons.push(`存在重复表达：${repeats.slice(0, 3).join('、')}`);
  }

  if (!reasons.length) reasons.push('未检出明显不规范用词，按一档给分');
  return { deduction: clamp(round1(deduction), 0, 4), reasons };
}

export interface SpeakScoreOptions {
  wav: Blob;
  durationSec: number;
  settings: IseSettings;
  onProgress?: (note: string) => void;
}

/** 命题说话：讯飞听写转写 + 讯飞 ISE 自参考发音评测 */
export async function speakScoreSection(opts: SpeakScoreOptions): Promise<SectionResult> {
  const { wav, durationSec, settings, onProgress } = opts;
  const spec = SECTION_MAP.speak;
  if (!settings.appId.trim() || !settings.apiKey.trim() || !settings.apiSecret.trim()) {
    throw new Error('未配置讯飞凭据（AppID / APIKey / APISecret）');
  }

  /* ① 讯飞语音听写 → 转写文本 */
  onProgress?.('① 讯飞语音听写：把说话录音转成文字…');
  let transcript: string;
  try {
    transcript = await transcribeWav(wav, {
      settings,
      onProgress: (n) => onProgress?.(`① ${n}`),
    });
  } catch (err) {
    throw new Error(`讯飞语音听写失败：${(err as Error).message}`);
  }
  const hanzi = countHanzi(transcript);
  if (hanzi < 5) throw new Error('讯飞转写结果过少，无法作为评测参考文本（录音可能含大量静音）');

  /* ② 以转写文本为参考文本，交给讯飞 ISE 做发音评测 */
  // 讯飞 read_chapter 参考文本上限 1000 字，超长时截断（按实际说出的话截取，不影响声韵调评测）
  const refText = transcript.replace(/\s+/g, '').slice(0, 1000);
  onProgress?.(`② 讯飞语音评测：以转写文本（${Math.min(hanzi, 1000)} 字）为参考评测发音…`);
  let raw;
  try {
    raw = await iseEvaluate({
      wav,
      refText,
      category: 'read_chapter',
      settings,
      onProgress: (n) => onProgress?.(`② ${n}`),
      timeoutMs: 120_000,
    });
  } catch (err) {
    throw new Error(`讯飞语音评测失败：${(err as Error).message}`);
  }

  /* ③ 按大纲折算 */
  const phone = raw.dims.phone;
  const tone = raw.dims.tone;
  const voiceRaw = phone !== undefined && tone !== undefined ? (phone + tone) / 2 : raw.totalScore;
  const voice = voiceStandardDeduction(voiceRaw);
  const grammar = grammarCheck(transcript, hanzi);

  const fluencyDim = raw.dims.fluency ?? raw.totalScore;
  const integrityDim = raw.dims.integrity ?? 100;
  const backReads = raw.issues.filter((i) => i.type === '回读').length;
  const fluencyDeduction = clamp(
    round1(5 * (1 - clamp(fluencyDim, 0, 100) / 100) + Math.min(1.5, backReads * 0.2) + ((100 - clamp(integrityDim, 0, 100)) / 100) * 2),
    0,
    3,
  );

  let deductionSum = voice.deduction + grammar.deduction + fluencyDeduction;
  const items: ScoreItem[] = [
    {
      item: '语音标准程度',
      deduction: voice.deduction,
      reason: `讯飞评测声韵 ${phone?.toFixed(1) ?? '-'}、调型 ${tone?.toFixed(1) ?? '-'}、总分 ${raw.totalScore.toFixed(
        1,
      )} → ${voice.label}`,
    },
    {
      item: '词汇语法规范程度',
      deduction: grammar.deduction,
      reason: grammar.reasons.join('；'),
    },
    {
      item: '自然流畅程度',
      deduction: fluencyDeduction,
      reason: `讯飞流畅度 ${fluencyDim.toFixed(1)}、完整度 ${integrityDim.toFixed(1)}${
        backReads ? `、回读 ${backReads} 处` : ''
      }`,
    },
  ];

  /* ④ 大纲缺时规则 */
  const shortfall = spec.limitSec - durationSec;
  const warnings: string[] = [];
  let forcedZero = false;
  if (durationSec < 30) {
    forcedZero = true;
    items.push({ item: '说话不足 30 秒', deduction: 40, reason: '大纲：说话不满 30 秒（含 30 秒），本项成绩计 0 分' });
    warnings.push('说话不足 30 秒，按大纲本项计 0 分。');
  } else if (shortfall > 60) {
    items.push({ item: '缺时', deduction: 4.5, reason: `缺时 ${Math.round(shortfall)} 秒（超过 1 分钟），大纲扣 4~6 分` });
    deductionSum += 4.5;
    warnings.push('未说满 2 分钟，缺时扣分较重。');
  } else if (shortfall > 0) {
    items.push({ item: '缺时', deduction: 2, reason: `缺时 ${Math.round(shortfall)} 秒（1 分钟以内），大纲扣 1~3 分` });
    deductionSum += 2;
    warnings.push('未说满 3 分钟，按缺时扣分。');
  }

  const score = forcedZero ? 0 : round1(clamp(spec.maxScore - deductionSum, 0, spec.maxScore));

  /* ⑤ 定位明细 */
  const issues: Issue[] = raw.issues.slice(0, 25).map((i) => ({
    at: i.at,
    type: i.type,
    note: `${i.note}（参考文本为讯飞听写结果，定位仅供参考）`,
  }));
  const ratePerMin = durationSec > 0 ? Math.round((hanzi / durationSec) * 60) : 0;
  if (ratePerMin > 0) {
    issues.push({
      at: '全段',
      type: '语速',
      note: `约 ${ratePerMin} 字/分钟（讯飞听写 ${hanzi} 字 / ${Math.round(durationSec)} 秒），普通话说话通常 200~300 字/分钟`,
    });
  }
  if (ratePerMin > 380) warnings.push('语速偏快，可能影响清晰度。');
  if (ratePerMin > 0 && ratePerMin < 120) warnings.push('语速偏慢或停顿较多。');

  const dims: Record<string, number> = {};
  if (phone !== undefined) dims.声韵 = phone;
  if (tone !== undefined) dims.调型 = tone;
  if (raw.dims.fluency !== undefined) dims.流利度 = raw.dims.fluency;
  if (raw.dims.integrity !== undefined) dims.完整度 = raw.dims.integrity;

  const comment = [
    `命题说话 ${score}/${spec.maxScore} 分：语音标准程度扣 ${voice.deduction} 分（${voice.label}）`,
    `词汇语法扣 ${grammar.deduction} 分、自然流畅扣 ${fluencyDeduction} 分`,
    `讯飞听写 ${hanzi} 字，评测依据转写文本（声韵 ${phone?.toFixed(1) ?? '-'}、调型 ${tone?.toFixed(1) ?? '-'}、流利度 ${fluencyDim.toFixed(1)}）`,
    '本项通过「讯飞语音听写 + 讯飞 ISE 自参考评测」两步实现，无人工复核',
  ].join('；');

  return {
    key: 'speak',
    title: spec.name,
    maxScore: spec.maxScore,
    score,
    limitSec: spec.limitSec,
    durationSec,
    comment: `${comment}。`,
    items,
    issues,
    engine: 'ise',
    rawScore: round2(voiceRaw),
    dims,
    errorMessage: undefined,
    warnings: warnings.length ? warnings : undefined,
    transcript,
  };
}


