/**
 * 安卓真机调试驱动（临时排查脚本）
 *
 * 通过 adb forward 的 WebView devtools 端口连 CDP，在真机 WebView 里：
 *   1) 收集 console / JS 异常 / Log 条目
 *   2) 按考试真实路径点一遍（首页检测麦克风 → 设备调试 → 四项 → 成绩页 → 其他页面）
 *   3) 每步截图 + 打印关键 DOM 文本
 *
 * 用法：
 *   adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
 *   node tools/_android_debug.mjs [输出目录]
 */
import fs from 'node:fs';
import path from 'node:path';

const ENDPOINT = process.env.CDP_ENDPOINT || 'http://127.0.0.1:9222';
const OUT = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve('C:/Users/38329/AppData/Local/Temp/android-debug');
fs.mkdirSync(OUT, { recursive: true });

const errors = [];
const logs = [];
const requests = [];
const netErrors = [];
let ws;
let seq = 0;
const pending = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function send(method, params = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`${method} 超时`));
      }
    }, timeoutMs);
  });
}

async function evaluate(expression) {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (res.result?.exceptionDetails) {
    throw new Error(`执行异常：${res.result.exceptionDetails.text} ${JSON.stringify(res.result.exceptionDetails.exception?.description || '')}`);
  }
  return res.result?.result?.value;
}

async function waitFor(selector, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = await evaluate(`!!document.querySelector(${JSON.stringify(selector)})`);
    if (found) return true;
    await sleep(250);
  }
  throw new Error(`等待元素超时：${selector}`);
}

async function clickTestId(testId) {
  await evaluate(`(() => { const el = document.querySelector('[data-testid="${testId}"]'); if (!el) throw new Error('找不到 ${testId}'); el.click(); return true; })()`);
}

async function clickByText(text) {
  await evaluate(`(() => {
    const el = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes(${JSON.stringify(text)}));
    if (!el) throw new Error('找不到按钮：${text}');
    el.click();
    return true;
  })()`);
}

