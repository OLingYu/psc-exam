import { useState } from 'react';
import { poolStats } from '../lib/draw';
import { examOutline, EXAM_INTRO } from '../lib/prompts';
import { levelOf } from '../lib/grade';
import { Recorder } from '../lib/recorder';
import { builtinSupported, hasLocalChineseVoice, preferredChineseVoice, preview } from '../lib/tts';
import { iseReady, llmReady, scoringLabel } from '../lib/sections';
import { fmtScore } from '../lib/grade';
import type { HistoryItem, Settings } from '../types';

interface Props {
  settings: Settings;
  history: HistoryItem[];
  onStart: () => void;
  onGoto: (page: 'settings' | 'bank' | 'history') => void;
  onToast: (msg: string, kind?: 'ok' | 'err') => void;
}

export function Home({ settings, history, onStart, onGoto, onToast }: Props) {
  const stats = poolStats();
  const label = scoringLabel(settings);
  const [micState, setMicState] = useState<'idle' | 'checking' | 'ok' | 'fail'>('idle');
  const [micMsg, setMicMsg] = useState('');
  const [ttsState, setTtsState] = useState('');

  const checkMic = async (): Promise<void> => {
    setMicState('checking');
    try {
      const rec = new Recorder();
      const name = await rec.probe();
      setMicMsg(name);
      setMicState('ok');
    } catch (err) {
      setMicMsg((err as Error).message);
      setMicState('fail');
    }
  };

  const testTts = async (): Promise<void> => {
    setTtsState('播放中…');
    const msg = await preview(EXAM_INTRO[0], settings.tts);
    setTtsState(msg);
    onToast(msg, msg.includes('成功') ? 'ok' : 'err');
  };

  const ttsLabel =
    settings.tts.engine === 'off'
      ? '已关闭'
      : settings.tts.engine === 'http'
        ? '本机 HTTP 服务'
        : builtinSupported()
          ? hasLocalChineseVoice()
            ? `浏览器内置（${preferredChineseVoice()?.name ?? '本地中文语音'}）`
            : '浏览器内置（未检测到本地中文语音）'
          : '不支持';

  return (
    <div className="page home-page" data-testid="home-page">
      <section className="hero">
        <div className="hero-text">
          <span className="hero-badge">普通话水平测试 · 模拟机考</span>
          <h1>
            按大纲走完一遍
            <br />
            真实的<a className="hover-tip" title="普测四项：读单音节、读多音节、朗读短文、命题说话" href="#/bank">四项考试</a>
          </h1>
          <p className="hero-sub">
            本地 TTS 播报考试提示音 · 浏览器直接录音 · 讯飞 ISE 逐字发音评测 · 命题说话交给外部大模型按大纲评分
          </p>
          <div className="hero-actions">
            <button type="button" className="primary big" data-testid="btn-start-exam" onClick={onStart}>
              开始模拟考试
            </button>
            <button type="button" className="ghost big" onClick={() => onGoto('settings')}>
              配置评分接口
            </button>
          </div>
          <p className="hero-note">
            首次使用请先到「接口配置」填写讯飞 AppID/APIKey/APISecret（前三项）与大模型接口（命题说话）；
            未配置时会以演示模式跑通流程。
          </p>
        </div>
        <div className="hero-card">
          <div className="status-row">
            <span className="status-k">评分方式</span>
            <span className="status-v" data-testid="mode-chip">
              {label.short}
            </span>
          </div>
          <div className="status-row">
            <span className="status-k">讯飞 ISE</span>
            <span className={`status-v ${iseReady(settings) ? 'ok' : 'warn'}`}>
              {iseReady(settings) ? '凭据已配置' : '未配置（前三项无法真实评分）'}
            </span>
          </div>
          <div className="status-row">
            <span className="status-k">命题说话大模型</span>
            <span className={`status-v ${llmReady(settings) ? 'ok' : 'warn'}`}>
              {llmReady(settings) ? `${settings.llm.model || '已配置'}（${settings.llm.audioMode === 'direct' ? '录音直传' : '先转写'}）` : '未配置'}
            </span>
          </div>
          <div className="status-row">
            <span className="status-k">提示音 TTS</span>
            <span className="status-v">{ttsLabel}</span>
          </div>
          <div className="status-row">
            <span className="status-k">麦克风</span>
            <span className={`status-v ${micState === 'ok' ? 'ok' : micState === 'fail' ? 'warn' : ''}`}>
              {micState === 'idle' ? '未检测' : micState === 'checking' ? '检测中…' : micMsg}
            </span>
          </div>
          <div className="status-actions">
            <button type="button" className="ghost small" onClick={() => void checkMic()}>
              检测麦克风
            </button>
            <button type="button" className="ghost small" onClick={() => void testTts()}>
              试听提示音
            </button>
          </div>
          {ttsState && <div className="status-hint">{ttsState}</div>}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>试卷构成（大纲 4 项制，满分 100）</h2>
          <button type="button" className="link" onClick={() => onGoto('bank')}>
            查看题库 →
          </button>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>分项</th>
              <th>要求</th>
              <th>限时</th>
              <th>分值</th>
              <th>评分引擎</th>
            </tr>
          </thead>
          <tbody>
            {examOutline().map((s, i) => (
              <tr key={s.name}>
                <td>
                  <b>{s.ordinal}</b> {s.name}
                </td>
                <td className="muted">
                  {i === 0 && '100 个音节'}
                  {i === 1 && '100 个音节'}
                  {i === 2 && '1 篇 400 音节'}
                  {i === 3 && '二选一，连续说满 3 分钟'}
                </td>
                <td>{s.limit}</td>
                <td>
                  <b>{s.maxScore}</b>
                </td>
                <td>
                  {i < 3 ? (
                    <span className="tag tag-ise">讯飞 ISE</span>
                  ) : (
                    <span className="tag tag-llm">{settings.llm.audioMode === 'direct' ? '大模型（录音直传）' : '大模型（先转写）'}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small">
          说明：附件大纲为 5 项 100 分制（含「选择判断」10 分）。大纲「特别说明」允许免测选择判断，此时命题说话由 30 分调为 40 分。
          本项目采用该 4 项制口径，未实现选择判断（附件未提供方言词语/语法差异对照表）。
        </p>
      </section>

      <section className="grid-3">
        <div className="panel mini">
          <h3>考试流程</h3>
          <ol className="steps">
            <li>考前须知 + 设备调试（麦克风试音）</li>
            <li>读单音节字词 100 个（10 分）</li>
            <li>读多音节词语 100 个音节（20 分）</li>
            <li>朗读短文 400 音节（30 分）</li>
            <li>命题说话 二选一 3 分钟（40 分）</li>
            <li>提交评分 → 成绩页（分级 + 扣分明细）</li>
          </ol>
        </div>
        <div className="panel mini">
          <h3>题库规模</h3>
          <ul className="stat-list">
            <li>
              <b>{stats.works}</b> 篇朗读作品（附件 PDF 提取）
            </li>
            <li>
              <b>{stats.topics}</b> 个命题说话题目（附件 话题.txt）
            </li>
            <li>
              <b>{stats.chars}</b> 个单音节字（含声母/韵母/声调标注）
            </li>
            <li>
              <b>{stats.words}</b> 个多音节词语（含轻声/儿化/上声标注）
            </li>
            <li>
              声母 <b>{stats.initials}</b> / 韵母 <b>{stats.finals}</b> / 声调 <b>{stats.tones}</b>
            </li>
          </ul>
        </div>
        <div className="panel mini">
          <h3>最近成绩</h3>
          {history.length === 0 ? (
            <p className="muted">还没有考试记录，考一次试试。</p>
          ) : (
            <ul className="history-mini" data-testid="history-mini">
              {history.slice(0, 4).map((h) => (
                <li key={h.id}>
                  <span className="hm-score">{fmtScore(h.total)}</span>
                  <span className="hm-level">{h.level}</span>
                  <span className="hm-date">{new Date(h.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                </li>
              ))}
            </ul>
          )}
          <button type="button" className="link" onClick={() => onGoto('history')}>
            全部记录 →
          </button>
        </div>
      </section>

      <section className="panel">
        <h2>等级标准</h2>
        <div className="level-scale">
          {[
            ['一级甲等', '97 分及以上'],
            ['一级乙等', '92 ~ 96.9'],
            ['二级甲等', '87 ~ 91.9'],
            ['二级乙等', '80 ~ 86.9'],
            ['三级甲等', '70 ~ 79.9'],
            ['三级乙等', '60 ~ 69.9'],
          ].map(([name, range]) => (
            <div className="level-item" key={name}>
              <span className="level-name">{name}</span>
              <span className="level-range">{range}</span>
              <span className="level-note">{levelOf(Number.parseFloat(range))}...</span>
            </div>
          ))}
        </div>
        <p className="muted small">
          分级依据《普通话水平测试等级标准》。本系统为模拟练习工具，评分由机器完成，不代表官方成绩。
        </p>
      </section>
    </div>
  );
}
