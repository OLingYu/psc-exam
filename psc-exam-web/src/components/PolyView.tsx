import type { WordItem } from '../data/words';

interface Props {
  items: WordItem[];
  showPinyin: boolean;
}

/** 第二项：多音节词语（轻声/儿化/变调标注） */
export function PolyView({ items, showPinyin }: Props) {
  return (
    <div className="poly-grid" data-testid="poly-grid">
      {items.map((w, i) => (
        <div className="poly-cell" key={`${w.w}-${i}`}>
          <span className="poly-word">{w.w}</span>
          {showPinyin && <span className="poly-pinyin">{w.py}</span>}
          {w.tags.length > 0 && (
            <span className="poly-tags">
              {w.tags.map((t) => (
                <span className={`tag tag-${t}`} key={t}>
                  {t}
                </span>
              ))}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
