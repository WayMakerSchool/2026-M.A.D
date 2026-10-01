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
  ['가짜 사회적 증거',  '지금 내 지역 48명 구매 성공', 'dp-social'],
  ['조회수 압박',       '지금 127명이 이 상품을 보고 있어요', 'dp-social'],
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

const total = POSITIVE.length + NEGATIVE.length + metaChecked + evChecked + cdChecked;
lines.push('');
lines.push(failed === 0 ? '  ✅ ' + total + '개 전부 통과' : '  ❌ ' + total + '개 중 ' + failed + '건 실패');

const report = lines.join('\n');
if (typeof process !== 'undefined' && process.versions && process.versions.node) {
  console.log(report);
  if (failed > 0) process.exit(1);
}
report;
