import { getAudio } from '../lib/audioStore';
import { fmtScore, levelOf, LEVEL_DESC } from '../lib/grade';
import { engineNote } from '../lib/reference';
import type { ExamResult } from '../types';

interface Props {
  result: ExamResult;
  onRestart: () => void;
  onGoto: (p: 'home' | 'bank' | 'history') => void;
}

const ENGINE_TAG: Record<string, string> = { ise: '讯飞 ISE', llm: '大模型', demo: '演示', none: '未评分' };

export function Result({ result, onRestart, onGoto }: Props) {
  return (
    <div className="page result-page" data-testid="result-page">
      <section className="score-hero">
        <div>
          <div className="muted">本次模拟成绩</div>
          <div className="total" data-testid="result-total">
            {fmtScore(result.total)}
            <span className="total-max">/ {result.maxTotal}</span>
          </div>
          <div className="level" data-testid="result-level">
            {result.level}
          </div>
          <p className="muted small">{LEVEL_DESC[result.level]}</p>
        </div>
        <div className="score-actions">
          <button type="button" className="primary" onClick={onRestart}>
            再考一次
          </button>
          <button type="button" className="ghost" onClick={() => onGoto('bank')}>
            去题库练习
          </button>
          <button type="button" className="ghost" onClick={() => onGoto('history')}>
            历史记录
          </button>
          <button type="button" className="ghost" onClick={() => window.print()}>
            打印成绩
          </button>
        </div>
      </section>

      <section className="panel">
        <h2>总评</h2>
        <p className="overall-comment">{result.overallComment}</p>
        <p className="muted small">评分来源：{result.engineLabel}</p>
      </section>

      <div className="section-results" data-testid="result-sections">
        {result.sections.map((s) => {
          const audio = getAudio(result.id, s.key);
          const pct = Math.max(0, Math.min(100, (s.score / s.maxScore) * 100));
          return (
            <section className="panel section-result" key={s.key}>
              <div className="sr-head">
                <h3>
                  {s.title}
                  <span className="score-badge">
                    {fmtScore(s.score)} / {s.maxScore}
                  </span>
                  <span className="tag">{ENGINE_TAG[s.engine] ?? s.engine}</span>
                </h3>
                <span className="muted small">
                  用时 {s.durationSec.toFixed(0)} 秒 / 限时 {Math.floor(s.limitSec / 60)} 分{s.limitSec % 60 ? `${s.limitSec % 60} 秒` : ''}
                </span>
              </div>
              <div className="bar">
                <span style={{ width: `${pct}%` }} />
              </div>
              {s.errorMessage && <div className="banner error">评分失败：{s.errorMessage}</div>}
              {s.warnings?.map((w) => (
                <div className="banner warn" key={w}>
                  {w}
                </div>
              ))}
              {s.comment && <p className="sr-comment">{s.comment}</p>}
              {s.dims && Object.keys(s.dims).length > 0 && (
                <div className="dims">
                  {Object.entries(s.dims).map(([k, v]) => (
                    <span key={k} className="dim">
                      {k} <b>{v.toFixed(1)}</b>
                    </span>
                  ))}
                </div>
              )}
              {s.items.length > 0 && (
                <table className="table compact">
                  <thead>
                    <tr>
                      <th>扣分项</th>
                      <th>扣分</th>
                      <th>依据</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.items.map((it, i) => (
                      <tr key={`${it.item}-${i}`}>
                        <td>{it.item}{it.count !== undefined ? `（${it.count} 处）` : ''}</td>
                        <td className="deduct">-{it.deduction.toFixed(2)}</td>
                        <td className="muted small">{it.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {s.issues.length > 0 && (
                <details className="issues" open={s.issues.length <= 6}>
                  <summary>定位明细（{s.issues.length} 条）</summary>
                  <ul>
                    {s.issues.map((it, i) => (
                      <li key={`${it.at}-${i}`}>
                        <span className="issue-at">{it.at || '—'}</span>
                        <span className="issue-type">{it.type}</span>
                        <span className="muted small">{it.note}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {s.transcript && (
                <details className="transcript">
                  <summary>讯飞听写文本</summary>
                  <p>{s.transcript}</p>
                </details>
              )}
              {audio && (
                <div className="audio-box">
                  <span className="muted small">录音回放</span>
                  <audio controls src={audio.url} preload="none" />
                </div>
              )}
              <p className="muted small">{engineNote(s.key, s.engine)}</p>
            </section>
          );
        })}
      </div>

      <p className="muted small center">
        本成绩由机器自动评分（等级 {levelOf(result.total)}），仅供练习参考，不代表官方普通话水平测试结果。
      </p>
    </div>
  );
}
