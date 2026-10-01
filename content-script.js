// 버전 마커 — 페이지 콘솔(F12)에서 새 버전 로드 여부 확인용
console.log('[ShoMate] content-script v1.9.0 로드됨');

const selectors = {
  title: ['.title_main', '.prod-buy-header__title', '.prod_title', '#productTitle', '.product_title', '.title', 'h1', 'h2', '.prod-name', '.prod-name__title'],
  // 구체적(플랫폼 전용) → 일반 순서. querySelector 첫 매칭을 사용하므로 순서가 중요
  price: [
    // 쿠팡 전용 — 할인가(sale-price) 영역 우선, 단품가(unit-price) 회피
    '.sale-price .total-price strong',
    '.sale-price .total-price',
    '.prod-sale-price .total-price strong',
    '.prod-sale-price strong',
    '#ct-prod-price-area .sale-price strong',
    '#ct-prod-price-area .total-price strong',
    '#ct-prod-price-area .total-price',
    // 11번가
    '.price_real strong',
    '.price_real',
    // 네이버쇼핑
    '.price_num strong',
    '.price_num',
    // 일반
    '.total-price strong',
    '.total-price',
    '.final-price',
    '.sale_price',
    '.price_info',
    'span.price',
  ],
  originalPrice: [
    '.prod-origin-price .origin-price',
    '.prod-origin-price',
    '.origin-price',
    '.price_origin',
    '.price_list .origin',
    '.strike_price',
    '.price-before',
    '.price_before_discount',
  ],
  shipping: ['.delivery_info', '.delivery_type', '.shipping_info', '.pay_shipping', '.desc_ship', '.delivery', '.shipping', '.ship-type'],
  option: ['.option_selected', '.selected_option', '.option_value', '.selected_value', '.prod_option', '.prod-buy-header__option', '.option'],
  // 판매자 블록 — 구체적(플랫폼) → 일반
  seller: [
    // 쿠팡
    '.prod-sale-vendor-name', '.prod-seller', '.prod-vendor', '.seller-name', '.vendor-name',
    // 11번가
    '.c_product_seller', '.seller_info', '.seller', '.s_name',
    // 네이버
    '.basicList_mall__sbVax', '.mall_txt', '.seller_name', '.seller_link', '.product_mall',
    // 일반
    '[class*="seller"]', '[class*="vendor"]', '[class*="mall"]',
  ],
  productArea: ['#product_detail', '.product_info', '.specs', '.prod_desc', '.product_description', 'body'],
};

// 리뷰 본문 셀렉터 — 플랫폼 전용 → 제네릭 순서
const reviewSelectors = [
  // 쿠팡
  '.sdp-review__article__list__review__content',
  '.js_reviewArticleContent',
  '.sdp-review__article__list__review',
  // 11번가
  '.review_text',
  '.cont_review',
  '.c_product_review_cont',
  // 네이버 (스마트스토어/쇼핑 리뷰 본문)
  '.review_text_area',
  '.reviewItems_text__XrSSf',
  // 제네릭 — class에 review 포함된 텍스트 노드
  '[class*="review"] [class*="content"]',
  '[class*="review"] [class*="text"]',
  '[class*="reviewContent"]',
  '[class*="review-content"]',
];

// querySelectorAll 전체 수집 대신 셀렉터 순서대로 첫 매칭 하나만 반환
const queryFirst = (sels) => {
  for (const sel of sels) {
    try {
      const el = document.querySelector(sel);
      const text = el?.textContent?.trim();
      if (text) return text;
    } catch (_) {}
  }
  return null;
};

const getMetaContent = (keys) => {
  for (const key of keys) {
    const meta = document.querySelector(`meta[property="${key}"]`) || document.querySelector(`meta[name="${key}"]`);
    if (meta && meta.content) return meta.content.trim();
  }
  return null;
};

const queryText = (sels) => {
  const results = [];
  sels.forEach(sel => document.querySelectorAll(sel).forEach(node => {
    if (node.textContent) results.push(node.textContent.trim());
  }));
  return results.filter(Boolean).join('\n\n');
};

const getFirstImageUrl = () => {
  // og:image가 가장 신뢰도 높음 (쿠팡·네이버 등 모두 메인 상품 이미지 사용)
  const ogImage = getMetaContent(['og:image', 'twitter:image']);
  if (ogImage && ogImage.startsWith('http')) return ogImage;

  // DOM 셀렉터 — 구체적인 것부터, 제네릭('img') 마지막
  const imgSelectors = [
    // 쿠팡
    '.prod-img .prod-image__detail',
    '.prod-buy-image img',
    '.prod-img img',
    '.prod-buy-header__image img',
    // 11번가
    '.prod_img img',
    '.thumbnail_img img',
    '#mainImg',
    // 네이버
    '.product_img img',
    '.product-image img',
    '#product-images img',
    // 일반
    '.image img',
    '.prod-image img',
  ];

  for (const sel of imgSelectors) {
    const img = document.querySelector(sel);
    if (!img) continue;
    // src 없으면 lazy-load 속성 확인
    const url = img.src
      || img.getAttribute('data-img-cdn-src')
      || img.getAttribute('data-src')
      || img.getAttribute('data-lazy-src');
    if (url && url.startsWith('http')) return url;
  }

  // 마지막 수단: 크기가 충분한 img 중 첫 번째
  for (const img of document.querySelectorAll('img')) {
    const url = img.src || img.getAttribute('data-src') || img.getAttribute('data-img-cdn-src');
    if (!url || !url.startsWith('http')) continue;
    if (img.naturalWidth >= 100 || img.width >= 100) return url;
  }

  return null;
};

// JSON-LD 구조화 데이터에서 offers.price 추출 (가장 신뢰도 높음)
const getJsonLdPrice = () => {
  const scripts = document.querySelectorAll('script[type="application/ld+json"]');
  for (const script of scripts) {
    try {
      const data = JSON.parse(script.textContent || '');
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        const offers = item.offers;
        if (!offers) continue;
        const offerList = Array.isArray(offers) ? offers : [offers];
        for (const offer of offerList) {
          const price = offer.price ?? offer.lowPrice;
          // 100원 미만은 그램·용량 등 스펙값으로 간주하고 무시
          if (price != null && !isNaN(Number(price)) && Number(price) >= 100) return String(price);
        }
      }
    } catch (_) {}
  }
  return null;
};

// 추천·함께 본 상품·캐러셀·광고 섹션 판별 — 이런 영역의 가격은 '현재 상품'이 아니므로 배제.
// (쿠팡 등에서 하단 추천상품 카드의 판매가/취소선 원가를 잘못 긁어 18,050원·37,955원 같은 오추출 발생)
const PROMO_SECTION_RE = /recommend|related|carousel|slider|together|similar|also-|also_|cross-?sell|upsell|bundle|sd-list|other-?product|ranking|rank-|best-?seller|widget|banner|advertise|(^|[-_])ad([-_]|$)|프로모|추천|함께|다른\s*고객|비슷|광고/i;
const isInPromoSection = (el) => {
  let node = el;
  for (let i = 0; i < 14 && node && node.nodeType === 1; i++) {
    const cls = typeof node.className === 'string' ? node.className : (node.getAttribute && node.getAttribute('class')) || '';
    const idc = (node.id || '') + ' ' + cls;
    if (idc.trim() && PROMO_SECTION_RE.test(idc)) return true;
    node = node.parentElement;
  }
  return false;
};

// DOM 셀렉터에서 가격 텍스트 추출 — 100원 미만은 스펙값으로 보고 건너뜀.
// 추천/캐러셀 섹션 요소는 건너뛰고 '현재 상품'의 가격만 취한다.
// 조건부 가격 컨테이너 — 쿠폰 다운로드·멤버십 가입·특정 카드 결제를 전제로 한 가격.
// 쿠팡의 "와우 가입 쿠폰할인가"(0원/16,500원 등)가 DOM 상 일반할인가보다 위에 와서
// 먼저 잡히는 문제. '현재가'는 조건 없이 누구나 내는 값이어야 시세 비교가 맞다.
const CONDITIONAL_PRICE_RE = /coupon|쿠폰|wow-?(member|price)|membership|card-?(benefit|discount|price)|instant-?discount|즉시할인/i;
const isConditionalPrice = (el) => {
  let node = el;
  for (let i = 0; i < 8 && node && node.nodeType === 1; i++) {
    const cls = typeof node.className === 'string' ? node.className : (node.getAttribute && node.getAttribute('class')) || '';
    const idc = (node.id || '') + ' ' + cls;
    if (idc.trim() && CONDITIONAL_PRICE_RE.test(idc)) return true;
    node = node.parentElement;
  }
  return false;
};

// 진단용 — 마지막 추출에서 셀렉터별로 무엇이 잡혔는지 (F12 콘솔 '[ShoMate] 가격추출' 로그에 실림)
let _priceCandidates = [];

// 다른 상품으로 가는 링크 안의 가격은 '현재 상품'의 가격이 아니다 (추천 카드·다른 판매자·묶음 상품).
// 클래스명으로는 못 거르는 카드까지 걸러낸다. 같은 페이지 앵커(#, 옵션 링크)와 javascript:/tel: 같은
// 비-http 링크는 통과 — 구형 몰은 가격을 <a href="javascript:;"> 로 감싸기도 한다.
const isInOtherPageLink = (el) => {
  const a = el.closest && el.closest('a[href]');
  if (!a) return false;
  try {
    const u = new URL(a.href, location.href);
    if (!/^https?:$/.test(u.protocol)) return false;
    const norm = (p) => String(p || '').replace(/\/+$/, '');
    return u.hostname !== location.hostname || norm(u.pathname) !== norm(location.pathname);
  } catch (_) { return false; }
};

