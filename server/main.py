"""ShoMate 백엔드 — Gemini 프록시.

설계 원칙: **확장 프로그램 번들에는 API 키를 절대 넣지 않는다.**

확장은 키를 받아가지 않는다. 키를 내려주면 네트워크 탭·메모리에 그대로 노출되므로,
서버가 키를 들고 대신 Gemini를 호출한 뒤 응답만 돌려준다.
키는 이 서버의 환경변수(GEMINI_API_KEY)에만 존재한다.

    확장(background.js) ──POST /gemini──> 이 서버 ──키 첨부──> Gemini API

응답은 Gemini 원본 JSON을 그대로 돌려준다. background.js의 파싱 로직이 직접 호출
경로와 동일하게 동작하도록 하기 위함이다.
"""

from __future__ import annotations

import logging
import os
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from typing import Any, Dict, List, Optional

import httpx
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

try:  # .env 는 개발 편의용. 배포 환경에서는 실제 환경변수를 쓴다.
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:  # python-dotenv 미설치여도 동작해야 한다
    pass

from billing import router as billing_router, verify_license


log = logging.getLogger("shomate")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")


# ── 설정 ────────────────────────────────────────────────────────

def _env_int(key: str, default: int) -> int:
    try:
        return int(os.environ.get(key, "").strip() or default)
    except ValueError:
        return default


def _env_float(key: str, default: float) -> float:
    try:
        return float(os.environ.get(key, "").strip() or default)
    except ValueError:
        return default


GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "").strip() or "gemini-3.5-flash-lite"
GEMINI_URL_TMPL = (
    "https://generativelanguage.googleapis.com/v1beta/models/"
    "{model}:generateContent"
)
GEMINI_URL = GEMINI_URL_TMPL.format(model=GEMINI_MODEL)

# 티어별 허용 모델. 클라이언트가 보낸 model 문자열은 URL 경로에 들어가므로
# 절대 그대로 쓰지 않는다 — 이 목록에 없으면 기본 모델로 떨어뜨린다.
MODEL_TIERS = {
    "gemini-3.5-flash-lite": "free",
    "gemini-3.7-flash":      "pro",
    "gemini-2.5-pro":        "enterprise",
}
TIER_RANK = {"free": 0, "pro": 1, "enterprise": 2}
BASE_MODEL = "gemini-2.5-flash"   # 완화 사다리 마지막 단계 — 호출부 원래 설정이 검증된 모델

RATE_LIMIT_PER_MIN = _env_int("SHOMATE_RATE_LIMIT_PER_MIN", 20)
MAX_PROMPT_CHARS = _env_int("SHOMATE_MAX_PROMPT_CHARS", 20_000)
UPSTREAM_TIMEOUT_S = _env_float("SHOMATE_UPSTREAM_TIMEOUT_S", 30.0)

# 허용 확장 ID — 비우면 모든 chrome-extension:// 오리진 허용(개발용).
_raw_ids = os.environ.get("SHOMATE_ALLOWED_EXTENSION_IDS", "")
ALLOWED_EXTENSION_IDS = [x.strip() for x in _raw_ids.split(",") if x.strip()]

# tools 로 허용할 값 — 확장이 임의의 도구를 켜서 비용을 태우지 못하게 화이트리스트로 제한
ALLOWED_TOOL_KEYS = {"google_search"}

# generationConfig 로 허용할 키 — 알 수 없는 키는 버린다
ALLOWED_GEN_CONFIG_KEYS = {
    "temperature",
    "maxOutputTokens",
    "topP",
    "topK",
    "stopSequences",
    "responseMimeType",
    "thinkingConfig",
}
MAX_OUTPUT_TOKENS_CAP = _env_int("SHOMATE_MAX_OUTPUT_TOKENS", 4096)


# ── 레이트리밋 (IP당 슬라이딩 윈도) ──────────────────────────────
# 단일 프로세스 메모리 기반. 워커를 여러 개 띄우거나 수평 확장하면
# Redis 등 공유 저장소로 옮겨야 한다. (README 참고)
_hits: Dict[str, deque] = defaultdict(deque)


