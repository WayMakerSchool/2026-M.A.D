#!/usr/bin/env bash
# 전체 테스트 실행. 저장소 루트에서 `bash tests/run-all.sh` 로 실행하세요.
# node 가 있으면 node 로, 없으면 macOS 기본 osascript 로 돌립니다.
set -u
cd "$(dirname "$0")/.." || exit 1

if command -v node >/dev/null 2>&1; then
  RUN() { node "$1"; }
elif command -v osascript >/dev/null 2>&1; then
  RUN() { osascript -l JavaScript "$1" 2>/dev/null; }
else
  echo "node 또는 osascript 가 필요합니다."; exit 1
fi

fail=0
for t in tests/price-sanity.test.js tests/dark-pattern.test.js; do
  echo "── $t ────────────────────────────────"
  RUN "$t" || fail=1
  echo
done

exit $fail
