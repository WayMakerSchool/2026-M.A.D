const _openTabs = new Set();
chrome.tabs.onRemoved.addListener(id => _openTabs.delete(id));

// ── 가격 알림 알람 등록 (MV3 SW는 휘발성 → 알람은 영속) ──────────
const PRICE_ALARM = 'shomate-price-check';
const PRICE_CHECK_PERIOD_MIN = 60;                 // 60분 주기
const NOTIFY_THROTTLE_MS = 12 * 60 * 60 * 1000;    // 12시간

function ensurePriceAlarm() {
  chrome.alarms.get(PRICE_ALARM, (a) => {
    if (!a) chrome.alarms.create(PRICE_ALARM, { periodInMinutes: PRICE_CHECK_PERIOD_MIN, delayInMinutes: 1 });
  });
}
chrome.runtime.onInstalled.addListener(ensurePriceAlarm);
chrome.runtime.onStartup.addListener(ensurePriceAlarm);
ensurePriceAlarm(); // SW 콜드스타트 시에도 보장

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PRICE_ALARM) { runPriceWatchCheck(); runWishlistPriceRefresh(); }
  if (alarm.name === ITEM_PAID_ALARM) { checkPendingItemCheckout().catch(() => {}); }
});

// 알림 id→url 매핑은 chrome.storage.local에 저장 (MV3 SW는 휘발성이라 메모리 Map은 클릭 시점에 비어 있음)
chrome.notifications.onClicked.addListener((id) => {
  chrome.storage.local.get({ notifUrlMap: {} }, ({ notifUrlMap }) => {
    const url = notifUrlMap[id];
    if (url) chrome.tabs.create({ url });
    if (url) { delete notifUrlMap[id]; chrome.storage.local.set({ notifUrlMap }); }
    chrome.notifications.clear(id);
  });
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;

  // 저장된 표시 모드에 따라 분기 — 'overlay'면 페이지 내 오버레이, 그 외엔 사이드패널
  const { displayMode } = await chrome.storage.local.get({ displayMode: 'sidepanel' });

  if (displayMode === 'sidepanel') {
    try {
      await chrome.sidePanel.open({ tabId: tab.id });
      _openTabs.add(tab.id);
      return;
    } catch (err) {
      // 사이드패널 열기 실패 시 오버레이로 폴백
      console.warn('[ShoMate] 사이드패널 열기 실패, 오버레이로 대체:', err?.message || err);
    }
  }

  chrome.tabs.sendMessage(tab.id, { type: 'toggleOverlay' }, () => void chrome.runtime.lastError);
});


// ── Gemini 호출 경로 ────────────────────────────────────────────
// 🔒 키는 더 이상 클라이언트 번들에 두지 않는다. 두 경로 중 하나로 호출한다:
//   1) 사용자가 설정에서 '본인 키' 입력 → 그 키로 Gemini 직접 호출
//   2) (기본) Firebase 프록시(GEMINI_PROXY_URL)로 호출 → 키는 서버 시크릿에만 존재
// 배포 후: `firebase deploy --only functions` 출력 URL을 아래 GEMINI_PROXY_URL에 붙여넣거나
//          설정에서 chrome.storage.local 'geminiProxyUrl'로 주입하세요.
// FastAPI 백엔드 (서류 아키텍처: 확장 → FastAPI → AI). 기본 로컬 개발 서버.
// 설정에서 chrome.storage.local 'backendUrl'로 덮어쓸 수 있고, 서버가 꺼져 있으면 자동 폴백.
const DEFAULT_BACKEND_URL = 'http://localhost:8000';
let _backendOnline = null;          // null=미확인, true/false=최근 헬스체크 결과
let _backendCheckedAt = 0;

async function getBackendUrl() {
  try {
    const { backendUrl } = await chrome.storage.local.get('backendUrl');
    const u = (backendUrl || '').trim();
    return u === '__off__' ? '' : (u || DEFAULT_BACKEND_URL);
  } catch { return DEFAULT_BACKEND_URL; }
}

// 30초 캐시 헬스체크 — 매 호출마다 서버를 두드리지 않도록
async function isBackendOnline() {
  const url = await getBackendUrl();
  if (!url) return false;
  const now = Date.now();
  if (_backendOnline !== null && now - _backendCheckedAt < 30000) return _backendOnline;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 2500);
    const r = await fetch(`${url}/health`, { signal: ctl.signal });
    clearTimeout(t);
    _backendOnline = r.ok;
  } catch { _backendOnline = false; }
  _backendCheckedAt = now;
  return _backendOnline;
}

const GEMINI_PROXY_URL = ''; // 예: 'https://geminiproxy-xxxxxxxxxx-uc.a.run.app'
// 🔒 API 키는 이 번들에 절대 두지 않는다.
//    확장은 사용자 PC에 파일째 설치되고, 이 저장소는 공개돼 있다.
//    코드에 박은 키는 발급 즉시 공개된 키다.
//    "서버에서 키를 내려받는" 방식도 안 된다 — 받는 순간 네트워크 탭에 그대로 찍힌다.
//    반드시 서버가 키를 들고 대신 호출하는 '프록시' 구조여야 한다 (server/main.py).
//
// 호출 우선순위: ShoMate 백엔드 → 사용자 본인 키(설정에서 입력) → 프록시
// 셋 다 없으면 에러. 코드에 박아둔 폴백 키는 존재하지 않는다.
// ── 모델 선택 ─────────────────────────────────────────────────
// sidebar/model-selector.js 가 chrome.storage.local.selectedModel 에 저장한다.
// 허용목록은 서버(main.py MODEL_TIERS)와 동일. 목록 밖 값은 URL 에 넣지 않고 기본 모델로.
const MODEL_ALLOWLIST = ['gemini-3.5-flash-lite', 'gemini-3.7-flash', 'gemini-2.5-pro'];
const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
async function getSelectedModel() {
  try {
    const { selectedModel } = await chrome.storage.local.get('selectedModel');
    return MODEL_ALLOWLIST.includes(selectedModel) ? selectedModel : DEFAULT_MODEL;
  } catch { return DEFAULT_MODEL; }
}
const geminiDirectUrl = (key, model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

// 모델별 generationConfig 보정. 호출부는 전부 thinkingConfig.thinkingBudget:0 (= thinking 끄기) 을
// 보낸다 — 2.5 Flash 에서 thinking 토큰이 maxOutputTokens 를 잠식해 본문이 비는 문제 회피용.
// 그런데 **2.5 Flash 외의 모델은 thinking 을 끌 수 없다** → budget 0 은 400 ("Budget 0 is invalid").
// 2026-09-10 실제로 gemini-3.5-flash-lite 에서 400 발생.
// - 3.x: thinkingLevel 로 그 모델의 최저 레벨 지정 (공식 표: 3.5-flash-lite 는 minimal, 3.7-flash 는
//   low 가 최저 — minimal 미지원). thinkingBudget 과 thinkingLevel 을 같이 보내면 400 → 하나만.
// - 2.5 Pro: thinkingLevel 대신 thinkingBudget 최소값 128.
// maxOutputTokens 는 thinking 토큰까지 포함하므로 여유를 더한다 (서버는 4096 에서 캡).
const THINKING_FLOOR = { 'gemini-3.5-flash-lite': 'minimal', 'gemini-3.7-flash': 'low' };
function adaptGenConfig(model, cfg) {
  if (!cfg || cfg.thinkingConfig?.thinkingBudget !== 0) return cfg;
  if (model === 'gemini-2.5-flash') return cfg;   // 호출부 설정의 기준 모델 — 그대로
  const out = { ...cfg };
  let headroom = 1024;
  if (/^gemini-3/.test(model)) {
    const level = THINKING_FLOOR[model] || 'low';
    out.thinkingConfig = { thinkingLevel: level };
    if (level !== 'minimal') headroom = 2048;
  } else if (model === 'gemini-2.5-pro') {
    out.thinkingConfig = { thinkingBudget: 128 };
  }
  if (typeof out.maxOutputTokens === 'number') out.maxOutputTokens += headroom;
  return out;
}
const stripThinking = (cfg) => {
  if (!cfg || !cfg.thinkingConfig) return cfg;
  const { thinkingConfig, ...rest } = cfg;
  return rest;
};

// 직접 호출 (본인 키 / 개발 폴백 키). 설정·모델 비호환으로 실패해도 빈 화면으로 끝내지 않는다:
//   ① 그대로 → (400) ② thinkingConfig 제거(모델 기본 thinking) → (400) ③ tools 제거(검색 그라운딩 없이)
//   → (400/404) ④ 기준 모델 gemini-2.5-flash + 호출부 원본 설정
// 401/403/429/5xx 는 설정을 완화해도 소용없으니 즉시 중단. 완화가 일어나면 console.warn 으로 남긴다.
async function geminiDirect(key, model, prompt, adaptedCfg, rawCfg, tools, signal) {
  const attempt = async (m, cfg, t) => {
    const body = { contents: [{ parts: [{ text: prompt }] }] };
    if (cfg) body.generationConfig = cfg;
    if (t) body.tools = t;
    const res = await fetch(geminiDirectUrl(key, m), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
    });
    if (res.ok) return { ok: true, data: await res.json() };
    return { ok: false, status: res.status, text: await res.text().catch(() => '') };
  };
  const BASE = 'gemini-2.5-flash';
  const plan = [
    { m: model, cfg: adaptedCfg, t: tools, why: '' },
    { m: model, cfg: stripThinking(adaptedCfg), t: tools, why: 'thinkingConfig 제거' },
    tools ? { m: model, cfg: stripThinking(adaptedCfg), t: null, why: 'tools 제거' } : null,
    model !== BASE ? { m: BASE, cfg: rawCfg, t: tools, why: `기준 모델 ${BASE} 로 대체`, fallback: true } : null,
  ].filter(Boolean);
  let last = null;
  for (let i = 0; i < plan.length; i++) {
    const step = plan[i];
    if (step.fallback && last && last.status !== 400 && last.status !== 404) break;
    if (last) console.warn(`[ShoMate] Gemini ${last.status} → 재시도(${step.why}):`, last.text.slice(0, 160));
    const r = await attempt(step.m, step.cfg, step.t);
    if (r.ok) {
      if (i > 0) console.warn(`[ShoMate] ${step.why} 로 성공 — 설정/모델 점검 필요`);
      return r.data;
    }
    last = r;
    if (r.status === 404) {                      // 이 키에서 모델 자체가 안 열림 → 바로 기준 모델로
      const fb = plan.find(p => p.fallback);
      if (!fb || step.fallback) break;
      i = plan.indexOf(fb) - 1;
      continue;
    }
    if (r.status !== 400) break;
  }
  throw new Error(`Gemini ${last.status}: ${last.text.slice(0, 200)}`);
}

