/**
 * ShoMate Gemini 프록시 — Cloudflare Worker (배포 이름: shomate-proxy)
 *
 * 무엇인가
 *   확장(background.js)의 AI 호출을 대신 받아 Gemini 에 전달하는 프록시.
 *   server/main.py 의 GET /health · POST /gemini 와 **같은 계약**이다
 *   (요청·응답 모양, 모델 허용목록·티어, generationConfig/tools 정화, 완화 사다리, 오류 문구).
 *   확장은 어느 쪽에 붙어도 같은 파싱 로직으로 동작한다.
 *
 * 왜 다시 썼나
 *   기존 배포본은 /health 는 200 인데 POST /gemini 가 모델과 무관하게 전부
 *   502 "AI 오류 (upstream 404)" 를 냈다. 같은 모델을 유효한 키로 Gemini 에 직접 부르면 200 이었으므로
 *   Worker 의 업스트림 호출 구성(URL 등)이 고장난 것이다. 원본 소스가 로컬에 없어 고칠 수 없으니
 *   main.py 의 계약을 기준으로 처음부터 다시 썼다. 업스트림 URL 은 main.py 와 같은 형식이다.
 *
 * 키
 *   GEMINI_API_KEY 는 Cloudflare 의 Secret(env.GEMINI_API_KEY)에만 둔다. 이 파일·확장 번들·URL 에는 없다.
 *   업스트림에는 쿼리스트링(?key=)이 아니라 x-goog-api-key 헤더로 보낸다 —
 *   쿼리에 넣으면 프록시·액세스 로그에 키가 남는다.
 *
 * 구조
 *   위쪽은 순수 함수(tests/worker.test.js 가 이 파일을 읽어 그대로 실행한다), 맨 아래 fetch 핸들러는 얇게.
 *   외부 패키지 없이 표준 Web API(fetch, Response, URL, AbortController, crypto.subtle)만 쓴다.
 *   배포 방법·시크릿·확인 명령은 proxy/README.md.
 */

// ── 설정 (main.py 와 같은 값) ────────────────────────────────────
const BASE_MODEL = 'gemini-2.5-flash';         // 완화 사다리 마지막 단계 — 호출부 원래 설정이 검증된 모델
const DEFAULT_MODEL = 'gemini-3.5-flash-lite'; // main.py GEMINI_MODEL 기본값 — 요청 모델이 없거나 권한 밖일 때

// 티어별 허용 모델. 클라이언트가 보낸 model 문자열은 URL 경로에 들어가므로
// 절대 그대로 쓰지 않는다 — 이 목록에 없으면 기본 모델로 떨어뜨린다.
const MODEL_TIERS = {
  'gemini-3.5-flash-lite': 'free',
  'gemini-3.7-flash': 'pro',
  'gemini-2.5-pro': 'enterprise',
};
const TIER_RANK = { free: 0, pro: 1, enterprise: 2 };

const MAX_PROMPT_CHARS = 20000;       // env.MAX_PROMPT_CHARS 로 덮어쓸 수 있다
const MAX_OUTPUT_TOKENS_CAP = 4096;   // 확장이 출력 토큰을 키워 비용을 태우지 못하게
const UPSTREAM_TIMEOUT_MS = 30000;    // main.py UPSTREAM_TIMEOUT_S 와 같은 30초

// generationConfig 로 허용할 키 — 알 수 없는 키는 버린다
const ALLOWED_GEN_CONFIG_KEYS = [
  'temperature', 'maxOutputTokens', 'topP', 'topK',
  'stopSequences', 'responseMimeType', 'thinkingConfig',
];
// tools 로 허용할 키 — 확장이 임의의 도구를 켜서 비용을 태우지 못하게 화이트리스트로 제한
const ALLOWED_TOOL_KEYS = ['google_search'];

const GEMINI_MODELS_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

