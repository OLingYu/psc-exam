import { useEffect, useState } from 'react';
import { testIse } from '../lib/ise';
import { testAsr, testLlm } from '../lib/llm';
import { iseReady, llmReady, scoringLabel } from '../lib/sections';
import { preview, listVoices, waitForVoices, type VoiceOption } from '../lib/tts';
import type { Settings } from '../types';

interface Props {
  settings: Settings;
  onChange: (s: Settings) => void;
  onToast: (msg: string, kind?: 'ok' | 'err') => void;
}

type Tab = 'ise' | 'llm' | 'tts' | 'exam';

const TABS: { key: Tab; label: string; desc: string }[] = [
  { key: 'ise', label: '讯飞接口', desc: '读单音节 / 多音节 / 朗读短文 的发音评测' },
  { key: 'llm', label: '大模型接口', desc: '命题说话评分（可直传录音或先转写再评分）' },
  { key: 'tts', label: '本地语音', desc: '考试提示音（本地 TTS 生成）' },
  { key: 'exam', label: '考试参数', desc: '倒计时、提醒、麦克风等' },
];

function Field(props: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  required?: boolean;
  ok?: boolean;
}) {
  return (
    <label className={`field ${props.required ? 'is-required' : ''}`}>
      <span className="field-label">
        {props.label}
        {props.required && <em className="req">必填</em>}
        {props.ok !== undefined && (
          <em className={props.ok ? 'ok' : 'warn'}>{props.ok ? '已填写' : '待填写'}</em>
        )}
      </span>
      {props.children}
      {props.hint && <span className="field-hint">{props.hint}</span>}
    </label>
  );
}

function SecretInput(props: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [show, setShow] = useState(false);
  return (
    <span className="secret-wrap">
      <input
        type={show ? 'text' : 'password'}
        value={props.value}
        placeholder={props.placeholder}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => props.onChange(e.target.value)}
      />
      <button type="button" className="link" onClick={() => setShow((s) => !s)}>
        {show ? '隐藏' : '显示'}
      </button>
    </span>
  );
}