async function getUserApiKey() {
  try {
    const { geminiApiKey } = await chrome.storage.local.get('geminiApiKey');
    return (geminiApiKey || '').trim();
  } catch { return ''; }
}
async function getProxyUrl() {
  try {
    const { geminiProxyUrl } = await chrome.storage.local.get('geminiProxyUrl');
    return (geminiProxyUrl || '').trim() || GEMINI_PROXY_URL;
  } catch { return GEMINI_PROXY_URL; }
}

// 설정 페이지(options.html)가 "지금 어느 경로로 AI를 부르는지" 보여줄 때 쓴다.
// 코드에 박아둔 폴백 키가 없어졌으므로, 사용자가 자기 상태를 직접 확인할 수 있어야 한다.
async function getAiStatus() {
  const backendUrl = await getBackendUrl();
  const backendOnline = backendUrl ? await isBackendOnline() : false;
  const hasUserKey = !!(await getUserApiKey());
  const hasProxy = !!(await getProxyUrl());
  const naver = await getNaverCreds();
  const hasNaver = !!(naver.id && naver.secret);
  const path = backendUrl && backendOnline ? 'backend'
    : hasUserKey ? 'userKey'
    : hasProxy ? 'proxy'
    : 'none';
  return { path, backendUrl, backendOnline, hasUserKey, hasProxy, hasNaver };
}

// 선택 언어 — AI가 이 언어로 응답하도록 프롬프트에 주입
const LANG_NAME = { ko: '한국어', en: 'English', zh: '중국어(간체)', ja: '일본어' };
async function getLangName() {
  try {
    const { lang } = await chrome.storage.local.get('lang');
    return LANG_NAME[lang] || '한국어';
  } catch { return '한국어'; }
}

// 우선순위: FastAPI 백엔드(온라인 시) → 사용자 키 직접 → Firebase 프록시 → 개발용 폴백 키.
// 모델은 네 경로 모두 사용자가 고른 selectedModel 을 쓴다(백엔드는 라이선스 티어로 재검증).
// 항상 Gemini 원본 JSON을 반환. tools: 선택 — [{ google_search: {} }] (웹검색 그라운딩).
async function geminiRaw(prompt, generationConfig, signal, tools) {
  const extra = tools ? { tools } : {};
  const model = await getSelectedModel();
  const rawConfig = generationConfig;                       // 호출부 원본 (기준 모델 폴백용)
  generationConfig = adaptGenConfig(model, generationConfig);
  // 어느 경로로 어떤 모델이 실제 응답했는지 — 응답의 modelVersion 이 최종 근거
  const tag = (data, via) => {
    const actual = data?.modelVersion || '';
    console.log(`[ShoMate] AI 모델 요청=${model} 응답=${actual || '?'} (${via})`);
    // 사이드바 모델 알약이 '실제로 답한 모델'을 보여줄 수 있게 남긴다 (폴백 발동 시 불일치 표시)
    try { chrome.storage.local.set({ aiLastModel: actual, aiLastRequested: model, aiLastVia: via, aiLastAt: Date.now() }); } catch (_) {}
    return data;
  };

  // 1) FastAPI 백엔드 (서류 아키텍처) — 온라인일 때만
  try {
    if (await isBackendOnline()) {
      const base = await getBackendUrl();
      const res = await fetch(`${base}/gemini`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, generationConfig, model, license: await getLicense(), ...extra }),
        signal,
      });
      if (res.ok) {
        const data = await res.json();
        if (!data.error) return tag(data, '백엔드');   // 서버 오류면 아래 폴백으로
      }
    }
  } catch (e) {
    _backendOnline = false; // 실패하면 다음 30초간 폴백
    console.warn('[ShoMate] 백엔드 호출 실패, 폴백:', e?.message || e);
  }

  const userKey = await getUserApiKey();
  if (userKey) {
    return tag(await geminiDirect(userKey, model, prompt, generationConfig, rawConfig, tools || null, signal), '본인 키');
  }
  const proxyUrl = await getProxyUrl();
  if (proxyUrl) {
    const res = await fetch(proxyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, generationConfig, model, ...extra }),
      signal,
    });
    if (!res.ok) { const e = await res.text().catch(() => ''); throw new Error(`Proxy ${res.status}: ${e.slice(0, 200)}`); }
    return tag(await res.json(), '프록시');
  }
  // 여기까지 왔다면 쓸 수 있는 경로가 하나도 없다.
  // 코드에 키를 박아두는 폴백은 의도적으로 두지 않는다 (번들 = 공개 파일).
  throw new Error(
    'AI 호출 경로가 없습니다. ShoMate 백엔드가 꺼져 있고, 설정에 본인 API 키도 프록시 주소도 없습니다. ' +
    '서버를 실행하거나(server/README.md) 확장 설정에서 본인 Gemini API 키를 입력하세요.'
  );
}

// 결제 완료 시 서버가 발급한 서명 토큰. 위조해도 서버가 서명 검증에서 걸러낸다.
async function getLicense() {
  try {
    const { shomateLicense } = await chrome.storage.local.get('shomateLicense');
    return (shomateLicense || '').trim();
  } catch { return ''; }
}

// ── 결제(업그레이드) 흐름 ───────────────────────────────────────
// 확장 안에서는 토스 SDK 를 못 띄운다. MV3 는 확장 페이지의 원격 스크립트를
// 금지하므로(웹스토어 정책이기도 하다) 결제창은 일반 탭에서 서버가 띄운다.
// 서버가 결제를 확정하고 서명 토큰을 만들면, 여기서 폴링해 받아 저장한다.
const UPGRADE_POLL_MS = 2000;
const UPGRADE_TIMEOUT_MS = 3 * 60 * 1000;

async function pollUpgrade(sid, base, deadline) {
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, UPGRADE_POLL_MS));
    try {
      const r = await fetch(`${base}/billing/status?sid=${encodeURIComponent(sid)}`);
      if (!r.ok) continue;
      const d = await r.json();
      if (!d.pending && d.license) {
        await chrome.storage.local.set({
          shomateLicense: d.license,
          subscription: d.tier || 'pro',
        });
        await chrome.storage.local.remove('pendingUpgradeSid');
        try {
          chrome.notifications.create({
            type: 'basic', iconUrl: 'icons/icon128.png',
            title: 'ShoMate', message: `업그레이드 완료 — ${d.tier} 플랜이 적용되었습니다.`,
          });
        } catch {}
        return { ok: true, tier: d.tier };
      }
    } catch { /* 서버가 잠깐 끊겨도 계속 시도 */ }
  }
  return { ok: false, error: 'timeout' };
}

async function startUpgrade(plan) {
  // 번들의 업그레이드 버튼은 응답을 무시하므로, 실패는 알림으로 알린다.
  // 안 그러면 눌러도 아무 일도 안 일어난 것처럼 보인다.
  const failed = (msg) => {
    try {
      chrome.notifications.create({
        type: 'basic', iconUrl: 'icons/icon128.png',
        title: 'ShoMate — 업그레이드 실패', message: msg,
      });
    } catch {}
    return { ok: false, error: msg };
  };

  const base = await getBackendUrl();
  if (!base) return failed('백엔드 주소가 설정되어 있지 않습니다.');
  // /health 가 아니라 결제 엔드포인트로 확인한다.
  // /health 는 GEMINI_API_KEY 가 없으면 503 이라, AI 키와 결제가 엮이면 안 된다.
  try {
    const ping = await fetch(`${base}/billing/plans`);
    if (!ping.ok) throw new Error(String(ping.status));
  } catch {
    return failed(`결제 서버(${base})에 연결할 수 없습니다. 서버를 먼저 실행하세요.`);
  }
  const sid = (self.crypto?.randomUUID?.() || String(Date.now() + Math.random()));
  await chrome.storage.local.set({ pendingUpgradeSid: sid });
  await chrome.tabs.create({
    url: `${base}/billing/checkout?plan=${encodeURIComponent(plan)}&sid=${encodeURIComponent(sid)}`,
  });
  return pollUpgrade(sid, base, Date.now() + UPGRADE_TIMEOUT_MS);
}

