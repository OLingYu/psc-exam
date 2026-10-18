import { useMemo } from 'react';
import type { Work } from '../data/works';

interface Props {
  work: Work;
}

const countSyllables = (text: string): number => {
  const clean = text.replace(/[^\u4e00-\u9fa5]/g, '');
  return clean.length;
};

/** 第三项：朗读短文（评分以「∥」之前 400 个音节为限，界面上把越界部分淡出） */
export function ReadView({ work }: Props) {
  const { before, after, hasMarker } = useMemo(() => {
    const i = work.text.indexOf('∥');
    if (i < 0) return { before: work.text, after: '', hasMarker: false };
    return { before: work.text.slice(0, i), after: work.text.slice(i + 1), hasMarker: true };
  }, [work.text]);

  const syllables = countSyllables(before);

  return (
    <div className="read-view" data-testid="read-view">
      <div className="read-meta">
        <span>作品 {work.index}</span>
        <span>{work.source}</span>
        <span className={syllables >= 400 ? 'ok' : 'warn'}>计分音节：约 {syllables} 个</span>
      </div>
      <p className="read-text">
        {before}
        {hasMarker && <span className="read-marker" title="此后内容不计入评分">∥</span>}
        {hasMarker && <span className="read-after">{after}</span>}
      </p>
      {hasMarker && <p className="read-hint">「∥」之后的内容不计入评分，读到「∥」即可停止。</p>}
    </div>
  );
}
