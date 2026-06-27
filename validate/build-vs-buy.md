# Build vs Buy

> 생성: 2026-06-27 | PreFlight Phase 2 — LibScout

---

## 기능 1: 로컬 LLM 실행 런타임 (Ollama 연동)

| 후보                                             | 유지보수                      | 라이선스 | CVE    | 무게                      | 적합도                                    |
| ------------------------------------------------ | ----------------------------- | -------- | ------ | ------------------------- | ----------------------------------------- |
| **Ollama REST API** (기존 DisBot/Consilium 방식) | 활발 (월 단위 릴리스)         | MIT      | 없음   | HTTP client만 필요        | 100% — 이미 두 프로젝트에서 검증됨        |
| LangChain.js                                     | 활발                          | MIT      | 없음   | 무거움 (전이 의존성 100+) | 60% — 과한 추상화, openclaw 스타일 불일치 |
| llama-node (Node.js)                             | 비활발 (6개월 이상 커밋 없음) | MIT      | 미확인 | 무거움 (네이티브 바인딩)  | 30%                                       |

**판정: 🟢 도입 (Ollama REST API 직접 호출)**
**근거:** DisBot의 `ollama_executor.py`에서 `POST /api/chat` 패턴이 이미 검증됨 [코드:DisBot/ollama_executor.py:http://localhost:11434/api/chat]. openclaw 플러그인에서 동일한 HTTP 패턴을 TypeScript로 포팅하면 됨. LangChain 추상화는 불필요.

---

## 기능 2: 토론/멀티모델 루프 오케스트레이터

| 후보                                      | 유지보수                       | 라이선스  | CVE  | 무게              | 적합도                                                 |
| ----------------------------------------- | ------------------------------ | --------- | ---- | ----------------- | ------------------------------------------------------ |
| **Consilium orchestrator.py** (기존 코드) | 활발 (Cycle 6 완료, 374 tests) | 확인 필요 | 없음 | Python 서비스 1개 | 95% — 합의 감지, 조기 종료, 역할 기반 토론 모두 구현됨 |
| AutoGen (Microsoft)                       | 활발                           | MIT       | 없음 | 무거움            | 70% — 범용 설계, 커스텀 역할 복잡                      |
| CrewAI                                    | 활발                           | MIT       | 없음 | 중간              | 60% — 역할 모델링 있으나 토론 모드 없음                |

**판정: 🟢 도입 (Consilium 기존 코드 — HTTP API로 노출)**
**근거:** Consilium은 이미 `/api/debates`, `/api/goals`, `/api/self-dev/tasks` REST 엔드포인트를 제공함 [코드:Consilium/webapi/routes/]. 재구현 불필요. openclaw 플러그인이 HTTP client로 호출하는 것이 최선.
⚠️ **라이선스 확인 필요**: Consilium 라이선스가 명시적으로 확인되지 않음. `Ti_AI_Project` 하위 프로젝트이므로 사용자 소유로 간주하나, 공식 라이선스 파일 점검 권장.

---

## 기능 3: 프롬프트 인젝션 / 보안 가드

| 후보                                    | 유지보수                  | 라이선스 | CVE  | 무게            | 적합도                                                      |
| --------------------------------------- | ------------------------- | -------- | ---- | --------------- | ----------------------------------------------------------- |
| **DisBot security/guard.py** (20+ 패턴) | 사용자 소유               | N/A      | N/A  | Python 파일 1개 | 90% — 이미 동작하는 패턴셋                                  |
| openclaw 기존 보안                      | 활발                      | MIT      | 없음 | 내장            | 60% — SSRF/Zod 검증은 있으나 프롬프트 인젝션 특화 가드 없음 |
| rebuff (라이브러리)                     | 비활발 (마지막 커밋 1년+) | MIT      | 없음 | 중간            | 40%                                                         |

**판정: 🟡 부분 차용 (DisBot 패턴 → TypeScript 포팅)**
**근거:** DisBot의 20+ 정규식 패턴은 검증된 자산 [코드:DisBot/src/security/guard.py]. 그러나 Python → TypeScript 포팅이 필요. openclaw 플러그인 SDK의 `beforeMessage` 훅에 삽입하는 방식으로 적용. 전체 보안 모듈이 아닌 **인젝션 패턴 목록만 이식**.

---

## 기능 4: Goal 상태 머신 / 루프 스케줄러

| 후보                                           | 유지보수 | 라이선스    | CVE  | 무게               | 적합도                                                            |
| ---------------------------------------------- | -------- | ----------- | ---- | ------------------ | ----------------------------------------------------------------- |
| **Consilium goal_store.py + goal_dev_loop.py** | 활발     | 사용자 소유 | N/A  | Python 서비스      | 95% — 상태 머신(analyzing→done), 재시도, 에스컬레이션 모두 구현됨 |
| openclaw cron (`src/cron/`)                    | 활발     | MIT         | 없음 | 내장               | 50% — 타이밍 스케줄만, 목표 상태 머신 없음                        |
| Temporal.io                                    | 활발     | MIT         | 없음 | 무거움 (서버 필요) | 70% — 오버엔지니어링                                              |

**판정: 🟢 도입 (Consilium Goal API 재사용)**
**근거:** Consilium의 `POST /api/goals` + `GET /api/goals/{id}/run`이 완성된 상태 머신 제공 [코드:Consilium/webapi/routes/goals.py]. openclaw 플러그인은 이 API를 호출만 하면 됨. openclaw의 기존 cron은 루프 실행 트리거에만 활용.

---

## 기능 5: 감사 로그 / JSONL 로테이션

| 후보                                       | 유지보수    | 라이선스 | CVE  | 무게        | 적합도                                |
| ------------------------------------------ | ----------- | -------- | ---- | ----------- | ------------------------------------- |
| **DisBot audit.py** (JSONL + SHA-256 해싱) | 사용자 소유 | N/A      | N/A  | Python 파일 | 80% — 일별 로테이션, 응답 해싱 구현됨 |
| openclaw SQLite 로그 (기존)                | 활발        | MIT      | 없음 | 내장        | 70% — SQLite 기반, 더 쿼리 친화적     |
| winston (Node.js)                          | 활발        | MIT      | 없음 | 가벼움      | 60% — 일반 로거                       |

**판정: 🟡 부분 차용 (openclaw SQLite 기반으로 DisBot 감사 스키마 적용)**
**근거:** openclaw의 아키텍처 원칙이 "SQLite only, no JSONL sidecar files"를 명시 [코드:openclaw/CLAUDE.md — "Storage default: SQLite only"]. DisBot의 JSONL 방식은 openclaw 원칙에 위배. DisBot의 **스키마(timestamp, user, prompt_hash, response_hash, cost)를 SQLite 테이블로 이식**.

---

## 기능 6: 채널 전달 (Telegram, Discord 등)

| 후보                                                   | 유지보수    | 라이선스 | CVE  | 무게   | 적합도                         |
| ------------------------------------------------------ | ----------- | -------- | ---- | ------ | ------------------------------ |
| **openclaw 기존 채널 플러그인** (telegram, discord 등) | 활발        | MIT      | 없음 | 내장   | 100% — 이미 20+ 채널 지원      |
| DisBot discord adapter                                 | 사용자 소유 | N/A      | N/A  | Python | 30% — Discord만, 재구현 불필요 |

**판정: 🟢 도입 (openclaw 기존 채널 100% 재사용)**
**근거:** openclaw의 채널 레이어가 이 통합의 가장 큰 자산. 완전 재사용.

---

## 요약

| 기능                     | 판정                         | 핵심 근거              |
| ------------------------ | ---------------------------- | ---------------------- |
| 로컬 LLM (Ollama)        | 🟢 Ollama REST 직접 호출     | DisBot 패턴 TS 포팅    |
| 토론 루프 오케스트레이터 | 🟢 Consilium API 재사용      | HTTP 클라이언트만 추가 |
| 프롬프트 인젝션 가드     | 🟡 DisBot 패턴 부분 이식     | 패턴 목록만, TS 포팅   |
| Goal 상태 머신           | 🟢 Consilium Goal API 재사용 | 상태 머신 완성         |
| 감사 로그                | 🟡 DisBot 스키마 → SQLite    | openclaw 원칙 준수     |
| 채널 전달                | 🟢 openclaw 기존 100% 재사용 | 추가 작업 없음         |

**직접 구현이 필요한 것:** openclaw 플러그인 1개 (`consilium-bridge`) — Consilium HTTP API 호출 래퍼 + Ollama 공급자 플러그인 1개.
**직접 구현 불필요:** 토론 엔진, 채널 레이어, Goal 상태 머신, 기본 LLM 런타임.
