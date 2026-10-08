/**
 * Cloudflare Worker 프록시(proxy/worker.js) 테스트
 *
 * proxy/worker.js 를 실제 소스 그대로 읽어 실행한다 ('export default' 만 'var __default =' 로 바꿔
 * new Function 으로 평가). 로직을 복붙해 검증하면 원본이 바뀌어도 테스트가 통과해버리기 때문이다.
 * 같은 이유로 server/main.py 도 읽어 모델 허용목록·기본 모델·정화 규칙이 Worker 와 같은지 대조한다.
 *
 * JXA(osascript)에는 URL/Request/Response/Headers/AbortController/setTimeout/crypto 가 없다.
 * 그래서 아래의 최소 목(mock)을 new Function 의 인자로 주입한다 — node 에서도 같은 목을 써서
 * 두 런타임이 같은 코드 경로를 돈다. 업스트림 fetch 도 목이라 네트워크에 나가지 않는다.
 * crypto 만 예외: node 에 webcrypto 가 있으면 진짜를, 없으면(JXA) 이 파일의 순수 JS HMAC-SHA256 을 쓴다.
 *
 * 비동기 처리: 핸들러가 async 라 결과가 Promise 다. osascript 는 스크립트 본문이 끝난 뒤
 * 마이크로태스크를 비우고 나서 종료한다(이 저장소 환경에서 확인). 그래서 비동기 검사는 Promise 체인으로
 * 돌리고, 마지막 .then 에서 보고서를 stdout(NSFileHandle)에 직접 쓰고 $.exit 로 종료 코드를 정한다.
 * 체인이 끝나지 못하면(마이크로태스크 미처리·Promise 미완료) 맨 끝 표현식의 경고 문구가 대신 출력된다.
 *
 * 실행 (저장소 루트에서):
 *   node tests/worker.test.js
 *   osascript -l JavaScript tests/worker.test.js
 */

// ── 런타임 호환 (node / osascript JXA) ─────────────────────────
function readFile(path) {
  if (typeof require === 'function') return require('fs').readFileSync(path, 'utf8');
  ObjC.import('Foundation');
  return ObjC.unwrap(
    $.NSString.stringWithContentsOfFileEncodingError($(path), $.NSUTF8StringEncoding, null)
  );
}
const IS_NODE = typeof process !== 'undefined' && !!(process.versions && process.versions.node);

const SRC_PATH = 'proxy/worker.js';
const src = readFile(SRC_PATH);
if (!src) throw new Error(SRC_PATH + ' 를 읽지 못했습니다. 저장소 루트에서 실행하세요.');
if (!/^export default /m.test(src)) throw new Error(SRC_PATH + ' 에 export default 가 없습니다.');
const MODULE_SRC = src.replace(/^export default /m, 'var __default = ');
const mainPy = readFile('server/main.py');
if (!mainPy) throw new Error('server/main.py 를 읽지 못했습니다.');

// Worker 에서 꺼내 쓸 이름들. 없으면 undefined 로 받아 FAIL 로 보고한다(로드 자체는 깨지지 않게).
const NAMES = [
  'BASE_MODEL', 'DEFAULT_MODEL', 'MODEL_TIERS', 'MAX_PROMPT_CHARS', 'MAX_OUTPUT_TOKENS_CAP',
  'UPSTREAM_TIMEOUT_MS', 'ALLOWED_GEN_CONFIG_KEYS', 'ALLOWED_TOOL_KEYS',
  'upstreamUrl', 'sanitizeGenerationConfig', 'sanitizeTools', 'resolveModel', 'verifyLicense',
  'buildPlan', 'corsHeaders', 'describeUpstreamError', 'coloOf', '__default',
];

// ── 보고 ───────────────────────────────────────────────────────
const lines = [];
let failed = 0;
let total = 0;
let reported = false;
function check(name, ok, detail) {
  total++;
  if (!ok) failed++;
  lines.push((ok ? '  PASS  ' : '  FAIL  ') + name + (!ok && detail !== undefined ? '\n         ' + detail : ''));
}
function section(title) { lines.push(''); lines.push('  [' + title + ']'); }
function safe(name, fn) {
  try { fn(); } catch (e) { check(name + ' — 예외', false, errText(e)); }
}
const J = (v) => JSON.stringify(v);
// JXA 의 e.stack 에는 메시지가 없어(호출 위치만 나온다) 이름·메시지를 직접 붙인다
const errText = (e) => (e && e.message ? (e.name || 'Error') + ': ' + e.message : String(e));

// ── 목(mock): Headers / URL / Request / Response / AbortController / 타이머 ──
function MockHeaders(init) {
  this._m = {};
  if (init instanceof MockHeaders) init = init._m;
  if (init) for (const k of Object.keys(init)) this.set(k, init[k]);
}
MockHeaders.prototype.get = function (k) {
  const v = this._m[String(k).toLowerCase()];
  return v === undefined ? null : v;
};
MockHeaders.prototype.set = function (k, v) { this._m[String(k).toLowerCase()] = String(v); };
MockHeaders.prototype.has = function (k) {
  return Object.prototype.hasOwnProperty.call(this._m, String(k).toLowerCase());
};

// pathname 만 필요하다 (쿼리·해시는 떼어낸다)
function MockURL(u) {
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^\/?#]*([^?#]*)/i.exec(String(u));
  if (!m) throw new TypeError('Invalid URL: ' + u);
  this.href = String(u);
  this.pathname = m[1] || '/';
}

function MockRequest(url, init) {
  init = init || {};
  this.url = String(url);
  this.method = String(init.method || 'GET').toUpperCase();
  this.headers = new MockHeaders(init.headers);
  this._body = init.body === undefined || init.body === null ? '' : String(init.body);
}
MockRequest.prototype.json = function () {
  const b = this._body;
  return new Promise(function (resolve) { resolve(JSON.parse(b)); });  // 파싱 실패는 reject
};

function MockResponse(body, init) {
  init = init || {};
  this.status = init.status === undefined ? 200 : init.status;
  this.ok = this.status >= 200 && this.status < 300;
  this.headers = new MockHeaders(init.headers);
  this._body = body === undefined || body === null ? '' : String(body);
}
MockResponse.prototype.text = function () { return Promise.resolve(this._body); };
MockResponse.prototype.json = function () {
  const b = this._body;
  return new Promise(function (resolve) { resolve(JSON.parse(b)); });
};

function MockAbortController() { this.signal = { aborted: false }; }
MockAbortController.prototype.abort = function () { this.signal.aborted = true; };

// 즉시 반환하는 스텁 — 콜백은 부르지 않는다(타임아웃은 fetch 목이 AbortError 를 던져 흉내 낸다)
let timerDelays = [];
let timerSeq = 0;
function stubSetTimeout(fn, ms) { timerDelays.push(ms); return ++timerSeq; }
function stubClearTimeout() {}

// ── 목: fetch (호출 기록 + 시나리오별 응답) ─────────────────────
let calls = [];
let upstream = null;   // function(call) → { status, body } — 던지면 fetch 가 reject
function lowerHeaders(h) {
  if (!h) return {};
  if (h instanceof MockHeaders) return Object.assign({}, h._m);
  const out = {};
  for (const k of Object.keys(h)) out[k.toLowerCase()] = String(h[k]);
  return out;
}
function mockFetch(url, init) {
  init = init || {};
  let body = null;
  try { body = JSON.parse(init.body); } catch (e) { body = init.body; }
  const call = { url: String(url), init: init, headers: lowerHeaders(init.headers), body: body };
  calls.push(call);
  try {
    const r = upstream(call);
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return Promise.resolve(new MockResponse(text, { status: r.status }));
  } catch (e) {
    return Promise.reject(e);
  }
}

