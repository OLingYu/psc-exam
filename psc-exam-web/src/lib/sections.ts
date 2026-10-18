import type { SectionKey, SectionSpec, Settings } from '../types';

/**
 * 试卷构成（依据 附件/大纲.txt 第三部分）
 *
 * 大纲为 5 项、100 分制（读单音节 10 + 读多音节 20 + 选择判断 10 + 朗读短文 30 + 命题说话 30）。
 * 大纲「特别说明」允许免测「选择判断」，此时「命题说话」由 30 分调为 40 分，其余不变。
 * 本项目不实现「选择判断」（附件未提供《普通话与方言词语/语法差异对照表》），
 * 因此采用大纲允许的 4 项制口径，合计 100 分。
 */
export const SECTIONS: SectionSpec[] = [
  {
    key: 'mono',
    ordinal: '第一项',
    name: '读单音节字词',
    maxScore: 10,
    limitSec: 210,
    purpose: '测查应试人声母、韵母、声调读音的标准程度。',
    requirement: '100 个音节，限时 3 分 30 秒。请横向依次朗读，不要漏行、跳行，不要改读。',
    scoring: '语音错误每个音节扣 0.1 分，语音缺陷每个音节扣 0.05 分；超时 1 分钟内扣 0.5 分，1 分钟以上扣 1 分。',
  },
  {
    key: 'poly',
    ordinal: '第二项',
    name: '读多音节词语',
    maxScore: 20,
    limitSec: 150,
    purpose: '测查应试人声母、韵母、声调和变调、轻声、儿化读音的标准程度。',
    requirement: '100 个音节，限时 2 分 30 秒。注意上声变调、轻声与儿化，不要改读。',
    scoring: '语音错误每个音节扣 0.2 分，语音缺陷每个音节扣 0.1 分；超时扣 0.5~1 分。',
  },
  {
    key: 'read',
    ordinal: '第三项',
    name: '朗读短文',
    maxScore: 30,
    limitSec: 240,
    purpose: '测查使用普通话朗读书面作品的水平，重点测查连读音变、停连、语调以及流畅程度。',
    requirement: '朗读作品 1 篇，限时 4 分钟。评分以「∥」之前的 400 个音节为限，不要回读、不要多读。',
    scoring:
      '每错 1 个音节扣 0.1 分，漏读或增读 1 个音节扣 0.1 分；系统性语音缺陷扣 0.5~1 分；语调偏误、停连不当、朗读不流畅各视程度扣 0.5~2 分；超时扣 1 分。',
  },
  {
    key: 'speak',
    ordinal: '第四项',
    name: '命题说话',
    maxScore: 40,
    limitSec: 180,
    purpose: '测查无文字凭借情况下说普通话的水平，重点测查语音标准程度、词汇语法规范程度和自然流畅程度。',
    requirement: '从给定的两个话题中选定 1 个，连续说满 3 分钟。要求口语化，不得背稿、不得离题。',
    scoring:
      '语音标准程度 25 分（六档）、词汇语法规范程度 10 分（三档）、自然流畅程度 5 分（三档）；缺时 1 分钟内扣 1~3 分，1 分钟以上扣 4~6 分，不足 30 秒该项计 0 分。',
  },
];

export const SECTION_MAP: Record<SectionKey, SectionSpec> = SECTIONS.reduce(
  (acc, s) => ({ ...acc, [s.key]: s }),
  {} as Record<SectionKey, SectionSpec>,
);

export const TOTAL_SCORE = SECTIONS.reduce((sum, s) => sum + s.maxScore, 0);

/** 讯飞凭据是否填写完整 */
export function iseReady(settings: Settings): boolean {
  const { appId, apiKey, apiSecret } = settings.ise;
  return Boolean(appId.trim() && apiKey.trim() && apiSecret.trim());
}

/** 大模型凭据是否填写完整（命题说话评分用） */
export function llmReady(settings: Settings): boolean {
  const { baseUrl, model, apiKey, style } = settings.llm;
  const keyOk = Boolean(apiKey.trim()) || style !== 'anthropic';
  return Boolean(baseUrl.trim() && model.trim() && keyOk);
}

/** 各分项实际使用的评分方式 */
export function engineOf(key: SectionKey, settings: Settings): 'ise' | 'llm' | 'demo' {
  if (key === 'speak') {
    if (llmReady(settings)) return 'llm';
    if (iseReady(settings)) return 'ise';
    return 'demo';
  }
  return iseReady(settings) ? 'ise' : 'demo';
}

/** 当前评分配置说明（首页/设置页展示） */
export function scoringLabel(settings: Settings): { short: string; detail: string } {
  const ise = iseReady(settings);
  const llm = llmReady(settings);
  if (ise && llm) {
    return { short: '讯飞 ISE + 大模型', detail: '前三项用讯飞 ISE 逐字评测；命题说话由大模型按大纲评分' };
  }
  if (ise) {
    return { short: '讯飞 ISE（说话走听写兜底）', detail: '前三项逐字评测；命题说话因未配置大模型，改用讯飞听写+自动参考评测' };
  }
  if (llm) {
    return { short: '仅大模型（前三项无评测）', detail: '前三项需要讯飞 ISE 凭据才能评分，当前为演示模式' };
  }
  return { short: '演示模式', detail: '未配置任何接口，分数为示意值' };
}