// ── 시각 기반 가격 선택 (클래스명에 의존하지 않는다) ────────────────
// 2025 쿠팡 개편 뒤 가격 영역은 .price-container 안에 Tailwind 유틸 클래스(twc-text-[22px] …)만 남아
// 위의 쿠팡 전용 셀렉터가 전부 빗나간다. 그러면 DOM 가격이 비어 JSON-LD 로 넘어가는데, 쿠팡 JSON-LD 는
// 화면가와 다른 값을 담기도 한다 (2026-09-21 실측: 화면 30,920원 / JSON-LD 27,370원).
// 그래서 '보이는 가격 leaf' 중 취소선·할인액·단위가격을 빼고 글자가 가장 큰 것을 고른다.
// 실측 쿠팡 9개 변형(단일가 / 할인율+원가 / "N원 할인" / "N원 와우쿠폰할인" / "(10g당 61원)" /
// 이중 취소선 / "295,490원~ 카드 즉시할인")에서 주 가격은 항상 22px 로 최대였고 나머지는 14~16px 였다.
const PRICE_CONTAINER_SELECTORS = ['.price-container', '[class*="price-layout-container"]'];
const PRICE_LEAF_RE = /^(?:₩|KRW)?([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{3,9})(?:원|won|KRW)?~?$/i;
const PRICE_TOKEN_RE = /[0-9]{1,3}(?:,[0-9]{3})+|[0-9]{3,9}/g;
// "100g당"·"24개입" 같은 수량 표기의 숫자는 가격 토큰으로 세지 않는다 (행 문맥 확장이 거기서 끊기지 않게)
const UNIT_QTY_RE = /[0-9][0-9,.]*\s*(?:kg|g|ml|l|개입|개|매|팩|입|장|정|포|cm|mm|m)(?![a-z])/gi;
// 숫자 바로 옆 라벨로 금액의 성격을 가른다 (같은 행에 가격 토큰이 하나뿐일 때만 라벨로 인정):
//   "와우할인가 27,370원"·"쿠폰적용가" → 조건부 가격
//   "28,820원 할인"·"최대 750원 적립"·"배송비 3,000원"·"5,000원 쿠폰 받기"·"100g당 1,250원" → 가격 아님
// "회원가입"처럼 '가' 뒤에 한글이 이어지면 가격 라벨이 아니고, "12,000원 할인쿠폰 받기"의 12,000 은 가격이다.
const CONDITIONAL_LABEL_RE = /(와우|회원|멤버십|쿠폰|카드|첫\s*구매|앱\s*전용)[^0-9]{0,8}가(?![가-힣])|최대\s*(할인|혜택)가/;
const AMOUNT_AFTER_RE = /^(?:[가-힣\s]{0,6}(?:할인|적립|캐시|포인트|페이백)(?!가|\s*쿠폰|\s*받)|\s*(?:이상|이하|배송비|쿠폰))/;
const AMOUNT_BEFORE_RE = /(?:배송비|할인액|할인\s*금액|할인|쿠폰|적립|포인트|캐시|무이자|보증금|최대|월|[0-9]\s*(?:kg|g|ml|l|개입|개|매|팩|입|장|정|포|cm|mm|m)\s*당)\s*$/i;

const priceLeafKind = (el, token) => {
  // 위로 올라가며 '가격 토큰이 하나뿐인' 가장 큰 조상의 텍스트를 이 숫자의 행 문맥으로 쓴다
  let ctx = (el.innerText || '').replace(/\s+/g, ' ').trim();
  let node = el.parentElement;
  for (let i = 0; i < 4 && node && node.nodeType === 1; i++) {
    if ((node.textContent || '').length > 200) break;   // 큰 조상의 innerText 계산(레이아웃 비용)을 피한다
    const t = (node.innerText || '').replace(/\s+/g, ' ').trim();
    if (t.length > 40 || (t.replace(UNIT_QTY_RE, ' ').match(PRICE_TOKEN_RE) || []).length > 1) break;
    ctx = t;
    node = node.parentElement;
  }
  const idx = ctx.indexOf(token);
  if (idx < 0) return 'price';
  const before = ctx.slice(0, idx).trim();
  const after = ctx.slice(idx + token.length).replace(/^\s*(?:원|won|KRW)?~?/i, '').trim();
  if (CONDITIONAL_LABEL_RE.test(before.slice(-14)) || CONDITIONAL_LABEL_RE.test(after.slice(0, 14))) return 'conditional';
  if (AMOUNT_AFTER_RE.test(after) || AMOUNT_BEFORE_RE.test(before)) return 'amount';
  return 'price';
};

const isStruckThrough = (el) => {
  let node = el;
  for (let i = 0; i < 4 && node && node.nodeType === 1; i++) {
    if (/^(DEL|S|STRIKE)$/.test(node.tagName)) return true;
    const st = getComputedStyle(node);
    if ((st.textDecorationLine || st.textDecoration || '').includes('line-through')) return true;
    node = node.parentElement;
  }
  return false;
};

// root 안의 '가격만 담긴' 보이는 요소를 모은다. 텍스트 노드 기준으로 훑어 큰 페이지에서도 가볍다.
// stats.rejectedNums — 취소선·다른 상품이라 버린 숫자 (호출부가 '이 요소의 첫 숫자가 버려진 값인지' 판단하는 데 쓴다)
const collectPriceLeaves = (root, maxNodes, stats) => {
  const out = [];
  const reject = (num) => { if (stats) (stats.rejectedNums || (stats.rejectedNums = [])).push(num); };
  const seen = new Set();
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n, checked = 0, order = 0;
  while ((n = tw.nextNode()) && checked < maxNodes) {
    checked++;
    const v = n.nodeValue;
    if (!v || v.length > 40 || !/[0-9]{3}/.test(v)) continue;
    const el = n.parentElement;
    if (!el || seen.has(el)) continue;
    seen.add(el);
    const m = (el.innerText || '').replace(/\s+/g, '').match(PRICE_LEAF_RE);
    if (!m) continue;
    // <span>12,</span><span>900</span> 처럼 숫자가 쪼개진 조각은 독립된 가격이 아니다
    const prevText = el.previousSibling ? (el.previousSibling.textContent || '') : '';
    if (/[0-9],\s*$/.test(prevText)) continue;
    const num = Number(m[1].replace(/,/g, ''));
    if (!(num >= 100) || num > PRICE_ABSURD_MAX) continue;
    if (el.closest('#shomate-dp-alert, #shomate-overlay-root, #shomate-fab')) continue;
    if (!el.offsetWidth && !el.getClientRects().length) continue;                       // 화면에 안 보임
    if (isStruckThrough(el)) { reject(num); continue; }                                  // 취소선 = 할인 전 가격
    if (isInPromoSection(el) || isInOtherPageLink(el)) { reject(num); continue; }        // 다른 상품의 가격
    let kind = priceLeafKind(el, m[1]);
    if (kind === 'price' && isConditionalPrice(el)) kind = 'conditional';
    out.push({ el, num, kind, order: order++, font: parseFloat(getComputedStyle(el).fontSize) || 0 });
  }
  return out;
};

// 글자가 가장 큰 가격을 고른다.
//  · 가장 큰 후보의 70% 에 못 미치는 작은 글씨(쿠폰 금액·부가 정보)는 처음부터 뺀다.
//  · plainOnly — 조건 없는 일반가만. 1차 패스는 모든 단계를 plainOnly 로 돌아 '누구나 내는 값'을 먼저 찾는다.
//  · 2차 패스 — 조건부가(와우·쿠폰가), 그리고 "할인" 배지가 옆에 붙어 할인액처럼 보이는 큰(18px↑) 숫자까지 받는다.
const pickLargestPrice = (cands, plainOnly) => {
  if (!cands.length) return null;
  const maxFont = Math.max(...cands.map(c => c.font));
  const big = cands.filter(c => c.font >= maxFont * 0.7);
  const pool = plainOnly
    ? big.filter(c => c.kind === 'price')
    : big.filter(c => c.kind !== 'amount' || c.font >= 18);
  return pool.slice().sort((a, b) => (b.font - a.font) || (a.order - b.order))[0] || null;
};

const notePriceCandidate = (line) => {
  if (_priceCandidates.length < 6 && !_priceCandidates.includes(line)) _priceCandidates.push(line);
};

// 가격 컨테이너 안에서 고른다 (신 쿠팡 레이아웃)
const getContainerPriceText = (plainOnly) => {
  for (const sel of PRICE_CONTAINER_SELECTORS) {
    let roots;
    try { roots = document.querySelectorAll(sel); } catch (_) { continue; }
    for (const root of roots) {
      if (isInPromoSection(root) || isInOtherPageLink(root)) continue;
      if (!root.offsetWidth && !root.getClientRects().length) continue;
      const best = pickLargestPrice(collectPriceLeaves(root, 400), plainOnly);
      if (!best) continue;
      notePriceCandidate(`시각(${sel}) → ${best.num} [${best.font}px${best.kind !== 'price' ? ' ' + best.kind : ''}]`);
      return String(best.num);
    }
  }
  return null;
};

// 최후 수단 — 셀렉터도 컨테이너도 구조화 데이터도 없을 때 페이지 상단에서 가장 크게 쓰인 가격.
// 오탐 통제: 18px 이상·문서 상단 1800px 이내·nav/footer 밖·다른 페이지 링크 밖.
// 같은 크기로 서로 다른 가격이 3개 이상이면 목록 페이지로 보고 포기한다(가격 미검출이 오검출보다 낫다).
const getPageVisualPriceText = (plainOnly) => {
  if (!document.body) return null;
  const cands = collectPriceLeaves(document.body, 8000).filter(c => {
    if (c.font < 18) return false;
    if (c.el.closest('nav, footer')) return false;
    const r = c.el.getBoundingClientRect();
    return r.top + (window.scrollY || 0) < 1800;
  });
  const best = pickLargestPrice(cands, plainOnly);
  if (!best) return null;
  if (new Set(cands.filter(c => c.font === best.font).map(c => c.num)).size >= 3) return null;
  notePriceCandidate(`시각(page) → ${best.num} [${best.font}px${best.kind !== 'price' ? ' ' + best.kind : ''}]`);
  return String(best.num);
};

// 범용 셀렉터 — 어느 몰에나 있을 법한 이름이라 다른 상품 카드까지 걸린다.
const GENERIC_PRICE_SELECTORS = new Set(['.total-price strong', '.total-price', '.final-price', '.sale_price', '.price_info', 'span.price']);

// 추출 순서
//   쿠팡:   몰 전용 셀렉터 → 가격 컨테이너 시각 선택 → 범용 셀렉터
//   그 외:  몰 전용 셀렉터 → 범용 셀렉터 → 가격 컨테이너 시각 선택   (기존에 잘 되던 몰의 동작을 바꾸지 않는다)
//   공통:   → 구조화 데이터(JSON-LD·og)가 없을 때만 페이지 상단 시각 선택
// 1차는 '조건 없는 일반가'만, 그래도 없으면 2차로 조건부가(와우·쿠폰가)까지 받는다 (가격 미검출보다 낫다).
const getValidPriceText = (sels) => {
  _priceCandidates = [];
  const specific = sels.filter(s => !GENERIC_PRICE_SELECTORS.has(s));
  const generic = sels.filter(s => GENERIC_PRICE_SELECTORS.has(s));
  const isCoupang = /(^|\.)coupang\.com$/.test(location.hostname);
  const safe = (fn) => { try { return fn(); } catch (_) { return null; } };
  let hasStructured = null;
  const noStructuredData = () => {
    if (hasStructured === null) {
      hasStructured = safe(() => parseWon(getJsonLdPrice()) != null
        || parseWon(getMetaContent(['og:price:amount', 'product:price:amount', 'price:amount'])) != null) === true;
    }
    return !hasStructured;
  };
  for (const plainOnly of [true, false]) {
    const allowConditional = !plainOnly;
    const stages = isCoupang
      ? [() => scanPriceSelectors(specific, allowConditional), () => getContainerPriceText(plainOnly), () => scanPriceSelectors(generic, allowConditional)]
      : [() => scanPriceSelectors(specific, allowConditional), () => scanPriceSelectors(generic, allowConditional), () => getContainerPriceText(plainOnly)];
    stages.push(() => (noStructuredData() ? getPageVisualPriceText(plainOnly) : null));
    for (const stage of stages) {
      const v = safe(stage);
      if (v != null) return v;
    }
  }
  return null;
};

const scanPriceSelectors = (sels, allowConditional = false) => {
  for (const sel of sels) {
    try {
      for (const el of document.querySelectorAll(sel)) {
        if (isInPromoSection(el) || isInOtherPageLink(el)) continue;
        // innerText = '화면에 보이는' 텍스트만. 숨겨진 쿠폰가/카드가 노드(textContent에는 잡힘)를 배제
        const text = (el.innerText ?? el.textContent)?.trim();
        if (!text) continue;
        // 걸린 요소 안을 시각 규칙으로 읽는다. 11번가는 .price_info 가 둘인데 첫 번째에는 취소선 원가
        // (<del>369,000</del>)만 있고 실제 판매가(321,030, 30px)는 두 번째에 있다 — '첫 숫자'를 집으면 원가가 현재가로 둔갑한다.
        // 단, "판매가 12,000원 배송비 <b>3,000</b>원"처럼 주 가격이 leaf 로 안 읽히는 구조에서는 기존처럼 첫 가격 토큰을 쓴다.
        const stats = { rejectedNums: [] };
        const leaves = collectPriceLeaves(el, 300, stats);
        const first = parseWon(text);
        const firstIsLeaf = leaves.some(c => c.num === first);
        const firstRejected = stats.rejectedNums.includes(first);
        let n, conditional;
        if (first != null && !firstIsLeaf && !firstRejected) {
          n = first;                                         // 첫 토큰이 leaf 도 아니고 버려진 값도 아님 → 기존 동작
          conditional = isConditionalPrice(el);
        } else {
          const best = pickLargestPrice(leaves, !allowConditional);
          if (!best) continue;                               // 취소선·할인액·다른 상품뿐 → 이 요소는 현재가가 아니다
          n = best.num;
          conditional = best.kind !== 'price' || isConditionalPrice(el);
        }
        const pc = el.parentElement, pcls = pc ? (typeof pc.className === 'string' ? pc.className : '') : '';
        notePriceCandidate(`${sel} → ${n}${conditional ? ' (조건부)' : ''} [${pcls.slice(0, 60)}]`);
        if (!allowConditional && conditional) continue;
        return String(n);
      }
    } catch (_) {}
  }
  return null;
};

// 평점 텍스트 파서 — 0~5 범위의 '독립된' 토큰만. "19개"의 1, "2024년"의 2 같은 오염 차단.
const RATING_UNIT_RE = /(?<![\d.])([0-5](?:\.\d)?)(?![\d.])\s*(?:점|\/\s*5(?![\d.])|stars?|★)/i;
const RATING_DECIMAL_RE = /(?<![\d.])([0-5]\.\d)(?![\d.])/;
const parseRatingText = (t) => {
  if (!t) return null;
  const m = t.match(RATING_UNIT_RE) || t.match(RATING_DECIMAL_RE);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) && v >= 0 && v <= 5 ? v : null;
};

