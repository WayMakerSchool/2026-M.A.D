# ShoMate Gemini 프록시 (Cloudflare Worker)

`proxy/worker.js` 는 Cloudflare Workers 에 올리는 **Gemini 프록시**입니다.
배포 이름은 `shomate-proxy`, 주소는 `https://shomate-proxy.iseongjang74.workers.dev` 입니다.

> 이 문서에 나오는 대시보드 메뉴 이름은 2026-10 기준입니다. Cloudflare 가 화면을 바꾸면 이름이 조금 다를 수 있습니다.

## 1. 무엇이고, 확장의 어디서 쓰나

확장 번들에는 API 키를 넣지 않습니다(번들은 공개 파일이라 넣는 순간 공개된 키가 됩니다).
그래서 키는 이 Worker 의 **Secret** 에만 두고, Worker 가 키를 붙여 Gemini 를 대신 호출한 뒤 응답만 돌려줍니다.

```
확장(background.js) ──POST /gemini──▶ Worker ──x-goog-api-key 헤더──▶ Gemini API
```

- **계약은 `server/main.py` 와 같습니다.** `GET /health`, `POST /gemini` 의 요청·응답 모양, 모델 허용목록·티어,
  `generationConfig`/`tools` 정화, 400/404 일 때의 단계적 완화(① 그대로 → ② thinkingConfig 제거 → ③ tools 제거 →
  ④ `gemini-2.5-flash`), 오류 문구가 모두 같습니다. `tests/worker.test.js` 가 `main.py` 를 직접 읽어 값을 대조합니다.
- **확장 쪽 연결 지점**: `background.js` 의 `geminiRaw()` 는 ① 백엔드(`getBackendUrl()`, 기본 `http://localhost:8000`)
  → ② 사용자 본인 키 → ③ **프록시** 순으로 시도합니다. ③ 의 주소는 `getProxyUrl()` 이 정하며,
  `chrome.storage.local` 의 `geminiProxyUrl` 이 있으면 그 값, 없으면 상수 `GEMINI_PROXY_URL` 입니다.
  - 확장은 이 주소로 **그대로** POST 합니다. 그러니 값은 경로까지 포함한
    `https://shomate-proxy.iseongjang74.workers.dev/gemini` 여야 합니다.
  - 상수가 비어 있고 저장소 값도 없으면 ③ 경로는 쓰이지 않습니다. 설정 화면(options.html)에는 프록시 주소
    입력란이 없으므로 주소는 사실상 `GEMINI_PROXY_URL` 상수로 정해집니다.
  - 확장 설정의 **백엔드 서버 URL**(①)에 이 Worker 를 넣지 마세요. ① 은 같은 주소로 `/billing/*` 도 부르는데
    Worker 에는 결제 경로가 없어 결제가 깨집니다(7절).
  - 프록시 경로는 `license` 를 보내지 않습니다. 그래서 ③ 으로 오는 요청은 언제나 무료 티어로 처리되어
    Pro 모델을 골라도 기본 모델(`gemini-3.5-flash-lite`)로 내려갑니다.
- manifest 의 `host_permissions` 에 `workers.dev` 가 없어서, 확장의 요청은 CORS 검사를 받습니다.
  Worker 는 `chrome-extension://<32자 a~p>` 오리진에만 `Access-Control-Allow-Origin` 을 그대로 돌려줍니다.

## 2. 배포 (Cloudflare 대시보드)

1. Cloudflare 대시보드 → **Workers & Pages** → **shomate-proxy** 를 엽니다.
2. **Edit code** 를 누릅니다.
3. 편집기의 기존 코드를 **전부 지우고** `proxy/worker.js` 내용을 **처음부터 끝까지** 붙여넣습니다.
   (모듈 형식 `export default { async fetch(...) }` 입니다. 외부 패키지는 없습니다.)
4. **Deploy** 를 누릅니다.
5. 아래 4절의 확인 명령으로 새 코드가 올라갔는지 봅니다.

## 3. 시크릿·변수

**Settings → Variables and Secrets** 에서 추가합니다. 저장한 뒤 화면에 Deploy 버튼이 뜨면 눌러 반영합니다.

