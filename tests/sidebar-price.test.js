/**
 * 사이드바 "가격 미확인" 카드 테스트
 *
 * 배경: 베타에서 사이드바가 Gemini 가 지어낸 최저가("네이버쇼핑 약 1,650,000원")를 가격 카드로 보여주고,
 * 그 카드가 가디언 점수 1위까지 받았다. background.js 는 더 이상 가격을 묻지 않지만, 사이드바는
 * 로컬 캐시·24시간 공유 캐시에 남은 예전 분석 결과(sameProductAlts[].estimatedPrice 등)를 그대로 쓴다.
 * 그래서 사이드바 번들에서 출처와 무관하게 막는다 — 팀 원칙: "모르는 건 모른다고 표시한다."
 *   - 카드 생성: estimatedPrice 를 읽지 않는다. price 0 + estimated 표시 + 검색 링크만 남긴다.
 *   - 표시: 추정 카드는 숫자 대신 "가격 확인하기 ›" / "가격 미확인".
 *   - 가디언 점수(dL): 추정 카드는 점수 Map 에 넣지 않고, 최소·최대 가격 계산에서도 뺀다.
 *   - 정렬: 추정 카드는 모든 우선순위 분기에서 맨 뒤.
 *
 * A안(쿠팡 검색 결과 백그라운드 수집) 이후 추가된 원칙:
 *   - 검색 링크 카드(gs-/ga-)는 아예 만들지 않는다. "검색 페이지로 대체하지 않는다."
 *   - np- 카드는 background 가 만든 card 객체(계약 3)로 덮어쓴다. 배지 "실시간 최저가"·"네이버쇼핑 API" 문구는 없다.
 *   - 가디언 점수(dL): background 가 계산한 scores 가 있으면 그대로 쓴다. fL: dataInsufficient 카드는 1위가 될 수 없다.
 *   - 보러가기·결제·찜 버튼: url 이 없으면 검색 페이지로 보내지 않고 아무것도 하지 않는다.
 *
 * 번들(sidebar/assets/index-DF11T7pu.js)은 minified React 빌드다. 로직을 복붙해 검증하면 번들이 바뀌어도
 * 테스트가 통과해버리므로, 검증 대상 함수·식을 번들에서 직접 잘라내 new Function 으로 평가한다.
 * 잘라내기에 쓰는 앵커 문자열이 사라지면 그 자체를 FAIL 로 보고한다.
 *
 * 실행 (저장소 루트에서):
 *   node tests/sidebar-price.test.js
 *   osascript -l JavaScript tests/sidebar-price.test.js
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

const SRC_PATH = 'sidebar/assets/index-DF11T7pu.js';
const src = readFile(SRC_PATH);
if (!src) throw new Error(SRC_PATH + ' 를 읽지 못했습니다. 저장소 루트에서 실행하세요.');

// ── 보고 ───────────────────────────────────────────────────────
const lines = [];
let failed = 0;
let total = 0;
function check(name, ok, detail) {
  total++;
  if (!ok) failed++;
  lines.push((ok ? '  PASS  ' : '  FAIL  ') + name + (!ok && detail !== undefined ? '\n         ' + detail : ''));
}
function section(title) { lines.push(''); lines.push('  [' + title + ']'); }
// JXA 의 e.stack 에는 메시지가 없어(호출 위치만 나온다) 이름·메시지를 직접 붙인다
const errText = (e) => (e && e.message ? (e.name || 'Error') + ': ' + e.message : String(e));
function safe(name, fn) {
  try { fn(); } catch (e) { check(name + ' — 예외', false, errText(e)); }
}
const J = (v) => JSON.stringify(v);

function count(sub) { return src.split(sub).length - 1; }

// 여는 괄호 위치에서 짝이 맞는 닫는 괄호 위치를 찾는다. "…" '…' 문자열은 건너뛴다.
// 템플릿 리터럴(`)은 ${} 안에 코드가 들어가 이 단순 스캐너로는 안전하지 않으므로 만나면 예외를 던진다
// (잘라내는 dL·p2·fL·정렬 비교함수에는 템플릿 리터럴이 없다 — 있으면 테스트가 실패로 알려준다).
// 정규식 리터럴 /로켓|당일|익일/ 등에는 괄호·따옴표가 없어 그대로 지나가도 된다.
function matchClose(text, openIdx) {
  const open = text[openIdx];
  const close = open === '{' ? '}' : open === '(' ? ')' : null;
  if (!close) throw new Error('여는 괄호가 아님: ' + open);
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'") {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === '\\') i++;
      continue;
    }
    if (c === '`') throw new Error('템플릿 리터럴을 만나 짝 찾기를 중단 (위치 ' + i + ')');
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return i; }
  }
  throw new Error('짝이 맞는 ' + close + ' 를 찾지 못함');
}
// "function 이름(…){" 로 시작하는 함수 정의 전체를 잘라낸다
function sliceFunction(header) {
  const i = src.indexOf(header);
  if (i < 0 || src.indexOf(header, i + 1) >= 0) throw new Error('함수 머리가 없거나 2회 이상: ' + header);
  const open = i + header.length - 1;
  return src.slice(i, matchClose(src, open) + 1);
}
function anchorOnce(a) {
  const i = src.indexOf(a);
  if (i < 0) throw new Error('앵커 없음: ' + a);
  if (src.indexOf(a, i + 1) >= 0) throw new Error('앵커가 2회 이상: ' + a);
  return i;
}

// ════════════════════════════════════════════════════════════
section('a) 정적 검사 — 번들 문자열');
// [설명, 문자열, 기대 횟수]
const STATIC = [
  ['추천 카드에 "약 " 접두 없음',                  'P.estimated?"약 "', 0],
  ['결제 패널에 "약 " 접두 없음',                  'e.estimated?"약 "', 0],
  ['카드 생성이 estimatedPrice 를 숫자로 읽지 않음', 'Number(we.estimatedPrice)', 0],
  ['카드 생성이 we.estimatedPrice 를 아예 읽지 않음', 'we.estimatedPrice', 0],
  ['추천 카드 가격 자리 "가격 확인하기 ›"',          '"가격 확인하기 ›"', 1],
  ['추천 카드: 추정이면 숫자 대신 링크 문구',        'children:P.estimated?["가격 확인하기 ›"]:[P.price.toLocaleString(),"원"]', 1],
  ['dL 루프가 추정 카드를 건너뜀',                  'if(g.estimated)continue;', 1],
  ['dL 최소·최대에서 추정 카드 제외',               'const s=n.filter(g=>!g.estimated).map(g=>g.price).filter(g=>g>0)', 1],
  ['옛 문구 "AI 추정가 · 실제 가격 아님" 없음',      'AI 추정가 · 실제 가격 아님', 0],
  ['옛 태그 "AI 추정 · 실제 가격 아님" 없음',        'AI 추정 · 실제 가격 아님', 0],
  ['옛 배지 "· AI 추정가" 없음',                   '· AI 추정가`', 0],
  ['결제 패널 가격: 추정이면 "가격 미확인"',          'children:e.estimated?["가격 미확인"]:[T.toLocaleString(),"원"]', 1],
  ['결제 패널 할인액: 추정 카드는 계산 안 함',        'b=e&&!e.estimated&&Wcur!=null?Wcur-e.price:null', 1],
  // 결제 패널의 추정 카드 버튼: url 이 있을 때만 연다(검색 폴백 없음)
  ['결제 패널: 추정 카드는 url 있을 때만 이동',       'e.estimated?f.jsxs("button",{onClick:()=>{e.url&&gL(e.url)},', 1],
  ['i18n pc.estimated (ko)',                     'ko:"가격 미확인 · 쇼핑몰에서 확인"', 1],
  ['i18n pc.estimated (en)',                     'en:"Price unverified — check on the store"', 1],
  ['비교표(yL): 추정이면 "가격 미확인"',             'children:T.estimated?["가격 미확인"]:[((O=T.estimatedPrice)', 1],
  // 가격 0 이거나, 베타 때 찜한 AI 추정 카드(id gs-/ga-)면 저장된 가격이 지어낸 값이라 숨긴다
  ['찜 목록: 가격 0 또는 AI 추정 카드(gs-/ga-)면 "가격 미확인"', 'children:D.price>0&&!/^g[sa]-/.test(String(D.id))?[D.price.toLocaleString(),"원"]:["가격 미확인"]', 1],
  // ── A안: 쿠팡 검색 결과 기반 추천 ──
  ['옛 배지 "실시간 최저가" 없음',                    'badge:"실시간 최저가"', 0],
  ['"네이버쇼핑 API" 문구 없음',                      '네이버쇼핑 API', 0],
  ['np- 카드가 background 의 card 객체로 덮어씀',      '...(Re.card||{})', 1],
  ['np- 카드는 최대 3장',                            'Ee=Qe.items.slice(0,3).map((Re,De)=>({id:`np-${De}`', 1],
  ['marketLowestPrice 는 후보 중 실제 최저가(Qe.lowest)', '$e=Qe.lowest||Qe.items[0]', 1],
  ['background 의 note 를 상태 문구로 표시',           'Qe.note&&Ht(Qe.note)', 1],
  ['dL: background 점수(scores)가 있으면 그대로 사용', 'if(g.scores){t.set(String(g.id),g.scores);continue;}', 1],
  ['fL: 데이터 부족 카드는 가디언 1위 불가',           '!a.dataInsufficient&&', 1],
  ['검색 링크 카드 gs- 생성식이 빈 배열',              'Re=[].map(', 1],
  ['검색 링크 카드 ga- 생성식이 빈 배열',              'De=[].map(', 1],
  ['sameProductAlts 로 카드를 만들지 않음',            '(ce.sameProductAlts||[]).filter(', 0],
  ['alternativeProducts 로 카드를 만들지 않음',        '(ce.alternativeProducts||[]).filter(', 0],
  ['보러가기: url 없으면 아무것도 안 함',              'const de=P.url||(P.type==="optimal"&&v?v:void 0);if(!de)return;', 1],
  ['찜 목록 개별 버튼: url 없으면 아무것도 안 함',      'onClick:()=>{const re=D.url;if(!re)return;O(re)}', 1],
  ['찜 목록 전체 실행: url 없는 항목은 건너뜀',         'E.forEach(D=>{const re=D.url;if(!re)return;O(re)})', 1],
  // 버튼 onClick 의 검색 폴백(…search/all?query=${encodeURIComponent(…)})은 전부 없어야 한다.
  // 잔존 허용: $e 검색 URL 조립 함수 본문(…${tt}&sort=price_asc, 죽은 코드)과 RM 폴백 분석의 미사용 변수.
  ['버튼 onClick 검색 폴백 없음',                     'search/all?query=${encodeURIComponent(', 0],
  ['$e 검색 URL 함수 본문은 죽은 코드로 1곳 잔존',     'search/all?query=${tt}&sort=price_asc', 1],
];
for (const [name, sub, want] of STATIC) {
  const got = count(sub);
  check(name + '  (' + got + '회)', got === want, '기대 ' + want + '회, 실제 ' + got + '회: ' + sub);
}

// ════════════════════════════════════════════════════════════
section('b) 가디언 점수 dL — 번들에서 잘라내 실행');
let dL = null, fL = null;
safe('dL·fL 잘라내기', () => {
  // const Yh=…,hL=[…];function p2(n){…}function dL(n,e){…} 는 번들에서 연달아 있다.
  // dL 이 쓰는 보조 식별자: Yh(0~100 반올림), hL(주요 쇼핑몰 목록), p2(우선순위별 가중치). 스텁 없음.
  const start = anchorOnce('const Yh=n=>');
  const dlSrc = sliceFunction('function dL(n,e){');
  const dlStart = src.indexOf('function dL(n,e){');
  if (dlStart < start || dlStart - start > 2000) throw new Error('Yh·hL·p2 와 dL 이 연달아 있지 않습니다');
  const prelude = src.slice(start, dlStart);           // const Yh=…,hL=[…];function p2(n){…}
  const p2Src = sliceFunction('function p2(n){');
  if (prelude.indexOf(p2Src) < 0) throw new Error('p2 정의가 dL 앞 구간에 없습니다');
  const flSrc = sliceFunction('function fL(n,e){');
  const factory = new Function(prelude + dlSrc + '\n' + flSrc + '\nreturn { dL: dL, fL: fL };');
  const m = factory();
  dL = m.dL; fL = m.fL;
  check('dL·fL 잘라내 평가 (Yh·hL·p2 포함, 스텁 없음)', typeof dL === 'function' && typeof fL === 'function');
  // 잘라낸 dL 이 위 식별자 외에 다른 번들 식별자에 기대지 않는지: 실행이 ReferenceError 없이 끝나는지로 확인
});

function card(id, price, extra) {
  const c = { id: id, type: 'optimal', price: price, platform: '네이버쇼핑', tags: [] };
  for (const k in (extra || {})) c[k] = extra[k];
  return c;
}
const REAL_A = card('np-0', 1684700, { platform: '네이버쇼핑' });
const REAL_B = card('np-1', 1700000, { platform: '11번가' });
const EST_C = card('gs-0', 0, { estimated: true, platform: '네이버쇼핑', tags: ['가격 미확인 · 검색에서 확인'] });
const EST_D = card('gs-1', 0, { estimated: true, platform: '11번가', tags: ['가격 미확인 · 검색에서 확인'] });
// 혹시 가격이 남은 추정 카드가 들어와도(옛 캐시·다른 경로) 최소·최대를 오염시키면 안 된다
const EST_C_LEGACY = card('gs-0', 1650000, { estimated: true, platform: '네이버쇼핑' });
const EST_D_LEGACY = card('gs-1', 1660000, { estimated: true, platform: '11번가' });
const CTX = { priority: '가성비 우대', fakeRiskLabel: undefined, hasDarkPattern: false, hasSellerWarning: false };

if (dL) {
  safe('dL 기본 케이스', () => {
    const all = dL([EST_C, REAL_A, EST_D, REAL_B], CTX);
    const realOnly = dL([REAL_A, REAL_B], CTX);
    check('결과 Map 에 가격 미확인 카드 id 없음 (gs-0, gs-1)',
      !all.has('gs-0') && !all.has('gs-1'), '키: ' + J(Array.from(all.keys())));
    const a = all.get('np-0'), b = all.get('np-1');
    check('실가격 카드 2개는 점수 있음',
      !!a && !!b && typeof a.total === 'number' && typeof b.total === 'number', 'np-0=' + J(a) + ' np-1=' + J(b));
    check('1,684,700 쪽 가격 점수가 1,700,000 쪽보다 높음',
      !!a && !!b && a.price > b.price, 'np-0.price=' + (a && a.price) + ' np-1.price=' + (b && b.price));
    check('가격 미확인 카드를 빼고 계산한 결과와 점수가 같음',
      J(all.get('np-0')) === J(realOnly.get('np-0')) && J(all.get('np-1')) === J(realOnly.get('np-1')),
      '함께: ' + J([all.get('np-0'), all.get('np-1')]) + ' / 단독: ' + J([realOnly.get('np-0'), realOnly.get('np-1')]));
    check('Map 크기 = 실가격 카드 수(2)', all.size === 2, 'size=' + all.size);
  });

  safe('dL 옛 캐시 가격이 남은 추정 카드', () => {
    const all = dL([EST_C_LEGACY, REAL_A, EST_D_LEGACY, REAL_B], CTX);
    const realOnly = dL([REAL_A, REAL_B], CTX);
    check('추정 카드에 가격이 남아 있어도 점수 없음',
      !all.has('gs-0') && !all.has('gs-1'), '키: ' + J(Array.from(all.keys())));
    check('추정 카드 가격(1,650,000·1,660,000)이 최소·최대에 섞이지 않음',
      J(all.get('np-0')) === J(realOnly.get('np-0')) && J(all.get('np-1')) === J(realOnly.get('np-1')),
      '함께: ' + J([all.get('np-0'), all.get('np-1')]) + ' / 단독: ' + J([realOnly.get('np-0'), realOnly.get('np-1')]));
  });

  safe('dL 우선순위별', () => {
    for (const pri of ['안전성 우대', '배송속도 우대']) {
      const ctx = { priority: pri, fakeRiskLabel: '보통', hasDarkPattern: true, hasSellerWarning: false };
      const all = dL([EST_C, REAL_A, EST_D, REAL_B], ctx);
      const realOnly = dL([REAL_A, REAL_B], ctx);
      check(pri + ': 추정 카드 제외 + 실가격 점수 불변',
        !all.has('gs-0') && !all.has('gs-1') && all.size === 2 &&
        J(all.get('np-0')) === J(realOnly.get('np-0')) && J(all.get('np-1')) === J(realOnly.get('np-1')),
        J(Array.from(all.entries())));
    }
  });

  safe('dL 추정 카드만', () => {
    const only = dL([EST_C, EST_D], CTX);
    check('추정 카드만 있으면 빈 Map', only.size === 0, 'size=' + only.size);
  });

  safe('fL 가디언 1위', () => {
    // fL 은 Map 에 없는 id 를 건너뛴다(l&&l.total>s). 추정 카드를 앞에 둬도 1위는 실가격 카드여야 한다.
    const list = [EST_C, EST_D, REAL_B, REAL_A];
    const top = fL(list, dL(list, CTX));
    check('추정 카드가 앞에 있어도 1위는 실가격 카드', top === 'np-0' || top === 'np-1', 'top=' + top);
    check('추정 카드만이면 1위 없음(null)', fL([EST_C, EST_D], dL([EST_C, EST_D], CTX)) === null);
  });

  // A안: background 가 후보 전체(kept)를 보고 계산한 점수가 scores 로 온다.
  // 사이드바는 Top3 만 보므로 다시 계산하면 가격 축이 왜곡된다 → 그대로 써야 한다.
  const SC_A = { price: 92, quality: 81, safety: 70, total: 83 };
  const SC_B = { price: 55, quality: 40, safety: 70, total: 55 };
  const BG_A = card('np-0', 1684700, { platform: '쿠팡', scores: SC_A, rating: 4.7, reviewCount: 2341 });
  const BG_B = card('np-1', 1700000, { platform: '쿠팡', scores: SC_B, rating: 3.9, reviewCount: 12 });
  // 데이터 부족 카드: 평점·리뷰가 없어 background 가 quality 를 못 매긴 경우. total 이 가장 높아도 1위는 안 된다.
  const BG_INSUF = card('np-2', 1500000, { platform: '쿠팡', scores: { price: 100, quality: null, safety: 70, total: 95 }, dataInsufficient: true });

  safe('dL background 점수 그대로 사용', () => {
    const m = dL([BG_A, BG_B], CTX);
    check('scores 있는 카드는 Map 에 그 점수 객체가 그대로 들어감',
      m.get('np-0') === SC_A && m.get('np-1') === SC_B, J(Array.from(m.entries())));
    const mixed = dL([BG_A, REAL_B], CTX);
    check('scores 없는 카드는 기존대로 사이드바가 계산',
      mixed.get('np-0') === SC_A && !!mixed.get('np-1') && mixed.get('np-1') !== SC_B && typeof mixed.get('np-1').total === 'number',
      J(Array.from(mixed.entries())));
    const withEst = dL([EST_C, BG_A], CTX);
    check('추정 카드 제외는 scores 보다 먼저 적용', !withEst.has('gs-0') && withEst.get('np-0') === SC_A, J(Array.from(withEst.keys())));
  });

  safe('fL 데이터 부족 카드는 1위 불가', () => {
    const list = [BG_INSUF, BG_B, BG_A];
    const m = dL(list, CTX);
    check('데이터 부족 카드도 점수 Map 에는 있음(표시용)', m.get('np-2') && m.get('np-2').total === 95, J(m.get('np-2')));
    const top = fL(list, m);
    check('total 95 인 데이터 부족 카드 대신 83 인 np-0 이 1위', top === 'np-0', 'top=' + top);
    check('데이터 부족 카드만이면 1위 없음(null)', fL([BG_INSUF], dL([BG_INSUF], CTX)) === null);
  });
}

// ════════════════════════════════════════════════════════════
section('c) 정렬 비교함수 — 번들의 두 자리에서 잘라내 실행');
// 두 자리: ① 조건 적용 콜백(he.sort((et,yt)=>…)) ② ii.current useEffect(re.sort((he,Ie)=>…))
// 각 자리는 J==="가성비 우대"?X.sort(가성비):J==="배송속도 우대"?X.sort(배송):X.sort(안전성) 형태다.
const SORT_SITES = [
  { name: '자리1 (he)', v: 'he', p: ['et', 'yt'], expr: {
    cheap: '(et,yt)=>(!!et.estimated-!!yt.estimated)||et.price-yt.price',
    ship: 'return(!!et.estimated-!!yt.estimated)||Nt-ft}',
    safety: '(et,yt)=>(!!et.estimated-!!yt.estimated)||(yt.rating||0)-(et.rating||0)' } },
  { name: '자리2 (re)', v: 're', p: ['he', 'Ie'], expr: {
    cheap: '(he,Ie)=>(!!he.estimated-!!Ie.estimated)||he.price-Ie.price',
    ship: 'return(!!he.estimated-!!Ie.estimated)||et-yt}',
    safety: '(he,Ie)=>(!!he.estimated-!!Ie.estimated)||(Ie.rating||0)-(he.rating||0)' } },
];
function extractComparators(v) {
  // 가성비 → 배송속도 → 안전성 순으로 X.sort( 의 괄호 내용을 차례로 잘라낸다
  const out = [];
  let from = anchorOnce('J==="가성비 우대"?' + v + '.sort(');
  for (let k = 0; k < 3; k++) {
    const at = src.indexOf(v + '.sort(', from);
    if (at < 0 || at - from > 600) throw new Error(v + '.sort( 를 ' + (k + 1) + '번째에서 찾지 못함');
    const open = at + (v + '.sort').length;
    const close = matchClose(src, open);
    out.push(src.slice(open + 1, close));
    from = close;
  }
  return out;
}
for (const site of SORT_SITES) {
  safe(site.name, () => {
    const [cheapSrc, shipSrc, safetySrc] = extractComparators(site.v);
    check(site.name + ' 가성비: 새 비교식', cheapSrc === site.expr.cheap, '실제: ' + cheapSrc);
    check(site.name + ' 배송속도: 추정 카드 우선 비교', shipSrc.indexOf(site.expr.ship) >= 0, '실제: ' + shipSrc);
    check(site.name + ' 안전성: 새 비교식', safetySrc === site.expr.safety, '실제: ' + safetySrc);
    const cheap = new Function('return ' + cheapSrc)();
    const ship = new Function('return ' + shipSrc)();
    const safety = new Function('return ' + safetySrc)();

    // 명세 케이스: [{p:0,est:true},{p:1700000},{p:1684700}] → 실가격 오름차순 뒤에 미확인
    const spec = [{ id: 'e', price: 0, estimated: true }, { id: 'b', price: 1700000 }, { id: 'a', price: 1684700 }];
    const r1 = spec.slice().sort(cheap).map(x => x.id).join(',');
    check(site.name + ' 가성비: [미확인0, 1,700,000, 1,684,700] → a,b,e', r1 === 'a,b,e', '실제: ' + r1);

    // 섞인 목록 — 모든 분기에서 추정 카드가 맨 뒤
    const mixed = () => [
      { id: 'e1', price: 0, estimated: true, tags: ['가격 미확인 · 검색에서 확인'] },
      { id: 'B', price: 1700000, rating: 4.0, tags: [] },
      { id: 'e2', price: 0, estimated: true, tags: ['가격 미확인 · 검색에서 확인'] },
      { id: 'A', price: 1684700, tags: ['로켓배송'] },
    ];
    const ids = (cmp) => mixed().sort(cmp).map(x => x.id).join(',');
    const g = ids(cheap), s = ids(ship), f = ids(safety);
    check(site.name + ' 가성비 섞인 목록 → A,B,e1,e2', g === 'A,B,e1,e2', '실제: ' + g);
    check(site.name + ' 배송속도 섞인 목록 → A(로켓),B,e1,e2', s === 'A,B,e1,e2', '실제: ' + s);
    check(site.name + ' 안전성 섞인 목록 → B(평점),A,e1,e2', f === 'B,A,e1,e2', '실제: ' + f);
  });
}

// ════════════════════════════════════════════════════════════
section('d) 카드 생성 Re/De — 번들에서 잘라내 실행');
safe('검색 링크 카드 생성 안 함', () => {
  // const Ee=fe.currentPrice??0,$e=(검색 URL 생성·죽은 코드),Re=[].map(…),De=[].map(…),Je=ii.current…
  // A안 이후 Re/De 는 빈 배열이다. 옛 캐시에 sameProductAlts/alternativeProducts 가 남아 있어도 카드가 나오면 안 된다.
  const head = 'const Ee=fe.currentPrice??0,';
  const start = anchorOnce(head);
  const end = anchorOnce(',Je=ii.current.filter(we=>we.type==="alternative")');
  if (end < start || end - start > 3000) throw new Error('카드 생성 구간이 예상과 다릅니다');
  const region = src.slice(start, end);
  const reAt = region.indexOf('Re=[].map(');
  const deAt = region.indexOf('De=[].map(');
  if (reAt < 0 || deAt < 0) throw new Error('Re/De 빈 배열 생성식을 찾지 못함');
  const gen = region.slice(reAt);
  check('생성 구간이 ce.sameProductAlts 를 읽지 않음', gen.indexOf('sameProductAlts') < 0);
  check('생성 구간이 ce.alternativeProducts 를 읽지 않음', gen.indexOf('alternativeProducts') < 0);
  check('생성 구간이 we.estimatedPrice 를 읽지 않음', gen.indexOf('we.estimatedPrice') < 0);
  check('생성 구간에 .filter(we=>we&&we.platform) 없음', gen.indexOf('.filter(we=>we&&we.platform)') < 0);

  const build = new Function('ce', 'fe', region + ';return {Re: Re, De: De};');
  const fe = { productName: '삼성 갤럭시 북4 프로', currentPrice: 1838000, imageUrl: 'https://img.example/x.jpg' };

  // ① 옛 캐시(가격 포함) — 카드 자체가 나오면 안 된다
  const legacy = {
    sameProductAlts: [
      { platform: '네이버쇼핑', estimatedPrice: 1650000, reason: '최저가 검색', searchQuery: '갤럭시 북4 프로' },
      { platform: '11번가', estimatedPrice: 1660000, reason: '포인트 적립', searchQuery: '갤럭시 북4 프로' },
    ],
    alternativeProducts: [
      { productName: 'LG 그램 16', platform: '쿠팡', estimatedPrice: 1590000, searchQuery: 'LG 그램 16' },
    ],
  };
  const r = build(legacy, fe);
  check('옛 캐시: 같은 상품 검색 링크 카드 0장', Array.isArray(r.Re) && r.Re.length === 0, 'Re=' + J(r.Re));
  check('옛 캐시: 대안 검색 링크 카드 0장', Array.isArray(r.De) && r.De.length === 0, 'De=' + J(r.De));

  // ② 새 분석 결과(가격 없음) — 역시 0장
  const fresh = {
    sameProductAlts: [{ platform: '쿠팡', reason: '로켓배송 가능', searchQuery: '갤럭시 북4 프로' }],
    alternativeProducts: [{ productName: 'LG 그램 16', platform: '쿠팡', reason: '가성비 대안', searchQuery: 'LG 그램 16' }],
  };
  const r2 = build(fresh, fe);
  check('새 결과: 검색 링크 카드 0장', r2.Re.length === 0 && r2.De.length === 0, 'Re=' + r2.Re.length + ' De=' + r2.De.length);

  // ③ 빈 결과
  const r3 = build({}, fe);
  check('빈 결과 → 카드 0장', r3.Re.length === 0 && r3.De.length === 0);
});

// ════════════════════════════════════════════════════════════
section('e) np- 카드 매핑 — 번들에서 잘라내 실행');
safe('np- 카드 매핑', () => {
  // Ee=Qe.items.slice(0,3).map((Re,De)=>({…,...(Re.card||{}),url:Re.link,imageUrl:Re.image||void 0})),$e=Qe.lowest||Qe.items[0]
  const head = 'Ee=Qe.items.slice(0,3).map((Re,De)=>({id:`np-${De}`';
  const start = anchorOnce(head);
  const tail = ',$e=Qe.lowest||Qe.items[0]';
  const end = anchorOnce(tail);
  if (end < start || end - start > 1000) throw new Error('np- 매핑 구간이 예상과 다릅니다');
  const expr = src.slice(start, end);
  const build = new Function('Qe', 'fe', 'ce', 'const ' + expr + ';return Ee;');
  const fe = { productName: '페이지 상품명', currentPrice: 1838000 };
  const card1 = {
    productName: '삼성 갤럭시 북4 프로 NT940XGK', name: '삼성 갤럭시 북4 프로 NT940XGK', price: 1684700, estimatedPrice: 1684700,
    savings: 153300, platform: '쿠팡', tags: ['후보 32개 중 최저가', '로켓배송', '쿠팡 검색 결과 기준'],
    reason: '후보 32개 중 1번째로 저렴 · 평점 4.7 (리뷰 2,341개) · 로켓배송',
    rating: 4.7, reviewCount: 2341, scores: { price: 100, quality: 88, safety: 80, total: 91 },
    dataInsufficient: false, lowest: true, rank: 1, candidateCount: 32,
    link: 'https://www.coupang.com/vp/products/1?itemId=2&vendorItemId=3', image: 'https://img.example/1.jpg',
  };
  const Qe = {
    configured: true, source: 'coupang-search', lowest: { price: 1684700, mall: '쿠팡' },
    items: [
      { title: '삼성 갤럭시 북4 프로 NT940XGK', price: 1684700, mall: '쿠팡', link: card1.link, image: card1.image, card: card1 },
      { title: '두 번째', price: 1700000, mall: '쿠팡', link: 'https://www.coupang.com/vp/products/4', image: null },  // card 없음
      { title: '세 번째', price: 1710000, mall: '쿠팡', link: 'https://www.coupang.com/vp/products/5', image: null, card: { dataInsufficient: true, tags: ['데이터 부족', '쿠팡 검색 결과 기준'], reason: '후보 32개 중 3번째로 저렴 · 평점·리뷰 데이터 부족 · 일반배송' } },
      { title: '네 번째(잘려야 함)', price: 1720000, mall: '쿠팡', link: 'https://www.coupang.com/vp/products/6', image: null },
    ],
  };
  const Ee = build(Qe, fe, fe.currentPrice);
  const d = J(Ee);
  check('최대 3장', Ee.length === 3, 'len=' + Ee.length);
  check('id 는 np-0..2, type optimal, badge 없음', Ee.every((c, i) => c.id === 'np-' + i && c.type === 'optimal' && !('badge' in c)), d);
  const a = Ee[0];
  check('card 가 productName·price·tags·reason·rating·reviewCount·scores·lowest 를 덮어씀',
    a.productName === card1.productName && a.price === 1684700 && J(a.tags) === J(card1.tags) && a.reason === card1.reason &&
    a.rating === 4.7 && a.reviewCount === 2341 && a.scores === card1.scores && a.lowest === true && a.dataInsufficient === false &&
    a.rank === 1 && a.candidateCount === 32, J(a));
  check('url 은 link, imageUrl 은 image (card 뒤에 와서 최종)', a.url === card1.link && a.imageUrl === card1.image, J([a.url, a.imageUrl]));
  check('savings = max(현재가 - price, 0)', a.savings === 1838000 - 1684700, 'savings=' + a.savings);
  const b = Ee[1];
  check('card 없는 항목도 깨지지 않음: 기본 태그·빈 reason·platform 쿠팡',
    b.productName === '두 번째' && b.price === 1700000 && J(b.tags) === J(['쿠팡 검색 결과 기준']) && b.reason === '' && b.platform === '쿠팡' && b.imageUrl === undefined, J(b));
  const c = Ee[2];
  check('데이터 부족 카드: dataInsufficient 와 태그가 그대로 전달', c.dataInsufficient === true && c.tags.indexOf('데이터 부족') >= 0, J(c));
  check('어떤 카드에도 네이버 문구 없음', d.indexOf('네이버') < 0, d);
  // card 가 있으면 background 가 계산한 savings 가 우선이므로, card 없는 항목으로만 확인한다
  check('현재가 없으면 savings 0 (card 없는 항목)', build({ items: [Qe.items[1]] }, { productName: 'x' }, 0).every(x => x.savings === 0));
});

// ── 마무리 ─────────────────────────────────────────────────────
lines.push('');
lines.push(failed === 0 ? '  ✅ ' + total + '개 전부 통과' : '  ❌ ' + total + '개 중 ' + failed + '건 실패');
const report = lines.join('\n');
if (IS_NODE) {
  console.log(report);
  if (failed > 0) process.exit(1);
} else {
  // osascript: 마지막 표현식 출력만으로는 실패해도 종료 코드가 0 이라 run-all.sh 가 통과로 본다.
  // stdout 에 직접 쓰고 종료 코드로 알린다 (worker.test.js 와 같은 방식).
  ObjC.import('Foundation');
  ObjC.import('stdlib');
  $.NSFileHandle.fileHandleWithStandardOutput.writeData($(report + '\n').dataUsingEncoding($.NSUTF8StringEncoding));
  $.exit(failed > 0 ? 1 : 0);
}
