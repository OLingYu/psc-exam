// 讯飞开放平台公共工具：WebSocket 握手签名（HMAC-SHA256）、base64、错误码说明

/** HMAC-SHA256 → base64（浏览器 WebCrypto） */
export async function hmacSha256Base64(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return bytesToBase64(new Uint8Array(sig));
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(binary);
}

export function base64ToUtf8(b64: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

export interface WsSignatureParams {
  host: string;
  path: string;
  apiKey: string;
  apiSecret: string;
  /** 覆盖请求的 HTTP 方法（ISE/suntone 均为 GET 风格的握手） */
  method?: string;
}

/**
 * 构造带鉴权参数的 wss 地址：
 *   signature_origin = "host: {host}\ndate: {date}\nGET {path} HTTP/1.1"
 *   signature        = base64(hmac-sha256(signature_origin, apiSecret))
 *   authorization    = base64(`api_key="...", algorithm="hmac-sha256", headers="host date request-line", signature="..."`)
 */
export async function buildSignedWsUrl(params: WsSignatureParams): Promise<string> {
  const { path, apiKey, apiSecret } = params;
  const method = params.method ?? 'GET';
  // host 支持写成 wss://host、ws://host:port、host，本机调试/自建代理时自动用 ws
  let raw = params.host.trim().replace(/\/+$/, '');
  let scheme = 'wss';
  const m = raw.match(/^(wss?|https?):\/\/(.*)$/i);
  if (m) {
    scheme = m[1].toLowerCase().startsWith('wss') || m[1].toLowerCase() === 'https' ? 'wss' : 'ws';
    raw = m[2];
  } else if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|$)/.test(raw)) {
    scheme = 'ws';
  }
  const host = raw;
  const date = new Date().toUTCString();
  const origin = `host: ${host}\ndate: ${date}\n${method} ${path} HTTP/1.1`;
  const signature = await hmacSha256Base64(apiSecret, origin);
  const authOrigin = `api_key="${apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
  const authorization = bytesToBase64(new TextEncoder().encode(authOrigin));
  const query = new URLSearchParams({ authorization, host, date });
  return `${scheme}://${host}${path}?${query.toString()}`;
}

/** 讯飞常见 WebSocket 错误码 → 中文说明 */
const ISE_ERRORS: Record<number, string> = {
  10105: '没有权限（请确认控制台已开通「语音评测」服务，且 AppID/APIKey/APISecret 属于同一应用）',
  10106: '参数错误（cmd/business 字段不合法）',
  10110: '无授权（请确认应用已开通语音评测流式版服务）',
  10160: '请求数据格式非法（JSON 解析失败）',
  10163: '缺少必传参数或参数不合法（请查看 message 详情）',
  10165: '会话超时',
  10202: '网络异常',
  10313: 'appid 不能为空',
  10317: '版本非法',
  10700: '引擎错误',
  11200: '没有该能力权限（未开通对应服务或已超量）',
  11201: '日流控超限',
  10701: '音频格式错误（要求 16k / 16bit / 单声道）',
  10703: '音频时长超限（评测会话不超过 5 分钟）',
  10704: '音频数据不完整',
  10114: 'session 超时',
  10201: '参数缺失',
};

export function explainXfyunError(code: number, message?: string): string {
  const base = ISE_ERRORS[code];
  const raw = message ? `（云端返回：${message}）` : '';
  return base ? `${base} · 错误码 ${code}${raw}` : `讯飞接口返回错误码 ${code}${raw}`;
}

/** 简单重试封装 */
export async function withRetry<T>(fn: () => Promise<T>, times = 1, delayMs = 800): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i <= times; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < times) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
