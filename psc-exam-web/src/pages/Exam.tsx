import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LevelMeter } from '../components/LevelMeter';
import { MonoView } from '../components/MonoView';
import { PolyView } from '../components/PolyView';
import { ReadView } from '../components/ReadView';
import { SpeakView } from '../components/SpeakView';
import { drawExamPaper } from '../lib/draw';
import { putAudio } from '../lib/audioStore';
import { iseCategoryFor, iseEvaluate, iseRefText, iseScoreSection } from '../lib/ise';
import { llmScoreSection } from '../lib/llm';
import { transcribeWav } from '../lib/iat';
import { speakScoreSection } from '../lib/speak';
import { demoScore, engineNote, pickEngine, refTextFor } from '../lib/reference';
import { Recorder, type MicDevice, type RecordingResult } from '../lib/recorder';
import { SECTION_MAP, SECTIONS, iseReady, llmReady } from '../lib/sections';
import {
  EXAM_INTRO,
  FINISH_TEXT,
  SECTION_END_TEXT,
  SPEAK_PICK_TEXT,
  SPEAK_PREP_TEXT,
  sectionGuide,
  warnText,
} from '../lib/prompts';
import { playBeep, playDoubleBeep, speak, stopSpeaking } from '../lib/tts';
import { levelOf } from '../lib/grade';
import type { ExamPaper, ExamResult, SectionKey, SectionResult, Settings } from '../types';

type Phase =
  | 'intro' // 考前须知
  | 'device' // 设备调试
  | 'brief' // 分项说明
  | 'countdown' // 3-2-1
  | 'answering' // 作答录音中
  | 'saved' // 本项完成
  | 'pick' // 命题说话选题
  | 'prep' // 命题说话准备
  | 'finishing' // 评分中
  | 'finished'; // 评分完成

interface Props {
  settings: Settings;
  onDone: (result: ExamResult) => void;
  onQuit: () => void;
}