// 별 그래픽의 채움 폭 → 점수. 쿠팡 .rating-star-num(style="width: 90%") 등. 추천상품 카드의 별은 제외.
const ratingFromStarWidth = () => {
  try {
    const els = document.querySelectorAll(
      '[class*="rating"] [style*="width"], [class*="star"] [style*="width"], [class*="rating"][style*="width"], [class*="star"][style*="width"]'
    );
    for (const el of els) {
      if (isInPromoSection(el)) continue;
      const m = (el.getAttribute('style') || '').match(/width\s*:\s*([0-9]{1,3}(?:\.[0-9]+)?)%/);
      if (!m) continue;
      const pct = Number(m[1]);
      if (pct > 0 && pct <= 100) return Math.round(pct / 20 * 10) / 10;   // 90% → 4.5
    }
  } catch (_) {}
  return null;
};

// 판매자 신뢰 신호 수집 — 셀렉터 우선, body 텍스트 regex 폴백
const collectSellerSignals = () => {
  const bodyText = document.body?.innerText || '';

  let sellerName = queryFirst(selectors.seller);
  if (sellerName) sellerName = sellerName.replace(/\s+/g, ' ').trim().slice(0, 60);

  // 평점 — 예전 정규식은 "첫 번째 0~5 숫자"를 평점으로 읽어서, 쿠팡의 평점 영역 텍스트
  // "19개 상품평"에서 1 을 뽑아 "평점 1.0점" 경고를 냈다(실제 4.5). 순서를 바꾼다:
  //   1) 평점 요소 텍스트에서 '독립된' 점수 토큰만 — 소수점(4.5) 또는 단위(점·/5·stars·★) 필수
  //   2) 별 채움 폭(style="width: 90%") → 4.5  (쿠팡·11번가 등 별 그래픽)
  //   3) body 텍스트 "평점 4.5" (뒤에 숫자가 더 붙으면 무시)
  let sellerRating = null;
  const ratingText = queryFirst(['.rating', '.star-rating', '.prod-rating', '.score', '[class*="rating"]', '[class*="score"]']);
  sellerRating = parseRatingText(ratingText);
  if (sellerRating == null) sellerRating = ratingFromStarWidth();
  if (sellerRating == null) {
    const m = bodyText.match(/(?:평점|별점|평균\s*별점)\D{0,4}([0-5](?:\.[0-9])?)(?![\d.])/);
    if (m) sellerRating = Number(m[1]);
  }

  let reviewCount = null;
  const reviewText = queryFirst(['.count-num', '.review-count', '.js_reviewArea', '[class*="review"]', '[class*="count"]']);
  const rcSel = reviewText && reviewText.replace(/,/g, '').match(/([0-9]{1,7})/);
  if (rcSel) reviewCount = Number(rcSel[1]);
  if (reviewCount == null) {
    const m = bodyText.replace(/,/g, '').match(/(?:리뷰|구매평|상품평|평가|후기)\D{0,4}([0-9]{1,7})\s*(?:건|개)?/);
    if (m) reviewCount = Number(m[1]);
  }

  let lowReviewWarning = null;
  const lrw = bodyText.match(/([0-9]{1,4})\s*건\s*이하의\s*평가/);
  if (lrw) lowReviewWarning = lrw[0].trim();

  const sellerBlockText = (queryText(selectors.seller) || '').slice(0, 400) || null;

  return { sellerName, sellerRating, reviewCount, lowReviewWarning, sellerBlockText };
};

// ── 다크패턴 감지 ───────────────────────────────────────────────
// 텍스트 규칙 + DOM 구조 규칙 두 갈래로 본다.
// 텍스트만으로는 '미리 선택된 체크박스'처럼 문구가 아니라 상태로 존재하는 유형을 못 잡는다.
//
// 출력 원칙 (브랜드 원칙): 단정하지 않고 관측 사실을 근거와 함께 진술한다.
// 모든 판정은 다음 필드를 갖는다:
//   fairType       공정위 「온라인 다크패턴 가이드라인」 19개 세부유형 중 해당 유형
//   law            2025.2.14 시행 개정 전자상거래법이 금지하는 5개 유형이면 true
//   evidence       페이지에서 실제로 관측/측정된 문구·수치 (우리가 지어낸 문장이 아님)
//   method         'rule-text' 문구 규칙 / 'rule-dom' DOM 상태 / 'measured' 스타일 측정 / 'observed' 시간 관측
//   evidenceLevel  1 = 그런 '표시'가 존재함을 확인 / 2 = 그 표시가 사실과 다름을 직접 관측
// 규칙이 잡는 것은 기본적으로 evidenceLevel 1이다. "이 문구가 있다"는 사실이지
// "이 문구가 거짓이다"가 아니다 — 후자는 반복 관측(observed)으로만 승격된다.
const DARK_PATTERN_RULES = [
  { id: 'dp-urgency', re: /(남은\s*시간|마감\s*임박|판매\s*종료\s*임박|곧\s*(마감|종료|품절)|오늘\s*(자정|24시)?\s*마감|지금\s*안\s*사면|[0-9]{1,2}\s*분\s*[0-9]{2}\s*초)/,
    fairType: '시간제한 알림 (압박형)', law: false,
    message: '시간 압박 표시(카운트다운·마감 임박)가 있어요. 실제 마감인지는 알 수 없으니 서두르지 마세요.' },
  // "127명이 이 상품을 보고 있어요"처럼 '명'과 동사 사이에 수식어가 끼는 경우가 많아
  // 사이에 짧은 구절(최대 12자)을 허용한다. 문장을 넘지 않도록 마침표·줄바꿈은 제외.
  { id: 'dp-social', re: /([0-9][0-9,]*\s*명(이)?[^.\n]{0,12}?(구매|구입|주문|보고\s*있|담았|참여|신청))/,
    fairType: '다른 소비자의 활동 알림 (압박형)', law: false,
    message: '“N명 구매/보는 중” 표시가 있어요. 이 숫자는 검증할 수 없으니 실제 리뷰 수와 비교하세요.' },
  { id: 'dp-stock', re: /((품절|재고)\s*임박|단\s*[0-9]+\s*개?\s*남|마지막\s*[0-9]+\s*개|[0-9]+\s*개?\s*(밖에\s*)?남았)/,
    fairType: '낮은 재고 알림 (압박형)', law: false,
    message: '재고 압박 표시(“품절 임박/N개 남음”)가 있어요. 인위적으로 만들 수 있는 표시이니 조급해하지 마세요.' },
  { id: 'dp-subscription', re: /(무료\s*체험|첫\s*달\s*무료|무료\s*이용)[\s\S]{0,50}(자동\s*(결제|연장|갱신)|정기\s*결제|매월|구독)|자동\s*결제\s*동의/,
    fairType: '숨은 갱신 (편취형)', law: false,
    message: '무료 안내 근처에 자동결제·정기구독 조건이 있어요. 결제 전 “자동 결제/정기결제” 항목을 꼭 확인하세요.' },
  // 확인 쉐이밍(confirmshaming) — 거절 버튼에 죄책감·손해감을 심는 문구
  { id: 'dp-confirmshaming', re: /(괜찮아요[,\s]*(손해|할인|혜택|비싸게)|아니요[,\s]*(비싸게|손해|정가로)|혜택을?\s*포기|할인\s*받지\s*않을|나중에\s*후회)/,
    fairType: '감정적 언어 사용 (압박형)', law: false,
    message: '거절 선택지에 죄책감을 심는 문구(확인 쉐이밍)예요. 문구가 아니라 필요 여부로 판단하세요.' },
  // 취소·해지 방해(roach motel) — 가입은 쉬운데 해지는 전화·방문만 허용
  // '전용 창구로만' 이라는 배타성 표현까지 요구한다 — 단순 안내문("고객센터로 문의")과 구분
  { id: 'dp-roachmotel', re: /(해지|탈퇴|구독\s*취소)[^.\n]{0,14}?(고객센터|상담원|전화|유선|방문)[^.\n]{0,8}?(에서만|으로만|로만|만)\s*(가능|신청|접수)/,
    fairType: '취소·탈퇴 방해 (방해형)', law: true,
    message: '가입은 클릭 한 번인데 해지는 전화·상담만 허용하는 구조예요(취소 방해). 가입 전 해지 방법을 확인하세요.' },
];

// 라벨 텍스트 추출 — for 속성, 감싼 label, aria-label, 부모 텍스트 순으로 시도
const labelTextFor = (el) => {
  try {
    if (el.labels && el.labels.length) {
      const t = Array.from(el.labels).map(l => l.innerText || '').join(' ').trim();
      if (t) return t;
    }
    const wrap = el.closest('label');
    if (wrap && wrap.innerText) return wrap.innerText.trim();
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();
    const parent = el.parentElement;
    if (parent && parent.innerText && parent.innerText.length < 200) return parent.innerText.trim();
  } catch (_) {}
  return '';
};

// 미리 선택된 동의·추가 항목 (preselection / sneak into basket)
// 법정 필수 동의는 미리 체크돼 있어도 다크패턴이 아니므로 제외한다.
const PRESELECT_TARGET_RE = /(광고|마케팅|프로모션|정보\s*수신|혜택\s*알림|자동\s*결제|정기\s*결제|구독|멤버십|보험|안심\s*케어|추가\s*(구매|상품|옵션)|함께\s*(담기|구매)|사은품|유료)/;
const PRESELECT_EXEMPT_RE = /(필수|\[필수\]|\(필수\)|이용\s*약관\s*동의|개인정보\s*(수집|처리방침)|만\s*14세|전체\s*동의)/;

const detectPreselectedOptIns = () => {
  let boxes;
  try { boxes = document.querySelectorAll('input[type="checkbox"]:checked'); }
  catch (_) { return null; }
  const samples = [];
  for (const el of boxes) {
    if (el.disabled) continue;
    const label = labelTextFor(el).replace(/\s+/g, ' ');
    if (!label || label.length > 120) continue;
    if (PRESELECT_EXEMPT_RE.test(label)) continue;
    if (!PRESELECT_TARGET_RE.test(label)) continue;
    if (samples.length < 3) samples.push(label.slice(0, 40));
  }
  if (!samples.length) return null;
  return {
    id: 'dp-preselect', evidenceLevel: 1, method: 'rule-dom',
    fairType: '특정옵션 사전선택 (오도형)', law: true,
    evidence: `미리 체크된 항목: ${samples.join(' / ')}`,
    message: `동의하지 않았는데 미리 체크된 항목이 있어요 (${samples.join(' / ')}). 결제 전 체크박스를 직접 확인하세요.`,
  };
};

// ── 근거 요소 찾기 + 판정 범위 한정 ─────────────────────────────
// 매칭된 문구가 실제로 '어느 요소'에 있는지 찾는다. 두 가지 목적:
//   1) 근거 표시 — 경고에 "페이지의 이 문구 때문"을 함께 보여준다
//   2) 오탐 컷 — 리뷰·추천상품·광고 영역의 문구는 판매자의 판매 화면이 아니므로 제외
//      (평가 하니스 A1 실험에서 '판정 범위 한정'만으로 오탐 9건 → 2건)
// 한계: 첫 번째 매칭 위치만 확인한다. 같은 문구가 리뷰와 본문에 모두 있으면
// 앞쪽(대개 본문)이 기준이 된다 — Precision 우선 원칙의 의도된 트레이드오프.
const DP_EXCLUDE_SELECTOR = '[class*="review" i], [class*="comment" i], [class*="reply" i], nav, footer, #shomate-dp-alert, #shomate-overlay-root';

const findEvidenceElement = (snippet) => {
  if (!snippet || snippet.length < 4) return null;
  const norm = (s) => String(s).replace(/\s+/g, ' ');
  try {
    // 1차: 단일 텍스트 노드 안에서 찾기 (대부분의 배너·라벨)
    const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n, checked = 0;
    while ((n = tw.nextNode()) && checked < 20000) {
      checked++;
      const t = n.nodeValue;
      if (!t || t.length < 4) continue;
      if (norm(t).includes(snippet)) return n.parentElement;
    }
    // 2차: 문구가 여러 노드에 걸친 경우 — 작은 요소 단위로 재확인
    let scanned = 0;
    for (const el of document.body.querySelectorAll('*')) {
      if (++scanned > 30000) break;
      if (el.children.length > 2) continue;
      const t = el.textContent;
      if (!t || t.length > 300) continue;
      if (norm(t).includes(snippet)) return el;
    }
  } catch (_) {}
  return null;
};

// 시간 관측으로 evidenceLevel 2(기만 확인)에 도달한 판정 — id → finding
const OBSERVED_FINDINGS = new Map();