| 이름 | 종류 | 필수 | 설명 |
|---|---|---|---|
| `GEMINI_API_KEY` | **Secret** | 예 | Google AI Studio 에서 받은 Gemini 키. 없으면 `/health` 503, `/gemini` 503. |
| `SHOMATE_LICENSE_SECRET` | Secret | 아니오 | 결제 서버(`server/billing.py`)의 `.env` 값과 **같게**. 같아야 결제로 받은 라이선스 토큰을 Worker 가 인정합니다. 없으면 모든 요청이 무료 티어. |
| `ALLOWED_EXTENSION_IDS` | Text | 아니오 | 쉼표로 구분한 확장 ID 목록(`chrome://extensions` 에서 확인). 넣으면 그 ID 의 오리진에만 CORS 를 허용합니다. 개발용(압축 해제) 확장과 스토어 확장은 ID 가 다르니 둘 다 넣으세요. 비우면 형식이 맞는 모든 확장 허용. |
| `MAX_PROMPT_CHARS` | Text | 아니오 | 프롬프트 최대 글자 수. 기본 20000. |

- 키는 **Secret** 종류로 넣으세요. Text(평문 변수)로 넣으면 대시보드에서 값이 그대로 보입니다.
- 키는 코드·URL·확장 어디에도 쓰지 않습니다. Worker 는 업스트림에 키를 쿼리스트링(`?key=`)이 아니라 `x-goog-api-key` 헤더로 보냅니다.
- CLI 를 쓴다면 같은 일을 `npx wrangler secret put GEMINI_API_KEY` 로 할 수 있습니다.

## 4. 확인 명령

```bash
# 1) 헬스체크
curl -i https://shomate-proxy.iseongjang74.workers.dev/health
```

기대: `200` 과 `{"ok":true,"model":"gemini-2.5-flash","defaultModel":"gemini-3.5-flash-lite"}`
- `defaultModel` 이 보이면 **새 코드**입니다. 예전 배포본은 그 자리에 `"bindings":[...]` 를 냈습니다.
- `503 {"ok":false,"error":"GEMINI_API_KEY 미설정"}` 이면 시크릿이 없거나 이름이 틀렸습니다.

```bash
# 2) 최소 POST
curl -i -X POST https://shomate-proxy.iseongjang74.workers.dev/gemini \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"한 단어로만 답하세요: 맑은 하늘은 무슨 색?"}'
```

기대: `200` 과 Gemini 원본 JSON(`candidates[0].content.parts[0].text` 에 답, `modelVersion` 에 실제 응답 모델).

| 응답 | 뜻 |
|---|---|
| `400 {"error":"prompt 가 필요합니다"}` | 본문에 `prompt` 문자열이 없음 |
| `413` | 프롬프트가 `MAX_PROMPT_CHARS` 초과 |
| `503` | `GEMINI_API_KEY` 시크릿 없음 |
| `502 {"error":"AI 오류 (upstream 4xx/5xx)"}` | Gemini 가 거절. 원인은 응답에 싣지 않으니 로그에서 봅니다(아래) |
| `504 {"error":"AI 응답 시간 초과"}` | Gemini 가 30초 안에 답하지 않음 |
| `404 {"error":"없는 경로입니다"}` | `/health`, `/gemini` 외의 경로 |

`502` 일 때 업스트림 본문 확인: 대시보드 **shomate-proxy → Logs**(실시간 로그) 또는 `npx wrangler tail shomate-proxy`.
업스트림 상태별 흔한 원인 — `400`: 설정/키 형식(`API_KEY_INVALID` 등), `403`: 키 권한·API 비활성·키 제한,
`404`: 모델 이름/URL, `429`: 할당량 초과.

```bash
# 3) CORS 사전요청 (확장 ID 자리에 a~p 32자)
curl -i -X OPTIONS https://shomate-proxy.iseongjang74.workers.dev/gemini \
  -H 'Origin: chrome-extension://abcdefghijklmnopabcdefghijklmnop' \
  -H 'Access-Control-Request-Method: POST'
```

기대: `204` 와 `Access-Control-Allow-Origin: chrome-extension://abcdefghijklmnopabcdefghijklmnop`.
(`ALLOWED_EXTENSION_IDS` 를 넣었다면 그 목록의 ID 로 시험하세요. 목록 밖 ID 는 이 헤더가 없습니다.)

로컬 테스트(네트워크 없이 목으로 검증): 저장소 루트에서 `bash tests/run-all.sh`.

## 5. 키 교체 순서

노출된 적이 있는 키는 반드시 바꿉니다. 순서가 중요합니다 — 옛 키를 먼저 지우면 그 사이 서비스가 멈춥니다.