const fmt = (sec: number): string => {
  const s = Math.max(0, Math.round(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

const RECORDINGS_KEY = (id: string) => id;

export function Exam({ settings, onDone, onQuit }: Props) {
  const [paper] = useState<ExamPaper>(() => drawExamPaper());
  const [resultId] = useState<string>(() => `exam-${Date.now()}`);
  const [idx, setIdx] = useState(0);
  const [phase, setPhase] = useState<Phase>('intro');
  const [remaining, setRemaining] = useState(SECTIONS[0].limitSec);
  const [countdown, setCountdown] = useState(settings.exam.countdownSec);
  const [prepRemaining, setPrepRemaining] = useState(settings.exam.speakPrepSec);
  const [level, setLevel] = useState(0);
  const [peak, setPeak] = useState(0);
  const [topic, setTopic] = useState<string | null>(null);
  const [micLabel, setMicLabel] = useState('');
  const [devices, setDevices] = useState<MicDevice[]>([]);
  const [deviceId, setDeviceId] = useState<string>('');
  const [records, setRecords] = useState<Partial<Record<SectionKey, { wav: Blob; durationSec: number }>>>({});
  const [results, setResults] = useState<Partial<Record<SectionKey, SectionResult>>>({});
  const [scoringSteps, setScoringSteps] = useState<{ key: SectionKey; state: 'wait' | 'run' | 'ok' | 'fail'; note: string }[]>(
    [],
  );
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const recorderRef = useRef<Recorder | null>(null);
  const savedRef = useRef(false);
  const scoringRef = useRef(false);
  const spec = SECTIONS[idx];
  const tts = settings.tts;

  const rec = useMemo(() => {
    if (!recorderRef.current) recorderRef.current = new Recorder();
    return recorderRef.current;
  }, []);

  const say = useCallback(
    (text: string) => {
      if (!settings.exam.prompts) return;
      void speak(text, tts);
    },
    [settings.exam.prompts, tts],
  );

  /** 用户点了「继续 / 开始答题 / 下一项」等按钮：立刻掐断还在播的指导语，别盖住录音 */
  const stopSay = useCallback(() => stopSpeaking(), []);

  /* ------------------------------ 麦克风电平 ------------------------------ */
  useEffect(() => {
    const id = window.setInterval(() => {
      const r = recorderRef.current;
      if (!r) return;
      setLevel(r.getLevel());
      setPeak(r.getPeak());
    }, 100);
    return () => clearInterval(id);
  }, []);

  /* ------------------------------ 开考须知 ------------------------------ */
  useEffect(() => {
    if (phase === 'intro') void speak(EXAM_INTRO.join(' '), tts);
    return () => {
      /* noop */
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 离开考试页（退出 / 评分完成回首页）时掐断提示音，避免声音继续播 */
  useEffect(
    () => () => {
      stopSpeaking();
    },
    [],
  );

  /* ------------------------------ 倒计时 ------------------------------ */
  useEffect(() => {
    if (phase !== 'countdown') return;
    if (countdown <= 0) {
      void startAnswering();
      return;
    }
    void playBeep(760, 140, 0.3);
    const t = window.setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, countdown]);

  /* ------------------------------ 命题说话准备 ------------------------------ */
  useEffect(() => {
    if (phase !== 'prep') return;
    if (prepRemaining <= 0) {
      setPhase('countdown');
      setCountdown(settings.exam.countdownSec);
      return;
    }
    if (prepRemaining <= 5) void playBeep(660, 120, 0.22);
    const t = window.setTimeout(() => setPrepRemaining((c) => c - 1), 1000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, prepRemaining]);

  /* ------------------------------ 答题计时 ------------------------------ */
  useEffect(() => {
    if (phase !== 'answering') return;
    const t = window.setInterval(() => setRemaining((r) => Math.max(0, r - 1)), 1000);
    return () => clearInterval(t);
  }, [phase]);

  useEffect(() => {
    if (phase !== 'answering') return;
    if (remaining <= 0) {
      void stopAndSave('timeout');
      return;
    }
    if (settings.exam.warnSeconds.includes(remaining)) {
      void playBeep(720, 150, 0.25);
      say(warnText(remaining));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remaining, phase]);

  /* ------------------------------ 流程动作 ------------------------------ */
  async function beginDevice(): Promise<void> {
    stopSay();
    setError('');
    setPhase('device');
    try {
      setDevices(await Recorder.listDevices());
      const label = await rec.probe(deviceId || undefined);
      setMicLabel(label);
      await rec.start(deviceId || undefined, settings.exam.rawMic);
      setNotice('麦克风已开启，请对着麦克风说几句话，观察电平条。');
    } catch (err) {
      setError(`麦克风不可用：${(err as Error).message}`);
    }
  }

  async function confirmDevice(): Promise<void> {
    stopSay();
    if (rec.recording) await rec.stop();
    savedRef.current = false;
    setNotice('');
    setPhase('brief');
    say(sectionGuide(spec.key, paper));
  }

  async function startAnswering(): Promise<void> {
    stopSay();
    setPhase('answering');
    savedRef.current = false;
    setRemaining(spec.limitSec);
    try {
      await rec.start(deviceId || undefined, settings.exam.rawMic);
      await playDoubleBeep();
      say(spec.key === 'speak' ? SPEAK_PREP_TEXT : '计时开始，请开始朗读。');
    } catch (err) {
      setError(`录音启动失败：${(err as Error).message}`);
      setPhase('brief');
    }
  }

  async function stopAndSave(reason: 'manual' | 'timeout'): Promise<void> {
    if (savedRef.current) return;
    savedRef.current = true;
    stopSay();
    const key = spec.key;
    let res: RecordingResult | null = null;
    try {
      if (rec.recording) res = await rec.stop();
    } catch (err) {
      setError(`录音保存失败：${(err as Error).message}`);
    }
    if (res) {
      putAudio(RECORDINGS_KEY(resultId), key, res.wav, res.durationSec);
      setRecords((prev) => ({ ...prev, [key]: { wav: res!.wav, durationSec: res!.durationSec } }));
      if (res.durationSec < 1) setNotice('录音时长不足 1 秒，请检查麦克风。');
      else if (reason === 'timeout') setNotice(SECTION_END_TEXT);
    }
    setPhase('saved');
    void playBeep(520, 260, 0.28);
    say(SECTION_END_TEXT);
  }

  function retake(): void {
    stopSay();
    savedRef.current = false;
    setNotice('');
    setPhase('brief');
  }

  function advance(): void {
    stopSay();
    setNotice('');
    if (idx < SECTIONS.length - 1) {
      const next = idx + 1;
      setIdx(next);
      setRemaining(SECTIONS[next].limitSec);
      const nextSpec = SECTIONS[next];
      if (nextSpec.key === 'speak') {
        setPhase('pick');
        say(SPEAK_PICK_TEXT);
      } else {
        setPhase('brief');
        say(sectionGuide(nextSpec.key, paper));
      }
    } else {
      void runScoring();
    }
  }

  function selectTopic(t: string): void {
    stopSay();
    setTopic(t);
    setPrepRemaining(settings.exam.speakPrepSec);
    setPhase('prep');
    say(`你选择的话题是：${t}。请准备。`);
  }

  /* ------------------------------ 评分 ------------------------------ */
  async function scoreOne(key: SectionKey): Promise<SectionResult> {
    const record = records[key];
    if (!record) throw new Error('没有找到本项录音');
    const engine = pickEngine(key, settings);

    if (engine === 'ise') {
      if (key === 'speak') {
        // 未配置大模型时的兜底：讯飞语音听写 + 讯飞 ISE 自参考评测
        return await speakScoreSection({
          wav: record.wav,
          durationSec: record.durationSec,
          settings: settings.ise,
          onProgress: (note) => updateStep(key, 'run', note),
        });
      }
      const category = iseCategoryFor(key, settings.ise);
      const raw = await iseEvaluate({
        wav: record.wav,
        refText: iseRefText(key, paper),
        category,
        settings: settings.ise,
        onProgress: (note) => updateStep(key, 'run', note),
      });
      return iseScoreSection(key, raw, record.durationSec);
    }

    if (engine === 'llm') {
      let transcript: string | undefined;
      // 「先转写再评分」且转写来源选择讯飞听写时，先用讯飞把录音转成文字
      if (settings.llm.audioMode === 'asr' && settings.llm.asrSource === 'xfyun') {
        if (!iseReady(settings)) throw new Error('已选择讯飞听写作为转写来源，但未配置讯飞凭据');
        updateStep(key, 'run', '讯飞语音听写转写中…');
        transcript = await transcribeWav(record.wav, {
          settings: settings.ise,
          onProgress: (note) => updateStep(key, 'run', note),
        });
      }
      return await llmScoreSection({
        key,
        refText: refTextFor(key, paper),
        wav: record.wav,
        durationSec: record.durationSec,
        settings: settings.llm,
        transcript,
        onProgress: (note) => updateStep(key, 'run', note),
      });
    }

    return demoScore(key, record.durationSec, paper);
  }

  function updateStep(key: SectionKey, state: 'wait' | 'run' | 'ok' | 'fail', note: string): void {
    setScoringSteps((prev) => prev.map((s) => (s.key === key ? { ...s, state, note } : s)));
  }

  async function runScoring(): Promise<void> {
    if (scoringRef.current) return;
    scoringRef.current = true;
    setPhase('finishing');
    say(FINISH_TEXT);
    const order = SECTIONS.map((s) => s.key);
    setScoringSteps(order.map((key) => ({ key, state: 'wait' as const, note: '' })));
    const out: SectionResult[] = [];

    for (const key of order) {
      const s = SECTION_MAP[key];
      updateStep(key, 'run', '准备中…');
      try {
        const r = await scoreOne(key);
        out.push(r);
        updateStep(key, 'ok', `${r.score.toFixed(1)} / ${r.maxScore} 分`);
        setResults((prev) => ({ ...prev, [key]: r }));
      } catch (err) {
        const failed: SectionResult = {
          key,
          title: s.name,
          maxScore: s.maxScore,
          score: 0,
          limitSec: s.limitSec,
          durationSec: records[key]?.durationSec ?? 0,
          comment: '',
          items: [],
          issues: [],
          engine: 'none',
          errorMessage: (err as Error).message,
        };
        out.push(failed);
        updateStep(key, 'fail', (err as Error).message);
        setResults((prev) => ({ ...prev, [key]: failed }));
      }
    }

    const total = Math.round(out.reduce((n, r) => n + r.score, 0) * 10) / 10;
    const worst = [...out].sort((a, b) => a.score / a.maxScore - b.score / b.maxScore)[0];
    const overall =
      total >= 87
        ? `总分 ${total.toFixed(1)} 分，普通话语音面貌较好，注意个别字词的声调与前后鼻音，继续保持朗读的流畅度。`
        : total >= 70
          ? `总分 ${total.toFixed(1)} 分，整体可正常交流，主要失分集中在${worst?.title ?? '部分分项'}，建议加强声韵调基本功与朗读停连练习。`
          : `总分 ${total.toFixed(1)} 分，方音较重，建议系统练习声母、韵母、声调，尤其是平翘舌、前后鼻音与上声变调。`;

    const result: ExamResult = {
      id: resultId,
      createdAt: new Date().toISOString(),
      total,
      maxTotal: 100,
      level: levelOf(total),
      engineLabel: Array.from(new Set(out.map((r) => engineNote(r.key, r.engine)))).join('；'),
      paper,
      sections: out,
      overallComment: overall,
    };
    setPhase('finished');
    scoringRef.current = false;
    window.setTimeout(() => onDone(result), 400);
  }

  /* ------------------------------ 渲染 ------------------------------ */
  const currentRecord = records[spec.key];
  const phaseText: Record<Phase, string> = {
    intro: '考前须知',
    device: '设备调试',
    brief: `${spec.ordinal} · 准备`,
    countdown: `${spec.ordinal} · 即将开始`,
    answering: `${spec.ordinal} · 答题中`,
    saved: `${spec.ordinal} · 已完成`,
    pick: '命题说话 · 选题',
    prep: '命题说话 · 准备',
    finishing: '正在评分',
    finished: '评分完成',
  };

  return (
    <div className="exam-page" data-testid="exam-page">
      <header className="exam-top">
        <div className="exam-progress" data-testid="exam-progress">
          {SECTIONS.map((s, i) => (
            <div
              key={s.key}
              className={`step ${i === idx && phase !== 'intro' && phase !== 'device' ? 'current' : ''} ${
                i < idx ? 'done' : ''
              }`}
            >
              <span className="step-no">{i + 1}</span>
              <span className="step-name">{s.name}</span>
            </div>
          ))}
        </div>
        <div className="exam-status">
          <span className="phase-chip" data-testid="exam-phase">
            {phaseText[phase]}
          </span>
          <span className={`timer ${remaining <= 30 && phase === 'answering' ? 'urgent' : ''}`} data-testid="exam-countdown">
            {fmt(phase === 'prep' ? prepRemaining : remaining)}
          </span>
          <button type="button" className="ghost" onClick={() => { if (window.confirm('确定退出本次考试？已录音的题目将不会保存。')) { stopSay(); onQuit(); } }}>
            退出
          </button>
        </div>
      </header>

      {error && (
        <div className="banner error" data-testid="exam-error">
          {error}
          <button type="button" className="link" onClick={() => setError('')}>
            关闭
          </button>
        </div>
      )}
      {notice && <div className="banner info">{notice}</div>}

      <main className="exam-main">
        {phase === 'intro' && (
          <section className="panel intro-panel">
            <h2>考前须知</h2>
            <ol className="intro-list">
              <li>本次模拟考试按《普通话水平测试大纲》4 项制组织，满分 100 分。</li>
              <li>请使用 Chrome / Edge 等现代浏览器，并允许使用麦克风。</li>
              <li>每一项开考前会播报本地语音提示，提示结束后自动开始计分倒计时。</li>
              <li>请保持环境安静，麦克风与嘴部距离约 15 厘米，不要遮挡麦克风。</li>
              <li>录音只在本机处理，评分时按你的设置在浏览器内直接调用讯飞 / 大模型接口。</li>
            </ol>
            <div className="intro-actions">
              <button type="button" className="primary" data-testid="btn-device" onClick={() => void beginDevice()}>
                开始设备调试
              </button>
              <button type="button" className="ghost" onClick={() => { stopSay(); setPhase('brief'); say(sectionGuide(spec.key, paper)); }}>
                跳过调试
              </button>
            </div>
          </section>
        )}

        {phase === 'device' && (
          <section className="panel device-panel">
            <h2>设备调试</h2>
            <p className="muted">
              当前设备：{micLabel || '未检测到'}
              {settings.exam.rawMic ? '（已关闭浏览器降噪/AGC，保留原始音质）' : '（已开启浏览器降噪/AGC）'}
            </p>
            {devices.length > 1 && (
              <label className="field">
                <span>选择麦克风</span>
                <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
                  <option value="">默认设备</option>
                  {devices.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <LevelMeter level={level} peak={peak} active />
            <p className="muted">请朗读下面这句话，确认电平条随声音变化：</p>
            <p className="device-line">四是四，十是十，十四是十四，四十是四十。</p>
            <div className="intro-actions">
              <button type="button" className="primary" data-testid="btn-device-ok" onClick={() => void confirmDevice()}>
                设备正常，进入考试
              </button>
              <button type="button" className="ghost" onClick={() => void beginDevice()}>
                重新检测
              </button>
            </div>
          </section>
        )}

        {(phase === 'brief' || phase === 'countdown' || phase === 'answering' || phase === 'saved') && (
          <section className="panel section-panel">
            <div className="section-head">
              <h2>
                {spec.ordinal} · {spec.name}
                <span className="score-badge">满分 {spec.maxScore} 分</span>
                <span className="limit-badge">限时 {fmt(spec.limitSec)}</span>
              </h2>
              <p className="muted">{spec.purpose}</p>
            </div>

            {phase === 'brief' && (
              <>
                <div className="requirement">{spec.requirement}</div>
                <div className="scoring-rule">{spec.scoring}</div>
                <div className="intro-actions">
                  <button
                    type="button"
                    className="primary"
                    data-testid="btn-start-answer"
                    onClick={() => {
                      stopSay();
                      setCountdown(settings.exam.countdownSec);
                      setPhase('countdown');
                    }}
                  >
                    开始答题（{settings.exam.countdownSec} 秒倒计时）
                  </button>
                  <button type="button" className="ghost" onClick={() => { stopSay(); setPhase('device'); }}>
                    重新试音
                  </button>
                </div>
              </>
            )}

            {phase === 'countdown' && (
              <div className="countdown-wrap">
                <div className="countdown-num" data-testid="countdown-num">
                  {countdown}
                </div>
                <div className="muted">倒计时结束后开始录音</div>
              </div>
            )}

            {(phase === 'answering' || phase === 'saved') && (
              <div className="answer-area">
                <div className="answer-header">
                  <LevelMeter level={level} peak={peak} active={phase === 'answering'} />
                  <div className="answer-actions">
                    {phase === 'answering' ? (
                      <button type="button" className="primary" data-testid="btn-finish-section" onClick={() => void stopAndSave('manual')}>
                        我读完了，停止录音
                      </button>
                    ) : (
                      <>
                        <button type="button" className="ghost" onClick={retake} data-testid="btn-retake">
                          重录本项
                        </button>
                        <button type="button" className="primary" data-testid="btn-next-section" onClick={advance}>
                          {idx < SECTIONS.length - 1 ? '进入下一项' : '提交评分'}
                        </button>
                      </>
                    )}
                  </div>
                </div>
                <div className="paper-view">
                  {spec.key === 'mono' && <MonoView items={paper.mono} showPinyin={settings.exam.showPinyin} />}
                  {spec.key === 'poly' && <PolyView items={paper.poly} showPinyin={settings.exam.showPinyin} />}
                  {spec.key === 'read' && <ReadView work={paper.read} />}
                  {spec.key === 'speak' && (
                    <SpeakView
                      topics={paper.speak}
                      selected={topic}
                      onSelect={selectTopic}
                      phase="speak"
                      prepRemaining={0}
                      disabled
                    />
                  )}
                </div>
                {phase === 'saved' && currentRecord && (
                  <div className="saved-info">
                    本项录音已保存：{currentRecord.durationSec.toFixed(1)} 秒
                    {currentRecord.durationSec < spec.limitSec * 0.5 && (
                      <span className="warn-text">（录音时长偏短，请确认是否读完）</span>
                    )}
                  </div>
                )}
              </div>
            )}
          </section>
        )}

        {(phase === 'pick' || phase === 'prep') && (
          <section className="panel section-panel">
            <div className="section-head">
              <h2>
                第四项 · 命题说话
                <span className="score-badge">满分 {SECTION_MAP.speak.maxScore} 分</span>
                <span className="limit-badge">限时 03:00</span>
              </h2>
              <p className="muted">{SECTION_MAP.speak.purpose}</p>
            </div>
            <div className="requirement">
              {phase === 'pick' ? '请从下面两道题目中选择一道（鼠标点击）。' : '准备时间：请在心里列好提纲，准备好后系统会自动开始。'}
            </div>
            <SpeakView
              topics={paper.speak}
              selected={topic}
              onSelect={selectTopic}
              phase={phase === 'prep' ? 'prep' : 'pick'}
              prepRemaining={prepRemaining}
            />
            {phase === 'prep' && (
              <div className="intro-actions">
                <button
                  type="button"
                  className="primary"
                  onClick={() => {
                    stopSay();
                    setCountdown(settings.exam.countdownSec);
                    setPhase('countdown');
                  }}
                >
                  准备好了，立即开始
                </button>
              </div>
            )}
          </section>
        )}

        {(phase === 'finishing' || phase === 'finished') && (
          <section className="panel finish-panel">
            <h2>{phase === 'finishing' ? '正在评分' : '评分完成'}</h2>
            <p className="muted">
              {iseReady(settings) || llmReady(settings)
                ? '正在调用评分引擎，请勿关闭页面。单项评分通常需要 10~60 秒。'
                : '未配置讯飞 ISE 或大模型接口，本次将使用演示模式评分（结果不代表真实水平）。'}
            </p>
            <ul className="scoring-list" data-testid="scoring-list">
              {scoringSteps.map((s) => {
                const sp = SECTION_MAP[s.key];
                const r = results[s.key];
                return (
                  <li key={s.key} className={`scoring-item ${s.state}`}>
                    <span className="scoring-name">{sp.name}</span>
                    <span className="scoring-state">
                      {s.state === 'wait' && '等待中'}
                      {s.state === 'run' && `评分中${s.note ? `：${s.note}` : '…'}`}
                      {s.state === 'ok' && `${r?.score.toFixed(1) ?? '-'} / ${sp.maxScore} 分（${r?.engine === 'ise' ? '讯飞 ISE' : r?.engine === 'llm' ? '大模型' : '演示'}）`}
                      {s.state === 'fail' && `失败：${s.note}`}
                    </span>
                  </li>
                );
              })}
            </ul>
            {phase === 'finishing' && <div className="loading-bar" />}
          </section>
        )}
      </main>
    </div>
  );
}