export function SettingsPage({ settings, onChange, onToast }: Props) {
  const [tab, setTab] = useState<Tab>('ise');
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [testing, setTesting] = useState('');
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    void (async () => {
      await waitForVoices();
      setVoices(listVoices());
    })();
  }, []);

  const patch = <K extends keyof Settings>(section: K, value: Partial<Settings[K]>): void => {
    onChange({ ...settings, [section]: { ...settings[section], ...value } });
    setDirty(true);
  };

  const test = async (key: string, fn: () => Promise<string>): Promise<void> => {
    setTesting(key);
    try {
      const msg = await fn();
      onToast(msg, 'ok');
    } catch (err) {
      onToast((err as Error).message, 'err');
    } finally {
      setTesting('');
    }
  };

  const save = (): void => {
    onToast('配置已保存到本浏览器（localStorage）', 'ok');
    setDirty(false);
  };

  const exportConfig = (): void => {
    const blob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `psc-exam-config-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const importConfig = (file: File): void => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const raw = JSON.parse(String(reader.result));
        onChange({ ...settings, ...raw });
        setDirty(true);
        onToast('配置已导入，请点「保存配置」', 'ok');
      } catch (err) {
        onToast(`导入失败：${(err as Error).message}`, 'err');
      }
    };
    reader.readAsText(file);
  };

  const { ise, llm, tts, exam } = settings;
  const label = scoringLabel(settings);

  return (
    <div className="page settings-page" data-testid="settings-page">
      <header className="page-head">
        <div>
          <h1>接口配置</h1>
          <p className="muted">
            当前评分方式：<strong>{label.short}</strong> —— {label.detail}
          </p>
        </div>
        <div className="head-actions">
          <button type="button" className="ghost" onClick={exportConfig}>
            导出配置
          </button>
          <label className="ghost as-label">
            导入配置
            <input
              type="file"
              accept="application/json"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) importConfig(f);
                e.target.value = '';
              }}
            />
          </label>
          <button type="button" className="primary" data-testid="btn-save-settings" onClick={save}>
            保存配置{dirty ? ' •' : ''}
          </button>
        </div>
      </header>

      <nav className="tabs">
        {TABS.map((t) => (
          <button
            type="button"
            key={t.key}
            className={`tab ${tab === t.key ? 'active' : ''}`}
            onClick={() => setTab(t.key)}
            data-testid={`tab-${t.key}`}
          >
            <span className="tab-label">{t.label}</span>
            <span className="tab-desc">{t.desc}</span>
          </button>
        ))}
      </nav>

      {tab === 'ise' && (
        <section className="panel form-panel">
          <div className="panel-head">
            <h2>讯飞开放平台 · 语音评测（流式版）</h2>
            <div className="panel-actions">
              <span className={`pill ${iseReady(settings) ? 'ok' : 'warn'}`}>{iseReady(settings) ? '凭据已填写' : '凭据未填写'}</span>
              <button
                type="button"
                className="ghost"
                disabled={testing === 'ise' || !iseReady(settings)}
                data-testid="btn-test-ise"
                onClick={() =>
                  test('ise', () =>
                    iseReady(settings) ? testIse(settings.ise) : Promise.reject(new Error('请先填写 AppID / APIKey / APISecret')),
                  )
                }
              >
                {testing === 'ise' ? '测试中…' : '测试连通性'}
              </button>
            </div>
          </div>

          <p className="notice">
            在<a href="https://console.xfyun.cn/app/myapp" target="_blank" rel="noreferrer">讯飞控制台</a>
            创建应用并开通「语音评测（流式版）」与「语音听写（流式版）」后，把同一应用的三元组填在这里。
            朗读类三项用<b>语音评测</b>；若命题说话未配置大模型，会用<b>语音听写</b>转写后再评测。
          </p>

          <div className="grid-2">
            <Field label="AppID" required ok={Boolean(ise.appId.trim())}>
              <input value={ise.appId} onChange={(e) => patch('ise', { appId: e.target.value })} placeholder="例如 1234abcd" spellCheck={false} />
            </Field>
            <Field label="APIKey" required ok={Boolean(ise.apiKey.trim())}>
              <SecretInput value={ise.apiKey} onChange={(v) => patch('ise', { apiKey: v })} placeholder="32 位字符串" />
            </Field>
            <Field label="APISecret" required ok={Boolean(ise.apiSecret.trim())}>
              <SecretInput value={ise.apiSecret} onChange={(v) => patch('ise', { apiSecret: v })} placeholder="32 位字符串" />
            </Field>
            <Field label="评测语种 ent" hint="中文为 cn_vip，英文为 en_vip">
              <select value={ise.ent} onChange={(e) => patch('ise', { ent: e.target.value as Settings['ise']['ent'] })}>
                <option value="cn_vip">cn_vip（中文）</option>
                <option value="en_vip">en_vip（英文）</option>
              </select>
            </Field>
            <Field label="评测题型 category" hint="auto 会按分项自动选：单音节→read_syllable、词语→read_word、短文/说话→read_chapter">
              <select
                value={ise.category}
                onChange={(e) => patch('ise', { category: e.target.value as Settings['ise']['category'] })}
              >
                <option value="auto">auto（按分项自动）</option>
                <option value="read_syllable">read_syllable 单字</option>
                <option value="read_word">read_word 词语</option>
                <option value="read_sentence">read_sentence 句子</option>
                <option value="read_chapter">read_chapter 篇章</option>
              </select>
            </Field>
            <Field label="评测群体 group" hint="成人参加普通话水平测试选 adult">
              <select value={ise.group} onChange={(e) => patch('ise', { group: e.target.value as Settings['ise']['group'] })}>
                <option value="adult">adult 成人</option>
                <option value="youth">youth 中学</option>
                <option value="pupil">pupil 小学</option>
              </select>
            </Field>
            <Field label="打分松紧 check_type">
              <select
                value={ise.checkType}
                onChange={(e) => patch('ise', { checkType: e.target.value as Settings['ise']['checkType'] })}
              >
                <option value="common">common 普通</option>
                <option value="easy">easy 容易</option>
                <option value="hard">hard 困难</option>
              </select>
            </Field>
            <Field label="拓展能力 extra_ability" hint="需要控制台已开通全维度权限；留空则不请求维度分">
              <input
                value={ise.extraAbility}
                onChange={(e) => patch('ise', { extraAbility: e.target.value })}
                placeholder="multi_dimension;syll_phone_err_msg"
                spellCheck={false}
              />
            </Field>
            <Field label="评测接口 host" hint="默认 ise-api.xfyun.cn">
              <input value={ise.host} onChange={(e) => patch('ise', { host: e.target.value })} spellCheck={false} />
            </Field>
            <Field label="评测接口 path" hint="默认 /v2/open-ise">
              <input value={ise.path} onChange={(e) => patch('ise', { path: e.target.value })} spellCheck={false} />
            </Field>
            <Field label="语音听写 host" hint="命题说话兜底转写用，默认 iat-api.xfyun.cn">
              <input value={ise.iatHost} onChange={(e) => patch('ise', { iatHost: e.target.value })} spellCheck={false} />
            </Field>
            <Field label="语音听写 path" hint="默认 /v2/iat">
              <input value={ise.iatPath} onChange={(e) => patch('ise', { iatPath: e.target.value })} spellCheck={false} />
            </Field>
            <Field label="送评增益" hint="0 = 不处理；0.9 会把录音峰值归一到 90%，录音音量偏小时更容易评准">
              <input
                type="number"
                step="0.1"
                min="0"
                max="1"
                value={ise.gain}
                onChange={(e) => patch('ise', { gain: Number(e.target.value) })}
              />
            </Field>
          </div>
        </section>
      )}

      {tab === 'llm' && (
        <section className="panel form-panel">
          <div className="panel-head">
            <h2>外部大模型 · 命题说话评分</h2>
            <div className="panel-actions">
              <span className={`pill ${llmReady(settings) ? 'ok' : 'warn'}`}>{llmReady(settings) ? '接口已配置' : '接口未配置'}</span>
              <button
                type="button"
                className="ghost"
                disabled={testing === 'llm' || !llmReady(settings)}
                data-testid="btn-test-llm"
                onClick={() => test('llm', () => testLlm(settings.llm))}
              >
                {testing === 'llm' ? '测试中…' : '测试对话接口'}
              </button>
              <button
                type="button"
                className="ghost"
                disabled={testing === 'asr' || llm.audioMode !== 'asr' || llm.asrSource !== 'endpoint'}
                onClick={() => test('asr', () => testAsr(settings.llm))}
              >
                {testing === 'asr' ? '测试中…' : '测试转写接口'}
              </button>
            </div>
          </div>

          <p className="notice">
            命题说话没有标准文本，讯飞中文评测不支持自由说，因此这一项交给外部大模型按大纲评分。
            支持 <b>OpenAI 兼容</b>（OpenAI / DeepSeek / 智谱 / Moonshot / 硅基流动 / Ollama / vLLM / LM Studio / one-api 等）与
            <b> Anthropic Messages</b>。凭据只保存在本机浏览器里。
          </p>

          <div className="grid-2">
            <Field label="协议类型" hint="Anthropic 不支持音频输入，只能选「先转写再评分」">
              <select
                value={llm.style}
                onChange={(e) => patch('llm', { style: e.target.value as Settings['llm']['style'] })}
              >
                <option value="openai">OpenAI 兼容 /chat/completions</option>
                <option value="anthropic">Anthropic Messages</option>
              </select>
            </Field>
            <Field label="Base URL" required ok={Boolean(llm.baseUrl.trim())} hint="到 /v1 为止，例如 https://api.deepseek.com/v1">
              <input value={llm.baseUrl} onChange={(e) => patch('llm', { baseUrl: e.target.value })} placeholder="https://api.example.com/v1" spellCheck={false} />
            </Field>
            <Field label="API Key" required ok={Boolean(llm.apiKey.trim())}>
              <SecretInput value={llm.apiKey} onChange={(v) => patch('llm', { apiKey: v })} placeholder="sk-..." />
            </Field>
            <Field label="模型名称" required ok={Boolean(llm.model.trim())} hint="必须选支持音频输入的多模态模型（直传模式）">
              <input value={llm.model} onChange={(e) => patch('llm', { model: e.target.value })} placeholder="例如 gpt-4o-audio-preview / qwen-audio" spellCheck={false} />
            </Field>
            <Field label="对话路径" hint="默认 /chat/completions；Anthropic 用 /v1/messages">
              <input value={llm.chatPath} onChange={(e) => patch('llm', { chatPath: e.target.value })} spellCheck={false} />
            </Field>
            <Field label="温度 temperature" hint="评分建议 0~0.3">
              <input
                type="number"
                step="0.1"
                min="0"
                max="2"
                value={llm.temperature}
                onChange={(e) => patch('llm', { temperature: Number(e.target.value) })}
              />
            </Field>
            <Field label="超时（毫秒）" hint="说话录音较长，建议 120000 以上">
              <input
                type="number"
                step="1000"
                min="5000"
                value={llm.timeoutMs}
                onChange={(e) => patch('llm', { timeoutMs: Number(e.target.value) })}
              />
            </Field>
            <Field label="命题说话评分方式" hint="直传需要多模态模型；先转写则文本模型也能评">
              <select
                value={llm.audioMode}
                onChange={(e) => patch('llm', { audioMode: e.target.value as Settings['llm']['audioMode'] })}
              >
                <option value="direct">录音直传（多模态大模型）</option>
                <option value="asr">先转写再评分（文本模型）</option>
              </select>
            </Field>
            {llm.audioMode === 'direct' && (
              <Field
                label="音频字段风格"
                hint="input_audio 为 OpenAI 原生；audio_url（data URL）兼容更多第三方端点。百炼/DashScope 兼容端点（地址含 compatible-mode / dashscope 等）会自动改用 input_audio + data URL 多模态写法"
              >
                <select
                  value={llm.audioStyle}
                  onChange={(e) => patch('llm', { audioStyle: e.target.value as Settings['llm']['audioStyle'] })}
                >
                  <option value="input_audio">input_audio（OpenAI 原生）</option>
                  <option value="audio_url">audio_url（data URL）</option>
                </select>
              </Field>
            )}
            {llm.audioMode === 'asr' && (
              <>
                <Field label="转写来源">
                  <select
                    value={llm.asrSource}
                    onChange={(e) => patch('llm', { asrSource: e.target.value as Settings['llm']['asrSource'] })}
                  >
                    <option value="endpoint">外部 ASR 接口（OpenAI 兼容）</option>
                    <option value="xfyun">讯飞语音听写（复用上面的讯飞凭据）</option>
                  </select>
                </Field>
                {llm.asrSource === 'endpoint' && (
                  <>
                    <Field label="ASR Base URL" hint="留空则复用主 Base URL">
                      <input value={llm.asrBaseUrl} onChange={(e) => patch('llm', { asrBaseUrl: e.target.value })} placeholder="https://api.example.com/v1" spellCheck={false} />
                    </Field>
                    <Field label="ASR API Key" hint="留空则复用主 API Key">
                      <SecretInput value={llm.asrApiKey} onChange={(v) => patch('llm', { asrApiKey: v })} />
                    </Field>
                    <Field label="ASR 模型" hint="如 whisper-1 / paraformer-realtime-v2">
                      <input value={llm.asrModel} onChange={(e) => patch('llm', { asrModel: e.target.value })} spellCheck={false} />
                    </Field>
                  </>
                )}
              </>
            )}
          </div>

          <Field label="额外请求头（JSON）" hint='例如 {"X-Org":"abc"}；会合并到所有请求头里'>
            <textarea
              rows={2}
              value={llm.extraHeaders}
              onChange={(e) => patch('llm', { extraHeaders: e.target.value })}
              placeholder='{"X-Custom-Header":"value"}'
              spellCheck={false}
            />
          </Field>

          <Field
            label="自定义系统提示词"
            hint="留空则使用内置的大纲评分细则（推荐）。填写后会完全替换内置提示词，请自行保留 JSON 输出要求。"
          >
            <textarea
              rows={6}
              value={llm.systemPrompt}
              onChange={(e) => patch('llm', { systemPrompt: e.target.value })}
              placeholder="留空使用内置提示词"
              spellCheck={false}
            />
          </Field>
          <div className="row-actions">
            <button type="button" className="ghost" onClick={() => patch('llm', { systemPrompt: '' })}>
              恢复内置提示词
            </button>
          </div>
        </section>
      )}

      {tab === 'tts' && (
        <section className="panel form-panel">
          <div className="panel-head">
            <h2>本地 TTS · 考试提示音</h2>
            <div className="panel-actions">
              <button
                type="button"
                className="ghost"
                data-testid="btn-preview-tts"
                onClick={() => test('tts', () => preview('现在开始第一项，读单音节字词。请横向依次朗读。', tts))}
              >
                {testing === 'tts' ? '播放中…' : '试听提示音'}
              </button>
            </div>
          </div>

          <p className="notice">
            所有考试提示音都在本机生成：内置引擎用浏览器自带的本地语音（Windows 10/11 自带中文离线语音），
            也可以指向本机跑的 TTS 服务（piper / edge-tts / sherpa-onnx / PaddleSpeech 等）。
          </p>

          <div className="grid-2">
            <Field label="TTS 引擎">
              <select value={tts.engine} onChange={(e) => patch('tts', { engine: e.target.value as Settings['tts']['engine'] })}>
                <option value="builtin">浏览器内置语音（完全离线）</option>
                <option value="http">本机 HTTP TTS 服务</option>
                <option value="off">关闭提示音</option>
              </select>
            </Field>
            {tts.engine === 'builtin' && (
              <>
                <Field label="语音（本机已安装）" hint={voices.length ? `共 ${voices.length} 个可用语音` : '未检测到语音，请确认系统已安装中文语音包'}>
                  <select value={tts.voiceURI} onChange={(e) => patch('tts', { voiceURI: e.target.value })}>
                    <option value="">自动选择中文语音</option>
                    {voices.map((v) => (
                      <option key={v.voiceURI} value={v.voiceURI}>
                        {v.name}（{v.lang}{v.localService ? '，本地' : ''}）
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="语速 rate" hint="1 为正常；0.9 更接近考场提示音">
                  <input type="number" step="0.05" min="0.5" max="2" value={tts.rate} onChange={(e) => patch('tts', { rate: Number(e.target.value) })} />
                </Field>
                <Field label="音高 pitch">
                  <input type="number" step="0.05" min="0" max="2" value={tts.pitch} onChange={(e) => patch('tts', { pitch: Number(e.target.value) })} />
                </Field>
                <Field label="音量 volume">
                  <input type="number" step="0.05" min="0" max="1" value={tts.volume} onChange={(e) => patch('tts', { volume: Number(e.target.value) })} />
                </Field>
              </>
            )}
            {tts.engine === 'http' && (
              <>
                <Field label="服务地址" hint="用 {text} 占位，例如 http://127.0.0.1:8080/tts?text={text}">
                  <input value={tts.url} onChange={(e) => patch('tts', { url: e.target.value })} spellCheck={false} />
                </Field>
                <Field label="请求方法">
                  <select value={tts.method} onChange={(e) => patch('tts', { method: e.target.value as 'GET' | 'POST' })}>
                    <option value="GET">GET（文本放在 URL 里）</option>
                    <option value="POST">POST（文本放在请求体）</option>
                  </select>
                </Field>
                <Field label="请求头（JSON）">
                  <textarea rows={2} value={tts.headers} onChange={(e) => patch('tts', { headers: e.target.value })} placeholder='{"Content-Type":"application/json"}' spellCheck={false} />
                </Field>
                <Field label="请求体模板" hint="仅 POST 使用，{text} 会被替换为提示语">
                  <textarea rows={2} value={tts.body} onChange={(e) => patch('tts', { body: e.target.value })} spellCheck={false} />
                </Field>
              </>
            )}
          </div>
        </section>
      )}

      {tab === 'exam' && (
        <section className="panel form-panel">
          <div className="panel-head">
            <h2>考试参数</h2>
          </div>
          <div className="grid-2">
            <Field label="TTS 提示音">
              <select
                value={exam.prompts ? 'on' : 'off'}
                onChange={(e) => patch('exam', { prompts: e.target.value === 'on' })}
              >
                <option value="on">开启（播报指导语、开始/结束提示、剩余时间提醒）</option>
                <option value="off">关闭（只显示屏幕文字）</option>
              </select>
            </Field>
            <Field label="剩余时间播报点（秒）" hint="逗号分隔，例如 60,30,10">
              <input
                value={exam.warnSeconds.join(',')}
                onChange={(e) =>
                  patch('exam', {
                    warnSeconds: e.target.value
                      .split(',')
                      .map((v) => Number(v.trim()))
                      .filter((v) => Number.isFinite(v) && v > 0),
                  })
                }
              />
            </Field>
            <Field label="开考倒计时（秒）" hint="每题点开始后的准备倒计时">
              <input
                type="number"
                min="0"
                max="10"
                value={exam.countdownSec}
                onChange={(e) => patch('exam', { countdownSec: Number(e.target.value) })}
              />
            </Field>
            <Field label="命题说话准备时间（秒）" hint="选题后的准备倒计时">
              <input
                type="number"
                min="0"
                max="120"
                value={exam.speakPrepSec}
                onChange={(e) => patch('exam', { speakPrepSec: Number(e.target.value) })}
              />
            </Field>
            <Field label="麦克风处理" hint="关闭降噪/AGC 更接近真实评测；环境嘈杂时可开启降噪">
              <select value={exam.rawMic ? 'raw' : 'processed'} onChange={(e) => patch('exam', { rawMic: e.target.value === 'raw' })}>
                <option value="raw">原始音质（关闭降噪/AGC，推荐）</option>
                <option value="processed">浏览器降噪与自动增益</option>
              </select>
            </Field>
            <Field label="字词拼音显示" hint="练习时显示拼音，正式模拟建议关闭">
              <select value={exam.showPinyin ? 'on' : 'off'} onChange={(e) => patch('exam', { showPinyin: e.target.value === 'on' })}>
                <option value="off">不显示</option>
                <option value="on">显示拼音</option>
              </select>
            </Field>
          </div>
        </section>
      )}

      <footer className="sticky-save">
        <span className="muted">
          {dirty ? '有未保存的修改' : '配置已同步'} · 凭据仅保存在本机浏览器 localStorage，不会上传到任何服务器
        </span>
        <button type="button" className="primary" onClick={save}>
          保存配置
        </button>
      </footer>
    </div>
  );
}
