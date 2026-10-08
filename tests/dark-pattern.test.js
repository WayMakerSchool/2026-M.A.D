/**
 * 다크패턴 텍스트 규칙 테스트
 *
 * content-script.js 의 DARK_PATTERN_RULES 를 실제 소스에서 잘라내 검증한다.
 * 탐지(positive)뿐 아니라 **오탐 방지(negative)** 도 같이 본다 — 오탐이 잦으면
 * 사용자가 경고를 무시하게 되어 기능 자체가 무력해지기 때문이다.
 *
 * 실행 (저장소 루트에서):
 *   node tests/dark-pattern.test.js
 *   osascript -l JavaScript tests/dark-pattern.test.js
 */

function readFile(path) {
  if (typeof require === 'function') return require('fs').readFileSync(path, 'utf8');
  ObjC.import('Foundation');
  return ObjC.unwrap(
    $.NSString.stringWithContentsOfFileEncodingError($(path), $.NSUTF8StringEncoding, null)
  );
}

const src = readFile('content-script.js');
if (!src) throw new Error('content-script.js 를 읽지 못했습니다. 저장소 루트에서 실행하세요.');

const start = src.indexOf('const DARK_PATTERN_RULES = [');
const end = src.indexOf('\n];', start);
if (start < 0 || end < 0) throw new Error('DARK_PATTERN_RULES 를 찾지 못했습니다.');
const RULES = new Function('return ' + src.slice(start + 'const DARK_PATTERN_RULES = '.length, end + 2))();

function match(text) {
  return RULES.filter(r => r.re.test(text)).map(r => r.id);
}

// [설명, 문구, 기대되는 규칙 id (null = 아무것도 걸리면 안 됨)]
const POSITIVE = [
  ['카운트다운',        '이 가격 남은 시간 3분 12초', 'dp-urgency'],
  ['마감 임박',         '오늘 자정 마감! 놓치지 마세요', 'dp-urgency'],
  ['가짜 사회적 증거',  '지금 내 지역 48명 구매 성공', 'dp-social-sales'],
  ['조회수 압박',       '지금 127명이 이 상품을 보고 있어요', 'dp-social-live'],
  ['플랫폼 판매 집계',  '한 달간 8,000명 이상 구매했어요', 'dp-social-sales'],
  ['장바구니 실시간',   '지금 32명이 장바구니에 담았어요', 'dp-social-live'],
  ['재고 압박',         '품절 임박! 단 3개 남음', 'dp-stock'],
  ['수량 압박',         '이제 2개 밖에 남았어요', 'dp-stock'],
  ['숨은 자동결제',     '첫 달 무료 이후 매월 자동 결제됩니다', 'dp-subscription'],
  ['무료체험 함정',     '무료 체험 신청하기 · 종료 후 정기 결제 전환', 'dp-subscription'],
  ['확인 쉐이밍',       '괜찮아요, 손해 볼래요', 'dp-confirmshaming'],
  ['혜택 포기 유도',    '아니요, 정가로 구매할게요', 'dp-confirmshaming'],
  ['취소 방해',         '해지는 고객센터 전화로만 가능합니다', 'dp-roachmotel'],
  ['탈퇴 방해',         '탈퇴 신청은 상담원 연결로만 접수됩니다', 'dp-roachmotel'],
];

// 정상 쇼핑몰 문구 — 하나도 걸리면 안 된다
const NEGATIVE = [
  ['일반 배송 안내',    '무료배송 · 3일 이내 도착 예정'],
  ['리뷰 개수',         '상품평 1,024건 · 평점 4.7'],
  ['정상 재고 표기',    '재고가 충분하여 즉시 출고됩니다'],
  ['정상 문의 안내',    '교환 및 환불은 고객센터로 문의 가능합니다'],
  ['정상 상품 설명',    '무선 선풍기 3단 풍량 조절, 최대 20시간 연속 사용'],
  ['정상 결제 안내',    '카드 결제 시 최대 4% 캐시적립'],
  ['정상 마감 없음',    '이 상품은 상시 판매 상품입니다'],
];

