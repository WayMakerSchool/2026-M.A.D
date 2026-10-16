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
 *   - 가디언 점수(dL): background 가 계산한 scores 가 있으면 3축은 그대로, total 만 현재 우선순위 가중치로 다시 계산한다.
 *     fL: dataInsufficient 카드는 1위가 될 수 없다.
 *   - 보러가기·결제·찜 버튼: url 이 없으면 검색 페이지로 보내지 않고 아무것도 하지 않는다.
 *
 * 카테고리 검색 3축 순위(계약 8장) 이후:
 *   - searchPrices 에 mode:"category"·weights·priority·brand·model·sourceUrl 을 보내고, 45초 안전 타이머를 건다.
 *   - 카드는 최대 5장. category 모드에서는 다른 상품을 '시장 최저가'로 채우지 않는다(lowest 없으면 items[0] 폴백 차단).
 *   - category 실패는 오류 문장을 상태바에 보이고 Gemini 웹검색 폴백으로 넘어가지 않는다.
 *   - 추천 목록은 종합점수 순(가디언 맨 위). 헤더 버튼 '쿠팡 검색 창에서 순위 보기' → openRankedSearch.
 *   - 카테고리 순위 카드(categoryRank)는 다른 상품이므로 결제 요약에서 '차액(절약)'을 만들지 않고 openCheckout savings 는 0.
 *     categoryRank 항목이 없으면 탭 라벨은 '동일 제품 대안'. 데이터 부족 카드의 3축 막대는 품질 '평점 없음'.
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
  ['결제 패널 할인액: 추정 카드·카테고리 순위 카드는 계산 안 함', 'b=e&&!e.estimated&&!Wcat&&Wcur!=null?Wcur-e.price:null', 1],
  ['옛 할인액 식(카테고리 순위 카드도 차액 계산) 없음', 'b=e&&!e.estimated&&Wcur!=null?Wcur-e.price:null', 0],
  ['결제 요약: categoryRank 카드 판별 Wcat',           'Wcat=!!(e&&e.categoryRank)', 1],
  ['openCheckout savings: categoryRank 카드는 0 + categoryRank 표시', 'savings:Wcat?0:b!=null&&b>0?Math.round(b):0,categoryRank:Wcat,', 1],
  ['결제 요약: 다른 상품은 회색 중립 문구(pc.otherDiff·pc.otherNote)', 'children:l("pc.otherDiff")}),f.jsx("span",{className:"text-xs font-semibold text-gray-500",', 1],
  ['결제 확인 모달: categoryRank 카드는 차액 대신 "절약 아님" 문구', 'children:b==null?(Wcat?l("pc.otherNote"):"—"):', 1],
  ['i18n pc.otherNote (ko)',                       'ko:"다른 상품이라 절약액으로 세지 않아요"', 1],
  ['np- 카드: categoryRank 카드는 savings 0 강제',      '...(Re.card&&Re.card.categoryRank?{savings:0}:{})', 1],
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
  ['np- 카드는 최대 5장 (카테고리 순위 상위 5개)',       'Ee=Qe.items.slice(0,5).map((Re,De)=>({id:`np-${De}`', 1],
  ['옛 3장 제한 없음',                               'Ee=Qe.items.slice(0,3).map(', 0],
  ['marketLowestPrice: category 모드는 items[0] 폴백 차단', '$e=Qe.lowest||(Qe.mode==="category"?null:Qe.items[0])', 1],
  ['옛 무조건 items[0] 폴백 없음',                     '$e=Qe.lowest||Qe.items[0];', 0],
  ['marketLowestPrice: $e 가 null 이면 기존 값 유지',   'marketLowestPrice:ce&&$e&&$e.price<ce?', 1],
  ['background 의 note(없으면 완료 문구)를 상태 문구로 표시', 'Ht(Qe.note||(Qe.mode==="category"?le("st.catRanked",', 1],
  ['dL: 옛 "scores 그대로 사용" 식 없음',              'if(g.scores){t.set(String(g.id),g.scores);continue;}', 0],
  ['dL: background 3축 점수를 현재 우선순위 가중치로 total 재계산',
    'if(g.scores){const S=g.scores,Sq=typeof S.quality=="number";t.set(String(g.id),typeof S.price=="number"&&typeof S.safety=="number"?{...S,total:Yh(Sq?S.price*u.price+S.quality*u.quality+S.safety*u.safety:(S.price*u.price+S.safety*u.safety)/(u.price+u.safety))}:S);continue;}', 1],
  // ── 카테고리 검색 3축 순위 (계약 8장) ──
  ['8.1 searchPrices payload 에 mode·weights·priority·brand·model·sourceUrl',
    'specText:fe.specText,mode:"category",weights:p2(J),priority:J,brand:(fe.extractedSpecs||{}).brand||null,model:(fe.extractedSpecs||{}).modelNumber||null,sourceUrl:fe.sourceUrl||re}', 1],
  ['8.2 진행 문구 (st.catRanking)',                   'try{Ht(le("st.catRanking"));const Qe=await new Promise(', 1],
  ['8.2 진행 문구 i18n (ko, -어요 체)',                 'ko:"쿠팡 카테고리 검색 결과에 ShoMate 3축 순위를 매기고 있어요..."', 1],
  ['8.2 45초 안전 타임아웃',                            '}),45e3);chrome.runtime.sendMessage({type:"searchPrices"', 1],
  ['8.5 category 실패: 오류 문구 표시 + Gemini 폴백 안 탐', '}else if(Qe&&Qe.mode==="category"){Ht(Qe.error||Qe.note||', 1],
  ['8.6 성공 시 recSearchUrl·recQuery 보관',            '{...Re,recSearchUrl:Qe.searchUrl||null,recQuery:Qe.query||null,comparisons:', 1],
  ['8.6 헤더 버튼: openRankedSearch 메시지',             'chrome.runtime.sendMessage({type:"openRankedSearch",searchUrl:We.recSearchUrl,query:We.recQuery||null,weights:p2(J),priority:J,sourceUrl:We.sourceUrl||Zt||null}', 1],
  ['8.6 헤더 버튼 문구 (ko)',                           'ko:"쿠팡 검색 창에서 순위 보기"', 1],
  ['8.6 헤더 버튼 문구 (en)',                           'en:"Rank on Coupang search"', 1],
  ['8.7 \'평점 없음\' 안내는 background 점수 카드를 빼고 판단', 'I.some(P=>!P.scores&&!(typeof P.rating=="number"&&P.rating>0))', 1],
  ['8.7 목록을 종합점수 순(가디언 맨 위)으로 렌더',       '[...I].sort((Wa,Wb)=>', 1],
  ['8.8 보러가기: 분석 고정 + 포그라운드 탭',             'P=D=>{Nr(!0),O(D),Ht(le("st.fgTab"))}', 1],
  ['8.8 옛 백그라운드 탭 열기 없음',                      'O(D,{background:!0})', 0],
  ['8.9 다른 상품 분석 시작 시 선택 초기화',              'Nr(!1),Aa(!0),gt(null),T(null),Ht(`분석 중: ${re}`)', 1],
  ['8.10 탭 이름 카테고리 순위',                          '"rec.same":{ko:"카테고리 순위",en:"Category ranking",zh:"品类排名",ja:"カテゴリ順位"}', 1],
  ['탭 라벨: categoryRank 항목이 없으면 rec.sameAlt',       'children:b(e.some(Wp=>Wp&&Wp.categoryRank)?"rec.same":"rec.sameAlt")}),', 1],
  ['빈 목록 문구도 같은 조건',                             'b(a==="same"?e.some(Wp=>Wp&&Wp.categoryRank)?"rec.emptySame":"rec.emptySameAlt":"rec.emptySimilar")', 1],
  ['i18n rec.sameAlt 4개 언어',                           '"rec.sameAlt":{ko:"동일 제품 대안",en:"Same product",zh:"同款商品",ja:"同一商品"}', 1],
  ['i18n rec.emptySame (-어요 체)',                        'ko:"카테고리 순위에 올릴 상품이 없어요."', 1],
  ['"동일 제품 대안" 문구는 sameAlt·emptySameAlt 두 곳만', '동일 제품 대안', 2],
  ['3축 막대: 데이터 부족 카드는 품질 null(평점 없음)로',   'f.jsx(mL,{s:P.dataInsufficient?{...J,quality:null}:J})', 1],
  ['st.rankOpened: 단정하지 않는 문구',                    'ko:"쿠팡 검색 창을 열었어요. 페이지가 뜨면 상품마다 ShoMate 순위를 붙여 볼게요. 쿠팡이 페이지를 막으면 순위가 표시되지 않을 수 있어요."', 1],
  ['사용자 문구에 lastError.message 를 붙이지 않음',        '"+chrome.runtime.lastError.message', 0],
  ['옛 "백그라운드 응답을 받지 못했어요:" 문구 없음',         'ShoMate 백그라운드 응답을 받지 못했어요:', 0],
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
  // 사이드바는 상위 5개만 보므로 3축(가격·품질·안정)을 다시 계산하면 가격 축이 왜곡된다 → 3축은 그대로 쓴다.
  // 카테고리 순위(계약 8.7): total 만 사이드바의 현재 우선순위 가중치(p2)로 다시 계산한다.
  const SC_A = { price: 92, quality: 81, safety: 70, total: 83 };
  const SC_B = { price: 55, quality: 40, safety: 70, total: 55 };
  const BG_A = card('np-0', 1684700, { platform: '쿠팡', scores: SC_A, rating: 4.7, reviewCount: 2341 });
  const BG_B = card('np-1', 1700000, { platform: '쿠팡', scores: SC_B, rating: 3.9, reviewCount: 12 });
  // 데이터 부족 카드: 평점·리뷰가 없어 background 가 quality 를 못 매긴 경우. total 이 가장 높아도 1위는 안 된다.
  const BG_INSUF = card('np-2', 1500000, { platform: '쿠팡', scores: { price: 100, quality: null, safety: 70, total: 95 }, dataInsufficient: true });
  const same3 = (x, y) => !!x && !!y && x.price === y.price && x.quality === y.quality && x.safety === y.safety;
  const W = { '가성비 우대': [0.5, 0.3, 0.2], '안전성 우대': [0.2, 0.3, 0.5], '배송속도 우대': [0.34, 0.33, 0.33] };
  const wTotal = (sc, pri) => Math.max(0, Math.min(100, Math.round(sc.price * W[pri][0] + sc.quality * W[pri][1] + sc.safety * W[pri][2])));

  safe('dL background 점수: 3축 유지 + total 재가중', () => {
    const m = dL([BG_A, BG_B], CTX);   // CTX 는 가성비 우대
    check('scores 있는 카드는 3축(가격·품질·안정) 값을 그대로 씀',
      same3(m.get('np-0'), SC_A) && same3(m.get('np-1'), SC_B), J(Array.from(m.entries())));
    check('가성비 우대: total = round(.5·가격 + .3·품질 + .2·안정) → 84 / 54',
      m.get('np-0').total === wTotal(SC_A, '가성비 우대') && m.get('np-0').total === 84 &&
      m.get('np-1').total === wTotal(SC_B, '가성비 우대') && m.get('np-1').total === 54,
      J([m.get('np-0'), m.get('np-1')]));
    check('원본 card.scores 객체를 바꾸지 않음(total 83·55 그대로)', SC_A.total === 83 && SC_B.total === 55, J([SC_A, SC_B]));
    for (const pri of ['안전성 우대', '배송속도 우대']) {
      const mm = dL([BG_A, BG_B], { priority: pri });
      check(pri + ': total 이 그 우선순위 가중치로 다시 계산됨',
        mm.get('np-0').total === wTotal(SC_A, pri) && mm.get('np-1').total === wTotal(SC_B, pri),
        J([mm.get('np-0'), mm.get('np-1')]) + ' 기대 ' + wTotal(SC_A, pri) + '/' + wTotal(SC_B, pri));
    }
    const mixed = dL([BG_A, REAL_B], CTX);
    check('scores 없는 카드는 기존대로 사이드바가 계산',
      same3(mixed.get('np-0'), SC_A) && !!mixed.get('np-1') && !same3(mixed.get('np-1'), SC_B) && typeof mixed.get('np-1').total === 'number',
      J(Array.from(mixed.entries())));
    const withEst = dL([EST_C, BG_A], CTX);
    check('추정 카드 제외는 scores 보다 먼저 적용', !withEst.has('gs-0') && same3(withEst.get('np-0'), SC_A), J(Array.from(withEst.keys())));
    const broken = { price: '?', quality: 50, safety: 50, total: 40 };
    const mb = dL([card('np-9', 1000, { scores: broken })], CTX);
    check('3축이 숫자가 아닌 이상한 scores 는 손대지 않고 그대로 둠', mb.get('np-9') === broken, J(mb.get('np-9')));
  });

  safe('dL 재가중: 우선순위를 바꾸면 가디언 1위가 바뀜', () => {
    // A: 싸지만 안정성 낮음 / B: 비싸지만 로켓·리뷰로 안정성 높음
    const A = card('cp-1', 30000, { platform: '쿠팡', scores: { price: 100, quality: 50, safety: 40, total: 60 } });
    const B = card('cp-2', 52000, { platform: '쿠팡', scores: { price: 30, quality: 60, safety: 100, total: 60 } });
    const cheap = dL([A, B], { priority: '가성비 우대' });
    const safeP = dL([A, B], { priority: '안전성 우대' });
    check('가성비 우대: A 73 > B 53', cheap.get('cp-1').total === 73 && cheap.get('cp-2').total === 53, J(Array.from(cheap.entries())));
    check('안전성 우대: B 74 > A 55', safeP.get('cp-2').total === 74 && safeP.get('cp-1').total === 55, J(Array.from(safeP.entries())));
    check('가디언: 가성비 우대 → cp-1, 안전성 우대 → cp-2',
      fL([A, B], cheap) === 'cp-1' && fL([A, B], safeP) === 'cp-2', fL([A, B], cheap) + ' / ' + fL([A, B], safeP));
  });

  safe('fL 데이터 부족 카드는 1위 불가', () => {
    const list = [BG_INSUF, BG_B, BG_A];
    const m = dL(list, CTX);
    const ins = m.get('np-2');
    // 품질이 null 이면 가격·안정 가중치만으로 정규화: (100·.5 + 70·.2) / .7 = 91.4 → 91
    check('데이터 부족 카드도 점수 Map 에는 있음(표시용) · 품질 없으면 가격·안정만으로 91',
      !!ins && ins.total === 91 && ins.quality === null, J(ins));
    const top = fL(list, m);
    check('total 91 인 데이터 부족 카드 대신 84 인 np-0 이 1위', top === 'np-0', 'top=' + top);
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
  // Ee=Qe.items.slice(0,5).map((Re,De)=>({…,...(Re.card||{}),url:Re.link,imageUrl:Re.image||void 0})),$e=Qe.lowest||(…)
  const head = 'Ee=Qe.items.slice(0,5).map((Re,De)=>({id:`np-${De}`';
  const start = anchorOnce(head);
  const tail = ',$e=Qe.lowest||(Qe.mode==="category"?null:Qe.items[0])';
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
      { title: '네 번째', price: 1720000, mall: '쿠팡', link: 'https://www.coupang.com/vp/products/6', image: null },
      { title: '다섯 번째', price: 1730000, mall: '쿠팡', link: 'https://www.coupang.com/vp/products/7', image: null },
      { title: '여섯 번째(잘려야 함)', price: 1740000, mall: '쿠팡', link: 'https://www.coupang.com/vp/products/8', image: null },
    ],
  };
  const Ee = build(Qe, fe, fe.currentPrice);
  const d = J(Ee);
  check('최대 5장 (6개 중 6번째는 잘림)', Ee.length === 5 && Ee[4].productName === '다섯 번째', 'len=' + Ee.length);
  check('id 는 np-0..4, type optimal, badge 없음', Ee.every((c, i) => c.id === 'np-' + i && c.type === 'optimal' && !('badge' in c)), d);
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
  // 카테고리 순위 카드는 다른 상품 — card 에 savings 가 빠져 와도(옛 background·버그) 현재가 차액을 절약으로 넣지 않는다
  const catNoSav = { categoryRank: true, tags: ['쿠팡 「x」 검색 기준'], reason: 'r' };
  const catEe = build({ items: [{ title: '다른 상품', price: 29800, mall: '쿠팡', link: 'https://www.coupang.com/vp/products/9', image: null, card: catNoSav }] }, fe, 39800);
  check('categoryRank 카드: card.savings 없어도 savings 0 (현재가 39,800 > 29,800 이어도)', catEe[0].savings === 0 && catEe[0].categoryRank === true, J(catEe[0]));
  const catBad = build({ items: [{ title: '다른 상품', price: 29800, mall: '쿠팡', link: 'https://www.coupang.com/vp/products/9', image: null, card: { categoryRank: true, savings: 10000, tags: [] } }] }, fe, 39800);
  check('categoryRank 카드: card.savings 가 잘못 와도 0', catBad[0].savings === 0, J(catBad[0]));
});

