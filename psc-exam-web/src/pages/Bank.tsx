import { useMemo, useState } from 'react';
import { CHARS } from '../data/chars';
import { TOPICS } from '../data/topics';
import { WORKS } from '../data/works';
import { WORDS } from '../data/words';

type Tab = 'chars' | 'words' | 'works' | 'topics';

const TABS: { key: Tab; label: string; count: number }[] = [
  { key: 'works', label: '朗读作品', count: WORKS.length },
  { key: 'topics', label: '命题说话', count: TOPICS.length },
  { key: 'chars', label: '单音节字', count: CHARS.length },
  { key: 'words', label: '多音节词语', count: WORDS.length },
];

const PAGE = 60;

export function Bank() {
  const [tab, setTab] = useState<Tab>('works');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(0);
  const [openWork, setOpenWork] = useState<number | null>(null);

  const filteredChars = useMemo(
    () => CHARS.filter((c) => !q || c.c.includes(q) || c.py.includes(q)),
    [q],
  );
  const filteredWords = useMemo(() => WORDS.filter((w) => !q || w.w.includes(q) || w.py.includes(q)), [q]);
  const filteredWorks = useMemo(
    () => WORKS.filter((w) => !q || w.text.includes(q) || w.source.includes(q) || String(w.index) === q),
    [q],
  );
  const filteredTopics = useMemo(() => TOPICS.filter((t) => !q || t.includes(q)), [q]);

  const switchTab = (t: Tab): void => {
    setTab(t);
    setPage(0);
  };

  return (
    <div className="page bank-page" data-testid="bank-page">
      <header className="page-head">
        <div>
          <h1>题库</h1>
          <p className="muted">来自附件：50 篇朗读作品（PDF 提取）、50 个说话题目、朗读作品用字与常用字词。</p>
        </div>
      </header>

      <div className="bank-bar">
        <div className="tabs inline">
          {TABS.map((t) => (
            <button type="button" key={t.key} className={`tab ${tab === t.key ? 'active' : ''}`} onClick={() => switchTab(t.key)}>
              {t.label}
              <span className="tab-count">{t.count}</span>
            </button>
          ))}
        </div>
        <input className="search" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} placeholder="搜索字 / 词 / 作品内容 / 话题" />
      </div>

      {tab === 'works' && (
        <div className="list">
          {filteredWorks.map((w) => (
            <article className="card" key={w.index}>
              <button type="button" className="card-head" onClick={() => setOpenWork(openWork === w.index ? null : w.index)}>
                <b>作品 {w.index}</b>
                <span className="muted">{w.source}</span>
                <span className="link">{openWork === w.index ? '收起' : '展开全文'}</span>
              </button>
              {openWork === w.index && <p className="work-text">{w.text}</p>}
            </article>
          ))}
        </div>
      )}

      {tab === 'topics' && (
        <div className="chip-grid">
          {filteredTopics.map((t, i) => (
            <span className="chip" key={t}>
              <b>{i + 1}</b> {t}
            </span>
          ))}
        </div>
      )}

      {tab === 'chars' && (
        <>
          <div className="mono-grid small">
            {filteredChars.slice(page * PAGE, page * PAGE + PAGE).map((c, i) => (
              <div className="mono-cell" key={`${c.c}-${i}`}>
                <span className="mono-char">{c.c}</span>
                <span className="mono-pinyin">{c.py}</span>
              </div>
            ))}
          </div>
          <Pager total={filteredChars.length} page={page} setPage={setPage} />
        </>
      )}

      {tab === 'words' && (
        <>
          <div className="poly-grid">
            {filteredWords.slice(page * PAGE, page * PAGE + PAGE).map((w, i) => (
              <div className="poly-cell" key={`${w.w}-${i}`}>
                <span className="poly-word">{w.w}</span>
                <span className="poly-pinyin">{w.py}</span>
                <span className="poly-tags">
                  {w.tags.map((t) => (
                    <span className={`tag tag-${t}`} key={t}>
                      {t}
                    </span>
                  ))}
                </span>
              </div>
            ))}
          </div>
          <Pager total={filteredWords.length} page={page} setPage={setPage} />
        </>
      )}
    </div>
  );
}

function Pager({ total, page, setPage }: { total: number; page: number; setPage: (p: number) => void }) {
  const max = Math.max(0, Math.ceil(total / PAGE) - 1);
  if (total <= PAGE) return <p className="muted small">共 {total} 条</p>;
  return (
    <div className="pager">
      <button type="button" className="ghost small" disabled={page <= 0} onClick={() => setPage(page - 1)}>
        上一页
      </button>
      <span className="muted small">
        第 {page + 1} / {max + 1} 页 · 共 {total} 条
      </span>
      <button type="button" className="ghost small" disabled={page >= max} onClick={() => setPage(page + 1)}>
        下一页
      </button>
    </div>
  );
}
