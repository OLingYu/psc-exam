import type { CharItem } from '../data/chars';

interface Props {
  items: CharItem[];
  showPinyin: boolean;
}

/** 第一项：100 个单音节字（5 列 × 20 行，模拟机考排版） */
export function MonoView({ items, showPinyin }: Props) {
  return (
    <div className="mono-grid" data-testid="mono-grid">
      {items.map((c, i) => (
        <div className="mono-cell" key={`${c.c}-${i}`}>
          <span className="mono-char">{c.c}</span>
          {showPinyin && <span className="mono-pinyin">{c.py}</span>}
        </div>
      ))}
    </div>
  );
}