// ════════════════════════════════════════════════════════════
section('f) 카테고리 순위 흐름 — searchPrices 블록을 잘라 동기 실행');
// si() 안의 if(fe…)try{ … searchPrices … }catch(Qe){…} 블록 전체를 잘라 스텁 환경에서 돌린다.
// await 는 동기 호출로 바꾼다(스텁 콜백이 즉시 불리므로 결과가 같다). await 개수가 바뀌면 FAIL 로 알린다.
let flowFactory = null, p2fn = null;
safe('searchPrices 블록 잘라내기', () => {
  const head = 'if(fe!=null&&fe.productName&&fe.productName.length>1)try{';
  const tail = '}catch(Qe){console.warn("실시간 최저가 검색 실패",Qe)}';
  const i = anchorOnce(head), j = anchorOnce(tail);
  if (j < i || j - i > 8000) throw new Error('searchPrices 블록 범위가 예상과 다릅니다');
  let blk = src.slice(i, j + tail.length);
  const nP = blk.split('await new Promise(').length - 1, nH = blk.split('await $h(').length - 1, nA = blk.split('await ').length - 1;
  if (nP !== 2 || nH !== 1 || nA !== 3) throw new Error('await 구성이 예상과 다름: new Promise ' + nP + ', $h ' + nH + ', 전체 ' + nA);
  blk = blk.split('await new Promise(').join('SYNC(').split('await $h(').join('$h(');
  flowFactory = new Function('env',
    'var fe=env.fe,re=env.re,J=env.J,p2=env.p2,Ht=env.Ht,le=env.le,gt=env.gt,ii=env.ii,$h=env.$h,Ue=env.Ue,Be=env.Be,' +
    'Kh=env.Kh,Jp=env.Jp,chrome=env.chrome,window=env.window,console=env.console,SYNC=env.SYNC;var bi,Ir;' + blk);
  p2fn = new Function(sliceFunction('function p2(n){') + '\nreturn p2;')();
  check('searchPrices 블록·p2 잘라 평가', typeof flowFactory === 'function' && typeof p2fn === 'function');
});

