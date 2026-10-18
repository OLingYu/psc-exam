#!/usr/bin/env node
/**
 * 普通话水平测试（PSC）考试前端 —— 本地 Mock 服务
 *
 * 零第三方依赖，只用 Node 内置模块：http / crypto / stream / buffer / fs。
 * 启动：node tools/mock_server.mjs 8100
 *
 * 提供：
 *   GET  /health                      健康检查
 *   POST /v1/chat/completions         OpenAI 兼容打分（支持文本 + input_audio/audio_url）
 *   POST /v1/audio/transcriptions     OpenAI 兼容 ASR（吃掉 multipart，返回固定文本）
 *   GET  /v1/models                   模型列表
 *   POST /tts                         返回真实可播放的 16kHz/16bit/单声道 WAV
 *   WS   /v2/open-ise                 讯飞 ISE 语音评测模拟（手写 WebSocket 服务端）
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_BODY_BYTES = 200 * 1024 * 1024; // 单请求体上限 200MB（足够长录音）

let PORT = Number.parseInt(process.argv[2] ?? '', 10);
if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) PORT = 8100;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': '*',
};

/** 读取完整请求体（分块累积，直到 end）；超限直接报错。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
    req.on('aborted', () => reject(new Error('请求被中断')));
  });
}

/** 发送 JSON 响应。 */
function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, {
    ...CORS_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/** 统一错误响应（500）+ 进程不退出。 */
function sendError(res, status, message, type = 'mock_server_error') {
  if (res.headersSent) {
    try { res.end(); } catch { /* ignore */ }
    return;
  }
  sendJson(res, status, { error: { message: String(message), type, code: status } });
}

/** 安全 JSON.parse，失败返回 undefined。 */
function tryParseJson(buf) {
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return undefined;
  }
}

/** 保留 n 位小数（返回 number）。 */
function round(n, digits) {
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

/** XML 属性/文本转义。 */
function escapeXml(v) {
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ---------------------------------------------------------------------------
// 1) GET /health
// ---------------------------------------------------------------------------

function handleHealth(res) {
  sendJson(res, 200, { ok: true });
}

// ---------------------------------------------------------------------------
// 2) POST /v1/chat/completions —— OpenAI 兼容打分
// ---------------------------------------------------------------------------

/** 从一条 message 的 content 中提取文本与音频标记。 */
function inspectContent(content, acc) {
  if (typeof content === 'string') {
    acc.texts.push(content);
    return;
  }
  if (!content || typeof content !== 'object') return;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const type = String(part.type ?? '');
      if (type === 'text' || type === 'input_text') {
        if (typeof part.text === 'string') acc.texts.push(part.text);
      } else if (type === 'input_audio' || type === 'audio' || type === 'audio_url') {
        // 任何音频元素都算“音频直传”
        acc.hasAudio = true;
        const maybeText = part.input_audio?.text ?? part.audio?.text ?? part.text;
        if (typeof maybeText === 'string' && maybeText.trim()) acc.texts.push(maybeText);
      } else if (typeof part.text === 'string') {
        acc.texts.push(part.text); // 兜底：未知类型但带 text
      }
    }
    return;
  }
  if (typeof content.text === 'string') acc.texts.push(content.text);
  if (content.input_audio || content.audio_url) acc.hasAudio = true;
}

/** 从文本中抓“该项满分: 20 / 满分 10”之类的分值；默认 10。 */
function extractMaxScore(text) {
  if (!text) return 10;
  const m1 = text.match(/该项满分[:：]\s*(\d+(?:\.\d+)?)/);
  if (m1) return Number.parseFloat(m1[1]);
  const m2 = text.match(/满分\s*(\d+)/);
  if (m2) return Number.parseFloat(m2[1]);
  return 10;
}

async function handleChatCompletions(req, res) {
  const raw = await readBody(req);
  const body = tryParseJson(raw);
  if (!body || typeof body !== 'object') {
    sendError(res, 400, '请求体不是合法 JSON', 'invalid_request_error');
    return;
  }

  const acc = { texts: [], hasAudio: false };
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    inspectContent(msg.content, acc);
  }
  // 有些前端把音频放在顶层字段里
  if (!acc.hasAudio && (body.audio || body.input_audio || body.audio_url)) acc.hasAudio = true;

  const longestText = acc.texts.reduce((a, b) => (b.length > a.length ? b : a), '') || '';
  const maxScore = extractMaxScore(longestText);

  const result = {
    score: round(maxScore * 0.88, 1),
    items: [
      {
        item: '语音错误',
        count: 3,
        deduction: round(maxScore * 0.03, 2),
        reason: '个别声调不到位',
      },
      {
        item: '语音缺陷',
        count: 2,
        deduction: round(maxScore * 0.02, 2),
        reason: '前后鼻音偏弱',
      },
    ],
    comment: `${acc.hasAudio ? '【音频直传】' : '【文本评分】'}（模拟）整体语音面貌较好，注意声调与儿化。`,
    issues: [{ at: '第 12 字', type: '错误', note: '声调偏低' }],
  };

  sendJson(res, 200, {
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: body.model ?? 'mock-text-model',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: JSON.stringify(result) },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 80, total_tokens: 180 },
  });
}

