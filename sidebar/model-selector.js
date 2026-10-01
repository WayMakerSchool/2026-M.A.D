// ShoMate — AI 모델 선택기
// ─────────────────────────────────────────────────────────────
// 기존 React 번들(index-*.js)은 건드리지 않는다.
// 이 파일은 사이드패널 위에 떠 있는 독립 오버레이로만 동작하고,
// 선택 결과를 chrome.storage.local 에 쓴다.
// background.js 의 geminiRaw() 가 그 값을 읽어 백엔드로 넘긴다.
//
// Shadow DOM 을 쓰는 이유: 번들이 62KB 짜리 CSS(Tailwind 추정)를 싣고 있어
// 전역 스타일이 서로 새는 걸 막아야 한다.

// ⚠️ 모델 ID 는 Google 이 수시로 갱신한다. 추가/변경 전 현재 사용 가능한
//    목록을 반드시 확인할 것 → https://ai.google.dev/gemini-api/docs/models
const MODELS = [
  { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash Lite', desc: '가장 빠르고 가벼운 분석', tier: 'free',       badge: '무료' },
  { id: 'gemini-3.7-flash',      name: 'Gemini 3.7 Flash',      desc: '복잡한 다크패턴 추론',   tier: 'pro',        badge: '프리미엄' },
  { id: 'gemini-2.5-pro',        name: 'Gemini 2.5 Pro',        desc: '깊은 추론 · 리뷰 대량 분석', tier: 'enterprise', badge: '기업' },
];

// tier → billing.py 의 PLANS 키
const TIER_PLAN = { pro: 'pro', enterprise: 'proplus' };
const TIER_RANK = { free: 0, pro: 1, enterprise: 2 };
const DEFAULT_MODEL = 'gemini-3.5-flash-lite';

const CSS = `
:host { all: initial; }
.wrap { position: fixed; right: 12px; bottom: 70px; z-index: 2147483647;
  font: 13px/1.45 "Pretendard Variable", Pretendard, -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Segoe UI", "Noto Sans KR", sans-serif; }
.trigger { display: flex; align-items: center; gap: 5px; padding: 4px 9px;
  background: rgba(255,255,255,.92); color: #4E5968; border: 1px solid #E5E8EB; border-radius: 999px;
  box-shadow: 0 2px 8px rgba(25,31,40,.06); cursor: pointer; font-size: 11px; font-weight: 600; backdrop-filter: blur(4px); }
.trigger:hover { background: #fafaf9; }
.trigger .dot { width: 6px; height: 6px; border-radius: 50%; background: #2b7fff; flex: none; }
.menu { position: absolute; right: 0; bottom: calc(100% + 8px); width: 268px;
  background: #fff; border: 1px solid #e3e3e0; border-radius: 14px;
  box-shadow: 0 12px 32px rgba(0,0,0,.16); padding: 6px; }
.menu[hidden] { display: none; }
.row { display: flex; align-items: flex-start; gap: 10px; width: 100%;
  padding: 9px 10px; background: none; border: 0; border-radius: 9px;
  text-align: left; cursor: pointer; color: #111; }
.row:hover:not(.locked) { background: #f4f4f2; }
.row.locked { opacity: .62; }
.row.locked:hover { background: #f4f4f2; opacity: .85; }
.row .body { flex: 1; min-width: 0; }
.row .name { font-size: 14px; font-weight: 600; letter-spacing: -.01em; }
.row .desc { font-size: 12px; color: #6b6b66; margin-top: 1px; }
.badge { display: inline-block; margin-left: 6px; padding: 1px 6px; border-radius: 5px;
  font-size: 10px; font-weight: 700; vertical-align: 2px; }
.badge.free { background: #e7f5ec; color: #1a7f42; }
.badge.pro  { background: #fdf0dd; color: #a35c00; }
.badge.enterprise { background: #efe9fd; color: #6337c9; }
.check { flex: none; width: 16px; color: #2b7fff; font-weight: 700; text-align: center; }
.sep { height: 1px; background: #ececea; margin: 5px 8px; }
.foot { padding: 7px 10px 5px; font-size: 11.5px; color: #6b6b66; }
.trigger.mismatch .dot { background: #f59e0b; }
.trigger.mismatch { color: #a35c00; }
.foot a { color: #2b7fff; text-decoration: none; font-weight: 600; cursor: pointer; }
.foot a:hover { text-decoration: underline; }
@media (prefers-color-scheme: dark) {
  .trigger, .menu { background: #1f1f1e; border-color: #35352f; color: #e9e9e4; }
  .trigger { color: #e9e9e4; }
  .trigger:hover { background: #262624; }
  .row { color: #e9e9e4; }
  .row:hover:not(.locked) { background: #2a2a28; }
  .row .desc, .foot { color: #a3a39c; }
  .sep { background: #35352f; }
}
`;

function tierOf(sub) { return TIER_RANK[sub] === undefined ? 0 : TIER_RANK[sub]; }

async function readState() {
  const { selectedModel, subscription, aiLastModel } = await chrome.storage.local.get({
    selectedModel: DEFAULT_MODEL,
    subscription: 'free',
    aiLastModel: '',          // background.js 가 마지막 응답의 modelVersion 을 기록
  });
  return { selectedModel, subscription, aiLastModel };
}

// 실제로 답한 모델이 선택 모델과 다른가 (완화 사다리가 기준 모델로 대체한 경우 등).
// modelVersion 은 "gemini-2.5-flash" 또는 "gemini-2.5-flash-001" 형태.
function actualMismatch(state) {
  const a = (state.aiLastModel || '').trim();
  return a && !a.startsWith(state.selectedModel) ? a : '';
}

function build(root, state, onPick, onUpgrade) {
  const allowed = tierOf(state.subscription);
  const current = MODELS.find(m => m.id === state.selectedModel) || MODELS[0];

  root.innerHTML = '';
  const style = document.createElement('style');
  style.textContent = CSS;

  const wrap = document.createElement('div');
  wrap.className = 'wrap';

  const mismatch = actualMismatch(state);
  const trigger = document.createElement('button');
  trigger.className = 'trigger' + (mismatch ? ' mismatch' : '');
  trigger.type = 'button';
  trigger.title = mismatch ? `선택: ${current.id} · 실제 응답: ${mismatch}` : `실제 응답: ${state.aiLastModel || '(아직 없음)'}`;
  trigger.innerHTML = '<span class="dot"></span>';
  trigger.appendChild(document.createTextNode(current.name));
  if (mismatch) trigger.appendChild(document.createTextNode(' · 실제 ' + mismatch.replace(/^gemini-/, '')));

  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.hidden = true;

  for (const m of MODELS) {
    const locked = tierOf(m.tier) > allowed;
    const row = document.createElement('button');
    row.className = 'row' + (locked ? ' locked' : '');
    row.type = 'button';

    const body = document.createElement('div');
    body.className = 'body';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = m.name;
    const badge = document.createElement('span');
    badge.className = 'badge ' + m.tier;
    badge.textContent = locked ? '🔒 ' + m.badge : m.badge;
    name.appendChild(badge);
    const desc = document.createElement('div');
    desc.className = 'desc';
    desc.textContent = m.desc;
    body.append(name, desc);

    const check = document.createElement('div');
    check.className = 'check';
    check.textContent = m.id === current.id ? '✓' : '';

    row.append(body, check);
    row.addEventListener('click', () => {
      if (locked) { onUpgrade(TIER_PLAN[m.tier] || 'pro', m.name); return; }
      menu.hidden = true;
      onPick(m.id);
    });
    menu.appendChild(row);
  }

  const sep = document.createElement('div');
  sep.className = 'sep';
  const foot = document.createElement('div');
  foot.className = 'foot';
  foot.id = 'sm-foot';
  if (state.notice) {
    foot.textContent = state.notice;
  } else if (mismatch) {
    foot.textContent = `실제 응답 모델: ${mismatch} — 선택한 모델이 거부돼 대체됐습니다 (콘솔 [ShoMate] 로그 참고)`;
  } else if (allowed === 0) {
    foot.textContent = '잠긴 모델을 누르면 업그레이드가 열립니다';
  } else {
    foot.textContent = '현재 플랜: ' + state.subscription;
  }
  menu.append(sep, foot);

  trigger.addEventListener('click', (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; });
  document.addEventListener('click', () => { menu.hidden = true; });
  menu.addEventListener('click', (e) => e.stopPropagation());

  wrap.append(menu, trigger);
  root.append(style, wrap);

}

async function mount() {
  const host = document.createElement('div');
  host.id = 'shomate-model-selector';
  const root = host.attachShadow({ mode: 'open' });
  document.body.appendChild(host);

  let state = await readState();
  const render = () => build(
    root, state,
    async (id) => {                       // 모델 선택
      await chrome.storage.local.set({ selectedModel: id });
      state = { ...state, selectedModel: id };
      render();
    },
    (plan, modelName) => {                // 잠긴 모델 → 결제
      state = { ...state, notice: `${modelName} 결제창을 여는 중…` };
      render();
      chrome.runtime.sendMessage({ type: 'openUpgrade', plan }, (res) => {
        if (chrome.runtime.lastError) { state = { ...state, notice: '' }; render(); return; }
        if (res && res.ok) {
          readState().then(s2 => { state = { ...s2, notice: '' }; render(); });
        } else {
          const msg = (res && res.error) || '결제가 완료되지 않았습니다';
          state = { ...state, notice: msg === 'timeout' ? '결제 대기 시간이 지났습니다' : msg };
          render();
        }
      });
    }
  );
  render();

  // 다른 화면(옵션·결제 완료 등)에서 플랜이 바뀌면 즉시 반영
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (!changes.subscription && !changes.selectedModel && !changes.aiLastModel) return;
    readState().then(s => { state = s; render(); });
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount);
} else {
  mount();
}