const NO_REPLY = { noReply: true };
function runFlow(opts) {
  const sent = [], status = [], timers = [], cleared = [], hCalls = [], warns = [];
  let state = opts.state;
  const chrome = { runtime: { lastError: null, sendMessage(msg, cb) {
    sent.push(msg);
    const r = opts.respond(msg);
    if (r === NO_REPLY) return;
    if (r && r.__lastError) { chrome.runtime.lastError = { message: r.__lastError }; cb(undefined); chrome.runtime.lastError = null; return; }
    cb(r);
  } } };
  const env = {
    fe: opts.fe, re: opts.re || 'https://www.coupang.com/vp/products/111', J: opts.J || '안전성 우대', p2: p2fn,
    Ht: (m) => status.push(m),
    le: (k, p) => (p ? k + ' ' + JSON.stringify(p) : k),
    gt: (u) => { state = typeof u === 'function' ? u(state) : u; },
    ii: { current: [] },
    $h: (kind, key) => { hCalls.push(kind); return null; },
    Ue: 'key', Be: null, Kh: () => {}, Jp: () => {},
    chrome: chrome,
    window: {
      setTimeout: (fn, ms) => { timers.push(ms); if (opts.fireTimeoutAt === ms) fn(); return 'T' + timers.length; },
      clearTimeout: (id) => cleared.push(id),
    },
    console: { warn: function () { warns.push(Array.prototype.join.call(arguments, ' ')); }, log: () => {} },
    SYNC: (exec) => { let done = false, v; exec((x) => { if (!done) { done = true; v = x; } }); if (!done) throw new Error('SYNC: 응답 없음'); return v; },
  };
  flowFactory(env);
  return { sent, status, timers, cleared, hCalls, warns, state: () => state, ii: env.ii };
}