// MV3 서비스워커는 유휴 30초면 죽는다. 폴링 중에 죽었으면 다음 기동 때 이어서 확인한다.
async function resumePendingUpgrade() {
  const { pendingUpgradeSid } = await chrome.storage.local.get('pendingUpgradeSid');
  if (!pendingUpgradeSid) return;
  const base = await getBackendUrl();
  if (!base) return;
  pollUpgrade(pendingUpgradeSid, base, Date.now() + 30 * 1000).catch(() => {});
}
chrome.runtime.onStartup.addListener(resumePendingUpgrade);
resumePendingUpgrade();

// 상품 결제(데모) — 확장이 보고 있는 상품을 토스 결제창으로 연다.
// 구독과 달리 라이선스는 발급되지 않는다. 결제창이 열리는 것만으로는 아무것도 기록하지
// 않고, 서버가 토스 confirm 을 마친 뒤 /billing/status 로 알려줄 때만 홈 탭 구매 내역에
// 남긴다. (예전에는 창이 열리는 순간 '구매 완료'로 기록했다 — 가짜 내역.)
const ITEM_PAID_ALARM = 'shomate-item-paid';
const ITEM_PAID_TIMEOUT_MS = 15 * 60 * 1000;

async function openItemCheckout(amount, name, meta = {}) {
  const amt = Math.round(Number(amount) || 0);
  if (!(amt > 0)) return { ok: false, error: '결제 금액이 없습니다.' };
  const base = await getBackendUrl();
  if (!base) return { ok: false, error: '백엔드 주소가 설정되어 있지 않습니다.' };
  try {
    const ping = await fetch(`${base}/billing/plans`);
    if (!ping.ok) throw new Error(String(ping.status));
  } catch {
    const msg = `결제 서버(${base})에 연결할 수 없습니다. server/start.command 를 실행하세요.`;
    try {
      chrome.notifications.create({
        type: 'basic', iconUrl: 'icons/icon128.png',
        title: 'ShoMate — 결제창을 열 수 없음', message: msg,
      });
    } catch {}
    return { ok: false, error: msg };
  }
  const sid = (self.crypto?.randomUUID?.() || String(Date.now() + Math.random()));
  const itemName = String(name || '상품 결제').slice(0, 80);
  const q = `amount=${amt}&name=${encodeURIComponent(itemName)}&sid=${encodeURIComponent(sid)}`;
  await chrome.tabs.create({ url: `${base}/billing/checkout?${q}` });
  const pending = {
    sid, base, amount: amt, name: itemName,
    saved: Math.max(0, Math.round(Number(meta.savings) || 0)),
    platform: String(meta.platform || '토스 결제').slice(0, 40),
    url: String(meta.url || '').slice(0, 500),
    startedAt: Date.now(),
  };
  await chrome.storage.local.set({ pendingItemCheckout: pending });
  try { chrome.alarms.create(ITEM_PAID_ALARM, { periodInMinutes: 0.5 }); } catch {}
  pollItemPaid(pending).catch(() => {});
  return { ok: true, amount: amt, sid };
}

// 서버가 confirm 을 끝냈는지 한 번 확인. 기록했으면 true.
async function checkItemPaidOnce(pending) {
  const r = await fetch(`${pending.base}/billing/status?sid=${encodeURIComponent(pending.sid)}`);
  if (!r.ok) return false;
  const d = await r.json();
  if (d.pending || !d.paid) return false;
  await recordPaidPurchase(pending, d.paid);
  return true;
}

async function finishItemCheckout(pending) {
  const { pendingItemCheckout } = await chrome.storage.local.get('pendingItemCheckout');
  if (!pendingItemCheckout || pendingItemCheckout.sid === pending.sid) {
    await chrome.storage.local.remove('pendingItemCheckout');
    try { chrome.alarms.clear(ITEM_PAID_ALARM); } catch {}
  }
}

async function pollItemPaid(pending) {
  const deadline = pending.startedAt + ITEM_PAID_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, UPGRADE_POLL_MS));
    const { pendingItemCheckout } = await chrome.storage.local.get('pendingItemCheckout');
    if (!pendingItemCheckout || pendingItemCheckout.sid !== pending.sid) return { ok: false, error: 'superseded' };
    try {
      if (await checkItemPaidOnce(pending)) { await finishItemCheckout(pending); return { ok: true }; }
    } catch { /* 서버가 잠깐 끊겨도 계속 시도 */ }
  }
  await finishItemCheckout(pending);
  return { ok: false, error: 'timeout' };
}

// 알람 폴백 + 서비스워커 재기동 시 이어서 확인
async function checkPendingItemCheckout() {
  const { pendingItemCheckout } = await chrome.storage.local.get('pendingItemCheckout');
  if (!pendingItemCheckout) { try { chrome.alarms.clear(ITEM_PAID_ALARM); } catch {} return; }
  if (Date.now() > (pendingItemCheckout.startedAt || 0) + ITEM_PAID_TIMEOUT_MS) {
    await finishItemCheckout(pendingItemCheckout); return;
  }
  try {
    if (await checkItemPaidOnce(pendingItemCheckout)) await finishItemCheckout(pendingItemCheckout);
  } catch {}
}
checkPendingItemCheckout().catch(() => {});

// 구매 내역 날짜 라벨 — '오늘'로 고정하면 다음 날부터 거짓말이 된다
function purchaseDateLabel(ts) {
  const d = new Date(Number(ts) || Date.now());
  return `${d.getMonth() + 1}월 ${d.getDate()}일`;
}

// 결제 확정된 상품을 구매 내역(autoPurchases)에 기록 — 주문완료 페이지 감지와 같은 형식
async function recordPaidPurchase(pending, paid) {
  const { autoPurchases } = await chrome.storage.local.get({ autoPurchases: [] });
  const list = Array.isArray(autoPurchases) ? autoPurchases : [];
  const capturedAt = Number(paid.paidAt) || Date.now();
  const price = Number(paid.amount) || pending.amount;
  const id = `auto-toss-${String(pending.sid || '').slice(0, 8)}-${capturedAt}`;
  if (list.some(x => x.id === id || x.orderId === paid.orderId)) return;
  const record = {
    id, name: paid.name || pending.name, price,
    date: purchaseDateLabel(capturedAt), saved: pending.saved || 0,
    platform: pending.platform || '토스 결제',
    source: 'toss', orderId: paid.orderId || '', url: pending.url || '',
    capturedAt,
  };
  await chrome.storage.local.set({ autoPurchases: [record, ...list].slice(0, 100) });
  try {
    chrome.notifications.create({
      type: 'basic', iconUrl: 'icons/icon128.png',
      title: 'ShoMate — 결제 완료',
      message: `${record.name} ${price.toLocaleString()}원 결제가 확인되어 홈 탭 구매 내역에 기록했어요.`,
    });
  } catch {}
}