const lines = [];
let failed = 0;

lines.push('  [탐지되어야 하는 문구]');
for (const [name, text, wantId] of POSITIVE) {
  const hits = match(text);
  const ok = hits.includes(wantId);
  if (!ok) failed++;
  lines.push('  ' + (ok ? 'PASS  ' : 'FAIL  ') + name + '  →  ' + (hits.join(', ') || '(탐지 없음)'));
  if (!ok) lines.push('        기대: ' + wantId + '   |  문구: ' + text);
}

lines.push('');
lines.push('  [오탐되면 안 되는 정상 문구]');
for (const [name, text] of NEGATIVE) {
  const hits = match(text);
  const ok = hits.length === 0;
  if (!ok) failed++;
  lines.push('  ' + (ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : '  →  오탐: ' + hits.join(', ')));
  if (!ok) lines.push('        문구: ' + text);
}

// ── 실시간/집계 상호 배제 ─────────────────────────────────────
// 집계("N명 구매")는 리뷰 수로 검증해 제외할 수 있지만 실시간("N명이 보는 중")은 검증
// 불가라 무조건 유지된다. 한 문구가 두 규칙에 모두 걸리면 집계를 검증으로 걸러도
// 실시간 경고가 남아 분리한 의미가 없어지므로, 서로의 규칙에 걸리지 않는지 본다.
lines.push('');
lines.push('  [실시간/집계 상호 배제]');
const EXCLUSION_CASES = [
  ['집계 문구는 live 에 안 걸림',    '지금 내 지역 48명 구매 성공', 'dp-social-live'],
  ['실시간 문구는 sales 에 안 걸림', '지금 127명이 이 상품을 보고 있어요', 'dp-social-sales'],
  // "구매 중"은 두 규칙의 동사군이 겹치던 지점 — 집계 쪽 부정 전방탐색 (?!\s*중) 으로 제외했다
  ['"구매 중"은 sales 에 안 걸림',   '지금 12명이 구매 중이에요',          'dp-social-sales', 'dp-social-live'],
];
let exChecked = 0;
// 네 번째 값(mustId)이 있으면 그 규칙에는 반드시 걸려야 한다 — 양쪽 다 빠지는 미탐도 함께 막는다
for (const [name, text, mustNotId, mustId] of EXCLUSION_CASES) {
  exChecked++;
  const hits = match(text);
  const ok = !hits.includes(mustNotId) && (!mustId || hits.includes(mustId));
  if (!ok) failed++;
  lines.push('  ' + (ok ? 'PASS  ' : 'FAIL  ') + name + '  →  ' + (hits.join(', ') || '(탐지 없음)'));
  if (!ok) lines.push('        걸리면 안 됨: ' + mustNotId + (mustId ? '  / 걸려야 함: ' + mustId : '') + '   |  문구: ' + text);
}

// ── 판정 메타데이터 완결성 ─────────────────────────────────────
// 모든 규칙은 공정위 유형(fairType)과 안내문(message)을 반드시 가진다.
// "무슨 공적 기준으로 경고하는가"를 못 대는 규칙은 출고할 수 없다 (출력 원칙).
lines.push('');
lines.push('  [규칙 메타데이터 — 근거·유형 필수]');
let metaChecked = 0;
for (const r of RULES) {
  metaChecked++;
  const ok = typeof r.fairType === 'string' && r.fairType.length > 0
    && typeof r.message === 'string' && r.message.length > 0
    && typeof r.law === 'boolean'
    && r.re instanceof RegExp;
  if (!ok) failed++;
  lines.push('  ' + (ok ? 'PASS  ' : 'FAIL  ') + r.id + '  →  ' + (r.fairType || '(fairType 없음)'));
}

