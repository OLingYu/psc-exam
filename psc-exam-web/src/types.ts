// 全局类型定义（普通话水平测试模拟考试）

import type { CharItem } from './data/chars';
import type { WordItem } from './data/words';
import type { Work } from './data/works';

export type SectionKey = 'mono' | 'poly' | 'read' | 'speak';

/** 分项规格（依据 附件/大纲.txt） */
export interface SectionSpec {
  key: SectionKey;
  ordinal: string;
  name: string;
  maxScore: number;
  limitSec: number;
  /** 目的（大纲原文） */
  purpose: string;
  /** 屏幕展示的答题要求 */
  requirement: string;
  /** 评分口径提示 */
  scoring: string;
}

/** 一套试卷：四项题目一次性抽好 */
export interface ExamPaper {
  mono: CharItem[];
  poly: WordItem[];
  read: Work;
  speak: [string, string];
}

/** 扣分明细条目 */
export interface ScoreItem {
  item: string;
  count?: number;
  deduction: number;
  reason: string;
}

/** 逐字/逐音节定位 */
export interface Issue {
  at: string;
  type: string;
  note: string;
}

/**
 * 评分引擎：
 *  - ise  ：讯飞「语音评测（流式版）」；命题说话为「讯飞语音听写 + ISE 自参考评测」两步
 *  - demo ：演示模式（未配置凭据时跑通流程）
 */
export type ScoreEngine = 'ise' | 'llm' | 'demo' | 'none';

/** 单项成绩 */
export interface SectionResult {
  key: SectionKey;
  title: string;
  maxScore: number;
  score: number;
  limitSec: number;
  durationSec: number;
  comment: string;
  items: ScoreItem[];
  issues: Issue[];
  engine: ScoreEngine;
  /** 引擎原始分（ISE 为 0~100 百分制） */
  rawScore?: number;
  /** 引擎返回的维度分（声韵/调型/流利度等） */
  dims?: Record<string, number>;
  /** 讯飞听写得到的说话转写文本（命题说话） */
  transcript?: string;
  errorMessage?: string;
  warnings?: string[];
}

export interface ExamResult {
  id: string;
  createdAt: string;
  total: number;
  maxTotal: number;
  level: string;
  engineLabel: string;
  paper: ExamPaper;
  sections: SectionResult[];
  overallComment: string;
}

/* ------------------------------- 设置 ------------------------------- */

export type LlmStyle = 'openai' | 'anthropic';
/** direct：录音直传多模态大模型；asr：先转写再由文本模型评分 */
export type LlmAudioMode = 'direct' | 'asr';
export type LlmAudioStyle = 'input_audio' | 'audio_url';
/** 转写来源：外部 ASR 接口 / 讯飞语音听写 */
export type AsrSource = 'endpoint' | 'xfyun';

/** 外部大模型接口配置（用于命题说话） */
export interface LlmSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
  style: LlmStyle;
  /** 对话路径，默认 /chat/completions（Anthropic 为 /v1/messages） */
  chatPath: string;
  temperature: number;
  timeoutMs: number;
  audioMode: LlmAudioMode;
  audioStyle: LlmAudioStyle;
  asrSource: AsrSource;
  /** 外部 ASR（OpenAI 兼容 /audio/transcriptions） */
  asrBaseUrl: string;
  asrApiKey: string;
  asrModel: string;
  /** 额外请求头，JSON 对象字符串 */
  extraHeaders: string;
  /** 自定义系统提示词，留空使用内置大纲细则 */
  systemPrompt: string;
}

export type IseCategory = 'auto' | 'read_syllable' | 'read_word' | 'read_sentence' | 'read_chapter';
export type IseGroup = 'adult' | 'youth' | 'pupil';

/** 讯飞开放平台「语音评测（流式版）」WebAPI 配置 */
export interface IseSettings {
  appId: string;
  apiKey: string;
  apiSecret: string;
  /** 评测接口主机，默认 ise-api.xfyun.cn */
  host: string;
  /** 评测接口路径，默认 /v2/open-ise */
  path: string;
  /** 语音听写主机，默认 iat-api.xfyun.cn（命题说话转写用） */
  iatHost: string;
  /** 语音听写路径，默认 /v2/iat */
  iatPath: string;
  ent: 'cn_vip' | 'en_vip';
  /** auto 按分项自动选择（单字/词语/篇章） */
  category: IseCategory;
  group: IseGroup;
  checkType: 'easy' | 'common' | 'hard';
  /** 拓展能力，默认 multi_dimension;syll_phone_err_msg */
  extraAbility: string;
  rst: 'entirety' | 'plain';
  iseUnite: '0' | '1';
  /** 送评前峰值归一化目标（0 = 不处理） */
  gain: number;
}

export interface TtsSettings {
  engine: 'builtin' | 'http' | 'off';
  voiceURI: string;
  rate: number;
  pitch: number;
  volume: number;
  /** HTTP 本地 TTS：URL 中 {text} 占位，例 http://127.0.0.1:8080/tts?text={text} */
  url: string;
  method: 'GET' | 'POST';
  headers: string;
  /** POST 请求体模板，{text} 占位 */
  body: string;
}

export interface ExamSettings {
  /** 是否开启本地 TTS 提示音 */
  prompts: boolean;
  /** 剩余时间播报点（秒） */
  warnSeconds: number[];
  /** 每题开始前的准备倒计时（秒） */
  countdownSec: number;
  /** 命题说话准备时间（秒） */
  speakPrepSec: number;
  /** 关闭降噪/AGC，尽量保留原始音质（更接近真实评测） */
  rawMic: boolean;
  /** 是否在字词上显示拼音 */
  showPinyin: boolean;
}

export interface Settings {
  ise: IseSettings;
  llm: LlmSettings;
  tts: TtsSettings;
  exam: ExamSettings;
}

export interface HistoryItem {
  id: string;
  createdAt: string;
  total: number;
  maxTotal: number;
  level: string;
  engineLabel: string;
  sections: {
    key: SectionKey;
    title: string;
    score: number;
    maxScore: number;
    durationSec: number;
    engine: ScoreEngine;
    comment: string;
    errorMessage?: string;
  }[];
}