// 메시지 처리
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'analyzeUrl') {
    analyzeUrl(message.url)
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message || String(err) }));
    return true;
  }
  if (message.type === 'geminiAnalyze') {
    callGemini(message.data)
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message || String(err) }));
    return true;
  }
  if (message.type === 'geminiChat') {
    callGeminiChat(message.productName, message.question)
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message || String(err) }));
    return true;
  }
  if (message.type === 'geminiReviews') {
    callGeminiReviews(message.productName, message.reviewTexts)
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message || String(err) }));
    return true;
  }
  if (message.type === 'geminiPrice') {
    callGeminiPrice(message.priceText, message.productName)
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message || String(err) }));
    return true;
  }
  if (message.type === 'findRealListings') {
    findRealListings(message.productName, message.currentPrice, message.specText)
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message || String(err) }));
    return true;
  }
  if (message.type === 'findPriceFloor') {
    findPriceFloor(message.productName, message.currentPrice, message.specText)
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message || String(err) }));
    return true;
  }
  if (message.type === 'openCheckout') {
    openItemCheckout(message.amount, message.name, {
      savings: message.savings, platform: message.platform, url: message.url,
    })
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }
  if (message.type === 'openUpgrade') {
    startUpgrade(message.plan || 'pro')
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }
  if (message.type === 'aiStatus') {
    _backendOnline = null; // 설정 저장 직후 호출되므로 캐시를 버리고 강제 재확인
    getAiStatus()
      .then(sendResponse)
      .catch(err => sendResponse({
        path: 'none', backendUrl: '', backendOnline: false,
        hasUserKey: false, hasProxy: false, hasNaver: false,
        error: err?.message || String(err),
      }));
    return true;
  }
  if (message.type === 'backendStatus') {
    _backendOnline = null; // 강제 재확인
    (async () => {
      const online = await isBackendOnline();
      const url = await getBackendUrl();
      sendResponse({ online, url });
    })();
    return true;
  }
  if (message.type === 'orderCompleted') {
    const p = message.payload || {};
    chrome.storage.local.get({ autoPurchases: [] }, ({ autoPurchases }) => {
      const list = Array.isArray(autoPurchases) ? autoPurchases : [];
      const name = String(p.name || '주문 상품').trim();
      const price = Number(p.price) || 0;
      const capturedAt = Number(p.capturedAt) || Date.now();
      const DAY = 24 * 60 * 60 * 1000;
      const dup = list.some(x =>
        x.name === name && Number(x.price) === price &&
        Math.abs((Number(x.capturedAt) || 0) - capturedAt) < DAY
      );
      if (dup) { sendResponse({ ok: true, added: false }); return; }
      const id = `auto-${capturedAt}-${Math.abs((name + price).split('').reduce((a, c) => ((a << 5) - a + c.charCodeAt(0)) | 0, 0))}`;
      const record = {
        id, name, price,
        date: purchaseDateLabel(capturedAt),
        saved: 0,
        platform: p.platform || '알 수 없음',
        source: 'auto',
        capturedAt,
      };
      const next = [record, ...list].slice(0, 100);
      chrome.storage.local.set({ autoPurchases: next }, () => sendResponse({ ok: true, added: true }));
    });
    return true;
  }
  if (message.type === 'registerPriceWatch') {
    chrome.storage.local.get({ priceWatches: [] }, ({ priceWatches }) => {
      const w = message.watch;
      const next = priceWatches.filter(x => x.productKey !== w.productKey);
      next.push({ ...w, source: 'product', createdAt: Date.now() });
      chrome.storage.local.set({ priceWatches: next }, () => sendResponse({ ok: true }));
    });
    return true;
  }
  if (message.type === 'removePriceWatch') {
    chrome.storage.local.get({ priceWatches: [] }, ({ priceWatches }) => {
      const next = priceWatches.filter(x => x.productKey !== message.productKey);
      chrome.storage.local.set({ priceWatches: next }, () => sendResponse({ ok: true }));
    });
    return true;
  }
  if (message.type === 'checkPriceWatchesNow') {
    runPriceWatchCheck().then(n => sendResponse({ ok: true, checked: n }))
      .catch(err => sendResponse({ error: err.message || String(err) }));
    return true;
  }
  if (message.type === 'searchPrices') {
    searchShoppingPrices(message.query, message.currentPrice, message.specText)
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message || String(err) }));
    return true;
  }
  if (message.type === 'refreshWishlistPrices') {
    runWishlistPriceRefresh(!!message.force)
      .then(n => sendResponse({ ok: true, updated: n }))
      .catch(err => sendResponse({ error: err.message || String(err) }));
    return true;
  }
  if (message.type === 'setDisplayMode') {
    chrome.storage.local.set({ displayMode: message.mode });
    sendResponse({ ok: true });
  }
  if (message.type === 'openTab') {
    // active:false면 백그라운드 탭 — 현재 화면(비교 중인 패널)이 유지된다
    chrome.tabs.create({ url: message.url, active: message.active !== false });
    sendResponse({ ok: true });
  }
  if (message.type === 'toggleSidePanel') {
    const tabId = _sender?.tab?.id;
    const windowId = _sender?.tab?.windowId;
    if (!tabId || !windowId) { sendResponse({ ok: false }); return; }

    if (_openTabs.has(tabId)) {
      // 닫기: enabled false → 즉시 true 복원
      chrome.sidePanel.setOptions({ tabId, enabled: false })
        .then(() => chrome.sidePanel.setOptions({ tabId, enabled: true, path: 'sidebar/index.html' }))
        .then(() => { _openTabs.delete(tabId); sendResponse({ ok: true, action: 'closed' }); })
        .catch(err => sendResponse({ error: err.message }));
    } else {
      // 열기
      chrome.sidePanel.open({ windowId })
        .then(() => { _openTabs.add(tabId); sendResponse({ ok: true, action: 'opened' }); })
        .catch(err => sendResponse({ error: err.message }));
    }
    return true;
  }
  if (message.type === 'openSidePanel') {
    const windowId = _sender?.tab?.windowId;
    if (windowId) {
      chrome.sidePanel.open({ windowId })
        .then(() => { if (_sender?.tab?.id) _openTabs.add(_sender.tab.id); sendResponse({ ok: true }); })
        .catch(err => sendResponse({ error: err.message }));
      return true;
    }
    sendResponse({ ok: false });
  }
});

// ── Gemini AI 분석 ──────────────────────────────────────────────

async function callGemini({ productName, currentPrice, detectedMall, rawText = '', soldOut = false, soldOutText = '' }) {
  const stockLine = soldOut ? `\n판매 상태: 현재 구매 불가 (${soldOutText || '일시품절'})` : '';
  const stockRule = soldOut ? '\n[중요] 이 상품은 지금 살 수 없다. recommendation과 aiPros에서 구매를 권하지 말고, 재입고 확인이나 대안 검토를 권하라.' : '';
  const snippet = rawText.slice(0, 3000);
  const priceStr = currentPrice ? `${Number(currentPrice).toLocaleString('ko-KR')}원` : '정보 없음';
  const langName = await getLangName();

  const prompt = `다음 쇼핑 상품을 분석하세요. 반드시 아래 JSON 형식으로만 응답하고, JSON 외 다른 텍스트는 절대 출력하지 마세요.
[중요] JSON의 모든 문자열 값(요약·장단점·추천·이유 등)은 반드시 ${langName}로 작성하세요. searchQuery는 원어 유지.

상품명: ${productName || '알 수 없음'}
현재 판매가: ${priceStr}
쇼핑몰: ${detectedMall || '알 수 없음'}${stockLine}
페이지 내용:
${snippet}${stockRule}

응답 JSON:
{
  "aiSummary": "이 상품의 특징, 품질, 주요 용도를 설명하는 2-3문장 한국어 요약",
  "aiPros": ["구체적 장점 또는 특징 1", "구체적 장점 또는 특징 2", "구체적 장점 또는 특징 3"],
  "aiCons": ["주의할 점 또는 단점 1", "주의할 점 또는 단점 2"],
  "priceAssessment": "저렴 또는 적당 또는 비쌈",
  "recommendation": "이 상품 구매에 대한 한 문장 추천 의견",
  "sameProductAlts": [
    {"platform": "네이버쇼핑", "estimatedPrice": 숫자, "reason": "최저가 검색", "searchQuery": "정확한 상품명"},
    {"platform": "쿠팡", "estimatedPrice": 숫자, "reason": "로켓배송 가능", "searchQuery": "정확한 상품명"},
    {"platform": "11번가", "estimatedPrice": 숫자, "reason": "포인트 적립", "searchQuery": "정확한 상품명"}
  ],
  "alternativeProducts": [
    {"productName": "다른 브랜드 경쟁 상품명 1", "platform": "네이버쇼핑", "estimatedPrice": 숫자, "reason": "가성비 대안", "searchQuery": "검색어"},
    {"productName": "다른 브랜드 경쟁 상품명 2", "platform": "쿠팡", "estimatedPrice": 숫자, "reason": "인기 대안", "searchQuery": "검색어"},
    {"productName": "다른 브랜드 경쟁 상품명 3", "platform": "11번가", "estimatedPrice": 숫자, "reason": "고성능 대안", "searchQuery": "검색어"}
  ]
}

반드시 지켜야 할 규칙 (위반 시 사용 불가):
1. sameProductAlts.estimatedPrice는 현재 판매가(${Number(currentPrice).toLocaleString('ko-KR')}원)보다 낮거나 같아야 함. 더 비싼 값은 절대 금지. 확실하지 않으면 현재가와 동일하게.
2. alternativeProducts는 현재 상품과 완전히 다른 브랜드·모델의 실제 경쟁 상품이어야 함 (같은 상품명 변형 금지)
   예: 나이키 티셔츠 → 아디다스 티셔츠, 언더아머 티셔츠, 뉴발란스 티셔츠
   예: 갤럭시 버즈 → 소니 WF-C700N, 에어팟 프로, 보스 QuietComfort Earbuds
3. alternativeProducts.estimatedPrice는 현재 판매가(${Number(currentPrice).toLocaleString('ko-KR')}원) 기준 ±30% 범위 내
4. 모든 숫자는 JSON 숫자형(따옴표 없이)으로 작성
5. searchQuery는 해당 플랫폼에서 실제로 검색할 구체적인 상품명
6. sameProductAlts의 가격이 현재가보다 높으면 JSON 생성 실패로 간주하고 재작성할 것`;

  const data = await geminiRaw(prompt, { temperature: 0.4, maxOutputTokens: 1024, thinkingConfig: { thinkingBudget: 0 } });
  console.log('[ShoMate] Gemini 성공:', data.candidates?.[0]?.content?.parts?.[0]?.text?.slice(0, 100));
  const text = (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();

  try {
    const m = text.match(/\{[\s\S]*\}/);
    return JSON.parse(m ? m[0] : text);
  } catch {
    return { aiSummary: text.slice(0, 300), aiPros: [], aiCons: [], priceAssessment: '적당', recommendation: '' };
  }
}

// ── AI Q&A 채팅 ────────────────────────────────────────────────

async function callGeminiChat(productName, question) {
  const today = new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' });
  const langName = await getLangName();
  const prompt = `당신은 쇼핑 전문가 AI 어시스턴트입니다. 오늘 날짜는 ${today}입니다. 최신 출시 제품들(아이폰 17 시리즈, 갤럭시 S25 시리즈 등 2025년 이후 제품 포함)을 알고 있습니다.

분석 중인 상품: "${productName || '알 수 없는 상품'}"
사용자 질문: "${question}"

답변 규칙:
- 핵심만 간결하게, 3~5문장 이내로 답변하세요.
- 표(table)는 절대 사용하지 마세요.
- 마크다운 헤더(#, ##)는 사용하지 마세요.
- 불릿(•, -)은 꼭 필요할 때만 최대 3개까지만 사용하세요.
- 반드시 ${langName}로 자연스럽게 대화하듯 답변하세요.
- 모르는 정보는 모른다고 짧게 말하세요.`;

  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 25000);

  try {
    const data = await geminiRaw(
      prompt,
      { temperature: 0.7, maxOutputTokens: 1024, thinkingConfig: { thinkingBudget: 0 } },
      controller.signal
    );
    const answer = (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
    return { answer: answer || '답변을 가져올 수 없습니다.' };
  } finally {
    clearTimeout(tid);
  }
}

// ── URL 분석 로직 (server.js 내장) ──────────────────────────────

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ko-KR,ko;q=0.9',
};

