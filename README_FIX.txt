listeningpractice 교사용 페이지 수정본

수정 내용:
- teacher.js의 showStudentDetail() 내부 summary/history 삼항 연산자에서 누락된 템플릿 리터럴 백틱(`) 2개를 추가했습니다.
- 이 문법 오류 때문에 발생하던 "Uncaught SyntaxError: Unexpected token 'class'"를 제거했습니다.
- teacher.js가 정상 파싱되므로 학생 등록 버튼의 click 이벤트 바인딩도 실행됩니다.

적용 방법:
1. 기존 프로젝트의 teacher.js를 이 파일로 교체합니다.
2. Firebase Hosting에 다시 배포합니다.
3. 브라우저에서 강력 새로고침(Ctrl+Shift+R 또는 Cmd+Shift+R) 후 확인합니다.
