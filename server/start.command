#!/bin/bash
# ShoMate 결제·AI 서버 실행 — Finder에서 더블클릭(또는 터미널에서 `bash start.command`)
# 이 창을 닫으면 서버가 꺼집니다. 오류가 나면 창이 바로 닫히지 않고 내용이 남습니다.
cd "$(dirname "$0")" || { echo "폴더 이동 실패"; read -n 1 -s -r -p "아무 키나 누르면 닫힙니다"; exit 1; }
xattr -d com.apple.quarantine "$0" 2>/dev/null   # 다운로드 표시가 붙어 있으면 제거 (무해)
# 화면 출력을 start.log 에도 남긴다 (원격 진단용)
: > start.log; exec > >(tee -a start.log) 2>&1

pause() { echo; read -n 1 -s -r -p "▶ 아무 키나 누르면 이 창이 닫힙니다"; echo; }

echo "════════════════════════════════════════════"
echo "  ShoMate 서버 준비 중…"
echo "════════════════════════════════════════════"

# 1) 파이썬 확인
if ! command -v python3 >/dev/null 2>&1; then
  echo "❌ python3 이 없습니다. https://www.python.org/downloads/ 에서 설치 후 다시 실행하세요."; pause; exit 1
fi
echo "• 시스템 python3: $(python3 --version 2>&1)"

# 2) 가상환경 — 깨져 있으면(파이썬 경로 소실 등) 새로 만든다
if [ ! -x .venv/bin/python ] || ! .venv/bin/python -c "import sys" >/dev/null 2>&1; then
  echo "• 가상환경 생성/복구 중…"
  rm -rf .venv 2>/dev/null
  python3 -m venv .venv || { echo "❌ 가상환경 생성 실패"; pause; exit 1; }
fi
# shellcheck disable=SC1091
. .venv/bin/activate
echo "• 가상환경 python: $(python --version 2>&1)"

# 3) 의존성
echo "• 의존성 확인 중… (처음엔 1~2분)"
pip install -q -r requirements.txt || { echo "❌ 의존성 설치 실패 — 네트워크 확인"; pause; exit 1; }
python -c "import fastapi, uvicorn, httpx, dotenv" 2>/dev/null || { echo "❌ 패키지 import 실패"; pip install -r requirements.txt; pause; exit 1; }

# 4) 포트 8000 이미 사용 중이면 알림
PIDS=$(lsof -nP -iTCP:8000 -sTCP:LISTEN -t 2>/dev/null)
if [ -n "$PIDS" ]; then
  for P in $PIDS; do
    if ps -p "$P" -o command= | grep -Eq "main\.py|uvicorn"; then
      echo "• 이전 ShoMate 서버(PID $P) 종료 후 재시작합니다"; kill "$P" 2>/dev/null; sleep 1
    else
      echo "⚠ 포트 8000 을 다른 프로그램(PID $P)이 쓰고 있습니다:"; ps -p "$P" -o command=; pause; exit 1
    fi
  done
fi

echo
echo "════════════════════════════════════════════"
echo "  ShoMate 서버 실행 중 — http://localhost:8000"
echo "  확인: 크롬에서 http://localhost:8000/billing/plans 열면 JSON 이 보여야 합니다"
echo "  이 창을 닫으면 서버가 꺼집니다."
echo "════════════════════════════════════════════"
echo
python main.py
echo
echo "서버가 종료되었습니다."
pause