def _client_ip(request: Request) -> str:
    # 리버스 프록시(Cloud Run·Render·nginx) 뒤에 있을 때를 대비
    fwd = request.headers.get("x-forwarded-for", "")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _rate_limited(ip: str) -> bool:
    now = time.monotonic()
    window = _hits[ip]
    while window and now - window[0] > 60.0:
        window.popleft()
    if len(window) >= RATE_LIMIT_PER_MIN:
        return True
    window.append(now)
    # 오래된 IP 엔트리 정리 — 메모리 무한 증가 방지
    if len(_hits) > 10_000:
        for stale_ip in [k for k, v in _hits.items() if not v]:
            del _hits[stale_ip]
    return False


# ── 앱 ──────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    if not GEMINI_API_KEY:
        log.warning(
            "GEMINI_API_KEY 가 설정되지 않았습니다. /health 가 503 을 반환하고 "
            "확장은 자동으로 폴백 경로를 씁니다. server/.env 를 확인하세요."
        )
    app.state.http = httpx.AsyncClient(timeout=UPSTREAM_TIMEOUT_S)
    try:
        yield
    finally:
        await app.state.http.aclose()


app = FastAPI(title="ShoMate Backend", version="1.0.0", lifespan=lifespan)

# 크롬 확장의 서비스워커에서 fetch 하므로 오리진은 chrome-extension://<id> 이다.
if ALLOWED_EXTENSION_IDS:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[f"chrome-extension://{i}" for i in ALLOWED_EXTENSION_IDS],
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type"],
    )
else:
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"^chrome-extension://[a-z]{32}$",
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type"],
    )


app.include_router(billing_router)


class GeminiRequest(BaseModel):
    # Python 3.9 호환을 위해 `X | None` 대신 typing 구문을 쓴다.
    # pydantic 은 이 애노테이션을 런타임에 평가하므로 3.10+ 문법을 쓰면 부팅이 깨진다.
    prompt: str = Field(min_length=1)
    generationConfig: Optional[Dict[str, Any]] = None
    tools: Optional[List[Dict[str, Any]]] = None
    model: Optional[str] = None      # 사용자가 고른 모델 (허용목록으로 검증)
    license: Optional[str] = None    # 서버가 서명한 구독 토큰


@app.get("/health")
async def health():
    """확장이 30초 캐시로 호출한다. 키가 없으면 503 → 확장은 폴백 경로로 간다."""
    if not GEMINI_API_KEY:
        return JSONResponse(
            status_code=503,
            content={"ok": False, "error": "GEMINI_API_KEY 미설정", "model": GEMINI_MODEL},
        )
    return {"ok": True, "model": GEMINI_MODEL}


