"""ShoMate 결제 — 토스페이먼츠 **테스트 모드**.

⚠️ 테스트 키로만 동작한다. 실제 금액은 청구되지 않는다.
   단, 카드사 인증창은 실제 화면이 뜬다 — 토스 안내: "테스트용 국내 카드번호는 없어요.
   직접 발급받은 카드 정보를 입력해서 결제를 해도 테스트 환경에서는 실제로 돈이 출금되지 않는다."
   (https://docs.tosspayments.com/blog/how-to-test-toss-payments)

흐름
────
  확장 ──탭 열기──> GET /billing/checkout?plan=pro&sid=...   (토스 결제창)
                       ↓ 사용자가 테스트 카드로 결제
  토스 ──리다이렉트─> GET /billing/success?paymentKey&orderId&amount
                       ↓ 서버가 시크릿키로 confirm 호출  ← 결제 확정은 여기서만
                       ↓ HMAC 서명 라이선스 토큰 발급
  확장 ──폴링──────> GET /billing/status?sid=...  → { "license": "..." }  (구독)
                                                   → { "paid": {...} }      (상품 결제 → 홈 탭 구매 내역)

왜 이렇게 하나
──────────────
확장의 chrome.storage.local 에 subscription:'pro' 를 쓰는 방식은 사용자가
DevTools 에서 한 줄로 바꾼다. 그래서 티어 판정을 클라이언트에 두면 안 된다.
서버가 서명한 토큰만 신뢰하고, /gemini 가 그 서명을 검증해 모델을 허용한다.

운영 전환 전 반드시 할 것 (TODO)
────────────────────────────────
  1) TOSS_SECRET_KEY 를 라이브 키로 교체
  2) _ISSUED / _ORDERS 를 실제 DB 로 교체 (지금은 프로세스 메모리 → 재시작 시 소실)
  3) 계정 로그인 붙이기 — 지금은 sid 만 알면 토큰을 가져갈 수 있다
  4) 결제 취소/환불·구독 갱신 웹훅 처리
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from typing import Any, Dict, Optional

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, JSONResponse

router = APIRouter(prefix="/billing", tags=["billing"])

# ── 설정 ────────────────────────────────────────────────────────
# 토스 문서용 공개 테스트 키 — 'API 개별 연동 키'(ck/sk) 계열. v2 결제창 payment() 는 이 계열만 받는다.
# (주문서형·결제창형 연동 키 gck/gsk 를 넣으면 NOT_SUPPORTED_WIDGET_KEY, 예전 기본값 test_ck_docs_… 는 UNAUTHORIZED_KEY)
# 본인 키: 개발자센터 > API 키 > 'API 개별 연동 키' 의 클라이언트/시크릿 키.
TOSS_CLIENT_KEY = os.environ.get("TOSS_CLIENT_KEY", "").strip() \
    or "test_ck_D5GePWvyJnrK0W0k6q8gLzN97Eoq"
TOSS_SECRET_KEY = os.environ.get("TOSS_SECRET_KEY", "").strip() \
    or "test_sk_zXLkKEypNArWmo50nX3lmeaxYG5R"
TOSS_CONFIRM_URL = "https://api.tosspayments.com/v1/payments/confirm"

PUBLIC_BASE_URL = os.environ.get("SHOMATE_PUBLIC_URL", "").strip() or "http://localhost:8000"

# 라이선스 서명 키. 설정하지 않으면 부팅 시 임의 생성 → 서버 재시작하면 기존 토큰 무효.
LICENSE_SECRET = (os.environ.get("SHOMATE_LICENSE_SECRET", "").strip()
                  or secrets.token_hex(32)).encode()
LICENSE_TTL_S = 30 * 24 * 60 * 60  # 30일

IS_TEST_MODE = TOSS_SECRET_KEY.startswith("test_")

PLANS: Dict[str, Dict[str, Any]] = {
    "pro":     {"name": "ShoMate Pro",  "amount": 15900, "tier": "pro"},
    "proplus": {"name": "ShoMate Pro+", "amount": 59000, "tier": "enterprise"},
}

# 데모용 메모리 저장소 (TODO 2 참고)
_ORDERS: Dict[str, Dict[str, Any]] = {}   # orderId -> {plan, amount, sid, tier, name}
_ISSUED: Dict[str, str] = {}              # sid     -> license token
_PAID: Dict[str, Dict[str, Any]] = {}     # sid     -> 상품 결제 완료 정보 (확장이 폴링해 구매 내역에 기록)


# ── 라이선스 토큰 (HMAC 서명) ───────────────────────────────────
def _b64e(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _b64d(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def issue_license(tier: str, order_id: str) -> str:
    body = {"tier": tier, "order": order_id, "exp": int(time.time()) + LICENSE_TTL_S}
    payload = _b64e(json.dumps(body, separators=(",", ":")).encode())
    sig = _b64e(hmac.new(LICENSE_SECRET, payload.encode(), hashlib.sha256).digest())
    return f"{payload}.{sig}"


def verify_license(token: Optional[str]) -> str:
    """서명이 유효하면 tier, 아니면 'free'. 예외를 던지지 않는다."""
    if not token or "." not in token:
        return "free"
    payload, _, sig = token.partition(".")
    expected = _b64e(hmac.new(LICENSE_SECRET, payload.encode(), hashlib.sha256).digest())
    if not hmac.compare_digest(sig, expected):   # 타이밍 공격 방지
        return "free"
    try:
        body = json.loads(_b64d(payload))
    except Exception:
        return "free"
    if int(body.get("exp", 0)) < time.time():
        return "free"
    return str(body.get("tier") or "free")


# ── 결제창 ──────────────────────────────────────────────────────
_CHECKOUT_HTML = """<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ShoMate 결제</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css">
<script src="https://js.tosspayments.com/v2/standard"></script>
<style>
  :root{--brand:#6366f1;--brand-deep:#4f46e5;--ink:#191f28;--sub:#6b7684;--line:#e5e8eb;--bg:#f2f4f6}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);
       font-family:"Pretendard Variable",Pretendard,-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans KR",sans-serif;
       color:var(--ink);-webkit-font-smoothing:antialiased}
  .card{background:#fff;border-radius:24px;padding:28px 28px 24px;width:min(400px,calc(100vw - 32px));
        box-shadow:0 12px 40px rgba(25,31,40,.08)}
  .brand{display:flex;align-items:center;gap:8px;margin-bottom:22px}
  .mark{width:26px;height:26px;border-radius:8px;background:linear-gradient(135deg,#6366f1,#4338ca);
        display:grid;place-items:center;color:#fff;font-weight:900;font-size:13px}
  .wordmark{font-weight:800;font-size:15px;letter-spacing:-.01em}
  .pill{margin-left:auto;font-size:11px;font-weight:700;color:#8a6100;background:#fff4d6;border-radius:999px;padding:4px 9px}
  .label{font-size:12px;color:var(--sub);font-weight:600;margin-bottom:4px}
  h1{font-size:17px;font-weight:700;margin:0 0 16px;line-height:1.4;word-break:keep-all}
  .price{font-size:32px;font-weight:800;letter-spacing:-.03em;line-height:1.1}
  .per{color:var(--sub);font-size:13px;margin-top:6px}
  .status{margin-top:22px;padding:14px 16px;border-radius:14px;background:#f7f8fa;display:flex;align-items:center;gap:10px;
          font-size:13.5px;font-weight:600;color:var(--sub);min-height:50px}
  .status.err{background:#fff1f1;color:#c0392b}
  .spin{width:16px;height:16px;border-radius:50%;border:2.5px solid #d9dce2;border-top-color:var(--brand);
        animation:sp .8s linear infinite;flex:none}
  @keyframes sp{to{transform:rotate(360deg)}}
  .hidden{display:none}
  button{margin-top:14px;width:100%;padding:14px;border:0;border-radius:14px;background:var(--brand);
         color:#fff;font-size:15px;font-weight:700;cursor:pointer;font-family:inherit;transition:background .15s}
  button:hover{background:var(--brand-deep)} button:disabled{opacity:.5;cursor:default}
  details{margin-top:16px;font-size:12px;color:var(--sub);line-height:1.6}
  summary{cursor:pointer;font-weight:600;list-style:none;display:flex;align-items:center;gap:4px}
  summary::-webkit-details-marker{display:none}
  summary::after{content:"›";display:inline-block;transform:rotate(90deg);transition:transform .15s;font-size:14px}
  details[open] summary::after{transform:rotate(-90deg)}
  details p{margin:8px 0 0;padding-left:2px}
  .foot{margin-top:18px;font-size:11px;color:#8b95a1;text-align:center}
</style></head><body>
<div class="card">
  <div class="brand"><div class="mark">S</div><div class="wordmark">ShoMate</div><div class="pill">테스트 결제 · 실제 청구 없음</div></div>
  <div class="label">결제 상품</div>
  <h1>__PLAN_NAME__</h1>
  <div class="label">결제 금액</div>
  <div class="price">__AMOUNT__원</div>
  <div class="per">__PER__</div>
  <div class="status" id="status"><span class="spin" id="spin"></span><span id="msg">토스페이먼츠 결제창을 여는 중…</span></div>
  <button id="pay" class="hidden">결제창 다시 열기</button>
  <details>
    <summary>테스트 모드 안내</summary>
    <p>카드사 인증창은 실제 화면이 뜹니다. 토스페이먼츠는 테스트용 국내 카드번호를 제공하지 않아서, 본인 카드나 카드 앱으로 인증해야 진행됩니다. 인증을 마쳐도 <b>가상으로만 승인</b>되고 돈은 나가지 않습니다. 인증창을 닫으면 "인증을 취소하셨습니다"가 표시됩니다.</p>
  </details>
  <div class="foot">결제는 토스페이먼츠 결제창에서 진행되며, ShoMate는 카드 정보를 보거나 저장하지 않습니다.</div>
</div>
<script>
  const CFG = __CFG__;
  const btn = document.getElementById('pay');
  const status = document.getElementById('status');
  const spin = document.getElementById('spin');
  const msg = document.getElementById('msg');
  const toss = TossPayments(CFG.clientKey);
  const payment = toss.payment({ customerKey: TossPayments.ANONYMOUS });
  let opening = false;

  function setStatus(text, isErr) {
    msg.textContent = text;
    status.classList.toggle('err', !!isErr);
    spin.classList.toggle('hidden', !!isErr);
    btn.classList.toggle('hidden', !isErr);
  }

  async function open() {
    if (opening) return;
    opening = true; btn.disabled = true;
    setStatus('토스페이먼츠 결제창을 여는 중…', false);
    try {
      await payment.requestPayment({
        method: 'CARD',
        amount: { currency: 'KRW', value: CFG.amount },
        orderId: CFG.orderId,
        orderName: CFG.planName,
        successUrl: CFG.successUrl,
        failUrl: CFG.failUrl,
        card: { useEscrow: false, flowMode: 'DEFAULT', useCardPoint: false, useAppCardOnly: false }
      });
    } catch (e) {
      const code = e && e.code;
      if (code === 'USER_CANCEL') setStatus('결제창을 닫았어요. 다시 열 수 있어요.', true);
      else setStatus((e && e.message) ? e.message : '결제를 시작하지 못했습니다.', true);
    } finally { opening = false; btn.disabled = false; }
  }
  btn.addEventListener('click', open);
  setTimeout(open, 350);   // 페이지가 그려진 뒤 바로 결제창 오픈 (버튼 한 번 더 누를 필요 없음)
</script></body></html>"""


def _page(title: str, body: str, ok: bool = True) -> HTMLResponse:
    color = "#1a7f42" if ok else "#c0392b"
    icon = "✓" if ok else "!"
    icon_bg = "#e8f7ee" if ok else "#fff1f1"
    return HTMLResponse(f"""<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css">
<style>
body{{margin:0;min-height:100vh;display:grid;place-items:center;background:#f2f4f6;color:#191f28;
font-family:"Pretendard Variable",Pretendard,-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans KR",sans-serif;-webkit-font-smoothing:antialiased}}
.c{{background:#fff;border-radius:24px;padding:32px 28px;width:min(400px,calc(100vw - 32px));text-align:center;
box-shadow:0 12px 40px rgba(25,31,40,.08)}}
.brand{{display:flex;align-items:center;justify-content:center;gap:8px;margin-bottom:22px}}
.mark{{width:26px;height:26px;border-radius:8px;background:linear-gradient(135deg,#6366f1,#4338ca);display:grid;place-items:center;color:#fff;font-weight:900;font-size:13px}}
.wordmark{{font-weight:800;font-size:15px}}
.ico{{width:56px;height:56px;border-radius:50%;background:{icon_bg};color:{color};display:grid;place-items:center;margin:0 auto 14px;font-size:26px;font-weight:800}}
h1{{font-size:19px;margin:0 0 8px;color:{color};letter-spacing:-.01em}}
p{{color:#6b7684;font-size:14px;line-height:1.6;margin:0}}
button{{margin-top:22px;width:100%;padding:13px;border:0;border-radius:14px;background:#f2f4f6;color:#333d4b;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit}}
</style></head>
<body><div class="c"><div class="brand"><div class="mark">S</div><div class="wordmark">ShoMate</div></div>
<div class="ico">{icon}</div><h1>{title}</h1><p>{body}</p>
<button onclick="window.close()">이 창 닫기</button></div></body></html>""")


@router.get("/checkout")
async def checkout(plan: str = "pro", sid: str = "", amount: int = 0, name: str = ""):
    # amount 가 오면 '상품 결제' 모드 — 구독 플랜이 아니라 확장이 보고 있는 상품을 결제한다.
    # 이 경우 라이선스(플랜 승급)는 발급하지 않는다.
    if amount and int(amount) > 0:
        amt = max(100, min(int(amount), 10_000_000))
        cfg = {"name": (name or "상품 결제").strip()[:80], "amount": amt, "tier": None}
        order_id = f"shomate_item_{secrets.token_urlsafe(12)}"
    else:
        cfg = PLANS.get(plan)
        if not cfg:
            return _page("알 수 없는 플랜", f"'{plan}' 은(는) 없는 플랜입니다.", ok=False)
        order_id = f"shomate_{plan}_{secrets.token_urlsafe(12)}"

    # 금액을 서버에 기억해 둔다. success 로 돌아온 amount 를 그대로 믿으면
    # 사용자가 URL 의 금액을 100원으로 고쳐 보낼 수 있다.
    _ORDERS[order_id] = {"plan": plan, "amount": cfg["amount"], "sid": sid,
                         "tier": cfg.get("tier"), "name": cfg["name"]}

    js_cfg = json.dumps({
        "clientKey": TOSS_CLIENT_KEY,
        "amount": cfg["amount"],
        "orderId": order_id,
        "planName": cfg["name"],
        "successUrl": f"{PUBLIC_BASE_URL}/billing/success",
        "failUrl": f"{PUBLIC_BASE_URL}/billing/fail",
    }, ensure_ascii=False)

    html = (_CHECKOUT_HTML
            .replace("__PLAN_NAME__", cfg["name"])
            .replace("__AMOUNT__", f"{cfg['amount']:,}")
            .replace("__PER__", "월 구독" if cfg.get("tier") else "상품 결제 (테스트)")
            .replace("__CFG__", js_cfg))
    return HTMLResponse(html)


@router.get("/success")
async def success(request: Request, paymentKey: str = "", orderId: str = "", amount: int = 0):
    order = _ORDERS.get(orderId)
    if not order:
        return _page("주문을 찾을 수 없습니다", "결제창을 다시 열어주세요.", ok=False)
    if int(amount) != int(order["amount"]):
        # 리다이렉트 파라미터 위변조
        return _page("금액이 일치하지 않습니다", "결제가 취소되었습니다.", ok=False)

    auth = base64.b64encode(f"{TOSS_SECRET_KEY}:".encode()).decode()
    try:
        res = await request.app.state.http.post(
            TOSS_CONFIRM_URL,
            json={"paymentKey": paymentKey, "orderId": orderId, "amount": int(amount)},
            headers={"Authorization": f"Basic {auth}", "Content-Type": "application/json"},
        )
    except httpx.HTTPError:
        return _page("결제 확인 실패", "네트워크 오류로 확정하지 못했습니다.", ok=False)

    if res.status_code != 200:
        detail = ""
        try:
            detail = res.json().get("message", "")
        except Exception:
            pass
        return _page("결제가 승인되지 않았습니다", detail or f"토스 응답 {res.status_code}", ok=False)

    tier = order.get("tier") or (PLANS.get(order["plan"], {}) or {}).get("tier")
    if tier:                       # 구독 결제만 라이선스를 발급한다
        token = issue_license(tier, orderId)
        if order.get("sid"):
            _ISSUED[order["sid"]] = token
        note = "이 창을 닫으셔도 됩니다. 확장에 플랜이 곧 반영됩니다."
    else:                          # 상품 결제 — 확장이 폴링해서 홈 탭 구매 내역에 기록한다
        if order.get("sid"):
            _PAID[order["sid"]] = {"orderId": orderId, "name": order.get("name") or "상품 결제",
                                   "amount": int(amount), "paidAt": int(time.time() * 1000)}
        note = "이 창을 닫으셔도 됩니다. ShoMate 홈 탭의 구매 내역에 기록됩니다."
    _ORDERS.pop(orderId, None)

    return _page("결제가 완료되었습니다",
                 note + (" (테스트 모드 — 실제 청구 없음)" if IS_TEST_MODE else ""))


@router.get("/fail")
async def fail(code: str = "", message: str = ""):
    return _page("결제가 취소되었습니다", message or code or "다시 시도해 주세요.", ok=False)


@router.get("/status")
async def status(sid: str = ""):
    """확장이 폴링한다. 발급됐으면 한 번만 내주고 지운다.
    구독 → license 토큰, 상품 결제 → paid 정보."""
    token = _ISSUED.pop(sid, None) if sid else None
    if token:
        return JSONResponse({"pending": False, "license": token, "tier": verify_license(token)})
    paid = _PAID.pop(sid, None) if sid else None
    if paid:
        return JSONResponse({"pending": False, "paid": paid})
    return JSONResponse({"pending": True})


@router.get("/plans")
async def plans():
    return {"testMode": IS_TEST_MODE,
            "plans": [{"id": k, **v} for k, v in PLANS.items()]}
