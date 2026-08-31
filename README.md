# 중학교 영어 듣기·읽기 관리 웹사이트

학생은 학번/이름으로 들어가 회차와 4문제 묶음을 선택합니다. 선택한 4문제의 영어/한글 대본을 한 화면에서 보며 묶음 전체 음원을 3회 듣고, 같은 4문제를 파일 하나로 3회 녹음합니다. 교사는 학생 등록, 회차/대본 등록, 음원 등록, 학생별 재생 시간·녹음 시간·녹음 파일을 확인할 수 있습니다.

## 1. Firebase 준비

1. Firebase Console에서 새 프로젝트 생성
2. **Firestore Database** 생성
3. **Storage** 생성
4. **Hosting** 사용 설정
5. 프로젝트 설정 > 웹 앱 추가 > SDK 설정 값을 `firebase-config.js`에 붙여넣기

> 2026년 현재 Cloud Storage for Firebase를 사용하려면 Blaze(종량제) 요금제 연결이 필요합니다. 무료 사용량 범위 안이면 실제 과금이 없을 수 있지만, 결제 계정 연결 자체는 필요합니다.

## 2. 배포

Node.js가 설치된 컴퓨터에서 이 폴더로 이동한 뒤:

```bash
npm install -g firebase-tools
firebase login
firebase use --add
firebase deploy
```

배포가 끝나면:

- 학생용: `https://프로젝트주소.web.app/`
- 교사용: `https://프로젝트주소.web.app/teacher.html`

마이크는 HTTPS에서만 정상적으로 권한 요청이 되므로 Firebase Hosting 주소에서 시험하는 것을 권장합니다.

## 3. 학생 입력

교사용 페이지 > 학생 관리에서 엑셀의 학번/이름 두 열을 복사해 붙여넣고 **학생 일괄 등록**을 누릅니다.

예:

```text
10101    김민수
10102    이서연
```

학번은 Firestore 문서 ID로 쓰므로 `/` 문자는 사용할 수 없습니다.

## 4. 대본 자동 분할

다음처럼 문제 번호가 줄 맨 앞에 있으면 자동 인식합니다.

```text
1. 대본 내용...
2) 대본 내용...
[3] 대본 내용...
4번 대본 내용...
```

문제 단위로 나눈 뒤 자동으로 4문제씩 묶습니다. 예: 1–4, 5–8, 9–12.

AI는 기본적으로 필요 없습니다. 번호 규칙은 결정적이라 LLM보다 빠르고 안정적입니다. 저장 전에 미리보기를 반드시 확인하세요.

## 5. 음원 넣는 방법

### 권장: 4문제 묶음별 업로드

각 회차 아래에서 `1–4번`, `5–8번` 등의 파일 입력에 해당 묶음 음원을 업로드합니다. 가장 단순하고 안정적입니다.

### 대안: 전체 음원 1개 + 시간 구간

회차의 **전체 음원**에 파일을 한 번 올린 뒤, 각 묶음에 `시작 초 / 끝 초`를 입력합니다.

예:

- 1–4번: 0 ~ 185.5초
- 5–8번: 185.5 ~ 372초

학생 페이지에서는 같은 전체 파일을 쓰되 해당 시간 구간을 묶음 단위로 연속 재생합니다. 구간을 따로 입력하지 않은 기존 회차는 `questionTimings` 중 묶음의 첫 문제 시작부터 마지막 문제 다음 시작 시각까지를 자동으로 사용합니다.

## 6. 아이폰/갤럭시 녹음

브라우저의 `MediaRecorder`를 사용합니다. 브라우저가 지원하는 형식을 자동 선택합니다.

- Chrome/Android 계열: 주로 WebM/Opus
- Safari/iPhone 계열: 주로 MP4/AAC

녹음이 안 될 때는 브라우저의 사이트 마이크 권한을 확인하고 Safari/Chrome을 최신 버전으로 업데이트하세요.

## 7. 14일 뒤 녹음 파일 자동 삭제

`lifecycle.json`은 `recordings/` 경로의 파일만 14일 후 삭제하도록 되어 있습니다. 따라서 교사용 원본 음원(`teacher-audio/`)은 지워지지 않습니다.

Google Cloud CLI가 설치된 환경에서 버킷 이름을 확인한 뒤:

```bash
gcloud storage buckets update gs://YOUR_BUCKET_NAME --lifecycle-file=lifecycle.json
```

또는 Google Cloud Console > Storage > 버킷 > Lifecycle에서 같은 조건을 설정할 수 있습니다.

주의: 파일은 삭제되어도 Firestore의 활동 기록/누적 시간은 남습니다. 오래된 녹음 재생 버튼은 파일 만료 후 재생되지 않을 수 있습니다.

## 8. 데이터 구조

- `students/{학번}`: 이름
- `rounds/{회차ID}`: 제목, 문제 대본, 4문제 묶음, 음원 URL/구간
- `progress/{학번__회차__묶음}`: 3회 듣기 + 3회 녹음 누적 진도
- `activityLogs/{자동ID}`: 실제 재생/녹음 1회별 시간과 녹음 URL
- Storage `recordings/...`: 학생 녹음
- Storage `teacher-audio/...`: 교사용 원본/묶음 음원