// ── 근거(evidence) 추출 — 매칭 문구가 실제로 잘려 나오는지 ──────
lines.push('');
lines.push('  [근거 문구 추출]');
const EVIDENCE_CASES = [
  ['재고 압박 근거',   '한정수량! 단 3개 남음 서두르세요', 'dp-stock', '단 3개 남'],
  ['카운트다운 근거',  '특가 마감까지 남은 시간 12분 34초', 'dp-urgency', '남은 시간'],
];
let evChecked = 0;
for (const [name, text, ruleId, expectPart] of EVIDENCE_CASES) {
  evChecked++;
  const rule = RULES.find(r => r.id === ruleId);
  const m = rule ? text.match(rule.re) : null;
  const evidence = m ? m[0].trim() : '';
  const ok = evidence.includes(expectPart);
  if (!ok) failed++;
  lines.push('  ' + (ok ? 'PASS  ' : 'FAIL  ') + name + '  →  "' + evidence + '"');
}

// ── 카운트다운 파서 (시간 관측 · evidenceLevel 2 승격의 기초) ───
// content-script.js 의 parseCountdownSeconds 를 원본에서 잘라내 검증한다.
const pcStart = src.indexOf('const parseCountdownSeconds = (raw) => {');
const pcEnd = src.indexOf('\n};', pcStart);
if (pcStart < 0 || pcEnd < 0) throw new Error('parseCountdownSeconds 를 찾지 못했습니다.');
const parseCountdownSeconds = new Function(
  'return ' + src.slice(pcStart + 'const parseCountdownSeconds = '.length, pcEnd + 2)
)();

lines.push('');
lines.push('  [카운트다운 파서]');
const CD_CASES = [
  ['분:초',            '12:34',            12 * 60 + 34],
  ['시:분:초',         '1:02:03',          3723],
  ['한국어 분·초',     '3분 12초',          192],
  ['한국어 시간·분',   '1시간 20분',        4800],
  ['스펙 문구(비시간)', '최대 20시간 연속 사용', null],
  ['평점(비시간)',     '평점 4.7',          null],
  ['잘못된 초(60)',    '01:60',            null],
];
let cdChecked = 0;
for (const [name, input, want] of CD_CASES) {
  cdChecked++;
  const got = parseCountdownSeconds(input);
  const ok = got === want;
  if (!ok) failed++;
  lines.push('  ' + (ok ? 'PASS  ' : 'FAIL  ') + name + '  "' + input + '" → ' + got + (ok ? '' : '  (기대: ' + want + ')'));
}

// ── 판매 집계 교차검증 ────────────────────────────────────────
// content-script.js 의 assessSalesClaim 을 원본에서 잘라내 검증한다.
// 함수가 참조하는 SALES_PER_REVIEW_MAX(리뷰 1건당 구매 상한)는 소스의 값 20 을 그대로 주입한다.
const asStart = src.indexOf('const assessSalesClaim = (evidence, reviewCount) => {');
const asEnd = src.indexOf('\n};', asStart);
if (asStart < 0 || asEnd < 0) throw new Error('assessSalesClaim 를 찾지 못했습니다.');
const assessSalesClaim = new Function(
  'SALES_PER_REVIEW_MAX',
  'return ' + src.slice(asStart + 'const assessSalesClaim = '.length, asEnd + 2)
)(20);

