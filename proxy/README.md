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
  - 예외 하나: 업스트림 최종 실패(502) 때 Worker 는 `main.py` 와 같은 `AI 오류 (upstream N` 으로 시작하는 문구 뒤에
    원인을 덧붙이고 `upstreamStatus`·`reason`·`detail`·`colo` 필드를 더 싣습니다(4절 표, 8절). `/health` 에도 `colo` 가 있습니다.
- **확장 쪽 연결 지점**: `background.js` 의 `geminiRaw()` 는 ① 백엔드(`getBackendUrl()`, 기본 `http://localhost:8000`)
  → ② 사용자 본인 키 → ③ **프록시** 순으로 시도합니다. ③ 의 주소는 `getProxyUrl()` 이 정하며,
  `chrome.storage.local` 의 `geminiProxyUrl` 이 있으면 그 값, 없으면 상수 `GEMINI_PROXY_URL` 입니다.
  - 확장은 이 주소로 **그대로** POST 합니다. 그러니 값은 경로까지 포함한
    `https://shomate-proxy.iseongjang74.workers.dev/gemini` 여야 합니다.
  - 상수가 비어 있고 저장소 값도 없으면 ③ 경로는 쓰이지 않습니다. 설정 화면(options.html)에는 프록시 주소
    입력란이 없으므로 주소는 사실상 `GEMINI_PROXY_URL` 상수로 정해집니다.
  - 확장 설정의 **백엔드 서버 URL**(①)에 이 Worker 를 넣지 마세요. ① 은 같은 주소로 `/billing/*` 도 부르는데
    Worker 에는 결제 경로가 없어 결제가 깨집니다(7절).
  - 프록시 경로도 백엔드 경로와 같이 `license` 를 보냅니다. Worker 에 `SHOMATE_LICENSE_SECRET` 이 없으면
    서명을 확인할 수 없어 모든 요청이 무료 티어(`gemini-3.5-flash-lite`)로 처리됩니다.
- manifest 의 `host_permissions` 에 `workers.dev` 가 없어서, 확장의 요청은 CORS 검사를 받습니다.
  Worker 는 `chrome-extension://<32자 a~p>` 오리진에만 `Access-Control-Allow-Origin` 을 그대로 돌려줍니다.

## 2. 배포 (Cloudflare 대시보드)

1. Cloudflare 대시보드 → **Workers & Pages** → **shomate-proxy** 를 엽니다.
2. **Edit code** 를 누릅니다.
3. 편집기의 기존 코드를 **전부 지우고** `proxy/worker.js` 내용을 **처음부터 끝까지** 붙여넣습니다.
   (모듈 형식 `export default { async fetch(...) }` 입니다. 외부 패키지는 없습니다.)
4. **Deploy** 를 누릅니다.
5. 아래 4절의 확인 명령으로 새 코드가 올라갔는지 봅니다.

CLI 로 배포하려면 `proxy/wrangler.toml` 을 씁니다(8절 (b)). 그 설정에는 실행 위치를 한국 근처로 고정하는 배치(Placement) 힌트가 들어 있습니다.

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

기대: `200` 과 `{"ok":true,"model":"gemini-2.5-flash","defaultModel":"gemini-3.5-flash-lite","colo":"ICN"}`
- `defaultModel` 이 보이면 **새 코드**입니다. 예전 배포본은 그 자리에 `"bindings":[...]` 를 냈습니다.
- `colo` 는 요청이 닿은 Cloudflare 데이터센터 코드입니다(`ICN` 서울, `HKG` 홍콩 …). `HKG` 면 8절을 보세요.
  키에 관한 정보는 `/health` 에 싣지 않습니다.
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
| `502 {"error":"AI 오류 (upstream 4xx/5xx…)", …}` | Gemini 가 거절. 원인 필드는 아래 |
| `504 {"error":"AI 응답 시간 초과"}` | Gemini 가 30초 안에 답하지 않음 |
| `404 {"error":"없는 경로입니다"}` | `/health`, `/gemini` 외의 경로 |

업스트림 최종 실패(`502`) 응답 본문:

```json
{"error":"AI 오류 (upstream 400: 지원하지 않는 지역 HKG)","upstreamStatus":400,
 "reason":"FAILED_PRECONDITION","detail":"User location is not supported for the API use.","colo":"HKG"}
```

| 필드 | 뜻 |
|---|---|
| `error` | 확장 사이드바에 그대로 보이는 짧은 문구. 앞부분은 예전과 같은 `AI 오류 (upstream N` |
| `upstreamStatus` | Gemini 가 돌려준 HTTP 상태 |
| `reason` | Google 오류의 `status`(예: `FAILED_PRECONDITION`, `INVALID_ARGUMENT`). 없으면 `null` |
| `detail` | Google 오류의 `message` 를 160자 이내로 자른 것(키 모양 문자열은 `<KEY>` 로 가림). 없으면 `null` |
| `colo` | 요청이 닿은 Cloudflare 데이터센터 코드. 모르면 `null` |