// 크롬 확장 ID 는 a~p 32자다(0~9a~f 를 a~p 로 옮긴 16진). 그래서 [a-z] 가 아니라 [a-p].
const EXTENSION_ORIGIN_RE = /^chrome-extension:\/\/([a-p]{32})$/;

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// ── 업스트림 URL ─────────────────────────────────────────────────
// model 은 resolveModel 을 거친 허용목록 값만 오므로 인코딩하지 않는다.
// 앞에 'models/' 가 붙어 와도 경로에 두 번 들어가지 않게 떼어낸다 (…/models/models/… 는 404).
function upstreamUrl(model) {
  return GEMINI_MODELS_BASE + String(model).replace(/^models\//, '') + ':generateContent';
}

// ── 요청 정화 (main.py _sanitize_generation_config / _sanitize_tools 와 같은 규칙) ──
function sanitizeGenerationConfig(cfg) {
  if (!isPlainObject(cfg)) return {};
  const out = {};
  for (const k of Object.keys(cfg)) {
    if (ALLOWED_GEN_CONFIG_KEYS.indexOf(k) >= 0) out[k] = cfg[k];
  }
  const mot = out.maxOutputTokens;
  if (typeof mot === 'number' && isFinite(mot)) {
    // Python int() 처럼 0 쪽으로 자른 뒤 상한 적용
    out.maxOutputTokens = Math.min(Math.trunc(mot), MAX_OUTPUT_TOKENS_CAP);
  }
  return out;
}

function sanitizeTools(tools) {
  if (!Array.isArray(tools)) return [];
  // main.py 와 같다: 모든 키가 허용목록 안에 있는 dict 만 남긴다 (빈 dict 도 통과 — 같은 규칙 유지)
  return tools.filter(t => isPlainObject(t) && Object.keys(t).every(k => ALLOWED_TOOL_KEYS.indexOf(k) >= 0));
}

// ── 모델 결정 (main.py _resolve_model) ────────────────────────────
// 티어는 서명된 라이선스에서만 나온다. 확장이 보내는 값은 신뢰하지 않는다.
// 권한이 없거나 모르는 모델이면 조용히 기본 모델로 떨어뜨린다(요청은 살린다).
function resolveModel(requested, tier) {
  if (typeof requested !== 'string' || !requested) return DEFAULT_MODEL;
  // hasOwn: 'constructor' 같은 프로토타입 이름이 허용목록으로 통과하지 않게
  if (!hasOwn(MODEL_TIERS, requested)) {
    console.log('허용목록에 없는 모델 요청: ' + JSON.stringify(requested.slice(0, 40)));
    return DEFAULT_MODEL;
  }
  const need = MODEL_TIERS[requested];
  const have = hasOwn(TIER_RANK, tier) ? TIER_RANK[tier] : 0;
  if (have < TIER_RANK[need]) {
    console.log('티어 부족 (' + tier + ' < ' + need + ') — 기본 모델로 대체');
    return DEFAULT_MODEL;
  }
  return requested;
}

// ── 라이선스 검증 (billing.py verify_license 와 같은 의미) ─────────
// 토큰 = b64url(JSON 본문) + '.' + b64url(HMAC-SHA256(secret, b64url 본문)).
// b64 는 billing.py _b64e 와 같다: urlsafe 알파벳, 끝의 '=' 패딩 제거.
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function b64urlEncode(bytes) {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63] + B64URL[(n >> 6) & 63] + B64URL[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63];
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63] + B64URL[(n >> 6) & 63];
  }
  return out;
}

// billing.py _b64d 는 패딩을 채워 디코드한다. 여기서는 패딩 없는 urlsafe 만 받는다(엄격).
// 서명 검증을 통과한 뒤에만 부르므로 입력은 서버가 만든 값이고, 그 값에 대해서는 결과가 같다.
function b64urlDecode(s) {
  const clean = String(s).replace(/=+$/, '');
  if (!/^[A-Za-z0-9_-]*$/.test(clean) || clean.length % 4 === 1) throw new Error('b64 형식 오류');
  const out = [];
  let buf = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i++) {
    buf = (buf << 6) | B64URL.indexOf(clean[i]);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 255);
    }
  }
  return new Uint8Array(out);
}