function extractMeta(html, attr) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${attr}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i');
  const m = html.match(re);
  return m ? m[1].trim() : null;
}

// JSON-LD offers.price 추출 (서버 HTML에 인라인된 경우 가장 신뢰도 높음 — content-script와 동일 우선순위)
function getJsonLdPriceFromHtml(html) {
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const data = JSON.parse(m[1].trim());
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        const offers = item && item.offers;
        if (!offers) continue;
        const list = Array.isArray(offers) ? offers : [offers];
        for (const o of list) {
          const p = o && (o.price ?? o.lowPrice);
          if (p != null && !isNaN(Number(p)) && Number(p) >= 100) return Number(p);
        }
      }
    } catch (_) {}
  }
  return null;
}

function parsePrice(html) {
  const ld = getJsonLdPriceFromHtml(html);
  if (ld != null) return ld;
  for (const k of ['product:price:amount', 'og:price:amount', 'price:amount', 'price']) {
    const v = extractMeta(html, k);
    if (v) { const n = Number(v.replace(/[^0-9.]/g, '')); if (!isNaN(n)) return n; }
  }
  const m = html.match(/([0-9]{1,3}(?:,[0-9]{3})*)[\s]*원/);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

function detectPlatform(url, html) {
  // URL 기반 판단을 body text보다 먼저 — 가격비교 페이지에 타 플랫폼명이 나와도 오감지 방지
  if (url.includes('11st.co.kr') || url.includes('11st.')) return '11번가';
  if (url.includes('coupang.com')) return '쿠팡';
  if (url.includes('naver.com') || url.includes('naver.co.kr')) return '네이버쇼핑';
  if (url.includes('gmarket.co.kr')) return 'G마켓';
  if (url.includes('auction.co.kr')) return '옥션';
  if (url.includes('interpark.com')) return '인터파크';
  if (url.includes('lotteon.com')) return '롯데온';
  if (url.includes('ssg.com')) return 'SSG';
  // URL로 판단 안 될 때만 html 텍스트 사용
  if (html.includes('11번가')) return '11번가';
  if (html.includes('쿠팡')) return '쿠팡';
  if (html.includes('네이버')) return '네이버쇼핑';
  if (html.includes('G마켓')) return 'G마켓';
  if (html.includes('옥션')) return '옥션';
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return '알 수 없음'; }
}

async function analyzeUrl(rawUrl) {
  const res = await fetch(rawUrl, { headers: HEADERS });
  if (!res.ok) throw new Error(`페이지 로드 실패: ${res.status}`);
  const html = await res.text();

  const title = extractMeta(html, 'og:title') || extractMeta(html, 'twitter:title')
    || html.match(/<title>([^<]+)<\/title>/i)?.[1]?.trim()
    || new URL(rawUrl).hostname;
  const description = extractMeta(html, 'og:description') || extractMeta(html, 'description') || '';
  const image = extractMeta(html, 'og:image') || extractMeta(html, 'twitter:image') || '';
  const currentPrice = parsePrice(html);
  const detectedMall = detectPlatform(rawUrl, html);
  const productName = title || `상품 정보 (${detectedMall})`;
  const bodyText = String(html || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const soldOutM = bodyText.match(/일시\s*품절|판매\s*(?:종료|중지)|sold\s*out|재고\s*없음/i);
  const soldOut = !!soldOutM;
  const specM = bodyText.match(/(\d+(?:\.\d+)?\s*(?:ml|mL|㎖|L|리터|g|kg|㎏)\s*[x×X*]\s*\d{1,4}\s*개?)/);
  const specText = specM ? specM[1].replace(/\s+/g, '') : (parseSpec(productName) ? parseSpec(productName).label : null);

  // 최저가 날조 금지: 실측(네이버쇼핑 API)이 가능할 때만 값을 채우고, 아니면 null(비교 불가로 표시)
  let mktLow = null;
  let naverAlts = [];
  if (currentPrice && productName) {
    try {
      const r = await searchShoppingPrices(productName, currentPrice, specText);
      if (r.configured && r.items.length) {
        const best = r.items[0]; // 타당성 필터 + 가격순 정렬 완료
        if (best.price < currentPrice) {
          mktLow = { price: best.price, platform: best.mall, savePotential: currentPrice - best.price };
        }
        naverAlts = r.items.slice(0, 5).map((it, i) => ({
          id: `np-${i}`, type: 'optimal', badge: '실시간 최저가',
          productName: it.title || productName, name: it.title || productName,
          price: it.price, estimatedPrice: it.price,
          savings: Math.max(currentPrice - it.price, 0),
          platform: it.mall || '네이버쇼핑', tags: ['네이버쇼핑 실시간'],
          reason: '네이버쇼핑 실시간 최저가', url: it.link, imageUrl: it.image || undefined,
        }));
      }
    } catch (e) { console.warn('[ShoMate] 네이버 최저가 조회 실패(무시):', e?.message || e); }
  }

  // 현재 페이지가 정상적인 쇼핑몰이면 그 URL을 직접 사용 (검색 페이지 아님)
  const isValidShoppingPage = rawUrl && (
    !rawUrl.includes('search') &&
    !rawUrl.includes('query') &&
    !rawUrl.includes('keyword') &&
    (detectedMall === '쿠팡' || detectedMall === '네이버쇼핑' || detectedMall === '11번가' || detectedMall === 'G마켓' || detectedMall === '옥션')
  );

  const primaryProductUrl = isValidShoppingPage ? rawUrl : rawUrl;

  const altSuggestions = currentPrice ? [
    {
      id: 'alt-1', type: 'optimal', badge: '현재 상품',
      productName, name: `${productName} - 현재 상품 보기`,
      price: currentPrice,
      estimatedPrice: currentPrice,
      savings: 0,
      platform: detectedMall, tags: ['현재 페이지'],
      reason: '현재 보고 있는 상품',
      url: primaryProductUrl,
    },
    ...naverAlts, // 실측된 항목만. 임의 가격(×0.94)·임의 평점(4.5) 항목은 제거
  ] : [];

  return {
    sourceUrl: rawUrl,
    productName,
    currentPrice,
    detectedMall,
    soldOut,
    soldOutText: soldOutM ? soldOutM[0] : null,
    specText,
    imageUrl: image,
    summary: description || `${productName} 상품을 분석했습니다.`,
    aiSummary: description || `${productName} 상품을 분석했습니다.`,
    aiPros: ['상품 정보가 수집되었습니다.', '가격 비교 정보를 확인하세요.'],
    aiCons: currentPrice ? [] : ['가격 정보를 찾지 못했습니다.'],
    warnings: buildSellerWarningsFromHtml(html),
    comparisons: {
      marketLowestPrice: mktLow,
      alternativeSuggestions: altSuggestions,
    },
  };
}

// ── 가격만 가볍게 재수집 (알람용) ───────────────────────────────
async function fetchPriceForUrl(rawUrl) {
  const res = await fetch(rawUrl, { headers: HEADERS });
  if (!res.ok) throw new Error(`페이지 로드 실패: ${res.status}`);
  const html = await res.text();
  const title = extractMeta(html, 'og:title') || extractMeta(html, 'twitter:title')
    || html.match(/<title>([^<]+)<\/title>/i)?.[1]?.trim()
    || new URL(rawUrl).hostname;
  return {
    productName: title,
    currentPrice: parsePrice(html),
    detectedMall: detectPlatform(rawUrl, html),
    imageUrl: extractMeta(html, 'og:image') || extractMeta(html, 'twitter:image') || '',
  };
}

// ── 가격 감시 실행 ──────────────────────────────────────────────
async function runPriceWatchCheck() {
  const snapshot = (await chrome.storage.local.get({ priceWatches: [] })).priceWatches;
  if (!Array.isArray(snapshot) || snapshot.length === 0) return 0;

  const now = Date.now();
  const results = new Map(); // productKey -> { lastSeenPrice, lastNotifiedAt? }

  for (const w of snapshot) {
    if (!w.url || typeof w.targetPrice !== 'number') continue;
    let info;
    try { info = await fetchPriceForUrl(w.url); }
    catch (e) { console.warn('[ShoMate] 감시 fetch 실패:', w.url, e?.message || e); continue; }
    const price = info.currentPrice;
    if (price == null) continue;
    const r = { lastSeenPrice: price };

    // 모드별 재알림 주기: immediate=12h, daily=24h, weekly=7d
    const at = w.alertType ?? 'immediate';
    const windowMs = at === 'weekly' ? 7 * 24 * 60 * 60 * 1000 : at === 'daily' ? 24 * 60 * 60 * 1000 : NOTIFY_THROTTLE_MS;
    const hitTarget = price <= w.targetPrice;
    const throttled = w.lastNotifiedAt && (now - w.lastNotifiedAt) < windowMs;
    if (hitTarget && !throttled) {
      notifyPriceDrop(w, price);
      r.lastNotifiedAt = now;
    }
    results.set(w.productKey, r);
  }

  // 폴링은 수 초~수십 초 걸리므로, 끝나면 최신 상태를 다시 읽어 델타만 병합한다.
  // (폴링 중 사용자가 추가/삭제한 watch를 stale 스냅샷으로 덮어쓰지 않도록 — lost-update 방지)
  if (results.size > 0) {
    const fresh = (await chrome.storage.local.get({ priceWatches: [] })).priceWatches;
    if (Array.isArray(fresh)) {
      let changed = false;
      for (const w of fresh) {
        const r = results.get(w.productKey);
        if (!r) continue;
        w.lastSeenPrice = r.lastSeenPrice;
        if (r.lastNotifiedAt) w.lastNotifiedAt = r.lastNotifiedAt;
        changed = true;
      }
      if (changed) await chrome.storage.local.set({ priceWatches: fresh });
    }
  }
  return snapshot.length;
}

function notifyPriceDrop(watch, price) {
  const notifId = `pw-${watch.productKey}-${Date.now()}`;
  chrome.notifications.create(notifId, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: 'ShoMate 가격 하락 알림',
    message: `${watch.productName}\n목표가 ${watch.targetPrice.toLocaleString('ko-KR')}원 이하 도달! 현재 ${price.toLocaleString('ko-KR')}원`,
    priority: 2,
  }, () => void chrome.runtime.lastError);
  // 클릭 시 열 url을 영속 저장 (최근 50개만 유지)
  chrome.storage.local.get({ notifUrlMap: {} }, ({ notifUrlMap }) => {
    notifUrlMap[notifId] = watch.url;
    const keys = Object.keys(notifUrlMap);
    if (keys.length > 50) for (const k of keys.slice(0, keys.length - 50)) delete notifUrlMap[k];
    chrome.storage.local.set({ notifUrlMap });
  });
}