## 9. Ollama Cloud를 쓸지?

현재 버전에서는 쓰지 않는 것을 권장합니다.

- **대본 분할**: 번호 정규식이 더 정확하고 공짜입니다.
- **음원 자동 분할**: LLM 자체보다 음성 인식(STT) + 대본 정렬(alignment)이 필요한 문제입니다. 현재 Ollama Cloud의 일반 채팅/비전 모델 API만으로 이 작업을 핵심 기능으로 맡기는 것은 권장하지 않습니다.

나중에 자동 음원 분할이 꼭 필요해지면 Whisper 계열 STT 또는 타임스탬프를 반환하는 음성 인식 API로 전체 음원을 전사한 뒤, 각 문제 대본의 첫 문장과 전사 결과를 매칭해 구간을 제안하는 기능을 붙이는 편이 좋습니다. 그래도 최종 저장 전 교사 확인 화면은 두는 것이 안전합니다.

## 10. 녹음 저장과 재시도

- 녹음 한 번에는 현재 묶음의 4문제가 파일 하나로 들어갑니다.
- Storage 업로드나 Firestore 저장이 실패해도 페이지를 새로고침하지 않는 한 완성된 Blob을 메모리에 유지합니다.
- 학생은 다시 녹음하지 않고 **다시 저장**을 누릅니다.
- 동일 제출 ID의 활동 로그 존재 여부를 Firestore transaction에서 확인하므로 재시도해도 `recordCount`는 한 번만 증가합니다.
- 저장 중에는 회차/묶음 변경, 로그아웃, 새 녹음, 중복 저장을 막고 페이지 이탈 경고를 표시합니다.

## 11. 보안과 인증 도입 절차

현재 학번+이름 확인은 Firebase Authentication이 아니므로 보안 경계로 사용할 수 없습니다. 호환성을 위해 공개 읽기와 필요한 익명 쓰기는 유지하되 다음 방어를 적용했습니다.

- progress 횟수 범위를 0~3으로 제한하고 삭제를 금지
- activityLogs는 생성만 허용하고 수정/삭제 금지
- Storage는 `recordings/`와 `teacher-audio/` 오디오 경로만 허용하며 크기를 제한
- 다른 임의 경로는 거부

그래도 URL을 아는 사용자가 다른 학생의 개인정보와 녹음을 조회하거나 데이터를 위조할 위험은 남습니다. 운영 전에 Firebase Console에서 다음 순서로 인증을 도입해야 합니다.

1. Firebase Authentication에서 교사용 로그인 방식을 활성화합니다.
2. 교사 계정에 서버에서만 설정하는 custom claim(예: `teacher: true`)을 부여합니다.
3. 학생에게도 익명 또는 학교 계정 인증을 붙이고, 서버에서 학번과 인증 UID를 연결합니다.
4. Firestore/Storage rules를 UID 소유권과 교사 claim 기준으로 바꿉니다.
5. App Check를 웹 앱에 적용하고 모니터링 후 enforcement를 켭니다.
6. Emulator Suite에서 학생/교사 권한 시나리오를 검증한 뒤 rules를 배포합니다.

프론트엔드에 관리자 비밀번호나 secret을 넣는 방식은 사용하지 마세요. `teacher.html` 주소 자체도 접근 제어가 아니므로 인증 도입 전에는 민감한 운영에 적합하지 않습니다.

## 12. Rules 수동 배포

`.github/workflows/firebase-hosting-live.yml`은 main push 때 학생 사이트의 Firebase Hosting 배포만 수행합니다. Rules 배포의 인증 또는 권한 문제가 Hosting 배포를 막지 않도록 Firestore rules와 Storage rules는 별도로 수동 배포합니다.

Firebase CLI에 로그인하고 프로젝트 권한이 있는 계정으로 다음 명령을 실행하세요.

```bash
firebase deploy --only firestore:rules,storage --project test2222-e2458
```

## 13. 실제 기기 점검표

### iPhone Safari

- HTTPS Hosting 주소에서 `🎤 내 휴대폰 녹음 테스트` 권한 허용, 정지, 즉시 재생
- 화면 잠금/다른 앱 전환 시 듣기 자동 일시정지 및 복귀 후 자동 재생 안 됨
- 4문제 전체 대본 스크롤과 하단 safe-area 재생 컨트롤 확인
- 3회 듣기 전 녹음 버튼이 숨겨지고 3회 후 표시되는지 확인
- MP4/AAC 계열 녹음이 교사 화면에서 재생되는지 확인
- 네트워크를 끊어 저장 실패를 만든 뒤 연결 복구와 `다시 저장` 확인

### Galaxy Chrome / Samsung Internet

- 두 브라우저에서 각각 마이크 테스트와 WebM/Opus 재생 확인
- 마이크 권한 거부 시 쉬운 한국어 안내와 진도 불변 확인
- -3초, +3초, 자유 seek, 0.6~1.2배속 확인
- 듣기 중 앱 전환 시 일시정지, 녹음 중 화면 전환 시 브라우저가 허용하는 동안 유지 확인
- 업로드 중 묶음/회차/로그아웃/중복 저장 차단 확인
- 교사 화면에서 묶음당 녹음 1회·2회·3회 파일이 각각 하나씩 보이는지 확인