// TextEncoder 없이도(테스트 환경 JXA) 같은 결과가 나오게 직접 인코딩한다.
// 짝 없는 서로게이트는 TextEncoder 처럼 U+FFFD 로 바꾼다.
function utf8Bytes(str) {
  const out = [];
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (d >= 0xdc00 && d <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; } else c = 0xfffd;
    } else if (c >= 0xdc00 && c <= 0xdfff) c = 0xfffd;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return new Uint8Array(out);
}

// 잘못된 UTF-8 이면 decodeURIComponent 가 던진다 → verifyLicense 가 'free' 로 받는다 (json.loads 실패와 같다)
function utf8Decode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '%0' : '%') + bytes[i].toString(16);
  return decodeURIComponent(s);
}

// 타이밍 공격 방지 — 첫 불일치에서 멈추지 않고 끝까지 비교한다 (hmac.compare_digest 대응)
function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacSha256(keyBytes, dataBytes) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, dataBytes));
}

/** 서명이 유효하면 tier, 아니면 'free'. 예외를 던지지 않는다. secret 이 없으면 항상 'free'. */
async function verifyLicense(token, secret, nowSec) {
  try {
    // billing.py 처럼 앞뒤 공백을 떼고 UTF-8 바이트를 키로 쓴다 (대시보드에 붙여넣을 때 줄바꿈이 섞여도 같은 키)
    const key = typeof secret === 'string' ? secret.trim() : '';
    if (!key) return 'free';   // 서명 키가 없으면 어떤 토큰도 믿을 근거가 없다
    if (typeof token !== 'string' || token.indexOf('.') < 0) return 'free';
    const dot = token.indexOf('.');            // Python str.partition 과 같이 첫 '.' 에서 자른다
    const payload = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = b64urlEncode(await hmacSha256(utf8Bytes(key), utf8Bytes(payload)));
    if (!constantTimeEqual(sig, expected)) return 'free';
    const body = JSON.parse(utf8Decode(b64urlDecode(payload)));
    if (!isPlainObject(body)) return 'free';
    const exp = Number(body.exp === undefined ? 0 : body.exp);
    const now = typeof nowSec === 'number' ? nowSec : Date.now() / 1000;
    if (!isFinite(exp) || Math.trunc(exp) < now) return 'free';
    return body.tier ? String(body.tier) : 'free';
  } catch (e) {
    return 'free';  // crypto 미지원·형식 오류 등 어떤 경우든 무료 티어로 — 요청 자체는 살린다
  }
}

// ── 완화 사다리 (main.py 와 같은 순서·조건) ────────────────────────
// 모델·설정 비호환(400)이나 이 키에서 안 열리는 모델(404)이면 502 로 끝내지 않고
//   ① 그대로 → ② thinkingConfig 제거 → ③ tools 제거 → ④ 기준 모델 gemini-2.5-flash
// 순으로 재시도한다. 401/403/429/5xx 는 완화해도 소용없으니 즉시 중단 (runPlan).
function withoutThinking(cfg) {
  const out = {};
  for (const k of Object.keys(cfg)) if (k !== 'thinkingConfig') out[k] = cfg[k];
  return out;
}

function buildPlan(model, genCfg, tools) {
  const cfg = isPlainObject(genCfg) ? genCfg : {};
  const tls = Array.isArray(tools) ? tools : [];
  const plan = [{ model: model, cfg: cfg, tools: tls, why: '' }];
  if (hasOwn(cfg, 'thinkingConfig')) {
    plan.push({ model: model, cfg: withoutThinking(cfg), tools: tls, why: 'thinkingConfig 제거' });
  }
  if (tls.length) {
    plan.push({ model: model, cfg: withoutThinking(cfg), tools: [], why: 'tools 제거' });
  }
  if (model !== BASE_MODEL) {
    // 기준 모델은 thinkingBudget 0 이 유효(호출부 원래 설정) — thinking 토큰이 출력 상한을 잠식하지 않게
    const baseCfg = withoutThinking(cfg);
    baseCfg.thinkingConfig = { thinkingBudget: 0 };
    plan.push({ model: BASE_MODEL, cfg: baseCfg, tools: tls, why: '기준 모델 ' + BASE_MODEL + ' 로 대체' });
  }
  return plan;
}