`error` 에 붙는 원인: `지원하지 않는 지역 XXX`(8절) · `API 키가 올바르지 않음`(5절로 키 확인) ·
`모델을 찾을 수 없음`(404, 모델 이름/URL) · 그 밖에는 `reason` 값(예: `429: RESOURCE_EXHAUSTED` 는 할당량 초과,
`403: PERMISSION_DENIED` 는 키 권한·API 비활성·키 제한). 원인을 모르면 예전 문구 `AI 오류 (upstream N)` 그대로입니다.

업스트림 **원문 본문 전체**는 응답에 싣지 않습니다(`details` 등 다른 필드에 무엇이 섞일지 통제할 수 없어서).
원문은 로그에만 남습니다: 대시보드 **shomate-proxy → Logs**(실시간) 또는 `npx wrangler tail shomate-proxy`,
CLI 로 배포해 로그 보존을 켰다면 **shomate-proxy → Observability**.

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
  확장은 프록시 경로에서도 `license` 를 보내므로, 결제 서버와 같은 시크릿을 넣어야 유료 티어가 인정됩니다.
- **메모리 레이트리밋이 없습니다.** 6절의 규칙을 거세요.
- 업스트림 오류 원문 본문 전체는 응답에 싣지 않습니다(키·내부 정보 유출 방지). 응답에는 Google 오류의 `status`·`message`(정리본)와
  `colo` 만 실리고(4절), 원문은 Logs / `wrangler tail` / Observability 에서만 봅니다.
- **실행 위치를 코드로 정할 수 없습니다.** Cloudflare 는 기본적으로 요청이 닿은 데이터센터에서 Worker 를 실행합니다.
  그곳이 Gemini 가 막는 지역(홍콩 등)이면 키·코드가 멀쩡해도 400 이 납니다 — 8절의 배치 설정이 필요합니다.
- 원래 배포본의 소스는 로컬에 없어서, 이 파일은 `main.py` 계약을 기준으로 새로 쓴 것입니다. 배포 전 대시보드의 기존 코드를 따로 보관하고 싶다면 붙여넣기 전에 복사해 두세요.

## 8. 지역 문제 (홍콩)

### 증상 (2026-10-08 실측)

- `GET /health` 는 `200 ok:true`(키 등록됨)인데 `POST /gemini` 가 모델과 무관하게 `502 {"error":"AI 오류 (upstream 400)"}`.
- 8번 모두 응답 헤더 `cf-ray` 끝의 데이터센터 코드가 `HKG`(홍콩).
- 같은 키·같은 요청을 한국에서 로컬 FastAPI(`server/main.py`)로 보내면 `200`.
- 지금 코드는 원인을 응답에 바로 보여 줍니다:
  `502 {"error":"AI 오류 (upstream 400: 지원하지 않는 지역 HKG)", "reason":"FAILED_PRECONDITION", "colo":"HKG", …}`,
  그리고 `/health` 의 `"colo":"HKG"`.

### 원인

- Gemini API 는 호출한 쪽 IP 의 지역을 보고, 홍콩에서 온 호출은
  `400 FAILED_PRECONDITION` — "User location is not supported for the API use." 로 거절합니다.
- Worker 는 기본적으로 **요청이 닿은 Cloudflare 데이터센터**에서 실행되고, Cloudflare 는 그 위치를 보장하지 않습니다.
  한국에서 보낸 요청도 통신사 경로에 따라 홍콩 데이터센터로 들어가 거기서 Gemini 를 부를 수 있습니다.
- 키·코드 문제가 아니므로 키를 바꿔도 낫지 않습니다. Worker 를 **어디서 실행할지(배치, Placement)** 를 정해야 합니다.

### 해결 (a) 대시보드 — Smart 배치

