# CodePet

Codex, Google Antigravity(AGY), Claude Code의 작업 상태와 계정별 한도를 한곳에서 보여 주는 데스크톱 펫입니다. 세 프로그램의 대화를 동시에 감지해 말풍선으로 표시하고, 설정 창에서 계정·말풍선 색상·글꼴을 관리합니다.

Windows와 macOS를 지원합니다. CLI 세션(Claude Code, Codex CLI)뿐 아니라 데스크톱 앱 세션도 감지합니다 — Claude 데스크톱 앱의 Claude Code 세션은 `~/.claude/projects`에, Codex 데스크톱 앱 세션은 `~/.codex/sessions`에 기록되므로 같은 감시 경로로 함께 잡힙니다.

Codex CLI의 펫 에셋(`~/.codex/pets`)을 그대로 가져다 쓰기 때문에, Codex에서 펫을 설치해뒀다면 별도 설정 없이 바로 골라 쓸 수 있습니다.

## 실행

```bash
npm install
npm run start
```

실행 파일로 뽑으려면:

```bash
npm run dist          # 현재 OS용 (Windows → 포터블 exe, macOS → dmg/zip)
npm run dist -- --win # Windows용 명시
npm run dist -- --mac # macOS용 명시
```

Windows에서는 `artifacts/CodePet-<버전>.exe` 포터블 실행 파일이, macOS에서는 dmg와 zip이 나옵니다. 설치 과정 없이 실행할 수 있습니다. 빌드는 앱을 끈 상태에서 돌려야 합니다(실행 중이면 파일 잠금 때문에 실패).

DevTools가 필요하면 이렇게 켜세요.

```powershell
$env:PET_DEVTOOLS="1"
npm run dev
```

## 뭘 하는 앱인가

### 사용량 확인

펫을 더블클릭하면 설정의 `한도` 화면이 열립니다. Codex, AGY, Claude의 현재 계정 한도를 카드로 함께 표시하며 계정 전환 기능은 카드에 넣지 않습니다. Codex는 고정된 5시간 주기로 추정하지 않고 서버가 보내는 실제 기간을 읽어 5시간·주간·월간 한도와 모델별 추가 한도를 동적으로 표시합니다. 사용률이 70%를 넘으면 게이지가 노란색, 90%를 넘으면 빨간색이 됩니다.

Codex 사용률이 90%를 넘으면 초기화 주기당 한 번 경고 말풍선을 표시합니다.

### 계정 추가/전환/삭제

우클릭 메뉴와 시스템 트레이에서 Codex, AGY, Claude 모두 같은 형태의 저장 계정 목록과 `로그인 / 계정 추가` 항목을 제공합니다. 계정 삭제는 `설정…` → `계정`에서 할 수 있습니다.

- Codex: 별도 로그인 프로필에서 새 계정을 추가하고 저장된 인증 정보를 원자적으로 전환합니다. 기본은 전환 후 Codex Desktop 재시작이지만, 우클릭 메뉴의 "Codex 재시작 없는 전환 (프록시)"를 켜면 로컬 프록시(127.0.0.1)가 요청 단위로 계정 인증 헤더를 갈아끼워 재시작 없이 즉시 적용됩니다. 프록시 모드를 켜고 끌 때 `~/.codex/config.toml` 루트에 `openai_base_url` 한 줄을 넣고 빼며(마커 주석으로 관리), 모드를 켠 직후에는 Codex를 한 번만 다시 시작하면 됩니다. CodePet 종료 시 자동으로 원복하므로 CodePet이 꺼져 있어도 Codex는 정상 동작합니다.
- AGY: 현재 자격 증명(Windows 자격 증명 관리자 / macOS Keychain)을 프로필로 저장하고, 확인 가능한 계정 이메일을 함께 기록한 뒤 선택한 계정으로 바꾸고 AGY를 다시 시작합니다.
- Claude: 현재 Claude 자격 파일과 `claude auth status`의 이메일을 프로필로 저장하고 전환합니다. OAuth 토큰이 갱신돼도 같은 이메일은 한 계정으로 병합하며, 이미 열린 세션은 유지되고 새 세션부터 선택한 계정을 사용합니다.

프로필 저장소는 `~/.codepet/codex-switch`, `~/.codepet/antigravity-switch`, `~/.codepet/claude-switch`입니다. 설정 화면에는 비밀 값이 노출되지 않습니다.

현재 사용 중인 계정은 삭제할 수 없으며, 다른 계정으로 전환한 뒤 저장된 프로필만 삭제할 수 있습니다.

### 작업 실시간 표시

Codex의 `~/.codex/sessions`, AGY의 로컬 transcript, Claude의 프로젝트 JSONL을 tail해 세 프로그램의 작업을 함께 감지합니다.

- 작업 시작/응답 작성 → 펫이 살펴보기 모션으로 바뀜. Codex rollout에 확인된 Sol/Terra/Luna 모델 정보가 있으면 제목에 표시됩니다. 동시 대화는 공급자를 합쳐 시작 순서대로 최대 5개를 보여 주며, 각 제목 바로 아래에 해당 대화 내용이 표시됩니다.
- 파일 수정, 명령, 테스트, 빌드 → 작업 중 모션과 현재 상태가 말풍선에 표시됨
- Codex 사용자 입력 또는 실행 승인 대기 → 기다리기 모션으로 바뀜. 말풍선을 클릭하면 해당 Codex 대화를 바로 열 수 있음(세션 로그에 구조화 이벤트가 있을 때)
- 작업 완료 → 폴짝 뛰고 마지막 메시지를 표시함. 완료 말풍선을 클릭하면 해당 Codex 채팅으로 이동함
- 작업 중단 → 쓰러짐