// 계약 2.1 형태의 category 응답 (상위 5개)
const CAT_URL = 'https://www.coupang.com/np/search?q=%EA%B0%95%EC%95%84%EC%A7%80%20%EA%B3%A0%EC%96%91%EC%9D%B4%20%EC%9D%B4%EB%8F%99%EC%9E%A5';
function catCard(pid, rank, price, sc, extra) {
  const c = { id: 'cp-' + pid, type: 'optimal', productName: '상품 ' + pid, name: '상품 ' + pid, price: price, estimatedPrice: price, savings: 0,
    platform: '쿠팡', tags: ['로켓배송', '쿠팡 「강아지 고양이 이동장」 검색 기준'], reason: '「강아지 고양이 이동장」 검색 48개 중 종합 ' + rank + '위',
    rating: 4.5, reviewCount: 100 * rank, scores: sc, dataInsufficient: false, lowest: false, rank: rank, candidateCount: 48,
    link: 'https://www.coupang.com/vp/products/' + pid + '?itemId=1&vendorItemId=2', image: 'https://img.example/' + pid + '.jpg', productId: String(pid), categoryRank: true };
  for (const k in (extra || {})) c[k] = extra[k];
  return c;
}
const CAT_CARDS = [
  catCard(101, 1, 45000, { price: 60, quality: 90, safety: 95, total: 87 }),
  catCard(102, 2, 29800, { price: 100, quality: 70, safety: 60, total: 71 }),
  catCard(103, 3, 39000, { price: 80, quality: 60, safety: 75, total: 70 }),
  catCard(104, 4, 52000, { price: 40, quality: 80, safety: 85, total: 75 }, { dataInsufficient: true, rating: null, reviewCount: null }),
  catCard(105, 5, 61000, { price: 20, quality: 75, safety: 70, total: 62 }),
];
const CAT_RESP = {
  configured: true, mode: 'category', source: 'coupang-search', query: '강아지 고양이 이동장', queryVia: 'rule', searchUrl: CAT_URL,
  candidateCount: 48, rankedCount: 30, excludedCounts: { ad: 9, soldOut: 2, current: 1, outlier: 3, accessory: 2, noSpec: 0, badUrl: 1 },
  guardian: true, note: null, weights: { price: 0.2, quality: 0.3, safety: 0.5 }, priority: '안전성 우대', unitMode: null, lowest: null,
  items: CAT_CARDS.map(c => ({ title: c.productName, price: c.price, mall: '쿠팡', link: c.link, image: c.image, specText: null, card: c })),
};
const FLOW_FE = { productName: '호밍사이 강아지 백팩 고양이 이동장 앞가방', currentPrice: 39800, specText: null,
  extractedSpecs: { brand: '호밍사이', modelNumber: null }, sourceUrl: 'https://www.coupang.com/vp/products/111?itemId=9' };
