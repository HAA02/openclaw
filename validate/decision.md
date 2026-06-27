# PreFlight 판정

> 생성: 2026-06-27 | 최종 GO / HOLD / DROP

---

## 판정 테이블

| 목표                                   | Why                  | Build/Buy             | 방법론    | RedTeam                  | 최종               |
| -------------------------------------- | -------------------- | --------------------- | --------- | ------------------------ | ------------------ |
| **[스파이크] Consilium API 연동 증명** | ✅                   | 직접 curl 검증        | Spike     | 위험 없음                | ✅ **GO**          |
| **[B] Ollama 공급자 플러그인**         | ✅                   | Ollama REST 직접 호출 | TDD       | GPU 보호 포함 시 GO      | ✅ **GO**          |
| **[A] Consilium-Bridge 플러그인**      | ⏸ (연결 방식 미확정) | Consilium API 재사용  | Spike→TDD | max_iterations 강제 필수 | ⏸ **HOLD**         |
| **[C] 보안 가드 이식**                 | ✅                   | DisBot 패턴 부분 포팅 | TDD       | 오탐 모니터링 필요       | 🟡 **GO (B 이후)** |
| **[D] 감사 로그 + 스케줄러**           | ✅                   | openclaw SQLite 패턴  | OOD→TDD   | 마이그레이션 패턴 준수   | 🟡 **GO (A 이후)** |
| **[전체 통합 단번에]**                 | ❌                   | —                     | —         | 범위 크리프 위험         | ❌ **DROP**        |

---

## ✅ GO 목표 (즉시 시작 가능)

### 1. [스파이크] Consilium API 연동 증명 (½일)

**목적**: 실제로 openclaw 환경에서 Consilium REST API가 호출 가능한지 최소 증명.

```bash
# Consilium 서버 실행
cd /run/media/iaan/1TB-WD/Github/Ti_AI_Project/Consilium
uvicorn webapi.main:app --host 0.0.0.0 --port 8000

# 연동 테스트
curl -X POST http://localhost:8000/api/debates \
  -H "Content-Type: application/json" \
  -d '{"topic":"openclaw plugin architecture", "models":["llama3.2"], "rounds":2}'
```

**성공 기준**: 200 OK + debate_id 반환 + 스트림 SSE 수신 확인.

---

### 2. [목표 B] Ollama 공급자 플러그인

**구현 위치**: `extensions/ollama/`
**참조 패턴**: `extensions/groq/src/index.ts` (구조 동일)

**핵심 구현 요소**:

```typescript
// extensions/ollama/src/index.ts
- provider manifest (id: "ollama", capabilities: ["chat", "completion"])
- POST http://localhost:11434/api/chat 호출
- 스트리밍: /api/chat (stream: true)
- 모델 목록: GET http://localhost:11434/api/tags
- GPU 동시 호출 제한: 세마포어 1개
```

**TDD 테스트 목록**:

```
[ ] ollama 서버 미기동 시 명확한 에러 반환
[ ] 모델 목록 조회 정상 반환
[ ] 채팅 완성 정상 반환
[ ] 스트리밍 토큰 순서 보장
[ ] 동시 요청 1개 제한 (semaphore 테스트)
```

---

### 3. [목표 C] 보안 가드 (B 이후)

**DisBot 포팅 대상 패턴 (우선순위):**

```typescript
// extensions/security-guard/src/patterns.ts
const INJECTION_PATTERNS = [
  /\[INST\]/i, // LLaMA jailbreak
  /<\|im_start\|>/i, // ChatML injection
  /ignore previous instructions/i,
  /you are now (DAN|jailbroken)/i,
  // ... 20+ patterns from DisBot/src/security/guard.py
];
```

---

## ⏸ HOLD 목표

### [목표 A] Consilium-Bridge 플러그인

**HOLD 사유**: 연결 방식 미확정.

**사용자 결정 필요**:

> **질문**: Consilium과 openclaw 연결 방식을 어떻게 할까요?
>
> | 옵션                                                                          | 장점                                 | 단점                                           |
> | ----------------------------------------------------------------------------- | ------------------------------------ | ---------------------------------------------- |
> | **A) HTTP 직접 호출** — openclaw 플러그인이 `http://localhost:8000` 직접 호출 | 구현 빠름 (½일), Consilium 수정 없음 | openclaw-Consilium 간 타입 안전성 없음         |
> | **B) MCP 래퍼 추가** — Consilium에 MCP 서버 추가 후 openclaw MCP 채널로 연결  | openclaw 네이티브 통합, 타입 안전    | Consilium 수정 필요 (~1일), MCP 서버 구현 추가 |
>
> **권장**: **옵션 A (HTTP 직접 호출)** — Consilium은 사용자 소유이므로 API 계약 통제 가능. MCP 래퍼는 안정화 후 Phase 2에서 추가.

---

## ❌ DROP 목표

### [전체 통합 단번에]

**DROP 사유**: 세 코드베이스의 모든 기능을 동시에 통합하는 것은 범위 크리프. MVP 가치 없이 복잡도만 증가. 단계별 접근이 필수.

---

## 아키텍처 최종 설계 (GO 기준)

```
사용자 (Telegram/Discord/CLI)
        ↓
[openclaw 채널 레이어] ← 기존 100% 재사용
        ↓
[consilium-bridge 플러그인] ← 목표 A (HOLD 해제 후)
   ├─ /debate [주제] → POST http://localhost:8000/api/debates
   ├─ /goal [목표] [명령어]  → POST http://localhost:8000/api/goals
   ├─ /loop-stop → 실행 중 루프 중단
   └─ 결과 스트리밍 → 채널에 점진적 전달
        ↓
[Consilium FastAPI] ← 기존 100% 재사용
   ├─ 토론 오케스트레이터 (orchestrator.py)
   ├─ Goal 상태 머신 (goal_store.py)
   └─ 자가개발 루프 (self_dev_loop.py / repo_heal_loop.py)
        ↓
[Ollama Local LLM] ← openclaw ollama 플러그인 (목표 B) + 기존 Consilium
   └─ localhost:11434 (24시간 상시 실행)

[보안 가드] ← 목표 C
   └─ openclaw beforeMessage 훅

[감사 로그] ← 목표 D
   └─ openclaw SQLite (loop_audit 테이블)
```

---

## 즉시 실행 체크리스트

```
[ ] 스파이크: Consilium 서버 로컬 실행 + curl 연동 확인
[ ] 목표 A 연결 방식 결정 (HTTP 직접 vs MCP — 사용자 확인)
[ ] extensions/groq/src/index.ts 읽어 Ollama 플러그인 구조 파악
[ ] pnpm install 후 pnpm test extensions/ollama 실행 가능 환경 확인
[ ] Consilium Cycle 6 최신 상태 확인 (git log HEAD~3)
```
