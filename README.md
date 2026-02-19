# XMate

XMate는 X(구 Twitter)에서 유저별 메모를 기록하고, 타임라인에서 바로 다시 볼 수 있게 해주는 브라우저 확장 프로그램입니다.

## 주요 기능
- 프로필 화면에서 유저 메모 작성/수정/삭제
- 타임라인에서 저장 메모 인라인 표시
- userId 기반 저장으로 핸들(@) 변경 시에도 데이터 유지
- `chrome.storage.sync` 기반 다기기 동기화
- 설정 페이지에서 저장 데이터 조회/검색/삭제
- 한국어/영어 다국어 UI 지원

## 설치(개발 모드)
1. 브라우저 확장 관리 페이지를 엽니다.
2. 개발자 모드를 활성화합니다.
3. 이 폴더를 `압축해제된 확장 프로그램 로드`로 불러옵니다.

## 스토어 등록용 설명 문구
### 한국어 요약
X 프로필 메모를 저장하고 타임라인에서 바로 확인하는 생산성 확장 프로그램

### 한국어 상세
XMate는 X(구 Twitter)에서 유저별 메모를 기록하고 다시 보는 도구입니다.
- 프로필 화면에서 유저별 메모 작성/저장
- 타임라인에서 저장한 메모를 이름 옆에 표시
- userId 기반 저장으로 핸들 변경에도 데이터 유지
- 여러 기기 동기화(`chrome.storage.sync`)
- 설정 페이지에서 저장 데이터 조회/검색/삭제

데이터는 사용자가 입력한 메모만 저장하며, 별도 자체 서버로 전송하지 않습니다.

### English Summary
A productivity extension that saves profile notes on X and shows them directly in your timeline.

### English Description
XMate helps you save and reuse profile notes on X (formerly Twitter).
- Write and save notes per user on profile pages
- Show saved notes inline next to names in timeline
- userId-based storage so notes survive handle changes
- Multi-device sync with `chrome.storage.sync`
- View/search/delete all saved notes in the settings page

Only user-entered note data is stored. No separate custom backend server is used.

## 정책 문서
- Privacy Policy template: `store/PRIVACY_POLICY.md`
- Store listing templates: `store/listing-ko.md`, `store/listing-en.md`
