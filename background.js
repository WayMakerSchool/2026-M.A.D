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

  // 오버레이 — manifest 의 content_scripts 에 선언된 쇼핑몰에서만 content script 가 존재한다.
  // 그 외 사이트에서는 수신자가 없어 조용히 무시된다(의도된 동작).
  chrome.tabs.sendMessage(tab.id, { type: 'toggleOverlay' }, () => void chrome.runtime.lastError);
});


// ── Gemini 호출 경로 ────────────────────────────────────────────
// 🔒 API 키는 이 번들에 절대 두지 않는다. 확장은 사용자 PC에 파일째 설치되므로
//    코드에 박은 키는 발급 즉시 공개된 키다. 서버가 키를 들고 대신 호출한다.
// 실제 순서(geminiRaw): ① 로컬 ShoMate 백엔드(server/main.py, 헬스체크 온라인일 때만)
//   → ② 사용자 본인 키(설정) → ③ Cloudflare Worker 프록시(GEMINI_PROXY_URL).
//   ③은 기본값으로 늘 있으므로 로컬 서버가 꺼져 있고 본인 키가 없어도 호출할 곳이 남는다.
//   코드에 박아둔 폴백 키는 존재하지 않는다.
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

// Cloudflare Worker 배포본 (소스는 proxy/worker.js — 배포는 Cloudflare 대시보드에 붙여넣어 한다. server/main.py 와 같은
// POST /gemini 계약: { prompt, generationConfig, model, tools? } → Gemini 원본 JSON). 키는 Worker 시크릿에만 있다.
// 백엔드 URL 이 아니라 프록시 자리에 두는 이유: Worker 에는 /billing 이 없어서, 백엔드로 쓰면 결제가 깨진다.
// (설정 저장소 'geminiProxyUrl' 로 덮어쓸 수 있다 — getProxyUrl)
const GEMINI_PROXY_URL = 'https://shomate-proxy.iseongjang74.workers.dev/gemini';
// 🔒 API 키는 이 번들에 절대 두지 않는다.
//    확장은 사용자 PC에 파일째 설치되고, 이 저장소는 공개돼 있다.
//    코드에 박은 키는 발급 즉시 공개된 키다.
//    "서버에서 키를 내려받는" 방식도 안 된다 — 받는 순간 네트워크 탭에 그대로 찍힌다.
//    반드시 서버가 키를 들고 대신 호출하는 '프록시' 구조여야 한다 (server/main.py).
//
// 호출 우선순위: 로컬 ShoMate 백엔드 → 사용자 본인 키(설정에서 입력) → Worker 프록시
// 코드에 박아둔 폴백 키는 존재하지 않는다.
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
// 화면·오류 문구에는 프록시 전체 URL 대신 호스트명만 쓴다 (짧고, 어디로 가는지는 충분히 보인다).
const hostOf = (u) => { try { return new URL(u).hostname; } catch (_) { return u; } };

// 설정 페이지(options.html)가 "지금 어느 경로로 AI를 부르는지" 보여줄 때 쓴다.
// 코드에 박아둔 폴백 키가 없어졌으므로, 사용자가 자기 상태를 직접 확인할 수 있어야 한다.
async function getAiStatus() {
  const backendUrl = await getBackendUrl();
  const backendOnline = backendUrl ? await isBackendOnline() : false;
  const hasUserKey = !!(await getUserApiKey());
  const proxyUrl = await getProxyUrl();
  const hasProxy = !!proxyUrl;
  const proxyHost = proxyUrl ? hostOf(proxyUrl) : '';   // 설정 화면 안내용
  const naver = await getNaverCreds();
  const hasNaver = !!(naver.id && naver.secret);
  const path = backendUrl && backendOnline ? 'backend'
    : hasUserKey ? 'userKey'
    : hasProxy ? 'proxy'
    : 'none';
  return { path, backendUrl, backendOnline, hasUserKey, hasProxy, proxyHost, hasNaver };
}

// 선택 언어 — AI가 이 언어로 응답하도록 프롬프트에 주입
const LANG_NAME = { ko: '한국어', en: 'English', zh: '중국어(간체)', ja: '일본어' };
async function getLangName() {
  try {
    const { lang } = await chrome.storage.local.get('lang');
    return LANG_NAME[lang] || '한국어';
  } catch { return '한국어'; }
}

// 우선순위: 로컬 FastAPI 백엔드(온라인 시) → 사용자 키 직접 → Cloudflare Worker 프록시. 폴백 키는 없다.
// 모델은 세 경로 모두 사용자가 고른 selectedModel 을 쓴다(백엔드는 라이선스 티어로 재검증).
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

  // fetch 가 TypeError('Failed to fetch') 로 끝나면 어느 경로에서 막혔는지 알 길이 없어
  // 화면에 "AI 분석 실패: Failed to fetch" 만 남는다. 경로를 붙여 다시 던진다.
  // 사이드바 채팅은 오류를 100자에서 자르므로 화면 문구는 100자 안으로, 모델·원인은 콘솔에 남긴다.
  // 그 외 에러(geminiDirect 의 'Gemini 404: ...', Abort 등)는 그대로 올린다.
  const isNetworkError = (e) => e instanceof TypeError && /Failed to fetch|NetworkError/.test(String(e?.message || ''));
  const connectError = (route, e) => {
    console.warn(`[ShoMate] AI 연결 실패 (경로: ${route}, 모델: ${model}):`, e?.message || e);
    return new Error(('AI 서버 연결 실패 (' + route + '). 네트워크·VPN·광고차단 확장을 확인하세요.').slice(0, 100));
  };
  const userKey = await getUserApiKey();
  if (userKey) {
    try {
      return tag(await geminiDirect(userKey, model, prompt, generationConfig, rawConfig, tools || null, signal), '본인 키');
    } catch (e) {
      if (isNetworkError(e)) throw connectError('본인 키', e);
      throw e;
    }
  }
  const proxyUrl = await getProxyUrl();
  if (proxyUrl) {
    const proxyHost = hostOf(proxyUrl);
    try {
      const res = await fetch(proxyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // 백엔드 분기와 같이 라이선스를 보낸다 — 빠지면 Worker 가 유료 사용자도 무료 모델로 내린다.
        body: JSON.stringify({ prompt, generationConfig, model, license: await getLicense(), ...extra }),
        signal,
      });
      if (!res.ok) {
        // Worker·server/main.py 는 실패 시 {"error": "..."} 를 돌려준다 → 그 문구가 원인을 가장 잘 말한다.
        // JSON 이 아니면(게이트웨이 HTML 등) 본문 앞 80자. 사이드바가 100자에서 자르므로 전체를 100자로 맞춘다.
        const body = await res.text().catch(() => '');
        let msg = '';
        try {
          const err = JSON.parse(body)?.error;
          if (err) msg = typeof err === 'string' ? err : (err.message || JSON.stringify(err));
        } catch (_) {}
        if (!msg) msg = body.replace(/\s+/g, ' ').trim().slice(0, 80) || res.statusText || '응답 본문 없음';
        throw new Error(('AI 프록시 오류 (' + res.status + '): ' + msg).slice(0, 100));
      }
      return tag(await res.json(), '프록시');
    } catch (e) {
      if (isNetworkError(e)) throw connectError('프록시 ' + proxyHost, e);
      throw e;
    }
  }
  // 여기까지 왔다면 쓸 수 있는 경로가 하나도 없다 (GEMINI_PROXY_URL 을 비운 빌드에서만 도달).
  // 코드에 키를 박아두는 폴백은 의도적으로 두지 않는다 (번들 = 공개 파일).
  // 사이드바 채팅이 오류를 100자에서 자르므로 90자 안으로 유지한다.
  throw new Error('AI에 연결할 수 없습니다. 확장 설정에서 본인 Gemini API 키를 입력하거나 ShoMate 서버를 켜세요.');
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

// 결제 기록에 남길 '아낀 돈'. 카테고리 순위 카드(meta.categoryRank)는 다른 상품이라 가격 차이를 절약으로 세지 않는다.
// (사이드바도 0 을 보내야 하지만 여기서 한 번 더 막는다 — 이중 방어)
function itemCheckoutSaved(meta) {
  const m = meta || {};
  if (m.categoryRank) return 0;
  return Math.max(0, Math.round(Number(m.savings) || 0));
}

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
    saved: itemCheckoutSaved(meta),
    categoryRank: !!(meta && meta.categoryRank),
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
    date: purchaseDateLabel(capturedAt), saved: pending.categoryRank ? 0 : (Number(pending.saved) || 0),
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
    // Q&A 가 "이 페이지에 무엇이 있고 없는지" 알고 답하도록 분석 입력을 남겨 둔다.
    // storage.session 은 storage 권한에 포함되고 브라우저를 닫으면 사라진다 —
    // 상품 페이지 텍스트를 디스크에 남기지 않으려는 의도. 없는 환경이면 조용히 건너뛴다.
    try {
      const { productName, currentPrice, detectedMall, rawText, soldOut, soldOutText } = message.data || {};
      const ctx = { productName, currentPrice, detectedMall, rawText: String(rawText || '').slice(0, 4000), soldOut, soldOutText, savedAt: Date.now() };
      Promise.resolve(chrome.storage.session.set({ lastAnalysisCtx: ctx })).catch(() => {});
    } catch (_) {}
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
      categoryRank: !!(message.categoryRank || (message.card && message.card.categoryRank)),
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
        hasUserKey: false, hasProxy: false, proxyHost: '', hasNaver: false,
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
    // 네이버 API 대신 쿠팡 검색 페이지 1회 수집. 현재가가 안 오면 geminiAnalyze 가 남긴
    // lastAnalysisCtx 의 현재가를 쓴다 — 없으면 0 으로 "모름" 처리된다.
    // mode:'category' 면 상품 종류 검색어로 검색한 결과에 3축 순위(rankCategoryForProduct), 아니면 같은 상품 최저가(recommendForProduct).
    const isCategory = message.mode === 'category';
    (async () => {
      let currentPrice = Number(message.currentPrice) || 0;
      if (!currentPrice) {
        try {
          const { lastAnalysisCtx: ctx } = await chrome.storage.session.get('lastAnalysisCtx');
          if (ctx && ctx.productName === message.query) currentPrice = Number(ctx.currentPrice) || 0;
        } catch (_) {}
      }
      if (isCategory) {
        return rankCategoryForProduct({
          productName: message.query, currentPrice,
          brand: message.brand, model: message.model, specText: message.specText,
          weights: message.weights, priority: message.priority,
          currentProductId: productIdFromUrl(message.sourceUrl),
        });
      }
      return recommendForProduct({
        productName: message.query, currentPrice,
        brand: message.brand, model: message.model, specText: message.specText,
      });
    })()
      .then(sendResponse)
      .catch(err => {
        if (!isCategory) { sendResponse({ configured: false, error: err.message || String(err) }); return; }
        console.warn('[ShoMate] 카테고리 순위 실패:', err?.message || err);
        sendResponse({ configured: false, mode: 'category', error: CAT_ERR_GENERIC });
      });
    return true;
  }
  if (message.type === 'openRankedSearch') {
    // 사용자 버튼으로만 — 쿠팡 검색 창을 보이는 탭으로 열고 그 탭을 순위 탭으로 기록한다
    openRankedSearch(message)
      .then(sendResponse)
      .catch(err => {
        console.warn('[ShoMate] 순위 탭 열기 실패:', err?.message || err);
        sendResponse({ ok: false, error: '쿠팡 검색 탭을 열지 못했어요. 잠시 뒤 다시 눌러 주세요.' });
      });
    return true;
  }
  if (message.type === 'rankTabStatus') {
    getRankTab(_sender?.tab?.id)
      .then(e => sendResponse(e
        ? { isRankTab: true, query: e.query || null, weights: e.weights || null, priority: e.priority || null, currentProductId: e.currentProductId || null }
        : { isRankTab: false, query: null, weights: null, priority: null, currentProductId: null }))
      .catch(() => sendResponse({ isRankTab: false, query: null, weights: null, priority: null, currentProductId: null }));
    return true;
  }
  if (message.type === 'rankSearchItems') {
    rankSearchItemsForTab(message, _sender)
      .then(sendResponse)
      .catch(err => {
        console.warn('[ShoMate] 검색 페이지 순위 계산 실패:', err?.message || err);
        sendResponse({ ok: false, error: '순위를 매기는 중 문제가 생겼어요. 페이지를 새로고침해 주세요.' });
      });
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
// 가격은 내려보내지 않는다. 베타에서 "네이버쇼핑 약 1,650,000원" 같은 추정가가 실제로는 존재하지 않는
// 값이었고, 그 카드가 가디언 1위까지 받아 신뢰를 깼다. 사이드바는 sameProductAlts/alternativeProducts 를
// 가격 없는 '가격 확인하기' 검색 링크 카드로만 만들고 점수·정렬에서 뺀다 — 캐시에 남은 옛 응답의
// estimatedPrice 도 읽지 않는다 (tests/sidebar-price.test.js).
// 실제 가격은 네이버 검색 API(searchShoppingPrices)와 AI 실검색(findRealListings)에서만 온다.
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
    {"platform": "네이버쇼핑", "reason": "최저가 검색", "searchQuery": "정확한 상품명"},
    {"platform": "쿠팡", "reason": "로켓배송 가능", "searchQuery": "정확한 상품명"},
    {"platform": "11번가", "reason": "포인트 적립", "searchQuery": "정확한 상품명"}
  ],
  "alternativeProducts": [
    {"productName": "다른 브랜드 경쟁 상품명 1", "platform": "네이버쇼핑", "reason": "가성비 대안", "searchQuery": "검색어"},
    {"productName": "다른 브랜드 경쟁 상품명 2", "platform": "쿠팡", "reason": "인기 대안", "searchQuery": "검색어"},
    {"productName": "다른 브랜드 경쟁 상품명 3", "platform": "11번가", "reason": "고성능 대안", "searchQuery": "검색어"}
  ]
}

