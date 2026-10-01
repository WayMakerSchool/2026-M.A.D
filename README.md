# 🚀 ShoMate (Shopping Mate)

> 가격·품질·안정성을 함께 따져주고, 쇼핑몰이 숨겨둔 다크패턴을 실시간으로 잡아내는 크롬 확장 프로그램이에요.

<!-- 대표 이미지나 시연 GIF가 있다면 여기에 넣어주세요. -->

<br>

## 📖 프로젝트 소개

- **기간**: 2026.03.20 ~ 2026.12.03
- **프로젝트**: 2026 웹 프로젝트
- **소개**: 국내 주요 온라인 쇼핑몰의 64.3%가 다크패턴을 쓰고, 소비자의 72.1%가 그 때문에 불필요한 구매를 한 적이 있어요. 소비자가 합리적으로 못 고르는 건 능력의 문제가 아니라 쇼핑 환경의 문제라고 생각했어요. 온라인 쇼핑을 하는 모든 사람을 위해, 추천의 근거까지 함께 보여주는 중립적인 도구를 만들었어요.

<br>

## ✨ 주요 기능

| 기능 | 설명 |
| :-- | :-- |
| 실시간 다크패턴 감지 | 시간 압박·가짜 사회적 증거·재고 압박·숨은 자동결제·확인 쉐이밍·취소 방해·미리 선택된 체크박스를 찾아 페이지 위에 경고를 띄워요. |
| 근거 기반 판정 | 단정하지 않고, 페이지에서 실제로 관측한 문구를 근거로 함께 보여줘요. |
| 카운트다운 시간 관측 | 카운트다운이 0에서 되돌아가는지 직접 지켜보고 가짜 마감을 확인해요. |
| 3축 종합 점수화 | 가격·품질·안정성을 점수로 매기고 1위 상품에 가디언 배지를 줘요. |
| 가격 교차 검증 | 세 가지 소스를 대조해 가격이 10배로 잘못 읽히는 오류를 걸러내요. |
| 리뷰 인텔리전스 | 리뷰를 요약하고 가짜 리뷰 위험도와 주요 불만을 알려줘요. |
| 결제 최적화 | 등록한 멤버십 혜택을 계산해 최종 체감가를 보여줘요. |
| 가격 하락 알림 | 목표가를 등록하면 가격을 지켜보다가 떨어지면 알려줘요. |
| AI 상품 Q&A | 상품에 대해 궁금한 걸 자유롭게 물어볼 수 있어요. |

<br>

## 🛠 기술 스택

- **언어**: JavaScript, HTML, CSS, Python
- **프레임워크 / 라이브러리**: React, Tailwind CSS, framer-motion, FastAPI, Firebase
- **도구**: Chrome Extension API (Manifest V3), Google Gemini API, 네이버 검색 API

<br>

## 👥 팀원

| <img src="https://github.com/iseongjang74-code.png" width="100"> |
| :--: |
| [데릭](https://github.com/iseongjang74-code) |
| 개발 |

<br>

## ▶️ 실행 방법

```bash
# 1. 저장소 받기
git clone https://github.com/WayMakerSchool/2026-M.A.D.git

# 2. 크롬에서 chrome://extensions 접속 → 개발자 모드 켜기
#    → '압축해제된 확장 프로그램을 로드' → 받은 폴더 선택

# 3. AI 분석 서버 띄우기 (API 키는 서버에만 둬요)
cd 2026-M.A.D/server
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env            # .env 에 GEMINI_API_KEY 입력
.venv/bin/python -m uvicorn main:app --port 8000
```

<br>

## 📁 폴더 구조

```
.
├── manifest.json        # 확장 프로그램 설계도 (권한, 서비스워커)
├── background.js        # AI 호출, 가격 감시 알람, 결제 연동
├── content-script.js    # 상품 정보 수집, 다크패턴 감지
├── options.html         # 설정 페이지 (API 키 입력)
├── options.js
├── sidebar/             # 사이드패널 화면
│   ├── index.html
│   ├── model-selector.js
│   └── assets/
├── server/              # 분석 서버 (FastAPI)
│   ├── main.py          #   Gemini 프록시 — API 키는 서버에만 둬요
│   ├── billing.py       #   결제 처리
│   └── .env.example     #   .env 는 Git에 올리지 않아요
├── tests/               # 테스트
├── icons/               # 아이콘
├── .gitignore           # Git에 올리지 않을 파일 목록
└── README.md            # 지금 보고 있는 문서
```

<br>

## 🤝 협업 규칙

- **브랜치**
  - `develop`: 개발용 기본 브랜치. 모든 작업은 여기서 시작해요.
  - `feat/기능이름`, `fix/버그이름`: `develop`에서 만들어서 작업하고, PR로 `develop`에 합쳐요.
  - `main`: 발표나 배포할 때만 `develop`을 합쳐요.
- **커밋 메시지**: `feat: 로그인 기능 추가`, `fix: 버튼 클릭 오류 수정`, `docs: README 수정`
