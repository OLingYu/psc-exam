/**
 * Web 端「点继续就打断 TTS」回归测试（无头 Edge，不依赖真实语音合成）
 *
 * 做法：在页面加载前把 window.speechSynthesis 换成不会自行结束的假实现，
 * 记录 speak/cancel 调用；然后走考试流程，验证点击推进类按钮时确实调用了 cancel()。
 *
 * 用法：node tools/tts_interrupt_test.mjs
 * 前置：npm run build（读 dist/）
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, '..', 'dist');
const EDGE = process.env.E2E_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 4181;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function startServer() {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0].split('#')[0]);
    if (urlPath === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }
    const file = path.join(DIST, urlPath === '/' ? '/index.html' : urlPath);
    if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

/** 假的 speechSynthesis：speak 后永不结束，模拟「一条很长的指导语还在播」 */
const FAKE_TTS = () => {
  const log = { speaks: [], cancels: 0, events: [] };
  window.__ttsLog = log;
  const synth = {
    speaking: false,
    pending: false,
    paused: false,
    getVoices: () => [{ name: 'Fake 中文语音', lang: 'zh-CN', voiceURI: 'fake-zh', localService: true, default: true }],
    speak: (u) => {
      log.speaks.push(String(u && u.text));
      log.events.push({ at: Date.now(), type: 'speak', text: String(u && u.text).slice(0, 20) });
      synth.speaking = true;
      // 故意不触发 onend，模拟长时间播报
    },
    cancel: () => {
      log.cancels += 1;
      synth.speaking = false;
      log.events.push({ at: Date.now(), type: 'cancel' });
    },
    pause() {},
    resume() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return true;
    },
  };
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true, writable: true });
  window.SpeechSynthesisUtterance = function (text) {
    this.text = text;
    this.lang = '';
    this.voice = null;
    this.rate = 1;
    this.pitch = 1;
    this.volume = 1;
    this.onend = null;
    this.onerror = null;
    this.onboundary = null;
  };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) throw new Error(`前端产物不存在：${DIST}（先 npm run build）`);
  if (!fs.existsSync(EDGE)) throw new Error(`找不到浏览器：${EDGE}`);

  const server = await startServer();
  const base = `http://127.0.0.1:${PORT}`;
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

  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok, detail });
    console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `  (${detail})` : ''}`);
  };

  try {
    await browser.defaultBrowserContext().overridePermissions(base, ['microphone']);
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
    await page.evaluateOnNewDocument(FAKE_TTS);

    await page.goto(`${base}/#/exam`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('[data-testid="btn-device"]', { timeout: 15000 });

    // 考前须知：进入页面时会播报长说明
    const introSpeaks = await page.evaluate(() => window.__ttsLog.speaks.length);
    check('进入考试页开始播报考前须知', introSpeaks > 0, `speak=${introSpeaks}`);

    // 点「跳过调试」→ 应掐断考前须知，同时开始播报第一项指导语
    await page.click('[data-testid="btn-device"] ~ button, .intro-actions button.ghost');
    await sleep(600);
    const afterSkip = await page.evaluate(() => ({
      cancels: window.__ttsLog.cancels,
      speakCount: window.__ttsLog.speaks.length,
      lastSpeak: window.__ttsLog.speaks[window.__ttsLog.speaks.length - 1] || '',
    }));
    check('「跳过调试」掐断考前须知', afterSkip.cancels >= 1, `cancel=${afterSkip.cancels}`);
    check(
      '进入第一项后播报指导语',
      afterSkip.speakCount > introSpeaks,
      `speak ${introSpeaks} → ${afterSkip.speakCount}：${String(afterSkip.lastSpeak).slice(0, 24)}…`,
    );

    // 点「开始答题」→ 应掐断指导语（关键用例）
    const cancelsBeforeStart = afterSkip.cancels;
    await page.click('[data-testid="btn-start-answer"]');
    await sleep(400);
    const afterStart = await page.evaluate(() => ({ cancels: window.__ttsLog.cancels, speaks: window.__ttsLog.speaks.length }));
    check('「开始答题」掐断指导语', afterStart.cancels > cancelsBeforeStart, `cancel ${cancelsBeforeStart} → ${afterStart.cancels}`);

    // 等录音开始（倒计时结束，默认 3 秒）
    await page.waitForSelector('[data-testid="btn-finish-section"]', { timeout: 15000 });
    const cancelsBeforeFinish = await page.evaluate(() => window.__ttsLog.cancels);
    await page.click('[data-testid="btn-finish-section"]');
    await sleep(400);
    const afterFinish = await page.evaluate(() => ({ cancels: window.__ttsLog.cancels, speaks: window.__ttsLog.speaks }));
    check('「我读完了」掐断仍在播的提示', afterFinish.cancels > cancelsBeforeFinish, `cancel=${afterFinish.cancels}`);

    // 等待保存完成 → 「重录本项」也应掐断（本项结束语）
    await page.waitForSelector('[data-testid="btn-retake"]', { timeout: 15000 });
    const cancelsBeforeRetake = await page.evaluate(() => window.__ttsLog.cancels);
    await page.click('[data-testid="btn-retake"]');
    await sleep(400);
    const afterRetake = await page.evaluate(() => window.__ttsLog.cancels);
    check('「重录本项」掐断本项结束语', afterRetake > cancelsBeforeRetake, `cancel ${cancelsBeforeRetake} → ${afterRetake}`);

    // 事件顺序：cancel 之前必须有 speak（确保不是空转）
    const events = await page.evaluate(() => window.__ttsLog.events);
    const firstCancel = events.findIndex((e) => e.type === 'cancel');
    const firstSpeak = events.findIndex((e) => e.type === 'speak');
    check('cancel 发生在 speak 之后（确有声音被中断）', firstSpeak >= 0 && firstCancel > firstSpeak, `speak@${firstSpeak} cancel@${firstCancel}`);

    // 首页「试听提示音」：再点一次应掐断上一次，而不是排队等前一句念完
    await page.goto(`${base}/#/`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('[data-testid="home-page"]', { timeout: 15000 });
    const clickPreview = () =>
      page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('试听提示音'));
        if (!btn) throw new Error('找不到「试听提示音」按钮');
        btn.click();
      });
    const count = () => page.evaluate(() => ({ speaks: window.__ttsLog.speaks.length, cancels: window.__ttsLog.cancels }));
    const beforePreview = await count();
    await clickPreview();
    await sleep(400);
    const midPreview = await count();
    await clickPreview();
    await sleep(400);
    const afterPreview = await count();
    check('首页「试听提示音」能出声', midPreview.speaks > beforePreview.speaks, `speak ${beforePreview.speaks} → ${midPreview.speaks}`);
    check(
      '再点「试听提示音」掐断上一次',
      afterPreview.cancels > midPreview.cancels && afterPreview.speaks > midPreview.speaks,
      `cancel ${midPreview.cancels} → ${afterPreview.cancels}`,
    );

    await page.close();
  } finally {
    await browser.close();
    server.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => {
  console.error('测试失败：', e);
  process.exitCode = 1;
});