const OLD_ALT = { id: 'alt-1', type: 'alternative', price: 1, tags: [] };
const flowState = () => ({ productName: FLOW_FE.productName, comparisons: { marketLowestPrice: null, alternativeSuggestions: [OLD_ALT] } });

if (flowFactory) {
  safe('category 성공 응답', () => {
    const r = runFlow({ fe: FLOW_FE, J: '가성비 우대', state: flowState(), respond: (m) => m.type === 'searchPrices' ? CAT_RESP : { listings: [] } });
    const m = r.sent[0] || {};
    check('보낸 메시지는 searchPrices 1건뿐 (findRealListings 없음)', r.sent.length === 1 && m.type === 'searchPrices', J(r.sent.map(x => x.type)));
    check('payload: mode=category · priority=가성비 우대 · weights=p2(가성비 우대)',
      m.mode === 'category' && m.priority === '가성비 우대' && J(m.weights) === J({ price: 0.5, quality: 0.3, safety: 0.2 }), J(m));
    check('payload: query=상품명 · currentPrice · brand · model(null) · sourceUrl',
      m.query === FLOW_FE.productName && m.currentPrice === 39800 && m.brand === '호밍사이' && m.model === null && m.sourceUrl === FLOW_FE.sourceUrl, J(m));
    check('진행 문구 st.catRanking 이 먼저 뜸', r.status[0] === 'st.catRanking', J(r.status));
    check('45초 안전 타이머를 걸고 응답이 오면 해제', r.timers[0] === 45000 && r.cleared.indexOf('T1') >= 0, J([r.timers, r.cleared]));
    const st = r.state(), list = st.comparisons.alternativeSuggestions;
    check('카드 5장 + 기존 alternative 유지', list.length === 6 && list[5] === OLD_ALT, J(list.map(x => x.id)));
    check('카드 id 는 background 의 cp-<productId>, url 은 상세 링크',
      list.slice(0, 5).every((c, k) => c.id === CAT_CARDS[k].id && c.url === CAT_CARDS[k].link && c.categoryRank === true && Array.isArray(c.tags)), J(list.slice(0, 5)));
    check('marketLowestPrice 는 다른 상품(29,800원)으로 채우지 않음 (null 유지)', st.comparisons.marketLowestPrice === null, J(st.comparisons.marketLowestPrice));
    check('recSearchUrl·recQuery 보관', st.recSearchUrl === CAT_URL && st.recQuery === '강아지 고양이 이동장', J([st.recSearchUrl, st.recQuery]));
    check('ii.current 도 같은 목록(우선순위·예산 재정렬 원본)', r.ii.current.length === 6);
    const last = r.status[r.status.length - 1];
    check('완료 문구: st.catRanked {q,c,r}', last === 'st.catRanked ' + J({ q: '강아지 고양이 이동장', c: 48, r: 30 }), last);
    check('Gemini 웹검색 캐시($h listings)를 읽지 않음', r.hCalls.length === 0, J(r.hCalls));
  });

  safe('category 성공 + note', () => {
    const resp = JSON.parse(J(CAT_RESP)); resp.note = '후보가 적어 순위가 덜 정확할 수 있어요';
    const r = runFlow({ fe: FLOW_FE, state: flowState(), respond: () => resp });
    check('note 가 있으면 note 를 상태 문구로', r.status[r.status.length - 1] === resp.note, J(r.status));
    check('기본 우선순위(안전성 우대) 가중치 20/30/50 전송', J(r.sent[0].weights) === J({ price: 0.2, quality: 0.3, safety: 0.5 }) && r.sent[0].priority === '안전성 우대', J(r.sent[0]));
  });

  safe('category 실패 응답', () => {
    const resp = { configured: false, mode: 'category', error: '쿠팡 검색 결과를 읽지 못했어요.', query: '강아지 고양이 이동장', searchUrl: CAT_URL };
    const r = runFlow({ fe: FLOW_FE, state: flowState(), respond: (m) => m.type === 'searchPrices' ? resp : { listings: [{ title: 'x', price: 1, url: 'https://x' }] } });
    check('오류 문장을 상태바에 표시', r.status[r.status.length - 1] === resp.error, J(r.status));
    check('Gemini 웹검색(findRealListings) 폴백으로 넘어가지 않음', r.sent.length === 1 && r.hCalls.length === 0, J(r.sent.map(x => x.type)));
    const st = r.state();
    check('목록은 그대로, 검색 URL·검색어만 보관(버튼으로 직접 열 수 있게)',
      st.comparisons.alternativeSuggestions.length === 1 && st.recSearchUrl === CAT_URL && st.recQuery === '강아지 고양이 이동장', J(st));
  });

  safe('category 응답 items 0개', () => {
    const resp = JSON.parse(J(CAT_RESP)); resp.items = []; resp.note = null;
    const r = runFlow({ fe: FLOW_FE, state: flowState(), respond: () => resp });
    check('후보 없음 문구 + 폴백 없음', /순위를 매길 상품을 찾지 못했어요/.test(r.status[r.status.length - 1]) && r.sent.length === 1, J(r.status));
  });

  safe('45초 타임아웃', () => {
    const r = runFlow({ fe: FLOW_FE, state: flowState(), respond: () => NO_REPLY, fireTimeoutAt: 45000 });
    check('시간 초과 문구 표시 + 폴백 없음', /45초/.test(r.status[r.status.length - 1]) && r.sent.length === 1 && r.hCalls.length === 0, J([r.status, r.sent.length]));
  });

  safe('runtime.lastError', () => {
    const r = runFlow({ fe: FLOW_FE, state: flowState(), respond: (m) => m.type === 'searchPrices' ? { __lastError: 'Could not establish connection' } : { listings: [] } });
    const last = r.status[r.status.length - 1] || '';
    check('lastError 도 category 실패로 표시 + 폴백 없음 (쉬운 한국어 문장)',
      /받지 못했어요/.test(last) && r.sent.length === 1, J([r.status, r.sent.map(x => x.type)]));
    check('영문 내부 메시지(lastError.message)는 상태바에 안 보이고 console.warn 으로만',
      !/Could not establish connection/.test(r.status.join('|')) && r.warns.some(w => /Could not establish connection/.test(w)), J([r.status, r.warns]));
  });

  safe('옛 background(mode 없음) 응답 호환', () => {
    const legacy = { configured: true, source: 'coupang-search', items: [{ title: '같은 상품', price: 35000, mall: '쿠팡', link: 'https://www.coupang.com/vp/products/5', image: null }] };
    const r = runFlow({ fe: FLOW_FE, state: flowState(), respond: () => legacy });
    const mlp = r.state().comparisons.marketLowestPrice;
    check('mode 없는 같은 상품 응답은 예전처럼 items[0] 을 시장 최저가로', !!mlp && mlp.price === 35000 && mlp.savePotential === 4800, J(mlp));
    check('mode 없는 응답이면 진행 문구를 지움("")', r.status[r.status.length - 1] === '', J(r.status));
    const fail = runFlow({ fe: FLOW_FE, state: flowState(), respond: (m) => m.type === 'searchPrices' ? { configured: false, error: '옛 오류' } : { listings: [] } });
    check('mode 없는 실패는 예전처럼 findRealListings 폴백', fail.sent.map(x => x.type).join(',') === 'searchPrices,findRealListings' && fail.status.indexOf('옛 오류') >= 0,
      J([fail.sent.map(x => x.type), fail.status]));
  });
}

