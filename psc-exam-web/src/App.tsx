import { useCallback, useEffect, useState } from 'react';
import {
  appendHistory,
  clearHistory,
  lastResultId,
  loadHistory,
  loadSettings,
  readStashedResult,
  removeHistory,
  saveSettings,
  stashResult,
} from './lib/storage';
import { Exam } from './pages/Exam';
import { Bank } from './pages/Bank';
import { History } from './pages/History';
import { Home } from './pages/Home';
import { Result } from './pages/Result';
import { SettingsPage } from './pages/Settings';
import type { ExamResult, HistoryItem, Settings } from './types';

type Page = 'home' | 'exam' | 'result' | 'bank' | 'history' | 'settings';

const pages: { key: Page; label: string }[] = [
  { key: 'home', label: '首页' },
  { key: 'bank', label: '题库' },
  { key: 'history', label: '历史记录' },
  { key: 'settings', label: '接口配置' },
];

function parseHash(): { page: Page; id?: string } {
  const h = window.location.hash.replace(/^#\/?/, '');
  const [page, id] = h.split('/');
  const known: Page[] = ['home', 'exam', 'result', 'bank', 'history', 'settings'];
  return { page: (known.includes(page as Page) ? page : 'home') as Page, id };
}

export function App() {
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [history, setHistory] = useState<HistoryItem[]>(() => loadHistory());
  const [route, setRoute] = useState(parseHash);
  const [result, setResult] = useState<ExamResult | null>(() => {
    const id = parseHash().id ?? lastResultId();
    return id ? readStashedResult(id) : null;
  });
  const [toast, setToast] = useState<{ msg: string; kind: 'ok' | 'err' } | null>(null);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 4200);
    return () => clearTimeout(t);
  }, [toast]);

  const goto = useCallback((page: Page, id?: string) => {
    window.location.hash = id ? `#/${page}/${id}` : `#/${page}`;
    setRoute({ page, id });
    window.scrollTo({ top: 0 });
  }, []);

  const showToast = useCallback((msg: string, kind: 'ok' | 'err' = 'ok') => setToast({ msg, kind }), []);

  useEffect(() => {
    if (route.page === 'result' && !result) {
      const id = route.id ?? lastResultId();
      const stashed = id ? readStashedResult(id) : null;
      if (stashed) setResult(stashed);
      else goto('history');
    }
  }, [route, result, goto]);

  const finishExam = (r: ExamResult): void => {
    stashResult(r);
    setResult(r);
    setHistory(appendHistory(r));
    goto('result', r.id);
  };

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#/">
          <span className="brand-mark">PSC</span>
          <span className="brand-text">普通话水平测试 · 模拟考试</span>
        </a>
        <nav className="nav">
          {pages.map((p) => (
            <a key={p.key} href={`#/${p.key}`} className={route.page === p.key ? 'active' : ''}>
              {p.label}
            </a>
          ))}
        </nav>
      </header>

      <main className="app-main">
        {route.page === 'home' && (
          <Home
            settings={settings}
            history={history}
            onStart={() => goto('exam')}
            onGoto={(p) => goto(p === 'settings' ? 'settings' : p)}
            onToast={showToast}
          />
        )}
        {route.page === 'exam' && (
          <Exam
            settings={settings}
            onDone={finishExam}
            onQuit={() => {
              goto('home');
            }}
          />
        )}
        {route.page === 'result' && result && (
          <Result result={result} onRestart={() => goto('exam')} onGoto={goto} />
        )}
        {route.page === 'bank' && <Bank />}
        {route.page === 'history' && (
          <History
            history={history}
            onClear={() => {
              clearHistory();
              setHistory([]);
            }}
            onRemove={(id) => setHistory(removeHistory(id))}
          />
        )}
        {route.page === 'settings' && <SettingsPage settings={settings} onChange={setSettings} onToast={showToast} />}
      </main>

      {toast && (
        <div className={`toast ${toast.kind}`} data-testid="toast">
          {toast.msg}
        </div>
      )}
    </div>
  );
}