const detectDarkPatterns = () => {
  const text = (document.body?.innerText || '').replace(/\s+/g, ' ');
  const out = [];
  for (const r of DARK_PATTERN_RULES) {
    try {
      const m = text.match(r.re);
      if (!m) continue;
      const evidence = m[0].trim().slice(0, 90);
      // 근거 요소가 리뷰·추천·광고 영역이면 오탐으로 보고 버린다 (판정 범위 한정)
      const host = findEvidenceElement(evidence);
      if (host && (isInPromoSection(host) || host.closest(DP_EXCLUDE_SELECTOR))) continue;
      out.push({
        id: r.id, evidenceLevel: 1, method: 'rule-text',
        fairType: r.fairType, law: !!r.law,
        evidence, message: r.message,
      });
    } catch (_) {}
  }
  const pre = detectPreselectedOptIns();
  if (pre) out.push(pre);
  const hier = detectManipulativeHierarchy();
  if (hier) out.push(hier);
  for (const obs of OBSERVED_FINDINGS.values()) out.push(obs);
  return out;
};

// ── 카운트다운 시간 관측 (evidenceLevel 1 → 2 승격) ─────────────
// "남은 시간 14:59" 는 규칙만으로는 '그런 표시가 있다'(1)까지만 말할 수 있다.
// 표시가 거짓임(2)은 시간을 두고 지켜봐야만 알 수 있고, 이건 결정론적으로 가능하다:
//   · 카운트다운이 0에 닿기 전에 도로 늘어나면 → 리셋 (실제 마감이 아님)
//   · 표시 시간이 실제 시계와 다른 속도로 흐르면 → 연출된 타이머
// LLM 없이 관측만으로 반증한다 — "반증 가능한 것은 반증으로 판정한다"는 설계 원칙.

// 카운트다운 문자열 → 초. "12:34" / "1:02:03" / "3분 12초" / "1시간 20분" 지원.
// 시각(clock)과의 혼동을 피하는 문맥 판단은 호출부(마감·특가 등 주변 문구 게이트)가 한다.
const parseCountdownSeconds = (raw) => {
  const s = String(raw || '').trim();
  let m = s.match(/(?:(\d{1,2})\s*:\s*)?(\d{1,2})\s*:\s*(\d{2})(?!\d)/);
  if (m) {
    const h = m[1] != null ? Number(m[1]) : 0;
    const mi = Number(m[2]), se = Number(m[3]);
    if (mi < 60 && se < 60) return h * 3600 + mi * 60 + se;
  }
  m = s.match(/(?:(\d{1,2})\s*시간)?\s*(\d{1,3})\s*분\s*(?:(\d{1,2})\s*초)?/);
  if (m && (m[1] != null || m[3] != null)) {
    const h = Number(m[1]) || 0, mi = Number(m[2]) || 0, se = Number(m[3]) || 0;
    if (mi < 600 && se < 60) return h * 3600 + mi * 60 + se;
  }
  return null;
};

const fmtCountdown = (sec) => {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const two = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
};

const CD_CONTEXT_RE = /(마감|남은|남았|종료|임박|타임|특가|세일|딜|한정|할인|deal|sale)/i;
const CD_WATCH = { samples: new Map(), timer: null, startedAt: 0 };
const CD_TICK_MS = 5000;           // 5초 간격 표본
const CD_MAX_WATCH_MS = 15 * 60 * 1000; // 15분 뒤 관측 종료 (메모리·CPU 상한)

// 요소의 안정 키 — 리렌더로 텍스트 노드가 갈려도 조상 경로는 대체로 유지된다.
// 키가 바뀌면 표본이 이어지지 않을 뿐(미탐), 잘못 이어져 오판(리셋 오인)하지는 않는다.
const cdKeyFor = (el) => {
  const parts = [];
  let node = el;
  for (let i = 0; i < 3 && node && node.nodeType === 1; i++) {
    const cls = typeof node.className === 'string' ? node.className.trim().split(/\s+/)[0] : '';
    parts.push(node.tagName + (node.id ? '#' + node.id : cls ? '.' + cls : ''));
    node = node.parentElement;
  }
  return parts.join('>');
};

function scanCountdownsOnce() {
  const now = Date.now();
  if (now - CD_WATCH.startedAt > CD_MAX_WATCH_MS) {
    clearInterval(CD_WATCH.timer); CD_WATCH.timer = null;
    return;
  }
  if (document.hidden) return; // 백그라운드 탭은 사이트 타이머도 지연되므로 표본에서 제외

  let found = 0;
  try {
    const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n, checked = 0;
    while ((n = tw.nextNode()) && checked < 20000 && found < 8) {
      checked++;
      const t = n.nodeValue;
      if (!t || t.length > 60) continue;
      if (!/\d{1,2}\s*:\s*\d{2}|\d+\s*분\s*\d+\s*초/.test(t)) continue;
      const el = n.parentElement;
      if (!el || el.closest(DP_EXCLUDE_SELECTOR) || isInPromoSection(el)) continue;
      // 문맥 게이트: 주변에 마감·특가류 문구가 있어야 카운트다운으로 본다 (시계·영상시간 오인 방지)
      const ctx = ((el.closest('[class]')?.parentElement?.innerText) || el.innerText || '').slice(0, 160);
      if (!CD_CONTEXT_RE.test(ctx)) continue;
      const sec = parseCountdownSeconds(t);
      if (sec == null || sec <= 0 || sec > 48 * 3600) continue;

      found++;
      const key = cdKeyFor(el);
      const prev = CD_WATCH.samples.get(key);
      if (!prev) {
        CD_WATCH.samples.set(key, { first: { sec, at: now }, last: { sec, at: now } });
        continue;
      }
      // (a) 리셋: 0에 닿기 전에 표시값이 도로 크게 늘어남 (+90초 이상 — 서버 재동기화 오차와 구분)
      if (sec > prev.last.sec + 90) {
        OBSERVED_FINDINGS.set('dp-urgency-observed', {
          id: 'dp-urgency-observed', evidenceLevel: 2, method: 'observed',
          fairType: '시간제한 알림 (압박형)', law: false,
          evidence: `카운트다운 ${fmtCountdown(prev.last.sec)} → ${fmtCountdown(sec)} 되돌아감 (${Math.round((now - CD_WATCH.startedAt) / 1000)}초 관측)`,
          message: '카운트다운이 끝나기 전에 되돌아가는 것을 직접 관측했어요. 표시된 마감시간은 실제 마감이 아닙니다.',
        });
        runDarkPatternScan();
      }
      // (b) 속도 이상: 실제 경과와 표시 감소가 크게 다름 (멈춰 있는 타이머 포함)
      const wall = (now - prev.first.at) / 1000;
      const shown = prev.first.sec - sec;
      if (wall >= 45 && shown >= 0 && Math.abs(wall - shown) > Math.max(30, wall * 0.4)) {
        OBSERVED_FINDINGS.set('dp-urgency-drift', {
          id: 'dp-urgency-drift', evidenceLevel: 2, method: 'observed',
          fairType: '시간제한 알림 (압박형)', law: false,
          evidence: `실제 ${Math.round(wall)}초 경과, 표시는 ${Math.round(shown)}초 감소`,
          message: '카운트다운이 실제 시간과 다른 속도로 흐르는 것을 관측했어요. 연출된 타이머일 수 있습니다.',
        });
        runDarkPatternScan();
      }
      prev.last = { sec, at: now };
    }
  } catch (_) {}
}

function startCountdownWatcher() {
  if (CD_WATCH.timer) return;
  CD_WATCH.startedAt = Date.now();
  CD_WATCH.timer = setInterval(scanCountdownsOnce, CD_TICK_MS);
  scanCountdownsOnce();
}

// ── 잘못된 계층구조 측정 (법정 금지 유형) ───────────────────────
// "거절 버튼을 안 보이게 만든다"는 문구가 아니라 스타일의 문제라 규칙 텍스트로는 못 잡는다.
// 대신 측정한다: 수락/거절 버튼 쌍의 글자 크기와 명도 대비(WCAG 산식)를 재서,
// 거절 쪽만 가독 최소 기준(3:1) 미달로 만들어놓은 극단적 비대칭만 보고한다.
// 오탐 통제: '보조 버튼을 연하게'는 정상 디자인이다. 게이트 3중 —
//   구독·동의·결제류 문맥 + 수락은 선명(≥4.5:1)한데 거절만 3:1 미달 (또는 글자 2/3 이하)
const HIER_CONTEXT_RE = /(구독|해지|탈퇴|동의|무료\s*체험|멤버십|정기\s*결제|자동\s*결제|알림\s*받기|혜택|쿠폰)/;
const HIER_POS_RE = /(동의|확인|구독|가입|결제|계속|유지|신청|받기|시작|할게요|할래요|좋아요)/;
const HIER_NEG_RE = /(거절|취소|해지|탈퇴|나중에|괜찮|안\s*할|받지\s*않|아니요|아니오|필요\s*없|그만|안내\s*받지)/;

