/**
 * 쿠팡 검색 결과 수집기 순수 함수 테스트
 *
 * content-script.js 의 '수집기 순수 함수' 구간(JSON-LD 파서·가격/평점/리뷰 텍스트 파서·로켓 badge-id 매핑·
 * href 파서·광고 href 판별·JSON-LD 보강·접근 거부 판별)과 순위 오버레이 문구 함수(3축 점수·제외 칩·패널 하단)를
 * 실제 소스에서 잘라 new Function 으로 실행한다.
 * 로직을 복붙해 검증하면 원본이 바뀌어도 테스트가 통과해버리므로, 원본을 직접 읽는다.
 * 잘라내는 표시 주석:
 *   시작 '// ── 수집기 순수 함수 시작 ──'  /  끝 '// ── 수집기 DOM 함수 시작 ──'
 * 픽스처는 2026-10-16 쿠팡 검색 페이지 실측 형태(CollectionPage.mainEntity(ItemList) JSON-LD,
 * PriceArea 말단 텍스트, '(1,843)' 리뷰 수, img[data-badge-id], 카드 href 파라미터)를 따른다.
 *
 * 실행 (저장소 루트에서):
 *   node tests/search-collector.test.js
 *   osascript -l JavaScript tests/search-collector.test.js
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

const SRC_PATH = 'content-script.js';
const src = readFile(SRC_PATH);
if (!src) throw new Error(SRC_PATH + ' 를 읽지 못했습니다. 저장소 루트에서 실행하세요.');

const START = '// ── 수집기 순수 함수 시작 ──';
const END = '// ── 수집기 DOM 함수 시작 ──';
const si = src.indexOf(START);
const ei = src.indexOf(END, si);
if (si < 0 || ei < 0) throw new Error('수집기 순수 함수 구간 표시를 찾지 못했습니다.');
if (src.indexOf(START, si + 1) >= 0 || src.indexOf(END, ei + 1) >= 0) throw new Error('구간 표시가 2회 이상 있습니다.');
const DEFS = src.slice(si, ei);
// 구간이 DOM·브라우저 전역에 기대지 않는지 — JXA 에는 document·location 이 없다
if (/\bdocument\./.test(DEFS) || /\blocation\./.test(DEFS)) throw new Error('순수 구간에 document/location 참조가 있습니다.');

// URL 전역을 가려(JXA 와 같게) 수동 결합 경로를 시험한다
const F = new Function('URL',
  DEFS + '\nreturn { csrInt, csrNum, csrAbsUrl, csrProductId, csrQueryParam, csrIsAdHref, csrParseProductHref,' +
  ' csrWonText, csrPercentText, csrReviewCountText, csrPickPriceLeaves, csrRocketFromBadgeIds,' +
  ' csrRankFromClassName, csrBlankItem, parseCoupangSearchJsonLd, csrEnrichWithJsonLd, csrDetectBlocked,' +
  ' rankOvScore, rankOvAxes, rankOvChipLabel, rankOvFooterText };')(undefined);

const lines = [];
let failed = 0;
let total = 0;
const J = (v) => JSON.stringify(v);
function check(name, ok, detail) {
  total++;
  if (!ok) failed++;
  lines.push('  ' + (ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail == null ? '' : '  → ' + detail));
}
function eq(name, got, want) { check(name, J(got) === J(want), '실제 ' + J(got) + ' / 기대 ' + J(want)); }

// ── a) 텍스트 파서 ─────────────────────────────────────────────
lines.push('  [a) 가격·할인율·리뷰 수 텍스트]');
eq("가격 '59,800원'", F.csrWonText('59,800원'), 59800);
eq("가격 공백 포함 ' 34,000원 '", F.csrWonText(' 34,000원 '), 34000);
eq("쿠폰 문장 '100원 / 와우 가입 쿠폰' 은 가격 아님", F.csrWonText('100원 / 와우 가입 쿠폰'), null);
eq("단가 '(100g당 1,250원)' 은 가격 아님", F.csrWonText('(100g당 1,250원)'), null);
eq("'0원' 은 null", F.csrWonText('0원'), null);
eq("할인율 '27%'", F.csrPercentText('27%'), 27);
eq("할인율 '100%' 는 null", F.csrPercentText('100%'), null);
eq("할인율 '최대 27%' 는 null", F.csrPercentText('최대 27%'), null);
eq("리뷰 '(1,843)'", F.csrReviewCountText('(1,843)'), 1843);
eq("리뷰 '( 31 )'", F.csrReviewCountText('( 31 )'), 31);
eq("리뷰 '1,843' (괄호 없음) 은 null", F.csrReviewCountText('1,843'), null);
eq("리뷰 '(무료배송)' 은 null", F.csrReviewCountText('(무료배송)'), null);
eq("평점 aria-label '4.5'", F.csrNum('4.5'), 4.5);
eq("평점 '7' 은 범위 밖 null", F.csrNum('7'), null);

// ── b) 가격 영역 말단 ──────────────────────────────────────────
lines.push('');
lines.push('  [b) PriceArea 말단 → 판매가·원가·할인율]');
eq('실측 형태: 할인 라벨·할인율·원가(del)·판매가·쿠폰',
  F.csrPickPriceLeaves([
    { text: '와우쿠폰할인', inDel: false }, { text: '27%', inDel: false },
    { text: '82,720원', inDel: true }, { text: '59,800원', inDel: false },
    { text: '100원', inDel: false }, { text: '와우 가입 쿠폰', inDel: false },
  ]),
  { price: 59800, originalPrice: 82720, discountRate: 27 });
eq('원가·할인 없는 카드', F.csrPickPriceLeaves([{ text: '34,000원', inDel: false }]),
  { price: 34000, originalPrice: null, discountRate: null });
eq('del 안 금액은 판매가가 아님', F.csrPickPriceLeaves([{ text: '35,900원', inDel: true }]),
  { price: null, originalPrice: 35900, discountRate: null });
eq('빈 입력', F.csrPickPriceLeaves(null), { price: null, originalPrice: null, discountRate: null });

// ── c) 로켓 badge-id ───────────────────────────────────────────
lines.push('');
lines.push('  [c) img[data-badge-id] → 로켓 종류]');
eq('ROCKET → 로켓배송', F.csrRocketFromBadgeIds(['ROCKET']), '로켓배송');
eq('ROCKET_MERCHANT → 판매자로켓', F.csrRocketFromBadgeIds(['ROCKET_MERCHANT']), '판매자로켓');
eq('ROCKET_JIKGU → 로켓직구', F.csrRocketFromBadgeIds(['ROCKET_JIKGU']), '로켓직구');
eq('GLOBAL_ROCKET → 로켓직구', F.csrRocketFromBadgeIds(['GLOBAL_ROCKET']), '로켓직구');
eq('ROCKET_FRESH → 로켓프레시', F.csrRocketFromBadgeIds(['ROCKET_FRESH']), '로켓프레시');
eq('FRESH → 로켓프레시', F.csrRocketFromBadgeIds(['FRESH']), '로켓프레시');
eq('TOMORROW 는 로켓 아님', F.csrRocketFromBadgeIds(['TOMORROW']), null);
eq('ROCKET + TOMORROW → 로켓배송', F.csrRocketFromBadgeIds(['TOMORROW', 'ROCKET']), '로켓배송');
eq('모르는 id 는 무시', F.csrRocketFromBadgeIds(['ROCKET_SOMETHING_NEW', 'COUPICK']), null);
eq('빈 배열', F.csrRocketFromBadgeIds([]), null);
eq('RankMark 클래스 → 순위', F.csrRankFromClassName('RankMark_rank3__EWwz0'), 3);
eq('RankMark 없으면 null', F.csrRankFromClassName('ProductUnit_productName__gre7e'), null);

// ── d) href 파싱·광고 판별 ─────────────────────────────────────
lines.push('');
lines.push('  [d) 카드 href → productId·vendorItemId·itemId·rank, 광고 판별]');
const HREF_NORMAL = '/vp/products/6472758137?itemId=14135487433&vendorItemId=81382345678&sourceType=srp_product&clickEventId=abc&korePlacement=15&q=%EA%B3%A0%EC%96%91%EC%9D%B4&searchId=xyz&searchRank=2&rank=2&itemsCount=60';
const HREF_AD = '/vp/products/7660384708?itemId=20406909698&vendorItemId=85870000001&sourceType=srp_product_ads&clickEventId=def&korePlacement=15&q=x&searchId=y&searchRank=0';
eq('일반 카드 href', F.csrParseProductHref(HREF_NORMAL),
  { productId: '6472758137', vendorItemId: '81382345678', itemId: '14135487433', rank: 2, isAd: false });
eq('광고 카드 href', F.csrParseProductHref(HREF_AD),
  { productId: '7660384708', vendorItemId: '85870000001', itemId: '20406909698', rank: null, isAd: true });
check('sourceType=srp_product 는 광고 아님', F.csrIsAdHref(HREF_NORMAL) === false);
check('sourceType=srp_product_ads 는 광고', F.csrIsAdHref(HREF_AD) === true);
check('sourceType=srp_product_ads_x 같은 다른 값은 광고 아님', F.csrIsAdHref('/vp/products/1?sourceType=srp_product_ads_x') === false);
eq('파라미터 없는 깔끔한 URL', F.csrParseProductHref('https://www.coupang.com/vp/products/245133941'),
  { productId: '245133941', vendorItemId: null, itemId: null, rank: null, isAd: false });
eq('검색 URL 은 productId 없음', F.csrParseProductHref('https://www.coupang.com/np/search?q=abc').productId, null);
eq('q 파라미터 디코딩', F.csrQueryParam(HREF_NORMAL, 'q'), '고양이');
eq('URL 생성자 없이 절대 URL', F.csrAbsUrl('/vp/products/1?a=1', 'https://www.coupang.com/np/search?q=x'), 'https://www.coupang.com/vp/products/1?a=1');
eq('프로토콜 상대 이미지', F.csrAbsUrl('//thumbnail.coupangcdn.com/a.jpg'), 'https://thumbnail.coupangcdn.com/a.jpg');

// ── e) JSON-LD (mainEntity 구조, 실측 형태) ────────────────────
lines.push('');
lines.push('  [e) JSON-LD CollectionPage.mainEntity(ItemList)]');
const LD = JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'CollectionPage',
  name: '고양이 이동장 - 쿠팡',
  mainEntity: {
    '@type': 'ItemList',
    numberOfItems: 3,
    itemListElement: [
      { '@type': 'ListItem', position: 1, item: {
        '@type': 'Product', name: '스페이스캣 반려동물 3면 통풍 백팩형 이동가방, 그레이',
        url: 'https://www.coupang.com/vp/products/6472758137?itemId=14135487433&vendorItemId=81382345678',
        image: 'https://thumbnail.coupangcdn.com/thumbnails/remote/320x320ex/image/a.jpg',
        offers: { '@type': 'Offer', price: 34000, priceCurrency: 'KRW', availability: 'https://schema.org/InStock' },
        aggregateRating: { '@type': 'AggregateRating', ratingValue: 5, reviewCount: 1843 } } },
      { '@type': 'ListItem', position: 2, item: {
        '@type': 'Product', name: '코지스 강아지 백팩 고양이 이동장 산책가방 앞가방, 1개',
        url: 'https://www.coupang.com/vp/products/8299680606?itemId=23941824046&vendorItemId=90960000001',
        image: ['https://thumbnail.coupangcdn.com/b.jpg'],
        offers: { '@type': 'Offer', price: '19900', availability: 'https://schema.org/OutOfStock' },
        aggregateRating: { '@type': 'AggregateRating', ratingValue: '4.5', reviewCount: '598' } } },
      { '@type': 'ListItem', position: 3, item: {
        '@type': 'Product', name: 'JSON-LD 에만 있는 상품',
        url: 'https://www.coupang.com/vp/products/1111111111?itemId=2&vendorItemId=3',
        offers: { '@type': 'Offer', price: 25000, availability: 'https://schema.org/InStock' } } },
    ],
  },
});
const ld = F.parseCoupangSearchJsonLd(LD);
eq('mainEntity 아래 3개를 읽음(예전 0개 버그)', ld.length, 3);
eq('1번 productId·vendorItemId·itemId', [ld[0].productId, ld[0].vendorItemId, ld[0].itemId], ['6472758137', '81382345678', '14135487433']);
eq('1번 가격·평점·리뷰', [ld[0].price, ld[0].rating, ld[0].reviewCount], [34000, 5, 1843]);
eq('1번 cleanUrl = JSON-LD url', ld[0].cleanUrl, 'https://www.coupang.com/vp/products/6472758137?itemId=14135487433&vendorItemId=81382345678');
eq('2번 문자열 가격·평점·리뷰', [ld[1].price, ld[1].rating, ld[1].reviewCount], [19900, 4.5, 598]);
check('2번 OutOfStock → soldOut', ld[1].soldOut === true);
eq('2번 이미지 배열 첫 원소', ld[1].image, 'https://thumbnail.coupangcdn.com/b.jpg');
check('JSON-LD 항목의 광고 여부는 모름(false)·searchRank null', ld.every((x) => x.adBadge === false && x.searchRank === null));
const KEYS = Object.keys(F.csrBlankItem()).sort().join(',');
eq('항목 필드 집합(계약 1)', KEYS, ['adBadge', 'cleanUrl', 'coupangRank', 'discountRate', 'freeShipping', 'image', 'itemId', 'name',
  'originalPrice', 'price', 'productId', 'rating', 'reviewCount', 'rocket', 'searchRank', 'soldOut', 'url', 'vendorItemId'].join(','));
eq('구형 ItemList 최상위', F.parseCoupangSearchJsonLd(JSON.stringify({ '@type': 'ItemList', itemListElement: [{ item: { name: 'a', url: '/vp/products/5' } }] })).length, 1);
eq('@graph 안 ItemList', F.parseCoupangSearchJsonLd(JSON.stringify({ '@graph': [{ '@type': 'ItemList', itemListElement: [{ '@type': 'Product', name: 'b', url: '/vp/products/6' }] }] })).length, 1);
eq('깨진 JSON → []', F.parseCoupangSearchJsonLd('{not json'), []);
eq('BreadcrumbList 만 → []', F.parseCoupangSearchJsonLd(JSON.stringify({ '@type': 'BreadcrumbList', itemListElement: [] })), []);

// ── f) DOM 카드 + JSON-LD 보강 ─────────────────────────────────
lines.push('');
lines.push('  [f) DOM 카드 1개 = 원소 1개, JSON-LD 는 빈 값만 채움]');
function dom(over) { return Object.assign(F.csrBlankItem(), over); }
const DOM = [
  // 광고 카드와 일반 카드가 같은 productId — 병합하지 않는다
  dom({ productId: '6472758137', vendorItemId: '81382345678', name: '스페이스캣 (광고)', price: 34000, adBadge: true, searchRank: 1, url: 'https://www.coupang.com/vp/products/6472758137?vendorItemId=81382345678&sourceType=srp_product_ads' }),
  dom({ productId: '6472758137', vendorItemId: '81382345678', name: '스페이스캣', price: null, rating: null, reviewCount: null, rocket: '로켓배송', searchRank: 2, coupangRank: 1 }),
  // 같은 productId, 다른 옵션(vendorItemId) — 상품 단위 값만
  dom({ productId: '8299680606', vendorItemId: '99999999999', name: '코지스 다른 옵션', price: null, searchRank: 3 }),
  dom({ productId: null, name: '링크 없는 카드', searchRank: 4 }),
];
const merged = F.csrEnrichWithJsonLd(DOM, ld);
eq('원소 수 = DOM 카드 4개만 (JSON-LD 전용 상품은 넣지 않음)', merged.length, 4);
check('JSON-LD 에만 있는 상품(화면에 카드 없음)은 빠짐', !merged.some((x) => x.productId === '1111111111'));
check('광고·일반 카드가 따로 남음', merged[0].adBadge === true && merged[1].adBadge === false && merged[0].searchRank === 1 && merged[1].searchRank === 2);
eq('DOM 값이 있으면 그대로(광고 카드 이름)', merged[0].name, '스페이스캣 (광고)');
eq('같은 옵션: 빈 가격·평점·리뷰를 JSON-LD 로 채움', [merged[1].price, merged[1].rating, merged[1].reviewCount], [34000, 5, 1843]);
check('같은 옵션: cleanUrl 채움, 로켓·쿠팡순위 유지', merged[1].cleanUrl === ld[0].cleanUrl && merged[1].rocket === '로켓배송' && merged[1].coupangRank === 1);
eq('다른 옵션: 평점·리뷰만 채우고 가격은 비움', [merged[2].price, merged[2].rating, merged[2].reviewCount, merged[2].cleanUrl], [null, 4.5, 598, null]);
check('다른 옵션: JSON-LD 품절을 옮기지 않음', merged[2].soldOut === false);
check('JSON-LD 중 DOM 에 있는 상품은 다시 붙이지 않음', merged.filter((x) => x.productId === '8299680606').length === 1);
const ldOnly = F.csrEnrichWithJsonLd([], ld);
eq('DOM 카드 0개일 때만 JSON-LD 로 대신(숨은 탭 보호)', ldOnly.length, 3);
check('대신한 항목은 searchRank·coupangRank null, adBadge false', ldOnly.every((x) => x.searchRank === null && x.coupangRank === null && x.adBadge === false));
eq('DOM 카드 1개라도 있으면 JSON-LD 전용 상품을 붙이지 않음',
  F.csrEnrichWithJsonLd([dom({ productId: '9999', name: '다른 검색어 카드', price: 1000, searchRank: 1 })], ld).map((x) => x.productId), ['9999']);
eq('이름·링크 없는 쓰레기 원소만 있으면 0개로 보고 JSON-LD 로 대신', F.csrEnrichWithJsonLd([null, 'x'], ld).length, 3);
eq('둘 다 없음 → []', F.csrEnrichWithJsonLd(null, null), []);

// ── g) 접근 거부·빈 페이지 판별 ─────────────────────────────
lines.push('');
lines.push('  [g) 카드·JSON-LD 0개 → blocked]');
eq('카드 있음 → 정상', F.csrDetectBlocked(60, 0, ''), { blocked: false, denied: false });
eq('JSON-LD 만 있음 → 정상', F.csrDetectBlocked(0, 54, ''), { blocked: false, denied: false });
eq('둘 다 0 + 접근 거부 문구 → blocked·denied', F.csrDetectBlocked(0, 0, '쿠팡  요청하신 페이지의 사용권한이 없습니다.  홈으로'), { blocked: true, denied: true });
eq('둘 다 0 + Access Denied → denied', F.csrDetectBlocked(0, 0, 'Access Denied  You don\'t have permission'), { blocked: true, denied: true });
eq('둘 다 0 + 문구 없음 → blocked, 단정 안 함', F.csrDetectBlocked(0, 0, '검색 결과가 없습니다'), { blocked: true, denied: false });
eq('카드가 있으면 본문에 거부 문구가 있어도 정상', F.csrDetectBlocked(3, 0, '사용권한이 없습니다'), { blocked: false, denied: false });
eq('이상한 입력(null·음수) → blocked', F.csrDetectBlocked(null, -1, null), { blocked: true, denied: false });

// ── h) 순위 오버레이 문구 ──────────────────────────────────────
lines.push('');
lines.push('  [h) 3축 점수·제외 칩·패널 하단 문구]');
eq('3축 점수', F.rankOvAxes({ price: 100, quality: 92.4, safety: 85 }, false), '가격 100 · 품질 92 · 안정 85');
eq('평점 없으면 품질에 (평점 없음)', F.rankOvAxes({ price: 40, quality: 30, safety: 60 }, true), '가격 40 · 품질 30(평점 없음) · 안정 60');
eq('점수 없음 → –', F.rankOvAxes(null, false), '가격 – · 품질 – · 안정 –');
eq('null 순위는 0 이 아니라 –', F.rankOvScore(null), '–');
eq('광고로만 나온 상품 칩', F.rankOvChipLabel('ad', false), '광고 · 순위 제외');
eq('같은 상품이 순위에 있는 광고 카드 칩', F.rankOvChipLabel('ad', true), '광고 · 순위는 일반 카드');
eq('품절 칩', F.rankOvChipLabel('soldOut', false), '품절');
eq('badUrl 은 칩 없음', F.rankOvChipLabel('badUrl', false), null);
eq('모르는 사유는 칩 없음', F.rankOvChipLabel('zzz', false), null);
eq('하단: 사유별 개수(상품 단위), 0 생략, 광고는 광고로만 나온 상품 수',
  F.rankOvFooterText(48, 41, [
    { productId: '1', why: 'ad' }, { productId: '2', why: 'soldOut' },
    { productId: '3', why: 'accessory' }, { productId: '4', why: 'accessory' },
    { productId: '5', why: 'outlier' }, { productId: '6', why: 'current' }, { productId: '7', why: 'badUrl' },
  ]),
  '검색 결과 48개 중 41개 순위 · 제외: 광고 상품 1·품절 1·액세서리 2·가격 이상치 1·지금 보던 상품 1·링크 확인 불가 1 · 페이지의 가격·평점·리뷰·배송 정보로 계산했어요');
eq('하단: 규격 확인 불가 포함', F.rankOvFooterText(20, 18, [{ why: 'noSpec' }, { why: 'noSpec' }]),
  '검색 결과 20개 중 18개 순위 · 제외: 규격 확인 불가 2 · 페이지의 가격·평점·리뷰·배송 정보로 계산했어요');
eq('하단: 제외 없음', F.rankOvFooterText(5, 5, null), '검색 결과 5개 중 5개 순위 · 페이지의 가격·평점·리뷰·배송 정보로 계산했어요');

// ── 마무리 ─────────────────────────────────────────────────────
lines.push('');
lines.push(failed === 0 ? '  ✅ ' + total + '개 전부 통과' : '  ❌ ' + total + '개 중 ' + failed + '건 실패');
const report = lines.join('\n');
if (IS_NODE) {
  console.log(report);
  if (failed > 0) process.exit(1);
} else {
  // osascript: 마지막 표현식 출력만으로는 실패해도 종료 코드가 0 이라 run-all.sh 가 통과로 본다.
  // stdout 에 직접 쓰고 종료 코드로 알린다 (sidebar-price.test.js 와 같은 방식).
  ObjC.import('Foundation');
  ObjC.import('stdlib');
  $.NSFileHandle.fileHandleWithStandardOutput.writeData($(report + '\n').dataUsingEncoding($.NSUTF8StringEncoding));
  $.exit(failed > 0 ? 1 : 0);
}