// ── 찜·최근 본 상품 시세 자동 수집 (하루 1회) ─────────────────────
// 사이드바가 쓰는 priceHistory(chrome.storage.local, 상품키별 [{t,price}], 하루 1점, 최대 60점)와
// 같은 규칙으로 점을 추가한다 → 페이지를 열지 않아도 시세 그래프가 매일 쌓인다.
// 찜 상품이 이력상 최저가보다 1% 이상 싸지면 알림(상품당 12시간 1회).
const WISH_REFRESH_GAP_MS = 20 * 60 * 60 * 1000; // 같은 상품은 20시간 지나야 재수집
const WISH_MAX_PER_RUN = 12;                     // 알람 1회(1시간)당 최대 수집 수 — 부하 제한
const HIST_BUCKET_MS = 1440 * 60 * 1000;         // 사이드바 C_ 와 동일 (하루 1점)
const HIST_MAX_POINTS = 60;                      // 사이드바 N_ 와 동일

function mergeHistoryPoints(points) {
  const byDay = new Map();
  for (const p of points) {
    if (!p || typeof p.price !== 'number' || !isFinite(p.price) || p.price <= 0 || !isFinite(p.t)) continue;
    const day = Math.floor(p.t / HIST_BUCKET_MS) * HIST_BUCKET_MS;
    const prev = byDay.get(day);
    if (!prev || p.t >= prev.t) byDay.set(day, { t: p.t, price: Math.round(p.price) });
  }
  const out = Array.from(byDay.values()).sort((a, b) => a.t - b.t);
  return out.length > HIST_MAX_POINTS ? out.slice(out.length - HIST_MAX_POINTS) : out;
}

async function runWishlistPriceRefresh(force = false) {
  const { wishlistItems, recentProducts, priceHistory } =
    await chrome.storage.local.get({ wishlistItems: [], recentProducts: [], priceHistory: {} });
  const now = Date.now();
  const seen = new Set();
  const targets = [];
  const add = (it, wish) => {
    const key = String(it?.priceKey || it?.id || '');
    const url = String(it?.url || '');
    if (!key || seen.has(key) || !/^https?:\/\//.test(url)) return;
    seen.add(key);
    const pts = Array.isArray(priceHistory?.[key]) ? priceHistory[key] : [];
    const last = pts.length ? Number(pts[pts.length - 1].t) || 0 : 0;
    if (!force && now - last < WISH_REFRESH_GAP_MS) return;
    targets.push({ key, url, name: String(it.name || ''), wish, last });
  };
  (Array.isArray(wishlistItems) ? wishlistItems : []).forEach(it => add(it, true));
  (Array.isArray(recentProducts) ? recentProducts : []).forEach(it => add(it, false));
  targets.sort((a, b) => (b.wish - a.wish) || (a.last - b.last)); // 찜 우선, 오래된 것 우선

  let updated = 0;
  for (const t of targets.slice(0, force ? 30 : WISH_MAX_PER_RUN)) {
    let price;
    try { price = Number((await fetchPriceForUrl(t.url)).currentPrice); }
    catch (e) { console.warn('[ShoMate] 찜 시세 수집 실패(무시):', t.name, e?.message || e); continue; }
    if (!(price > 0)) continue;

    // fetch 사이에 사이드바가 이력을 썼을 수 있으므로 저장 직전에 다시 읽어 키 단위로 병합 (lost-update 방지)
    const fresh = await chrome.storage.local.get({ priceHistory: {}, wishNotifiedAt: {} });
    const hist = fresh.priceHistory && typeof fresh.priceHistory === 'object' ? fresh.priceHistory : {};
    const prev = Array.isArray(hist[t.key]) ? hist[t.key] : [];
    const prevPrices = prev.map(p => Number(p.price)).filter(v => v > 0);
    const prevMin = prevPrices.length ? Math.min(...prevPrices) : null;
    hist[t.key] = mergeHistoryPoints([...prev, { t: Date.now(), price }]);
    const toSet = { priceHistory: hist };

    const notified = fresh.wishNotifiedAt && typeof fresh.wishNotifiedAt === 'object' ? fresh.wishNotifiedAt : {};
    if (t.wish && prevMin != null && price <= prevMin * 0.99 && now - (Number(notified[t.key]) || 0) > NOTIFY_THROTTLE_MS) {
      notifyWishlistLow(t, price, prevMin);
      notified[t.key] = now;
      toSet.wishNotifiedAt = notified;
    }
    await chrome.storage.local.set(toSet);
    updated++;
  }
  if (updated) console.log(`[ShoMate] 찜/최근 상품 시세 수집: ${updated}건`);
  return updated;
}

function notifyWishlistLow(t, price, prevMin) {
  const notifId = `wl-${Date.now()}-${Math.abs(t.key.split('').reduce((a, c) => ((a << 5) - a + c.charCodeAt(0)) | 0, 0))}`;
  chrome.notifications.create(notifId, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: 'ShoMate 찜 상품 최저가',
    message: `${t.name}\n역대 최저 ${prevMin.toLocaleString('ko-KR')}원 → 지금 ${price.toLocaleString('ko-KR')}원`,
    priority: 2,
  }, () => void chrome.runtime.lastError);
  chrome.storage.local.get({ notifUrlMap: {} }, ({ notifUrlMap }) => {
    notifUrlMap[notifId] = t.url;
    const keys = Object.keys(notifUrlMap);
    if (keys.length > 50) for (const k of keys.slice(0, keys.length - 50)) delete notifUrlMap[k];
    chrome.storage.local.set({ notifUrlMap });
  });
}

