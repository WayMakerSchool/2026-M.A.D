# 결제 연동 (토스페이먼츠 테스트 모드)

## 실행

```bash
cd server
cp .env.example .env          # 최초 1회
# .env 에 GEMINI_API_KEY 를 채운다 (토스 키는 기본값으로 바로 동작)
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python main.py                # http://localhost:8000
```

확장 설정에서 백엔드 주소를 `http://localhost:8000` 으로 둔다 (기본값).

## 테스트 결제

1. 사이드패널 우하단 모델 버튼 클릭
2. 잠긴 모델(🔒 프리미엄 / 기업) 클릭 → 결제창 탭이 열림
3. 테스트 카드로 결제
   - 카드번호 `4330-1234-1234-1234`
   - 유효기간·비밀번호·생년월일은 아무 값
4. 완료되면 확장에 알림이 뜨고 해당 모델이 풀린다

실제 청구는 없다. `TOSS_SECRET_KEY` 가 `test_` 로 시작하는 한 토스 테스트망만 탄다.

## 흐름

```
확장 ──탭 열기──> GET /billing/checkout?plan=pro&sid=…   토스 결제창
토스 ──리다이렉트─> GET /billing/success?paymentKey&orderId&amount
                    서버가 시크릿키로 confirm 호출        ← 결제 확정은 여기서만
                    HMAC 서명 라이선스 토큰 발급
확장 ──폴링──────> GET /billing/status?sid=…  → { license }
확장 ──이후 매 요청─> POST /gemini { model, license }
                    서버가 서명 검증 → 티어 판정 → 모델 허용/차단
```

## 왜 서명 토큰인가

`chrome.storage.local` 의 `subscription:'pro'` 는 사용자가 DevTools 에서 한 줄로 바꾼다.
그래서 **티어 판정을 클라이언트에 두면 안 된다.** 서버가 HMAC 으로 서명한 토큰만
신뢰하고, `/gemini` 가 매 요청마다 서명을 검증해 모델을 결정한다.

검증된 방어(테스트 완료):

| 공격 | 결과 |
|---|---|
| payload 의 tier 를 enterprise 로 수정 | `free` 로 강등 |
| 서명 문자열 날조 | `free` |
| 만료된 토큰 | `free` |
| 다른 키로 서명한 토큰 | `free` |
| 허용목록에 없는 모델 요청 | 기본 모델로 대체 |
| 경로 조작 (`../`, `?key=`) | 허용목록에서 차단 |

## 운영 전환 전 반드시

- [ ] `TOSS_SECRET_KEY` 를 라이브 키로 교체
- [ ] `SHOMATE_LICENSE_SECRET` 고정 (안 하면 서버 재시작마다 전 사용자 구독 무효)
- [ ] `_ORDERS` / `_ISSUED` 를 DB 로 교체 — 지금은 프로세스 메모리
- [ ] 계정 로그인 — 지금은 `sid` 만 알면 토큰을 가져갈 수 있다
- [ ] 결제 취소·환불·구독 갱신 웹훅
- [ ] `SHOMATE_PUBLIC_URL` 을 실제 도메인으로 (토스 리다이렉트 대상)

## 알려진 제약

MV3 서비스워커는 유휴 30초에 종료된다. 결제 대기 폴링 중 워커가 죽으면
다음 기동 때 `pendingUpgradeSid` 로 30초간 재확인한다. 그 사이를 놓치면
사용자가 결제창을 다시 열어야 한다 — 운영에서는 웹훅으로 바꿀 것.