1. **새 키 발급**: Google AI Studio → API keys → 새 키 만들기.
2. **시크릿 갱신**: Worker 의 `GEMINI_API_KEY` 를 새 키로 바꾸고 배포. 로컬 서버를 쓴다면 `server/.env` 의 `GEMINI_API_KEY` 도 바꾸고 서버를 재시작.
3. **확인**: 4절의 `/health` 와 최소 POST 가 200 인지 봅니다.
4. **옛 키 삭제**: AI Studio(또는 Google Cloud 콘솔 → 사용자 인증 정보)에서 옛 키를 삭제합니다.

## 6. 레이트리밋 거는 법

Worker 에는 레이트리밋이 **없습니다.** Worker 인스턴스는 여러 곳에서 따로 떠서 메모리를 공유하지 않으므로,
메모리 카운터로는 제대로 셀 수 없기 때문에 일부러 넣지 않았습니다(`main.py` 의 분당 20회 제한은 단일 프로세스라서 가능했습니다).
CORS 오리진 검사는 브라우저 밖(curl 등)에서는 위조할 수 있으니 **인증이 아닙니다.** 아래 중 하나 이상을 거세요.

**A. Cloudflare Rate limiting rule (대시보드, 권장)**
- WAF 규칙은 **본인 도메인(zone)** 에 걸립니다. `*.workers.dev` 주소에는 걸 수 없습니다.
  1. Cloudflare 에 등록된 본인 도메인이 있다면: **shomate-proxy → Settings → Domains & Routes** 에서
     Custom domain(예: `ai.example.com`)을 붙입니다.
  2. 그 도메인의 대시보드 → **Security → WAF → Rate limiting rules** → **Create rule**.
  3. 조건: `URI Path` `equals` `/gemini` (필요하면 `Request Method` `equals` `POST` 추가).
  4. 기준: 같은 IP 기준, 예) 10초에 5회 초과 시 **Block**. 요금제에 따라 고를 수 있는 기간·기준이 다릅니다(무료 플랜은 선택지가 적습니다).
  5. 확장의 프록시 주소를 커스텀 도메인 주소로 바꾸고, **Settings → Domains & Routes** 에서 `workers.dev` 주소를 끄면 규칙을 우회할 길이 없어집니다.
- 본인 도메인이 없다면 B 를 쓰세요.

**B. Workers Rate Limiting 바인딩** — wrangler 설정에 `ratelimit` 바인딩을 추가하고 코드에서 `env.<바인딩>.limit({ key })` 를 호출하는 방식입니다. `workers.dev` 에서도 동작하지만 코드·설정 변경이 필요해 이번 버전에는 넣지 않았습니다.

**C. 비용 상한(최후의 방어선)** — Google Cloud 콘솔 → API 및 서비스 → Generative Language API → **할당량** 에서
분당 요청 수를 낮춰 둡니다. 남용이 있어도 청구액이 무한정 커지지 않습니다.

## 7. 한계

- **결제 경로가 없습니다.** `/billing/*` 는 404 입니다. 확장의 결제(업그레이드)는 `getBackendUrl()`
  (기본 `http://localhost:8000`, 로컬 FastAPI + `billing.py`)을 씁니다. 스토어 배포 후 다른 사용자가 결제하려면
  결제 서버를 따로 배포해야 합니다. 확장 설정의 **백엔드 서버 URL** 에 이 Worker 주소를 넣으면 AI 는 되지만 결제는 404 로 깨집니다.
- **라이선스는 검증만 합니다.** 발급은 결제 서버가 하고, Worker 는 `SHOMATE_LICENSE_SECRET` 으로 서명만 확인합니다.
  지금 확장의 프록시 경로는 `license` 를 보내지 않으므로 이 검증은 백엔드 경로처럼 `license` 를 실어 보낼 때만 의미가 있습니다.
- **메모리 레이트리밋이 없습니다.** 6절의 규칙을 거세요.
- 업스트림 오류 본문은 응답에 싣지 않습니다(키·내부 정보 유출 방지). 진단은 Logs / `wrangler tail` 에서만 봅니다.
- 원래 배포본의 소스는 로컬에 없어서, 이 파일은 `main.py` 계약을 기준으로 새로 쓴 것입니다. 배포 전 대시보드의 기존 코드를 따로 보관하고 싶다면 붙여넣기 전에 복사해 두세요.