def _sanitize_generation_config(cfg: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if not isinstance(cfg, dict):
        return {}
    out = {k: v for k, v in cfg.items() if k in ALLOWED_GEN_CONFIG_KEYS}
    mot = out.get("maxOutputTokens")
    if isinstance(mot, (int, float)):
        out["maxOutputTokens"] = min(int(mot), MAX_OUTPUT_TOKENS_CAP)
    return out


def _sanitize_tools(tools: Optional[List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
    if not isinstance(tools, list):
        return []
    out: List[Dict[str, Any]] = []
    for t in tools:
        if isinstance(t, dict) and set(t.keys()) <= ALLOWED_TOOL_KEYS:
            out.append(t)
    return out


def _resolve_model(requested: Optional[str], tier: str) -> str:
    """요청 모델을 허용목록 + 구독 티어로 검증한다.

    티어는 서명된 라이선스에서만 나온다. 확장이 보내는 값은 신뢰하지 않는다.
    권한이 없거나 모르는 모델이면 조용히 기본 모델로 떨어뜨린다(요청은 살린다).
    """
    if not requested:
        return GEMINI_MODEL
    need = MODEL_TIERS.get(requested)
    if need is None:
        log.warning("허용목록에 없는 모델 요청: %r", requested[:40])
        return GEMINI_MODEL
    if TIER_RANK.get(tier, 0) < TIER_RANK[need]:
        log.info("티어 부족 (%s < %s) — 기본 모델로 대체", tier, need)
        return GEMINI_MODEL
    return requested


@app.post("/gemini")
async def gemini(body: GeminiRequest, request: Request):
    if not GEMINI_API_KEY:
        return JSONResponse(
            status_code=503,
            content={"error": "서버에 GEMINI_API_KEY 가 설정되지 않았습니다."},
        )

    ip = _client_ip(request)
    if _rate_limited(ip):
        return JSONResponse(
            status_code=429,
            content={"error": f"요청이 너무 많습니다. 분당 {RATE_LIMIT_PER_MIN}회까지 허용됩니다."},
        )

    if len(body.prompt) > MAX_PROMPT_CHARS:
        return JSONResponse(
            status_code=413,
            content={"error": f"프롬프트가 너무 깁니다({len(body.prompt)}자). 최대 {MAX_PROMPT_CHARS}자."},
        )

    tier = verify_license(body.license)          # 서명 검증 실패 시 "free"
    model = _resolve_model(body.model, tier)

    gen_cfg = _sanitize_generation_config(body.generationConfig)
    tools = _sanitize_tools(body.tools)

    # ── 업스트림 호출 + 단계적 완화 (확장의 geminiDirect 와 같은 순서) ──────────
    # 모델·설정 비호환(400)이나 이 키에서 안 열리는 모델(404)이면 502 로 끝내지 않고
    #   ① 그대로 → ② thinkingConfig 제거 → ③ tools 제거 → ④ 기준 모델 gemini-2.5-flash
    # 순으로 재시도한다. 401/403/429/5xx 는 완화해도 소용없으니 즉시 중단.
    # (2026-09-11: gemini-3.5-flash-lite 는 thinking 을 끌 수 없어 thinkingBudget 0 이 400 이었다)
    def _without_thinking(cfg: Dict[str, Any]) -> Dict[str, Any]:
        return {k: v for k, v in cfg.items() if k != "thinkingConfig"}

    plan: List[Any] = [(model, gen_cfg, tools, "")]
    if "thinkingConfig" in gen_cfg:
        plan.append((model, _without_thinking(gen_cfg), tools, "thinkingConfig 제거"))
    if tools:
        plan.append((model, _without_thinking(gen_cfg), [], "tools 제거"))
    if model != BASE_MODEL:
        # 기준 모델은 thinkingBudget 0 이 유효(호출부 원래 설정) — thinking 토큰이 출력 상한을 잠식하지 않게
        base_cfg = dict(_without_thinking(gen_cfg), thinkingConfig={"thinkingBudget": 0})
        plan.append((BASE_MODEL, base_cfg, tools, f"기준 모델 {BASE_MODEL} 로 대체"))

    last_status, last_text = 0, ""
    dead_models = set()
    for m, cfg, tls, why in plan:
        if m in dead_models:
            continue
        if why and last_status not in (400, 404):
            break
        if why:
            log.warning("Gemini %s → 재시도(%s): %s", last_status, why, last_text[:160])
        payload: Dict[str, Any] = {"contents": [{"parts": [{"text": body.prompt}]}]}
        if cfg:
            payload["generationConfig"] = cfg
        if tls:
            payload["tools"] = tls
        try:
            # 키는 헤더로 보낸다. 쿼리스트링에 넣으면 프록시·서버 액세스 로그에 남는다.
            res = await request.app.state.http.post(
                GEMINI_URL_TMPL.format(model=m),
                json=payload,
                headers={
                    "Content-Type": "application/json",
                    "x-goog-api-key": GEMINI_API_KEY,
                },
            )
        except httpx.TimeoutException:
            log.warning("Gemini 타임아웃 (%.1fs)", UPSTREAM_TIMEOUT_S)
            return JSONResponse(status_code=504, content={"error": "AI 응답 시간 초과"})
        except httpx.HTTPError as e:
            log.warning("Gemini 호출 실패: %s", e)
            return JSONResponse(status_code=502, content={"error": "AI 호출 실패"})

        if res.status_code == 200:
            if why:
                log.warning("'%s' 로 성공 — 설정/모델 점검 필요 (요청 모델 %s)", why, model)
            return JSONResponse(content=res.json())
        last_status, last_text = res.status_code, res.text
        if last_status == 404:
            dead_models.add(m)

    # 업스트림 에러 본문에 키가 섞여 나올 여지를 없애기 위해 그대로 전달하지 않는다
    log.warning("Gemini %s: %s", last_status, last_text[:300])
    return JSONResponse(
        status_code=502,
        content={"error": f"AI 오류 (upstream {last_status})"},
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)
