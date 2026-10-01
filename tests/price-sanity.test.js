/**
 * 가격 유효성 검증(sanity check) 테스트
 *
 * content-script.js 의 resolvePrice() 를 실제 소스에서 잘라내 실행한다.
 * 로직을 복붙해 검증하면 원본이 바뀌어도 테스트가 통과해버리므로, 원본을 직접 읽는다.
 *
 * 실행 (저장소 루트에서):
 *   node tests/price-sanity.test.js
 * node 가 없는 환경에서는:
 *   osascript -l JavaScript tests/price-sanity.test.js
 */

// ── 런타임 호환 (node / osascript JXA) ─────────────────────────
function readFile(path) {
  if (typeof require === 'function') return require('fs').readFileSync(path, 'utf8');
  ObjC.import('Foundation');
  return ObjC.unwrap(
    $.NSString.stringWithContentsOfFileEncodingError($(path), $.NSUTF8StringEncoding, null)
  );
}

const SRC_PATH = 'content-script.js';
const src = readFile(SRC_PATH);
if (!src) throw new Error(SRC_PATH + ' 를 읽지 못했습니다. 저장소 루트에서 실행하세요.');

// 검증 대상 함수 정의만 잘라낸다
function slice(startMarker, endMarker) {
  const i = src.indexOf(startMarker);
  const j = src.indexOf(endMarker, i);
  if (i < 0 || j < 0) throw new Error('소스에서 찾지 못함: ' + startMarker);
  return src.slice(i, j);
}
const DEFS =
  slice('const parseWon = (t) => {', '// 직전 getBestOriginalPrice') + '\n' +
  slice('const resolvePrice = () => {', '\nconst collectShoppingData');

// DOM 대신 세 소스를 직접 주입해 resolvePrice 를 호출한다
function callResolvePrice(dom, ld, og) {
  const fn = new Function('DOM', 'LD', 'OG',
    'var selectors = { price: [] };' +
    'var getValidPriceText = function () { return DOM; };' +
    'var getJsonLdPrice    = function () { return LD; };' +
    'var getMetaContent    = function () { return OG; };' +
    'var PRICE_DISAGREE_RATIO = 4; var PRICE_ABSURD_MAX = 500000000;' +
    DEFS + '\nreturn resolvePrice();');
  return fn(dom, ld, og);
}

// ── 케이스 ─────────────────────────────────────────────────────
// [설명, DOM 표시가, JSON-LD, og:price, 기대 채택가, 기대 신뢰도]
const CASES = [
  ['정상: DOM·JSON-LD 일치',            '1838000',  '1838000', null,     1838000, 'high'],
  ['10배 오추출 → JSON-LD로 교정',       '18380000', '1838000', null,     1838000, 'medium'],
  ['자릿수오염 "11% 1,838,000원"',       '111838000','1838000', null,     1838000, 'medium'],
  ['옵션 가격차(1.5배)는 DOM 유지',      '150000',   '100000',  null,     150000,  'high'],
  ['DOM 단독 → 저신뢰',                  '29900',    null,      null,     29900,   'low'],
  ['DOM 미검출 → JSON-LD 사용',          null,       '29900',   null,     29900,   'medium'],
  ['og가 MSRP(3.5배) — 값은 DOM 유지',   '24040',    null,      '83500',  24040,   'medium'],
  ['og 근접해도 high 아님',              '24040',    null,      '24040',  24040,   'medium'],
  ['og가 20배 어긋남 → 저신뢰',          '24040',    null,      '500000', 24040,   'low'],
  ['가격 미검출',                        null,       null,      null,     null,    'none'],
  ['비정상 초대형 값 기각',              '999999999',null,      null,     null,    'none'],
  ['경계: 정확히 4배는 불일치 처리',      '400000',   '100000',  null,     100000,  'medium'],
  ['경계: 3.9배는 통과',                 '390000',   '100000',  null,     390000,  'high'],
];

const lines = [];
let failed = 0;
for (const [name, dom, ld, og, wantValue, wantConf] of CASES) {
  let r;
  try {
    r = callResolvePrice(dom, ld, og);
  } catch (e) {
    lines.push('  ERROR ' + name + ' -> ' + e.message);
    failed++;
    continue;
  }
  const ok = r.value === wantValue && r.confidence === wantConf;
  if (!ok) failed++;
  lines.push((ok ? '  PASS  ' : '  FAIL  ') + name);
  lines.push('         value=' + r.value + '  confidence=' + r.confidence + '  | ' + r.note);
  if (!ok) lines.push('         기대: value=' + wantValue + ' confidence=' + wantConf);
}
lines.push('');
lines.push(failed === 0
  ? '  ✅ ' + CASES.length + '개 전부 통과'
  : '  ❌ ' + CASES.length + '개 중 ' + failed + '건 실패');

const report = lines.join('\n');
if (typeof process !== 'undefined' && process.versions && process.versions.node) {
  console.log(report);
  if (failed > 0) process.exit(1);
}
report; // osascript 는 마지막 표현식을 출력한다
