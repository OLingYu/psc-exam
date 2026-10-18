import type { ExamPaper, SectionKey, SectionSpec } from '../types';
import { SECTION_MAP, SECTIONS } from './sections';

/** 考前须知（首页/开考页展示，同时作为本地 TTS 的开场播报） */
export const EXAM_INTRO: string[] = [
  '普通话水平测试模拟考试即将开始。',
  '本次考试共四项：第一项，读单音节字词，十个字，限时三分三十秒；第二项，读多音节词语，限时两分三十秒；第三项，朗读短文，限时四分钟；第四项，命题说话，限时三分钟。',
  '请在提示音结束后开始作答，注意麦克风保持十五厘米左右的距离，语速平稳，音量适中。',
  '每一项作答完成后，系统会自动保存录音并进入下一项。全部完成后，系统将把录音送往评分引擎，按普通话水平测试大纲逐项评分。',
  '现在开始第一项，读单音节字词。',
];

/** 选题/准备阶段提示 */
export const SPEAK_PICK_TEXT = '请从两道题目中选择一道，作为命题说话的题目。选定后有三十秒准备时间。';

export const SPEAK_PREP_TEXT = '准备时间结束，请注意保持口语化表达，不要背稿，不要离题，连续说满三分钟。';

/** 单项指导语（TTS 播报 + 屏幕提示） */
export function sectionGuide(key: SectionKey, paper: ExamPaper): string {
  const spec = SECTION_MAP[key];
  switch (key) {
    case 'mono':
      return `${spec.ordinal}，读单音节字词。请横向依次朗读屏幕上的 ${paper.mono.length} 个单音节字，限时三分三十秒，现在开始。`;
    case 'poly':
      return `${spec.ordinal}，读多音节词语。请依次朗读屏幕上的 ${paper.poly.length} 个词语，共 ${paper.poly.reduce(
        (n, w) => n + w.syl,
        0,
      )} 个音节，注意上声变调、轻声和儿化，限时两分三十秒，现在开始。`;
    case 'read':
      return `${spec.ordinal}，朗读短文。请朗读作品《${paper.read.source}》，注意停连、语调和流畅程度，限时四分钟，现在开始。`;
    case 'speak':
      return `${spec.ordinal}，命题说话。请围绕选定的话题连续说满三分钟，注意语音标准、词汇语法规范、表达自然流畅，现在开始。`;
  }
}

/** 剩余时间播报 */
export const warnText = (sec: number): string => `还有${sec >= 60 ? `${Math.round(sec / 60)}分钟` : `${sec}秒`}。`;

export const SECTION_END_TEXT = '本项答题时间结束，请停止作答。';

export const FINISH_TEXT = '全部答题已完成，系统正在提交录音进行评分，请稍候。';

/* --------------------------- 大模型评分提示词 --------------------------- */

