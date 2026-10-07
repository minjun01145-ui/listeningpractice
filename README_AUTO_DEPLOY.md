# GitHub → Firebase Functions + Hosting 자동 배포 설정

대상 리포지토리:
- minjun01145-ui/listeningpractice

Firebase:
- projectId: listening-7680f
- Hosting target: listeningpractice
- Hosting site: listening-7680f

## 1. Workflow 파일 추가
이 ZIP의 `.github/workflows/firebase-hosting-live.yml` 파일을 리포지토리의 같은 경로에 추가하고 main 브랜치에 커밋합니다.

## 2. GitHub Secret 추가
이 workflow는 `FIREBASE_SERVICE_ACCOUNT_LISTENING_7680F`라는 Repository Secret이 필요합니다.

가장 쉬운 방법:
프로젝트 폴더에서 Firebase CLI로 아래 명령을 실행합니다.

    firebase init hosting:github

화면 안내에 따라:
- Firebase project: listening-7680f
- GitHub repo: minjun01145-ui/listeningpractice
- live channel 자동 배포: Yes

Firebase CLI가 GitHub용 서비스 계정/Secret을 만들어주는 경우에는, 생성된 workflow의 secret 이름이 다를 수 있습니다.
그 경우 이 ZIP의 workflow에서 아래 부분을 CLI가 생성한 secret 이름으로 바꾸면 됩니다.

    firebaseServiceAccount: ${{ secrets.FIREBASE_SERVICE_ACCOUNT_LISTENING_7680F }}

직접 Secret을 만들 경우:
1. Google Cloud Console → IAM & Admin → Service Accounts
2. listening-7680f 프로젝트에서 배포용 서비스 계정 생성
3. 필요한 권한 부여
4. JSON Key 생성
5. GitHub → listeningpractice → Settings → Secrets and variables → Actions
6. New repository secret
7. Name: FIREBASE_SERVICE_ACCOUNT_LISTENING_7680F
8. Value: JSON 파일 전체 내용

## 3. Rules 배포 권한

같은 `FIREBASE_SERVICE_ACCOUNT_LISTENING_7680F`를 Hosting 배포에 사용합니다. Rules는 현재 운영 방식대로 Firebase CLI에서 별도로 수동 배포합니다.

수동 확인 명령:

    firebase deploy --only firestore:rules,storage --project listening-7680f

## 4. 작동 확인
main 브랜치에 커밋을 push하면:
GitHub → Actions → Deploy to Firebase Hosting
에서 실행 결과를 확인할 수 있습니다.

성공하면 Firebase Hosting live 채널에 자동 반영됩니다.

Actions에서 **Deploy to Firebase Hosting → Run workflow**로 수동 재실행할 수도 있습니다. 배포는 같은 프로젝트에서 동시에 실행되지 않으며 진행 중인 배포를 취소하지 않습니다. Node 22와 Firebase CLI 15.27.0을 사용해 Functions와 Hosting을 함께 배포하고, 이어서 운영 교사용 HTML·JavaScript·가져오기 API를 검사합니다. 검증 요청은 자료 다운로드·번역·데이터 저장 없이 잘못된 연도에 대한 서버 응답만 확인합니다. Hosting은 JavaScript를 사용할 때마다 변경 여부를 재검증하도록 캐시 헤더를 설정합니다.

## 5. 기출 가져오기 함수

자동 배포는 Node 22에서 `functions` 의존성을 설치하고 `past-exam` 코드베이스의 함수를 먼저 배포합니다. 이어서 기존 Hosting 배포를 실행합니다. 기존 Repository Secret을 그대로 사용하되, 배포 서비스 계정에 Functions 배포 권한과 런타임 서비스 계정에 대한 `iam.serviceAccounts.actAs`가 필요합니다. Cloud Translation API 활성화와 실행 서비스 계정의 번역 권한은 README의 **기출 자동 불러오기** 설정을 참고하세요. Firestore/Storage 규칙과 교사용 인증은 변경하지 않습니다.

### 최초 설정은 프로젝트 소유자로 실행

Hosting 전용 배포 계정은 비활성화된 Cloud Functions/Cloud Build/Artifact Registry API를 켤 수 없습니다. 최초 Functions 배포와 필요한 API 활성화는 프로젝트 소유자가 완료한 뒤 자동 배포를 사용하세요. 2026-10-07 실패는 `Permissions denied enabling cloudfunctions.googleapis.com`에서 시작되어 Hosting 단계가 실행되지 않은 경우였습니다.

현재 GitHub 배포 계정은 `github-action-1346885701@listening-7680f.iam.gserviceaccount.com`, 함수 실행·빌드 계정은 `681467747891-compute@developer.gserviceaccount.com`입니다. 배포 계정에 프로젝트의 Cloud Functions Developer, Cloud Run Viewer, Firebase Hosting Admin, Service Usage Consumer/API Keys Viewer 권한과 실행·빌드 계정에 한정된 Service Account User 권한이 필요합니다. 실행 계정은 운영 함수 설정에서 확인하고, 새로운 권한 오류는 Actions 로그에 나온 리소스·권한을 확인해 보완하세요.

Firebase CLI는 최초 함수 배포 후 서울 리전의 `gcf-artifacts` 이미지 정리 정책 설정이 없으면 실패로 종료할 수 있습니다. 소유자가 아래 명령으로 7일 보관 정책을 설정합니다. 이 정책은 함수 빌드 이미지만 대상으로 하며 학생 데이터·녹음·교사용 음원에는 적용되지 않습니다. 삭제된 과거 이미지를 이용한 복구는 할 수 없지만 소스 커밋을 다시 빌드·배포할 수 있습니다.

```bash
firebase functions:artifacts:setpolicy --location asia-northeast3 --days 7 --project listening-7680f --force
```

소유자 수동 복구 명령:

```bash
firebase deploy --only functions:past-exam,hosting:listeningpractice --project listening-7680f --non-interactive
node .github/scripts/verify-deployment.mjs
```