function buildPayload(prompt, cfg, tools) {
  const payload = { contents: [{ parts: [{ text: prompt }] }] };
  if (cfg && Object.keys(cfg).length) payload.generationConfig = cfg;   // main.py: if cfg:
  if (tools && tools.length) payload.tools = tools;                     // main.py: if tls:
  return payload;
}

// 업스트림 1회 호출. 던지지 않고 결과 종류를 돌려준다.
//   { status, text } | { timeout: true } | { network: true, message }
async function postUpstream(url, payload, apiKey) {
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(payload),
      signal: ctl.signal,
    });
    const text = await res.text();   // 본문을 다 읽을 때까지 타이머를 유지한다
    return { status: res.status, text: text };
  } catch (e) {
    if (timedOut || (e && e.name === 'AbortError')) return { timeout: true };
    return { network: true, message: String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

// 사다리를 실제로 돈다. 반환: { status, body } — 핸들러가 그대로 JSON 응답으로 만든다.
async function runPlan(plan, prompt, apiKey) {
  let lastStatus = 0;
  let lastText = '';
  const dead = {};   // 404 난 모델은 다시 부르지 않는다 (키에서 모델 자체가 안 열림)
  for (const step of plan) {
    if (dead[step.model]) continue;
    if (step.why && lastStatus !== 400 && lastStatus !== 404) break;
    if (step.why) console.log('Gemini ' + lastStatus + ' → 재시도(' + step.why + '): ' + lastText.slice(0, 160));
    const r = await postUpstream(upstreamUrl(step.model), buildPayload(prompt, step.cfg, step.tools), apiKey);
    if (r.timeout) {
      console.log('Gemini 타임아웃 (' + UPSTREAM_TIMEOUT_MS / 1000 + 's)');
      return { status: 504, body: { error: 'AI 응답 시간 초과' } };
    }
    if (r.network) {
      console.log('Gemini 호출 실패: ' + r.message);
      return { status: 502, body: { error: 'AI 호출 실패' } };
    }
    if (r.status === 200) {
      let data;
      try { data = JSON.parse(r.text); } catch (e) {
        console.log('Gemini 200 이지만 JSON 아님: ' + String(r.text).slice(0, 160));
        return { status: 502, body: { error: 'AI 응답 형식 오류' } };
      }
      if (step.why) console.log("'" + step.why + "' 로 성공 — 설정/모델 점검 필요 (요청 모델 " + plan[0].model + ')');
      return { status: 200, body: data };
    }
    lastStatus = r.status;
    lastText = r.text || '';
    if (lastStatus === 404) dead[step.model] = true;
  }
  // 업스트림 에러 본문은 응답에 싣지 않는다 (키·내부 정보가 섞일 여지 차단). 진단은 wrangler tail 로.
  console.log('Gemini ' + lastStatus + ': ' + lastText.slice(0, 300));
  return { status: 502, body: { error: 'AI 오류 (upstream ' + lastStatus + ')' } };
}

// ── HTTP 공통 ───────────────────────────────────────────────────
function parseIdList(raw) {
  return String(raw || '').split(',').map(s => s.trim()).filter(Boolean);
}

// 확장 서비스워커의 fetch 는 Origin: chrome-extension://<id> 로 온다.
// manifest 의 host_permissions 에 이 도메인이 없으므로 CORS 가 걸린다 → 허용 오리진만 그대로 반사한다.
// ALLOWED_EXTENSION_IDS(쉼표 목록)가 있으면 그 ID 만, 없으면 형식이 맞는 모든 확장(개발용).
// 오리진 검사는 브라우저 밖(curl 등)에서는 위조 가능하므로 인증이 아니다 — 남용 방지는 README 의 레이트리밋.
function corsHeaders(origin, env) {
  const h = { 'Vary': 'Origin' };   // 응답이 Origin 에 따라 달라지므로 캐시가 섞이지 않게
  const m = typeof origin === 'string' ? EXTENSION_ORIGIN_RE.exec(origin) : null;
  if (!m) return h;
  const ids = parseIdList(env && env.ALLOWED_EXTENSION_IDS);
  if (ids.length && ids.indexOf(m[1]) < 0) return h;
  h['Access-Control-Allow-Origin'] = origin;
  h['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
  h['Access-Control-Allow-Headers'] = 'Content-Type';
  h['Access-Control-Max-Age'] = '86400';
  return h;
}

function jsonResponse(status, obj, cors, extra) {
  const headers = Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, cors, extra || {});
  return new Response(JSON.stringify(obj), { status: status, headers: headers });
}

function resolveMaxPromptChars(env) {
  const raw = String((env && env.MAX_PROMPT_CHARS) || '').trim();
  const n = /^\d+$/.test(raw) ? parseInt(raw, 10) : 0;
  return n > 0 ? n : MAX_PROMPT_CHARS;
}

// Python len() 과 같게 코드포인트 수로 센다 (이모지 1개 = 1자). 짧은 문자열은 세지 않고 통과.
function promptChars(s, limit) {
  if (s.length <= limit) return s.length;
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
    n++;
  }
  return n;
}

function getApiKey(env) {
  return String((env && env.GEMINI_API_KEY) || '').trim();
}

// ── 라우트 ──────────────────────────────────────────────────────
function handleHealth(env, cors) {
  // 확장이 30초 캐시로 호출한다. 키가 없으면 503 → 확장은 다음 경로로 간다.
  if (!getApiKey(env)) return jsonResponse(503, { ok: false, error: 'GEMINI_API_KEY 미설정' }, cors);
  // defaultModel: 새 코드가 배포됐는지 구별하는 표식이기도 하다 (옛 배포본은 bindings 를 냈다)
  return jsonResponse(200, { ok: true, model: BASE_MODEL, defaultModel: DEFAULT_MODEL }, cors);
}

async function handleGemini(request, env, cors) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse(400, { error: 'JSON 본문이 필요합니다' }, cors);
  }
  // main.py 는 pydantic 검증(prompt: str, min_length=1)이 핸들러보다 먼저 돈다 → 같은 순서
  if (!isPlainObject(body) || typeof body.prompt !== 'string' || body.prompt.length === 0) {
    return jsonResponse(400, { error: 'prompt 가 필요합니다' }, cors);
  }
  const apiKey = getApiKey(env);
  if (!apiKey) return jsonResponse(503, { error: '서버에 GEMINI_API_KEY 가 설정되지 않았습니다.' }, cors);

  const maxChars = resolveMaxPromptChars(env);
  const n = promptChars(body.prompt, maxChars);
  if (n > maxChars) {
    return jsonResponse(413, { error: '프롬프트가 너무 깁니다(' + n + '자). 최대 ' + maxChars + '자.' }, cors);
  }

  const tier = await verifyLicense(body.license, env.SHOMATE_LICENSE_SECRET, Date.now() / 1000);
  const model = resolveModel(body.model, tier);
  const plan = buildPlan(model, sanitizeGenerationConfig(body.generationConfig), sanitizeTools(body.tools));
  const result = await runPlan(plan, body.prompt, apiKey);
  return jsonResponse(result.status, result.body, cors);
}

export default {
  async fetch(request, env, ctx) {
    env = env || {};
    const cors = corsHeaders(request.headers.get('Origin'), env);
    try {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
      const path = new URL(request.url).pathname;
      if (path === '/health') {
        if (request.method === 'GET') return handleHealth(env, cors);
        return jsonResponse(405, { error: '허용되지 않는 메서드입니다' }, cors, { 'Allow': 'GET, OPTIONS' });
      }
      if (path === '/gemini') {
        if (request.method === 'POST') return await handleGemini(request, env, cors);
        return jsonResponse(405, { error: '허용되지 않는 메서드입니다' }, cors, { 'Allow': 'POST, OPTIONS' });
      }
      return jsonResponse(404, { error: '없는 경로입니다' }, cors);
    } catch (e) {
      // 예상 못 한 예외도 CORS 헤더가 붙은 JSON 으로 — 확장이 'Failed to fetch' 대신 상태코드를 보게
      console.log('처리 중 예외: ' + String((e && e.stack) || e));
      return jsonResponse(500, { error: '서버 내부 오류' }, cors);
    }
  },
};