반드시 지켜야 할 규칙 (위반 시 사용 불가):
1. 가격을 추정하거나 지어내지 마라. 가격 필드는 어떤 이름으로도 출력하지 않는다.
2. alternativeProducts는 현재 상품과 완전히 다른 브랜드·모델의 실제 경쟁 상품이어야 함 (같은 상품명 변형 금지)
   예: 나이키 티셔츠 → 아디다스 티셔츠, 언더아머 티셔츠, 뉴발란스 티셔츠
   예: 갤럭시 버즈 → 소니 WF-C700N, 에어팟 프로, 보스 QuietComfort Earbuds
3. 모든 숫자는 JSON 숫자형(따옴표 없이)으로 작성
4. searchQuery는 해당 플랫폼에서 실제로 검색할 구체적인 상품명`;

  const data = await geminiRaw(prompt, { temperature: 0.4, maxOutputTokens: 1024, thinkingConfig: { thinkingBudget: 0 } });
  console.log('[ShoMate] Gemini 성공:', data.candidates?.[0]?.content?.parts?.[0]?.text?.slice(0, 100));
  const text = (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();

  try {
    const m = text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(m ? m[0] : text);
    // 프롬프트로 금지해도 모델이 가격 키를 내보낼 수 있다. 두 배열의 항목에서 이름이 price 로
    // 끝나는 키(estimated 접두어 포함)를 전부 지운다 — 추정가가 사이드바 카드로 새지 않게.
    for (const key of ['sameProductAlts', 'alternativeProducts']) {
      if (!Array.isArray(parsed?.[key])) continue;
      for (const it of parsed[key]) {
        if (!it || typeof it !== 'object') continue;
        for (const k of Object.keys(it)) if (/price$/i.test(k)) delete it[k];
      }
    }
    return parsed;
  } catch {
    return { aiSummary: text.slice(0, 300), aiPros: [], aiCons: [], priceAssessment: '적당', recommendation: '' };
  }
}

// ── AI Q&A 채팅 ────────────────────────────────────────────────

// 분석 때 저장한 페이지 맥락. 상품명이 같거나(공백·대소문자 무시, 앞 30자) 30분 이내 것이면 쓴다 —
// 사이드바가 상품명을 조금 다르게 넘겨도 방금 분석한 페이지라면 같은 맥락으로 본다.
const ANALYSIS_CTX_TTL_MS = 30 * 60 * 1000;
async function getAnalysisCtx(productName) {
  try {
    const { lastAnalysisCtx: ctx } = await chrome.storage.session.get('lastAnalysisCtx');
    if (!ctx || typeof ctx !== 'object') return null;
    const norm = (v) => String(v || '').replace(/\s+/g, '').toLowerCase().slice(0, 30);
    const sameName = !!productName && !!ctx.productName && norm(productName) === norm(ctx.productName);
    const fresh = Date.now() - Number(ctx.savedAt || 0) < ANALYSIS_CTX_TTL_MS;
    return sameName || fresh ? ctx : null;
  } catch { return null; }
}

// Q&A 프롬프트에 넣을 "페이지에서 관측된 사실" 블록. 규칙 판정과 리뷰 수 추출은 URL 분석과
// 같은 함수를 써서, 사이드바 경고와 AI 답이 서로 다른 말을 하지 않게 한다.
// "없는 표시" 에 올리는 유형 — 사용자가 없는 것을 물었을 때 AI 가 "없다" 고 단언할 근거.
const DP_ABSENCE_LABELS = [
  ['dp-social-live', '실시간 활동 표시'], ['dp-urgency', '카운트다운'], ['dp-stock', '재고 임박'],
  ['dp-subscription', '자동결제'], ['dp-confirmshaming', '확인 쉐이밍'], ['dp-roachmotel', '취소 방해'],
];
function buildChatContextBlock(ctx) {
  const text = String(ctx.rawText || '');
  const { reviewCount, rating } = extractReviewSignals(text);
  const found = buildDarkPatternWarningsFromHtml(text, reviewCount);
  const foundIds = new Set(found.map(w => w.id));
  const fmt = (n) => Number(n).toLocaleString('ko-KR');
  const lines = [
    '[페이지에서 관측된 사실 — 이 범위 안에서만 답하라]',
    `상품: ${ctx.productName || '미확인'}, 쇼핑몰: ${ctx.detectedMall || '미확인'}, 표시 가격: ${ctx.currentPrice ? fmt(ctx.currentPrice) + '원' : '미확인'}, ` +
      `리뷰: ${reviewCount != null ? fmt(reviewCount) + '건' : '미확인'}, 평점: ${rating != null ? rating.toFixed(1) : '미확인'}, 품절: ${ctx.soldOut ? '예' : '아니오'}`,
    '발견된 표시:',
    ...(found.length ? found.map(w => `- [${w.fairType}] ${w.evidence} — ${w.message}`) : ['- 없음']),
  ];
  // 리뷰 수와 맞는 판매 집계는 경고 목록에서 빠진다. 그래도 AI 가 "다크패턴 아님" 을 숫자로 말할 수 있게 따로 적는다.
  const salesRule = BG_DARK_PATTERN_RULES.find(r => r.id === 'dp-social-sales');
  const sm = salesRule ? htmlToText(text).match(salesRule.re) : null;
  if (sm && !foundIds.has('dp-social-sales')) {
    const a = assessSalesClaim(sm[0], reviewCount);
    if (a.verdict === 'corroborated') {
      lines.push(`판매 집계: “${fmt(a.n)}명 구매” 표시 — 리뷰 ${fmt(reviewCount)}건 대비 통상 범위(리뷰 1건당 구매 ${SALES_PER_REVIEW_MAX}건 이내)라 플랫폼 공식 집계로 봄`);
    }
  }
  const absent = DP_ABSENCE_LABELS.filter(([id]) => !foundIds.has(id)).map(([, label]) => label);
  lines.push(`없는 표시: ${absent.length ? absent.join('·') : '없음'}`);
  return lines.join('\n');
}

async function callGeminiChat(productName, question) {
  const today = new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' });
  const langName = await getLangName();
  // 맥락이 없으면(분석 전·세션 만료) 기존 프롬프트 그대로 — 블록과 추가 규칙 둘 다 빈 문자열
  const ctx = await getAnalysisCtx(productName);
  const ctxBlock = ctx ? `\n${buildChatContextBlock(ctx)}\n` : '';
  const ctxRules = ctx ? `
- 사용자가 페이지에 없는 표시에 대해 물으면 "이 페이지에는 그 표시가 없다"고 분명히 말하고, 대신 실제로 있는 표시를 알려줘라.
- 플랫폼 공식 집계(예: 쿠팡 "한 달간 N명 구매", 네이버 "구매 N건")는 리뷰 수와 비교해 판단하고, 비교 숫자를 답에 포함하라. 리뷰 수 대비 통상 범위(리뷰 1건당 구매 ${SALES_PER_REVIEW_MAX}건 이내)면 다크패턴이 아니라고 말하라.
- 추측을 사실처럼 말하지 마라.` : '';
  const prompt = `당신은 쇼핑 전문가 AI 어시스턴트입니다. 오늘 날짜는 ${today}입니다. 최신 출시 제품들(아이폰 17 시리즈, 갤럭시 S25 시리즈 등 2025년 이후 제품 포함)을 알고 있습니다.

