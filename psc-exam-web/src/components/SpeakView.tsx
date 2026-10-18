interface Props {
  topics: [string, string];
  selected: string | null;
  onSelect: (topic: string) => void;
  /** pick：选题；prep：准备倒计时；speak：正式作答 */
  phase: 'pick' | 'prep' | 'speak';
  prepRemaining: number;
  disabled?: boolean;
}

const TIPS = [
  '开头一句话点题，直接说出你要讲的人/事/物。',
  '中间举 2~3 个具体事例，多用口语化的短句，少用书面长句。',
  '结尾说一说自己的感受或收获，把话收住。',
  '不要背稿、不要念屏幕、不要离题；语速放慢，保证三分钟不断话。',
];

/** 第四项：命题说话（二选一 + 准备 + 计时提示） */
export function SpeakView({ topics, selected, onSelect, phase, prepRemaining, disabled }: Props) {
  return (
    <div className="speak-view" data-testid="speak-view">
      <div className="topic-list">
        {topics.map((t, i) => (
          <button
            type="button"
            key={t}
            className={`topic-card ${selected === t ? 'selected' : ''}`}
            onClick={() => !disabled && onSelect(t)}
            disabled={disabled || phase !== 'pick'}
            data-testid={`topic-${i}`}
          >
            <span className="topic-index">话题 {i + 1}</span>
            <span className="topic-name">{t}</span>
            {selected === t && <span className="topic-check">✓ 已选择</span>}
          </button>
        ))}
      </div>

      {phase === 'prep' && (
        <div className="speak-prep">
          <div className="speak-prep-num">{prepRemaining}</div>
          <div className="speak-prep-text">秒后开始，请在心里列好提纲</div>
        </div>
      )}

      {phase === 'speak' && (
        <div className="speak-tips">
          <div className="speak-tips-title">说话提示（题目：{selected ?? '未选择'}）</div>
          <ul>
            {TIPS.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