const _parseRgb = (s) => {
  const m = String(s || '').match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([0-9.]+))?\)/);
  if (!m) return null;
  const a = m[4] != null ? Number(m[4]) : 1;
  if (a < 0.05) return null; // 사실상 투명
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
};
const _relLum = ({ r, g, b }) => {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const _contrast = (c1, c2) => {
  const l1 = _relLum(c1), l2 = _relLum(c2);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
};
// 요소의 실효 배경색 — 투명하면 조상으로 올라간다. 끝까지 없으면 흰색 가정.
const _effectiveBg = (el) => {
  let node = el;
  for (let i = 0; i < 12 && node && node.nodeType === 1; i++) {
    const bg = _parseRgb(getComputedStyle(node).backgroundColor);
    if (bg) return bg;
    node = node.parentElement;
  }
  return { r: 255, g: 255, b: 255 };
};

const detectManipulativeHierarchy = () => {
  let containers;
  try {
    containers = document.querySelectorAll(
      '[role="dialog"], [class*="modal" i], [class*="popup" i], [class*="layer" i], [class*="dialog" i]'
    );
  } catch (_) { return null; }

  let seen = 0;
  for (const box of containers) {
    if (++seen > 12) break;
    if (!box.offsetWidth || !box.offsetHeight) continue;
    const boxText = (box.innerText || '').slice(0, 1200);
    if (!HIER_CONTEXT_RE.test(boxText)) continue;

    let pos = null, neg = null;
    let btnSeen = 0;
    for (const b of box.querySelectorAll('button, [role="button"], input[type="submit"], a')) {
      if (++btnSeen > 40) break;
      if (!b.offsetWidth || !b.offsetHeight) continue;
      const label = (b.innerText || b.value || '').replace(/\s+/g, ' ').trim();
      if (!label || label.length > 30) continue;
      if (/^[✕×xX]$|^닫기$/.test(label)) continue; // 단순 닫기 아이콘은 판단 대상 아님
      if (!pos && HIER_POS_RE.test(label) && !HIER_NEG_RE.test(label)) pos = b;
      else if (!neg && HIER_NEG_RE.test(label)) neg = b;
      if (pos && neg) break;
    }
    if (!pos || !neg) continue;

    try {
      const ps = getComputedStyle(pos), ns = getComputedStyle(neg);
      const pC = _parseRgb(ps.color), nC = _parseRgb(ns.color);
      if (!pC || !nC) continue;
      const pRatio = _contrast(pC, _effectiveBg(pos));
      const nRatio = _contrast(nC, _effectiveBg(neg));
      const pFs = parseFloat(ps.fontSize) || 0, nFs = parseFloat(ns.fontSize) || 0;
      const posLabel = (pos.innerText || pos.value || '').trim().slice(0, 20);
      const negLabel = (neg.innerText || neg.value || '').trim().slice(0, 20);

      const contrastBad = nRatio < 3.0 && pRatio >= 4.5; // WCAG 최소 가독(3:1) 미달 vs 선명
      const sizeBad = pFs > 0 && nFs > 0 && nFs <= pFs * 0.66;
      if (contrastBad || sizeBad) {
        return {
          id: 'dp-hierarchy', evidenceLevel: 1, method: 'measured',
          fairType: '잘못된 계층구조 (오도형)', law: true,
          evidence: `수락 “${posLabel}” 대비 ${pRatio.toFixed(1)}:1·${pFs.toFixed(0)}px / 거절 “${negLabel}” 대비 ${nRatio.toFixed(1)}:1·${nFs.toFixed(0)}px`,
          message: '거절 선택지가 눈에 잘 안 띄게 만들어져 있어요(대비·크기 측정값 기준). 버튼 모양이 아니라 내용으로 판단하세요.',
        };
      }
    } catch (_) {}
  }
  return null;
};

// 리뷰 텍스트 수집 — 최대 15개, 개당 500자, trim+dedupe, 너무 짧은 것 제외
const collectReviewTexts = () => {
  const out = [];
  const seen = new Set();
  for (const sel of reviewSelectors) {
    let nodes;
    try { nodes = document.querySelectorAll(sel); } catch (_) { continue; }
    for (const node of nodes) {
      let t = (node.textContent || '').replace(/\s+/g, ' ').trim();
      if (!t || t.length < 10) continue;
      if (t.length > 500) t = t.slice(0, 500);
      const key = t.slice(0, 80);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
      if (out.length >= 15) return out;
    }
  }
  return out;
};

// 원화 텍스트 → 숫자. 텍스트의 '첫 번째 가격 토큰'만 사용한다.
// (모든 숫자를 이어붙이면 "11% 1,838,000원" → 111838000 같은 자릿수 오염 발생)
const parseWon = (t) => {
  const s = String(t || '');
  const m = s.match(/[0-9]{1,3}(?:,[0-9]{3})+/) || s.match(/[0-9]{4,9}/) || s.match(/[0-9]{3}/);
  if (!m) return null;
  const n = Number(m[0].replace(/,/g, ''));
  return (!isNaN(n) && n >= 100) ? n : null;
};

// 직전 getBestOriginalPrice 호출이 '표시 할인율 검증'을 통과했는지 여부
// (검증 통과 시 AI 가격 보정 호출을 건너뛰어 비용 절감)
let _origVerified = false;

// 실제 '일반판매가(원가)'를 찾는다. 부풀린 MSRP나 중간 잡음값을 피하기 위해
// 쇼핑몰이 '직접 표시하는' 두 신호로 교차 검증한다:
//   (A) 할인 금액 "N원 할인" → 원가 = 현재가 + 할인액 (정확)
//   (B) 할인율 "NN%" (가격 근처) → 후보 중 이 할인율과 가장 일치하는 값
// 그 다음에야 취소선/셀렉터 후보의 최솟값으로 폴백한다.
const getBestOriginalPrice = (currentNum) => {
  _origVerified = false;
  const cands = new Set();
  // strikeCands: 취소선(del/s/strike)이나 line-through 스타일, 전용 원가 셀렉터로
  // '화면에 명시적으로 할인 전 가격'이라 표시된 값만. 폴백은 이 집합만 신뢰한다(허위 할인 방지).
  const strikeCands = new Set();
  const add = (t) => { const n = parseWon(t); if (n) cands.add(n); };
  const addStrike = (t) => { const n = parseWon(t); if (n) { cands.add(n); strikeCands.add(n); } };
  // 후보 수집: 원가 셀렉터 + del/s/strike + 취소선 스타일(클래스명 무관) → '명시된 원가'로 취급
  // innerText 사용 — 화면에 안 보이는(hidden) 가격 노드는 후보에서 배제
  selectors.originalPrice.forEach(sel => {
    try { document.querySelectorAll(sel).forEach(el => { if (!isInPromoSection(el)) addStrike(el.innerText || ''); }); } catch (_) {}
  });
  try { document.querySelectorAll('del, s, strike').forEach(el => { if (!isInPromoSection(el)) addStrike(el.innerText || ''); }); } catch (_) {}
  try {
    document.querySelectorAll('[class*="price" i], [class*="price" i] *').forEach(el => {
      if (el.children.length > 2) return;
      if (isInPromoSection(el)) return;
      const st = getComputedStyle(el);
      if ((st.textDecorationLine || st.textDecoration || '').includes('line-through')) addStrike(el.innerText || '');
    });
  } catch (_) {}

  const bodyText = document.body?.innerText || '';
  // 가격 블록(판매가·정가·할인율이 함께 있는 영역) — 여기가 가장 신뢰도 높은 소스
  let blockText = '';
  try { blockText = getPriceBlockText() || ''; } catch (_) {}

  // (A) 가격 블록 안의 모든 원화 금액을 원가 후보로 추가 (예: "59,000원 59% 24,040원"의 59,000)
  if (blockText) {
    for (const m of blockText.matchAll(/([0-9]{1,3}(?:,[0-9]{3})+)\s*원/g)) add(m[1]);
  }

  // (B) 페이지의 모든 "N원 할인" 금액 → 원가 후보(현재가+할인액)로 추가.
  if (currentNum) {
    for (const m of bodyText.matchAll(/([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,})\s*원\s*(?:즉시\s*)?(?:쿠폰\s*)?할인/g)) {
      const amt = parseWon(m[1]);
      if (amt && amt > 0 && amt < currentNum * 5) cands.add(currentNum + amt);
    }
  }

  // (C) 표시 할인율 후보 수집 — 블록 안의 '모든' % (위치 포함), 없으면 body의 '% 뒤에 가격' 패턴
  // 적립/캐시/포인트/할부 문맥의 %는 할인율이 아니므로 제외 (예: "카드 최대 4% 캐시적립")
  const NOT_DISCOUNT_CTX = /적립|캐시|포인트|리워드|무이자|할부|이자|페이백/;
  const rateHits = []; // { r: 할인율, idx: blockText 내 위치(-1 = body 폴백) }
  for (const m of blockText.matchAll(/(\d{1,2})\s*%/g)) {
    const r = Number(m[1]);
    if (r < 3 || r >= 100) continue;
    const ctx = blockText.slice(Math.max(0, (m.index ?? 0) - 12), (m.index ?? 0) + 14);
    if (NOT_DISCOUNT_CTX.test(ctx)) continue;
    rateHits.push({ r, idx: m.index ?? 0 });
  }
  if (!rateHits.length) {
    const rmNear = bodyText.match(/(\d{1,2})\s*%[\s\S]{0,30}?[0-9]{1,3}(?:,[0-9]{3})+\s*원/);
    if (rmNear) rateHits.push({ r: Number(rmNear[1]), idx: -1 });
  }

  if (!currentNum) return cands.size ? String(Math.max(...cands)) : null;

  const above = [...cands].filter(n => n > currentNum && n <= currentNum * 8);

  // 1) %와 가격 후보를 대조하되, 수학적 일치(≤3%p)에 더해 '텍스트 인접성'(±60자)까지 요구.
  //    떨어져 있는 "적립 4%"와 무관한 가격이 우연히 맞아떨어지는 오탐을 차단한다.
  //    ⚠ 역산(%만 보고 원가를 지어내기)은 금지 — 17,390,000원 같은 조작값의 근원이었음.
  let best = null;
  for (const { r, idx } of rateHits) {
    const win = idx >= 0 ? blockText.slice(Math.max(0, idx - 40), idx + 40) : '';
    for (const n of above) {
      // 인접성: 해당 % 주변 ±40자 안에 이 가격이 실제로 표기되어 있어야 함 (body 폴백은 예외)
      if (idx >= 0 && !win.includes(n.toLocaleString('ko-KR')) && !win.includes(String(n))) continue;
      const err = Math.abs((1 - currentNum / n) * 100 - r);
      if (err <= 3 && (!best || err < best.err)) best = { n, err };
    }
  }
  if (best) { _origVerified = true; return String(best.n); }

  // 2) %매칭 실패 시: '취소선/할인 스타일로 명시된' 원가(strikeCands)만 폴백 채택한다.
  //    화면에 취소선도 %도 없는 값(상세 스펙 숫자·다른 상품가·MSRP 등)은 원가로 쓰지 않는다 — 허위 할인 방지.
  const strikeAbove = [...strikeCands].filter(n => n > currentNum && n <= currentNum * 8);
  if (strikeAbove.length) {
    const minStrike = Math.min(...strikeAbove);
    if ((1 - currentNum / minStrike) * 100 <= 60) return String(minStrike);
  }
  return null;
};

// AI 가격 보정용 — 가격 요소들의 상위 컨테이너 중 '진짜 가격 블록'을 고른다.
// 점수 기준: 할인율(%)이 있고 원화 금액이 여러 개(판매가+정가) 모여 있는 컨테이너 우선.
const getPriceBlockText = () => {
  const containers = new Set();
  for (const sel of selectors.price) {
    try {
      document.querySelectorAll(sel).forEach((e) => {
        if (!/[0-9]/.test(e.textContent || '')) return;
        if (isInPromoSection(e)) return; // 추천/캐러셀 상품의 가격 블록 배제
        let node = e;
        for (let i = 0; i < 6 && node.parentElement; i++) {
          node = node.parentElement;
          if ((node.innerText || '').length > 150) break;
        }
        containers.add(node);
      });
    } catch (_) {}
  }
  // 셀렉터가 빗나가는 레이아웃(신 쿠팡)에서는 위 루프가 비어 body 앞부분(메뉴 텍스트)으로 떨어진다.
  // 가격 컨테이너 자체를 후보에 넣어 할인율·원가 교차검증과 AI 보정이 진짜 가격 블록을 보게 한다.
  for (const sel of PRICE_CONTAINER_SELECTORS) {
    try {
      document.querySelectorAll(sel).forEach((c) => {
        if (!/[0-9]/.test(c.textContent || '')) return;
        if (isInPromoSection(c) || isInOtherPageLink(c)) return;
        containers.add(c);
      });
    } catch (_) {}
  }
  let best = null, bestScore = -Infinity;
  for (const c of containers) {
    const t = (c.innerText || '').replace(/\s+/g, ' ').trim();
    if (!t) continue;
    const priceCount = (t.match(/[0-9]{1,3}(?:,[0-9]{3})+\s*원/g) || []).length;
    const hasPct = /\d\s*%/.test(t) ? 2 : 0;
    // 가격 2개 이상 + % 존재 = 전형적 가격 블록. 지나치게 긴 컨테이너는 감점.
    const score = Math.min(priceCount, 4) + hasPct - Math.max(0, (t.length - 800) / 1000);
    if (score > bestScore) { bestScore = score; best = t; }
  }
  if (best) return best.slice(0, 1500);
  return (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 1500);
};

// ── 가격 유효성 검증 (sanity check) ─────────────────────────────
// 실측에서 '실제가 대비 최대 10배 높게 추출'되는 오류가 확인됐다. 원인은 대체로
// 자릿수 오염(할인율·다른 숫자가 값에 붙어 들어감)이거나 추천 상품 가격 오추출이다.
// 소스를 순서대로 훑어 '첫 값'만 쓰면 이런 값이 그대로 통과하므로,
// 세 소스를 모두 뽑아 교차 검증한 뒤 채택한다.
//   DOM 표시가 — 옵션 선택을 반영하는 '화면에 보이는' 값. 1순위지만 오염 위험도 가장 크다
//   JSON-LD    — 의미론적으로 정확하나 옵션 미반영(대표가)
//   og:price   — 몰에 따라 MSRP를 담는 경우가 있어 참고용
const PRICE_DISAGREE_RATIO = 4;      // 4배 이상 벌어지면 불일치로 판정 (옵션차는 통과, 자릿수 오염은 차단)
const PRICE_ABSURD_MAX = 500000000;  // 5억 초과는 원화 상품가로 볼 수 없다

const resolvePrice = () => {
  const dom = parseWon(getValidPriceText(selectors.price));
  const ld = parseWon(getJsonLdPrice());
  const og = parseWon(getMetaContent(['og:price:amount', 'product:price:amount', 'price:amount']));
  const sources = { dom, ld, og };
  const ratio = (a, b) => (a && b) ? Math.max(a / b, b / a) : null;

  const first = dom ?? ld ?? og ?? null;
  if (first == null) return { value: null, confidence: 'none', note: '가격 미검출', sources };
  if (first > PRICE_ABSURD_MAX) {
    return { value: null, confidence: 'none', note: `비정상 값(${first}) — 채택하지 않음`, sources };
  }

  const domLd = ratio(dom, ld);
  const domOg = ratio(dom, og);

  if (dom && ld) {
    if (domLd < PRICE_DISAGREE_RATIO) {
      return { value: dom, confidence: 'high', note: 'DOM·JSON-LD 교차검증 통과', sources };
    }
    // 자릿수 오염은 거의 항상 DOM 쪽에서 발생한다 → 구조화 데이터를 채택
    return {
      value: ld, confidence: 'medium',
      note: `DOM(${dom})과 JSON-LD(${ld})가 ${domLd.toFixed(1)}배 불일치 → JSON-LD 채택`,
      sources,
    };
  }
  if (dom && og) {
    // og:price 는 MSRP를 담는 몰이 있어 소스 자체의 신뢰도가 낮다.
    // 값이 근접해도 'high'는 주지 않는다 — high 는 DOM·JSON-LD 합의에만 부여한다.
    if (domOg < PRICE_DISAGREE_RATIO) {
      return { value: dom, confidence: 'medium', note: 'DOM·og:price 교차검증 통과', sources };
    }
    // og:price 는 MSRP인 경우가 잦아 DOM을 버리진 않되, 신뢰도를 낮춰 표시한다
    return {
      value: dom, confidence: 'low',
      note: `DOM(${dom})과 og:price(${og})가 ${domOg.toFixed(1)}배 불일치 → 교차검증 실패`,
      sources,
    };
  }
  if (dom) return { value: dom, confidence: 'low', note: '교차검증 불가(DOM 단일 소스)', sources };
  return { value: first, confidence: 'medium', note: 'DOM 미검출 → 구조화 데이터 사용', sources };
};

// ── 판매 가능 여부 (품절) ──────────────────────────────────────
// "품절 임박" 같은 압박 문구(다크패턴)와 구분해, 실제로 살 수 없는 상태만 잡는다.
const SOLD_OUT_RE = /일시\s*품절|품절(?!\s*임박)|판매\s*(?:종료|중지|중단)|매진|sold\s*out|재고\s*(?:없음|소진)|구매\s*불가/i;
const detectSoldOut = () => {
  try {
    // 1) 몰별 명시 요소 (쿠팡 .prod-not-available 등)
    for (const sel of ['.prod-not-available', '.sold-out', '.soldout', '.oos', '[class*="soldout"]', '[class*="sold-out"]', '[class*="not-available"]']) {
      const e = document.querySelector(sel);
      if (e && SOLD_OUT_RE.test(e.textContent || '') && !isInPromoSection(e)) {
        return { soldOut: true, text: (e.textContent || '').trim().slice(0, 40) };
      }
    }
    // 2) 구매 버튼의 짧은 문구 ("품절", "일시품절", "판매종료")
    const btns = Array.from(document.querySelectorAll('button, a[role="button"], [class*="buy"], [class*="cart"]')).slice(0, 400);
    for (const b of btns) {
      const t = (b.innerText || '').replace(/\s+/g, ' ').trim();
      if (t && t.length <= 12 && SOLD_OUT_RE.test(t) && !isInPromoSection(b)) return { soldOut: true, text: t };
    }
    // 3) 가격 블록 텍스트 (쿠팡은 가격 바로 아래 "일시품절")
    const pb = getPriceBlockText() || '';
    const m = pb.match(/일시\s*품절|판매\s*(?:종료|중지)|매진|sold\s*out|재고\s*없음/i);
    if (m) return { soldOut: true, text: m[0] };
  } catch (_) {}
  return { soldOut: false, text: null };
};

// ── 규격 텍스트 (용량·중량 × 수량) ───────────────────────────────
// "200ml × 24개", "1L x 3개", "500g 2팩" 같은 문자열. 비교 대상이 같은 규격인지 판별하는 데 쓴다.
const SPEC_RE = /(\d+(?:\.\d+)?)\s*(ml|mL|ML|㎖|ℓ|L|리터|g|kg|KG|Kg|㎏)(?![a-zA-Z가-힣])\s*(?:[x×X*]\s*\d{1,4}\s*(?:개입|개|팩|입|병|캔|봉|포|매|정)?|\d{1,4}\s*(?:개입|개|팩|입|병|캔|봉|포|매|정))?/;
const getSpecText = () => {
  try {
    const title = getMetaContent(['og:title', 'twitter:title']) || queryFirst(selectors.title) || document.title || '';
    const cands = [title, getPriceBlockText() || '', queryText(selectors.option) || ''];
    // "개당 용량 × 총 수량" 같은 행은 본문에서 가장 정확하므로 먼저 찾는다
    const body = (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 30000);
    const row = body.match(/(?:개당\s*)?(?:용량|중량|규격|구성)[^0-9]{0,20}(\d+(?:\.\d+)?\s*(?:ml|mL|㎖|L|리터|g|kg|㎏)\s*[x×X*]\s*\d{1,4}\s*개?)/);
    if (row) return row[1].replace(/\s+/g, '');
    for (const c of cands) { const m = String(c || '').match(SPEC_RE); if (m) return m[0].replace(/\s+/g, ''); }
  } catch (_) {}
  return null;
};

const collectShoppingData = () => {
  // 세 소스를 교차 검증해 채택한다 (resolvePrice 주석 참고).
  // 화면 표시가를 1순위로 두되, 다른 소스와 크게 어긋나면 기각·대체한다.
  const priceInfo = resolvePrice();
  const rawPrice = priceInfo.value != null ? String(priceInfo.value) : null;

  // 취소선 원가 — 부풀린 정가(MSRP) 대신 현재가 바로 위의 실제 '일반판매가' 선택
  const rawOriginalPrice = getBestOriginalPrice(parseWon(rawPrice));

  const seller = collectSellerSignals();
  const collected = {
    rawUrl: window.location.href,
    // og:title 우선 — DOM 제목 셀렉터는 '판매자 정보' 같은 섹션 헤딩을 오탐하는 사례가 있음(11번가)
    rawTitle: getMetaContent(['og:title', 'twitter:title']) || queryFirst(selectors.title) || document.title,
    rawPrice,
    rawOriginalPrice,
    rawText: queryText([...selectors.title, ...selectors.price, ...selectors.shipping, ...selectors.option, ...selectors.seller, ...selectors.productArea]) || document.body.innerText || '',
    imageUrl: getFirstImageUrl(),
    sellerName: seller.sellerName,
    sellerRating: seller.sellerRating,
    reviewCount: seller.reviewCount,
    lowReviewWarning: seller.lowReviewWarning,
    sellerBlockText: seller.sellerBlockText,
    reviewTexts: collectReviewTexts(),
    priceBlockText: getPriceBlockText(),
    priceVerified: _origVerified,
    priceSanity: priceInfo,
    darkPatterns: detectDarkPatterns(),
    // 판매 가능 여부·규격 — 품절 상품을 추천/최저가로 다루지 않기 위해
    ...(() => { const so = detectSoldOut(); return { soldOut: so.soldOut, soldOutText: so.text }; })(),
    specText: getSpecText(),
  };
  // 진단용 — F12 콘솔에서 실제 추출값 확인 가능 (판매가/원가/할인율 검증 여부)
  console.log('[ShoMate] 가격추출 → 판매가:', collected.rawPrice, '| 원가:', collected.rawOriginalPrice,
    '| %검증:', collected.priceVerified,
    '| 교차검증:', priceInfo.confidence, '-', priceInfo.note,
    '| 소스:', priceInfo.sources,
    '| 후보:', _priceCandidates,
    '| 블록:', (collected.priceBlockText || '').replace(/\s+/g, ' ').slice(0, 200));
  return collected;
};

// ── 원형 플로팅 버튼 (드래그 가능, 사이드패널 토글) ────────────

let _fabEl = null;

function showFloatingButton() {
  if (_fabEl) return;

  // 저장된 위치 복원
  let savedPos = null;
  try { savedPos = JSON.parse(localStorage.getItem('shomate_fab_pos') || 'null'); } catch(e) {}

  _fabEl = document.createElement('div');
  _fabEl.id = 'shomate-fab';

  const SIZE = 50;
  const defaultRight = 16, defaultBottom = 160;

  if (savedPos && savedPos.left != null && savedPos.top != null) {
    _fabEl.style.cssText = `position:fixed;left:${savedPos.left}px;top:${savedPos.top}px;width:${SIZE}px;height:${SIZE}px;border-radius:50%;background:linear-gradient(135deg,#6366f1,#4338ca);box-shadow:0 4px 20px rgba(79,70,229,0.55);cursor:pointer;user-select:none;z-index:2147483646;display:flex;align-items:center;justify-content:center;transition:box-shadow 0.2s;`;
  } else {
    _fabEl.style.cssText = `position:fixed;right:${defaultRight}px;bottom:${defaultBottom}px;width:${SIZE}px;height:${SIZE}px;border-radius:50%;background:linear-gradient(135deg,#6366f1,#4338ca);box-shadow:0 4px 20px rgba(79,70,229,0.55);cursor:pointer;user-select:none;z-index:2147483646;display:flex;align-items:center;justify-content:center;transition:box-shadow 0.2s;`;
  }

  _fabEl.innerHTML = `<svg width="24" height="24" viewBox="0 0 26 26" fill="none">
    <path d="M13 2L4 6v6c0 5.25 3.8 10.15 9 11.33C18.2 22.15 22 17.25 22 12V6L13 2Z"
      fill="rgba(255,255,255,0.28)" stroke="white" stroke-width="1.5" stroke-linejoin="round"/>
    <text x="13" y="17.5" text-anchor="middle"
      font-family="-apple-system,sans-serif" font-weight="900" font-size="11" fill="white">S</text>
  </svg>`;

  // 툴팁
  const tip = document.createElement('div');
  tip.style.cssText = 'position:absolute;right:calc(100% + 10px);top:50%;transform:translateY(-50%);background:rgba(17,24,39,0.88);color:#fff;font:600 12px/1 -apple-system,"Malgun Gothic",sans-serif;padding:6px 12px;border-radius:8px;white-space:nowrap;opacity:0;transition:opacity 0.18s;pointer-events:none;';
  tip.textContent = 'ShoMate';
  _fabEl.appendChild(tip);

  // ── 드래그 ─────────────────────────────────────────────────
  let dragging = false, moved = false;
  let ox = 0, oy = 0, startL = 0, startT = 0;

  _fabEl.addEventListener('mousedown', (e) => {
    dragging = true; moved = false;
    _fabEl.style.transition = 'none';
    const r = _fabEl.getBoundingClientRect();
    // right/bottom → left/top 좌표계로 전환
    startL = r.left; startT = r.top;
    _fabEl.style.left = startL + 'px';
    _fabEl.style.top  = startT + 'px';
    _fabEl.style.right  = 'auto';
    _fabEl.style.bottom = 'auto';
    ox = e.clientX; oy = e.clientY;
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - ox, dy = e.clientY - oy;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
    if (!moved) return;
    const x = Math.max(0, Math.min(startL + dx, window.innerWidth  - SIZE));
    const y = Math.max(0, Math.min(startT + dy, window.innerHeight - SIZE));
    _fabEl.style.left = x + 'px';
    _fabEl.style.top  = y + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    _fabEl.style.transition = 'box-shadow 0.2s';
    if (moved) {
      try { localStorage.setItem('shomate_fab_pos', JSON.stringify({ left: parseInt(_fabEl.style.left), top: parseInt(_fabEl.style.top) })); } catch(e) {}
    }
  });

  // ── 호버 ────────────────────────────────────────────────────
  _fabEl.addEventListener('mouseenter', () => {
    if (!dragging) { _fabEl.style.boxShadow = '0 8px 28px rgba(79,70,229,0.7)'; tip.style.opacity = '1'; }
  });
  _fabEl.addEventListener('mouseleave', () => {
    _fabEl.style.boxShadow = '0 4px 20px rgba(79,70,229,0.55)';
    tip.style.opacity = '0';
  });

  // ── 클릭 → 오버레이 토글 ────────────────────────────────────
  _fabEl.addEventListener('click', () => {
    if (moved) return;
    if (overlayContainer) removeOverlay();
    else createOverlay();
  });

  document.documentElement.appendChild(_fabEl);
}

function hideFloatingButton() {
  if (_fabEl) { _fabEl.remove(); _fabEl = null; }
}

// 쇼핑 사이트에서 자동으로 버튼 표시
const SHOPPING_HOSTS = ['coupang.com', '11st.co.kr', 'shopping.naver.com',
  'gmarket.co.kr', 'auction.co.kr', 'interpark.com', 'lotteon.com', 'ssg.com', 'tmon.co.kr'];
if (SHOPPING_HOSTS.some(h => location.hostname.includes(h))) {
  showFloatingButton();
}

// ── (제거됨) 표시가격 변화 감지 → 재분석 ─────────────────────────
// 예전에는 body 전체를 MutationObserver 로 보다가 "첫 번째로 잡히는 가격 텍스트"가
// 바뀌면 shomatePriceChanged 를 보내 사이드바를 재분석시켰다. 그런데 쿠팡은 스크롤만
// 해도 추천상품·다른 판매자·상단 고정바가 지연 로딩되면서 다른 가격 요소가 먼저 잡혀
// "가격이 바뀌었다"고 오판 → 스크롤마다 재분석 + 엉뚱한 가격(16,500 vs 18,500) 표시.
// 지금은 분석 트리거가 URL 하나뿐이다 (사이드바가 탭 URL 변화를 감지).
// 쿠팡은 옵션을 바꾸면 URL 의 itemId/vendorItemId 가 바뀌므로 그 경로로 잡힌다.
// 되돌리려면 content-script.js.bak-trigger 의 setupPriceChangeWatcher 참고.

// ── 다크패턴 실시간 감시 + 페이지 내 경고 레이어 ────────────────
// 기존에는 사이드바가 데이터를 요청할 때 딱 1회만 검사했다. 카운트다운·팝업·
// 미리 체크된 항목은 대부분 그 뒤에 나타나므로 '실시간'이라 부를 수 없었다.
// DOM 변화를 관찰하다가 새로 나타난 패턴이 있으면 페이지 위에 바로 경고를 띄운다.
const DP_WATCH = { seen: new Set(), el: null, mutedUntilReload: false };

function dismissDarkPatternAlert() {
  if (DP_WATCH.el) { DP_WATCH.el.remove(); DP_WATCH.el = null; }
}

function renderDarkPatternAlert(items) {
  dismissDarkPatternAlert();
  if (!items.length) return;

  const box = document.createElement('div');
  box.id = 'shomate-dp-alert';
  box.style.cssText = [
    'position:fixed', 'left:16px', 'bottom:16px',
    'width:320px', 'max-width:calc(100vw - 32px)',
    'z-index:2147483645',
    'background:#fffbeb', 'border:1px solid #fcd34d', 'border-radius:14px',
    'box-shadow:0 10px 30px rgba(0,0,0,0.18)',
    'padding:12px 14px',
    'font:400 12px/1.5 -apple-system,"Malgun Gothic",sans-serif',
    'color:#78350f',
  ].join(';');

  const head = document.createElement('div');
  head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px';

  // 정직한 제목 — 규칙 탐지는 '신호'일 뿐이고, 관측으로 확인된 것만 '확인'이라 말한다
  const confirmedCount = items.filter(i => i.evidenceLevel === 2).length;
  const title = document.createElement('strong');
  title.textContent = confirmedCount > 0
    ? `⚠ 다크패턴 신호 ${items.length}건 · 관측 확인 ${confirmedCount}건`
    : `⚠ 다크패턴 신호 ${items.length}건`;
  title.style.cssText = 'font:800 12px/1.2 -apple-system,"Malgun Gothic",sans-serif;color:#b45309';

  const close = document.createElement('button');
  close.textContent = '✕';
  close.title = '이 페이지에서 숨기기';
  close.style.cssText = 'background:none;border:none;cursor:pointer;color:#b45309;font-size:13px;line-height:1;padding:2px 4px';
  close.addEventListener('click', () => { DP_WATCH.mutedUntilReload = true; dismissDarkPatternAlert(); });

  head.appendChild(title);
  head.appendChild(close);
  box.appendChild(head);

  // 관측 확인(evidenceLevel 2)을 앞으로 — 근거가 강한 것부터 보여준다
  const ordered = [...items].sort((a, b) => (b.evidenceLevel || 1) - (a.evidenceLevel || 1));

  const ul = document.createElement('ul');
  ul.style.cssText = 'margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:8px';
  for (const it of ordered.slice(0, 3)) {
    const li = document.createElement('li');
    li.style.cssText = 'display:flex;flex-direction:column;gap:2px';

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px;align-items:flex-start';

    // 판정 성격 배지 — 관측 확인 / 측정 / 표시 감지
    const badge = document.createElement('span');
    if (it.evidenceLevel === 2) {
      badge.textContent = '관측 확인';
      badge.style.cssText = 'flex-shrink:0;background:#dc2626;color:#fff;border-radius:5px;padding:1px 5px;font:800 10px/1.4 -apple-system,"Malgun Gothic",sans-serif';
    } else if (it.method === 'measured') {
      badge.textContent = '측정';
      badge.style.cssText = 'flex-shrink:0;background:#7c3aed;color:#fff;border-radius:5px;padding:1px 5px;font:800 10px/1.4 -apple-system,"Malgun Gothic",sans-serif';
    } else {
      badge.textContent = '표시 감지';
      badge.style.cssText = 'flex-shrink:0;background:#f59e0b;color:#fff;border-radius:5px;padding:1px 5px;font:800 10px/1.4 -apple-system,"Malgun Gothic",sans-serif';
    }

    const msg = document.createElement('span');
    // 경고 문구에 페이지에서 읽은 라벨 텍스트가 섞이므로 반드시 textContent 로만 넣는다.
    // innerHTML 을 쓰면 쇼핑몰 페이지의 내용이 우리 UI에 마크업으로 주입될 수 있다.
    msg.textContent = it.message;
    row.appendChild(badge);
    row.appendChild(msg);
    li.appendChild(row);

    // 근거 줄 — 페이지에서 실제 관측된 문구/측정값 + 공정위 유형. 지어낸 문장이 아님을 그대로 보여준다.
    if (it.evidence || it.fairType) {
      const ev = document.createElement('div');
      const parts = [];
      if (it.evidence) parts.push(`근거: ${it.evidence}`);
      if (it.fairType) parts.push(`공정위 유형: ${it.fairType}${it.law ? ' · 전자상거래법 금지' : ''}`);
      ev.textContent = parts.join('  ·  ');
      ev.style.cssText = 'margin-left:2px;padding-left:8px;border-left:2px solid #fcd34d;font-size:10.5px;line-height:1.45;color:#a16207;word-break:break-all';
      li.appendChild(ev);
    }
    ul.appendChild(li);
  }
  box.appendChild(ul);

  if (items.length > 3) {
    const more = document.createElement('div');
    more.textContent = `외 ${items.length - 3}건`;
    more.style.cssText = 'margin-top:6px;font-size:11px;color:#a16207';
    box.appendChild(more);
  }

  const detail = document.createElement('button');
  detail.textContent = 'ShoMate에서 자세히 보기';
  detail.style.cssText = [
    'margin-top:10px', 'width:100%', 'cursor:pointer',
    'background:#f59e0b', 'border:none', 'border-radius:9px',
    'padding:7px 0', 'color:#fff',
    'font:800 11px/1 -apple-system,"Malgun Gothic",sans-serif',
  ].join(';');
  // 사이드패널 열기는 사용자 제스처를 요구하고 실패할 수 있어, FAB과 동일하게 오버레이를 쓴다
  detail.addEventListener('click', () => { if (!overlayContainer) createOverlay(); });
  box.appendChild(detail);

  // 정직성 고지 — 우리는 단정하지 않고 관측을 보고한다
  const honesty = document.createElement('div');
  honesty.textContent = '관측된 표시·측정값을 근거와 함께 보여드려요. 구매 판단은 소비자의 몫입니다.';
  honesty.style.cssText = 'margin-top:7px;font-size:10px;color:#b7791f;text-align:center';
  box.appendChild(honesty);

  document.documentElement.appendChild(box);
  DP_WATCH.el = box;
}

function runDarkPatternScan() {
  if (DP_WATCH.mutedUntilReload) return;
  let found;
  try { found = detectDarkPatterns(); } catch (_) { return; }
  // 시간 압박 표시가 보이면 그때부터 카운트다운 관측을 시작한다 (표시 감지 → 기만 확인 승격 경로)
  if (found.some(f => f.id === 'dp-urgency')) startCountdownWatcher();
  const fresh = found.filter(f => !DP_WATCH.seen.has(f.id));
  if (!fresh.length) return;               // 새로 나타난 게 없으면 다시 그리지 않는다
  fresh.forEach(f => DP_WATCH.seen.add(f.id));
  renderDarkPatternAlert(found);           // 누적 전체를 보여준다
}

function setupDarkPatternWatcher() {
  runDarkPatternScan();
  let timer = null;
  const obs = new MutationObserver(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(runDarkPatternScan, 900);   // 디바운스 — 렌더 폭주 시 과호출 방지
  });
  try { obs.observe(document.body, { subtree: true, childList: true, characterData: true }); } catch (_) {}
}
if (SHOPPING_HOSTS.some(h => location.hostname.includes(h))) {
  setupDarkPatternWatcher();
}