분석 중인 상품: "${productName || '알 수 없는 상품'}"
사용자 질문: "${question}"
${ctxBlock}
답변 규칙:
- 핵심만 간결하게, 3~5문장 이내로 답변하세요.
- 표(table)는 절대 사용하지 마세요.
- 마크다운 헤더(#, ##)는 사용하지 마세요.
- 불릿(•, -)은 꼭 필요할 때만 최대 3개까지만 사용하세요.
- 반드시 ${langName}로 자연스럽게 대화하듯 답변하세요.
- 모르는 정보는 모른다고 짧게 말하세요.${ctxRules}`;

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

  // 최저가 날조 금지: 여기서는 시세를 채우지 않는다(null = 비교 불가로 표시). 네이버 쇼핑 검색 API 는 2026-07-31 종료됐고,
  // 대체 경로(recommendForProduct)는 브라우저 탭을 여는 작업이라 사용자가 사이드바에서 "후보 찾기"를 눌렀을 때만 돈다.
  const mktLow = null;
  const naverAlts = [];

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
// 판매 집계 표시가 리뷰 수와 맞는지 본다. 리뷰 작성률은 통상 구매의 5~20% 이므로
// 리뷰 1건당 구매 20건까지는 정상 범위로 본다. 그 범위면 플랫폼 공식 집계로 보고 경고하지 않는다.
// content-script.js 에 같은 함수가 있지만 워커에는 DOM 이 없어 content-script 를 import 할 수 없다 —
// 여기 따로 정의한다. 이름·시그니처는 양쪽이 같아야 한다 (테스트가 소스에서 잘라내 쓴다).
const SALES_PER_REVIEW_MAX = 20;
const assessSalesClaim = (evidence, reviewCount) => {
  const m = String(evidence || '').replace(/,/g, '').match(/([0-9]+)\s*명/);
  const n = m ? Number(m[1]) : null;
  if (n == null) return { n: null, verdict: 'unknown' };
  if (reviewCount == null || !(reviewCount >= 0)) return { n, verdict: 'unverifiable' };
  if (reviewCount === 0) return { n, verdict: n > 50 ? 'suspicious' : 'unverifiable' };
  return { n, verdict: n <= reviewCount * SALES_PER_REVIEW_MAX ? 'corroborated' : 'suspicious' };
};

// 규칙 본문은 content-script.js 의 DARK_PATTERN_RULES 와 동일하게 유지해야 한다. 한쪽만 고치면
// 페이지에서는 잡히는데 URL 분석에서는 안 잡히는 불일치가 생긴다.
// '실시간 활동 표시'(검증 불가, 조급함 유도)와 '판매 집계 표시'(리뷰 수와 교차검증 가능)는 별개 규칙이다 —
// 쿠팡 "한 달간 8,000명 이상 구매했어요"(리뷰 11,394건) 같은 공식 집계를 압박형으로 오탐했던 베타 피드백 때문.
const BG_DARK_PATTERN_RULES = [
  { id: 'dp-urgency', re: /(남은\s*시간|마감\s*임박|판매\s*종료\s*임박|곧\s*(마감|종료|품절)|오늘\s*(자정|24시)?\s*마감|지금\s*안\s*사면|[0-9]{1,2}\s*분\s*[0-9]{2}\s*초)/,
    fairType: '시간제한 알림 (압박형)', law: false,
    message: '시간 압박 표시(카운트다운·마감 임박)가 있어요. 실제 마감인지는 알 수 없으니 서두르지 마세요.' },
  { id: 'dp-social-live',
    re: /(지금|현재|실시간)?\s*([0-9][0-9,]*)\s*명(이)?[^.\n]{0,12}?(보고\s*있|보는\s*중|담았|장바구니에\s*담|구매\s*중)/,
    fairType: '다른 소비자의 활동 알림 (압박형)', law: false,
    message: '“지금 N명이 보고 있어요” 같은 실시간 활동 표시가 있어요. 이 숫자는 검증할 수 없고, 조급함을 유도하는 데 쓰이기도 해요.' },
  // "N명이 구매 중" 은 실시간 활동(dp-social-live)이라 여기서 빼야 두 규칙이 겹치지 않는다 — 겹치면 집계를 리뷰 수로 걸러도 경고가 남는다.
  { id: 'dp-social-sales',
    re: /([0-9][0-9,]*)\s*명(이)?\s*(이상\s*)?[^.\n]{0,12}?(구매(?!\s*중)|구입|주문|참여|신청)/,
    fairType: '다른 소비자의 활동 알림 (압박형)', law: false,
    message: '“N명 구매” 표시가 있어요. 리뷰 수와 비교해 과장인지 확인하세요.' },
  { id: 'dp-stock', re: /((품절|재고)\s*임박|단\s*[0-9]+\s*개?\s*남|마지막\s*[0-9]+\s*개|[0-9]+\s*개?\s*(밖에\s*)?남았)/,
    fairType: '낮은 재고 알림 (압박형)', law: false,
    message: '재고 압박 표시(“품절 임박/N개 남음”)가 있어요. 인위적으로 만들 수 있는 표시이니 조급해하지 마세요.' },
  { id: 'dp-subscription', re: /(무료\s*체험|첫\s*달\s*무료|무료\s*이용)[\s\S]{0,50}(자동\s*(결제|연장|갱신)|정기\s*결제|매월|구독)|자동\s*결제\s*동의/,
    fairType: '숨은 갱신 (편취형)', law: false,
    message: '무료 안내 근처에 자동결제·정기구독 조건이 있어요. 결제 전 “자동 결제/정기결제” 항목을 꼭 확인하세요.' },
  { id: 'dp-confirmshaming', re: /(괜찮아요[,\s]*(손해|할인|혜택|비싸게)|아니요[,\s]*(비싸게|손해|정가로)|혜택을?\s*포기|할인\s*받지\s*않을|나중에\s*후회)/,
    fairType: '감정적 언어 사용 (압박형)', law: false,
    message: '거절 선택지에 죄책감을 심는 문구(확인 쉐이밍)예요. 문구가 아니라 필요 여부로 판단하세요.' },
  { id: 'dp-roachmotel', re: /(해지|탈퇴|구독\s*취소)[^.\n]{0,14}?(고객센터|상담원|전화|유선|방문)[^.\n]{0,8}?(에서만|으로만|로만|만)\s*(가능|신청|접수)/,
    fairType: '취소·탈퇴 방해 (방해형)', law: true,
    message: '가입은 클릭 한 번인데 해지는 전화·상담만 허용하는 구조예요(취소 방해). 가입 전 해지 방법을 확인하세요.' },
];

// HTML → 공백 정규화된 본문 텍스트. 이미 평문(rawText)이 와도 그대로 통과한다.
const htmlToText = (html) => String(html || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');

// 다크패턴 감지 (HTML 텍스트 기반). reviewCount 는 판매 집계 표시(dp-social-sales)를 교차검증하는 데 쓴다.
// 사이드바가 읽는 level/type 과, content-script 판정과 같은 evidenceLevel/method/fairType/law/evidence 를 함께 담는다.
function buildDarkPatternWarningsFromHtml(html, reviewCount) {
  const text = htmlToText(html);
  const out = [];
  for (const r of BG_DARK_PATTERN_RULES) {
    let m = null;
    try { m = text.match(r.re); } catch (_) { continue; }
    if (!m) continue;
    const evidence = m[0].trim().slice(0, 90);
    const item = {
      id: r.id, level: 'high', type: 'darkpattern', evidenceLevel: 1, method: 'rule-text',
      fairType: r.fairType, law: r.law, evidence, message: r.message,
    };
    if (r.id === 'dp-social-sales') {
      const a = assessSalesClaim(evidence, reviewCount);
      if (a.verdict === 'corroborated') continue;   // 리뷰 수와 맞는 집계 — 플랫폼 공식 집계로 보고 경고하지 않는다
      const nStr = a.n != null ? a.n.toLocaleString('ko-KR') + '명' : 'N명';
      item.message = a.verdict === 'suspicious'
        ? `“${nStr} 구매” 표시가 리뷰 ${Number(reviewCount).toLocaleString('ko-KR')}건에 비해 지나치게 커요. 과장된 집계일 수 있어요.`
        : `“${nStr} 구매” 표시가 있어요. 리뷰 수를 찾지 못해 검증할 수 없었어요.`;
      item.corroboration = { n: a.n, reviewCount: reviewCount ?? null, verdict: a.verdict };
    }
    out.push(item);
  }
  return out;
}

// content-script.js 의 parseReviewCountText 와 본문이 같아야 한다 — 워커에는 DOM 이 없어 import 할 수 없다.
// 리뷰 수 텍스트 파서 — 숫자가 키워드 앞("11,394 개 상품평", 쿠팡)이든 뒤("리뷰 1,024", "상품평(11,394)")든 읽는다.
// 소수("4.5")는 평점이므로 리뷰 수로 쓰지 않는다. 판매 집계 교차검증의 기준값이라, 틀리면 공식 집계를 과장으로 오판한다.
const parseReviewCountText = (raw) => {
  const t = String(raw || '');
  const NUM = '([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{1,7})';
  const before = t.match(new RegExp('(?<![0-9.,])' + NUM + '\\s*(?:개|건)?\\s*(?:상품평|구매평|리뷰|후기)'));
  if (before) return Number(before[1].replace(/,/g, ''));
  const after = t.match(new RegExp('(?:상품평|구매평|리뷰|후기|평가)\\s*[(\\[]?\\s*' + NUM + '(?![0-9.])'));
  if (after) return Number(after[1].replace(/,/g, ''));
  return null;
};

// 리뷰 수·평점 추출 — 판매자 경고와 Q&A 페이지 맥락 두 곳이 같은 규칙을 쓴다 (한쪽만 바꾸지 말 것)
// 리뷰 수는 위 parseReviewCountText 에 맡긴다 — 예전 "키워드 뒤 숫자" 정규식은 쿠팡 "11,394 개 상품평"을 놓치고
// "리뷰 4.5" 를 4건으로 읽어, 판매 집계 교차검증에서 공식 집계를 과장으로 오판했다.
// 평점도 소수 뒤에 숫자·점이 이어지면(가격·버전 등) 버린다 — content-script 의 평점 정규식과 같은 형태.
function extractReviewSignals(text) {
  const t = String(text || '');
  const reviewCount = parseReviewCountText(t);
  let rating = null;
  const rm = t.match(/(?:평점|별점|평균\s*별점)\D{0,4}([0-5](?:\.[0-9])?)(?![\d.])/);
  if (rm) rating = Number(rm[1]);
  return { reviewCount, rating };
}

function buildSellerWarningsFromHtml(html) {
  const text = String(html || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
  const lrw = text.match(/([0-9]{1,4})\s*건\s*이하의\s*평가/);
  // 리뷰 수를 먼저 구하고 다크패턴을 부른다 — 판매 집계 표시를 리뷰 수로 교차검증해야 하므로
  const { reviewCount, rating } = extractReviewSignals(text);
  const out = buildDarkPatternWarningsFromHtml(html, reviewCount);
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

// ── 상품 추천 (A안: 쿠팡 검색 페이지 1회 수집) ──────────────────
// 공식 검색 API 는 전부 쓸 수 없다(네이버 쇼핑 검색 API 2026-07-31 종료, 쿠팡은 없음, 11번가는 사업자 전용).
// 그래서 사용자가 사이드바에서 "후보 찾기"를 눌렀을 때만 쿠팡 검색 결과 페이지를 백그라운드 탭으로 1회 열고,
// 그 탭의 content script(collectSearchResults) 가 JSON-LD/DOM 에서 읽은 후보를 받아
// 여기서 필터 → 점수 → 상세 URL 검증 → Top3 → 카드를 만든다. 사이드바는 기존 searchPrices 응답 경로로 받는다.
// 원칙: 모르는 값은 모른다고 표시한다(dataInsufficient·shippingUnknown). 지어낸 숫자는 내보내지 않는다.
// 검색·카테고리 URL 은 절대 카드 링크로 내보내지 않는다(validateDetailUrl). 베타의 "최저가라 써 놓고
// 검색 결과 페이지를 여는" 카드가 바로 이 원칙을 깼다.
const REC_WEIGHTS_DEFAULT = { price: 0.4, quality: 0.3, safety: 0.3 };
const BAYES_M = 50;                      // 베이지안 평균 가중 리뷰 수 — 리뷰 50개 미만이면 전체 평균 쪽으로 끌린다
const ACCESSORY_PRICE_RATIO = 0.3;       // 중앙값의 30% 미만이면 액세서리 의심 (본품 검색에 케이스·필름이 섞여 온다)
const REC_CACHE_TTL_MS = 6 * 60 * 60 * 1000;  // 같은 검색어는 6시간 동안 탭을 다시 열지 않는다
const REC_CACHE_MAX = 30;
const REC_TAB_TIMEOUT_MS = 15000;
const REC_COLLECT_RETRIES = 8;           // content script 가 준비되기 전엔 "수신자 없음" 오류 → 700ms 간격 재시도
const REC_COLLECT_RETRY_MS = 700;
const ACCESSORY_WORDS = ['케이스', '이어팁', '케이블', '충전기', '필름', '거치대', '파우치', '스트랩', '커버', '보호', '교체용', '호환', '어댑터', '젠더', '마운트'];
// 광고·배송·수량·옵션 문구. 검색어에 섞이면 쿠팡이 엉뚱한 결과(배송 프로모션 상품)를 돌려준다.
const NOISE_WORDS = ['무료배송', '당일발송', '당일출발', '오늘출발', '오늘발송', '빠른배송', '로켓배송', '정품', '공식', '인증', '행사', '특가', '할인', '세일', '사은품', '증정', '한정', '신상', '신제품', '베스트', '인기', '추천', '국내', '해외', '직구', '정식수입', 'AS보장', '1+1', '2+1', '묶음', '세트', '구성'];
// 수량 패턴만 제거한다. 용량·규격(500ml, 256GB, 27인치, 5.3)은 핵심일 수 있어 남긴다.
// JS 의 \b 는 ASCII 단어 경계라 한글 접미사('개','팩') 뒤에서는 동작하지 않는다 → parseSpec 과 같은 부정 전방탐색을 쓴다.
const NOISE_PATTERNS = [
  /\d+\s*\+\s*\d+/g,                                                               // 1+1, 2+1
  /\d+\s*(?:개입|개|팩|세트|박스|매|족|켤레|병|캔|p|P|ea|EA)(?![a-zA-Z가-힣0-9])/g,  // 24개, 3팩, 2P
  /\d+%/g,                                                                         // 30%
];
const COLOR_WORDS = ['화이트', '블랙', '실버', '골드', '네이비', '레드', '블루', '그린', '핑크', '그레이', '베이지', '브라운', '퍼플', '옐로우', '오렌지', '민트', '아이보리', '카키', '와인', '로즈골드', '스페이스그레이', '미드나이트', '스타라이트', '차콜', '흰색', '검정', '검은색', '은색', '회색'];
const MALL_WORDS = ['네이버쇼핑', '스마트스토어', '쿠팡', '11번가', '네이버', 'G마켓', '옥션', 'SSG', '롯데온', '인터파크', '티몬'];
// 줄임말·붙여쓰기 → 쿠팡 검색이 더 잘 받는 표기. 값이 키로 시작하면(노이즈캔슬→노이즈캔슬링) 이미 바뀐 단어를 또 바꾸지 않게 applySynonyms 가 막는다.
const SYNONYMS = {
  '노캔': '노이즈캔슬링',
  '노이즈캔슬': '노이즈캔슬링',
  '노이즈 캔슬링': '노이즈캔슬링',
  '블투': '블루투스',
  '무선이어폰': '무선 이어폰',
  '전기 포트': '전기포트',
  '에어팟프로': '에어팟 프로',
  '갤럭시버즈': '갤럭시 버즈',
  '맥북에어': '맥북 에어',
  '맥북프로': '맥북 프로',
};
const REC_MODEL_RE = /[A-Z]{1,5}-?\d{2,5}[A-Z]?/;   // 번들과 같은 의미의 모델 토큰 (예: WH-1000XM5 의 'XM5' 는 못 잡는다 — 한계)
const REC_SEARCH_PAGE_RE = /\/search|query=|q=|keyword=|kwd=|category|\/np\/search|\/catalog\/|\/np\/categories|search\/all/i;

// URL 별 진행 중 수집. 같은 URL 이면 같은 Promise 를 돌려주고, 다른 URL(같은 상품 검색 vs 카테고리 검색)은 따로 연다.
// (예전엔 전역 1개라 검색어가 다른 요청이 앞 요청의 결과를 그대로 받았다)
const _recInFlight = new Map();

const recEscapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const recClamp = (n, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, Number(n) || 0));
const recSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const recHostIs = (host, domain) => host === domain || host.endsWith('.' + domain);
function recMedian(nums) {
  const a = nums.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return 0;
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}
function applySynonyms(text) {
  let s = String(text || '');
  for (const [from, to] of Object.entries(SYNONYMS)) {
    // '노이즈캔슬' → '노이즈캔슬링' 을 '노이즈캔슬링' 에 또 적용하면 '노이즈캔슬링링' 이 된다 → 이미 완성된 꼴은 건너뛴다
    const guard = to.startsWith(from) && to.length > from.length ? '(?!' + recEscapeRe(to.slice(from.length)) + ')' : '';
    s = s.replace(new RegExp(recEscapeRe(from) + guard, 'gi'), to);
  }
  return s;
}
// 토큰 양끝의 장식 문자(★!~ 등) 제거
const recStripDeco = (t) => t.replace(/^[\s!?~★☆♥♡■□▶◀●○◆◇※·,.:;'"`‘’“”#]+|[\s!?~★☆♥♡■□▶◀●○◆◇※·,.:;'"`‘’“”#]+$/g, '');

// 제목 정리(buildSearchQuery·buildCategoryQuery 공통): 괄호 블록·몰 꼬리·몰 이름·수량 패턴을 지우고 동의어를 맞춘다.
function recCleanTitle(name) {
  let s = String(name || '');
  // 괄호 블록([..] (..) 【..】 ｛..｝) — 대부분 광고·옵션 안내
  s = s.replace(/\[[^\]]*\]|\([^)]*\)|【[^】]*】|｛[^｝]*｝/g, ' ');
  // ' - 카테고리 | 몰' 과 ' | 몰' 꼬리 (쿠팡 제목: '상품명 - 휴대폰 | 쿠팡'). 카테고리 조각은 숫자 없는 짧은 것만 뗀다
  s = s.replace(/\s+-\s+[^|\-\d]{1,20}\s*\|\s*[^|]*$/, '');
  s = s.replace(/\s*\|\s*[^|]*$/, '');
  s = applySynonyms(s);
  for (const w of MALL_WORDS) s = s.replace(new RegExp(recEscapeRe(w), 'gi'), ' ');
  for (const re of NOISE_PATTERNS) s = s.replace(re, ' ');
  return s;
}