// ════════════════════════════════════════════════════════════
section('g) 추천 목록 정렬 — 종합점수 순, 가디언 맨 위');
safe('pL 정렬 비교함수', () => {
  const at = anchorOnce('[...I].sort(');
  const open = at + '[...I].sort'.length;
  const cmpSrc = src.slice(open + 1, matchClose(src, open));
  const mk = new Function('O', 'T', 'return ' + cmpSrc);
  const T = new Map([['a', { total: 60 }], ['b', { total: 80 }], ['g', { total: 70 }]]);
  const order = (O) => [{ id: 'a' }, { id: 'n' }, { id: 'b' }, { id: 'g' }].sort(mk(O, T)).map(x => x.id).join(',');
  check('가디언(g) 맨 위 → 나머지 total 내림차순 → 점수 없는 카드 맨 뒤', order('g') === 'g,b,a,n', order('g'));
  check('가디언 없으면 total 내림차순', order(null) === 'b,g,a,n', order(null));
  if (dL && fL) {
    // 계약 응답 카드 5장을 그대로 넣고 우선순위별로 화면 순서를 확인
    const cards = CAT_CARDS.map(c => Object.assign({}, c, { url: c.link }));
    for (const pri of ['안전성 우대', '가성비 우대']) {
      const sc = dL(cards, { priority: pri });
      const g = fL(cards, sc);
      const ids = cards.slice().sort(mk(g, sc)).map(c => c.id);
      const totals = ids.map(id => sc.get(id).total);
      const rest = totals.slice(1);
      const desc = rest.every((v, k) => k === 0 || rest[k - 1] >= v);
      const gCard = cards.find(c => c.id === ids[0]);
      check(pri + ': 5장 · 맨 위는 데이터 부족이 아닌 가디언 · 나머지는 종합점수 내림차순',
        ids.length === 5 && ids[0] === g && !gCard.dataInsufficient && desc, J(ids) + ' ' + J(totals));
    }
    const sSafe = dL(cards, { priority: '안전성 우대' }), sCheap = dL(cards, { priority: '가성비 우대' });
    check('우선순위에 따라 1위가 바뀜 (안전성 → cp-101, 가성비 → cp-102)',
      fL(cards, sSafe) === 'cp-101' && fL(cards, sCheap) === 'cp-102', fL(cards, sSafe) + ' / ' + fL(cards, sCheap));
  }
});

