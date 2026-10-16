/**
 * 카테고리 검색 3축 순위 테스트 (background.js)
 *
 * background.js 의 카테고리 순위 함수들을 실제 소스에서 잘라내 실행한다. 로직을 복붙해 검증하면 원본이 바뀌어도
 * 테스트가 통과해버리므로 원본을 직접 읽는다. 잘라내는 구간(마커):
 *   A. 'function parseSpec(text) {'                    ~ 'async function getNaverCreds'      (규격 파서)
 *   B. '// ── 상품 추천 (A안'                           ~ "// 탭이 'complete' 가 될 때까지"   (상수·buildSearchQuery·validateDetailUrl 등)
 *   C. "// 탭이 'complete' 가 될 때까지"                ~ 'async function getRecWeights'      (waitTabComplete·collectViaBackgroundTab)
 *   D. '// ── 카테고리 순위 (계약 3~5장) — 순수 함수'   ~ '// 네이버 쇼핑 검색 API 는 2026-07-31 종료'
 *      (순수 함수 + 저장소·탭·오케스트레이터. chrome.* 는 아래 목(mock)으로 주입한다)
 *
 * 픽스처: 2026-10-16 쿠팡 '고양이 이동장 백팩' 검색 페이지 실측 상위 10개 카드 값(광고 5 + 일반 5).
 *
 * JXA(osascript)에는 URL/URLSearchParams/setTimeout/AbortController 가 없어 최소 목을 주입한다(node 에서는 진짜 URL 을 쓴다).
 * 비동기 검사(탭 수집 in-flight·오케스트레이터)는 Promise 체인으로 돌리고, 끝에서 보고서를 stdout 에 쓰고 종료 코드를 정한다
 * (tests/worker.test.js 와 같은 방식).
 *
 * 실행 (저장소 루트에서):
 *   node tests/category-rank.test.js
 *   osascript -l JavaScript tests/category-rank.test.js
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

const SRC_PATH = 'background.js';
const src = readFile(SRC_PATH);
if (!src) throw new Error(SRC_PATH + ' 를 읽지 못했습니다. 저장소 루트에서 실행하세요.');

function slice(startMarker, endMarker) {
  const i = src.indexOf(startMarker);
  const j = src.indexOf(endMarker, i + 1);
  if (i < 0 || j < 0) throw new Error('소스에서 찾지 못함: ' + startMarker + ' ~ ' + endMarker);
  if (src.indexOf(startMarker, i + 1) >= 0) throw new Error('마커가 두 번 이상 나옴: ' + startMarker);
  return src.slice(i, j);
}
const DEFS =
  slice('function parseSpec(text) {', 'async function getNaverCreds') + '\n' +
  slice('// ── 상품 추천 (A안', "// 탭이 'complete' 가 될 때까지") + '\n' +
  slice("// 탭이 'complete' 가 될 때까지", 'async function getRecWeights') + '\n' +
  slice('// ── 카테고리 순위 (계약 3~5장) — 순수 함수', '// 네이버 쇼핑 검색 API 는 2026-07-31 종료');

const EXPORTS = [
  'buildSearchQuery', 'buildCategoryQuery', 'validateCategoryQuery', 'normalizeCategoryItems', 'filterCategoryCandidates',
  'scoreCategoryCandidates', 'rankCategoryCandidates', 'buildCategoryCard', 'rankCategoryItems', 'resolveCategoryWeights',
  'productIdFromUrl', 'isCoupangSearchUrl', 'queryFromSearchUrl', 'categorySearchUrl', 'countCategoryExcluded',
  'collectViaBackgroundTab', '_recInFlight', 'rankCategoryForProduct', 'openRankedSearch', 'getRankTab',
  'rankSearchItemsForTab', 'categoryQueryWithGemini', 'CATEGORY_WEIGHTS_DEFAULT',
];

// ── 목: URL / URLSearchParams (validateDetailUrl 이 쓰는 만큼만) ──
function MiniURLSearchParams(init) {
  this._p = [];
  const s = String(init || '').replace(/^\?/, '');
  if (s) for (const part of s.split('&')) {
    if (!part) continue;
    const k = part.split('=')[0], v = part.slice(k.length + 1);
    const dec = (x) => { try { return decodeURIComponent(x.replace(/\+/g, ' ')); } catch (_) { return x; } };
    this._p.push([dec(k), dec(v)]);
  }
}
MiniURLSearchParams.prototype.get = function (k) { const e = this._p.find((x) => x[0] === k); return e ? e[1] : null; };
MiniURLSearchParams.prototype.set = function (k, v) {
  const i = this._p.findIndex((x) => x[0] === k);
  if (i >= 0) this._p[i] = [k, String(v)]; else this._p.push([k, String(v)]);
};
MiniURLSearchParams.prototype.entries = function () { return this._p.map((x) => [x[0], x[1]])[Symbol.iterator](); };
MiniURLSearchParams.prototype.toString = function () {
  return this._p.map((x) => encodeURIComponent(x[0]) + '=' + encodeURIComponent(x[1])).join('&');
};
function MiniURL(u) {
  const m = /^([a-z][a-z0-9+.-]*:)\/\/([^\/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(String(u));
  if (!m) throw new TypeError('Invalid URL: ' + u);
  const host = m[2].replace(/^.*@/, '').toLowerCase();
  this.protocol = m[1].toLowerCase();
  this.hostname = host.replace(/:\d+$/, '');
  this.origin = this.protocol + '//' + host;
  this.pathname = m[3] || '/';
  this.search = m[4] && m[4] !== '?' ? m[4] : '';
  this.searchParams = new MiniURLSearchParams(this.search);
}
const URL_IMPL = typeof URL === 'function' ? URL : MiniURL;
const USP_IMPL = typeof URLSearchParams === 'function' ? URLSearchParams : MiniURLSearchParams;
function MockAbortController() { this.signal = { aborted: false }; }
MockAbortController.prototype.abort = function () { this.signal.aborted = true; };
const stubSetTimeout = function () { return 1; };   // 콜백은 부르지 않는다 (타임아웃 경로는 검사하지 않음)
const stubClearTimeout = function () {};
const quietConsole = { log() {}, warn() {}, error() {} };

// ── 목: chrome (storage.session·tabs) ──────────────────────────
function makeChrome(opts) {
  const o = opts || {};
  const env = {
    session: {}, created: [], removed: [], sent: [], removedListeners: [],
    collectResponse: o.collectResponse || ((url) => ({ ok: true, source: 'coupang', url, count: 0, items: [] })),
    nextTabId: 100,
  };
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  env.chrome = {
    storage: {
      session: {
        get(k) {
          const keys = Array.isArray(k) ? k : [k];
          const out = {};
          for (const key of keys) if (env.session[key] !== undefined) out[key] = clone(env.session[key]);
          return Promise.resolve(out);
        },
        set(obj) { for (const key of Object.keys(obj)) env.session[key] = clone(obj[key]); return Promise.resolve(); },
      },
    },
    tabs: {
      create(p) { const tab = { id: env.nextTabId++, url: p.url, active: p.active }; env.created.push(tab); return Promise.resolve(tab); },
      get(id) { return Promise.resolve({ id, status: 'complete' }); },
      remove(id) { env.removed.push(id); return Promise.resolve(); },
      sendMessage(id, msg) {
        env.sent.push({ id, msg });
        const tab = env.created.find((t) => t.id === id);
        return Promise.resolve(env.collectResponse(tab ? tab.url : null));
      },
      onUpdated: { addListener() {}, removeListener() {} },
      onRemoved: { addListener(fn) { env.removedListeners.push(fn); } },
    },
  };
  return env;
}

// 재시도 대기(recSleep)가 실제로 끝나야 하는 실패 경로용: 콜백을 다음 마이크로태스크에 부른다
const immediateSetTimeout = function (fn) { Promise.resolve().then(fn); return 1; };
function load(env, geminiRaw, setTimeoutImpl) {
  const fn = new Function('URL', 'URLSearchParams', 'chrome', 'setTimeout', 'clearTimeout', 'AbortController', 'console', 'geminiRaw',
    DEFS + '\nreturn {' + EXPORTS.join(', ') + '};');
  return fn(URL_IMPL, USP_IMPL, env.chrome, setTimeoutImpl || stubSetTimeout, stubClearTimeout, MockAbortController, quietConsole,
    geminiRaw || function () { return Promise.reject(new Error('Gemini 403 (테스트: 키 차단)')); });
}

// ── 보고 ───────────────────────────────────────────────────────
const lines = [];
let failed = 0;
let total = 0;
let reported = false;
const J = (v) => JSON.stringify(v);
const errText = (e) => (e && e.message ? (e.name || 'Error') + ': ' + e.message : String(e));
function check(name, ok, detail) {
  total++;
  if (!ok) failed++;
  lines.push((ok ? '  PASS  ' : '  FAIL  ') + name + (!ok && detail !== undefined ? '\n         ' + detail : ''));
}
function section(title) { lines.push(''); lines.push('  [' + title + ']'); }
function safe(name, fn) { try { fn(); } catch (e) { check(name + ' — 예외', false, errText(e)); } }
function finish() {
  if (reported) return;
  reported = true;
  lines.push('');
  lines.push(failed === 0 ? '  ✅ ' + total + '개 전부 통과' : '  ❌ ' + total + '개 중 ' + failed + '건 실패');
  const report = lines.join('\n');
  if (IS_NODE) {
    console.log(report);
    process.exitCode = failed > 0 ? 1 : 0;
    return;
  }
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

// ── 픽스처: 실측 상위 10개 (쿠팡 랭킹순, 2026-10-16) ─────────────
const CP = 'https://www.coupang.com';
const LIVE = [
  { productId: '7660384708', vendorItemId: '8587', itemId: '20406909698', name: '트래들 강아지 가방 이동가방 고양이 백팩 애견 반려견', price: 59800, originalPrice: 82720, discountRate: 27, rating: 4.5, reviewCount: 31, rocket: null, adBadge: true, url: CP + '/vp/products/7660384708?itemId=20406909698&vendorItemId=8587', searchRank: 1, coupangRank: null },
  { productId: '9654334164', vendorItemId: '9579', itemId: '28857851735', name: 'Hzuaneri 접이식 강아지 이동장 차량용 캠핑 휴대', price: 41980, originalPrice: 77970, discountRate: 46, rating: 5, reviewCount: 10, rocket: '판매자로켓', adBadge: true, url: CP + '/vp/products/9654334164?itemId=28857851735&vendorItemId=9579', searchRank: 2, coupangRank: null },
  { productId: '6472758137', vendorItemId: '8138', itemId: '14135487433', name: '스페이스캣 반려동물 3면 통풍 백팩형 이동가방, 그레이', price: 34000, originalPrice: null, discountRate: null, rating: 5, reviewCount: 1843, rocket: '로켓배송', adBadge: false, url: CP + '/vp/products/6472758137?itemId=14135487433&vendorItemId=8138', searchRank: 3, coupangRank: 1 },
  { productId: '9749179095', vendorItemId: '9609', itemId: '29190958226', name: 'Anystar 강아지 고양이 전면 확장형 이동가방 메쉬', price: 27670, originalPrice: 32700, discountRate: 15, rating: 5, reviewCount: 4, rocket: '판매자로켓', adBadge: false, url: CP + '/vp/products/9749179095?itemId=29190958226&vendorItemId=9609', searchRank: 4, coupangRank: 2 },
  { productId: '9428629989', vendorItemId: '9498', itemId: '28030768064', name: '강아지 고양이 이동가방 확장형 텐트형 백팩 3면통풍 펫', price: 29700, originalPrice: 35100, discountRate: 15, rating: 4.5, reviewCount: 37, rocket: '판매자로켓', adBadge: false, url: CP + '/vp/products/9428629989?itemId=28030768064&vendorItemId=9498', searchRank: 5, coupangRank: 3 },
  { productId: '8457588712', vendorItemId: '9147', itemId: '24463766248', name: '쁘띠시오 강아지 백팩 고양이 3면 통풍 확장형 이동가방', price: 35380, originalPrice: 57390, discountRate: 38, rating: 4.5, reviewCount: 228, rocket: '판매자로켓', adBadge: true, url: CP + '/vp/products/8457588712?itemId=24463766248&vendorItemId=9147', searchRank: 6, coupangRank: null },
  { productId: '8365213165', vendorItemId: '8782', itemId: '16176262808', name: '가티가티 고양이 이동가방 이동장 백팩 반려묘 강아지 케', price: 34690, originalPrice: 40900, discountRate: 15, rating: 5, reviewCount: 214, rocket: '판매자로켓', adBadge: true, url: CP + '/vp/products/8365213165?itemId=16176262808&vendorItemId=8782', searchRank: 7, coupangRank: null },
  { productId: '8148756016', vendorItemId: '9021', itemId: '23180130189', name: '레토 반려동물 이동장 백팩 가방, 혼합색상, 1개', price: 30920, originalPrice: 35900, discountRate: 13, rating: 4.5, reviewCount: 190, rocket: '로켓배송', adBadge: false, url: CP + '/vp/products/8148756016?itemId=23180130189&vendorItemId=9021', searchRank: 8, coupangRank: 4 },
  { productId: '8299680606', vendorItemId: '9096', itemId: '23941824046', name: '코지스 강아지 백팩 고양이 이동장 산책가방 앞가방, 1', price: 19900, originalPrice: 76000, discountRate: 73, rating: 4.5, reviewCount: 598, rocket: '판매자로켓', adBadge: false, url: CP + '/vp/products/8299680606?itemId=23941824046&vendorItemId=9096', searchRank: 9, coupangRank: 5 },
  { productId: '245133941', vendorItemId: '4965787', itemId: '777152073', name: '딩동펫 반려동물 투명 우주선 백팩, 블랙, 1개', price: 15900, originalPrice: null, discountRate: null, rating: 4.5, reviewCount: 3518, rocket: '로켓배송', adBadge: true, url: CP + '/vp/products/245133941?itemId=777152073&vendorItemId=4965787', searchRank: 10, coupangRank: null },
];
const ORGANIC_IDS = ['6472758137', '9749179095', '9428629989', '8148756016', '8299680606'];
const AD_IDS = ['7660384708', '9654334164', '8457588712', '8365213165', '245133941'];
const Q = '강아지 고양이 이동장';
const TOKS = ['강아지', '고양이', '이동장'];
const fx = () => JSON.parse(JSON.stringify(LIVE));
const ids = (list) => list.map((c) => c.productId);
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
const item = (id, name, price, extra) => Object.assign({ productId: id, name, price, url: CP + '/vp/products/' + id + '?itemId=1&vendorItemId=2', rating: 4.6, reviewCount: 120, rocket: null, adBadge: false, soldOut: false }, extra || {});

let F = null;
try { F = load(makeChrome()); } catch (e) { check('background.js 구간 로드', false, errText(e)); }

if (F) {
  // ── 3장: 카테고리 검색어 ─────────────────────────────────────
  section('buildCategoryQuery — 상품 종류 검색어');
  safe('검색어', () => {
    const r1 = F.buildCategoryQuery({ productName: '호밍사이 강아지 백팩 고양이 이동장 앞가방 삼면통풍 강아지가방 반려동물산책가방 고양이이동장' });
    check("'호밍사이 …고양이이동장' → '강아지 고양이 이동장' (브랜드 추정 제거·빈도)", r1.query === '강아지 고양이 이동장' && r1.via === 'rule', J(r1));
    check('  tokens 은 검색어 단어', J(r1.tokens) === J(['강아지', '고양이', '이동장']), J(r1.tokens));
    const r2 = F.buildCategoryQuery({ productName: '로지텍 MX Master 3S 무선 마우스 그래파이트' });
    check("'로지텍 MX Master 3S 무선 마우스 그래파이트' → '무선 마우스' (영문 모델·색상·브랜드 제거)", r2.query === '무선 마우스', J(r2));
    const r3 = F.buildCategoryQuery({ productName: '햇반 백미밥, 210g, 24개 - 즉석밥 | 쿠팡' });
    check("'햇반 백미밥, 210g, 24개 - 즉석밥 | 쿠팡' → '즉석밥 백미밥' (2토큰 브랜드 의심 + 제목 꼬리 카테고리)", r3.query === '즉석밥 백미밥' && J(r3.tokens) === J(['즉석밥', '백미밥']) && r3.via === 'rule', J(r3));
    const r3a = F.buildCategoryQuery({ productName: '비비고 왕교자 1.05kg' });
    check("'비비고 왕교자 1.05kg' → 꼬리 없으면 그대로 '비비고 왕교자'", r3a.query === '비비고 왕교자', J(r3a));
    const r3b = F.buildCategoryQuery({ productName: '[무료배송] 스탠리 텀블러 591ml 크림' });
    check("'[무료배송] 스탠리 텀블러 591ml 크림' → 꼬리 없으면 그대로 '스탠리 텀블러'", r3b.query === '스탠리 텀블러', J(r3b));
    const r3c = F.buildCategoryQuery({ productName: '햇반 백미밥, 210g, 24개 - 백미밥 | 쿠팡' });
    check("꼬리 카테고리가 둘째 토큰과 같으면 한 번만 → '백미밥'", r3c.query === '백미밥', J(r3c));
    const r3e = F.buildCategoryQuery({ productName: '곰곰 우유 - 우유/두유 | 쿠팡' });
    check("꼬리가 '우유/두유' 처럼 여럿이면 제목에도 나오는 한글 분류 하나만 → '우유'", r3e.query === '우유' && !r3e.query.includes('/'), J(r3e));
    const r3f = F.buildCategoryQuery({ productName: '애플 아이패드 - Apple | 쿠팡' });
    check("꼬리가 영문('Apple')이면 쓰지 않는다 — 브랜드가 검색어로 되돌아오지 않음", !/apple/i.test(r3f.query), J(r3f));
    const r3d = F.buildCategoryQuery({ productName: '호밍사이 강아지 백팩 고양이 이동장 - 반려동물가방 | 쿠팡' });
    check('한글 토큰 3개 이상이면 꼬리 카테고리를 검색어에 쓰지 않는다', !r3d.query.includes('반려동물가방') && !r3d.query.includes('호밍사이'), J(r3d));
    const r4 = F.buildCategoryQuery({ productName: '햇반 백미밥, 210g, 24개 - 즉석밥 | 쿠팡', brand: '햇반' });
    check("brand '햇반' 이 오면 그 토큰 제거 → '백미밥'", r4.query === '백미밥', J(r4));
    const r5 = F.buildCategoryQuery({ productName: '농심 신라면 120g x 40개', brand: '농심' });
    check("brand '농심' → '신라면' (수량 꼬리 'x' 도 안 남음)", r5.query === '신라면', J(r5));
    const r6 = F.buildCategoryQuery({ productName: '삼성전자 갤럭시 버즈3 프로 SM-R630 블루투스 이어폰 실버', brand: '삼성' });
    check("brand '삼성' → '삼성전자'(브랜드로 시작) 제거, 숫자 토큰 '버즈3'·모델·색상 제거 → '갤럭시 프로 블루투스'", r6.query === '갤럭시 프로 블루투스', J(r6));
    const r7 = F.buildCategoryQuery({ productName: '스페이스캣 반려동물 3면 통풍 백팩형 이동가방, 그레이' });
    check('실측 상품명: 브랜드·색상·숫자 토큰 제외', !r7.query.includes('스페이스캣') && !r7.query.includes('그레이') && !/\d/.test(r7.query) && r7.query.length > 0, J(r7));
    const name8 = 'Apple AirPods Pro 2 USB-C';
    const r8 = F.buildCategoryQuery({ productName: name8 });
    check('한글 종류 토큰이 없으면 buildSearchQuery 로 폴백', r8.query === F.buildSearchQuery({ productName: name8 }).query && r8.query.length > 0 && r8.via === 'rule', J(r8));
    const r9 = F.buildCategoryQuery({ productName: '가나다라마바사아자차 카타파하가나다라마바 사아자차카타파하가나', brand: '없는브랜드' });
    check('20자 넘으면 뒤에서부터 뺀다', r9.query === '가나다라마바사아자차' && r9.query.length <= 20, J(r9));
    const r10 = F.buildCategoryQuery({ productName: '고양이 이동장 고양이 가방' });
    check('첫 토큰이 제목에 두 번 나오면 브랜드로 보지 않는다', r10.query.includes('고양이'), J(r10));
  });

  section('validateCategoryQuery — AI 검색어 검증');
  safe('검증', () => {
    check("'고양이 이동장' 통과", F.validateCategoryQuery('고양이 이동장', '스페이스캣') === '고양이 이동장');
    check('앞뒤 공백·중복 공백 정리', F.validateCategoryQuery('  무선   마우스 ', '') === '무선 마우스');
    check('브랜드 포함 → null', F.validateCategoryQuery('로지텍 무선 마우스', '로지텍') === null);
    check('숫자 포함 → null', F.validateCategoryQuery('이동장 3종', '') === null);
    check('한글 없음 → null', F.validateCategoryQuery('wireless mouse', '') === null);
    check('21자 → null', F.validateCategoryQuery('가나다라마바사아자차카타파하가나다라마바사', '') === null);
    check('5단어 → null', F.validateCategoryQuery('강아지 고양이 이동장 백팩 가방', '') === null);
    check('1자 → null', F.validateCategoryQuery('펫', '') === null);
    check('기호 포함 → null', F.validateCategoryQuery('마우스/키보드', '') === null);
    check('null/undefined → null', F.validateCategoryQuery(undefined, '') === null && F.validateCategoryQuery(null, '') === null);
  });

  section('URL 도우미');
  safe('URL', () => {
    check('productIdFromUrl: 쿠팡 상세', F.productIdFromUrl(CP + '/vp/products/7660384708?itemId=1') === '7660384708');
    check('productIdFromUrl: 다른 호스트 → null', F.productIdFromUrl('https://evil.com/vp/products/1') === null);
    check('productIdFromUrl: 검색 URL → null', F.productIdFromUrl(CP + '/np/search?q=x') === null);
    check('productIdFromUrl: 빈 값 → null', F.productIdFromUrl(undefined) === null);
    const su = F.categorySearchUrl(Q);
    check('categorySearchUrl 은 isCoupangSearchUrl 통과', F.isCoupangSearchUrl(su), su);
    check('queryFromSearchUrl 왕복', F.queryFromSearchUrl(su) === Q, F.queryFromSearchUrl(su));
    check('isCoupangSearchUrl: http → 거부', !F.isCoupangSearchUrl('http://www.coupang.com/np/search?q=x'));
    check('isCoupangSearchUrl: 다른 호스트 → 거부', !F.isCoupangSearchUrl('https://www.coupang.com.evil.com/np/search?q=x'));
    check('isCoupangSearchUrl: 상세 URL → 거부', !F.isCoupangSearchUrl(CP + '/vp/products/1'));
    check('isCoupangSearchUrl: 쿼리 없음 → 거부', !F.isCoupangSearchUrl(CP + '/np/search'));
    check('isCoupangSearchUrl: javascript: → 거부', !F.isCoupangSearchUrl('javascript:alert(1)//https://www.coupang.com/np/search?q=x'));
  });

  // ── 4장: 필터 ─────────────────────────────────────────────────
  section('filterCategoryCandidates — 실측 상위 10개');
  safe('필터 실측', () => {
    const items = F.normalizeCategoryItems(fx());
    const r = F.filterCategoryCandidates(items, { tokens: TOKS, currentProductId: null });
    check('광고 5개 제외 (why=ad)', sameSet(r.excluded.filter((e) => e.why === 'ad').map((e) => e.productId), AD_IDS), J(r.excluded));
    check('일반 5개 남음', sameSet(ids(r.kept), ORGANIC_IDS), J(ids(r.kept)));
    check("'1개' 꼬리만 있는 이동장 목록은 단가 모드 아님", r.unitMode === null, r.unitMode);
    check('후보 5개(<8)라 이상치 검사 안 함', !r.excluded.some((e) => e.why === 'outlier'));
    check('kept 의 link 는 정규화한 상세 URL', r.kept.every((c) => /^https:\/\/www\.coupang\.com\/vp\/products\/\d+(\?itemId=\d+&vendorItemId=\d+)?$/.test(c.link)), J(r.kept.map((c) => c.link)));
    const r2 = F.filterCategoryCandidates(items, { tokens: TOKS, currentProductId: '6472758137' });
    check('현재 상품(productId 일치) → why=current', r2.excluded.some((e) => e.productId === '6472758137' && e.why === 'current') && !ids(r2.kept).includes('6472758137'));
    const counts = F.countCategoryExcluded(r2.excluded);
    check('countCategoryExcluded: ad 5 · current 1 · 나머지 0', counts.ad === 5 && counts.current === 1 && counts.soldOut === 0 && counts.outlier === 0 && counts.accessory === 0 && counts.noSpec === 0 && counts.badUrl === 0, J(counts));
  });

  section('filterCategoryCandidates — 규칙별');
  safe('필터 규칙', () => {
    const base = [
      item('101', '고양이 이동장 백팩', 30000),
      item('102', '고양이 이동장 커버', 9000),
      item('103', '강아지 이동장 품절상품', 31000, { soldOut: true }),
      item('104', '고양이 이동장 가방', 0),
      item('105', '강아지 고양이 이동장', 32000, { url: CP + '/np/search?q=%EC%9D%B4%EB%8F%99%EC%9E%A5', cleanUrl: null }),
      item('106', '반려동물 이동장', 33000, { url: 'not a url', cleanUrl: CP + '/vp/products/106?itemId=7&vendorItemId=8' }),
      item('107', '고양이 이동장 광고 노출', 28000, { adBadge: true }),
      item('107', '고양이 이동장 광고 노출', 28000, { adBadge: false, url: CP + '/vp/products/107?itemId=3&vendorItemId=4' }),
      item('108', '광고만 나온 이동장', 27000, { adBadge: true }),
      item('108', '광고만 나온 이동장', 27000, { adBadge: true }),
      item('109', '다른 상품 URL 이 붙은 카드', 29000, { url: CP + '/vp/products/999?itemId=1' }),
    ];
    const items = F.normalizeCategoryItems(base);
    const r = F.filterCategoryCandidates(items, { tokens: TOKS, currentProductId: null });
    const why = (id) => (r.excluded.find((e) => e.productId === id) || {}).why || null;
    check('액세서리 단어(커버) + 토큰에 없음 → accessory', why('102') === 'accessory');
    const rAcc = F.filterCategoryCandidates(items, { tokens: ['이동장', '커버'], currentProductId: null });
    check("카테고리 토큰에 '커버' 가 있으면 액세서리로 빼지 않는다", ids(rAcc.kept).includes('102'));
    check('품절 → soldOut', why('103') === 'soldOut');
    check('가격 0 → 조용히 버림(제외 목록에도 없음)', why('104') === null && !ids(r.kept).includes('104'));
    check('검색 URL 만 있는 카드 → badUrl, 카드로 안 나감', why('105') === 'badUrl' && !ids(r.kept).includes('105'));
    const k106 = r.kept.find((c) => c.productId === '106');
    check('url 이 깨져도 cleanUrl 이 상세 URL 이면 사용', !!k106 && k106.link === CP + '/vp/products/106?itemId=7&vendorItemId=8', k106 && k106.link);
    const k107 = r.kept.filter((c) => c.productId === '107');
    check('같은 productId: 광고 아닌 원소가 대표 (1개만, adBadge=false)', k107.length === 1 && k107[0].adBadge === false && why('107') === null, J(k107));
    check('같은 productId 가 광고로만 나오면 광고 원소 대표 → ad 1건', r.excluded.filter((e) => e.productId === '108').length === 1 && why('108') === 'ad');
    check('URL 의 productId 가 카드 productId 와 다르면 badUrl', why('109') === 'badUrl');
  });

  section('filterCategoryCandidates — 단가 모드·이상치');
  safe('단가', () => {
    const rice = [
      item('201', '햇반 백미밥, 210g, 24개', 23900),
      item('202', '오뚜기밥 흰밥, 210g, 12개', 13900),
      item('203', '작은밥 즉석밥, 130g, 36개', 26900),
      item('204', '대용량 즉석밥, 1kg, 4개', 15000),
      item('205', '즉석밥 백미, 210g, 36개', 33900),
      item('206', '즉석밥 대용량 묶음', 9900),
    ];
    const r = F.filterCategoryCandidates(F.normalizeCategoryItems(rice), { tokens: ['즉석밥'], currentProductId: null });
    check("규격(g) 보유 5/6 ≥ 60% → unitMode 'g'", r.unitMode === 'g', r.unitMode);
    check('규격 없는 후보 → noSpec', r.excluded.some((e) => e.productId === '206' && e.why === 'noSpec'), J(r.excluded));
    const k = (id) => r.kept.find((c) => c.productId === id);
    check("단가 라벨 '100g당 474원' (23,900원 / 5,040g)", k('201') && k('201').unitPriceLabel === '100g당 474원', k('201') && k('201').unitPriceLabel);
    check('effectivePrice = 100g당 가격', k('204') && Math.abs(k('204').effectivePrice - 375) < 1e-9, k('204') && k('204').effectivePrice);
    const s = F.scoreCategoryCandidates(r.kept, { price: 1, quality: 0, safety: 0 });
    const sc = (id) => s.find((c) => c.productId === id).scores.price;
    check('가격 점수는 단가 기준 (15,000원 1kg×4 가 100점, 13,900원 210g×12 는 25점)', sc('204') === 100 && sc('202') === 25, J(s.map((c) => [c.productId, c.scores.price])));

    const bat = [
      item('301', '알카라인 건전지 AA, 20개', 9900),
      item('302', '알카라인 건전지 AA, 10개', 5900),
      item('303', '알카라인 건전지 AA, 40개', 17900),
      item('304', '알카라인 건전지 AA, 4개', 2500),
    ];
    const rb = F.filterCategoryCandidates(F.normalizeCategoryItems(bat), { tokens: ['건전지'], currentProductId: null });
    check("개수만 있는 규격 → unitMode 'count', '1개당 495원'", rb.unitMode === 'count' && rb.kept.find((c) => c.productId === '301').unitPriceLabel === '1개당 495원', J(rb.kept.map((c) => c.unitPriceLabel)));

    const one = [
      item('401', '고양이 이동장 백팩, 1개', 30000),
      item('402', '강아지 이동장 가방, 1개', 31000),
      item('403', '반려동물 이동장, 1개', 32000),
      item('404', '고양이 이동장 캐리어, 1개', 33000),
      item('405', '고양이 이동장 하드케이지', 34000),
    ];
    const ro = F.filterCategoryCandidates(F.normalizeCategoryItems(one), { tokens: TOKS, currentProductId: null });
    check("전부 '1개' 뿐이면 단가 모드를 쓰지 않아 규격 없는 후보를 빼지 않는다", ro.unitMode === null && ro.kept.length === 5, J({ unitMode: ro.unitMode, kept: ids(ro.kept) }));
  });
  safe('이상치', () => {
    const normal = [25000, 26500, 27000, 28000, 29000, 30000, 31000, 32000, 33000, 34000];
    const list = normal.map((p, i) => item(String(500 + i), '고양이 이동장 ' + i, p));
    list.push(item('590', '고양이 이동장 초저가', 900));
    list.push(item('591', '고양이 이동장 초고가', 2000000));
    const r = F.filterCategoryCandidates(F.normalizeCategoryItems(list), { tokens: TOKS, currentProductId: null });
    const outs = r.excluded.filter((e) => e.why === 'outlier').map((e) => e.productId);
    check('n≥8: log 가격 IQR 밖 위·아래 → outlier', sameSet(outs, ['590', '591']), J(outs));
    check('정상 가격대 10개는 남음', r.kept.length === 10, r.kept.length);
    const few = [item('601', '이동장 a', 30000), item('602', '이동장 b', 31000), item('603', '이동장 c', 900), item('604', '이동장 d', 2000000)];
    const rf = F.filterCategoryCandidates(F.normalizeCategoryItems(few), { tokens: ['이동장'], currentProductId: null });
    check('n<8 이면 이상치 검사 안 함', rf.kept.length === 4 && !rf.excluded.length, J(rf.excluded));
  });

  // ── 5장: 점수 ─────────────────────────────────────────────────
  section('scoreCategoryCandidates — 실측 일반 5개');
  let organic = [];
  safe('점수 실측', () => {
    organic = F.filterCategoryCandidates(F.normalizeCategoryItems(fx()), { tokens: TOKS, currentProductId: null }).kept;
    const s = F.scoreCategoryCandidates(organic);   // 기본 가중치 = 안전성 우대(.2/.3/.5)
    const by = (id) => s.find((c) => c.productId === id);
    check('모든 축·total 이 0~100 정수', s.every((c) => ['price', 'quality', 'safety', 'total'].every((k) => Number.isInteger(c.scores[k]) && c.scores[k] >= 0 && c.scores[k] <= 100)), J(s.map((c) => c.scores)));
    check('가격 백분위: 최저가 코지스 100 · 최고가 스페이스캣 0 · 가운데 50', by('8299680606').scores.price === 100 && by('6472758137').scores.price === 0 && by('9428629989').scores.price === 50, J(s.map((c) => [c.productId, c.scores.price])));
    check('품질: 스페이스캣(5.0·리뷰 1,843) = 100', by('6472758137').scores.quality === 100, by('6472758137').scores.quality);
    check('안정: 스페이스캣 로켓배송+평점4.5↑리뷰100↑+리뷰1000↑ = 90', by('6472758137').scores.safety === 90, by('6472758137').scores.safety);
    check('안정: 레토 로켓배송+평점4.5↑리뷰100↑ = 85', by('8148756016').scores.safety === 85, by('8148756016').scores.safety);
    check('안정: Anystar 판매자로켓·리뷰 4개(<5) = 52', by('9749179095').scores.safety === 52, by('9749179095').scores.safety);
    check('안정: 코지스 73% 할인(원가 76,000 / 19,900 = 3.8배) 과장 할인 감점 → 62', by('8299680606').scores.safety === 62 && by('8299680606').overDiscount === true, by('8299680606').scores.safety);
    check('평점·리뷰 있는 후보는 dataInsufficient=false', s.every((c) => c.dataInsufficient === false));
  });

  section('가중치 반영 — 순위가 바뀐다');
  safe('가중치', () => {
    const order = (w) => F.rankCategoryCandidates(F.scoreCategoryCandidates(organic, w)).ranked.map((c) => c.productId);
    const def = order(undefined);
    const safetyOnly = order({ price: 0, quality: 0, safety: 1 });
    const value = order({ price: 0.5, quality: 0.3, safety: 0.2 });
    check('안전성 우대(기본): 1위 코지스', def[0] === '8299680606', J(def));
    check('안정만(0/0/1): 1위 스페이스캣(로켓배송·리뷰 1,843) — 기본과 1위가 다르다', safetyOnly[0] === '6472758137' && safetyOnly[0] !== def[0], J(safetyOnly));
    check('가성비 우대(.5/.3/.2): 1위 코지스, 2위 Anystar, 꼴찌 스페이스캣', value[0] === '8299680606' && value[1] === '9749179095' && value[4] === '6472758137', J(value));
    check('안정 동점(62)이면 리뷰 많은 쪽(코지스 598 > 37) 먼저', safetyOnly.indexOf('8299680606') < safetyOnly.indexOf('9428629989'), J(safetyOnly));
    const a = F.scoreCategoryCandidates(organic, { price: 2, quality: 3, safety: 5 }).map((c) => c.scores.total);
    const b = F.scoreCategoryCandidates(organic, { price: 0.2, quality: 0.3, safety: 0.5 }).map((c) => c.scores.total);
    check('가중치는 합 1로 정규화 (2/3/5 = .2/.3/.5)', J(a) === J(b), J([a, b]));
    const w0 = F.resolveCategoryWeights({ price: 0, quality: 0, safety: 0 });
    check('가중치 합 0 → 기본(.2/.3/.5)', Math.abs(w0.price - 0.2) < 1e-9 && Math.abs(w0.safety - 0.5) < 1e-9, J(w0));
    const wp = F.resolveCategoryWeights(undefined, '가성비 우대');
    check("weights 없고 priority '가성비 우대' → .5/.3/.2", Math.abs(wp.price - 0.5) < 1e-9 && Math.abs(wp.safety - 0.2) < 1e-9, J(wp));
  });

  section('점수 — 데이터 부족·가디언·과장 할인·동률');
  safe('경계', () => {
    const noRate = [
      item('701', '고양이 이동장 신상', 10000, { rating: null, reviewCount: null, rocket: '로켓배송' }),
      item('702', '고양이 이동장 리뷰많음', 50000, { rating: 4.8, reviewCount: 500 }),
    ];
    const s = F.scoreCategoryCandidates(noRate, { price: 1, quality: 0, safety: 0 });
    const x = s.find((c) => c.productId === '701');
    check('평점 없음 → 품질 30 · dataInsufficient', x.scores.quality === 30 && x.dataInsufficient === true, J(x.scores));
    check('리뷰 없음(5개 미만) 안정 감점: 50+25−10 = 65', x.scores.safety === 65, x.scores.safety);
    const rk = F.rankCategoryCandidates(s);
    check('가격만 보면 701 이 total 1위지만, 가디언(평점 있는 첫 후보) 702 를 1위로 끌어올림',
      x.scores.total > s.find((c) => c.productId === '702').scores.total && rk.ranked[0].productId === '702' && rk.guardian === true && rk.guardianProductId === '702' && rk.ranked[0].rank === 1 && rk.ranked[1].rank === 2, J(rk.ranked.map((c) => [c.productId, c.scores.total, c.rank])));
    const allNo = F.rankCategoryCandidates(F.scoreCategoryCandidates([noRate[0]]));
    check('평점 있는 후보가 없으면 guardian=false, guardianProductId=null', allNo.guardian === false && allNo.guardianProductId === null && allNo.ranked.length === 1);
    check('후보 1개 → 가격 100', F.scoreCategoryCandidates([noRate[1]]).every((c) => c.scores.price === 100));

    const d1 = F.scoreCategoryCandidates([item('801', '이동장', 20000, { discountRate: 15, originalPrice: 23500 })])[0].scores.safety;
    const d2 = F.scoreCategoryCandidates([item('802', '이동장', 20000, { discountRate: 73, originalPrice: 74000 })])[0].scores.safety;
    const d3 = F.scoreCategoryCandidates([item('803', '이동장', 20000, { discountRate: null, originalPrice: 66000 })])[0].scores.safety;
    check('할인율 70%↑ → 안정 −10', d1 - d2 === 10, J([d1, d2]));
    check('원가/판매가 ≥ 3.3 (할인율 없음) → 안정 −10', d1 - d3 === 10, J([d1, d3]));

    const tie = F.scoreCategoryCandidates([item('901', 'a', 100), item('902', 'b', 100), item('903', 'c', 200)], { price: 1, quality: 0, safety: 0 });
    check('가격 동률은 평균 순위 (100원 둘 다 75, 200원 0)', tie[0].scores.price === 75 && tie[1].scores.price === 75 && tie[2].scores.price === 0, J(tie.map((c) => c.scores.price)));
  });

  // ── 카드 ──────────────────────────────────────────────────────
  section('rankCategoryItems·buildCategoryCard — 카드 형태');
  safe('카드', () => {
    const items = fx();
    items.push(item('7777777777', '강아지 고양이 이동장 검색결과', 9900, { url: CP + '/np/search?q=%EA%B3%A0%EC%96%91%EC%9D%B4', cleanUrl: null }));
    const r = F.rankCategoryItems(items, { query: Q, tokens: TOKS, currentProductId: null, weights: undefined, currentPrice: 40000 });
    check('candidateCount = 가격 있는 서로 다른 상품 수(11), rankedCount = 5', r.candidateCount === 11 && r.rankedCount === 5, J([r.candidateCount, r.rankedCount]));
    check('excludedCounts: ad 5 · badUrl 1', r.excludedCounts.ad === 5 && r.excludedCounts.badUrl === 1, J(r.excludedCounts));
    const c = r.cards[0];
    check("id 'cp-<productId>' · type 'optimal' · categoryRank", c.id === 'cp-' + c.productId && c.type === 'optimal' && c.categoryRank === true, J([c.id, c.type]));
    check('savings 0 · lowest false (다른 상품이라 아낀 돈·최저가 아님)', r.cards.every((x) => x.savings === 0 && x.lowest === false));
    check('tags 는 빈 문자열 없는 배열, 마지막은 검색 기준 표시', r.cards.every((x) => Array.isArray(x.tags) && x.tags.length > 0 && x.tags.every((t) => typeof t === 'string' && t.trim()) && x.tags[x.tags.length - 1] === '쿠팡 「' + Q + '」 검색 기준'), J(r.cards.map((x) => x.tags)));
    check('rank 1부터 차례, candidateCount = rankedCount', r.cards.every((x, i) => x.rank === i + 1 && x.candidateCount === 5));
    check('scores 4개 모두 정수', r.cards.every((x) => ['price', 'quality', 'safety', 'total'].every((k) => Number.isInteger(x.scores[k]))));
    check('검색 URL 은 링크로 안 나감 (모든 link 가 상세 URL, /np/search·q= 없음)', r.cards.every((x) => /^https:\/\/www\.coupang\.com\/vp\/products\/\d+/.test(x.link) && !/\/np\/search|[?&]q=/.test(x.link)) && !r.cards.some((x) => x.productId === '7777777777'), J(r.cards.map((x) => x.link)));
    const kozis = r.cards.find((x) => x.productId === '8299680606');
    check('코지스 link = 추적 파라미터 뗀 상세 URL', kozis.link === CP + '/vp/products/8299680606?itemId=23941824046&vendorItemId=9096', kozis.link);
    check("reason: '「검색어」 검색 결과 5개와 비교 · 평점 4.5 (리뷰 598개) · 판매자로켓 · 현재 상품과 가격 차이 −20,100원(다른 상품)'",
      kozis.reason === '「' + Q + '」 검색 결과 5개와 비교 · 평점 4.5 (리뷰 598개) · 판매자로켓 · 현재 상품과 가격 차이 \u221220,100원(다른 상품)', kozis.reason);
    check('reason 에 순위 숫자(종합 N위)·저렴·절약 표현 없음, 카드 rank 는 유지', r.cards.every((x) => !/\d+위|저렴|절약|비쌈/.test(x.reason) && Number.isInteger(x.rank)), J(r.cards.map((x) => x.reason)));
    const rUp = F.rankCategoryItems(fx(), { query: Q, tokens: TOKS, currentPrice: 27000 });
    const up = rUp.cards.find((x) => x.productId === '6472758137');
    check("후보가 더 비싸면 '+7,000원(다른 상품)'", !!up && /현재 상품과 가격 차이 \+7,000원\(다른 상품\)$/.test(up.reason), up && up.reason);
    const rUnit = F.rankCategoryItems([item('801', '고양이 사료 2kg', 20000), item('802', '고양이 사료 1kg', 12000), item('803', '고양이 사료 500g', 7000)], { query: '고양이 사료', tokens: ['고양이', '사료'], currentPrice: 15000 });
    check('단가 모드에서는 가격 차이 구절 생략', rUnit.unitMode === 'g' && rUnit.cards.every((x) => !/현재 상품/.test(x.reason)), J([rUnit.unitMode, rUnit.cards.map((x) => x.reason)]));
    check('estimatedPrice = price, platform 쿠팡, rating·reviewCount 숫자', kozis.estimatedPrice === kozis.price && kozis.platform === '쿠팡' && kozis.rating === 4.5 && kozis.reviewCount === 598);
    const r2 = F.rankCategoryItems(fx(), { query: Q, tokens: TOKS });
    check('현재가 모르면 가격 비교 구절 없음', r2.cards.every((x) => !/현재 상품/.test(x.reason)), r2.cards[0].reason);
    const r3 = F.rankCategoryItems([item('950', '고양이 이동장', 20000, { rating: null, reviewCount: null })], { query: Q, tokens: TOKS });
    check("평점 없음 → reason '평점·리뷰 데이터 부족', tag '평점·리뷰 부족', rating null", /평점·리뷰 데이터 부족/.test(r3.cards[0].reason) && r3.cards[0].tags.includes('평점·리뷰 부족') && r3.cards[0].rating === null && r3.cards[0].dataInsufficient === true, J(r3.cards[0]));
  });

  // ── 정적 검사 ─────────────────────────────────────────────────
  section('소스 정적 검사');
  check('_recInFlight 는 URL 별 Map', /const _recInFlight = new Map\(\);/.test(src) && !/_recInFlight = null/.test(src));
  check('searchPrices: mode category 분기', /message\.mode === 'category'/.test(src) && /rankCategoryForProduct\(\{/.test(src));
  check("openRankedSearch 는 tabs.create({ url: searchUrl, active: true })", /chrome\.tabs\.create\(\{ url: searchUrl, active: true \}\)/.test(src));
  check('메시지 openRankedSearch·rankTabStatus·rankSearchItems 처리', ['openRankedSearch', 'rankTabStatus', 'rankSearchItems'].every((t) => src.includes("message.type === '" + t + "'")));
}

// ── 결제 기록: 카테고리 순위 카드는 '아낀 돈'으로 세지 않는다 (이중 방어) ──
section('itemCheckoutSaved·recordPaidPurchase — categoryRank 면 saved 0');
safe('결제 절약액', () => {
  const fnSrc = slice('function itemCheckoutSaved(meta) {', 'async function openItemCheckout(');
  const saved = new Function(fnSrc + '\nreturn itemCheckoutSaved;')();
  check('일반 카드 savings 3000 → 3000', saved({ savings: 3000 }) === 3000);
  check('categoryRank 카드 savings 3000 → 0', saved({ savings: 3000, categoryRank: true }) === 0);
  check('음수·빈 값 → 0', saved({ savings: -5 }) === 0 && saved({}) === 0 && saved(null) === 0);
  check('openCheckout 메시지의 categoryRank 를 meta 로 넘긴다', /categoryRank: !!\(message\.categoryRank \|\| \(message\.card && message\.card\.categoryRank\)\)/.test(src));
  check('pending 에 categoryRank 기록 + 구매 기록 saved 는 categoryRank 면 0', /saved: itemCheckoutSaved\(meta\),\s*categoryRank: !!\(meta && meta\.categoryRank\)/.test(src) && /saved: pending\.categoryRank \? 0 :/.test(src));
});

// ── 비동기: 탭 수집 in-flight·오케스트레이터 ──────────────────────
async function runAsync() {
  section('collectViaBackgroundTab — URL 별 in-flight');
  {
    const env = makeChrome({ collectResponse: (url) => ({ ok: true, source: 'coupang', url, count: 1, items: [{ url }] }) });
    const G = load(env);
    const urlA = CP + '/np/search?q=a', urlB = CP + '/np/search?q=b';
    const pA1 = G.collectViaBackgroundTab(urlA, 1000);
    const pA2 = G.collectViaBackgroundTab(urlA, 1000);
    const pB = G.collectViaBackgroundTab(urlB, 1000);
    check('같은 URL 동시 요청 → 같은 Promise', pA1 === pA2);
    check('다른 URL → 다른 Promise', pA1 !== pB);
    const [a, b] = await Promise.all([pA1, pB]);
    check('각자 자기 URL 결과를 받는다 (예전 버그: 앞 요청 결과 공유)', a.url === urlA && b.url === urlB, J([a.url, b.url]));
    check('탭은 URL 당 1개, 비활성으로 열고 닫는다', env.created.length === 2 && env.created.every((t) => t.active === false) && env.removed.length === 2, J(env.created));
    await Promise.resolve();
    check('끝나면 in-flight 항목 정리', G._recInFlight.size === 0, G._recInFlight.size);
    const again = await G.collectViaBackgroundTab(urlA, 1000);
    check('끝난 뒤 같은 URL 은 새로 수집', again.url === urlA && env.created.length === 3);
  }

  section('rankCategoryForProduct — 계약 2.1 응답 (AI 실패 → 규칙)');
  {
    const env = makeChrome({ collectResponse: (url) => ({ ok: true, source: 'coupang', url, count: LIVE.length, items: fx() }) });
    const G = load(env);
    const res = await G.rankCategoryForProduct({
      productName: '호밍사이 강아지 백팩 고양이 이동장 앞가방 삼면통풍 강아지가방 반려동물산책가방 고양이이동장',
      currentPrice: 40000, weights: { price: 0.2, quality: 0.3, safety: 0.5 }, priority: '안전성 우대',
      currentProductId: '6472758137',
    });
    check('configured·mode·source', res.configured === true && res.mode === 'category' && res.source === 'coupang-search', J(res).slice(0, 300));
    check("query '강아지 고양이 이동장' · queryVia 'rule'", res.query === Q && res.queryVia === 'rule', J([res.query, res.queryVia]));
    check('searchUrl 은 쿠팡 검색 URL', res.searchUrl === G.categorySearchUrl(Q) && G.isCoupangSearchUrl(res.searchUrl));
    check('lowest null', res.lowest === null);
    check('현재 상품 제외 → rankedCount 4, excludedCounts.current 1, ad 5', res.rankedCount === 4 && res.excludedCounts.current === 1 && res.excludedCounts.ad === 5, J([res.rankedCount, res.excludedCounts]));
    check('excludedCounts 키 7개', J(Object.keys(res.excludedCounts).sort()) === J(['accessory', 'ad', 'badUrl', 'current', 'noSpec', 'outlier', 'soldOut']));
    check('items 는 상위 5개 이하, {title, price, mall, link, image, specText, card}', res.items.length === 4 && res.items.every((it) => it.mall === '쿠팡' && it.title === it.card.name && it.link === it.card.link && 'specText' in it && 'image' in it));
    check('note: 5개 미만 안내 (문자열)', typeof res.note === 'string' && /4개뿐/.test(res.note), res.note);
    check("weights·priority·unitMode 포함", res.priority === '안전성 우대' && Math.abs(res.weights.safety - 0.5) < 1e-9 && res.unitMode === null);
    check('탭은 비활성으로 열고 닫음', env.created.length === 1 && env.created[0].active === false && env.removed.length === 1);
    const lcr = env.session.lastCategoryRank;
    check('storage.session.lastCategoryRank 저장', !!lcr && lcr.query === Q && lcr.searchUrl === res.searchUrl && lcr.currentProductId === '6472758137' && lcr.priority === '안전성 우대' && typeof lcr.savedAt === 'number', J(lcr));
    const cache = env.session.catRecCache && env.session.catRecCache['cat|' + Q];
    check("catRecCache['cat|'+query] 에 원본 items 만 (scores·card 없음)", !!cache && Array.isArray(cache.items) && cache.items.length === LIVE.length && cache.items.every((c) => !('scores' in c) && !('card' in c)) && cache.searchUrl === res.searchUrl, J(Object.keys(cache || {})));

    const res2 = await G.rankCategoryForProduct({
      productName: '호밍사이 강아지 백팩 고양이 이동장 앞가방 삼면통풍 강아지가방 반려동물산책가방 고양이이동장',
      currentPrice: 0, weights: { price: 0, quality: 0, safety: 1 }, priority: '안전성 우대', currentProductId: null,
    });
    check('캐시 적중이면 탭을 다시 열지 않는다', env.created.length === 1, env.created.length);
    check('캐시 적중이어도 가중치·현재 상품으로 다시 계산 (현재 상품 포함 5개, 안정 1위 스페이스캣)', res2.rankedCount === 5 && res2.items[0].card.productId === '6472758137', J(res2.items.map((i) => i.card.productId)));
    check('현재가 0 이면 가격 비교 구절 없음', res2.items.every((i) => !/현재 상품/.test(i.card.reason)));

    const empty = makeChrome({ collectResponse: (url) => ({ ok: true, source: 'coupang', url, count: 0, items: [] }) });
    const G2 = load(empty);
    const bad = await G2.rankCategoryForProduct({ productName: '로지텍 MX Master 3S 무선 마우스 그래파이트' });
    check("검색 결과 없음 → configured:false, mode:'category', error 문장, query·searchUrl", bad.configured === false && bad.mode === 'category' && typeof bad.error === 'string' && bad.query === '무선 마우스' && G2.isCoupangSearchUrl(bad.searchUrl), J(bad));
    check("수집 0개 → '쿠팡 「q」 검색 결과에서 상품을 읽지 못했어요(결과가 없거나 쿠팡이 접근을 막았을 수 있어요).'", bad.error === '쿠팡 「무선 마우스」 검색 결과에서 상품을 읽지 못했어요(결과가 없거나 쿠팡이 접근을 막았을 수 있어요).', bad.error);
    const blockedEnv = makeChrome({ collectResponse: () => ({ ok: false, error: 'blocked' }) });
    const badB = await load(blockedEnv).rankCategoryForProduct({ productName: '로지텍 MX Master 3S 무선 마우스 그래파이트' });
    check("수집기 ok:false error:'blocked' → 같은 쉬운 문장, 다시 시도하지 않음(sendMessage 1회)", badB.configured === false && badB.error === '쿠팡 「무선 마우스」 검색 결과에서 상품을 읽지 못했어요(결과가 없거나 쿠팡이 접근을 막았을 수 있어요).' && blockedEnv.sent.length === 1, J([badB.error, blockedEnv.sent.length]));
    const failEnv = makeChrome({ collectResponse: () => ({ ok: false, error: 'not-search-page' }) });
    const badF = await load(failEnv, null, immediateSetTimeout).rankCategoryForProduct({ productName: '로지텍 MX Master 3S 무선 마우스 그래파이트' });
    const internalRe = /collect-failed|empty-response|not-search-page|Could not establish|blocked|[A-Za-z]{4,}/;
    check('그 밖의 수집 실패 → 내부 코드 없이 쉬운 한국어 문장', badF.configured === false && badF.error === '쿠팡 검색 결과를 읽지 못했어요. 잠시 뒤 다시 분석해 주세요.' && !internalRe.test(badF.error), badF.error);
    const throwEnv = makeChrome();
    throwEnv.chrome.tabs.sendMessage = function () { return Promise.reject(new Error('Could not establish connection. Receiving end does not exist.')); };
    const badT = await load(throwEnv, null, immediateSetTimeout).rankCategoryForProduct({ productName: '로지텍 MX Master 3S 무선 마우스 그래파이트' });
    check("'Could not establish connection' 도 사용자 문장에 안 나옴", !internalRe.test(badT.error) && /어요/.test(badT.error), badT.error);
    check('빈 결과는 캐시하지 않는다', !empty.session.catRecCache);
    const allAds = makeChrome({ collectResponse: (url) => ({ ok: true, source: 'coupang', url, count: 5, items: fx().filter((c) => c.adBadge) }) });
    const bad2 = await load(allAds).rankCategoryForProduct({ productName: '호밍사이 강아지 백팩 고양이 이동장 앞가방' });
    check('전부 광고면 configured:false + 제외 사유', bad2.configured === false && /광고 5/.test(bad2.error), bad2.error);
    const bad3 = await G.rankCategoryForProduct({ productName: 'a' });
    check('상품명 없음 → configured:false', bad3.configured === false && bad3.mode === 'category');
    check("오류 문장은 '-어요' 체", [bad.error, bad2.error, bad3.error].every((t) => /어요/.test(t) && !/습니다/.test(t)), J([bad.error, bad2.error, bad3.error]));
  }

  section('categoryQueryWithGemini — 검증·캐시');
  {
    const env = makeChrome({ collectResponse: (url) => ({ ok: true, source: 'coupang', url, count: LIVE.length, items: fx() }) });
    let calls = 0;
    const reply = (text) => () => { calls++; return Promise.resolve({ candidates: [{ content: { parts: [{ text }] } }] }); };
    const G = load(env, reply('{"category":"고양이 이동장"}'));
    const res = await G.rankCategoryForProduct({ productName: '스페이스캣 반려동물 3면 통풍 백팩형 이동가방, 그레이', brand: '스페이스캣' });
    check("AI 검색어 통과 → queryVia 'gemini'", res.configured === true && res.query === '고양이 이동장' && res.queryVia === 'gemini', J([res.query, res.queryVia]));
    const q2 = await G.categoryQueryWithGemini('스페이스캣 반려동물 3면 통풍 백팩형 이동가방, 그레이', '스페이스캣');
    check('같은 상품명은 catQueryCache 에서 (AI 재호출 없음)', q2 === '고양이 이동장' && calls === 1, J([q2, calls]));
    const GB = load(makeChrome(), reply('{"category":"스페이스캣 이동가방"}'));
    check('브랜드가 들어간 AI 답 → null (규칙으로)', (await GB.categoryQueryWithGemini('스페이스캣 반려동물 이동가방', '스페이스캣')) === null);
    const GN = load(makeChrome(), reply('카테고리는 이동장 2종입니다'));
    check('JSON 아님·숫자 포함 → null', (await GN.categoryQueryWithGemini('어떤 상품', '')) === null);
  }

  section('openRankedSearch·rankTabStatus·rankSearchItems·onRemoved');
  {
    const env = makeChrome();
    const G = load(env);
    const badOpen = await G.openRankedSearch({ searchUrl: 'https://evil.example/np/search?q=x' });
    check('쿠팡 검색 URL 아니면 거부 (탭 안 엶)', badOpen.ok === false && typeof badOpen.error === 'string' && env.created.length === 0, J(badOpen));
    const detailOpen = await G.openRankedSearch({ searchUrl: CP + '/vp/products/1' });
    check('상세 URL 도 거부', detailOpen.ok === false && env.created.length === 0);
    env.session.lastCategoryRank = { query: Q, searchUrl: G.categorySearchUrl(Q), weights: { price: 0.5, quality: 0.3, safety: 0.2 }, priority: '가성비 우대', currentProductId: '6472758137', savedAt: 1 };
    const ok = await G.openRankedSearch({});
    check('빠진 값은 lastCategoryRank 로 채워 보이는 탭으로 연다', ok.ok === true && env.created.length === 1 && env.created[0].active === true && env.created[0].url === G.categorySearchUrl(Q), J(ok));
    const entry = env.session.rankTabs && env.session.rankTabs[String(ok.tabId)];
    check('rankTabs[tabId] = {query, weights, priority, currentProductId, openedAt}', !!entry && entry.query === Q && entry.priority === '가성비 우대' && Math.abs(entry.weights.price - 0.5) < 1e-9 && entry.currentProductId === '6472758137' && typeof entry.openedAt === 'number', J(entry));
    const ok2 = await G.openRankedSearch({ searchUrl: G.categorySearchUrl('무선 마우스'), query: '무선 마우스', weights: { price: 0, quality: 0, safety: 1 }, priority: '안전성 우대', sourceUrl: CP + '/vp/products/123?itemId=1' });
    const entry2 = env.session.rankTabs[String(ok2.tabId)];
    check('요청 값이 있으면 그 값 (sourceUrl → currentProductId)', entry2.query === '무선 마우스' && entry2.currentProductId === '123' && entry2.weights.safety === 1, J(entry2));

    const st = await G.getRankTab(ok.tabId);
    check('rankTabStatus 가 쓰는 getRankTab: 순위 탭이면 설정을 돌려준다', !!st && st.query === Q);
    check('순위 탭이 아니면 null', (await G.getRankTab(99999)) === null);

    const rs = await G.rankSearchItemsForTab({ type: 'rankSearchItems', url: G.categorySearchUrl(Q), items: fx() }, { tab: { id: ok.tabId } });
    check('rankSearchItems: ok·query·priority·counts', rs.ok === true && rs.query === Q && rs.priority === '가성비 우대' && rs.candidateCount === 10 && rs.rankedCount === 4, J([rs.ok, rs.query, rs.priority, rs.candidateCount, rs.rankedCount]));
    check('ranked 원소 형태 {productId, rank, scores, dataInsufficient, link, name, price, unitPriceLabel, reason, tags}', rs.ranked.every((x) => ['productId', 'rank', 'scores', 'dataInsufficient', 'link', 'name', 'price', 'unitPriceLabel', 'reason', 'tags'].every((k) => k in x) && Array.isArray(x.tags)), J(rs.ranked[0]));
    check('excluded: 광고 5 + 지금 보던 상품 1 (why 값)', rs.excluded.filter((e) => e.why === 'ad').length === 5 && rs.excluded.some((e) => e.productId === '6472758137' && e.why === 'current'), J(rs.excluded));
    check('guardianProductId 는 1위 상품', rs.guardianProductId === rs.ranked[0].productId);
    const rsPage = await G.rankSearchItemsForTab({ url: G.categorySearchUrl('고양이 백팩'), items: fx() }, { tab: { id: ok.tabId } });
    check('페이지 주소의 q 를 검색어로 우선', rsPage.query === '고양이 백팩', rsPage.query);
    const rsNone = await G.rankSearchItemsForTab({ url: 'https://www.coupang.com/np/search?q=x', items: 'nope' }, { tab: { id: ok.tabId } });
    check('items 없으면 ok:false', rsNone.ok === false && typeof rsNone.error === 'string');
    const envD = makeChrome();
    const GD = load(envD);
    const rsDef = await GD.rankSearchItemsForTab({ url: GD.categorySearchUrl(Q), items: fx() }, { tab: { id: 5 } });
    check('순위 탭·lastCategoryRank 모두 없으면 기본 가중치(.2/.3/.5)', rsDef.ok === true && rsDef.priority === '안전성 우대' && Math.abs(rsDef.weights.safety - 0.5) < 1e-9, J(rsDef.weights));

    check('tabs.onRemoved 리스너 등록', env.removedListeners.length === 1);
    env.removedListeners.forEach((fn) => fn(ok.tabId));
    for (let i = 0; i < 30; i++) await Promise.resolve();
    check('탭이 닫히면 rankTabs 항목 삭제 (다른 탭은 유지)', !(String(ok.tabId) in env.session.rankTabs) && (String(ok2.tabId) in env.session.rankTabs), J(Object.keys(env.session.rankTabs)));
  }

  section('rankTabs 쓰기 직렬화 — 동시 클릭');
  {
    const env = makeChrome();
    const G = load(env);
    const url = G.categorySearchUrl(Q);
    // 기다리지 않고 동시에 세 번 → 읽기-고치기-쓰기가 겹치면 앞 항목이 사라진다(예전 버그)
    const results = await Promise.all([
      G.openRankedSearch({ searchUrl: url, query: Q }),
      G.openRankedSearch({ searchUrl: url, query: Q }),
      G.openRankedSearch({ searchUrl: url, query: Q }),
    ]);
    const keys = Object.keys(env.session.rankTabs || {});
    check('동시 3회 열기 → rankTabs 항목 3개 모두 남는다', results.every((x) => x.ok) && keys.length === 3 && results.every((x) => keys.includes(String(x.tabId))), J(keys));
    // 닫기와 열기가 겹쳐도 다른 항목은 지켜진다
    env.removedListeners.forEach((fn) => fn(results[0].tabId));
    const r4 = await G.openRankedSearch({ searchUrl: url, query: Q });
    for (let i = 0; i < 30; i++) await Promise.resolve();
    const keys2 = Object.keys(env.session.rankTabs || {});
    check('닫힘·열림이 겹쳐도 닫힌 탭만 빠진다', !keys2.includes(String(results[0].tabId)) && keys2.includes(String(r4.tabId)) && keys2.includes(String(results[1].tabId)) && keys2.includes(String(results[2].tabId)), J(keys2));
  }
}

if (F) {
  runAsync().then(finish, function (e) {
    check('비동기 검사 실행', false, errText(e));
    finish();
  });
} else {
  finish();
}

// 정상이라면 finish() 의 $.exit 로 여기까지 오지 않는다. 여기 왔다면 비동기 검사가 끝나지 않은 것이다.
if (!IS_NODE) throw new Error('비동기 검사 결과가 출력되지 않았습니다 — Promise 가 끝나지 않았습니다.');