// 1단계: 상품 페이지 제목 → 쿼리·핵심 토큰. 광고·수량·색상·옵션·판매처 문구를 벗겨 "무엇을 찾는지"만 남긴다.
function buildSearchQuery(info) {
  const src = info && typeof info === 'object' ? info : { productName: String(info || '') };
  const s = recCleanTitle(src.productName);

  const brand = String(src.brand || '').trim() || null;
  let model = String(src.model || '').trim() || null;
  if (!model) { const m = s.match(REC_MODEL_RE); if (m) model = m[0]; }

  const noise = new Set(NOISE_WORDS.map((w) => w.toLowerCase()));
  const colors = new Set(COLOR_WORDS.map((w) => w.toLowerCase()));
  const core = [];
  for (const raw of s.split(/\s+/)) {
    let t = recStripDeco(raw);
    if (!t) continue;
    // '화이트/블랙', '256GB,512GB' 같은 옵션 나열은 첫 항목만. '1,000' 같은 천 단위 구분은 그대로
    if (/[\/,]/.test(t) && !/^\d{1,3}(,\d{3})+/.test(t)) t = recStripDeco(t.split(/[\/,]/)[0]);
    if (!t) continue;
    const low = t.toLowerCase();
    if (noise.has(low)) continue;
    if (colors.has(low) || colors.has(low.replace(/색$/, ''))) continue;
    if (core.some((c) => c.toLowerCase() === low)) continue;
    core.push(t);
  }
  // query = [brand, model, 핵심 토큰...]. 브랜드·모델이 이미 핵심 토큰에 있으면 중복시키지 않는다
  const head = [brand, model].filter(Boolean);
  const headLow = head.map((h) => h.toLowerCase());
  const rest = core.filter((t) => !headLow.includes(t.toLowerCase()));
  let parts = [...head, ...rest].slice(0, 6);
  while (parts.length > 1 && parts.join(' ').length > 60) parts.pop();
  let query = parts.join(' ');
  if (query.length > 60) query = query.slice(0, 60).trim();
  const tokens = [];
  for (const t of [...head, ...core]) { const low = t.toLowerCase(); if (!tokens.includes(low)) tokens.push(low); }
  return { query, tokens, brand, model };
}

// 소문자·공백 분리·노이즈 제거. 괄호·구분 기호는 공백으로.
function tokenizeForMatch(text) {
  let s = applySynonyms(String(text || '').toLowerCase());
  s = s.replace(/[\[\]()【】｛｝|,\/:;"'`]/g, ' ');
  const noise = new Set(NOISE_WORDS.map((w) => w.toLowerCase()));
  const out = [];
  for (const raw of s.split(/\s+/)) {
    const t = recStripDeco(raw);
    if (!t || noise.has(t)) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

// 상품명과 핵심 토큰 일치율 ≥ 0.5 (토큰 1~2개면 전부 일치). 한글은 붙여쓰기가 흔해('블루투스이어폰') 부분 문자열도 일치로 친다.
function isRelevantCandidate(cand, tokens) {
  const toks = Array.isArray(tokens) ? tokens.map((t) => String(t).toLowerCase()).filter(Boolean) : [];
  if (!toks.length) return true;   // 비교할 기준이 없으면 판단 불가 → 거르지 않는다
  const name = String(cand?.name || '');
  const ct = tokenizeForMatch(name);
  const nameLow = name.toLowerCase();
  const hit = toks.filter((t) => ct.includes(t) || (t.length >= 2 && nameLow.includes(t))).length;
  if (toks.length <= 2) return hit === toks.length;
  return hit / toks.length >= 0.5;
}

// 품절 → 관련성 → 액세서리(단어·가격) 순으로 거른다. dropped 는 사이드바가 "왜 후보가 적은지" 설명할 때 쓴다.
function filterCandidates(cands, tokens) {
  const dropped = { irrelevant: 0, accessory: 0, soldOut: 0 };
  const toks = Array.isArray(tokens) ? tokens.map((t) => String(t).toLowerCase()) : [];
  const relevant = [];
  for (const c of Array.isArray(cands) ? cands : []) {
    if (!c || !c.name || !(Number(c.price) > 0)) continue;
    if (c.soldOut) { dropped.soldOut++; continue; }
    if (!isRelevantCandidate(c, toks)) { dropped.irrelevant++; continue; }
    relevant.push(c);
  }
  // 액세서리 단어가 상품명엔 있는데 검색 토큰엔 없으면 본품이 아니다(케이스를 찾는 사용자면 토큰에 '케이스'가 있다)
  const byWord = relevant.filter((c) => {
    const name = String(c.name);
    const acc = ACCESSORY_WORDS.some((w) => name.includes(w) && !toks.some((t) => t.includes(w.toLowerCase())));
    if (acc) dropped.accessory++;
    return !acc;
  });
  // 중앙값은 관련성 통과 후보로 계산 — 액세서리가 많아도 본품 가격대가 기준이 되게
  const median = recMedian(relevant.map((c) => Number(c.price)));
  const kept = byWord.filter((c) => {
    const cheap = median > 0 && Number(c.price) < median * ACCESSORY_PRICE_RATIO;
    if (cheap) dropped.accessory++;
    return !cheap;
  });
  return { kept, dropped };
}

// 베이지안 평균: 리뷰가 적은 5.0 보다 리뷰가 많은 4.7 을 위로. v=리뷰 수, m=가중 리뷰 수, C=전체 평균
function bayesianRating(R, v, C, m) {
  const r = Number(R) || 0, n = Math.max(0, Number(v) || 0), c = Number(C) || 0, k = Math.max(0, Number(m) || 0);
  if (n + k === 0) return r;
  return (n / (n + k)) * r + (k / (n + k)) * c;
}

function normalizeRecWeights(weights) {
  const w = { ...REC_WEIGHTS_DEFAULT };
  if (weights && typeof weights === 'object') {
    for (const k of Object.keys(w)) { const v = Number(weights[k]); if (Number.isFinite(v) && v >= 0) w[k] = v; }
  }
  const sum = w.price + w.quality + w.safety;
  if (!(sum > 0)) return { ...REC_WEIGHTS_DEFAULT };
  if (Math.abs(sum - 1) > 1e-9) { w.price /= sum; w.quality /= sum; w.safety /= sum; }
  return w;
}

// 3단계: 가격·품질·안정 세 축을 0~100 으로. 입력은 건드리지 않고 복사본에 scores 등을 붙여 돌려준다.
function scoreCandidates(kept, weights) {
  const w = normalizeRecWeights(weights);
  const list = (Array.isArray(kept) ? kept : []).map((c) => ({ ...c }));
  if (!list.length) return list;
  for (const c of list) {
    c.price = Math.round(Number(c.price)) || 0;
    // 배송비는 검색 결과에 없다. 로켓·무료배송이면 0 이 확실하고, 아니면 모르는 것이지 0 이 아니다 → 플래그로 남긴다
    c.shippingUnknown = !(c.rocket || c.freeShipping);
    c.effectivePrice = c.price;
  }
  const prices = list.map((c) => c.effectivePrice);
  const min = Math.min(...prices), max = Math.max(...prices);
  // 품질 기준선 C: 평점이 있는 후보들의 평균 (없으면 리뷰 없는 후보만 있는 것 → 쓰이지 않는다)
  const rated = list.filter((c) => Number(c.rating) > 0 && Number(c.reviewCount) > 0);
  const C = rated.length ? rated.reduce((a, c) => a + Number(c.rating), 0) / rated.length : 0;
  // 가격 등수 (effectivePrice 오름차순, 동률은 같은 등수) — 카드 reason 의 "N번째로 저렴"
  const sortedPrices = [...new Set(prices)].sort((a, b) => a - b);

  for (const c of list) {
    const p = c.effectivePrice;
    const priceScore = max === min ? 100 : ((max - p) / (max - min)) * 100;
    const R = Number(c.rating), v = Number(c.reviewCount);
    let quality, dataInsufficient = false;
    if (!(R > 0) || !(v > 0)) {
      quality = 30; dataInsufficient = true;   // 모르는 건 모른다 — 중간값 50 을 주면 리뷰 없는 상품이 득을 본다
    } else {
      const adj = bayesianRating(R, v, C, BAYES_M);
      const norm = recClamp(((adj - 1) / 4) * 100);
      const bonus = Math.min(10, 2.5 * Math.log10(1 + v));
      quality = recClamp(norm + bonus);
    }
    // 안정: 쿠팡 직매입(로켓배송·로켓직구·로켓프레시)은 공식 반품 정책이 붙어 +30, 판매자로켓은 배송만 로켓이라 +15.
    // 리뷰 본문이 없어 가짜 리뷰·품질 리스크 감점은 0 이다 — 검색 결과만으로는 알 수 없는 한계.
    let safety = 50;
    if (c.rocket === '로켓배송' || c.rocket === '로켓직구' || c.rocket === '로켓프레시') safety += 30;
    else if (c.rocket === '판매자로켓') safety += 15;
    if (c.freeShipping) safety += 5;
    if (!dataInsufficient && v >= 100 && R >= 4.5) safety += 10;
    if (!dataInsufficient && v >= 1000) safety += 5;
    if (c.adBadge) safety -= 5;
    safety = recClamp(safety);

    const total = w.price * priceScore + w.quality * quality + w.safety * safety;
    c.scores = {
      price: Math.round(recClamp(priceScore)),
      quality: Math.round(recClamp(quality)),
      safety: Math.round(safety),
      total: Math.round(recClamp(total) * 10) / 10,
    };
    c.dataInsufficient = dataInsufficient;
    c.lowest = p === min;
    c.priceRank = sortedPrices.indexOf(p) + 1;
  }
  return list;
}

// 4단계: 카드 링크는 '개별 상품 상세 페이지'만. 검색·카테고리 URL 은 어떤 경우에도 내보내지 않는다.
function validateDetailUrl(url) {
  let u;
  try { u = new URL(String(url || '')); } catch { return { ok: false, normalized: null, reason: 'invalid-url' }; }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, normalized: null, reason: 'not-http' };
  const host = u.hostname.toLowerCase();
  const path = u.pathname;
  const q = u.searchParams;
  // 경로만 먼저 본다. 쿠팡 상세 URL 은 검색에서 들어오면 q=·searchId= 추적 파라미터가 붙는데 정규화에서 떼어내므로
  // 쿼리는 정규화 뒤에 다시 검사한다.
  if (REC_SEARCH_PAGE_RE.test(path)) return { ok: false, normalized: null, reason: 'search-or-category' };

  let normalized = null;
  let m;
  if (recHostIs(host, 'coupang.com')) {
    if ((m = path.match(/^\/vp\/products\/(\d+)/))) {
      const keep = new URLSearchParams();
      for (const k of ['itemId', 'vendorItemId']) { const v = q.get(k); if (v && /^\d+$/.test(v)) keep.set(k, v); }
      const qs = keep.toString();
      normalized = `https://www.coupang.com/vp/products/${m[1]}` + (qs ? '?' + qs : '');
    }
  } else if (recHostIs(host, 'smartstore.naver.com') || recHostIs(host, 'brand.naver.com')) {
    if ((m = path.match(/^\/[^/]+\/products\/\d+/))) normalized = u.origin + m[0];
  } else if (recHostIs(host, '11st.co.kr')) {
    const id = (path.match(/\/products\/(\d+)/) || [])[1] || ((q.get('prdNo') || '').match(/^\d+$/) || [])[0];
    if (id) normalized = `https://www.11st.co.kr/products/${id}`;
  } else if (recHostIs(host, 'gmarket.co.kr')) {
    const id = [...q.entries()].find(([k]) => k.toLowerCase() === 'goodscode')?.[1];
    if (id && /^\d+$/.test(id)) normalized = `${u.origin}${path}?goodscode=${id}`;
  } else if (recHostIs(host, 'auction.co.kr')) {
    const id = [...q.entries()].find(([k]) => k.toLowerCase() === 'itemno')?.[1];
    if (id && /^\d+$/.test(id)) normalized = `${u.origin}${path}?itemno=${id}`;
  } else if (recHostIs(host, 'ssg.com')) {
    const id = q.get('itemId');
    if (id && /^\d+$/.test(id)) normalized = `${u.origin}${path}?itemId=${id}`;
  } else if (recHostIs(host, 'lotteon.com')) {
    if (/\/p\/product\//.test(path)) normalized = u.origin + path;
  } else if (recHostIs(host, 'interpark.com')) {
    const prdNo = q.get('prdNo');
    if (prdNo && /^\d+$/.test(prdNo)) normalized = `${u.origin}${path}?prdNo=${prdNo}`;
    else if (/\/product\/\d+/.test(path)) normalized = u.origin + path;
  } else if (recHostIs(host, 'tmon.co.kr')) {
    if (/\/deal\/\d+/.test(path)) normalized = u.origin + path;
  } else {
    return { ok: false, normalized: null, reason: 'unknown-host' };
  }
  if (!normalized) return { ok: false, normalized: null, reason: 'not-detail-page' };
  // 정규화 뒤 남은 경로·쿼리에 검색 흔적이 있으면 거부 (다른 몰은 쿼리를 그대로 두므로 여기서 걸린다)
  const n = new URL(normalized);
  if (REC_SEARCH_PAGE_RE.test(n.pathname + n.search)) return { ok: false, normalized: null, reason: 'search-or-category' };
  return { ok: true, normalized, reason: null };
}

// total 내림차순. 1위(가디언 추천)는 평점·리뷰가 있는 후보만 — 데이터 없는 상품을 "추천"이라 부르지 않는다.
function pickTop3(scored) {
  const list = [...(Array.isArray(scored) ? scored : [])]
    .sort((a, b) => (b.scores?.total ?? 0) - (a.scores?.total ?? 0) || (a.effectivePrice ?? 0) - (b.effectivePrice ?? 0));
  const first = list.find((c) => !c.dataInsufficient) || null;
  const guardian = !!first;
  const top = (first ? [first, ...list.filter((c) => c !== first)] : list).slice(0, 3);
  const notes = [];
  if (list.length < 3) notes.push('추천 가능한 상품이 부족합니다');
  if (!guardian) notes.push('평점·리뷰 데이터가 없어 가디언 추천을 보류했어요');
  return { top, guardian, note: notes.length ? notes.join(' · ') : null };
}

// 계약 3 카드. 사이드바 번들이 ...card 로 펼쳐 쓴다 — 빈 태그·지어낸 값은 넣지 않는다.
function buildCard(cand, rank, candidateCount, currentPrice) {
  const c = cand || {};
  const price = Math.round(Number(c.price)) || 0;
  const cur = Number(currentPrice) || 0;
  const hasRating = Number(c.rating) > 0 && Number(c.reviewCount) > 0;
  const tags = [];
  if (c.lowest) tags.push(`후보 ${candidateCount}개 중 최저가`);
  if (c.rocket) tags.push(c.rocket);
  if (c.dataInsufficient) tags.push('데이터 부족');
  tags.push('쿠팡 검색 결과 기준');
  const reason = [
    `후보 ${candidateCount}개 중 ${c.priceRank || '?'}번째로 저렴`,
    hasRating ? `평점 ${Number(c.rating).toFixed(1)} (리뷰 ${Number(c.reviewCount).toLocaleString()}개)` : '평점·리뷰 데이터 부족',
    c.rocket || '일반배송',
  ].join(' · ');
  return {
    productName: c.name, name: c.name,
    price, estimatedPrice: price,
    savings: cur ? Math.max(cur - price, 0) : 0,
    platform: '쿠팡',
    tags, reason,
    rating: hasRating ? Number(c.rating) : null,
    reviewCount: hasRating ? Number(c.reviewCount) : null,
    scores: c.scores || { price: 0, quality: 0, safety: 0, total: 0 },
    dataInsufficient: !!c.dataInsufficient,
    lowest: !!c.lowest,
    rank, candidateCount,
    link: c.link,
    image: c.image || null,
  };
}

// 탭이 'complete' 가 될 때까지(또는 타임아웃) 기다린다. 이미 끝나 있으면 바로 돌아온다.
function waitTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    const finish = () => {
      if (done) return;
      done = true;
      try { chrome.tabs.onUpdated.removeListener(onUpdated); } catch (_) {}
      if (timer) clearTimeout(timer);
      resolve();
    };
    const onUpdated = (id, info) => { if (id === tabId && info && info.status === 'complete') finish(); };
    chrome.tabs.onUpdated.addListener(onUpdated);
    timer = setTimeout(finish, timeoutMs);
    Promise.resolve(chrome.tabs.get(tabId)).then((t) => { if (t && t.status === 'complete') finish(); }).catch(() => {});
  });
}

// 2단계 수집: 탭 열기 → 로드 대기 → collectSearchResults → 탭 닫기.
// 사용자가 버튼을 눌러 검색한 것과 같은 1회 요청이다. 크롤링이 아니라 사용자 브라우저의 탭이고, 결과는 그 사용자에게만 보인다.
// tabs.create/remove/onUpdated/sendMessage 는 별도 권한이 필요 없다(현재 permissions: storage,sidePanel,alarms,notifications 그대로).
// 같은 URL 은 동시 1회만 — 연타해도 탭은 하나만 열린다. 다른 URL 요청은 자기 결과를 받는다.
function collectViaBackgroundTab(url, timeoutMs = REC_TAB_TIMEOUT_MS) {   // async 아님 — 같은 URL 이면 진행 중인 Promise 자체를 돌려준다
  const key = String(url || '');
  if (_recInFlight.has(key)) return _recInFlight.get(key);
  const job = (async () => {
    let tabId = null;
    try {
      const tab = await chrome.tabs.create({ url, active: false });
      tabId = tab?.id ?? null;
      if (tabId == null) throw new Error('탭을 열지 못했습니다');
      await waitTabComplete(tabId, timeoutMs);
      let lastErr = null;
      for (let i = 0; i < REC_COLLECT_RETRIES; i++) {
        try {
          const res = await chrome.tabs.sendMessage(tabId, { type: 'collectSearchResults' });
          if (res && res.ok) return res;
          lastErr = new Error(res?.error || 'empty-response');
          if (res && res.error === 'blocked') break;   // 쿠팡이 접근을 막은 페이지 — 다시 읽어도 같다
        } catch (e) {
          lastErr = e;   // "Could not establish connection" — content script 가 아직 안 떴다
        }
        await recSleep(REC_COLLECT_RETRY_MS);
      }
      throw lastErr || new Error('collect-failed');
    } finally {
      if (tabId != null) { try { await chrome.tabs.remove(tabId); } catch (_) {} }
    }
  })();
  _recInFlight.set(key, job);
  // 끝나면(성공·실패 모두) 이 URL 의 항목을 지운다. 동기 예외로 job 이 set 전에 끝나도 여기서 지워진다.
  const clear = () => { if (_recInFlight.get(key) === job) _recInFlight.delete(key); };
  job.then(clear, clear);
  return job;
}

async function getRecWeights() {
  try {
    const { recWeights } = await chrome.storage.local.get('recWeights');
    return normalizeRecWeights(recWeights);
  } catch { return { ...REC_WEIGHTS_DEFAULT }; }
}

async function readRecCache(query) {
  try {
    const { recCache } = await chrome.storage.session.get('recCache');
    const hit = recCache && recCache[query];
    if (hit && Date.now() - (hit.savedAt || 0) < REC_CACHE_TTL_MS && hit.result) return hit.result;
  } catch (_) {}
  return null;
}

async function writeRecCache(query, result) {
  try {
    const { recCache } = await chrome.storage.session.get('recCache');
    const now = Date.now();
    const entries = Object.entries(recCache || {}).filter(([, v]) => v && now - (v.savedAt || 0) < REC_CACHE_TTL_MS);
    entries.push([query, { savedAt: now, result }]);
    entries.sort((a, b) => (b[1].savedAt || 0) - (a[1].savedAt || 0));
    await chrome.storage.session.set({ recCache: Object.fromEntries(entries.slice(0, REC_CACHE_MAX)) });
  } catch (_) {}
}

// Gemini 보정(선택): 규칙 기반 쿼리를 다듬는다. 실패·공란·60자 초과·규칙 토큰과 공통 토큰 0개면 버린다.
async function refineQueryWithGemini(productName, ruleTokens) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const prompt = `다음 상품명을 쇼핑몰 검색어로 정제하라. 브랜드·제품종류·핵심 규격만 남기고 광고·수량·색상·옵션·판매자 문구는 제거. JSON {"query":"..."} 만 출력\n\n상품명: ${String(productName).slice(0, 200)}`;
    const data = await geminiRaw(prompt, { temperature: 0, maxOutputTokens: 128, thinkingConfig: { thinkingBudget: 0 } }, ctrl.signal);
    const text = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join(' ').trim();
    const m = text.match(/\{[\s\S]*\}/);
    const q = String(JSON.parse(m ? m[0] : text)?.query || '').replace(/\s+/g, ' ').trim();
    if (!q || q.length > 60) return null;
    const gt = tokenizeForMatch(q);
    if (!gt.some((t) => ruleTokens.includes(t))) return null;
    return q;
  } finally { clearTimeout(timer); }
}