async function text(selector) {
  return evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.innerText.trim() : null; })()`);
}

async function shot(name) {
  try {
    const res = await send('Page.captureScreenshot', { format: 'png' }, 8000);
    const file = path.join(OUT, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(res.result.data, 'base64'));
    return file;
  } catch (e) {
    return `(截图失败: ${e.message})`;
  }
}

/** 当前页面状态摘要：路由 hash + 关键 testid 是否存在，便于定位步骤为何找不到元素 */
async function state() {
  return evaluate(`(() => {
    const ids = ['home-page','exam-page','btn-start-exam','btn-device','btn-device-ok','btn-start-answer','btn-finish-section','btn-next-section','topic-0','result-total'];
    const present = ids.filter((id) => document.querySelector('[data-testid="' + id + '"]'));
    return 'hash=' + location.hash + ' resumed=' + (document.visibilityState) + ' testids=[' + present.join(',') + '] body=' + document.body.innerText.replace(/\\s+/g, ' ').slice(0, 60);
  })()`);
}

async function step(name, fn) {
  process.stdout.write(`- ${name} … `);
  try {
    const detail = await fn();
    console.log(`OK${detail ? ` ${detail}` : ''}`);
    return detail;
  } catch (e) {
    console.log(`失败：${e.message}`);
    errors.push(`[步骤失败] ${name}: ${e.message}`);
    try {
      console.log(`    状态：${await state()}`);
    } catch (e2) {
      console.log(`    状态读取失败：${e2.message}`);
    }
    return null;
  }
}

async function main() {
  const pages = await (await fetch(`${ENDPOINT}/json`)).json();
  const page = pages.find((p) => p.type === 'page' && /appassets\.androidplatform\.net/.test(p.url || ''));
  if (!page) throw new Error(`没有找到应用页面：${JSON.stringify(pages.map((p) => p.url))}`);
  console.log(`页面：${page.url}`);
  console.log(`标题：${page.title}`);

  ws = new WebSocket(page.webSocketDebuggerUrl);
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
      return;
    }
    // 收集控制台 + 异常 + 日志
    if (msg.method === 'Runtime.consoleAPICalled') {
      const t = msg.params.type;
      const txt = (msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
      logs.push(`console.${t}: ${txt}`);
      if (t === 'error') errors.push(`console.error: ${txt}`);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      errors.push(`JS 异常: ${d.text} ${d.exception?.description || ''}`.trim());
    } else if (msg.method === 'Network.requestWillBeSent') {
      const r = msg.params.request;
      if (!/appassets\.androidplatform\.net/.test(r.url)) requests.push(`${r.method} ${r.url.slice(0, 160)}`);
    } else if (msg.method === 'Network.responseReceived') {
      const r = msg.params.response;
      if (r.status >= 400 && !/favicon\.ico/.test(r.url)) netErrors.push(`HTTP ${r.status} ${r.url.slice(0, 200)}`);
    } else if (msg.method === 'Network.loadingFailed') {
      netErrors.push(`请求失败 ${msg.params.errorText} (requestId=${msg.params.requestId})`);
    } else if (msg.method === 'Log.entryAdded') {
      const e = msg.params.entry;
      logs.push(`log.${e.level} ${e.source}: ${e.text}`);
      // WebView 会自动请求 favicon.ico，本地资源没有该文件 → 404，属于噪声
      if (e.level === 'error' && !(e.source === 'network' && /404/.test(e.text))) {
        errors.push(`log.error(${e.source}): ${e.text}`);
      }
    }
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Network.enable');

  console.log('\n== 环境 ==');
  console.log(
    JSON.stringify(
      await evaluate(`({
        href: location.href,
        ua: navigator.userAgent,
        secure: window.isSecureContext,
        mediaDevices: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
        bridge: typeof window.PscAndroid,
        ttsShim: !!window.__pscTtsShimInstalled,
        voices: (() => { try { return window.speechSynthesis.getVoices().map((v) => v.name + '|' + v.lang); } catch (e) { return String(e); } })(),
        settings: (() => { try { const s = JSON.parse(localStorage.getItem('psc.settings.v2') || '{}'); return { ise: !!(s.ise && s.ise.appId), llm: !!(s.llm && s.llm.apiKey), tts: s.tts && s.tts.engine, prompts: s.exam && s.exam.prompts }; } catch (e) { return String(e); } })(),
      })`),
      null,
      2,
    ),
  );

  console.log('\n== 流程 ==');
  await step('回到首页', async () => {
    await evaluate(`location.hash = '#/'`);
    await sleep(800);
    await waitFor('[data-testid="home-page"]');
    return await state();
  });

  await step('首页渲染', async () => {
    await waitFor('[data-testid="home-page"]');
    await shot('01-home');
    return await state();
  });

  await step('检测麦克风', async () => {
    await clickByText('检测麦克风');
    await sleep(3000);
    const mic = await evaluate(`(() => {
      const rows = [...document.querySelectorAll('.status-row')];
      const row = rows.find((r) => (r.textContent || '').includes('麦克风'));
      return row ? row.innerText.replace(/\\n/g, ' ') : null;
    })()`);
    await shot('02-mic');
    return mic;
  });

  await step('进入考试（考前须知）', async () => {
    await clickTestId('btn-start-exam');
    await waitFor('[data-testid="btn-device"]');
    await shot('03-intro');
    return await text('[data-testid="exam-phase"]');
  });

  await step('设备调试', async () => {
    await clickTestId('btn-device');
    await waitFor('[data-testid="btn-device-ok"]', 25000);
    await sleep(1500);
    const info = await evaluate(`(() => {
      const panel = document.querySelector('.device-panel');
      const err = document.querySelector('[data-testid="exam-error"]');
      return (panel ? panel.innerText.split('\\n').slice(1, 2).join(' ') : '') + (err ? ' | 错误:' + err.innerText : '');
    })()`);
    await shot('04-device');
    return info;
  });

  await step('确认麦克风，进入第一项', async () => {
    await clickTestId('btn-device-ok');
    await waitFor('[data-testid="btn-start-answer"]', 20000);
    await shot('05-brief-1');
    return await text('[data-testid="exam-phase"]');
  });

  const sections = ['mono', 'poly', 'read'];
  for (const [i, key] of sections.entries()) {
    await step(`${key} 答题`, async () => {
      await clickTestId('btn-start-answer');
      await waitFor('[data-testid="btn-finish-section"]', 20000);
      await sleep(2500);
      await shot(`06-${key}-recording`);
      await clickTestId('btn-finish-section');
      await waitFor('[data-testid="btn-next-section"]', 20000);
      const saved = await text('.saved-info');
      await shot(`07-${key}-saved`);
      await clickTestId('btn-next-section');
      await sleep(600);
      // 下一项说明页（命题说话则是选题页）
      if (key !== 'read') await waitFor('[data-testid="btn-start-answer"]', 20000);
      return saved;
    });
    void i;
  }

  await step('命题说话：选题', async () => {
    await waitFor('[data-testid="topic-0"]', 20000);
    await shot('08-speak-pick');
    await clickTestId('topic-0');
    await sleep(800);
    await shot('09-speak-prep');
    await clickByText('准备好了，立即开始');
    await waitFor('[data-testid="btn-finish-section"]', 20000);
    await sleep(3000);
    await shot('10-speak-recording');
    await clickTestId('btn-finish-section');
    await waitFor('[data-testid="btn-next-section"]', 20000);
    const saved = await text('.saved-info');
    await clickTestId('btn-next-section');
    return saved;
  });

  await step('评分 → 成绩页', async () => {
    await waitFor('[data-testid="result-total"]', 90000);
    const total = await text('[data-testid="result-total"]');
    const level = await text('[data-testid="result-level"]');
    const cards = await evaluate(`document.querySelectorAll('[data-testid="result-sections"] .section-result').length`);
    const detail = await evaluate(`[...document.querySelectorAll('[data-testid="result-sections"] .section-result')].map((el) => (el.innerText || '').replace(/\\s+/g, ' ').slice(0, 110))`);
    await shot('11-result');
    detail.forEach((d, i) => console.log(`\n    [分项${i + 1}] ${d}`));
    return `总分=${total} 等级=${level} 分项=${cards}`;
  });

  for (const [hash, name] of [['#/bank', '12-bank'], ['#/history', '13-history'], ['#/settings', '14-settings']]) {
    await step(`页面 ${hash}`, async () => {
      await evaluate(`location.hash = ${JSON.stringify(hash)}`);
      await sleep(1200);
      await shot(name);
      return `title=${await evaluate('document.title')}`;
    });
  }

  console.log('\n== 网络请求（非本地资源）==');
  if (!requests.length) console.log('（无）');
  else requests.slice(-25).forEach((r) => console.log(`  ${r}`));

  console.log('\n== 网络错误（>=400 / 失败）==');
  if (!netErrors.length) console.log('（无）');
  else netErrors.slice(0, 20).forEach((e) => console.log(`  ✗ ${e}`));

  console.log('\n== 控制台错误 / JS 异常 ==');
  if (!errors.length) console.log('（无）');
  else errors.slice(0, 40).forEach((e) => console.log(`  ✗ ${e}`));

  console.log('\n== 最近控制台输出 ==');
  logs.slice(-25).forEach((l) => console.log(`  ${l}`));

  console.log(`\n截图目录：${OUT}`);
  ws.close();
  process.exitCode = errors.filter((e) => !e.startsWith('[步骤失败]')).length ? 1 : 0;
}

main().catch((e) => {
  console.error('调试脚本失败：', e);
  process.exit(1);
});
