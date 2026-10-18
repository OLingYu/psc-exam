/**
 * 端到端冒烟测试（无头 Edge + 假麦克风）
 *
 * 前置：
 *   1) node tools/mock_server.mjs 8100        （终端 1）
 *   2) npm run build && npm run preview       （终端 2，http://127.0.0.1:4173）
 *   3) node tools/e2e_test.mjs
 *
 * 覆盖：配置注入 → 设备调试 → 四项作答（含讯飞 ISE 评测、命题说话大模型评分）→ 成绩页
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:4173';
const MOCK = 'http://127.0.0.1:8100';

const SETTINGS = {
  ise: {
    appId: 'e2e_appid',
    apiKey: 'e2e_apikey',
    apiSecret: 'e2e_secret',
    host: '127.0.0.1:8100',
    path: '/v2/open-ise',
    iatHost: '127.0.0.1:8100',
    iatPath: '/v2/iat',
    ent: 'cn_vip',
    category: 'auto',
    group: 'adult',
    checkType: 'common',
    extraAbility: 'multi_dimension;syll_phone_err_msg',
    rst: 'entirety',
    iseUnite: '1',
    gain: 0.9,
  },
  llm: {
    baseUrl: `${MOCK}/v1`,
    apiKey: 'e2e',
    model: 'mock-audio-model',
    style: 'openai',
    chatPath: '/chat/completions',
    temperature: 0.2,
    timeoutMs: 60000,
    audioMode: 'direct',
    audioStyle: 'input_audio',
    asrSource: 'endpoint',
    asrBaseUrl: `${MOCK}/v1`,
    asrApiKey: '',
    asrModel: 'whisper-1',
    extraHeaders: '',
    systemPrompt: '',
  },
  tts: { engine: 'off', voiceURI: '', rate: 1, pitch: 1, volume: 1, url: '', method: 'GET', headers: '', body: '' },
  exam: { prompts: false, warnSeconds: [], countdownSec: 1, speakPrepSec: 0, rawMic: true, showPinyin: true },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const ok = (name) => {
  passed += 1;
  console.log(`  ✓ ${name}`);
};

async function main() {
  const health = await fetch(`${MOCK}/health`).catch(() => null);
  if (!health?.ok) throw new Error(`Mock 服务未启动：${MOCK}`);

  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--no-sandbox',
      '--lang=zh-CN',
    ],
  });
  const page = await browser.newPage();
  // 可选：手机视口（如 E2E_VIEWPORT=360x800），用于检查安卓手机尺寸下的考试页布局
  const vp = (process.env.E2E_VIEWPORT || '').split('x').map((n) => Number(n));
  if (vp.length === 2 && vp[0] > 0 && vp[1] > 0) {
    await page.setViewport({ width: vp[0], height: vp[1], deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    console.log(`  [viewport] ${vp[0]}x${vp[1]} (mobile)`);
  }
  // 可选：每步截图目录（如 E2E_SHOTS=../安卓/out/screens）
  const shots = process.env.E2E_SHOTS ? path.resolve(process.env.E2E_SHOTS) : '';
  if (shots) {
    fs.mkdirSync(shots, { recursive: true });
  }
  const shot = async (name) => {
    if (!shots) return;
    await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: false });
  };
  // 手机视口下若有元素超出可视宽度（例如字表固定列数），APK 里就是「右侧被裁」——直接判失败
  const assertNoOverflow = async (name) => {
    const r = await page.evaluate(() => {
      const vw = window.innerWidth;
      const bad = [];
      for (const el of document.querySelectorAll('body *')) {
        const b = el.getBoundingClientRect();
        if (b.width === 0 && b.height === 0) continue;
        if (b.right > vw + 1) {
          bad.push({ tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 40), right: Math.round(b.right) });
        }
      }
      return { vw, scrollWidth: document.documentElement.scrollWidth, bad: bad.slice(0, 5) };
    });
    if (r.scrollWidth > r.vw + 1 || r.bad.length) {
      throw new Error(`${name} 横向溢出：scrollWidth=${r.scrollWidth} 视口=${r.vw} ${JSON.stringify(r.bad)}`);
    }
  };
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  await browser.defaultBrowserContext().overridePermissions(BASE, ['microphone']);

  await page.evaluateOnNewDocument((cfg) => {
    localStorage.setItem('psc.settings.v2', JSON.stringify(cfg));
  }, SETTINGS);

  // 首页
  await page.goto(`${BASE}/#/`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('[data-testid="home-page"]', { timeout: 15000 });
  ok('首页渲染');

  // 接口配置页
  await page.goto(`${BASE}/#/settings`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="settings-page"]', { timeout: 10000 });
  await page.click('[data-testid="tab-llm"]');
  await page.waitForSelector('[data-testid="btn-test-llm"]', { timeout: 5000 });
  await page.click('[data-testid="btn-test-llm"]');
  await page.waitForSelector('[data-testid="toast"].ok', { timeout: 20000 });
  ok('模型接口连通性测试');

  await page.click('[data-testid="tab-ise"]');
  await page.click('[data-testid="btn-test-ise"]');
  await page.waitForSelector('[data-testid="toast"].ok', { timeout: 30000 });
  ok('讯飞 ISE 连通性测试');

  // 考试
  await page.goto(`${BASE}/#/exam`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="btn-device"]', { timeout: 10000 });
  await page.click('[data-testid="btn-device"]');
  await page.waitForSelector('[data-testid="btn-device-ok"]', { timeout: 20000 });
  ok('麦克风设备调试');
  await shot('exam-device');
  await page.click('[data-testid="btn-device-ok"]');

  const keys = ['mono', 'poly', 'read', 'speak'];
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (i === 3) {
      await page.waitForSelector('[data-testid="topic-0"]', { timeout: 15000 });
      await page.click('[data-testid="topic-0"]');
      ok('命题说话选题');
    } else {
      await page.waitForSelector('[data-testid="btn-start-answer"]', { timeout: 15000 });
      await page.click('[data-testid="btn-start-answer"]');
    }
    await page.waitForSelector('[data-testid="btn-finish-section"]', { timeout: 20000 });
    await sleep(2600); // 录音 2.6 秒（假麦克风）
    await shot(`exam-${key}-answering`);
    await assertNoOverflow(`exam-${key}-answering`);
    await page.click('[data-testid="btn-finish-section"]');
    await page.waitForSelector('[data-testid="btn-next-section"]', { timeout: 20000 });
    ok(`${key} 录音完成`);
    await page.click('[data-testid="btn-next-section"]');
  }

  // 评分 → 成绩页
  await page.waitForSelector('[data-testid="result-total"]', { timeout: 120000 });
  const total = await page.$eval('[data-testid="result-total"]', (el) => el.textContent?.trim());
  const level = await page.$eval('[data-testid="result-level"]', (el) => el.textContent?.trim());
  const cards = await page.$$eval('[data-testid="result-sections"] .section-result', (els) => els.length);
  const body = await page.evaluate(() => document.body.innerText);
  if (cards !== 4) throw new Error(`成绩页分项数应为 4，实际 ${cards}`);
  ok(`成绩页：总分 ${total}，等级 ${level}，4 个分项`);
  if (!body.includes('讯飞 ISE')) throw new Error('成绩页缺少讯飞 ISE 标识');
  if (!body.includes('大模型')) throw new Error('成绩页缺少大模型评分标识（命题说话）');
  if (!body.includes('命题说话')) throw new Error('成绩页缺少命题说话');
  ok('评分来源标识正确（前三项 ISE / 说话大模型）');

  const history = await page.evaluate(() => JSON.parse(localStorage.getItem('psc.history.v2') || '[]'));
  if (!history.length) throw new Error('历史记录没有写入');
  ok('历史记录写入');

  await shot('exam-result');
  await assertNoOverflow('exam-result');
  await page.screenshot({ path: 'tools/e2e-result.png', fullPage: true });
  console.log(`\nE2E 通过：${passed} 项断言，截图 tools/e2e-result.png`);
  await browser.close();
}

main().catch((err) => {
  console.error('\nE2E 失败：', err.message);
  process.exit(1);
});
