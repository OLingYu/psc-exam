import type { ExamPaper, ScoreEngine, SectionKey, SectionResult, Settings } from '../types';
import { SECTION_MAP } from './sections';

/** 标准文本（供大模型比对）：朗读短文取「∥」前的 400 音节 */
export function refTextFor(key: SectionKey, paper: ExamPaper): string {
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

/** 本项应使用的评分引擎：前三项讯飞 ISE，命题说话优先大模型 */
export function pickEngine(key: SectionKey, settings: Settings): ScoreEngine {
  const iseOk = Boolean(settings.ise.appId.trim() && settings.ise.apiKey.trim() && settings.ise.apiSecret.trim());
  const llmOk = Boolean(settings.llm.baseUrl.trim() && settings.llm.model.trim());
  if (key === 'speak') {
    if (llmOk) return 'llm';
    // 未配置大模型时，退回「讯飞听写 + ISE 自参考评测」（仍全部走讯飞）
    return iseOk ? 'ise' : 'demo';
  }
  return iseOk ? 'ise' : 'demo';
}

/** 各分项引擎说明（界面展示） */
export function engineNote(key: SectionKey, engine: ScoreEngine): string {
  switch (engine) {
    case 'ise':
      return key === 'speak'
        ? '讯飞语音听写 + 讯飞 ISE 自参考评测（未配置大模型时的兜底）'
        : '讯飞 ISE 发音评测（声韵/调型/流利度/完整度逐字定位）';
    case 'llm':
      return '外部大模型按大纲评分（录音直传或先转写再评分）';
    case 'demo':
      return '演示模式：未调用任何真实接口，分数仅用于跑通流程';
    default:
      return '未评分';
  }
}

/** 演示模式评分：产生结构完整的示意成绩（明确标注不代表真实水平） */
export function demoScore(key: SectionKey, durationSec: number, paper: ExamPaper): SectionResult {
  const spec = SECTION_MAP[key];
  const ratio = key === 'speak'
    ? Math.min(1, durationSec / spec.limitSec) * 0.9
    : Math.min(1, durationSec / (spec.limitSec * 0.55));
  const base = spec.maxScore * (0.72 + ratio * 0.18);
  const jitter = (Math.random() - 0.5) * spec.maxScore * 0.06;
  const score = Math.max(0, Math.min(spec.maxScore, Math.round((base + jitter) * 10) / 10));
  const lost = Math.round((spec.maxScore - score) * 10) / 10;

  const items =
    lost > 0
      ? [
          {
            item: key === 'speak' ? '语音标准程度' : '语音错误',
            deduction: Math.round(lost * 0.6 * 10) / 10,
            reason: '演示模式：示意扣分，未接入真实评测引擎',
          },
          {
            item: key === 'read' ? '语调与停连' : key === 'speak' ? '自然流畅程度' : '语音缺陷',
            deduction: Math.round(lost * 0.4 * 10) / 10,
            reason: '演示模式：示意扣分，未接入真实评测引擎',
          },
        ]
      : [];

  const issues: { at: string; type: string; note: string }[] = [];
  if (key === 'mono' || key === 'poly') {
    const sample = key === 'mono' ? paper.mono : paper.poly;
    const hint = sample.slice(0, 3).map((x) => ('c' in x ? x.c : x.w));
    hint.forEach((t, i) =>
      issues.push({ at: t, type: i % 2 === 0 ? '示意-声调' : '示意-鼻韵母', note: '演示模式生成的示意问题，非真实识别结果' }),
    );
  }

  return {
    key,
    title: spec.name,
    maxScore: spec.maxScore,
    score,
    limitSec: spec.limitSec,
    durationSec,
    comment: `【演示模式】本项未调用真实评分引擎，按录音时长估算得分 ${score.toFixed(1)}/${spec.maxScore}。配置讯飞 ISE 或大模型接口后可获得真实评测结果。`,
    items,
    issues,
    engine: 'demo',
    rawScore: score,
  };
}