// ════════════════════════════════════════════════════════════
section('h) 헤더 버튼 — 쿠팡 검색 창에서 순위 보기');
safe('표시 조건', () => {
  const head = 'We&&typeof We.recSearchUrl=="string"&&';
  const i = anchorOnce(head);
  const j = src.indexOf('&&f.jsxs("button",{type:"button",', i);
  if (j < 0 || j - i > 300) throw new Error('버튼 표시 조건 범위가 예상과 다릅니다');
  const cond = new Function('We', 'return !!(' + src.slice(i, j) + ')');
  check('쿠팡 /np/search URL 이면 표시', cond({ recSearchUrl: CAT_URL }) === true);
  check('recSearchUrl 없음 → 숨김', cond({}) === false && cond(null) === false);
  check('상세·다른 사이트·javascript: URL → 숨김',
    cond({ recSearchUrl: 'https://www.coupang.com/vp/products/1' }) === false &&
    cond({ recSearchUrl: 'https://evil.example/np/search?q=1' }) === false &&
    cond({ recSearchUrl: 'javascript:alert(1)' }) === false);
});
safe('클릭 → openRankedSearch', () => {
  const head = 'onClick:()=>{if(!(typeof chrome<"u"&&chrome.runtime&&chrome.runtime.sendMessage)){window.open(We.recSearchUrl';
  const i = anchorOnce(head);
  const open = i + 'onClick:()=>'.length;
  const body = src.slice(open, matchClose(src, open) + 1);
  const make = new Function('We', 'J', 'p2', 'Zt', 'Ht', 'le', 'chrome', 'window', 'console', 'return ()=>' + body);
  const run = (reply, lastErr) => {
    const sent = [], status = [], warns = [];
    const chrome = { runtime: { lastError: null, sendMessage(m, cb) {
      sent.push(m);
      if (lastErr) { chrome.runtime.lastError = { message: lastErr }; cb(undefined); chrome.runtime.lastError = null; return; }
      cb(reply);
    } } };
    const We = { recSearchUrl: CAT_URL, recQuery: '강아지 고양이 이동장', sourceUrl: FLOW_FE.sourceUrl };
    const con = { warn: function () { warns.push(Array.prototype.join.call(arguments, ' ')); } };
    make(We, '가성비 우대', p2fn, 'https://zt.example', (m) => status.push(m), (k) => k, chrome, { open: () => { throw new Error('window.open 호출됨'); } }, con)();
    return { sent, status, warns };
  };
  const ok = run({ ok: true, tabId: 7 });
  const m = ok.sent[0] || {};
  check('openRankedSearch 에 searchUrl·query·weights·priority·sourceUrl',
    ok.sent.length === 1 && m.type === 'openRankedSearch' && m.searchUrl === CAT_URL && m.query === '강아지 고양이 이동장' &&
    J(m.weights) === J({ price: 0.5, quality: 0.3, safety: 0.2 }) && m.priority === '가성비 우대' && m.sourceUrl === FLOW_FE.sourceUrl, J(m));
  check('성공 응답 → st.rankOpened', ok.status[0] === 'st.rankOpened', J(ok.status));
  const bad = run({ ok: false, error: '쿠팡 검색 주소가 아니에요' });
  check('실패 응답 → 오류 문장 표시', /쿠팡 검색 주소가 아니에요/.test(bad.status[0] || ''), J(bad.status));
  const eng = run({ ok: false, error: 'invalid-search-url' });
  check('영문 오류 코드는 상태바에 안 보이고 console.warn 으로만',
    eng.status.length === 1 && !/invalid-search-url/.test(eng.status[0]) && /열지 못했어요/.test(eng.status[0]) && eng.warns.some(w => /invalid-search-url/.test(w)), J([eng.status, eng.warns]));
  const le2 = run(null, 'The message port closed before a response was received.');
  check('lastError → 쉬운 한국어 문장 + console.warn',
    le2.status.length === 1 && /열지 못했어요/.test(le2.status[0]) && !/message port/.test(le2.status[0]) && le2.warns.some(w => /message port/.test(w)), J([le2.status, le2.warns]));
  const none = run(undefined);
  check('응답 없음 → 쉬운 한국어 문장', none.status.length === 1 && /열지 못했어요/.test(none.status[0]), J(none.status));
});
safe('새 className 이 CSS 에 있는 토큰만 사용', () => {
  const css = readFile('sidebar/assets/index-x6PLsn2B.css');
  if (!css) throw new Error('CSS 를 읽지 못했습니다');
  const esc = (c) => '.' + c.replace(/[:.\[\]\/]/g, (x) => '\\' + x);
  const classes = [
    'flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-[11px] font-extrabold transition-all cursor-pointer bg-indigo-50 hover:bg-indigo-100 border-indigo-100 text-indigo-700',
    'relative flex flex-wrap items-center justify-end gap-1.5',
    'text-[10px] font-extrabold text-indigo-700 mb-1.5',
    'w-3 h-3',
  ];
  for (const cls of classes) {
    check('번들에 className 존재: ' + cls.slice(0, 40) + '…', count('className:"' + cls + '"') >= 1, cls);
    const missing = cls.split(/\s+/).filter(c => css.indexOf(esc(c)) < 0);
    check('CSS 토큰 모두 존재: ' + cls.slice(0, 40) + '…', missing.length === 0, '없음: ' + missing.join(' '));
  }
});

