# GitHub → Firebase Hosting + Rules 자동 배포 설정

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