// ---------------------------------------------------------------------------
// 3) POST /v1/audio/transcriptions —— OpenAI 兼容 ASR
// ---------------------------------------------------------------------------

async function handleTranscriptions(req, res) {
  // multipart/form-data 不解析，读完后直接丢弃
  await readBody(req);
  sendJson(res, 200, { text: '这是模拟的语音识别结果：今天天气很好，我们一起学习普通话。' });
}

// ---------------------------------------------------------------------------
// 4) GET /v1/models
// ---------------------------------------------------------------------------

function handleModels(res) {
  sendJson(res, 200, {
    object: 'list',
    data: [
      { id: 'mock-audio-model', object: 'model' },
      { id: 'mock-text-model', object: 'model' },
    ],
  });
}

// ---------------------------------------------------------------------------
// 5) POST /tts —— 生成真实可播放 WAV（16kHz / 16bit / 单声道 / 440Hz 正弦波）
// ---------------------------------------------------------------------------

/** 根据文本长度生成 0.3~2.5 秒 WAV。 */
function buildWavBuffer(text) {
  const sampleRate = 16000;
  const chars = Array.from(text ?? '');
  const seconds = Math.min(2.5, Math.max(0.3, 0.3 + chars.length * 0.07));
  const totalSamples = Math.round(seconds * sampleRate);
  const amplitude = 0.2 * 0x7fff; // 0.2 振幅
  const freq = 440;
  const fade = Math.min(Math.floor(sampleRate * 0.02), Math.floor(totalSamples / 2)); // 20ms 淡入淡出

  const dataSize = totalSamples * 2; // 16bit mono
  const wav = Buffer.alloc(44 + dataSize);
  // ---- 44 字节 WAV 头 ----
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + dataSize, 4); // RIFF chunk size
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16); // fmt chunk size
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // 单声道
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28); // byteRate = sampleRate * blockAlign
  wav.writeUInt16LE(2, 32); // blockAlign
  wav.writeUInt16LE(16, 34); // bits per sample
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(dataSize, 40);

  let phase = 0;
  const step = (2 * Math.PI * freq) / sampleRate;
  for (let i = 0; i < totalSamples; i++) {
    let env = 1;
    if (i < fade) env = i / fade;
    else if (i >= totalSamples - fade) env = (totalSamples - i) / fade;
    const sample = Math.sin(phase) * amplitude * env;
    wav.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample))), 44 + i * 2);
    phase += step;
    if (phase > Math.PI * 2) phase -= Math.PI * 2;
  }
  return wav;
}

async function handleTts(req, res, url) {
  let text = url.searchParams.get('text') ?? '';
  if (req.method === 'POST' || req.method === 'PUT') {
    const raw = await readBody(req);
    if (raw.length > 0) {
      const body = tryParseJson(raw);
      if (body && typeof body === 'object' && typeof body.text === 'string' && body.text) {
        text = body.text;
      }
    }
  }
  const wav = buildWavBuffer(text);
  res.writeHead(200, {
    ...CORS_HEADERS,
    'Content-Type': 'audio/wav',
    'Content-Length': wav.length,
    'Cache-Control': 'no-store',
  });
  res.end(wav);
}

// ---------------------------------------------------------------------------
// WebSocket 基础：握手 / 组帧 / 解帧
// ---------------------------------------------------------------------------