// Worker 의 console.log 를 모은다 (진단 로그에 무엇이 남는지 검사 + 보고서 오염 방지)
let logs = [];
const mockConsole = {
  log: function () { logs.push(Array.prototype.join.call(arguments, ' ')); },
};
mockConsole.warn = mockConsole.log;
mockConsole.error = mockConsole.log;

// ── 순수 JS SHA-256 / HMAC (JXA 에 crypto.subtle 이 없어서) ──────
const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
function sha256(msg) {
  const l = msg.length;
  const n = ((l + 9 + 63) >> 6) << 6;
  const p = new Uint8Array(n);
  p.set(msg);
  p[l] = 0x80;
  const hi = Math.floor((l * 8) / 0x100000000);
  const lo = (l * 8) >>> 0;
  p[n - 8] = hi >>> 24; p[n - 7] = (hi >>> 16) & 255; p[n - 6] = (hi >>> 8) & 255; p[n - 5] = hi & 255;
  p[n - 4] = lo >>> 24; p[n - 3] = (lo >>> 16) & 255; p[n - 2] = (lo >>> 8) & 255; p[n - 1] = lo & 255;
  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Array(64);
  const ror = (x, r) => (x >>> r) | (x << (32 - r));
  for (let off = 0; off < n; off += 64) {
    for (let t = 0; t < 16; t++) {
      const j = off + t * 4;
      w[t] = (p[j] << 24) | (p[j + 1] << 16) | (p[j + 2] << 8) | p[j + 3];
    }
    for (let t = 16; t < 64; t++) {
      const s0 = ror(w[t - 15], 7) ^ ror(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = ror(w[t - 2], 17) ^ ror(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let t = 0; t < 64; t++) {
      const t1 = (h + (ror(e, 6) ^ ror(e, 11) ^ ror(e, 25)) + ((e & f) ^ (~e & g)) + SHA256_K[t] + w[t]) | 0;
      const t2 = ((ror(a, 2) ^ ror(a, 13) ^ ror(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    out[i * 4] = H[i] >>> 24; out[i * 4 + 1] = (H[i] >>> 16) & 255;
    out[i * 4 + 2] = (H[i] >>> 8) & 255; out[i * 4 + 3] = H[i] & 255;
  }
  return out;
}
function hmacSha256Js(key, msg) {
  const kp = new Uint8Array(64);
  kp.set(key.length > 64 ? sha256(key) : key);
  const inner = new Uint8Array(64 + msg.length);
  const outer = new Uint8Array(64 + 32);
  for (let i = 0; i < 64; i++) { inner[i] = kp[i] ^ 0x36; outer[i] = kp[i] ^ 0x5c; }
  inner.set(msg, 64);
  outer.set(sha256(inner), 64);
  return sha256(outer);
}
const toU8 = (x) => (x instanceof Uint8Array ? x : new Uint8Array(x));
const ascii = (s) => new Uint8Array(s.split('').map(ch => ch.charCodeAt(0)));
const hex = (u8) => Array.prototype.map.call(u8, b => (b < 16 ? '0' : '') + b.toString(16)).join('');

// crypto.subtle 의 importKey/sign 만 흉내 낸다. 인자가 Web Crypto 규격과 다르면 reject — 오용을 잡기 위해.
const jsCrypto = {
  subtle: {
    importKey: function (format, keyData, algo, extractable, usages) {
      const hash = algo && (typeof algo.hash === 'string' ? algo.hash : algo.hash && algo.hash.name);
      if (format !== 'raw' || !algo || algo.name !== 'HMAC' || hash !== 'SHA-256' ||
          !Array.isArray(usages) || usages.indexOf('sign') < 0) {
        return Promise.reject(new Error('importKey 인자 오류'));
      }
      return Promise.resolve({ __raw: toU8(keyData) });
    },
    sign: function (algo, key, data) {
      const name = typeof algo === 'string' ? algo : algo && algo.name;
      if (name !== 'HMAC' || !key || !key.__raw) return Promise.reject(new Error('sign 인자 오류'));
      return Promise.resolve(hmacSha256Js(key.__raw, toU8(data)).buffer);
    },
  },
};

let CRYPTO_IMPL = jsCrypto;
let CRYPTO_LABEL = '순수 JS HMAC-SHA256 목';
if (IS_NODE) {
  try {
    const wc = require('crypto').webcrypto;
    if (wc && wc.subtle) { CRYPTO_IMPL = wc; CRYPTO_LABEL = 'node webcrypto (실제 crypto.subtle)'; }
  } catch (e) { /* 오래된 node — 목으로 */ }
}

// ── Worker 로드 ─────────────────────────────────────────────────
function loadWorker(cryptoImpl) {
  const exportsSrc = NAMES.map(n =>
    J(n) + ': (typeof ' + n + " === 'undefined' ? undefined : " + n + ')').join(',\n');
  const factory = new Function(
    'URL', 'Request', 'Response', 'Headers', 'AbortController', 'setTimeout', 'clearTimeout',
    'fetch', 'crypto', 'console',
    MODULE_SRC + '\nreturn {\n' + exportsSrc + '\n};');
  return factory(MockURL, MockRequest, MockResponse, MockHeaders, MockAbortController,
    stubSetTimeout, stubClearTimeout, mockFetch, cryptoImpl, mockConsole);
}

function finish() {
  if (reported) return;
  reported = true;
  lines.push('');
  lines.push(failed === 0 ? '  ✅ ' + total + '개 전부 통과' : '  ❌ ' + total + '개 중 ' + failed + '건 실패');
  lines.push('     (라이선스 HMAC: ' + CRYPTO_LABEL + ')');
  const report = lines.join('\n');
  if (IS_NODE) {
    console.log(report);
    process.exitCode = failed > 0 ? 1 : 0;
    return;
  }
  // osascript: 마이크로태스크 안이라 마지막 표현식으로 돌려줄 수 없다 → stdout 에 직접 쓰고 종료 코드로 알린다
  ObjC.import('Foundation');
  ObjC.import('stdlib');
  $.NSFileHandle.fileHandleWithStandardOutput.writeData($(report + '\n').dataUsingEncoding($.NSUTF8StringEncoding));
  $.exit(failed > 0 ? 1 : 0);
}
if (IS_NODE) {
  process.on('exit', function () {
    if (!reported) { console.log('  ❌ 비동기 검사가 끝나지 않았습니다 (Promise 미완료)'); process.exitCode = 1; }
  });
}

let W = null;    // crypto 있는 Worker
let W0 = null;   // crypto 없는 Worker (JXA 처럼 crypto.subtle 이 없는 환경)
try {
  W = loadWorker(CRYPTO_IMPL);
  W0 = loadWorker(undefined);
} catch (e) {
  section('로드');
  check('proxy/worker.js 를 평가할 수 있음', false, errText(e));
  finish();
}

// 고정 값 — 실제 비밀이 아닌 테스트 전용
const ENV = { GEMINI_API_KEY: 'test-key-not-real-123' };
const ID_OK = 'abcdefghijklmnop' + 'abcdefghijklmnop';     // 32자 a~p
const ORIGIN_OK = 'chrome-extension://' + ID_OK;
const OK_BODY = { candidates: [{ content: { parts: [{ text: '파랑' }] } }], modelVersion: 'mock-model' };

// billing.py 와 같은 식으로 python3 에서 만든 토큰 (secret = LICENSE_SECRET):
//   payload = _b64e(json.dumps({"tier":..,"order":..,"exp":..}, separators=(",",":")).encode())
//   sig     = _b64e(hmac.new(secret, payload.encode(), hashlib.sha256).digest())
const LICENSE_SECRET = 'worker-test-secret';
const TOKEN_PRO = 'eyJ0aWVyIjoicHJvIiwib3JkZXIiOiJULVBSTyIsImV4cCI6NDEwMjQ0NDgwMH0.PWBg2pwNUyJ3NdLkSfClw6tu0sfsZNgURsY0NmYGpT0';
const TOKEN_ENT = 'eyJ0aWVyIjoiZW50ZXJwcmlzZSIsIm9yZGVyIjoiVC1FTlQiLCJleHAiOjQxMDI0NDQ4MDB9.FuYPT29kqWik6D0u0_JgggY7b0yLXtN56wVOCgjsbno';
const TOKEN_EXPIRED = 'eyJ0aWVyIjoicHJvIiwib3JkZXIiOiJULU9MRCIsImV4cCI6MTAwMDAwMDAwMH0.eG4OHoOyk0c85eoSNpXTJHmO1IaNLBmMeq2LC4nB3bE';
const NOW = 1790000000;   // 2026-09 — 결정적인 시각

// Google 오류 본문 (2026-10-08 홍콩 데이터센터에서 실제로 받은 400 과 같은 모양)
const LOC_ERR = { error: { code: 400, message: 'User location is not supported for the API use.', status: 'FAILED_PRECONDITION' } };
const KEY_ERR = { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT',
  details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com' }] } };
const NF_ERR = { error: { code: 404, status: 'NOT_FOUND',
  message: 'models/gemini-9-flash is not found for API version v1beta, or is not supported for generateContent.' } };
// 키 모양 문자열은 실행 중에 이어 붙여 만든다 — 저장소에 'AIzaSy…' 39자 리터럴이 있으면 비밀 스캐너가 진짜 키로 오인한다.
// 'AIzaSy' + 33자 = 실제 Google API 키와 같은 길이. 가짜 값이다.
const FAKE_KEY = 'AIza' + 'Sy' + 'abcdefghijklmnopqrstuvwxyz0123456';

// ══ 동기 검사 ═══════════════════════════════════════════════════
if (W) {
  section('내보낸 이름');
  for (const n of NAMES) check(n + ' 존재', W[n] !== undefined);
  check('__default.fetch 는 함수', !!W.__default && typeof W.__default.fetch === 'function');

  section('정적 검사 — 키가 소스·URL 에 없다');
  // 주석은 설명에 '?key=' 를 적을 수 있으니 빼고 코드만 본다.
  // 줄 주석은 앞이 공백·줄머리인 '//' 만 — 'https://' 의 '//' 까지 지우면 URL 속 key= 를 놓친다.
  const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
  check("코드에 '?key=' / '&key=' / 'key=' 문자열 없음 (키는 헤더로)", !/[?&]key=|['"`]key=/.test(codeOnly));
  check('소스에 API 키 형태(AIza…) 없음', !/AIza[0-9A-Za-z_\-]{20,}/.test(src));
  check('소스가 x-goog-api-key 헤더를 쓴다', src.indexOf("'x-goog-api-key'") >= 0);

  section('main.py 와 같은 계약 (server/main.py 를 읽어 대조)');
  safe('main.py 대조', function () {
    const grab = (re) => { const m = re.exec(mainPy); return m ? m[1] : null; };
    const pyDefault = grab(/^GEMINI_MODEL = .*or "([^"]+)"/m);
    const pyBase = grab(/^BASE_MODEL = "([^"]+)"/m);
    const pyTiersBlock = grab(/^MODEL_TIERS = \{([\s\S]*?)\n\}/m);
    const pyGenBlock = grab(/^ALLOWED_GEN_CONFIG_KEYS = \{([\s\S]*?)\n\}/m);
    const pyToolBlock = grab(/^ALLOWED_TOOL_KEYS = \{([^}]*)\}/m);
    const pyCap = grab(/^MAX_OUTPUT_TOKENS_CAP = _env_int\("[A-Z_]+", ([\d_]+)\)/m);
    const pyMaxPrompt = grab(/^MAX_PROMPT_CHARS = _env_int\("[A-Z_]+", ([\d_]+)\)/m);
    const pyTimeout = grab(/^UPSTREAM_TIMEOUT_S = _env_float\("[A-Z_]+", ([\d.]+)\)/m);
    const quoted = (block) => {
      const out = []; const re = /"([^"]+)"/g; let m;
      while ((m = re.exec(block || ''))) out.push(m[1]);
      return out.sort();
    };
    const pyTiers = {};
    { const re = /"([^"]+)":\s*"([^"]+)"/g; let m; while ((m = re.exec(pyTiersBlock || ''))) pyTiers[m[1]] = m[2]; }
    check('기본 모델 = main.py GEMINI_MODEL 기본값 (' + pyDefault + ')', !!pyDefault && W.DEFAULT_MODEL === pyDefault, 'worker=' + W.DEFAULT_MODEL);
    check('BASE_MODEL = main.py (' + pyBase + ')', !!pyBase && W.BASE_MODEL === pyBase, 'worker=' + W.BASE_MODEL);
    check('MODEL_TIERS = main.py', Object.keys(pyTiers).length === 3 &&
      J(Object.keys(pyTiers).sort().map(k => [k, pyTiers[k]])) === J(Object.keys(W.MODEL_TIERS).sort().map(k => [k, W.MODEL_TIERS[k]])),
      'main.py=' + J(pyTiers) + ' worker=' + J(W.MODEL_TIERS));
    check('ALLOWED_GEN_CONFIG_KEYS = main.py', !!pyGenBlock && J(quoted(pyGenBlock)) === J(W.ALLOWED_GEN_CONFIG_KEYS.slice().sort()),
      'main.py=' + J(quoted(pyGenBlock)) + ' worker=' + J(W.ALLOWED_GEN_CONFIG_KEYS));
    check('허용 tools = main.py (google_search)', !!pyToolBlock && J(quoted(pyToolBlock)) === J(W.ALLOWED_TOOL_KEYS.slice().sort()));
    check('출력 토큰 상한 = main.py 기본 (' + pyCap + ')', !!pyCap && W.MAX_OUTPUT_TOKENS_CAP === Number(pyCap.replace(/_/g, '')));
    check('프롬프트 상한 = main.py 기본 (' + pyMaxPrompt + ')', !!pyMaxPrompt && W.MAX_PROMPT_CHARS === Number(pyMaxPrompt.replace(/_/g, '')));
    check('업스트림 타임아웃 = main.py (' + pyTimeout + 's)', !!pyTimeout && W.UPSTREAM_TIMEOUT_MS === Number(pyTimeout) * 1000);
  });

  section('검사 1 — upstreamUrl');
  safe('upstreamUrl', function () {
    const want = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent';
    check("upstreamUrl('gemini-3.5-flash-lite')", W.upstreamUrl('gemini-3.5-flash-lite') === want, W.upstreamUrl('gemini-3.5-flash-lite'));
    check("'models/' 접두가 와도 두 번 붙지 않음", W.upstreamUrl('models/gemini-2.5-flash') ===
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
    check('URL 에 key 쿼리 없음', W.upstreamUrl(W.BASE_MODEL).indexOf('?') < 0);
  });

  section('검사 6 — sanitizeTools / sanitizeGenerationConfig');
  safe('정화', function () {
    check('tools: google_search 만 남김',
      J(W.sanitizeTools([{ google_search: {} }, { code_execution: {} }])) === J([{ google_search: {} }]));
    check('tools: 허용 키 + 다른 키 섞인 dict 는 버림', J(W.sanitizeTools([{ google_search: {}, code_execution: {} }])) === '[]');
    check('tools: 배열 아님 → []', J(W.sanitizeTools({ google_search: {} })) === '[]' && J(W.sanitizeTools(null)) === '[]');
    check('genCfg: maxOutputTokens 999999 → 4096, evil 제거',
      J(W.sanitizeGenerationConfig({ maxOutputTokens: 999999, evil: 1 })) === J({ maxOutputTokens: 4096 }),
      J(W.sanitizeGenerationConfig({ maxOutputTokens: 999999, evil: 1 })));
    check('genCfg: 허용 키는 유지 (temperature, thinkingConfig)',
      J(W.sanitizeGenerationConfig({ temperature: 0.2, thinkingConfig: { thinkingBudget: 0 }, maxOutputTokens: 100.9 })) ===
      J({ temperature: 0.2, thinkingConfig: { thinkingBudget: 0 }, maxOutputTokens: 100 }));
    check('genCfg: 객체 아님 → {}', J(W.sanitizeGenerationConfig(null)) === '{}' && J(W.sanitizeGenerationConfig([1])) === '{}');
  });

  section('검사 7 — resolveModel');
  safe('resolveModel', function () {
    const D = W.DEFAULT_MODEL;
    const cases = [
      ['gemini-3.7-flash', 'free', D],
      ['gemini-3.7-flash', 'pro', 'gemini-3.7-flash'],
      ['unknown', 'enterprise', D],
      ['gemini-2.5-pro', 'pro', D],
      ['gemini-2.5-pro', 'enterprise', 'gemini-2.5-pro'],
      ['gemini-3.5-flash-lite', 'free', 'gemini-3.5-flash-lite'],
      [undefined, 'enterprise', D],
      ['', 'pro', D],
      ['constructor', 'enterprise', D],          // 프로토타입 이름이 허용목록으로 새지 않게
      ['gemini-3.7-flash', 'bogus-tier', D],     // 모르는 티어 = free
      [{}, 'enterprise', D],
    ];
    for (const [req, tier, want] of cases) {
      const got = W.resolveModel(req, tier);
      check('resolveModel(' + J(req) + ', ' + J(tier) + ') → ' + want, got === want, 'got=' + got);
    }
  });

  section('완화 사다리 계획 — buildPlan');
  safe('buildPlan', function () {
    const plan = W.buildPlan('gemini-3.5-flash-lite',
      { thinkingConfig: { thinkingLevel: 'minimal' }, maxOutputTokens: 100 }, [{ google_search: {} }]);
    check('4단계 (그대로 → thinking 제거 → tools 제거 → 기준 모델)', plan.length === 4, J(plan.map(s => s.why)));
    check('① 그대로', plan[0].why === '' && J(plan[0].cfg.thinkingConfig) === J({ thinkingLevel: 'minimal' }) && plan[0].tools.length === 1);
    check('② thinkingConfig 제거, tools 유지', !('thinkingConfig' in plan[1].cfg) && plan[1].tools.length === 1);
    check('③ tools 제거', plan[2].tools.length === 0 && !('thinkingConfig' in plan[2].cfg));
    check('④ BASE_MODEL + thinkingBudget 0, 나머지 설정 유지', plan[3].model === W.BASE_MODEL &&
      J(plan[3].cfg.thinkingConfig) === J({ thinkingBudget: 0 }) && plan[3].cfg.maxOutputTokens === 100 && plan[3].tools.length === 1);
    const p2 = W.buildPlan('gemini-3.5-flash-lite', {}, []);
    check('thinking·tools 없으면 2단계 (그대로 → 기준 모델)', p2.length === 2 && p2[1].model === W.BASE_MODEL);
    check('요청 모델이 BASE_MODEL 이면 1단계', W.buildPlan(W.BASE_MODEL, {}, []).length === 1);
  });

  section('업스트림 실패 설명 — describeUpstreamError');
  safe('describeUpstreamError', function () {
    const d = W.describeUpstreamError(400, J(LOC_ERR), 'HKG');
    check("location 메시지 + HKG → 'AI 오류 (upstream 400: 지원하지 않는 지역 HKG)'",
      d.error === 'AI 오류 (upstream 400: 지원하지 않는 지역 HKG)', J(d));
    check('location → reason FAILED_PRECONDITION, upstreamStatus 400, colo HKG',
      d.reason === 'FAILED_PRECONDITION' && d.upstreamStatus === 400 && d.colo === 'HKG', J(d));
    check('location → detail = Google message 그대로(짧아서 안 잘림)', d.detail === LOC_ERR.error.message, J(d.detail));
    const dq = W.describeUpstreamError(400, J(LOC_ERR), null);
    check("colo 모름 → '지원하지 않는 지역 ?', colo null", dq.error === 'AI 오류 (upstream 400: 지원하지 않는 지역 ?)' && dq.colo === null, J(dq));

    const k = W.describeUpstreamError(400, J(KEY_ERR), 'ICN');
    check("API key not valid → 'AI 오류 (upstream 400: API 키가 올바르지 않음)'", k.error === 'AI 오류 (upstream 400: API 키가 올바르지 않음)', J(k));
    check('API key not valid → reason INVALID_ARGUMENT', k.reason === 'INVALID_ARGUMENT', J(k));
    check('details 필드(ErrorInfo 등)는 결과에 없음', J(k).indexOf('googleapis.com') < 0 && J(k).indexOf('@type') < 0, J(k));

    const n = W.describeUpstreamError(404, J(NF_ERR), 'ICN');
    check("404 not found → 'AI 오류 (upstream 404: 모델을 찾을 수 없음)'", n.error === 'AI 오류 (upstream 404: 모델을 찾을 수 없음)', J(n));
    const n400 = W.describeUpstreamError(400, J(NF_ERR), 'ICN');
    check("'not found' 라도 400 이면 모델 문구 아님 (reason 으로)", n400.error === 'AI 오류 (upstream 400: NOT_FOUND)', J(n400));

    const q = W.describeUpstreamError(429, J({ error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' } }), 'ICN');
    check("그 외 reason 있음 → 'AI 오류 (upstream 429: RESOURCE_EXHAUSTED)'", q.error === 'AI 오류 (upstream 429: RESOURCE_EXHAUSTED)', J(q));

    const h = W.describeUpstreamError(500, '<html>Bad Gateway</html>', 'HKG');
    check("JSON 아님 → reason null·detail null·기존 문구 'AI 오류 (upstream 500)'",
      h.error === 'AI 오류 (upstream 500)' && h.reason === null && h.detail === null && h.upstreamStatus === 500, J(h));
    const s = W.describeUpstreamError(400, J({ error: 'bad' }), null);
    check("error 가 문자열인 JSON → reason null·detail null·'AI 오류 (upstream 400)'",
      s.error === 'AI 오류 (upstream 400)' && s.reason === null && s.detail === null, J(s));
    const e0 = W.describeUpstreamError(503, '', null);
    check("빈 본문 → 'AI 오류 (upstream 503)'", e0.error === 'AI 오류 (upstream 503)' && e0.reason === null && e0.detail === null, J(e0));
    check('본문이 문자열 아님(undefined) → 예외 없이 기존 문구', W.describeUpstreamError(400, undefined, null).error === 'AI 오류 (upstream 400)');

    const m = W.describeUpstreamError(400, J({ error: { message: 'bad key ' + FAKE_KEY + ' here', status: 'INVALID_ARGUMENT' } }), null);
    check("메시지 속 'AIzaSy'+33자 → '<KEY>' 로 가려짐", m.detail === 'bad key <KEY> here' && J(m).indexOf(FAKE_KEY) < 0 && J(m).indexOf('AIza') < 0, J(m));
    // 가리기 → 자르기 순서 검사: 먼저 자르면 150자 뒤의 키 앞 9자('AIzaSyabc')가 정규식(15자 이상)에 안 걸려 남는다
    const mb = W.describeUpstreamError(400, J({ error: { message: 'y'.repeat(150) + FAKE_KEY + 'z'.repeat(20) } }), null);
    check('160자 경계에 걸친 키도 남지 않음 (가린 뒤에 자른다)', !!mb.detail && mb.detail.indexOf('AIza') < 0, J(mb.detail));

    const longMsg = 'x'.repeat(500);
    const L = W.describeUpstreamError(400, J({ error: { message: longMsg, status: 'INVALID_ARGUMENT' } }), null);
    check('160자 초과 메시지 → 160자 이내로 잘림', typeof L.detail === 'string' && L.detail.length <= 160 && L.detail.length >= 150 &&
      L.detail.indexOf('x'.repeat(150)) === 0, L.detail && L.detail.length);
    check('잘린 결과에 원문 500자 전체는 없음', J(L).indexOf(longMsg) < 0);
    const em = W.describeUpstreamError(400, J({ error: { message: 'x'.repeat(158) + '😀😀' } }), null);
    check('서로게이트 쌍 가운데서 자르지 않음', !!em.detail && em.detail.length <= 160 && !/[\ud800-\udbff]…$/.test(em.detail), J(em.detail));

    const bad = W.describeUpstreamError(400, J({ error: { message: 'm', status: 'evil <b>status</b>' } }), '<b>');
    check('status 가 enum 모양이 아니면 reason null, colo 모양이 이상하면 null', bad.reason === null && bad.colo === null &&
      bad.error === 'AI 오류 (upstream 400)', J(bad));
    check('error 문구는 짧다 (사이드바 100자 자르기 안쪽)', [d, k, n, q, h].every(x => x.error.length <= 60), J([d, k, n, q, h].map(x => x.error.length)));
  });

  section('coloOf');
  safe('coloOf', function () {
    check("request.cf = { colo: 'ICN' } → 'ICN'", W.coloOf({ cf: { colo: 'ICN' } }) === 'ICN');
    check('request.cf 없음 → null', W.coloOf({}) === null && W.coloOf(null) === null);
    check('colo 가 문자열 아님·이상한 모양 → null', W.coloOf({ cf: { colo: 7 } }) === null && W.coloOf({ cf: { colo: 'HK G' } }) === null);
  });

  section('proxy/wrangler.toml 정적 검사');
  safe('wrangler.toml', function () {
    let toml = null;
    try { toml = readFile('proxy/wrangler.toml'); } catch (e) { toml = null; }
    check('proxy/wrangler.toml 이 있음', typeof toml === 'string' && toml.length > 0);
    const t = String(toml || '');
    const noComments = t.replace(/(^|\s)#.*$/gm, '$1');
    check('name = "shomate-proxy", main = "worker.js"', /^name\s*=\s*"shomate-proxy"\s*$/m.test(noComments) && /^main\s*=\s*"worker\.js"\s*$/m.test(noComments));
    check('[placement] 블록이 있고 region 은 "<공급자>:<리전>" 형식',
      /^\[placement\]\s*$/m.test(noComments) && /^region\s*=\s*"(aws|gcp|azure):[a-z0-9-]+"\s*$/m.test(noComments));
    check('[observability] enabled = true', /^\[observability\]\s*$/m.test(noComments) && /^enabled\s*=\s*true\s*$/m.test(noComments));
    check('시크릿 값 없음 (AIza… 키 모양·GEMINI_API_KEY 대입·[vars] 의 키 없음)',
      !/AIza[0-9A-Za-z_-]{10,}/.test(t) && !/^\s*(GEMINI_API_KEY|SHOMATE_LICENSE_SECRET)\s*=/m.test(noComments));
  });

  section('테스트용 HMAC 목 자체 검증 (RFC 4231 / FIPS 180-2 벡터)');
  check("sha256('abc')", hex(sha256(ascii('abc'))) === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  check('HMAC-SHA256 RFC 4231 #2', hex(hmacSha256Js(ascii('Jefe'), ascii('what do ya want for nothing?'))) ===
    '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
}

// ══ 비동기 검사 (핸들러 호출) ═══════════════════════════════════
async function call(Wi, method, path, opts) {
  opts = opts || {};
  const headers = {};
  if (opts.origin) headers['Origin'] = opts.origin;
  let body;
  if (opts.raw !== undefined) body = opts.raw;
  else if (opts.json !== undefined) { body = J(opts.json); headers['Content-Type'] = 'application/json'; }
  const req = new MockRequest('https://shomate-proxy.test.workers.dev' + path, { method: method, headers: headers, body: body });
  // 실제 Workers 는 런타임이 request.cf(colo 등)를 채운다. 목에서는 opts.cf 로 넣고, 없으면 cf 자체가 없다.
  if (opts.cf !== undefined) req.cf = opts.cf;
  const res = await Wi.__default.fetch(req, opts.env === undefined ? ENV : opts.env, { waitUntil: function () {} });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* 본문 없음(204) 등 */ }
  return { status: res.status, headers: res.headers, text: text, json: json };
}
async function vl(Wi, token, secret, now) {
  try { return await Wi.verifyLicense(token, secret, now); } catch (e) { return 'THREW: ' + e.message; }
}
const ok200 = () => ({ status: 200, body: OK_BODY });
const LADDER_REQ = {
  prompt: '테스트',
  generationConfig: { thinkingConfig: { thinkingLevel: 'minimal' }, maxOutputTokens: 100 },
  tools: [{ google_search: {} }],
};

const SCENARIOS = [];
function scenario(title, fn) { SCENARIOS.push({ title: title, fn: fn }); }

scenario('검사 2 — 정상 요청: URL 에 키 없음, x-goog-api-key 헤더', async function () {
  upstream = ok200;
  const r = await call(W, 'POST', '/gemini', { json: { prompt: '안녕' }, origin: ORIGIN_OK });
  check('200', r.status === 200, 'status=' + r.status + ' body=' + r.text);
  check('업스트림 JSON 그대로', J(r.json) === J(OK_BODY));
  check('업스트림 1회 호출', calls.length === 1, 'calls=' + calls.length);
  const c = calls[0] || { url: '', headers: {}, init: {}, body: {} };
  check("URL 에 'key=' 없음", c.url.indexOf('key=') < 0, c.url);
  check('URL 에 키 문자열 없음', c.url.indexOf(ENV.GEMINI_API_KEY) < 0);
  check('x-goog-api-key = env 키', c.headers['x-goog-api-key'] === ENV.GEMINI_API_KEY, J(c.headers));
  check('모델 미지정 → 기본 모델 URL', c.url === W.upstreamUrl(W.DEFAULT_MODEL), c.url);
  check('POST + contents[0].parts[0].text', c.init.method === 'POST' && !!c.body && c.body.contents[0].parts[0].text === '안녕');
  check('빈 generationConfig/tools 는 본문에서 생략', !('generationConfig' in c.body) && !('tools' in c.body), J(c.body));
  check('Content-Type: application/json; charset=utf-8', r.headers.get('content-type') === 'application/json; charset=utf-8');
  check('응답에 ACAO 반사', r.headers.get('access-control-allow-origin') === ORIGIN_OK);
  check('업스트림 타임아웃 타이머 30000ms', timerDelays.indexOf(30000) >= 0, J(timerDelays));
});

scenario('검사 6 — 정화가 실제 업스트림 본문에 반영', async function () {
  upstream = ok200;
  await call(W, 'POST', '/gemini', { json: {
    prompt: 'x',
    generationConfig: { maxOutputTokens: 999999, evil: 1, temperature: 0.2 },
    tools: [{ google_search: {} }, { code_execution: {} }],
  } });
  const b = (calls[0] || {}).body || {};
  check('generationConfig = {maxOutputTokens:4096, temperature:0.2}', J(b.generationConfig) === J({ maxOutputTokens: 4096, temperature: 0.2 }), J(b.generationConfig));
  check('tools = [google_search]', J(b.tools) === J([{ google_search: {} }]), J(b.tools));
});

scenario('검사 3 — GET /health', async function () {
  const a = await call(W, 'GET', '/health');
  check('키 있음 → 200 ok:true model=BASE_MODEL', a.status === 200 && a.json && a.json.ok === true && a.json.model === W.BASE_MODEL, a.status + ' ' + a.text);
  const q = await call(W, 'GET', '/health?x=2');
  check('쿼리스트링이 붙어도 200', q.status === 200 && q.json && q.json.ok === true, q.status + ' ' + q.text);
  const b = await call(W, 'GET', '/health', { env: {} });
  check('키 없음 → 503 ok:false', b.status === 503 && b.json && b.json.ok === false && b.json.error === 'GEMINI_API_KEY 미설정', b.status + ' ' + b.text);
  const c = await call(W, 'GET', '/health', { env: { GEMINI_API_KEY: '   ' } });
  check('키가 공백뿐 → 503', c.status === 503);
  const d = await call(W, 'GET', '/health', { env: null });
  check('env 자체가 없음 → 503 (예외 아님)', d.status === 503);
  // colo: 지금 어느 데이터센터가 요청을 받았는지 curl 한 번으로 보이게 (지역 문제 진단)
  check('cf 없음 → colo 필드가 있고 null', !!a.json && Object.prototype.hasOwnProperty.call(a.json, 'colo') && a.json.colo === null, a.text);
  const icn = await call(W, 'GET', '/health', { cf: { colo: 'ICN' } });
  check("request.cf = { colo: 'ICN' } → colo 'ICN'", icn.status === 200 && !!icn.json && icn.json.colo === 'ICN', icn.text);
  const hkg503 = await call(W, 'GET', '/health', { env: {}, cf: { colo: 'HKG' } });
  check("키 없음(503)에도 colo 'HKG'", hkg503.status === 503 && !!hkg503.json && hkg503.json.colo === 'HKG', hkg503.text);
  check('health 응답에 키 문자열 없음', [a, icn].every(x => x.text.indexOf(ENV.GEMINI_API_KEY) < 0));
  check('health 는 업스트림을 부르지 않음', calls.length === 0);
});

scenario('검사 4 — CORS', async function () {
  const a = await call(W, 'OPTIONS', '/gemini', { origin: ORIGIN_OK });
  check('허용 오리진 OPTIONS → 2xx', a.status === 204 || a.status === 200, 'status=' + a.status);
  check('ACAO 반사', a.headers.get('access-control-allow-origin') === ORIGIN_OK);
  check('Allow-Methods / Allow-Headers / Max-Age / Vary',
    a.headers.get('access-control-allow-methods') === 'GET, POST, OPTIONS' &&
    a.headers.get('access-control-allow-headers') === 'Content-Type' &&
    a.headers.get('access-control-max-age') === '86400' && a.headers.get('vary') === 'Origin');
  const bad = [
    ['https://evil.com', 'https://evil.com'],
    ['q~z 문자(확장 ID 에 없음)', 'chrome-extension://' + 'z'.repeat(32)],
    ['31자', 'chrome-extension://' + 'a'.repeat(31)],
    ['대문자', 'chrome-extension://' + ID_OK.toUpperCase()],
    ['뒤에 경로', ORIGIN_OK + '/x'],
    ['null 오리진', 'null'],
  ];
  for (const [name, origin] of bad) {
    const r = await call(W, 'OPTIONS', '/gemini', { origin: origin });
    check('거부: ' + name + ' → ACAO 없음', !r.headers.has('access-control-allow-origin'), r.headers.get('access-control-allow-origin'));
  }
  const envIds = { GEMINI_API_KEY: ENV.GEMINI_API_KEY, ALLOWED_EXTENSION_IDS: ' ' + ID_OK + ' , ' + 'b'.repeat(32) };
  const inList = await call(W, 'OPTIONS', '/gemini', { origin: ORIGIN_OK, env: envIds });
  check('ALLOWED_EXTENSION_IDS 목록 안 → 반사', inList.headers.get('access-control-allow-origin') === ORIGIN_OK);
  const notInList = await call(W, 'OPTIONS', '/gemini', { origin: 'chrome-extension://' + 'p'.repeat(32), env: envIds });
  check('ALLOWED_EXTENSION_IDS 목록 밖 → ACAO 없음', !notInList.headers.has('access-control-allow-origin'));
  const errEvil = await call(W, 'GET', '/nope', { origin: 'https://evil.com' });
  check('오류 응답에도 evil 오리진엔 ACAO 없음', !errEvil.headers.has('access-control-allow-origin'));
  check('OPTIONS 는 업스트림을 부르지 않음', calls.length === 0);
});

scenario('검사 5 — POST /gemini 입력 검증', async function () {
  upstream = ok200;
  const a = await call(W, 'POST', '/gemini', { json: {} });
  check('본문 {} → 400 "prompt 가 필요합니다"', a.status === 400 && a.json && a.json.error === 'prompt 가 필요합니다', a.status + ' ' + a.text);
  const b = await call(W, 'POST', '/gemini', { raw: 'not json' });
  check('JSON 아님 → 400', b.status === 400, b.status + ' ' + b.text);
  for (const [name, body] of [['빈 문자열', { prompt: '' }], ['숫자', { prompt: 123 }], ['배열 본문', ['x']], ['null 본문', null]]) {
    const r = await call(W, 'POST', '/gemini', { json: body });
    check('prompt ' + name + ' → 400', r.status === 400, r.status + ' ' + r.text);
  }
  const long = await call(W, 'POST', '/gemini', { json: { prompt: 'a'.repeat(20001) } });
  check('prompt 20001자 → 413', long.status === 413 && /20001자/.test(long.text), long.status + ' ' + long.text);
  const noKey = await call(W, 'POST', '/gemini', { json: { prompt: 'hi' }, env: {} });
  check('키 없음 → 503', noKey.status === 503, noKey.status + ' ' + noKey.text);
  check('위 거절들은 업스트림을 부르지 않음', calls.length === 0, 'calls=' + calls.length);

  const edge = await call(W, 'POST', '/gemini', { json: { prompt: 'a'.repeat(20000) } });
  check('경계: 정확히 20000자 → 통과(200)', edge.status === 200, edge.status + ' ' + edge.text);
  const emoji = await call(W, 'POST', '/gemini', { json: { prompt: '😀'.repeat(10001) } });
  check('이모지 10001개(UTF-16 20002) → 코드포인트로 세어 통과 (Python len 과 같음)', emoji.status === 200, emoji.status + ' ' + emoji.text);
  const envMax = { GEMINI_API_KEY: ENV.GEMINI_API_KEY, MAX_PROMPT_CHARS: '10' };
  const c = await call(W, 'POST', '/gemini', { json: { prompt: 'a'.repeat(11) }, env: envMax });
  check('env.MAX_PROMPT_CHARS=10 → 11자 413', c.status === 413, c.status + ' ' + c.text);
  const d = await call(W, 'POST', '/gemini', { json: { prompt: 'a'.repeat(11) }, env: { GEMINI_API_KEY: ENV.GEMINI_API_KEY, MAX_PROMPT_CHARS: 'abc' } });
  check('env.MAX_PROMPT_CHARS 가 숫자 아님 → 기본값(20000) 적용', d.status === 200, d.status + ' ' + d.text);
});

scenario('검사 8 — 완화 사다리: 요청 모델 404 → 기준 모델 200', async function () {
  upstream = (c) => (c.url === W.upstreamUrl(W.BASE_MODEL) ? { status: 200, body: OK_BODY } : { status: 404, body: { error: { code: 404 } } });
  const r = await call(W, 'POST', '/gemini', { json: LADDER_REQ });
  check('최종 200', r.status === 200, r.status + ' ' + r.text);
  check('호출 2회 (404 난 모델은 thinking/tools 완화 단계를 건너뜀)', calls.length === 2, J(calls.map(c => c.url)));
  check('1회차 = 요청 모델', !!calls[0] && calls[0].url === W.upstreamUrl(W.DEFAULT_MODEL));
  check('2회차 URL 에 BASE_MODEL', !!calls[1] && calls[1].url.indexOf(W.BASE_MODEL + ':generateContent') >= 0, calls[1] && calls[1].url);
  check('2회차: thinkingBudget 0 + maxOutputTokens 유지 + tools 유지', !!calls[1] &&
    J(calls[1].body.generationConfig) === J({ maxOutputTokens: 100, thinkingConfig: { thinkingBudget: 0 } }) &&
    J(calls[1].body.tools) === J([{ google_search: {} }]), calls[1] && J(calls[1].body));
});

scenario('검사 8 — 완화 사다리: 401 이면 1회 호출 후 중단', async function () {
  upstream = () => ({ status: 401, body: { error: 'unauthorized' } });
  const r = await call(W, 'POST', '/gemini', { json: LADDER_REQ });
  check('502 "AI 오류 (upstream 401)"', r.status === 502 && r.json && r.json.error === 'AI 오류 (upstream 401)', r.status + ' ' + r.text);
  check('호출 1회', calls.length === 1, 'calls=' + calls.length);
  for (const st of [403, 429, 503]) {
    calls = [];
    upstream = () => ({ status: st, body: {} });
    const x = await call(W, 'POST', '/gemini', { json: LADDER_REQ });
    check(st + ' → 1회 호출 후 502', calls.length === 1 && x.status === 502 && x.json.error === 'AI 오류 (upstream ' + st + ')', calls.length + ' ' + x.text);
  }
});

scenario('완화 사다리: 계속 400 이면 네 단계를 모두 시도', async function () {
  upstream = () => ({ status: 400, body: { error: 'bad' } });
  const r = await call(W, 'POST', '/gemini', { json: LADDER_REQ });
  check('최종 502 "AI 오류 (upstream 400)"', r.status === 502 && r.json && r.json.error === 'AI 오류 (upstream 400)', r.text);
  check('호출 4회', calls.length === 4, 'calls=' + calls.length);
  if (calls.length === 4) {
    check('① thinkingConfig·tools 그대로', !!calls[0].body.generationConfig.thinkingConfig && !!calls[0].body.tools);
    check('② thinkingConfig 제거, tools 유지', !('thinkingConfig' in calls[1].body.generationConfig) && !!calls[1].body.tools);
    check('③ tools 제거', !('tools' in calls[2].body));
    check('④ BASE_MODEL', calls[3].url === W.upstreamUrl(W.BASE_MODEL));
  }
});

scenario('검사 9 — 업스트림 500: 원문 본문 전체를 응답에 싣지 않음', async function () {
  // 이제 Google message 는 정리해서 detail 로 싣는다(원인 구분용). 그래도 원문 본문 '전체'는 싣지 않는다는 뜻은 유지한다:
  // 원문 그대로도, JSON 문자열 안에 이스케이프되어 들어간 모양도 응답에 없어야 한다.
  const RAW = '{"error":{"message":"UPSTREAM-INTERNAL-DETAIL"}}';
  upstream = () => ({ status: 500, body: RAW });
  const r = await call(W, 'POST', '/gemini', { json: LADDER_REQ });
  check('502 "AI 오류 (upstream 500)"', r.status === 502 && r.json && r.json.error === 'AI 오류 (upstream 500)', r.text);
  check('응답에 업스트림 원문 본문 전체 없음 (그대로·이스케이프 모두)',
    r.text.indexOf(RAW) < 0 && r.text.indexOf(J(RAW).slice(1, -1)) < 0, r.text);
  check('응답은 정해진 필드만 (error, upstreamStatus, reason, detail, colo)', !!r.json &&
    J(Object.keys(r.json).sort()) === J(['colo', 'detail', 'error', 'reason', 'upstreamStatus']), r.text);
  check('upstreamStatus 500, reason null (status 없음), detail = message', !!r.json && r.json.upstreamStatus === 500 &&
    r.json.reason === null && r.json.detail === 'UPSTREAM-INTERNAL-DETAIL', r.text);
  check('호출 1회 (5xx 는 즉시 중단)', calls.length === 1);
  check('console.log 에는 남음 (wrangler tail 진단용)', logs.some(l => l.indexOf('UPSTREAM-INTERNAL-DETAIL') >= 0), J(logs));
  check('로그에 API 키 없음', !logs.some(l => l.indexOf(ENV.GEMINI_API_KEY) >= 0));
});

scenario('지원하지 않는 지역 — 모든 단계가 400 location 이면 원인을 응답에', async function () {
  // 2026-10-08 실측: HKG 데이터센터에서 실행되면 Gemini 가 모든 모델·설정에 같은 400 을 낸다.
  // details 의 표식은 status·message 밖의 필드가 응답에 새지 않는지 보려고 넣었다.
  const body = { error: Object.assign({}, LOC_ERR.error, { details: [{ debug: 'LOC-PRIVATE-DETAILS-FIELD' }] }) };
  const RAW = J(body);
  upstream = () => ({ status: 400, body: RAW });
  const r = await call(W, 'POST', '/gemini', { json: LADDER_REQ, cf: { colo: 'HKG' }, origin: ORIGIN_OK });
  check('502', r.status === 502, r.status + ' ' + r.text);
  check("body.error 가 'AI 오류 (upstream 400' 로 시작 (확장의 기존 파싱과 호환)", !!r.json && typeof r.json.error === 'string' &&
    r.json.error.indexOf('AI 오류 (upstream 400') === 0, r.text);
  check("body.error 에 '지원하지 않는 지역 HKG'", !!r.json && r.json.error.indexOf('지원하지 않는 지역 HKG') >= 0, r.text);
  check("body.reason === 'FAILED_PRECONDITION', upstreamStatus 400, colo 'HKG'", !!r.json &&
    r.json.reason === 'FAILED_PRECONDITION' && r.json.upstreamStatus === 400 && r.json.colo === 'HKG', r.text);
  check('원문 JSON 문자열 전체는 응답에 없음 (그대로·이스케이프 모두)', r.text.indexOf(RAW) < 0 && r.text.indexOf(J(RAW).slice(1, -1)) < 0, r.text);
  check('details 필드 값은 응답에 없음', r.text.indexOf('LOC-PRIVATE-DETAILS-FIELD') < 0, r.text);
  check('400 이라 사다리 네 단계를 모두 시도', calls.length === 4, 'calls=' + calls.length);
  check('오류 응답에도 ACAO 반사', r.headers.get('access-control-allow-origin') === ORIGIN_OK);
  check('로그에는 원문과 colo 가 남음 (진단용)', logs.some(l => l.indexOf('LOC-PRIVATE-DETAILS-FIELD') >= 0 && l.indexOf('HKG') >= 0), J(logs));
  check('로그·응답에 API 키 없음', !logs.some(l => l.indexOf(ENV.GEMINI_API_KEY) >= 0) && r.text.indexOf(ENV.GEMINI_API_KEY) < 0);

  calls = [];
  const q = await call(W, 'POST', '/gemini', { json: { prompt: 'x' } });
  check("cf 없음 → colo null, '지원하지 않는 지역 ?'", q.status === 502 && !!q.json && q.json.colo === null &&
    q.json.error === 'AI 오류 (upstream 400: 지원하지 않는 지역 ?)', q.text);
});

scenario('API 키 오류 — 원인이 응답에 보임', async function () {
  upstream = () => ({ status: 400, body: KEY_ERR });
  const r = await call(W, 'POST', '/gemini', { json: { prompt: 'x' }, cf: { colo: 'ICN' } });
  check("502 'AI 오류 (upstream 400: API 키가 올바르지 않음)'", r.status === 502 && !!r.json &&
    r.json.error === 'AI 오류 (upstream 400: API 키가 올바르지 않음)', r.text);
  check('reason INVALID_ARGUMENT, colo ICN', !!r.json && r.json.reason === 'INVALID_ARGUMENT' && r.json.colo === 'ICN', r.text);
});

scenario('업스트림 타임아웃·네트워크 오류·형식 오류', async function () {
  upstream = () => { const e = new Error('The operation was aborted'); e.name = 'AbortError'; throw e; };
  const a = await call(W, 'POST', '/gemini', { json: { prompt: 'x' } });
  check('AbortError → 504 "AI 응답 시간 초과"', a.status === 504 && a.json && a.json.error === 'AI 응답 시간 초과', a.status + ' ' + a.text);
  upstream = () => { throw new TypeError('fetch failed'); };
  const b = await call(W, 'POST', '/gemini', { json: { prompt: 'x' } });
  check('네트워크 예외 → 502 "AI 호출 실패"', b.status === 502 && b.json && b.json.error === 'AI 호출 실패', b.status + ' ' + b.text);
  upstream = () => ({ status: 200, body: '<html>not json</html>' });
  const c = await call(W, 'POST', '/gemini', { json: { prompt: 'x' } });
  check('업스트림 200 인데 JSON 아님 → 502', c.status === 502 && !!c.json && typeof c.json.error === 'string', c.status + ' ' + c.text);
});

scenario('라우팅', async function () {
  const a = await call(W, 'GET', '/nope', { origin: ORIGIN_OK });
  check('없는 경로 → 404 "없는 경로입니다"', a.status === 404 && a.json && a.json.error === '없는 경로입니다', a.status + ' ' + a.text);
  check('404 에도 JSON Content-Type + ACAO', a.headers.get('content-type') === 'application/json; charset=utf-8' &&
    a.headers.get('access-control-allow-origin') === ORIGIN_OK);
  const b = await call(W, 'POST', '/billing/status');
  check('/billing/* 는 없다 → 404', b.status === 404);
  const c = await call(W, 'GET', '/gemini');
  check('GET /gemini → 405', c.status === 405, c.status + ' ' + c.text);
  check('라우팅 검사는 업스트림을 부르지 않음', calls.length === 0);
});

scenario('라이선스 → 모델 (핸들러 경유)', async function () {
  upstream = ok200;
  const envL = { GEMINI_API_KEY: ENV.GEMINI_API_KEY, SHOMATE_LICENSE_SECRET: LICENSE_SECRET };
  const cases = [
    ['pro 토큰 + 3.7-flash → 3.7-flash', envL, { model: 'gemini-3.7-flash', license: TOKEN_PRO }, 'gemini-3.7-flash'],
    ['enterprise 토큰 + 2.5-pro → 2.5-pro', envL, { model: 'gemini-2.5-pro', license: TOKEN_ENT }, 'gemini-2.5-pro'],
    ['pro 토큰 + 2.5-pro → 기본 모델', envL, { model: 'gemini-2.5-pro', license: TOKEN_PRO }, W.DEFAULT_MODEL],
    ['토큰 없음 + 3.7-flash → 기본 모델', envL, { model: 'gemini-3.7-flash' }, W.DEFAULT_MODEL],
    ['만료 토큰 → 기본 모델', envL, { model: 'gemini-3.7-flash', license: TOKEN_EXPIRED }, W.DEFAULT_MODEL],
    ['서버에 서명 키 없음 → 기본 모델', ENV, { model: 'gemini-3.7-flash', license: TOKEN_PRO }, W.DEFAULT_MODEL],
  ];
  for (const [name, env, extra, wantModel] of cases) {
    calls = [];
    const r = await call(W, 'POST', '/gemini', { json: Object.assign({ prompt: 'x' }, extra), env: env });
    const url = calls[0] ? calls[0].url : '(호출 없음)';
    check(name, r.status === 200 && url === W.upstreamUrl(wantModel), r.status + ' ' + url);
  }
});

scenario('검사 10 — verifyLicense', async function () {
  check('secret 없음 → free', (await vl(W, TOKEN_PRO, undefined, NOW)) === 'free');
  check('secret 빈 문자열 → free', (await vl(W, TOKEN_PRO, '  ', NOW)) === 'free');
  check('crypto 없음 + 형식 깨짐(점 없음) → free, 예외 없음', (await vl(W0, 'garbage', LICENSE_SECRET, NOW)) === 'free');
  check('crypto 없음 + 형식 맞는 토큰 → free, 예외 없음', (await vl(W0, TOKEN_PRO, LICENSE_SECRET, NOW)) === 'free');
  for (const [name, tok] of [['null', null], ['숫자', 123], ['객체', {}], ['빈 문자열', ''], ['점만', '.'], ['형식 깨짐', 'a.b']]) {
    check('토큰 ' + name + ' → free', (await vl(W, tok, LICENSE_SECRET, NOW)) === 'free');
  }
  check('유효한 pro 토큰 → pro', (await vl(W, TOKEN_PRO, LICENSE_SECRET, NOW)) === 'pro', await vl(W, TOKEN_PRO, LICENSE_SECRET, NOW));
  check("유효한 enterprise 토큰 → enterprise ('_' 포함 서명)", (await vl(W, TOKEN_ENT, LICENSE_SECRET, NOW)) === 'enterprise');
  check('secret 앞뒤 공백·줄바꿈은 무시 (billing.py strip 과 같음)', (await vl(W, TOKEN_PRO, '  ' + LICENSE_SECRET + '\n', NOW)) === 'pro');
  const lastCh = TOKEN_PRO.slice(-1);
  check('서명 한 글자 변조 → free', (await vl(W, TOKEN_PRO.slice(0, -1) + (lastCh === 'A' ? 'B' : 'A'), LICENSE_SECRET, NOW)) === 'free');
  check('다른 secret → free', (await vl(W, TOKEN_PRO, 'other-secret', NOW)) === 'free');
  check('만료 토큰 → free', (await vl(W, TOKEN_EXPIRED, LICENSE_SECRET, NOW)) === 'free');
  check('만료 시각 이후 → free', (await vl(W, TOKEN_PRO, LICENSE_SECRET, 4102444801)) === 'free');
  const forgedPayload = TOKEN_ENT.split('.')[0] + '.' + TOKEN_PRO.split('.')[1];
  check('본문만 바꿔치기 → free', (await vl(W, forgedPayload, LICENSE_SECRET, NOW)) === 'free');
  check('뒤에 덧붙인 토큰 → free', (await vl(W, TOKEN_PRO + '.x', LICENSE_SECRET, NOW)) === 'free');
});

async function runScenarios() {
  for (const s of SCENARIOS) {
    section(s.title);
    calls = [];
    logs = [];
    timerDelays = [];
    upstream = () => { throw new Error('이 시나리오에서는 업스트림을 부르면 안 됩니다'); };
    try {
      await s.fn();
    } catch (e) {
      check('시나리오가 예외 없이 끝남', false, errText(e));
    }
  }
}

if (W && !reported) {
  runScenarios().then(finish, function (e) {
    check('비동기 검사 실행', false, errText(e));
    finish();
  });
}

// 정상이라면 finish() 의 $.exit 로 여기까지 오지 않는다. 여기 왔다면 비동기 검사가 끝나지 않은 것이다.
// 문자열만 출력하면 osascript 가 종료 코드 0 으로 끝나 run-all.sh 가 통과로 보므로, 예외로 실패 처리한다.
if (!IS_NODE) throw new Error('비동기 검사 결과가 출력되지 않았습니다 — 핸들러 Promise 가 끝나지 않았습니다.');