// ── 주문완료 자동 감지 → 최근 구매 내역 ─────────────────────────
// 결제/주문 컨텍스트가 붙은 완료 경로만 — 단독 complete/done은 오탐이 많아 제외
const ORDER_DONE_URL_RE = /(orderdone|order_done|ordercomplete|order\/complete|order\/?done|order\/?success|ordersuccess|checkoutcomplete|checkout\/complete|paymentcomplete|payment\/complete|pay\/complete|paycomplete|order\/receipt)/i;
const PLATFORM_DONE_RE = {
  '쿠팡': /coupang\.com\/.*\/(order|orders).*(done|complete)/i,
  '11번가': /11st\.co\.kr\/.*(order).*(complete)/i,
  '네이버쇼핑': /(naver|pay\.naver)\.com\/.*(order|pay).*(complete|done|receipt)/i,
};
// 확정 어구만 — '주문완료' 같은 상태 배지(주문내역 페이지)는 오탐이라 '완료되었/됐' 동사형 요구
const ORDER_DONE_TEXT_RE = /(주문이?\s*(정상적으로\s*)?완료\s*(되었|됐|되었습니다)|결제(가|를)?\s*(정상적으로\s*)?완료\s*(되었|됐|되었습니다)|주문해\s*주셔서|구매해\s*주셔서|주문이?\s*접수되었)/;

