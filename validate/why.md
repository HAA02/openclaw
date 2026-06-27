# Why 게이트 결과

> 생성: 2026-06-27 | PreFlight Phase 1

## 검증 목표

**openclaw + DisBot + Consilium 통합 시스템**: 로컬 LLM(Ollama) 기반 24시간 루프 엔지니어링 비서.
사용자 명령 → 토론(Consilium 방식) → 코드 생성 → 검증 루프를 openclaw 플러그인 체계 위에서 실행.

---

## 추론 체인 5문

| #   | 질문              | 내용                                                                                                                                                                                                                                                                                               | 출처                                                                                               |
| --- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 1   | **문제 정의**     | openclaw는 멀티채널 AI 게이트웨이지만 자율 루프 엔지니어링이 없음. Consilium은 토론/자가개발 루프가 있으나 채널 전달 없음. DisBot은 로컬 LLM + 24시간이 있으나 목표 관리 없음. 세 시스템이 **단절**돼 있어 사용자가 수동으로 오가야 한다.                                                          | [사용자], [코드:openclaw/extensions/], [코드:Consilium/src/], [코드:DisBot/ollama_executor.py]     |
| 2   | **진짜 문제인가** | 영향 대상: 사용자 단독. 발생 빈도: 매 개발 세션마다. openclaw는 Ollama 공급자 없음 (extensions/ 전체 검색 시 ollama 플러그인 미확인). Consilium은 채널 없이 FastAPI UI만 존재. DisBot은 Discord 단일 채널 + 목표 상태 머신 없음. 세 시스템이 실제로 분리된 것은 **코드로 확인된 사실**.            | [코드:openclaw/extensions/ — ollama 미존재], [코드:Consilium/webapi/main.py], [코드:DisBot/bot.py] |
| 3   | **왜 지금인가**   | 사용자가 세 프로젝트를 모두 보유하고 있고, openclaw는 fork 상태로 커스텀 플러그인 추가가 가능한 시점. Consilium은 Cycle 6 완료(374 tests pass) — 안정적인 API 진입점이 생겼음. 지금이 통합 시도 최적 시점.                                                                                         | [사용자], [코드:Consilium/PROGRESS.md — Cycle 6 COMPLETE]                                          |
| 4   | **안 만들면**     | 세 도구를 수동으로 병행 사용. 루프 엔지니어링을 시작할 때마다 Consilium WebUI → 결과 복사 → openclaw 채널 전달 → DisBot 수동 실행의 반복. **자동화 없이는 "24시간 비서"가 불가**.                                                                                                                  | [사용자]                                                                                           |
| 5   | **성공 기준**     | (1) Telegram/Discord 등 openclaw 채널에 명령 입력 → Consilium 토론 루프 트리거 → 결과 채널 반환 완료. (2) Ollama 모델로 24시간 비용 없이 동작 가능. (3) DisBot의 보안 패턴(프롬프트 인젝션 가드 20개+, 감사 로그) 최소 1개 이상 적용 확인. (4) 루프 1회 실행 E2E 증명 (명령 → 토론 → 코드 → 검증). | [사용자]                                                                                           |

---

## 출처 추적 — 환각 후보 점검

| 요구사항 주장                              | 태그                                                                 | 판정          |
| ------------------------------------------ | -------------------------------------------------------------------- | ------------- |
| openclaw에 Ollama 공급자 없음              | [코드:openclaw/extensions/ — grep 결과 없음]                         | ✅ 확인됨     |
| Consilium FastAPI `/api/debates` 존재      | [코드:Consilium/webapi/routes/]                                      | ✅ 확인됨     |
| Consilium self-dev loop 동작               | [코드:Consilium/src/self_dev_loop.py]                                | ✅ 확인됨     |
| DisBot Ollama REST 연동                    | [코드:DisBot/ollama_executor.py:http://localhost:11434]              | ✅ 확인됨     |
| openclaw MCP 서버 지원                     | [코드:openclaw/extensions/mcp/]                                      | ✅ 확인됨     |
| "Consilium을 MCP 서버로 노출 가능"         | 🚨 [출처없음] — Consilium에 MCP 서버 코드 없음. FastAPI HTTP만 존재. | **환각 후보** |
| openclaw 플러그인이 외부 FastAPI 호출 가능 | [코드:openclaw/src/plugin-sdk/ — HTTP helper 존재]                   | ✅ 확인됨     |

### 🚨 환각 후보 항목

**"Consilium을 MCP 서버로 바로 연결"** — Consilium은 MCP 서버 구현이 없음. HTTP REST만 존재.
→ 두 가지 옵션: (A) Consilium에 MCP 래퍼 추가, (B) openclaw 플러그인에서 직접 HTTP 호출.
→ **사용자 확인 필요**: "MCP 래퍼를 Consilium에 추가할 의향이 있습니까, 아니면 openclaw 플러그인에서 직접 HTTP 호출로 연결하겠습니까?"

**Why 판정: ⏸ 확인 필요 (환각 후보 1건 — 연결 방식 확정 대기)**

---

## 목표 분해 (MVP vs Full)

| 단계               | 목표                                                    | 범위      |
| ------------------ | ------------------------------------------------------- | --------- |
| **MVP (스파이크)** | openclaw ← HTTP → Consilium 연결 + Ollama 명령 실행     | 핵심 증명 |
| **Phase 1**        | openclaw Consilium-Bridge 플러그인 + Telegram 명령 연동 | 채널 통합 |
| **Phase 2**        | DisBot 보안 패턴 openclaw 플러그인으로 이식             | 보안 강화 |
| **Phase 3**        | Goal 상태 머신 + 24시간 루프 스케줄러                   | 자율 루프 |