// ════════════════════════════════════════════════════════════
section('i) 결제 요약 vL — categoryRank 카드는 절약으로 집계하지 않음');
// vL 의 상태·핸들러 부분(function vL(…){ … ;return f.jsxs(…) 앞까지)을 잘라 스텁 React 로 실행하고,
// 결제 버튼 핸들러 I() 가 openCheckout 으로 보내는 savings 를 확인한다.
// openCheckout savings → background pending.saved → 홈 '쇼메이트로 아낀 돈'(totalSaved) 으로 이어지는 유일한 경로다.
let vLfactory = null;
safe('vL 잘라내기', () => {
  const head = 'function vL({onPurchase:n,selectedRecommendation:e,';
  const i = anchorOnce(head);
  const j = src.indexOf(';return f.jsxs("div",{className:"bg-white border border-indigo-100', i);
  if (j < 0 || j - i > 3000) throw new Error('vL 상태·핸들러 범위가 예상과 다릅니다');
  const body = src.slice(i, j);
  if (body.indexOf('`') >= 0) throw new Error('vL 앞부분에 템플릿 리터럴이 생겼습니다(잘라내기 가정 깨짐)');
  vLfactory = new Function('Tr', 'B', 'chrome', 'setTimeout', 'console',
    body + ';I();return {b:b,T:T,Wcat:Wcat};}\nreturn vL;');
  check('vL 상태·핸들러 잘라 평가', typeof vLfactory === 'function');
});
function runCheckout(card, currentPrice) {
  const sent = [];
  const chrome = { runtime: { lastError: null, sendMessage(m, cb) { sent.push(m); cb({ ok: true }); } } };
  const vL = vLfactory(() => ({ t: (k) => k }), { useState: (v) => [v, () => {}] }, chrome, () => {}, { warn: () => {} });
  const r = vL({ onPurchase: () => {}, selectedRecommendation: card, currentPrice: currentPrice });
  return { r: r, msg: sent[0] || null, sent: sent };
}
if (vLfactory) {
  safe('vL openCheckout savings', () => {
    const cat = Object.assign({}, CAT_CARDS[1], { url: CAT_CARDS[1].link });   // 29,800원 · categoryRank:true
    const a = runCheckout(cat, 39800);
    check('categoryRank 카드 선택 → 차액 b 를 만들지 않음(null) · 취소선·"차액" 줄 없음', a.r.b === null && a.r.Wcat === true, J(a.r));
    check('categoryRank 카드 선택 → openCheckout savings 0 (현재가 39,800 > 29,800 이어도)',
      !!a.msg && a.msg.type === 'openCheckout' && a.msg.savings === 0 && a.msg.categoryRank === true && a.msg.amount === 29800, J(a.msg));
    const catSav = Object.assign({}, cat, { savings: 10000 });
    const a2 = runCheckout(catSav, 39800);
    check('categoryRank 카드에 savings 가 잘못 남아 있어도 openCheckout savings 0', !!a2.msg && a2.msg.savings === 0, J(a2.msg));
    // 회귀: 같은 상품(categoryRank 아님) 카드는 예전처럼 차액을 절약으로 보낸다
    const same = { id: 'np-0', type: 'optimal', productName: '같은 상품', price: 29800, platform: '쿠팡', url: 'https://www.coupang.com/vp/products/1', tags: [] };
    const b = runCheckout(same, 39800);
    check('같은 상품 카드는 기존대로 savings = 현재가 − 가격 (10,000)', b.r.b === 10000 && !!b.msg && b.msg.savings === 10000 && b.msg.categoryRank === false, J(b.msg));
    const c = runCheckout(same, null);
    check('현재가를 모르면 savings 0', !!c.msg && c.msg.savings === 0 && c.r.b === null, J(c.msg));
  });
}

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