const detectPlatformCS = (url) => {
  if (url.includes('11st.')) return '11번가';
  if (url.includes('coupang.com')) return '쿠팡';
  if (url.includes('naver.')) return '네이버쇼핑';
  if (url.includes('gmarket.co.kr')) return 'G마켓';
  if (url.includes('auction.co.kr')) return '옥션';
  if (url.includes('interpark.com')) return '인터파크';
  if (url.includes('lotteon.com')) return '롯데온';
  if (url.includes('ssg.com')) return 'SSG';
  if (url.includes('tmon.co.kr')) return '티몬';
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return '알 수 없음'; }
};

const extractOrderTotal = () => {
  const labelSels = [
    '.total-price strong', '.total_price strong', '.payment-price', '.pay-price',
    '.order-total', '.total_amount', '.final_payment', '[class*="totalPay"]',
    '[class*="finalPrice"]', '[class*="payAmount"]',
  ];
  for (const sel of labelSels) {
    try {
      const el = document.querySelector(sel);
      const n = Number((el?.textContent || '').replace(/[^0-9]/g, ''));
      if (n >= 100) return n;
    } catch (_) {}
  }
  const body = document.body?.innerText || '';
  const m = body.match(/(총\s*결제\s*금액|최종\s*결제\s*금액|실\s*결제\s*금액|총\s*결제액|카드\s*결제\s*금액|결제\s*금액|총\s*주문\s*금액)[^0-9]{0,12}([0-9]{1,3}(?:,[0-9]{3})+)\s*원/);
  if (m) return Number(m[2].replace(/,/g, ''));
  // 라벨 없는 페이지 전역 최댓값 폴백은 MSRP/소계/적립금 등을 잘못 잡아 제거 — 못 찾으면 0(미상)
  return 0;
};

const extractOrderName = () => {
  const itemSels = [
    '.order-item__name', '.prod-name', '.product-name', '.item-name',
    '.order_prd_name', '.goods_name', '.prdName', '[class*="productName"]',
    '[class*="itemName"]', '.cart-item__name',
  ];
  const names = [];
  for (const sel of itemSels) {
    document.querySelectorAll(sel).forEach(el => {
      const t = (el.textContent || '').trim();
      if (t && t.length >= 2) names.push(t);
    });
    if (names.length) break;
  }
  if (names.length) {
    const first = names[0].replace(/\s+/g, ' ').slice(0, 80);
    return names.length > 1 ? `${first} 외 ${names.length - 1}건` : first;
  }
  const og = getMetaContent(['og:title', 'twitter:title']);
  return (og || document.title || '주문 상품').replace(/\s+/g, ' ').trim().slice(0, 80);
};

const detectAndReportOrderComplete = () => {
  const url = location.href;
  const urlHit = ORDER_DONE_URL_RE.test(url) || Object.values(PLATFORM_DONE_RE).some(re => re.test(url));
  if (!urlHit) return;
  const bodyText = document.body?.innerText || '';
  if (!ORDER_DONE_TEXT_RE.test(bodyText)) return; // DOM 단서 필수 (오탐 방지)

  const marker = 'shomate_order_reported';
  try { if (sessionStorage.getItem(marker) === url) return; } catch (_) {}

  const price = extractOrderTotal();
  const name = extractOrderName();
  const platform = detectPlatformCS(url);
  const capturedAt = Date.now();

  try {
    chrome.runtime.sendMessage(
      { type: 'orderCompleted', payload: { name, price, platform, date: '오늘', url, capturedAt } },
      () => void chrome.runtime.lastError
    );
    try { sessionStorage.setItem(marker, url); } catch (_) {}
  } catch (_) {}
};

detectAndReportOrderComplete();
setTimeout(detectAndReportOrderComplete, 1500);