lines.push('');
lines.push('  [판매 집계 교차검증]');
// [설명, 근거 문구, 리뷰 수, 기대 verdict, 기대 n]
const SALES_CASES = [
  ['쿠팡 공식 집계(리뷰 11,394건)', '한 달간 8,000명 이상 구매했어요', 11394, 'corroborated', 8000],
  ['리뷰 3건에 12,000명',          '12,000명이 구매했어요',          3,     'suspicious',   12000],
  ['리뷰 수 없음',                 '500명이 구매했어요',             null,  'unverifiable', 500],
  ['리뷰 2건에 48명',              '지금 내 지역 48명 구매 성공',     2,     'suspicious',   48],
  ['숫자 없는 문구',               '구매했어요',                     100,   'unknown',      null],
  ['리뷰 0건에 60명',              '60명이 구매했어요',              0,     'suspicious',   60],
  ['리뷰 0건에 30명',              '30명이 구매했어요',              0,     'unverifiable', 30],
];
let salesChecked = 0;
for (const [name, text, reviews, wantVerdict, wantN] of SALES_CASES) {
  salesChecked++;
  const got = assessSalesClaim(text, reviews);
  const ok = got.verdict === wantVerdict && got.n === wantN;
  if (!ok) failed++;
  lines.push('  ' + (ok ? 'PASS  ' : 'FAIL  ') + name + '  →  ' + got.verdict + ' (n=' + got.n + ')'
    + (ok ? '' : '  (기대: ' + wantVerdict + ', n=' + wantN + ')'));
}

// ── 리뷰 수 파서 (판매 집계 교차검증의 기준값) ──────────────────
// content-script.js 의 parseReviewCountText 를 원본에서 잘라내 검증한다. 이 값이 틀리면
// 쿠팡 "한 달간 8,000명 이상 구매"(리뷰 11,394건) 같은 공식 집계를 과장으로 오판한다.
// 숫자가 키워드 앞("11,394 개 상품평")이든 뒤("리뷰 1,024")든 읽고, 평점(4.5)은 리뷰 수로 쓰지 않아야 한다.
const rcStart = src.indexOf('const parseReviewCountText = (raw) => {');
const rcEnd = src.indexOf('\n};', rcStart);
if (rcStart < 0 || rcEnd < 0) throw new Error('parseReviewCountText 를 찾지 못했습니다.');
const parseReviewCountText = new Function(
  'return ' + src.slice(rcStart + 'const parseReviewCountText = '.length, rcEnd + 2)
)();

lines.push('');
lines.push('  [리뷰 수 파서]');
// [설명, 입력, 기대 리뷰 수 (null = 리뷰 수로 읽으면 안 됨)]
const RC_CASES = [
  ['쿠팡 숫자 앞',          '11,394 개 상품평',                 11394],
  ['평점+괄호 안 숫자 앞',  '★4.5 (11,394개 상품평)',           11394],
  ['키워드 뒤',             '리뷰 1,024',                       1024],
  ['키워드 뒤 괄호',        '상품평(11,394)',                   11394],
  ['평점과 함께',           '평점 4.7 · 상품평 1,024건',        1024],
  ['평점은 리뷰 수 아님',   '리뷰 4.5',                         null],
  ['판매 집계는 리뷰 아님', '한 달간 8,000명 이상 구매했어요',  null],
  ['빈 문자열',             '',                                 null],
  ['null',                  null,                               null],
  ['구매평 N건',            '구매평 19건',                      19],
  ['판매자 평가',           '판매자 평가 19',                   19],
  ['리뷰 0건',              '후기 0',                           0],
];
let rcChecked = 0;
for (const [name, input, want] of RC_CASES) {
  rcChecked++;
  let got;
  try { got = parseReviewCountText(input); } catch (e) { got = 'ERROR: ' + e.message; }
  const ok = got === want;
  if (!ok) failed++;
  lines.push('  ' + (ok ? 'PASS  ' : 'FAIL  ') + name + '  ' + JSON.stringify(input) + ' → ' + got + (ok ? '' : '  (기대: ' + want + ')'));
}

const total = POSITIVE.length + NEGATIVE.length + metaChecked + evChecked + cdChecked + exChecked + salesChecked + rcChecked;
lines.push('');
lines.push(failed === 0 ? '  ✅ ' + total + '개 전부 통과' : '  ❌ ' + total + '개 중 ' + failed + '건 실패');

const report = lines.join('\n');
if (typeof process !== 'undefined' && process.versions && process.versions.node) {
  console.log(report);
  if (failed > 0) process.exit(1);
}
report;