/** 计算 Sec-WebSocket-Accept。 */
function wsAccept(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

/** 发送一帧服务端 WebSocket 帧（不掩码）。 */
function wsSend(socket, opcode, payload) {
  if (!socket || socket.destroyed || socket.writableEnded) return;
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode; // FIN + opcode
  try {
    socket.write(Buffer.concat([header, data]));
  } catch {
    /* 连接已断开，忽略 */
  }
}

function wsSendText(socket, text) {
  wsSend(socket, 0x1, text);
}

/** 发送 close 帧并结束连接。 */
function wsClose(socket, code = 1000, reason = '') {
  const payload = Buffer.alloc(2);
  payload.writeUInt16BE(code, 0);
  const body = Buffer.concat([payload, Buffer.from(reason, 'utf8')]);
  wsSend(socket, 0x8, body);
  try {
    socket.end();
  } catch {
    /* ignore */
  }
}

/**
 * 从连接缓存中解析出所有完整帧（支持粘包循环解析 + 半包缓存）。
 * 返回 [{ fin, opcode, payload }]，并把消费掉的字节从 state.buf 中移除。
 */
function wsDecodeFrames(state) {
  const frames = [];
  let buf = state.buf;
  for (;;) {
    if (buf.length < 2) break;
    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let offset = 2;

    if (len === 126) {
      // 16bit 扩展长度
      if (buf.length < 4) break;
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      // 64bit 扩展长度
      if (buf.length < 10) break;
      const big = buf.readBigUInt64BE(2);
      if (big > BigInt(MAX_BODY_BYTES)) throw new Error('WS 帧过大');
      len = Number(big);
      offset = 10;
    }

    let maskKey = null;
    if (masked) {
      if (buf.length < offset + 4) break;
      maskKey = buf.subarray(offset, offset + 4);
      offset += 4;
    }
    if (buf.length < offset + len) break; // 半包：等待下次数据

    const payload = Buffer.from(buf.subarray(offset, offset + len));
    if (maskKey) {
      for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
    }
    frames.push({ fin, opcode, payload });
    buf = buf.subarray(offset + len);
  }
  state.buf = buf;
  return frames;
}

// ---------------------------------------------------------------------------
// 6) WebSocket /v2/open-ise —— 讯飞 ISE 语音评测模拟
// ---------------------------------------------------------------------------

const XML_HEAD = '<?xml version="1.0" encoding="utf-8"?>';

/** 取文本中的汉字（去掉标点空白），最多 n 个。 */
function pickHanChars(text, n) {
  return Array.from(text ?? '').filter((ch) => /\p{Script=Han}/u.test(ch)).slice(0, n);
}

/** 声母占位：ASCII 字母取小写首字母，否则用 `_`。 */
function mockInitial(ch) {
  const m = String(ch).match(/[a-zA-Z]/);
  return m ? m[0].toLowerCase() : '_';
}

/** 把 category 变成一个合法 XML 标签名（read_syllable / read_word / read_sentence / read_chapter）。 */
function categoryTag(category) {
  const raw = String(category ?? '').trim();
  if (/^[A-Za-z_][A-Za-z0-9._-]*$/.test(raw)) return raw;
  return 'read_sentence';
}

/**
 * 构造 ISE 结果 XML。
 * 结构：<xml_result><CATEGORY 外层><rec_paper><CATEGORY 内层分数>...</CATEGORY></rec_paper></CATEGORY></xml_result>
 * 其中 CATEGORY 是占位：实际标签名 = business.category（内外层同名，与讯飞返回一致）。
 */
function buildIseXml(category, text) {
  const tag = categoryTag(category);
  const chars = pickHanChars(text, 12);
  const content30 = escapeXml(Array.from(text ?? '').slice(0, 30).join(''));
  const words = [];

  chars.forEach((ch, i) => {
    // 第 2 个 word（下标 1）的 syll 标为漏读；第 5 个 word（下标 4）的首个 phone 标声母错误
    const syllDp = i === 1 ? ' dp_message="16"' : ' dp_message="0"';
    const initialErr = i === 4 ? ' perr_msg="1"' : '';
    const initial = escapeXml(mockInitial(ch));
    const han = escapeXml(ch);
    words.push(
      `        <word content="${han}" symbol="zi4">` +
        `<syll content="${han}"${syllDp} symbol="zi4">` +
        `<phone content="${initial}" is_yun="0" dp_message="0"${initialErr}></phone>` +
        `<phone content="a" is_yun="1" mono_tone="TONE1" dp_message="0"></phone>` +
        `</syll></word>`,
    );
  });

  const innerOpen =
    chars.length > 0
      ? `<${tag} total_score="92.35" phone_score="93.2" tone_score="91.5" integrity_score="100" ` +
        `fluency_score="90.6" emotion_score="89.4" accuracy_score="93.0" content="${content30}" ` +
        `except_info="0" is_rejected="false" beg_pos="0" end_pos="150" time_len="150">`
      : `<${tag} total_score="92.35">`;

  const body = words.length > 0 ? `\n${words.join('\n')}\n` : '';
  const sentence = `        <sentence total_score="90.1" phone_score="93.2" tone_score="91.5"/>`;

  return (
    `${XML_HEAD}\n` +
    `<xml_result>\n` +
    `  <${tag} lan="cn" type="study" version="7,0,0,1024">\n` +
    `    <rec_paper>\n` +
    `      ${innerOpen}\n` +
    body +
    `${sentence}\n` +
    `      </${tag}>\n` +
    `    </rec_paper>\n` +
    `  </${tag}>\n` +
    `</xml_result>`
  );
}

/** 构造最终结果帧 JSON 文本。 */
function buildIseResult(category, text) {
  const xml = buildIseXml(category, text);
  const sid = `ise_mock_${crypto.randomBytes(4).toString('hex')}`; // 随机 8 位十六进制
  return JSON.stringify({
    code: 0,
    message: 'success',
    sid,
    data: { status: 2, data: Buffer.from(xml, 'utf8').toString('base64') },
  });
}

/** 处理一条完整的文本消息（ISE 协议）。 */
function handleIseTextMessage(state, rawText) {
  const body = tryParseJson(Buffer.from(rawText, 'utf8'));
  if (!body || typeof body !== 'object') {
    wsSendText(state.socket, JSON.stringify({
      code: 10160,
      message: 'parse request json error',
      sid: 'ise_mock',
      data: null,
    }));
    wsClose(state.socket, 1000, 'parse error');
    return;
  }

  // 第 1 个文本帧（ssb）：存 category / text
  const business = body.business ?? {};
  if (!state.receivedSsb) {
    state.receivedSsb = true;
    state.category = String(business.category ?? 'read_sentence');
    state.text = String(business.text ?? '').replace(/^\uFEFF/, '');
  }

  // 音频结束判定：business.aus === 4 或 data.status === 2
  const status = body.data?.status;
  const aus = business.aus;
  if (aus === 4 || status === 2) {
    state.audioEnded = true;
    if (state.finalTimer) return;
    state.finalTimer = setTimeout(() => {
      state.finalTimer = null;
      if (state.closed) return;
      try {
        wsSendText(state.socket, buildIseResult(state.category, state.text));
      } catch (err) {
        console.error('[mock] ISE 发送结果失败:', err.message);
      }
    }, 30);
  }
}

/** 语音听写（/v2/iat）模拟：收到结束帧后返回转写文本 */
function handleIatTextMessage(state, rawText) {
  const body = tryParseJson(Buffer.from(rawText, 'utf8'));
  if (!body || typeof body !== 'object') {
    wsSendText(state.socket, JSON.stringify({ code: 10160, message: 'parse request json error', data: null }));
    return;
  }
  if (body.data?.status === 2) {
    if (state.finalTimer) return;
    state.finalTimer = setTimeout(() => {
      state.finalTimer = null;
      if (state.closed) return;
      wsSendText(
        state.socket,
        JSON.stringify({
          code: 0,
          message: 'success',
          sid: 'iat_mock_' + Math.random().toString(16).slice(2, 10),
          data: {
            status: 2,
            result: {
              sn: 1,
              ls: true,
              ws: [{ bg: 0, cw: [{ sc: 0, w: '（模拟转写）今天天气很好，我们一起来学习普通话。' }] }],
            },
          },
        }),
      );
    }, 30);
  }
}

/** 按路径分发 WS 文本帧 */
function handleWsTextMessage(state, rawText) {
  if ((state.wsPath || '').includes('/v2/iat')) handleIatTextMessage(state, rawText);
  else handleIseTextMessage(state, rawText);
}

/** 处理 WebSocket 升级请求。 */
function handleUpgrade(req, socket, head) {
  console.log(`[mock] GET ${req.url} (upgrade)`);
  socket.on('error', () => { /* 忽略单连接错误，避免进程崩溃 */ });

  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string' || key.trim() === '') {
    try {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
    } catch { /* ignore */ }
    return;
  }
  const accept = wsAccept(key.trim());
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n` +
      '\r\n',
  );
  socket.setNoDelay(true);

  const wsPath = String(req.url || '').split('?')[0];
  const state = {
    socket,
    wsPath,
    buf: Buffer.alloc(0),
    frag: null, // 分片消息累积 { opcode, chunks }
    category: 'read_sentence',
    text: '',
    receivedSsb: false,
    audioEnded: false,
    finalTimer: null,
    closed: false,
  };

  const cleanup = () => {
    state.closed = true;
    if (state.finalTimer) {
      clearTimeout(state.finalTimer);
      state.finalTimer = null;
    }
    state.buf = Buffer.alloc(0);
  };

  const onData = (chunk) => {
    if (state.closed) return;
    try {
      state.buf = Buffer.concat([state.buf, chunk]);
      const frames = wsDecodeFrames(state);
      for (const frame of frames) {
        if (state.closed) break;
        const { opcode, fin, payload } = frame;

        if (opcode === 0x8) {
          // close：回一帧 close 后结束
          cleanup();
          wsSend(socket, 0x8, payload.subarray(0, 2));
          try { socket.end(); } catch { /* ignore */ }
          return;
        }
        if (opcode === 0x9) {
          // ping → pong
          wsSend(socket, 0xa, payload);
          continue;
        }
        if (opcode === 0xa) continue; // pong 忽略
        if (opcode === 0x1 || opcode === 0x2) {
          if (!fin) {
            state.frag = { opcode, chunks: [payload] };
            continue;
          }
          if (state.frag) {
            state.frag = null; // 异常：新消息打断旧分片
          }
          if (opcode === 0x1) handleWsTextMessage(state, payload.toString('utf8'));
          continue;
        }
        if (opcode === 0x0) {
          if (!state.frag) continue; // 无起始帧的续帧，忽略
          state.frag.chunks.push(payload);
          if (fin) {
            const whole = Buffer.concat(state.frag.chunks);
            const fragOp = state.frag.opcode;
            state.frag = null;
            if (fragOp === 0x1) handleWsTextMessage(state, whole.toString('utf8'));
          }
          continue;
        }
        // 其它 opcode 忽略
      }
    } catch (err) {
      console.error('[mock] WebSocket 帧处理异常:', err.message);
      cleanup();
      wsClose(socket, 1009, 'frame error');
    }
  };

  socket.on('data', onData);
  socket.on('end', cleanup);
  socket.on('close', cleanup);
  socket.on('timeout', () => { cleanup(); socket.destroy(); });

  // 升级请求可能自带首包数据
  if (head && head.length > 0) onData(head);
}

// ---------------------------------------------------------------------------
// HTTP 路由 + 启动
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
    const method = (req.method ?? 'GET').toUpperCase();
    console.log(`[mock] ${method} ${req.url}`);

    // 统一 CORS 预检
    if (method === 'OPTIONS') {
      res.writeHead(204, { ...CORS_HEADERS, 'Access-Control-Max-Age': '86400' });
      res.end();
      return;
    }
    // 每个请求独立 try/catch：任何异常都只影响本请求
    Promise.resolve()
      .then(async () => {
        if (url.pathname === '/health' && method === 'GET') return handleHealth(res);
        if (url.pathname === '/v1/chat/completions' && method === 'POST') {
          return handleChatCompletions(req, res);
        }
        if (url.pathname === '/v1/audio/transcriptions' && method === 'POST') {
          return handleTranscriptions(req, res);
        }
        if (url.pathname === '/v1/models' && method === 'GET') return handleModels(res);
        if (url.pathname === '/tts' && (method === 'POST' || method === 'GET')) {
          return handleTts(req, res, url);
        }
        // 兼容偶尔用 GET/HEAD 探测的客户端
        if (url.pathname === '/health' && method === 'HEAD') {
          res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
          res.end();
          return;
        }
        sendJson(res, 404, { error: { message: `未实现的端点: ${method} ${url.pathname}`, type: 'not_found', code: 404 } });
      })
      .catch((err) => {
        console.error(`[mock] 处理 ${method} ${url.pathname} 出错:`, err?.stack ?? err);
        sendError(res, 500, err?.message ?? 'mock server internal error');
      });
  } catch (err) {
    // 连 URL 都解析失败等极端情况
    console.error('[mock] 请求入口异常:', err?.stack ?? err);
    sendError(res, 500, err?.message ?? 'mock server internal error');
  }
});

server.on('upgrade', handleUpgrade);

server.on('clientError', (err, socket) => {
  console.error('[mock] clientError:', err.message);
  try { socket.destroy(); } catch { /* ignore */ }
});

server.on('error', (err) => {
  if (err?.code === 'EADDRINUSE') {
    console.error(`[mock] 错误：端口 ${PORT} 已被占用，请换一个端口，例如: node tools/mock_server.mjs ${PORT + 1}`);
  } else {
    console.error('[mock] 服务启动失败:', err?.message ?? err);
  }
  process.exit(1);
});

// 兜底：任何未捕获异常都不让进程退出
process.on('uncaughtException', (err) => {
  console.error('[mock] uncaughtException（已忽略，进程继续）:', err?.stack ?? err);
});
process.on('unhandledRejection', (err) => {
  console.error('[mock] unhandledRejection（已忽略，进程继续）:', err?.stack ?? err);
});

server.listen(PORT, () => {
  console.log(`MOCK READY http://127.0.0.1:${PORT}`);
});

// 导出以便（可选）在测试中复用；直接运行时无副作用
export { buildIseXml, buildWavBuffer, buildIseResult, wsAccept };