// ── 판매자 신뢰 경고 (HTML 기반, 워커에 DOM 없음) ───────────────
// 다크패턴 감지 (HTML 텍스트 기반) — content-script와 동일 규칙
function buildDarkPatternWarningsFromHtml(html) {
  const text = String(html || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  const rules = [
    { id: 'dp-urgency', re: /(남은\s*시간|마감\s*임박|판매\s*종료\s*임박|곧\s*(마감|종료|품절)|지금\s*안\s*사면|[0-9]{1,2}\s*분\s*[0-9]{2}\s*초)/, message: '거짓 긴급성(카운트다운·마감 임박)으로 조급함을 유도할 수 있어요. 서두르지 말고 차분히 확인하세요.' },
    { id: 'dp-social', re: /([0-9][0-9,]*\s*명(이)?\s*(구매|구입|주문|보고\s*있|담았|참여|신청))/, message: '“N명 구매/보는 중” 같은 사회적 증거는 과장·조작될 수 있어요. 실제 리뷰 수와 비교하세요.' },
    { id: 'dp-stock', re: /((품절|재고)\s*임박|단\s*[0-9]+\s*개?\s*남|마지막\s*[0-9]+\s*개|[0-9]+\s*개?\s*(밖에\s*)?남았)/, message: '재고 압박(“품절 임박/N개 남음”)은 인위적으로 만들어질 수 있어요. 조급하게 결정하지 마세요.' },
    { id: 'dp-subscription', re: /(무료\s*체험|첫\s*달\s*무료)[\s\S]{0,50}(자동\s*(결제|연장|갱신)|정기\s*결제|매월|구독)|자동\s*결제\s*동의/, message: '숨은 자동결제·정기구독 조건이 있을 수 있어요. 결제 전 “자동 결제/정기결제” 항목을 확인하세요.' },
  ];
  const out = [];
  for (const r of rules) { try { if (r.re.test(text)) out.push({ id: r.id, level: 'high', type: 'darkpattern', message: r.message }); } catch (_) {} }
  return out;
}

function buildSellerWarningsFromHtml(html) {
  const text = String(html || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
  const out = buildDarkPatternWarningsFromHtml(html);
  const lrw = text.match(/([0-9]{1,4})\s*건\s*이하의\s*평가/);
  let reviewCount = null;
  const rc = text.replace(/,/g, '').match(/(?:리뷰|구매평|상품평|평가|후기)\D{0,4}([0-9]{1,7})\s*(?:건|개)?/);
  if (rc) reviewCount = Number(rc[1]);
  let rating = null;
  const rm = text.match(/(?:평점|별점)\D{0,4}([0-5](?:\.[0-9])?)/);
  if (rm) rating = Number(rm[1]);
  if (lrw) {
    out.push({ id: 'sw-lowreview-text', level: 'high', type: 'seller', message: `이 판매자는 '${lrw[0].trim()}'를 받은 신규/소규모 판매자입니다. 구매 전 환불·교환 정책을 확인하세요.` });
  } else if (reviewCount != null && reviewCount <= 14) {
    out.push({ id: 'sw-lowreview-count', level: 'high', type: 'seller', message: `판매자 평가가 ${reviewCount}건으로 매우 적습니다. 신뢰도 확인이 어려우니 주의가 필요합니다.` });
  } else if (reviewCount != null && reviewCount <= 50) {
    out.push({ id: 'sw-lowreview-count', level: 'medium', type: 'seller', message: `판매자 평가가 ${reviewCount}건으로 다소 적습니다. 후기를 꼼꼼히 확인하세요.` });
  }
  if (rating != null && rating > 0 && rating < 4.0 && (reviewCount == null || reviewCount < 100)) {
    out.push({ id: 'sw-lowrating', level: 'medium', type: 'seller', message: `판매자/상품 평점이 ${rating.toFixed(1)}점으로 낮은 편입니다. 부정 후기를 확인하세요.` });
  }
  return out;
}

// ── 실시간 최저가 검색 (네이버쇼핑 검색 API) ────────────────────
// 사용자가 Naver Developers에서 발급한 client id/secret 필요. 미설정 시 configured:false 반환(폴백).
// ── 규격 파서: 용량·중량 × 수량 → 총량. "200ml × 24개", "1L x 3개", "500g 2팩", "24개입", "1.5L", "100개"
function parseSpec(text) {
  const t = String(text || '').replace(/,/g, '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const unitRe = /(\d+(?:\.\d+)?)\s*(ml|mL|ML|㎖|ℓ|l|L|리터|g|G|kg|KG|Kg|㎏)(?![a-zA-Z가-힣])/;
  const um = t.match(unitRe);
  let ml = null, g = null;
  if (um) {
    const v = parseFloat(um[1]); const u = um[2].toLowerCase();
    if (['ml', '㎖'].includes(u)) ml = v;
    else if (['l', 'ℓ', '리터'].includes(u)) ml = v * 1000;
    else if (u === 'g') g = v;
    else if (['kg', '㎏'].includes(u)) g = v * 1000;
  }
  // 수량: 단위 뒤의 "x 24개" 를 우선, 없으면 "24개입/24개/3팩"
  let count = null;
  const after = um ? t.slice(um.index + um[0].length) : t;
  const cm = after.match(/^\s*[x×X*]\s*(\d{1,4})\s*(?:개입|개|팩|입|병|캔|봉|포|매|정|박스|box|ea|EA)?/)
        || after.match(/^\s*(\d{1,4})\s*(?:개입|개|팩|입|병|캔|봉|포|매|정)(?![a-zA-Z가-힣0-9])/)
        || t.match(/(\d{1,4})\s*(?:개입|팩입)(?![a-zA-Z가-힣0-9])/)
        || t.match(/(?:^|[\s(])(\d{1,4})\s*(?:개|팩|병|캔|봉|포|매|정)(?![a-zA-Z가-힣0-9])/);
  if (cm) { const c = parseInt(cm[1], 10); if (c >= 1 && c <= 5000) count = c; }
  if (ml == null && g == null && count == null) return null;
  const qty = count || 1;
  return { ml, g, count, totalMl: ml != null ? ml * qty : null, totalG: g != null ? g * qty : null,
           label: [um ? um[0].replace(/\s+/g, '') : '', count ? `×${count}개` : ''].join('') };
}
// null = 판단 불가(어느 한쪽 규격 없음/종류 다름), true/false = 같은 규격인지
function specMatch(a, b) {
  if (!a || !b) return null;
  const near = (x, y) => Math.abs(x - y) / Math.max(x, y) <= 0.1;
  if (a.totalMl != null && b.totalMl != null) return near(a.totalMl, b.totalMl);
  if (a.totalG != null && b.totalG != null) return near(a.totalG, b.totalG);
  if ((a.totalMl != null) !== (b.totalMl != null) || (a.totalG != null) !== (b.totalG != null)) {
    // 한쪽만 용량이 있으면 수량으로라도 비교
    if (a.count != null && b.count != null) return a.count === b.count;
    return null;
  }
  if (a.count != null && b.count != null) return a.count === b.count;
  return null;
}

async function getNaverCreds() {
  try {
    const { naverClientId, naverClientSecret } = await chrome.storage.local.get(['naverClientId', 'naverClientSecret']);
    return { id: (naverClientId || '').trim(), secret: (naverClientSecret || '').trim() };
  } catch { return { id: '', secret: '' }; }
}

async function searchShoppingPrices(query, currentPrice, specText) {
  const q = String(query || '').trim();
  const cur = Number(currentPrice) || 0;
  const mySpec = parseSpec(specText || q);
  if (!q) return { configured: true, items: [] };
  const { id, secret } = await getNaverCreds();
  if (!id || !secret) return { configured: false, items: [] };

  // sort=asc(가격순)는 케이스·필름 같은 저가 액세서리가 1위로 올라와 '최저가'가 오염됨
  // → 관련도순(sim)으로 20개 받은 뒤 현재가 대비 타당성 필터를 거쳐 가격순 정렬
  const url = `https://openapi.naver.com/v1/search/shop.json?query=${encodeURIComponent(q)}&display=20&sort=sim`;
  const res = await fetch(url, {
    headers: { 'X-Naver-Client-Id': id, 'X-Naver-Client-Secret': secret },
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Naver ${res.status}: ${t.slice(0, 150)}`);
  }
  const data = await res.json();
  const items = (data.items || [])
    .map((it) => ({
      title: String(it.title || '').replace(/<\/?b>/g, '').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim(),
      price: Number(it.lprice) || 0,
      mall: it.mallName || '네이버쇼핑',
      link: it.link,
      image: it.image || '',
      productId: it.productId,
    }))
    .filter((x) => x.price > 0 && x.link)
    .filter((x) => !cur || (x.price >= cur * 0.3 && x.price <= cur * 1.5))
    // 규격(용량×수량)이 확인되는데 현재 상품과 다르면 제외 — 1L×3개를 200ml×24개와 비교하지 않는다
    .map((x) => { const sp = parseSpec(x.title); return { ...x, specText: sp ? sp.label : null, specMatch: specMatch(mySpec, sp) }; })
    .filter((x) => x.specMatch !== false)
    .sort((a, b) => a.price - b.price);
  return { configured: true, items };
}

// ── AI 실시간 웹검색으로 실제 판매 페이지 찾기 (구글 그라운딩) ──
async function findRealListings(productName, currentPrice, specText) {
  const name = String(productName || '').trim().slice(0, 120);
  const cur = Number(currentPrice) || 0;
  const mySpec = parseSpec(specText || name);
  const specLine = mySpec ? `\n규격: ${mySpec.label} — 용량·수량이 다른 구성(다른 팩 사이즈)은 제외한다.` : '';
  if (!name || name.length < 3) return { listings: [] };

  const prompt = `"${name}" 상품을 한국 온라인 쇼핑몰(네이버쇼핑/스마트스토어, 쿠팡, 11번가, G마켓, 옥션 등)에서 웹 검색으로 찾아라.${specLine}
실제로 확인된 '개별 상품 판매 페이지'만 수집한다. 품절·판매종료로 표시된 페이지는 제외한다. title에는 용량·수량(예: 200ml×24개)을 반드시 포함한다. 반드시 아래 JSON만 출력하고 다른 텍스트는 절대 쓰지 마라.

{"listings":[{"platform":"쇼핑몰 이름","title":"검색으로 확인한 상품명","price":원 단위 정수,"url":"실제 상품 페이지 URL"}]}

규칙:
1. 최대 5개. 검색 결과에서 실제 확인된 URL만 (검색결과 목록 페이지·메인 페이지 금지).
2. price는 검색 결과에서 확인된 판매가. 확인 안 되면 그 항목은 제외.
3. 동일 상품(같은 모델)만. 확실치 않으면 빈 배열 [].`;

  const data = await geminiRaw(
    prompt,
    { temperature: 0.1, maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 0 } },
    undefined,
    [{ google_search: {} }]
  );
  const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join(' ').trim();
  let listings = [];
  try {
    const m = text.match(/\{[\s\S]*\}/);
    const p = JSON.parse(m ? m[0] : text);
    if (Array.isArray(p.listings)) listings = p.listings;
  } catch (_) {}

  listings = listings
    .map(l => ({
      platform: String(l.platform || '').slice(0, 24) || '쇼핑몰',
      title: String(l.title || name).replace(/\s+/g, ' ').slice(0, 120),
      price: Math.round(Number(l.price)) || 0,
      url: String(l.url || ''),
    }))
    .filter(l => l.price >= 100 && /^https?:\/\//.test(l.url))
    // 타당성 필터: 현재가 대비 30%~150% 밖(액세서리·다른 모델·환각)은 최저가 후보에서 제외
    .filter(l => !cur || (l.price >= cur * 0.3 && l.price <= cur * 1.5))
    // 규격 필터: 제목에서 용량×수량이 읽히는데 현재 상품과 다르면 제외
    .map(l => { const sp = parseSpec(l.title); return { ...l, specText: sp ? sp.label : null, specMatch: specMatch(mySpec, sp) }; })
    .filter(l => l.specMatch !== false)
    .slice(0, 5);
  return { listings };
}

// ── AI 시세 부트스트랩: 웹검색으로 상품의 참고 최저가 찾기 ──────
// 이력이 없는 상품의 첫 방문 시 1회만 호출되고, 결과는 공유 DB(aiFloor)에 저장돼
// 이후 모든 사용자가 재검색 없이 공유한다.
async function findPriceFloor(productName, currentPrice, specText) {
  const name = String(productName || '').trim().slice(0, 120);
  const cur = Number(currentPrice) || 0;
  const mySpec = parseSpec(specText || name);
  const specLine = mySpec ? ` (규격 ${mySpec.label} — 같은 규격만)` : '';
  if (!name || name.length < 3) return {};

  const prompt = `"${name}"${specLine} 상품의 한국 온라인 최저가 정보를 웹에서 검색하라. 가격비교/추적 사이트(다나와, 에누리 등)나 쇼핑몰 검색 결과에서 확인된 '현재 최저 판매가'를 찾는다. 반드시 아래 JSON만 출력하고 다른 텍스트는 절대 쓰지 마라.

{"floorPrice": 원 단위 정수 또는 null, "source": "확인한 출처(사이트/쇼핑몰 이름)", "confidence": "high" 또는 "medium" 또는 "low"}

규칙: 검색 결과에서 실제 확인된 값만. 확인 불가하면 floorPrice는 null.`;

  // gemini-2.5-flash는 기본 thinking 토큰이 maxOutputTokens를 잠식해 본문이 비는 경우가 잦음
  // (callGeminiPrice와 동일하게 thinkingBudget 0 + 출력 상한 확보)
  const data = await geminiRaw(
    prompt,
    { temperature: 0.1, maxOutputTokens: 1024, thinkingConfig: { thinkingBudget: 0 } },
    undefined,
    [{ google_search: {} }]
  );
  const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join(' ').trim();
  try {
    const m = text.match(/\{[\s\S]*\}/);
    const p = JSON.parse(m ? m[0] : text);
    const fp = Math.round(Number(p.floorPrice));
    if (!isFinite(fp) || fp < 100) return {};
    // 타당성 검증: 현재가 대비 20%~150% 범위만 신뢰 (동일 상품이 아닐 가능성 배제).
    // 현재 페이지가 더 싼 경우(참고가 > 현재가)도 UI가 '참고가보다 저렴' 문구로 표시하므로 상한을 105%→150%로 완화
    if (cur > 0 && (fp > cur * 1.5 || fp < cur * 0.2)) return {};
    return {
      floorPrice: fp,
      source: String(p.source || 'AI 웹검색').slice(0, 80),
      confidence: ['high', 'medium', 'low'].includes(p.confidence) ? p.confidence : 'low',
    };
  } catch (_) { return {}; }
}

// ── AI 가격 정밀 추출 (DOM 파싱 보정용) ─────────────────────────
async function callGeminiPrice(priceText, productName) {
  const text = String(priceText || '').trim().slice(0, 1500);
  if (!text) return {};

  const prompt = `아래는 한 쇼핑몰 상품 페이지의 '가격 영역' 텍스트다. 화면에 표시된 실제 판매가와 할인 전 원래가(일반판매가/취소선 가격), 할인율을 추출하라. 반드시 아래 JSON만 출력하고 다른 텍스트는 절대 쓰지 마라.

상품명: ${productName || ''}
가격 영역:
"""${text}"""

JSON:
{ "currentPrice": 정수 또는 null, "originalPrice": 정수 또는 null, "discountRate": 정수 또는 null, "confidence": "high" 또는 "medium" 또는 "low" }

규칙:
1. 모든 숫자는 원 단위 정수(콤마·'원'·공백 제거).
2. currentPrice = 지금 실제 결제되는 판매가(예: 와우할인가/최종가). MSRP·정가·단위당가격이 아님.
3. originalPrice = 할인 전 '일반판매가'(취소선 가격). 없으면 null. 비정상적으로 부풀린 정가는 originalPrice로 쓰지 말 것.
4. discountRate = 화면에 표시된 할인율 정수. 없으면 currentPrice/originalPrice로 계산.
5. 쿠폰·적립·배송비 금액은 제외.
6. 확신 없으면 해당 값 null, confidence는 낮게.
7. 자릿수를 반드시 재확인하라 — 원문에 없는 0을 추가하지 말 것. 원문 텍스트에 문자 그대로 존재하는 숫자만 사용.
8. originalPrice가 currentPrice의 3배를 초과하면 확신이 없는 것이니 originalPrice는 null.`;

  const data = await geminiRaw(prompt, { temperature: 0, maxOutputTokens: 256, thinkingConfig: { thinkingBudget: 0 } });
  const out = (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
  try {
    const m = out.match(/\{[\s\S]*\}/);
    const p = JSON.parse(m ? m[0] : out);
    const num = (v) => { const n = Number(v); return isFinite(n) && n >= 100 ? Math.round(n) : null; };
    const rate = Number(p.discountRate);
    const cur = num(p.currentPrice);
    let org = num(p.originalPrice);
    // 자릿수 환각 가드: 원가가 판매가의 4배 초과면 신뢰하지 않음
    if (cur && org && org > cur * 4) org = null;
    // 반환값이 원문에 실제로 존재하는 숫자인지 검증 (콤마 유무 모두 확인)
    const inText = (n) => {
      if (!n) return false;
      const withComma = n.toLocaleString('ko-KR');
      return text.includes(withComma) || text.includes(String(n));
    };
    if (cur && !inText(cur)) return {};   // 판매가가 원문에 없으면 전체 기각
    if (org && !inText(org)) org = null;  // 원가가 원문에 없으면 원가만 기각
    return {
      currentPrice: cur,
      originalPrice: org,
      discountRate: isFinite(rate) && rate > 0 && rate < 100 ? Math.round(rate) : null,
      confidence: ['high', 'medium', 'low'].includes(p.confidence) ? p.confidence : 'low',
    };
  } catch {
    return {};
  }
}

// ── 리뷰 요약 + 가짜 리뷰 탐지 ──────────────────────────────────
async function callGeminiReviews(productName, reviewTexts) {
  const langName = await getLangName();
  const reviews = Array.isArray(reviewTexts)
    ? reviewTexts.map(r => String(r || '').trim()).filter(Boolean).slice(0, 15)
    : [];

  if (reviews.length === 0) {
    return {
      reviewSummary: '', fakeRiskScore: 0, fakeRiskLabel: '낮음',
      fakeSignals: [], topComplaints: [], sentiment: '정보 없음', empty: true,
    };
  }

  const reviewBlock = reviews.map((r, i) => `${i + 1}. ${r}`).join('\n');

  const prompt = `다음은 "${productName || '알 수 없는 상품'}" 상품의 실제 사용자 리뷰 ${reviews.length}건입니다. 이 리뷰들을 분석하세요. 반드시 아래 JSON 형식으로만 응답하고, JSON 외 다른 텍스트는 절대 출력하지 마세요.

리뷰 목록:
${reviewBlock}

응답 JSON:
{
  "reviewSummary": "리뷰 전반의 핵심 의견을 종합한 2-3문장 한국어 요약",
  "fakeRiskScore": 0부터 100 사이 정수 (가짜·조작 리뷰 의심 정도, 높을수록 의심),
  "fakeRiskLabel": "낮음 또는 보통 또는 높음",
  "fakeSignals": ["가짜 리뷰로 의심되는 구체적 신호 1", "신호 2"],
  "topComplaints": ["실제 구매자들의 주요 불만 1", "불만 2", "불만 3"],
  "sentiment": "긍정 또는 중립 또는 부정"
}

반드시 지켜야 할 규칙:
1. fakeRiskScore는 따옴표 없는 JSON 숫자형으로 작성
2. fakeRiskLabel은 fakeRiskScore와 일치: 0-33은 "낮음", 34-66은 "보통", 67-100은 "높음"
3. 가짜 신호 예: 지나치게 짧거나 과장된 칭찬, 동일 문구 반복, 상품과 무관한 내용, 비정상적으로 일관된 만점
4. fakeSignals와 topComplaints는 근거가 없으면 빈 배열 []로 두되 지어내지 말 것
5. reviewSummary·fakeSignals·topComplaints는 반드시 ${langName}로 작성
6. fakeRiskLabel은 반드시 "낮음"/"보통"/"높음" 중 하나로만 출력(번역·변경 금지)`;

  const data = await geminiRaw(prompt, { temperature: 0.3, maxOutputTokens: 1024, thinkingConfig: { thinkingBudget: 0 } });
  const text = (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();

  let parsed;
  try {
    const m = text.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(m ? m[0] : text);
  } catch {
    parsed = { reviewSummary: text.slice(0, 300), fakeRiskScore: 0, fakeRiskLabel: '낮음', fakeSignals: [], topComplaints: [], sentiment: '중립' };
  }

  const score = Math.max(0, Math.min(100, Number(parsed.fakeRiskScore) || 0));
  const label = score >= 67 ? '높음' : score >= 34 ? '보통' : '낮음';
  return {
    reviewSummary: typeof parsed.reviewSummary === 'string' ? parsed.reviewSummary : '',
    fakeRiskScore: score,
    fakeRiskLabel: ['낮음', '보통', '높음'].includes(parsed.fakeRiskLabel) ? parsed.fakeRiskLabel : label,
    fakeSignals: Array.isArray(parsed.fakeSignals) ? parsed.fakeSignals.filter(Boolean).slice(0, 5) : [],
    topComplaints: Array.isArray(parsed.topComplaints) ? parsed.topComplaints.filter(Boolean).slice(0, 5) : [],
    sentiment: typeof parsed.sentiment === 'string' ? parsed.sentiment : '중립',
  };
}
