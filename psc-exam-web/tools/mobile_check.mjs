/**
 * 手机视口渲染检查（无头 Edge，不依赖任何接口/后端）
 *
 * 目的：在没有安卓真机/模拟器的情况下，验证打包进 APK 的前端在手机尺寸下
 *       能正常启动、无脚本报错、无明显横向溢出，并输出各页面截图供人工确认。
 *
 * 用法：node tools/mobile_check.mjs [输出目录]
 *   - 默认输出：<本仓库上级>/安卓/out/screens
 *   - 也可用 E2E_EDGE 指定浏览器路径
 *
 * 说明：渲染引擎与 Android WebView 同为 Chromium，布局/JS 兼容性结论可信；
 *       但麦克风、系统 TTS、文件落盘等原生能力仍需真机验证。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, '..', 'dist');
const OUT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(HERE, '..', '..', '安卓', 'out', 'screens');
const EDGE = process.env.E2E_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 4180;

const PAGES = [
  { hash: '#/', name: 'home', sel: '.app-main' },
  { hash: '#/bank', name: 'bank', sel: '.app-main' },
  { hash: '#/settings', name: 'settings', sel: '.app-main' },
  { hash: '#/history', name: 'history', sel: '.app-main' },
];

const VIEWPORTS = [
  { label: '360x800', width: 360, height: 800, dpr: 2 },
  { label: '412x915', width: 412, height: 915, dpr: 2.625 },
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function startServer() {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0].split('#')[0]);
    // 浏览器/WebView 会自动请求 favicon，静态服务给 204，避免 404 噪声掩盖真实脚本错误
    if (urlPath === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }
    let rel = urlPath === '/' ? '/index.html' : urlPath;
    const file = path.join(DIST, rel);
    if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

/** 找出超出视口右边界的元素（横向溢出的直接原因） */
const OVERFLOW_PROBE = () => {
  const vw = window.innerWidth;
  const bad = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (r.right > vw + 1 || r.left < -1) {
      bad.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.className && String(el.className).slice(0, 60)) || '',
        left: Math.round(r.left),
        right: Math.round(r.right),
        width: Math.round(r.width),
      });
    }
  }
  return {
    viewport: vw,
    scrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    horizontalOverflow: document.documentElement.scrollWidth > vw + 1,
    offenders: bad.slice(0, 12),
  };
};

/** 检查关键控件是否可点（宽高 >= 24px，安卓触控最小可点尺寸的下限） */
const TAPPABLE_PROBE = () => {
  const small = [];
  for (const el of document.querySelectorAll('button, a.nav a, .nav a, [role="button"]')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (r.height < 24 || r.width < 24) {
      small.push({ text: (el.textContent || '').trim().slice(0, 20), w: Math.round(r.width), h: Math.round(r.height) });
    }
  }
  return small.slice(0, 12);
};

/** 关键容器的几何信息：确认内容没有被裁切（body overflow-x 可能掩盖溢出） */
const LAYOUT_PROBE = () => {
  const pick = ['.topbar', '.app-main', '.hero', '.hero-text', '.hero-card', '.panel', '.page-head'];
  const rect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) };
  };
  const out = {
    innerWidth: window.innerWidth,
    clientWidth: document.documentElement.clientWidth,
    bodyOverflowX: getComputedStyle(document.body).overflowX,
    htmlOverflowX: getComputedStyle(document.documentElement).overflowX,
    boxes: {},
  };
  for (const sel of pick) {
    const el = document.querySelector(sel);
    const r = rect(el);
    if (r) r.clippedRight = r.right > out.innerWidth + 1;
    out.boxes[sel] = r;
  }
  return out;
};

async function main() {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    throw new Error(`前端产物不存在：${DIST}（先运行 npm run build）`);
  }
  if (!fs.existsSync(EDGE)) throw new Error(`找不到浏览器：${EDGE}`);
  fs.mkdirSync(OUT, { recursive: true });

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
      '--hide-scrollbars',
    ],
  });

  const report = { generatedAt: new Date().toISOString(), base, viewports: [], errors: [] };

  try {
    await browser.defaultBrowserContext().overridePermissions(base, ['microphone']);

    for (const vp of VIEWPORTS) {
      const page = await browser.newPage();
      const pageErrors = [];
      page.on('pageerror', (e) => pageErrors.push(String(e.message || e)));
      page.on('console', (m) => {
        // favicon.ico 由 WebView/浏览器自动请求，静态服务没有该文件，404 属正常噪声
        if (m.type() === 'error' && !/favicon\.ico/.test(m.text())) pageErrors.push(`console: ${m.text()}`);
      });
      page.on('requestfailed', (r) => {
        if (!/favicon\.ico/.test(r.url())) pageErrors.push(`requestfailed: ${r.url()}`);
      });
      await page.setViewport({
        width: vp.width,
        height: vp.height,
        deviceScaleFactor: vp.dpr,
        isMobile: true,
        hasTouch: true,
      });

      for (const p of PAGES) {
        await page.goto(`${base}/${p.hash}`, { waitUntil: 'networkidle2', timeout: 30000 });
        await page.waitForSelector(p.sel, { timeout: 15000 });
        await new Promise((r) => setTimeout(r, 400));
        const overflow = await page.evaluate(OVERFLOW_PROBE);
        const layout = await page.evaluate(LAYOUT_PROBE);
        const small = p.name === 'home' ? await page.evaluate(TAPPABLE_PROBE) : [];
        const shot = path.join(OUT, `${vp.label}-${p.name}.png`);
        await page.screenshot({ path: shot, fullPage: false });
        report.viewports.push({ viewport: vp.label, page: p.name, screenshot: shot, overflow, layout, smallControls: small });
        console.log(
          `[${vp.label}] ${p.name}: overflow=${overflow.horizontalOverflow} scrollWidth=${overflow.scrollWidth}/${overflow.viewport} errors=${pageErrors.length}`
        );
      }

      // 首页完整长图，便于人工确认排版
      await page.goto(`${base}/#/`, { waitUntil: 'networkidle2' });
      await new Promise((r) => setTimeout(r, 300));
      const full = path.join(OUT, `${vp.label}-home-full.png`);
      await page.screenshot({ path: full, fullPage: true });
      report.viewports.push({ viewport: vp.label, page: 'home-full', screenshot: full });

      report.errors.push({ viewport: vp.label, messages: pageErrors });
      await page.close();
    }
  } finally {
    await browser.close();
    server.close();
  }

  const reportPath = path.join(OUT, 'mobile-check.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

  const overflowCount = report.viewports.filter((v) => v.overflow?.horizontalOverflow).length;
  const errorCount = report.errors.reduce((n, e) => n + e.messages.length, 0);
  console.log(`\n截图目录：${OUT}`);
  console.log(`报告：${reportPath}`);
  console.log(`横向溢出页面数=${overflowCount}  脚本报错数=${errorCount}`);
  process.exitCode = overflowCount === 0 && errorCount === 0 ? 0 : 2;
}

main().catch((e) => {
  console.error('检查失败：', e);
  process.exitCode = 1;
});