세션 여러 개를 동시에 돌려도 각각 추적하고, 완료 이벤트가 없는 작업은 공급자별 quiet-time 또는 stale 처리 뒤 원래 상태로 돌아옵니다.

말풍선 개인정보 수준은 설정의 `일반` 화면에서 선택합니다.

- "전체 내용" — 요청, 중간 메시지, 파일명과 명령을 표시
- "상태만" — 작업 중, 테스트 중, 승인 대기 같은 상태만 표시
- "끄기" — 자동 작업 말풍선만 끔. 펫 모션은 그대로 동작

### 화면 설정

설정의 `일반` 화면에서 말풍선 배경색과 글자색을 직접 고를 수 있습니다. 글자색은 본문뿐 아니라 모델명과 작업 상태 제목에도 함께 적용됩니다. 설치된 시스템 글꼴(Windows 레지스트리 / macOS 폰트 폴더)을 검색하고 선택하면 설정 창과 말풍선에 함께 적용됩니다.

### 펫 바꾸기

우클릭 → "펫 바꾸기"에서 고르면 즉시 바뀌고, 선택은 다음 실행 때도 유지됩니다. 목록에 나오는 순서는:

1. exe 옆 `pet/spritesheet.webp` — 직접 만든 스프라이트를 쓰고 싶을 때
2. `~/.codex/pets`에 설치된 펫들 — Codex에서 펫을 추가하면 여기에도 자동으로 나타남
3. 내장 기본 펫

## 조작법

| 동작 | 반응 |
|---|---|
| 클릭 | 인사 |
| 더블클릭 | 점프 + 설정의 한도 화면 열기 |
| 드래그 | 창 이동 |
| 드래그 종료 / 크기 조절 종료 | 현재 위치와 크기를 저장하고, 다음 실행 때 현재 화면 안에서 복원 |
| 우클릭 | 메뉴 (설정, 계정, 펫 바꾸기, 모션, 일시정지, 마우스 따라가기, 자동 실행, 숨기기 등) |
| 시스템 트레이 | 설정, 보이기, 숨기기, 계정, 펫 바꾸기, 완전 종료 |
| 완료·입력 대기·승인 대기 말풍선 클릭 | 해당 Codex 채팅 열기 |
| 그 외 말풍선 클릭 | 닫기 |

우클릭 메뉴의 "숨기기"는 창만 감추고 앱은 시스템 트레이에 남깁니다. 완전히 끄려면 시스템 트레이 아이콘을 우클릭해서 "완전 종료"를 누르면 됩니다.

`이동 일시 정지`와 `마우스 따라가기` 상태는 설정 파일에 저장되므로 앱을 다시 실행하거나 재부팅해도 유지됩니다.

우클릭 메뉴의 "로그인 시 자동 실행"을 켜면 로그인할 때 같이 뜹니다.

## 커스텀 스프라이트 만들기

Codex 펫 스프라이트 규격을 그대로 따르며 v1과 v2를 모두 자동 인식합니다.

- v1: 전체 크기 1536x1872, 셀 192x208의 8열 x 9행 그리드
- v2: 전체 크기 1536x2288, 셀 192x208의 8열 x 11행 그리드
- row가 상태, column이 프레임

| row | 상태 | v1 프레임 수 | v2 프레임 수 |
|---:|---|---:|---:|
| 0 | idle | 6 | 6 |
| 1 | runningRight | 8 | 8 |
| 2 | runningLeft | 8 | 8 |
| 3 | waving | 4 | 4 |
| 4 | jumping | 5 | 5 |
| 5 | failed | 8 | 8 |
| 6 | waiting | 8 | 6 |
| 7 | running | 8 | 6 |
| 8 | review | 8 | 6 |
| 9 | look directions A | - | 8 |
| 10 | look directions B | - | 8 |

v2의 row 9~10에는 시계 방향의 시선 방향 16개가 들어갑니다. 현재 CodePet은 row 0~8의 기본 애니메이션을 재생하고 row 9~10은 시트를 올바르게 자르기 위한 v2 레이아웃으로 인식합니다.

이미지 크기가 정상 규격이면 높이로 9행/11행을 자동 판별합니다. 이미지 비율을 판별할 수 없을 때는 같은 폴더의 `pet.json`에 있는 `spriteVersionNumber`를 fallback으로 사용합니다.

이 규격으로 만든 `spritesheet.webp`를 exe 옆 `pet/` 폴더에 넣으면 메뉴에 "커스텀"으로 나타납니다.

## 코드 구조

- `src/main.js` — 창 관리, 이동 로직, 메뉴, 말풍선 제어. 이동 속도나 말풍선 크기 같은 값은 상단의 `MOVEMENT_CONFIG`, `BUBBLE_CONFIG`에 모여 있음
- `src/codex-watcher.js`, `antigravity-watcher.js`, `claude-watcher.js` — 세 프로그램의 로컬 작업 로그 감시
- `src/codex-account-switcher.js`, `antigravity-account-switcher.js`, `claude-account-switcher.js` — 공급자별 계정 저장/전환/삭제
- `src/account-submenu.js` — Codex·AGY·Claude 공통 계정 메뉴 구성
- `src/codex-usage-label.js` — Codex 서버 한도 기간과 모델 범위에 맞는 표시 이름 생성
- `src/provider-usage.js` — AGY·Claude 한도 조회 및 정규화
- `src/settings.html` / `settings.js` — 설정, 계정, 한도 화면
- `src/renderer.js` — 스프라이트 애니메이션 재생. 상태 정의는 `PET_STATES`
- `src/bubble.html` / `bubble.js` — 통합 작업 말풍선
