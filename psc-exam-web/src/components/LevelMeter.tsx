import { useEffect, useRef, useState } from 'react';

interface Props {
  /** 0~1 的电平 */
  level: number;
  peak?: number;
  active: boolean;
}

/** 麦克风电平条：实时反映输入音量，帮助应试人确认设备可用 */
export function LevelMeter({ level, peak = 0, active }: Props) {
  const [bars, setBars] = useState<number[]>(Array.from({ length: 24 }, () => 0));
  const raf = useRef(0);

  useEffect(() => {
    if (!active) {
      setBars(Array.from({ length: 24 }, () => 0));
      return;
    }
    const tick = () => {
      setBars((prev) => {
        const next = prev.slice(1);
        next.push(Math.min(1, Math.sqrt(level) * 1.8));
        return next;
      });
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [active, level]);

  const peakPercent = Math.round(Math.min(1, peak * 1.4) * 100);

  return (
    <div className="level-meter" data-testid="level-meter" title={`峰值 ${peakPercent}%`}>
      <div className="level-bars">
        {bars.map((v, i) => (
          <span
            key={i}
            className={`level-bar ${v > 0.75 ? 'hot' : v > 0.45 ? 'warm' : ''}`}
            style={{ height: `${Math.max(6, v * 100)}%` }}
          />
        ))}
      </div>
      <div className="level-label">{active ? '正在录音' : '未录音'}</div>
    </div>
  );
}