// 오케스트레이터 → 계약 4 응답. 캐시에 있으면 탭을 열지 않는다.
async function recommendForProduct(info) {
  const src = info && typeof info === 'object' ? info : {};
  const productName = String(src.productName || '').trim();
  const currentPrice = Number(src.currentPrice) || 0;
  if (productName.length < 2) return { configured: false, error: '상품명이 없어 후보를 찾을 수 없습니다' };

  const built = buildSearchQuery({ productName, brand: src.brand, model: src.model, specText: src.specText });
  let query = built.query;
  let queryVia = 'rule';
  if (!query) return { configured: false, error: '검색어를 만들지 못했습니다' };
  try {
    const refined = await refineQueryWithGemini(productName, built.tokens);
    if (refined) { query = refined; queryVia = 'gemini'; }
  } catch (e) { console.warn('[ShoMate] 검색어 Gemini 보정 실패(규칙 기반 사용):', e?.message || e); }

  const cached = await readRecCache(query);
  if (cached) return { ...cached, cached: true };

  const searchUrl = 'https://www.coupang.com/np/search?q=' + encodeURIComponent(query);
  let collected;
  try {
    collected = await collectViaBackgroundTab(searchUrl, REC_TAB_TIMEOUT_MS);
  } catch (e) {
    console.warn('[ShoMate] 쿠팡 검색 수집 실패:', e?.message || e);
    return { configured: false, error: catCollectErrorText(e, query), query, queryVia };
  }
  const raw = Array.isArray(collected?.items) ? collected.items : [];
  if (!raw.length) return { configured: false, error: catEmptyResultText(query), query, queryVia };

  // 숫자 정리 — content script 가 준 값 그대로 믿지 않는다
  const cands = raw.map((it) => ({
    name: String(it?.name || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    price: Math.round(Number(it?.price)) || 0,
    originalPrice: Number(it?.originalPrice) > 0 ? Math.round(Number(it.originalPrice)) : null,
    url: String(it?.url || ''),
    image: it?.image ? String(it.image) : null,
    rating: Number(it?.rating) > 0 ? Number(it.rating) : null,
    reviewCount: Number(it?.reviewCount) > 0 ? Math.round(Number(it.reviewCount)) : null,
    rocket: ['로켓배송', '로켓직구', '판매자로켓', '로켓프레시'].includes(it?.rocket) ? it.rocket : null,
    freeShipping: typeof it?.freeShipping === 'boolean' ? it.freeShipping : null,
    soldOut: !!it?.soldOut,
    adBadge: !!it?.adBadge,
  }));

  const { kept: kept0, dropped } = filterCandidates(cands, built.tokens);
  // 규격(용량×수량)이 읽히는데 현재 상품과 다르면 제외 — 1L×3개를 200ml×24개와 비교하지 않는다 (네이버 경로와 같은 원칙)
  const mySpec = parseSpec(src.specText || productName);
  let kept = kept0;
  if (mySpec) {
    kept = kept0.filter((c) => specMatch(mySpec, parseSpec(c.name)) !== false);
    dropped.specMismatch = kept0.length - kept.length;
  }
  if (!kept.length) {
    return { configured: false, error: '검색 결과에 같은 상품으로 볼 후보가 없습니다', query, queryVia, droppedCounts: dropped };
  }

  const scored = scoreCandidates(kept, await getRecWeights());
  // 상세 URL 검증 — 실패 후보는 버리고 다음 순위로 채운다
  const valid = [];
  for (const c of scored) {
    const v = validateDetailUrl(c.url);
    if (v.ok) valid.push({ ...c, link: v.normalized });
    else dropped.badUrl = (dropped.badUrl || 0) + 1;
  }
  if (!valid.length) {
    return { configured: false, error: '상세 페이지 URL 이 확인된 후보가 없습니다', query, queryVia, droppedCounts: dropped };
  }
  const candidateCount = valid.length;
  const { top, guardian, note } = pickTop3(valid);
  const items = top.map((c, i) => {
    const card = buildCard(c, i + 1, candidateCount, currentPrice);
    const sp = parseSpec(c.name);
    return { title: c.name, price: c.price, mall: '쿠팡', link: c.link, image: c.image, specText: sp ? sp.label : null, card };
  });
  const lowestPrice = Math.min(...valid.map((c) => c.effectivePrice));
  const result = {
    configured: true, source: 'coupang-search', query, queryVia,
    candidateCount, droppedCounts: dropped, guardian, note,
    lowest: Number.isFinite(lowestPrice) ? { price: lowestPrice, mall: '쿠팡' } : null,
    items,
  };
  await writeRecCache(query, result);
  return result;
}

// ── 카테고리 순위 (계약 3~5장) — 순수 함수 ─────────────────────
// 같은 상품의 최저가 대신 "상품 종류" 검색어(예: '강아지 고양이 이동장')로 쿠팡을 검색하고, 그 결과에 나온
// 다른 상품들에 ShoMate 3축(가격·품질·안정) 순위를 매긴다. 다른 상품과의 비교이므로 절약액(savings)·
// 시장 최저가(lowest)는 만들지 않는다. 이 구간의 함수는 chrome.* 를 쓰지 않는다 —
// tests/category-rank.test.js 가 이 구간(아래 '저장소·탭·오케스트레이터' 머리 주석 전까지)을 잘라 실행한다.
const CATEGORY_WEIGHTS_DEFAULT = { price: 0.2, quality: 0.3, safety: 0.5 };   // 사이드바 기본 '안전성 우대'(p2) 와 같다
const CATEGORY_PRIORITY_WEIGHTS = {                                           // 사이드바 p2() 와 같은 표
  '가성비 우대': { price: 0.5, quality: 0.3, safety: 0.2 },
  '배송속도 우대': { price: 0.34, quality: 0.33, safety: 0.33 },
  '안전성 우대': { price: 0.2, quality: 0.3, safety: 0.5 },
};
const CATEGORY_PRIORITY_DEFAULT = '안전성 우대';
const CATEGORY_TOP_N = 5;                 // 사이드바 카드 수
const CATEGORY_QUERY_MAX = 20;            // 검색어 최대 글자 수
const CATEGORY_QUERY_PICK = 3;            // 검색어 최대 토큰 수
const CATEGORY_UNIT_RATIO = 0.6;          // 같은 규격 차원(g·ml·개)을 가진 후보 비율이 이 이상이면 단가로 비교
const CATEGORY_OUTLIER_MIN_N = 8;         // 후보가 이 수 이상일 때만 가격 이상치(IQR)를 거른다
const CATEGORY_ITEMS_MAX = 200;           // 한 번에 받는 수집 항목 상한 (쿠팡 한 페이지는 60개 안팎)
const CATEGORY_ROCKETS = ['로켓배송', '로켓직구', '판매자로켓', '로켓프레시'];
const CATEGORY_DIRECT_ROCKETS = ['로켓배송', '로켓직구', '로켓프레시'];   // 쿠팡 직매입 — 공식 반품 정책
const CATEGORY_EXCLUDE_WHY = ['ad', 'soldOut', 'current', 'outlier', 'accessory', 'noSpec', 'badUrl'];
// COLOR_WORDS 에 없는 색 이름 — 카테고리 검색어에 들어가면 엉뚱한 결과가 나온다
const CATEGORY_COLOR_EXTRA = ['그래파이트', '크림', '라벤더', '코랄', '라이트그레이', '다크그레이', '스카이블루', '라이트블루',
  '올리브', '버건디', '머스타드', '샴페인골드', '티타늄', '오프화이트', '혼합색상', '랜덤색상', '색상랜덤', '멀티컬러'];

const catWon = (n) => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const catIsKoreanToken = (t) => typeof t === 'string' && t.length >= 2 && /[가-힣]/.test(t) && !/\d/.test(t);
// 검색어 → 액세서리 판정·검색어 비교용 토큰 (공백 분리, 소문자)
const categoryTokensOf = (query) => String(query || '').toLowerCase().split(/\s+/).map((t) => t.trim()).filter(Boolean);
const categorySearchUrl = (query) => 'https://www.coupang.com/np/search?q=' + encodeURIComponent(String(query || ''));
// 상품 상세 URL 에서 productId. 쿠팡 상세(/vp/products/{id}, 모바일 /vm/products/{id})만 인정한다
function productIdFromUrl(url) {
  const m = String(url || '').match(/^https?:\/\/(?:[a-z0-9-]+\.)*coupang\.com\/v[pm]\/products\/(\d{1,20})(?:[/?#]|$)/i);
  return m ? m[1] : null;
}
// 보이는 탭으로 열어도 되는 주소: https://www.coupang.com/np/search?… 형태만
function isCoupangSearchUrl(url) {
  return /^https:\/\/www\.coupang\.com\/np\/search\?[^\s#]*(?:#[^\s]*)?$/.test(String(url || ''));
}
function queryFromSearchUrl(url) {
  const m = String(url || '').match(/[?&]q=([^&#]*)/);
  if (!m) return null;
  try { return decodeURIComponent(m[1].replace(/\+/g, ' ')).replace(/\s+/g, ' ').trim() || null; } catch (_) { return null; }
}
function normalizeCategoryPriority(p) {
  return Object.prototype.hasOwnProperty.call(CATEGORY_PRIORITY_WEIGHTS, p) ? p : CATEGORY_PRIORITY_DEFAULT;
}
// 가중치: 요청 weights(사이드바 p2) > priority 표 > 기본값. 합이 0 이하면 priority 표로 되돌린다. normalizeRecWeights 로 합 1.
function resolveCategoryWeights(weights, priority) {
  const base = CATEGORY_PRIORITY_WEIGHTS[priority] || CATEGORY_WEIGHTS_DEFAULT;
  let merged = { ...base };
  if (weights && typeof weights === 'object') {
    for (const k of ['price', 'quality', 'safety']) { const v = Number(weights[k]); if (Number.isFinite(v) && v >= 0) merged[k] = v; }
  }
  if (!(merged.price + merged.quality + merged.safety > 0)) merged = { ...base };
  return normalizeRecWeights(merged);
}

// 쿠팡 제목 꼬리 ' - 카테고리 | 쿠팡' 의 카테고리(숫자 없는 1~12자). 없으면 null. buildCategoryQuery 의 '2토큰 브랜드 의심' 경우에만 쓴다.
function categoryTitleTail(productName) {
  const s = String(productName || '').replace(/\[[^\]]*\]|\([^)]*\)|【[^】]*】|｛[^｝]*｝/g, ' ');
  const m = s.match(/\s+-\s+([^|\-\d]{1,20})\s*\|\s*[^|]*$/);
  if (!m) return null;
  const t = m[1].replace(/\s+/g, ' ').trim();
  if (!(t.length >= 1 && t.length <= 12) || /\d/.test(t)) return null;
  // '우유/두유' 처럼 여러 분류가 붙어 오면 한글 분류 하나만 쓴다 — 제목에도 나오는 쪽을 우선. 'Apple' 같은 영문(브랜드)은 버린다.
  const parts = t.split('/').map((x) => x.trim()).filter((x) => x && x.split(' ').every(catIsKoreanToken));
  return parts.find((x) => s.includes(x)) || parts[0] || null;
}

// 카테고리 검색어(규칙 기반): 브랜드·모델·용량·색상·옵션·광고 문구를 빼고 "상품 종류" 한글 토큰만 남긴다.
// 예) '호밍사이 강아지 백팩 고양이 이동장 … 고양이이동장' → '강아지 고양이 이동장'
function buildCategoryQuery(info) {
  const src = info && typeof info === 'object' ? info : { productName: String(info || '') };
  const productName = String(src.productName || '');
  const s = recCleanTitle(productName);
  const noise = new Set(NOISE_WORDS.map((w) => w.toLowerCase()));
  const colors = new Set([...COLOR_WORDS, ...CATEGORY_COLOR_EXTRA].map((w) => w.toLowerCase()));
  const all = [];          // 제목의 한글 토큰 (중복 포함, 등장 순) — 빈도 계산용
  let firstToken = null;   // 정리된 제목의 첫 토큰 (브랜드 추정용)
  for (const raw of s.split(/\s+/)) {
    let t = recStripDeco(raw);
    if (!t) continue;
    if (/[\/,]/.test(t) && !/^\d{1,3}(,\d{3})+/.test(t)) t = recStripDeco(t.split(/[\/,]/)[0]);
    if (!t) continue;
    if (firstToken == null) firstToken = t;
    const low = t.toLowerCase();
    if (noise.has(low)) continue;
    if (colors.has(low) || colors.has(low.replace(/색$/, ''))) continue;
    if (!catIsKoreanToken(t)) continue;   // 숫자 포함(용량·모델)·라틴 전용(영문 브랜드·모델)·1글자 제거
    all.push(t);
  }
  const uniq = [];
  for (const t of all) if (!uniq.some((u) => u.toLowerCase() === t.toLowerCase())) uniq.push(t);

  // 브랜드 제거: brand 가 오면 그 토큰(과 그 이름으로 시작하는 토큰, 예: '삼성' → '삼성전자')을 뺀다.
  // 없으면 첫 토큰이 한글이고 제목에 한 번만 나오며 한글 토큰이 3개 이상일 때 첫 토큰을 브랜드로 본다.
  let cands = uniq;
  const brand = String(src.brand || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (brand) {
    const whole = brand.replace(/\s+/g, '');
    const brandParts = brand.split(' ').filter((b) => b.length >= 2);
    cands = uniq.filter((t) => {
      const l = t.toLowerCase();
      return !(l === whole || brandParts.includes(l) || (whole.length >= 2 && l.startsWith(whole)));
    });
  } else if (firstToken && uniq.length >= 3 && uniq[0] === firstToken
             && s.split(firstToken).length - 1 === 1) {
    cands = uniq.slice(1);
  } else if (firstToken && uniq.length === 2 && uniq[0] === firstToken
             && s.split(firstToken).length - 1 === 1) {
    // 한글 토큰이 2개뿐이면 첫 토큰이 브랜드일 수 있다('햇반 백미밥'). 쿠팡 제목 꼬리 카테고리(' - 즉석밥 | 쿠팡')가
    // 있을 때만 그 카테고리를 앞에 두고 첫 토큰을 뺀다 → '즉석밥 백미밥'. 꼬리가 없으면('비비고 왕교자') 그대로 둔다.
    const tail = categoryTitleTail(productName);
    if (tail) {
      const parts2 = [tail];
      if (uniq[1].toLowerCase() !== tail.toLowerCase()) parts2.push(uniq[1]);
      while (parts2.length > 1 && parts2.join(' ').length > CATEGORY_QUERY_MAX) parts2.pop();
      const q2 = parts2.join(' ');
      return { query: q2, tokens: categoryTokensOf(q2), via: 'rule' };
    }
  }

  // 빈도: 제목의 한글 토큰 중 t 를 부분 문자열로 품은 토큰 수 ('고양이' ← '고양이', '고양이이동장')
  const scored = cands.map((t) => ({
    t,
    freq: all.filter((x) => x.toLowerCase().includes(t.toLowerCase())).length,
    pos: uniq.indexOf(t),
  }));
  scored.sort((a, b) => b.freq - a.freq || a.pos - b.pos);
  const parts = scored.slice(0, CATEGORY_QUERY_PICK).sort((a, b) => a.pos - b.pos).map((x) => x.t);
  while (parts.length && parts.join(' ').length > CATEGORY_QUERY_MAX) parts.pop();
  const query = parts.join(' ');
  if (query) return { query, tokens: categoryTokensOf(query), via: 'rule' };
  // 한글 종류 토큰이 하나도 없으면(영문 상품명 등) 같은 상품 검색어로 폴백
  const fb = buildSearchQuery({ productName, brand: src.brand, model: src.model, specText: src.specText });
  return { query: fb.query, tokens: fb.tokens, via: 'rule' };
}

// Gemini 가 준 카테고리 검색어 검증: 2~20자, 한글 포함, 1~4단어, 숫자 없음, 브랜드 미포함, 한글·영문·공백만.
function validateCategoryQuery(q, brand) {
  const s = String(q == null ? '' : q).replace(/\s+/g, ' ').trim();
  if (s.length < 2 || s.length > CATEGORY_QUERY_MAX) return null;
  if (!/[가-힣]/.test(s) || /\d/.test(s) || /[^가-힣a-zA-Z ]/.test(s)) return null;
  const words = s.split(' ');
  if (words.length < 1 || words.length > 4) return null;
  const b = String(brand || '').replace(/\s+/g, '').toLowerCase();
  if (b && s.replace(/\s+/g, '').toLowerCase().includes(b)) return null;
  return s;
}

// 수집기 항목(계약 1장) 정리 — content script 가 준 값을 그대로 믿지 않는다. productId 가 없으면 버린다(배지를 붙일 곳이 없다).
function normalizeCategoryItems(items) {
  const out = [];
  const idOf = (v) => (/^\d{1,20}$/.test(String(v == null ? '' : v)) ? String(v) : null);
  const posInt = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
  for (const it of (Array.isArray(items) ? items : []).slice(0, CATEGORY_ITEMS_MAX)) {
    if (!it || typeof it !== 'object') continue;
    const url = String(it.url || '');
    const cleanUrl = it.cleanUrl ? String(it.cleanUrl) : null;
    const productId = idOf(it.productId) || productIdFromUrl(url) || productIdFromUrl(cleanUrl);
    if (!productId) continue;
    const rating = Number(it.rating);
    const dr = Number(it.discountRate);
    out.push({
      productId,
      vendorItemId: idOf(it.vendorItemId),
      itemId: idOf(it.itemId),
      name: String(it.name || '').replace(/\s+/g, ' ').trim().slice(0, 200),
      price: Number(it.price) > 0 ? Math.round(Number(it.price)) : 0,
      originalPrice: Number(it.originalPrice) > 0 ? Math.round(Number(it.originalPrice)) : null,
      discountRate: Number.isFinite(dr) && dr > 0 && dr < 100 ? Math.round(dr) : null,
      rating: rating > 0 && rating <= 5 ? rating : null,
      reviewCount: Number(it.reviewCount) > 0 ? Math.round(Number(it.reviewCount)) : null,
      rocket: CATEGORY_ROCKETS.includes(it.rocket) ? it.rocket : null,
      freeShipping: it.freeShipping === true ? true : (it.freeShipping === false ? false : null),
      soldOut: !!it.soldOut,
      adBadge: !!it.adBadge,
      url, cleanUrl,
      image: it.image ? String(it.image).slice(0, 1000) : null,
      searchRank: posInt(it.searchRank),
      coupangRank: posInt(it.coupangRank),
    });
  }
  return out;
}

// 액세서리 단어가 상품명에 있는데 카테고리 토큰엔 없으면 본품이 아니다 (filterCandidates 와 같은 기준)
function isCategoryAccessory(name, tokens) {
  const n = String(name || '');
  const toks = Array.isArray(tokens) ? tokens.map((t) => String(t).toLowerCase()) : [];
  return ACCESSORY_WORDS.some((w) => n.includes(w) && !toks.some((t) => t.includes(w.toLowerCase())));
}

// 규격 차원: 'g' | 'ml' | 'count'(개수만) | null
function categorySpecDim(sp) {
  if (!sp) return null;
  if (sp.totalG != null) return 'g';
  if (sp.totalMl != null) return 'ml';
  if (sp.count != null) return 'count';
  return null;
}

// 4장 필터: 가격 없음(조용히) → productId 대표 → 광고·품절·현재 상품·액세서리·상세 URL → 단가 모드(noSpec) → 이상치.
// 반환 kept 원소에는 effectivePrice·unitPriceLabel·link(정규화한 상세 URL)·specLabel 이 붙는다.
function filterCategoryCandidates(items, opts) {
  const o = opts || {};
  const toks = (Array.isArray(o.tokens) ? o.tokens : []).map((t) => String(t).toLowerCase()).filter(Boolean);
  const curId = o.currentProductId != null && String(o.currentProductId) ? String(o.currentProductId) : null;

  // productId 별 대표: 광고 아닌 첫 원소. 그 상품이 광고로만 나왔으면 첫 광고 원소. (Map 은 처음 본 순서를 지킨다)
  const groups = new Map();
  for (const c of Array.isArray(items) ? items : []) {
    if (!c || !c.name || !(Number(c.price) > 0)) continue;
    const id = c.productId != null ? String(c.productId) : '';
    if (!id) continue;
    const g = groups.get(id);
    if (!g || (g.adBadge && !c.adBadge)) groups.set(id, c);
  }

  const excluded = [];
  let pass = [];
  for (const [id, c] of groups) {
    let why = null;
    let link = null;
    if (c.adBadge) why = 'ad';
    else if (c.soldOut) why = 'soldOut';
    else if (curId && id === curId) why = 'current';
    else if (isCategoryAccessory(c.name, toks)) why = 'accessory';
    else {
      // 카드 링크는 개별 상세 페이지만 — 검색·카테고리 URL 은 어떤 경우에도 내보내지 않는다
      let v = validateDetailUrl(c.url);
      if (!v.ok && c.cleanUrl) v = validateDetailUrl(c.cleanUrl);
      if (v.ok && productIdFromUrl(v.normalized) === id) link = v.normalized;
      else why = 'badUrl';
    }
    if (why) excluded.push({ productId: id, why });
    else pass.push({ ...c, productId: id, link });
  }

  // 단가 모드: 같은 차원의 규격을 가진 후보가 60% 이상이면 그 차원의 단가(100g·100ml·1개당)로 비교한다.
  // 단, 개수 차원인데 전부 '1개'면(쿠팡 옵션 꼬리 ', 1개') 단가가 가격과 같아 의미가 없고 규격 없는 후보만 억울하게
  // 빠지므로 단가 모드를 쓰지 않는다.
  let unitMode = null;
  const specs = pass.map((c) => parseSpec(c.name));
  if (pass.length) {
    const dims = specs.map(categorySpecDim);
    for (const d of ['g', 'ml', 'count']) {
      if (dims.filter((x) => x === d).length / pass.length >= CATEGORY_UNIT_RATIO) { unitMode = d; break; }
    }
    if (unitMode === 'count' && specs.every((sp) => categorySpecDim(sp) !== 'count' || sp.count === 1)) unitMode = null;
  }
  const next = [];
  pass.forEach((c, i) => {
    const sp = specs[i];
    const specLabel = sp ? sp.label : null;
    if (!unitMode) { next.push({ ...c, effectivePrice: c.price, unitPriceLabel: null, specLabel }); return; }
    if (categorySpecDim(sp) !== unitMode) { excluded.push({ productId: c.productId, why: 'noSpec' }); return; }
    let ep, label;
    if (unitMode === 'g') { ep = (c.price / sp.totalG) * 100; label = `100g당 ${catWon(ep)}원`; }
    else if (unitMode === 'ml') { ep = (c.price / sp.totalMl) * 100; label = `100ml당 ${catWon(ep)}원`; }
    else { ep = c.price / sp.count; label = `1개당 ${catWon(ep)}원`; }
    if (!(ep > 0) || !Number.isFinite(ep)) { excluded.push({ productId: c.productId, why: 'noSpec' }); return; }
    next.push({ ...c, effectivePrice: ep, unitPriceLabel: label, specLabel });
  });
  pass = next;

  // 가격 이상치: log(effectivePrice) 의 Q1−1.5·IQR 미만 / Q3+1.5·IQR 초과. IQR 이 0 이면(가격이 거의 같음) 거르지 않는다.
  let kept = pass;
  if (pass.length >= CATEGORY_OUTLIER_MIN_N) {
    const logs = pass.map((c) => Math.log(c.effectivePrice)).sort((a, b) => a - b);
    const quant = (p) => {
      const pos = (logs.length - 1) * p;
      const lo = Math.floor(pos), hi = Math.ceil(pos);
      return logs[lo] + (logs[hi] - logs[lo]) * (pos - lo);
    };
    const q1 = quant(0.25), q3 = quant(0.75), iqr = q3 - q1;
    if (iqr > 0) {
      const lower = q1 - 1.5 * iqr, upper = q3 + 1.5 * iqr;
      kept = pass.filter((c) => {
        const l = Math.log(c.effectivePrice);
        const out = l < lower || l > upper;
        if (out) excluded.push({ productId: c.productId, why: 'outlier' });
        return !out;
      });
    }
  }
  return { kept, excluded, unitMode };
}

function countCategoryExcluded(excluded) {
  const counts = {};
  for (const k of CATEGORY_EXCLUDE_WHY) counts[k] = 0;
  for (const e of Array.isArray(excluded) ? excluded : []) if (e && counts[e.why] != null) counts[e.why]++;
  return counts;
}

// 5장 점수: 세 축 0~100 정수, total = round(가중합). 입력은 건드리지 않고 복사본에 scores 등을 붙인다.
function scoreCategoryCandidates(kept, weights) {
  const w = resolveCategoryWeights(weights);
  const list = (Array.isArray(kept) ? kept : []).map((c) => ({ ...c }));
  const n = list.length;
  if (!n) return list;
  for (const c of list) {
    c.price = Math.round(Number(c.price)) || 0;
    const ep = Number(c.effectivePrice);
    c.effectivePrice = ep > 0 && Number.isFinite(ep) ? ep : c.price;
  }
  // 가격: effectivePrice 오름차순 백분위. 동률은 평균 순위. 1개면 100.
  const order = list.map((_, i) => i).sort((a, b) => list[a].effectivePrice - list[b].effectivePrice);
  const avgRank = new Array(n);
  for (let i = 0; i < n;) {
    let j = i;
    while (j + 1 < n && list[order[j + 1]].effectivePrice === list[order[i]].effectivePrice) j++;
    for (let k = i; k <= j; k++) avgRank[order[k]] = (i + j) / 2;
    i = j + 1;
  }
  // 품질 기준선 C: 평점·리뷰가 모두 있는 후보의 평균 평점
  const rated = list.filter((c) => Number(c.rating) > 0 && Number(c.reviewCount) > 0);
  const C = rated.length ? rated.reduce((a, c) => a + Number(c.rating), 0) / rated.length : 0;

  list.forEach((c, idx) => {
    const priceScore = n === 1 ? 100 : (100 * (n - 1 - avgRank[idx])) / (n - 1);
    const R = Number(c.rating) || 0, v = Number(c.reviewCount) || 0;
    const hasRating = R > 0 && v > 0;
    let quality;
    if (!hasRating) {
      quality = 30;   // 모르는 건 모른다 — 중간값 50 을 주면 리뷰 없는 상품이 득을 본다
    } else {
      const adj = bayesianRating(R, v, C, BAYES_M);
      quality = recClamp(recClamp(((adj - 1) / 4) * 100) + Math.min(10, 2.5 * Math.log10(1 + v)));
    }
    // 안정: 직매입 로켓 +25 / 판매자로켓 +12 / 무료배송 +5 / 평점 4.5↑·리뷰 100↑ +10 / 리뷰 1000↑ +5
    //       리뷰 5개 미만(없음 포함) −10 / 할인율 70%↑ 또는 원가가 판매가의 3.3배↑ → 과장 할인 의심 −10
    let safety = 50;
    if (CATEGORY_DIRECT_ROCKETS.includes(c.rocket)) safety += 25;
    else if (c.rocket === '판매자로켓') safety += 12;
    if (c.freeShipping === true) safety += 5;
    if (hasRating && v >= 100 && R >= 4.5) safety += 10;
    if (v >= 1000) safety += 5;
    if (v < 5) safety -= 10;
    const op = Number(c.originalPrice) || 0;
    const overDiscount = Number(c.discountRate) >= 70 || (op > 0 && c.price > 0 && op / c.price >= 3.3);
    if (overDiscount) safety -= 10;

    const ps = Math.round(recClamp(priceScore));
    const qs = Math.round(recClamp(quality));
    const ss = Math.round(recClamp(safety));
    c.scores = { price: ps, quality: qs, safety: ss, total: Math.round(recClamp(w.price * ps + w.quality * qs + w.safety * ss)) };
    c.dataInsufficient = !hasRating;
    c.overDiscount = overDiscount;
  });
  return list;
}

// 순위: total ↓ → 리뷰 수 ↓ → effectivePrice ↑ (→ 검색 노출 순서 ↑). 1위는 평점·리뷰가 있는 첫 후보(가디언)로 끌어올린다.
function rankCategoryCandidates(scored) {
  const list = [...(Array.isArray(scored) ? scored : [])].sort((a, b) =>
    (b.scores?.total ?? 0) - (a.scores?.total ?? 0)
    || (Number(b.reviewCount) || 0) - (Number(a.reviewCount) || 0)
    || (a.effectivePrice ?? 0) - (b.effectivePrice ?? 0)
    || (a.searchRank ?? 1e9) - (b.searchRank ?? 1e9));
  const first = list.find((c) => !c.dataInsufficient) || null;
  const ordered = first ? [first, ...list.filter((c) => c !== first)] : list;
  return {
    ranked: ordered.map((c, i) => ({ ...c, rank: i + 1 })),
    guardian: !!first,
    guardianProductId: first ? first.productId : null,
  };
}

// 카드 문구. currentPrice 를 모르거나 단가 모드(용량이 다른 상품끼리)면 현재 상품과의 가격 비교 구절은 넣지 않는다.
function buildCategoryReason(c, ctx) {
  const x = ctx || {};
  const R = Number(c.rating) || 0, v = Number(c.reviewCount) || 0;
  // 순위 숫자는 넣지 않는다 — 사이드바가 우선순위를 바꾸면 다시 정렬하므로 문장 속 'k위'가 화면 순서와 어긋난다.
  const parts = [`「${x.query || ''}」 검색 결과 ${x.rankedCount || 0}개와 비교`];
  parts.push(R > 0 && v > 0 ? `평점 ${R.toFixed(1)} (리뷰 ${catWon(v)}개)` : '평점·리뷰 데이터 부족');
  if (c.rocket) parts.push(c.rocket);
  else if (c.freeShipping === true) parts.push('무료배송');
  if (c.unitPriceLabel) parts.push(c.unitPriceLabel);
  const cur = Number(x.currentPrice) || 0;
  if (cur > 0 && !x.unitMode) {
    // 다른 상품(구성이 다를 수 있음)이라 '저렴·절약' 대신 중립적인 '가격 차이'로 쓴다. 후보가 싸면 −, 비싸면 +.
    const diff = Math.round(Number(c.price) || 0) - Math.round(cur);
    const sign = diff < 0 ? '\u2212' : diff > 0 ? '+' : '';
    parts.push(`현재 상품과 가격 차이 ${sign}${catWon(Math.abs(diff))}원(다른 상품)`);
  }
  return parts.join(' · ');
}
function buildCategoryTags(c, query) {
  const tags = [];
  if (c.rocket) tags.push(c.rocket);
  if (c.unitPriceLabel) tags.push(c.unitPriceLabel);
  if (c.dataInsufficient) tags.push('평점·리뷰 부족');
  tags.push(`쿠팡 「${query || ''}」 검색 기준`);
  return tags.filter((t) => typeof t === 'string' && t.trim());
}
// 계약 2.1 card. savings 는 0(다른 상품이라 '아낀 돈'이 아니다), lowest 는 false.
function buildCategoryCard(c, ctx) {
  const x = ctx || {};
  const price = Math.round(Number(c.price)) || 0;
  const R = Number(c.rating) || 0, v = Number(c.reviewCount) || 0;
  const hasRating = R > 0 && v > 0;
  const s = c.scores || {};
  return {
    id: 'cp-' + c.productId,
    type: 'optimal',
    productName: c.name, name: c.name,
    price, estimatedPrice: price,
    savings: 0,
    platform: '쿠팡',
    tags: buildCategoryTags(c, x.query),
    reason: buildCategoryReason(c, x),
    rating: hasRating ? R : null,
    reviewCount: hasRating ? v : null,
    scores: { price: s.price | 0, quality: s.quality | 0, safety: s.safety | 0, total: s.total | 0 },
    dataInsufficient: !!c.dataInsufficient,
    lowest: false,
    rank: c.rank,
    candidateCount: x.rankedCount || 0,   // rank 의 분모(순위에 든 상품 수)
    link: c.link,
    image: c.image || null,
    productId: c.productId,
    categoryRank: true,
  };
}

// 수집 항목 → 정리 → 필터 → 점수 → 순위 → 카드. 사이드바(searchPrices)와 검색 페이지 오버레이(rankSearchItems)가 같이 쓴다.
// candidateCount = 가격이 있는 서로 다른 상품 수(제외 전), rankedCount = 순위에 든 상품 수.
function rankCategoryItems(rawItems, opts) {
  const o = opts || {};
  const query = String(o.query || '');
  const items = normalizeCategoryItems(rawItems);
  const candidateCount = new Set(items.filter((c) => c.price > 0 && c.name).map((c) => c.productId)).size;
  const tokens = Array.isArray(o.tokens) ? o.tokens : categoryTokensOf(query);
  const { kept, excluded, unitMode } = filterCategoryCandidates(items, { tokens, currentProductId: o.currentProductId });
  const weights = resolveCategoryWeights(o.weights, o.priority);
  const { ranked, guardian, guardianProductId } = rankCategoryCandidates(scoreCategoryCandidates(kept, weights));
  const rankedCount = ranked.length;
  const ctx = { query, rankedCount, currentPrice: o.currentPrice, unitMode };
  const cards = ranked.map((c) => buildCategoryCard(c, ctx));
  return {
    query, weights, candidateCount, rankedCount, unitMode, guardian, guardianProductId,
    excluded, excludedCounts: countCategoryExcluded(excluded), ranked, cards,
  };
}

// 사이드바 상태바 note — 없으면 null
function buildCategoryNote(r) {
  const notes = [];
  if (r.rankedCount < CATEGORY_TOP_N) notes.push(`순위를 매길 수 있는 상품이 ${r.rankedCount}개뿐이에요`);
  if (!r.guardian) notes.push('평점·리뷰 데이터가 없어 가디언 추천을 보류했어요');
  if (r.unitMode) notes.push(`용량이 달라 ${r.unitMode === 'g' ? '100g' : r.unitMode === 'ml' ? '100ml' : '1개'}당 가격으로 비교했어요`);
  return notes.length ? notes.join(' · ') : null;
}

// ── 카테고리 순위 — 저장소·탭·오케스트레이터 ───────────────────
const CAT_QUERY_CACHE_MAX = 50;
const CAT_GEMINI_TIMEOUT_MS = 6000;
const RANK_TABS_MAX = 20;

// 사용자에게 보이는 실패 문장(쉬운 한국어). 내부 코드(collect-failed·empty-response·blocked·연결 오류)는 console.warn 으로만 남긴다.
const CAT_ERR_GENERIC = '쿠팡 검색 결과를 읽지 못했어요. 잠시 뒤 다시 분석해 주세요.';
const catEmptyResultText = (query) => `쿠팡 「${query || ''}」 검색 결과에서 상품을 읽지 못했어요(결과가 없거나 쿠팡이 접근을 막았을 수 있어요).`;
const catCollectErrorText = (e, query) => (String(e?.message || '') === 'blocked' ? catEmptyResultText(query) : CAT_ERR_GENERIC);

const catQueryKey = (name) => String(name || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 200);

// AI 카테고리 검색어. 6초 안에 검증을 통과한 답만 쓰고, 성공한 답은 상품명별로 캐시한다(최대 50). 실패·예외면 null.
async function categoryQueryWithGemini(productName, brand) {
  const key = catQueryKey(productName);
  if (!key) return null;
  try {
    const { catQueryCache } = await chrome.storage.session.get('catQueryCache');
    const hit = catQueryCache && catQueryCache[key];
    const ok = hit && validateCategoryQuery(hit.query, brand);
    if (ok) return ok;
  } catch (_) {}
  const ctrl = new AbortController();
  let timer = null;
  let q = null;
  try {
    const prompt = '다음 쇼핑 상품이 어떤 "상품 종류"인지 쿠팡 검색어로 답하라. 같은 종류의 다른 브랜드 상품들이 검색되어야 한다. '
      + '브랜드·모델명·용량·수량·색상·옵션·광고 문구는 빼고 일반 명사 1~4단어, 20자 이내, 숫자 없이. JSON {"category":"..."} 만 출력\n\n'
      + `상품명: ${String(productName).slice(0, 200)}` + (brand ? `\n브랜드(검색어에 넣지 말 것): ${String(brand).slice(0, 40)}` : '');
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { try { ctrl.abort(); } catch (_) {} reject(new Error('timeout')); }, CAT_GEMINI_TIMEOUT_MS);
    });
    const data = await Promise.race([
      geminiRaw(prompt, { temperature: 0, maxOutputTokens: 64, thinkingConfig: { thinkingBudget: 0 } }, ctrl.signal),
      timeout,
    ]);
    const text = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join(' ').trim();
    const m = text.match(/\{[\s\S]*\}/);
    q = validateCategoryQuery(JSON.parse(m ? m[0] : text)?.category, brand);
  } catch (e) {
    console.warn('[ShoMate] 카테고리 검색어 AI 실패(규칙 기반 사용):', e?.message || e);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!q) return null;
  try {
    const { catQueryCache } = await chrome.storage.session.get('catQueryCache');
    const now = Date.now();
    const entries = Object.entries(catQueryCache || {}).filter(([k]) => k !== key);
    entries.push([key, { query: q, savedAt: now }]);
    entries.sort((a, b) => (b[1]?.savedAt || 0) - (a[1]?.savedAt || 0));
    await chrome.storage.session.set({ catQueryCache: Object.fromEntries(entries.slice(0, CAT_QUERY_CACHE_MAX)) });
  } catch (_) {}
  return q;
}

// 6장 캐시: 수집 원본 items 만 (점수·카드는 가중치·현재가·현재 상품이 요청마다 달라 매번 다시 계산한다)
async function readCatRecCache(query) {
  try {
    const { catRecCache } = await chrome.storage.session.get('catRecCache');
    const hit = catRecCache && catRecCache['cat|' + query];
    if (hit && Date.now() - (hit.savedAt || 0) < REC_CACHE_TTL_MS && Array.isArray(hit.items) && hit.items.length) return hit;
  } catch (_) {}
  return null;
}
async function writeCatRecCache(query, items, searchUrl) {
  try {
    const { catRecCache } = await chrome.storage.session.get('catRecCache');
    const now = Date.now();
    const key = 'cat|' + query;
    const entries = Object.entries(catRecCache || {}).filter(([k, v]) => k !== key && v && now - (v.savedAt || 0) < REC_CACHE_TTL_MS);
    entries.push([key, { savedAt: now, items, searchUrl }]);
    entries.sort((a, b) => (b[1].savedAt || 0) - (a[1].savedAt || 0));
    await chrome.storage.session.set({ catRecCache: Object.fromEntries(entries.slice(0, REC_CACHE_MAX)) });
  } catch (_) {}
}

async function getLastCategoryRank() {
  try {
    const { lastCategoryRank } = await chrome.storage.session.get('lastCategoryRank');
    return lastCategoryRank && typeof lastCategoryRank === 'object' ? lastCategoryRank : null;
  } catch (_) { return null; }
}

// 보이는 순위 탭 기록 (storage.session.rankTabs[tabId]) — 탭이 닫히면 onRemoved 에서 지운다
async function getRankTab(tabId) {
  if (tabId == null) return null;
  try {
    const { rankTabs } = await chrome.storage.session.get('rankTabs');
    const e = rankTabs && rankTabs[String(tabId)];
    return e && typeof e === 'object' ? e : null;
  } catch (_) { return null; }
}
// rankTabs 는 읽고-고치고-쓰기라, 버튼 연타·탭 닫힘이 겹치면 한쪽 항목이 사라진다. 모듈 수준 Promise 체인으로 한 번에 하나씩 쓴다.
let _rankTabsLock = Promise.resolve();
function withRankTabsLock(fn) {
  const run = _rankTabsLock.then(fn, fn);
  _rankTabsLock = run.catch(() => {});   // 앞 작업이 실패해도 다음 작업은 돈다
  return run;
}
function setRankTab(tabId, entry) {
  return withRankTabsLock(async () => {
    const { rankTabs } = await chrome.storage.session.get('rankTabs');
    const entries = Object.entries(rankTabs || {}).filter(([k]) => k !== String(tabId));
    entries.push([String(tabId), entry]);
    entries.sort((a, b) => (b[1]?.openedAt || 0) - (a[1]?.openedAt || 0));
    await chrome.storage.session.set({ rankTabs: Object.fromEntries(entries.slice(0, RANK_TABS_MAX)) });
  });
}
function deleteRankTab(tabId) {
  return withRankTabsLock(async () => {
    const { rankTabs } = await chrome.storage.session.get('rankTabs');
    if (!rankTabs || !Object.prototype.hasOwnProperty.call(rankTabs, String(tabId))) return;
    const next = { ...rankTabs };
    delete next[String(tabId)];
    await chrome.storage.session.set({ rankTabs: next });
  });
}
chrome.tabs.onRemoved.addListener((tabId) => { deleteRankTab(tabId).catch(() => {}); });

// 계약 2.1 오케스트레이터: AI → (실패 시) 규칙 검색어 → 캐시 → 비활성 탭 수집(닫기) → 필터 → 점수 → 상위 5 카드.
// 자동 분석 경로라 보이는 탭은 절대 열지 않는다(순위 상품 클릭 → 자동 분석 → 탭 연쇄를 막는다).
async function rankCategoryForProduct(info) {
  const src = info && typeof info === 'object' ? info : {};
  const productName = String(src.productName || '').trim();
  const currentPrice = Number(src.currentPrice) || 0;
  const priority = normalizeCategoryPriority(src.priority);
  const weights = resolveCategoryWeights(src.weights, priority);
  const currentProductId = src.currentProductId ? String(src.currentProductId) : null;
  const brand = src.brand ? String(src.brand) : '';
  if (productName.length < 2) return { configured: false, mode: 'category', error: '상품명이 없어 카테고리 검색어를 만들 수 없어요.' };

  let query = null;
  let queryVia = 'rule';
  try {
    const ai = await categoryQueryWithGemini(productName, brand);
    if (ai) { query = ai; queryVia = 'gemini'; }
  } catch (e) { console.warn('[ShoMate] 카테고리 검색어 AI 실패(규칙 기반 사용):', e?.message || e); }
  if (!query) query = buildCategoryQuery({ productName, brand, model: src.model, specText: src.specText }).query;
  if (!query) return { configured: false, mode: 'category', error: '카테고리 검색어를 만들지 못했어요.' };
  const searchUrl = categorySearchUrl(query);

  let items;
  const hit = await readCatRecCache(query);
  if (hit) {
    items = hit.items;
  } else {
    let collected;
    try {
      collected = await collectViaBackgroundTab(searchUrl, REC_TAB_TIMEOUT_MS);
    } catch (e) {
      console.warn('[ShoMate] 카테고리 검색 수집 실패:', e?.message || e);
      return { configured: false, mode: 'category', error: catCollectErrorText(e, query), query, searchUrl };
    }
    items = normalizeCategoryItems(collected?.items);
    if (!items.length) {
      console.warn('[ShoMate] 카테고리 검색 수집 결과 0개:', searchUrl);
      return { configured: false, mode: 'category', error: catEmptyResultText(query), query, searchUrl };
    }
    await writeCatRecCache(query, items, searchUrl);
  }

  const r = rankCategoryItems(items, { query, tokens: categoryTokensOf(query), currentProductId, weights, currentPrice });
  if (!r.rankedCount) {
    const ec = r.excludedCounts;
    const why = [['광고', ec.ad], ['품절', ec.soldOut], ['지금 보던 상품', ec.current], ['액세서리', ec.accessory],
      ['규격 확인 불가', ec.noSpec], ['가격 이상치', ec.outlier], ['상세 주소 없음', ec.badUrl]]
      .filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join('·');
    return {
      configured: false, mode: 'category',
      error: `쿠팡 「${query}」 검색 결과에서 순위를 매길 상품을 찾지 못했어요` + (why ? ` (제외: ${why})` : '') + '.',
      query, searchUrl,
    };
  }
  const top = r.cards.slice(0, CATEGORY_TOP_N).map((card, i) => ({
    title: card.name, price: card.price, mall: '쿠팡', link: card.link, image: card.image,
    specText: r.ranked[i].specLabel || null, card,
  }));
  const result = {
    configured: true, mode: 'category', source: 'coupang-search',
    query, queryVia, searchUrl,
    candidateCount: r.candidateCount, rankedCount: r.rankedCount, excludedCounts: r.excludedCounts,
    guardian: r.guardian, note: buildCategoryNote(r), weights: r.weights, priority, unitMode: r.unitMode,
    lowest: null,
    items: top,
  };
  try {
    await chrome.storage.session.set({
      lastCategoryRank: { query, searchUrl, weights: r.weights, priority, currentProductId, savedAt: Date.now() },
    });
  } catch (_) {}
  return result;
}

// 계약 2.2: 사용자 버튼으로만 보이는 검색 탭을 연다. 빠진 값은 마지막 카테고리 순위(lastCategoryRank)로 채운다.
async function openRankedSearch(msg) {
  const m = msg || {};
  const last = (await getLastCategoryRank()) || {};
  const searchUrl = String(m.searchUrl || last.searchUrl || '');
  if (!isCoupangSearchUrl(searchUrl)) return { ok: false, error: '쿠팡 검색 주소가 아니라서 열지 않았어요' };
  const query = String(m.query || last.query || queryFromSearchUrl(searchUrl) || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const priority = normalizeCategoryPriority(m.priority || last.priority);
  const weights = resolveCategoryWeights(m.weights || last.weights, priority);
  const currentProductId = productIdFromUrl(m.sourceUrl) || last.currentProductId || null;
  const tab = await chrome.tabs.create({ url: searchUrl, active: true });
  if (tab?.id == null) return { ok: false, error: '쿠팡 검색 탭을 열지 못했어요. 잠시 뒤 다시 눌러 주세요.' };
  await setRankTab(tab.id, { query, weights, priority, currentProductId, openedAt: Date.now() });
  return { ok: true, tabId: tab.id };
}

// 계약 2.4: 검색 페이지 content script 가 읽은 항목에 순위를 매긴다. 설정은 그 탭의 rankTabs → lastCategoryRank → 기본값.
// 검색어는 페이지 주소의 q(사용자가 탭에서 검색어를 바꿨을 수 있다)를 먼저 쓴다.
async function rankSearchItemsForTab(message, sender) {
  const items = Array.isArray(message?.items) ? message.items : null;
  if (!items) return { ok: false, error: '페이지에서 읽어 온 상품 목록이 없어요.' };
  const conf = (await getRankTab(sender?.tab?.id)) || (await getLastCategoryRank()) || {};
  const pageQuery = isCoupangSearchUrl(message.url) ? queryFromSearchUrl(message.url) : null;
  const query = String(pageQuery || conf.query || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const priority = normalizeCategoryPriority(conf.priority);
  const weights = resolveCategoryWeights(conf.weights, priority);
  const r = rankCategoryItems(items, {
    query, tokens: categoryTokensOf(query), currentProductId: conf.currentProductId || null, weights,
  });
  return {
    ok: true, query, weights: r.weights, priority,
    candidateCount: r.candidateCount, rankedCount: r.rankedCount,
    guardianProductId: r.guardianProductId, unitMode: r.unitMode,
    ranked: r.ranked.map((c, i) => {
      const card = r.cards[i];
      return {
        productId: c.productId, rank: c.rank, scores: card.scores, dataInsufficient: card.dataInsufficient,
        link: card.link, name: card.name, price: card.price, unitPriceLabel: c.unitPriceLabel || null,
        reason: card.reason, tags: card.tags,
      };
    }),
    excluded: r.excluded,
  };
}

// 네이버 쇼핑 검색 API 는 2026-07-31 종료. 호출부 없음. 삭제 예정 (옵션 UI 의 키 입력란은 이번에 손대지 않는다).
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
    // 검색·카테고리 URL 은 절대 노출하지 않는다 — 개별 상품 상세 페이지로 확인된 것만 (recommendForProduct 와 같은 검증)
    .filter(l => validateDetailUrl(l.url).ok)
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