// ── 설정 캐시 ───────────────────────────────────────────────────
// 예전에는 keydown·click 핸들러 안에서 매번 chrome.storage 를 조회했다.
// 이 content script 는 <all_urls> 에서 돌기 때문에, 사용자가 어느 사이트에서
// 무엇을 입력하든 글자마다 비동기 IPC 가 발생하는 구조였다.
// 한 번만 읽어 캐시하고, 변경은 storage.onChanged 로 받는다.
const _settings = { shortcut: null, isShortcutEnabled: false, backdropClose: false };

try {
  chrome.storage.local.get(['shortcut', 'isShortcutEnabled', 'backdropClose'], (v) => {
    if (chrome.runtime.lastError || !v) return;
    _settings.shortcut = v.shortcut ?? null;
    _settings.isShortcutEnabled = !!v.isShortcutEnabled;
    _settings.backdropClose = !!v.backdropClose;
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.shortcut) _settings.shortcut = changes.shortcut.newValue ?? null;
    if (changes.isShortcutEnabled) _settings.isShortcutEnabled = !!changes.isShortcutEnabled.newValue;
    if (changes.backdropClose) _settings.backdropClose = !!changes.backdropClose.newValue;
  });
} catch (_) {}

// 키보드 단축키 리스너 — 캐시된 설정으로 오버레이 토글
document.addEventListener('keydown', (e) => {
  const shortcut = _settings.shortcut;
  if (!_settings.isShortcutEnabled || !shortcut?.code) return;
  if (
    !!shortcut.ctrl === e.ctrlKey &&
    !!shortcut.shift === e.shiftKey &&
    !!shortcut.alt === e.altKey &&
    shortcut.code === e.code
  ) {
    e.preventDefault();
    if (overlayContainer) removeOverlay();
    else createOverlay();
  }
});

// 백드롭 닫기 — 오버레이 영역 밖 클릭 시 닫기
document.addEventListener('click', (e) => {
  if (!overlayContainer) return;
  if (overlayContainer.contains(e.target)) return;
  if (_settings.backdropClose) removeOverlay();
}, true);

// ── 오버레이 모드 ──────────────────────────────────────────────

let overlayContainer = null;

function createOverlay() {
  if (overlayContainer) return;

  overlayContainer = document.createElement('div');
  overlayContainer.id = 'shomate-overlay-root';
  overlayContainer.style.cssText = [
    'position:fixed', 'top:0', 'right:0',
    'width:420px', 'max-width:50vw', 'height:100vh',
    'z-index:2147483647',
    'border-radius:20px 0 0 20px',
    'box-shadow:-8px 0 40px rgba(0,0,0,0.18),0 0 0 1px rgba(0,0,0,0.06)',
    'overflow:hidden', 'background:#fff',
    'display:flex', 'flex-direction:column',
  ].join(';');

  // 스냅 핸들 (좌/우 버튼)
  const handle = document.createElement('div');
  handle.style.cssText = [
    'height:38px', 'background:linear-gradient(to right,#f8f9fa,#ffffff)',
    'border-bottom:1px solid #e9ecef',
    'display:flex', 'align-items:center', 'justify-content:space-between',
    'padding:0 8px', 'flex-shrink:0', 'gap:6px',
    'cursor:grab', 'user-select:none', '-webkit-user-select:none',
  ].join(';');
  handle.title = '드래그해서 좌우로 옮기기';

  const snapBtnStyle = [
    'background:#f1f3f5', 'border:1px solid #dee2e6', 'cursor:pointer',
    'padding:4px 10px', 'border-radius:6px', 'font-size:11px',
    'color:#495057', 'font-weight:700',
    'font-family:-apple-system,"Malgun Gothic",sans-serif',
    'line-height:1', 'white-space:nowrap', 'transition:all 0.15s',
  ].join(';');

  const snapLeft = document.createElement('button');
  snapLeft.style.cssText = snapBtnStyle;
  snapLeft.textContent = '◀ 좌';
  snapLeft.title = '화면 왼쪽에 붙이기';
  snapLeft.onmouseenter = () => snapLeft.style.background = '#dee2e6';
  snapLeft.onmouseleave = () => snapLeft.style.background = '#f1f3f5';
  snapLeft.onclick = () => {
    overlayContainer.style.left = '0';
    overlayContainer.style.right = 'auto';
    overlayContainer.style.borderRadius = '0 20px 20px 0';
    overlayContainer.style.boxShadow = '8px 0 40px rgba(0,0,0,0.18),0 0 0 1px rgba(0,0,0,0.06)';
  };

  const logoEl = document.createElement('span');
  logoEl.textContent = 'ShoMate';
  logoEl.style.cssText = [
    'flex:1', 'text-align:center',
    'font:700 12px -apple-system,"Malgun Gothic",sans-serif',
    'color:#6366f1', 'pointer-events:none', 'user-select:none', '-webkit-user-select:none',
  ].join(';');

  const snapRight = document.createElement('button');
  snapRight.style.cssText = snapBtnStyle;
  snapRight.textContent = '우 ▶';
  snapRight.title = '화면 오른쪽에 붙이기';
  snapRight.onmouseenter = () => snapRight.style.background = '#dee2e6';
  snapRight.onmouseleave = () => snapRight.style.background = '#f1f3f5';
  snapRight.onclick = () => {
    overlayContainer.style.right = '0';
    overlayContainer.style.left = 'auto';
    overlayContainer.style.borderRadius = '20px 0 0 20px';
    overlayContainer.style.boxShadow = '-8px 0 40px rgba(0,0,0,0.18),0 0 0 1px rgba(0,0,0,0.06)';
  };

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.style.cssText = [
    'background:none', 'border:none', 'cursor:pointer', 'font-size:14px',
    'color:#868e96', 'padding:4px 6px', 'border-radius:6px', 'line-height:1',
    'font-family:sans-serif', 'transition:all 0.15s',
  ].join(';');
  closeBtn.onmouseenter = () => { closeBtn.style.background = '#e9ecef'; closeBtn.style.color = '#212529'; };
  closeBtn.onmouseleave = () => { closeBtn.style.background = 'none'; closeBtn.style.color = '#868e96'; };
  closeBtn.onclick = () => removeOverlay();

  handle.appendChild(snapLeft);
  handle.appendChild(logoEl);
  handle.appendChild(snapRight);
  handle.appendChild(closeBtn);
  overlayContainer.appendChild(handle);

  const iframe = document.createElement('iframe');
  iframe.src = chrome.runtime.getURL('sidebar/index.html');
  iframe.style.cssText = 'width:100%;flex:1;border:none;background:white;display:block;min-height:0;';
  iframe.allow = 'clipboard-write';
  overlayContainer.appendChild(iframe);

  // ── 핸들 드래그: 패널을 좌우로 옮긴다 ─────────────────────────
  // 예전에는 핸들을 잡고 끌면 아무 일도 안 일어나고 뒤의 쇼핑몰 페이지 텍스트가
  // 드래그 선택됐다(브라우저 기본 동작). mousedown 에서 preventDefault 하고,
  // 드래그 중에는 iframe 이 마우스 이벤트를 삼키지 않게 pointer-events 를 끈다.
  const SNAP_PX = 48;
  let hDrag = false, hMoved = false, hStartX = 0, hStartLeft = 0;
  const dockRight = () => {
    overlayContainer.style.right = '0';
    overlayContainer.style.left = 'auto';
    overlayContainer.style.borderRadius = '20px 0 0 20px';
    overlayContainer.style.boxShadow = '-8px 0 40px rgba(0,0,0,0.18),0 0 0 1px rgba(0,0,0,0.06)';
  };
  const dockLeft = () => {
    overlayContainer.style.left = '0';
    overlayContainer.style.right = 'auto';
    overlayContainer.style.borderRadius = '0 20px 20px 0';
    overlayContainer.style.boxShadow = '8px 0 40px rgba(0,0,0,0.18),0 0 0 1px rgba(0,0,0,0.06)';
  };
  const floatAt = (left) => {
    overlayContainer.style.left = left + 'px';
    overlayContainer.style.right = 'auto';
    overlayContainer.style.borderRadius = '20px';
    overlayContainer.style.boxShadow = '0 8px 40px rgba(0,0,0,0.22),0 0 0 1px rgba(0,0,0,0.06)';
  };
  handle.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('button')) return;           // 스냅/닫기 버튼은 그대로
    e.preventDefault();                                // 페이지 텍스트 선택 시작 차단
    hDrag = true; hMoved = false;
    hStartX = e.clientX;
    hStartLeft = overlayContainer.getBoundingClientRect().left;
    handle.style.cursor = 'grabbing';
    iframe.style.pointerEvents = 'none';               // iframe 위로 지나가도 mousemove 유지
    overlayContainer.style.transition = 'none';
  });
  const onHandleMove = (e) => {
    if (!hDrag) return;
    const dx = e.clientX - hStartX;
    if (!hMoved && Math.abs(dx) < 4) return;
    hMoved = true;
    e.preventDefault();
    const w = overlayContainer.offsetWidth;
    const left = Math.max(0, Math.min(hStartLeft + dx, window.innerWidth - w));
    floatAt(left);
  };
  const onHandleUp = () => {
    if (!hDrag) return;
    hDrag = false;
    handle.style.cursor = 'grab';
    iframe.style.pointerEvents = '';
    if (!hMoved) return;
    const r = overlayContainer.getBoundingClientRect();
    if (r.left <= SNAP_PX) dockLeft();
    else if (window.innerWidth - r.right <= SNAP_PX) dockRight();
    try { window.getSelection && window.getSelection().removeAllRanges(); } catch (_) {}
  };
  document.addEventListener('mousemove', onHandleMove, true);
  document.addEventListener('mouseup', onHandleUp, true);
  window.addEventListener('blur', onHandleUp);
  overlayContainer._cleanupDrag = () => {
    document.removeEventListener('mousemove', onHandleMove, true);
    document.removeEventListener('mouseup', onHandleUp, true);
    window.removeEventListener('blur', onHandleUp);
  };
  snapLeft.onclick = dockLeft;
  snapRight.onclick = dockRight;

  document.documentElement.appendChild(overlayContainer);
}

function removeOverlay() {
  if (overlayContainer) {
    try { overlayContainer._cleanupDrag && overlayContainer._cleanupDrag(); } catch (_) {}
    overlayContainer.remove();
    overlayContainer = null;
  }
}

// ── iframe postMessage 수신 (보기 버튼 탭 열기 / 드래그 새는 것 방지) ──
// 사이드바(iframe) 안에서 마우스를 누른 채 패널 밖으로 나가면 브라우저가 호스트
// 페이지(쿠팡 등) 텍스트를 이어서 선택한다. 사이드바가 mousedown/mouseup 을 알려주면
// 그동안만 호스트 페이지를 선택 불가로 만든다.
let _hostNoSelectPrev = null;
function setHostNoSelect(on) {
  const st = document.documentElement.style;
  if (on) {
    if (_hostNoSelectPrev === null) _hostNoSelectPrev = [st.getPropertyValue('user-select'), st.getPropertyValue('-webkit-user-select')];
    st.setProperty('user-select', 'none', 'important');
    st.setProperty('-webkit-user-select', 'none', 'important');
  } else if (_hostNoSelectPrev !== null) {
    st.setProperty('user-select', _hostNoSelectPrev[0]);
    st.setProperty('-webkit-user-select', _hostNoSelectPrev[1]);
    _hostNoSelectPrev = null;
    try { const s = window.getSelection(); if (s && !s.isCollapsed) s.removeAllRanges(); } catch (_) {}
  }
}
window.addEventListener('message', (e) => {
  if (!e.origin.startsWith('chrome-extension://')) return;
  const t = e.data?.type;
  if (t === 'openTab' && e.data?.url) {
    window.open(e.data.url, '_blank');
  } else if (t === 'shomate-drag-start') {
    setHostNoSelect(true);
  } else if (t === 'shomate-drag-end') {
    setHostNoSelect(false);
  }
});
document.addEventListener('mouseup', () => { if (_hostNoSelectPrev !== null) setHostNoSelect(false); }, true);
window.addEventListener('blur', () => { if (_hostNoSelectPrev !== null) setHostNoSelect(false); });

// ── 메시지 리스너 ──────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.type === 'collectShoppingData') {
    sendResponse({ ok: true, data: collectShoppingData() });
    return true;
  }
  if (message && message.type === 'toggleOverlay') {
    if (overlayContainer) removeOverlay();
    else createOverlay();
    sendResponse({ ok: true, visible: !!overlayContainer });
    return true;
  }
  if (message && message.type === 'showFloatingButton') {
    showFloatingButton();
    sendResponse({ ok: true });
    return true;
  }
  if (message && message.type === 'hideFloatingButton') {
    hideFloatingButton();
    sendResponse({ ok: true });
    return true;
  }
});
