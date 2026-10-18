import { fmtScore } from '../lib/grade';
import type { HistoryItem } from '../types';

interface Props {
  history: HistoryItem[];
  onClear: () => void;
  onRemove: (id: string) => void;
}

export function History({ history, onClear, onRemove }: Props) {
  return (
    <div className="page history-page" data-testid="history-page">
      <header className="page-head">
        <div>
          <h1>历史记录</h1>
          <p className="muted">仅保存成绩与评语，不保存录音文件（录音只在本机内存中，用于本次回放）。</p>
        </div>
        {history.length > 0 && (
          <button type="button" className="ghost" onClick={() => window.confirm('清空全部历史记录？') && onClear()}>
            清空
          </button>
        )}
      </header>

      {history.length === 0 ? (
        <p className="muted">还没有记录。</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>时间</th>
              <th>总分</th>
              <th>等级</th>
              <th>各分项</th>
              <th>评分来源</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {history.map((h) => (
              <tr key={h.id}>
                <td className="small">{new Date(h.createdAt).toLocaleString('zh-CN')}</td>
                <td>
                  <b>{fmtScore(h.total)}</b>
                </td>
                <td>{h.level}</td>
                <td className="small">
                  {h.sections.map((s) => `${s.title.slice(0, 2)} ${fmtScore(s.score)}`).join(' · ')}
                </td>
                <td className="small muted">{h.engineLabel}</td>
                <td>
                  <button type="button" className="link" onClick={() => onRemove(h.id)}>
                    删除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
