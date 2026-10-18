import { CHARS, type CharItem } from '../data/chars';
import { WORDS, type WordItem, type WordTag } from '../data/words';
import { TOPICS } from '../data/topics';
import { WORKS } from '../data/works';
import type { ExamPaper } from '../types';

/** 组卷：按大纲的覆盖要求抽题（声母/韵母/声调均衡、避免同一要素连续、轻声儿化配额） */

const shuffle = <T,>(arr: T[]): T[] => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

const pick = <T,>(arr: T[], n: number): T[] => shuffle(arr).slice(0, n);

const syls = (w: WordItem): string[] => w.py.split(/\s+/).filter(Boolean);
const firstSyl = (w: WordItem): string => syls(w)[0] ?? '';
const lastSyl = (w: WordItem): string => syls(w).slice(-1)[0] ?? '';

const INITIALS = Array.from(new Set(CHARS.map((c) => c.initial))).filter(Boolean);
const FINALS = Array.from(new Set(CHARS.map((c) => c.final)));

/** 第一项：100 个单音节字（每个声母≥3 次、每个韵母≥2 次、四声大致均衡、不连续同要素） */
export function drawMono(limit = 100): CharItem[] {
  for (let attempt = 0; attempt < 60; attempt++) {
    const used = new Set<string>();
    const result: CharItem[] = [];
    const iniCount: Record<string, number> = {};
    const finCount: Record<string, number> = {};
    const toneCount: Record<number, number> = {};

    const push = (c: CharItem): void => {
      used.add(c.c);
      result.push(c);
      iniCount[c.initial] = (iniCount[c.initial] ?? 0) + 1;
      finCount[c.final] = (finCount[c.final] ?? 0) + 1;
      toneCount[c.tone] = (toneCount[c.tone] ?? 0) + 1;
    };

    const base = shuffle(CHARS);
    // 先保证每个声母至少 3 次
    for (const ini of INITIALS) {
      if (result.length >= limit) break;
      const pool = shuffle(base.filter((x) => x.initial === ini && !used.has(x.c)));
      for (const c of pool.slice(0, 3)) {
        if (result.length >= limit) break;
        push(c);
      }
    }
    // 再用未达标要素补足，同时避免与前一个字同声母/同韵母/同声调
    const rest = shuffle(CHARS.filter((c) => !used.has(c.c)));
    for (const c of rest) {
      if (result.length >= limit) break;
      const prev = result[result.length - 1];
      const conflict = Boolean(prev && (prev.initial === c.initial || prev.final === c.final || prev.tone === c.tone));
      const underIni = (iniCount[c.initial] ?? 0) < 3;
      const underFin = (finCount[c.final] ?? 0) < 2;
      const underTone = (toneCount[c.tone] ?? 0) < limit / 4 - 6;
      if (conflict) continue;
      if (!underIni && !underFin && !underTone && Math.random() < 0.55) continue;
      push(c);
    }
    if (result.length === limit) return result;
  }
  return shuffle(CHARS).slice(0, limit);
}

/** 第二项：凑满 100 个音节的多音节词语（儿化≥4、轻声≥3、上上相连≥3、上声与非上声≥4） */
export function drawPoly(targetSyllables = 100): WordItem[] {
  const quota: { tag: WordTag; n: number }[] = [
    { tag: '儿化', n: 4 },
    { tag: '轻声', n: 3 },
    { tag: '上上', n: 3 },
    { tag: '上非', n: 4 },
  ];
  const byTag = (t: WordTag): WordItem[] => WORDS.filter((w) => w.tags.includes(t));

  for (let attempt = 0; attempt < 80; attempt++) {
    const chosen: WordItem[] = [];
    const used = new Set<string>();
    let total = 0;

    for (const { tag, n } of quota) {
      for (const w of pick(byTag(tag), n * 3)) {
        if (chosen.filter((c) => c.tags.includes(tag)).length >= n) break;
        if (used.has(w.w) || total + w.syl > targetSyllables) continue;
        used.add(w.w);
        chosen.push(w);
        total += w.syl;
      }
    }

    const rest = shuffle(WORDS.filter((w) => !used.has(w.w)));
    for (const w of rest) {
      if (total >= targetSyllables) break;
      if (total + w.syl > targetSyllables) continue;
      const prev = chosen[chosen.length - 1];
      if (prev && lastSyl(prev) === firstSyl(w) && Math.random() < 0.7) continue;
      used.add(w.w);
      chosen.push(w);
      total += w.syl;
    }

    // 差 1~2 个音节时，用更长的词替换一个 2 音节词
    let guard = 0;
    while (total < targetSyllables && guard++ < 40) {
      const remain = targetSyllables - total;
      const swapOut = chosen.findIndex((w) => w.syl === 2);
      const swapIn = WORDS.find((w) => w.syl === remain + 2 && !used.has(w.w));
      if (swapOut === -1 || !swapIn) break;
      used.delete(chosen[swapOut].w);
      chosen.splice(swapOut, 1, swapIn);
      used.add(swapIn.w);
      total += swapIn.syl - 2;
    }

    const tagOk = quota.every(({ tag, n }) => chosen.filter((c) => c.tags.includes(tag)).length >= n);
    if (total === targetSyllables && tagOk) return shuffle(chosen);
  }
  return shuffle(WORDS).slice(0, 50);
}

/** 抽整套试卷 */
export function drawExamPaper(): ExamPaper {
  const [topic1, topic2] = pick(TOPICS, 2);
  return {
    mono: drawMono(),
    poly: drawPoly(),
    read: pick(WORKS, 1)[0],
    speak: [topic1, topic2],
  };
}

export const poolStats = () => ({
  chars: CHARS.length,
  words: WORDS.length,
  works: WORKS.length,
  topics: TOPICS.length,
  initials: INITIALS.length,
  finals: FINALS.length,
  tones: Array.from(new Set(CHARS.map((c) => c.tone))).length,
});