/** 内置系统提示词：把大纲评分细则喂给大模型 */
export const SYSTEM_PROMPT = `你是国家普通话水平测试（PSC）的资深评测员，熟悉《普通话水平测试大纲》的评分系统。
你将收到应试人某一测试项的**现场录音**（或录音转写文本）以及该测试项的标准文本与答题要求。
请严格依据大纲的评分细则给出该项得分（不是百分制，而是该项满分制），并说明扣分构成。

评分依据（大纲）：
一、读单音节字词（满分 10 分，100 个音节，限时 3.5 分钟）
  1. 语音错误，每个音节扣 0.1 分；
  2. 语音缺陷，每个音节扣 0.05 分；
  3. 超时 1 分钟以内扣 0.5 分；超时 1 分钟以上（含 1 分钟）扣 1 分。
二、读多音节词语（满分 20 分，100 个音节，限时 2.5 分钟）
  1. 语音错误，每个音节扣 0.2 分；
  2. 语音缺陷，每个音节扣 0.1 分；
  3. 超时扣分同上。须特别注意上声变调、轻声、儿化的正确性。
三、朗读短文（满分 30 分，1 篇 400 个音节，限时 4 分钟）
  1. 每错 1 个音节扣 0.1 分；漏读或增读 1 个音节扣 0.1 分；
  2. 声母或韵母的系统性语音缺陷，视程度扣 0.5 分、1 分；
  3. 语调偏误，视程度扣 0.5 分、1 分、2 分；
  4. 停连不当，视程度扣 0.5 分、1 分、2 分；
  5. 朗读不流畅（含回读），视程度扣 0.5 分、1 分、2 分；
  6. 超时扣 1 分。
四、命题说话（满分 40 分，限时 3 分钟；即免测“选择判断”时按大纲附注调整后的分值）
  1. 语音标准程度 25 分，分六档：一档扣 0~2 分；二档扣 3~4 分；三档扣 5~6 分；四档扣 7~8 分；五档扣 9~11 分；六档扣 12~14 分。
  2. 词汇语法规范程度 10 分，分三档：一档扣 0 分；二档扣 1~2 分；三档扣 3~4 分。
  3. 自然流畅程度 5 分，分三档：一档扣 0 分；二档扣 0.5~1 分；三档扣 2~3 分。
  4. 说话不足 3 分钟酌情扣分：缺时 1 分钟以内（含 1 分钟）扣 1~3 分；缺时 1 分钟以上扣 4~6 分；说话不满 30 秒，本项成绩计 0 分。
  5. 明显背稿、离题、说话难以继续的，应给出提示性评语并相应扣分。

要求：
- 只能依据录音中真实可听的语音表现评分，不要臆造；无法判断时给出保守（偏严）的评分并说明。
- 评分必须落在该项满分区间内；扣分明细之和应与「满分 - 得分」基本一致。
- 语气客观、具体，指出问题所在的字/词（如果有转写文本可引用），不要空泛。
- 必须输出**纯 JSON**（不要 Markdown 代码块、不要任何解释性前后缀），结构如下：
{"score": 8.6, "items": [{"item": "语音错误", "count": 5, "deduction": 0.5, "reason": "具体说明"}], "comment": "总评（80 字以内）", "issues": [{"at": "第 12 字", "type": "声调", "note": "说明"}]}
`;

/** 分项用户提示词 */
export function buildScorePrompt(opts: {
  spec: SectionSpec;
  refText: string;
  durationSec: number;
  transcript?: string;
  audioAttached: boolean;
}): string {
  const { spec, refText, durationSec, transcript, audioAttached } = opts;
  const lines: string[] = [];
  lines.push(`本次评测分项：${spec.name}（${spec.ordinal}）`);
  lines.push(`该项满分：${spec.maxScore} 分；限时：${Math.round(spec.limitSec / 60)} 分钟；应试人实际用时：${durationSec.toFixed(1)} 秒。`);
  lines.push(`评测目的：${spec.purpose}`);
  lines.push(`评分口径：${spec.scoring}`);
  if (spec.key === 'speak') {
    lines.push(
      `说话话题：${refText}。该题无文字凭借，请重点评测：①语音标准程度（25 分，六档）②词汇语法规范程度（10 分，三档）③自然流畅程度（5 分，三档），并按缺时规则扣分。`,
    );
  } else {
    lines.push(`标准文本（应试人应朗读的内容，供比对）：\n${refText}`);
  }
  if (transcript) lines.push(`语音转写文本（可能有识别错误，仅供参考）：\n${transcript}`);
  lines.push(
    audioAttached
      ? '请直接听录音评分；如录音无法辨听，请在 comment 中说明并按保守标准给分。'
      : '本条为文本评分：请依据转写文本、时长与标准文本的差异估计语音/内容层面的表现。',
  );
  lines.push(`请输出 JSON，score 为 0~${spec.maxScore} 之间的数字（该项满分制）。`);
  return lines.join('\n');
}

/** 首页展示的考试结构说明 */
export const examOutline = (): { ordinal: string; name: string; maxScore: number; limit: string }[] =>
  SECTIONS.map((s) => ({
    ordinal: s.ordinal,
    name: s.name,
    maxScore: s.maxScore,
    limit: `${Math.floor(s.limitSec / 60)}′${String(s.limitSec % 60).padStart(2, '0')}″`,
  }));