공식 문서(<https://developers.cloudflare.com/workers/configuration/placement/>, 2026-10-08 확인)의 경로:

1. **Workers & Pages** → **shomate-proxy** 선택
2. **Settings** → **General**
3. **Placement** 에서 **Smart** 선택

대시보드에 해당 메뉴가 없으면 (b) 를 쓰세요. Smart 에는 한계가 있습니다:

- **바로 반영되지 않습니다.** 문서: 배포 후 분석에 최대 15분이 걸리고, 여러 지역에서 꾸준한 트래픽이 있어야 결정합니다.
  요청이 적으면 `INSUFFICIENT_INVOCATIONS` 상태로 남고, 그동안은 기본 위치(요청이 닿은 곳 — 여기서는 홍콩)에서 계속 실행됩니다.
- **홍콩에 남을 수 있습니다.** Smart 는 백엔드까지 지연이 짧은 곳을 고를 뿐 Google 의 지역 제한은 모릅니다.
  Google 의 접점은 홍콩에도 있으므로 "홍콩이 이미 가장 가깝다"고 보고 옮기지 않을 수 있습니다. 그러면 (b) 로 가세요.

### 해결 (b) CLI — region 힌트로 한국 근처에 고정 (확실한 쪽)

`proxy/wrangler.toml` 에 배치 힌트가 들어 있습니다. 문법은 공식 문서 그대로입니다
(<https://developers.cloudflare.com/changelog/2026-01-22-explicit-placement-hints/>):

```toml
[placement]
region = "gcp:asia-northeast3"   # GCP 서울 리전과 지연이 가장 짧은 Cloudflare 데이터센터에서 실행
```

- region 값은 `"<공급자>:<리전 ID>"` 형식입니다(`aws:` / `gcp:` / `azure:`). 같은 서울을 AWS 로 쓰면 `"aws:ap-northeast-2"`.
  `gcp:asia-east2`(홍콩)·`gcp:asia-east1`(대만)은 쓰지 마세요.
- `mode = "smart"` 와 `region` 은 함께 쓸 수 없습니다(문서: mutually exclusive). 문서에는 region 힌트를 대시보드에서
  넣는 방법이 없어서 wrangler 설정으로 배포합니다.

절차 — **node 가 필요합니다**(<https://nodejs.org> 의 LTS 설치. `npx` 가 node 에 들어 있습니다):

```bash
cd proxy                     # wrangler.toml 이 있는 폴더에서 실행 (main = "worker.js" 가 이 폴더 기준)
npx wrangler login           # 브라우저가 열리면 Cloudflare 계정으로 직접 승인
npx wrangler deploy          # proxy/worker.js + wrangler.toml 설정(배치·로그 보존)으로 shomate-proxy 를 덮어씀
```

- 키는 이미 대시보드 Secret 에 있으면(`/health` 가 `ok:true`) 다시 넣을 필요가 없습니다. 시크릿은 코드 배포로 지워지지 않습니다.
  새로 넣거나 바꿀 때만 **본인이 직접** `npx wrangler secret put GEMINI_API_KEY` 를 실행하고, 묻는 프롬프트에 키를 붙여넣습니다
  (키를 명령줄 인자·파일·`wrangler.toml` 에 쓰지 마세요 — 셸 기록과 저장소에 남습니다).
- `wrangler deploy` 는 대시보드에서 고친 코드를 `proxy/worker.js` 로 덮어씁니다 — 이 저장소가 기준입니다.
  대시보드의 평문 변수(`ALLOWED_EXTENSION_IDS`, `MAX_PROMPT_CHARS`)는 `wrangler.toml` 의 `keep_vars = true` 로 지킵니다.
- `[observability] enabled = true` 로 로그가 보존됩니다. 다음에 502 가 나면 **shomate-proxy → Observability** 에서
  지난 요청의 업스트림 원문을 볼 수 있습니다.
- 서울 힌트로도 지역 오류가 계속되면 `region = "gcp:asia-northeast1"`(도쿄)로 바꿔 다시 배포해 보세요.

### 확인 방법

```bash
# 1) 헤더까지 보기 (-i)
curl -i https://shomate-proxy.iseongjang74.workers.dev/health
```

- 본문의 `colo` 가 `HKG` 가 아니면(예: `ICN`) 이 요청은 홍콩이 아닌 곳에 닿은 것입니다.
- **주의**: 공식 문서에서 `colo` 는 "요청이 닿은 데이터센터"입니다. 배치가 켜지면 코드는 다른 데이터센터로 옮겨 실행될 수 있으므로,
  배치를 켠 뒤에도 `colo` 가 `HKG` 로 보일 수 있습니다(통신사 경로는 그대로이므로). 그때는 응답 헤더 **`cf-placement`** 를 봅니다 —
  문서: 배치가 켜져 있으면 Cloudflare 가 붙이며, `remote-XXX` 는 배치로 옮겨져 XXX 근처에서 실행, `local-XXX` 는 옮겨지지 않고
  XXX(요청이 닿은 곳)에서 실행입니다. `local-HKG` 면 아직 홍콩에서 실행 중입니다.
  (문서는 이 헤더가 Smart Placement 베타 종료 전에 없어질 수 있다고 적고 있습니다.)

```bash
# 2) 최종 판단 — 실제 호출이 200 인지
curl -i -X POST https://shomate-proxy.iseongjang74.workers.dev/gemini \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"한 단어로만 답하세요: 맑은 하늘은 무슨 색?"}'
```

- `200` 이면 해결입니다. 여전히 `502 … 지원하지 않는 지역 …` 이면 배치가 아직 반영되지 않았거나(a 의 한계) 힌트가 빠진 채
  배포된 것입니다 — `cf-placement` 헤더와 대시보드 **Settings → General → Placement** 를 확인하세요.
