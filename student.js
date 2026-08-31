import { db, storage } from "./firebase.js";
import { collection, doc, getDoc, getDocs, serverTimestamp, runTransaction } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js";
import { ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-storage.js";

const $ = id => document.getElementById(id);
const audio = $("practiceAudio");
const state = {
  student:null, rounds:[], round:null, groupIndex:null, groupQuestions:[], progress:null,
  hideEnglish:false, hideKorean:false, activePlayedSec:0, lastPlayTick:0,
  segmentEnded:false, completingListen:false, recording:null, pendingRecording:null,
  recordTimerId:null, testRecording:null, testTimerId:null, testAudioUrl:"", busy:false, startingRecorder:false
};

function fmtSec(sec=0){sec=Math.max(0,Math.round(Number(sec)||0));return `${Math.floor(sec/60)}분 ${sec%60}초`;}
function fmtClock(sec=0){sec=Math.max(0,Math.floor(Number(sec)||0));return `${String(Math.floor(sec/60)).padStart(2,"0")}:${String(sec%60).padStart(2,"0")}`;}
function escapeHtml(value=""){return String(value).replace(/[&<>'"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]));}
function uniqueId(){return crypto.randomUUID?.()||`${Date.now()}-${Math.random().toString(36).slice(2)}`;}
function safePathPart(value){return String(value).replace(/[^a-zA-Z0-9가-힣._-]/g,"_").slice(0,80)||"unknown";}
function progressId(studentNo,roundId,groupIndex){return `${studentNo}__${roundId}__g${groupIndex}`;}
function groupLabel(round,index){
  const questions=round?.questions||[];
  const first=questions[index*4]?.number??index*4+1;
  const last=questions[Math.min(index*4+3,questions.length-1)]?.number??index*4+4;
  return round?.groups?.[index]?.label||`${first}-${last}번`;
}
function effectiveCounts(progress){return {listen:Math.min(3,Math.max(0,Number(progress?.listenCount)||0)),record:Math.min(3,Math.max(0,Number(progress?.recordCount)||0))};}
function currentReadNo(){const counts=effectiveCounts(state.progress);return Math.min(7,counts.listen+counts.record+1);}
function mode(){const readNo=currentReadNo();return readNo<=3?"listen":readNo<=6?"record":"done";}
function isInteractionLocked(){return state.busy||state.completingListen||state.startingRecorder||Boolean(state.recording);}
function explainMicrophoneError(error){
  if(error?.name==="NotAllowedError"||error?.name==="SecurityError")return "마이크 권한이 거부되었습니다. 브라우저의 사이트 설정에서 마이크를 허용한 뒤 다시 시도해 주세요.";
  if(error?.name==="NotFoundError")return "사용할 수 있는 마이크를 찾지 못했습니다. 기기의 마이크 설정을 확인해 주세요.";
  if(error?.name==="NotReadableError")return "다른 앱이 마이크를 사용 중일 수 있습니다. 다른 앱을 닫고 다시 시도해 주세요.";
  return "마이크를 시작하지 못했습니다. 브라우저를 최신 버전으로 업데이트한 뒤 다시 시도해 주세요.";
}
function supportedMimeType(){
  const candidates=["audio/webm;codecs=opus","audio/mp4","audio/webm","audio/ogg;codecs=opus"];
  if(typeof MediaRecorder?.isTypeSupported!=="function")return "";
  return candidates.find(type=>MediaRecorder.isTypeSupported(type))||"";
}
async function createRecorderSession(){
  if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder)throw Object.assign(new Error("unsupported"),{name:"UnsupportedError"});
  const stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
  const mimeType=supportedMimeType();let recorder;
  try{recorder=mimeType?new MediaRecorder(stream,{mimeType}):new MediaRecorder(stream);}
  catch(error){
    try{if(!mimeType)throw error;recorder=new MediaRecorder(stream);}
    catch(fallbackError){stream.getTracks().forEach(track=>track.stop());throw fallbackError;}
  }
  return {stream,recorder,chunks:[],startedAtPerf:0,intentionalTrackStop:false,manualStop:false,failed:false};
}
function stopTracks(session){if(!session)return;session.intentionalTrackStop=true;session.stream?.getTracks().forEach(track=>track.stop());}
function setBusy(busy){
  state.busy=busy;document.body.classList.toggle("is-busy",busy);$("savingOverlay").classList.toggle("hidden",!busy);
  for(const id of ["roundSelect","logoutBtn","recordBtn","retrySaveBtn","deviceTestBtn"])$(id).disabled=busy;
  document.querySelectorAll("[data-group]").forEach(button=>{button.disabled=busy;});
}

async function login(studentNo,name){
  const snap=await getDoc(doc(db,"students",studentNo));
  if(!snap.exists()||String(snap.data().name).trim()!==name.trim())throw new Error("학번 또는 이름이 등록 정보와 일치하지 않습니다.");
  state.student={studentNo,name:snap.data().name};sessionStorage.setItem("elisteningStudent",JSON.stringify(state.student));await enterApp();
}
async function enterApp(){
  $("loginView").classList.add("hidden");$("studentView").classList.remove("hidden");
  $("studentBadge").textContent=`${state.student.studentNo} ${state.student.name}`;await loadRounds();await loadLatestProgress();
}
async function loadRounds(){
  const snap=await getDocs(collection(db,"rounds"));
  state.rounds=snap.docs.map(item=>({id:item.id,...item.data()})).filter(round=>round.visible!==false).sort((a,b)=>(b.createdAt?.seconds||0)-(a.createdAt?.seconds||0));
  $("roundSelect").innerHTML=`<option value="">회차를 선택하세요</option>${state.rounds.map(round=>`<option value="${escapeHtml(round.id)}">${escapeHtml(round.title||"이름 없는 회차")}</option>`).join("")}`;
}
async function loadLatestProgress(){
  const snap=await getDocs(collection(db,"progress"));
  const list=snap.docs.map(item=>({id:item.id,...item.data()})).filter(progress=>progress.studentNo===state.student.studentNo).sort((a,b)=>(b.updatedAt?.seconds||0)-(a.updatedAt?.seconds||0));
  if(!list.length){$("currentProgressCard").classList.add("hidden");return;}
  const progress=list[0],round=state.rounds.find(item=>item.id===progress.roundId),counts=effectiveCounts(progress);
  $("currentProgressCard").classList.remove("hidden");$("currentProgressStatus").textContent=counts.listen===3&&counts.record===3?"완료":`${counts.listen+counts.record}/6`;
  $("currentProgressText").innerHTML=`<b>${escapeHtml(round?.title||progress.roundTitle||"회차")}</b> · ${escapeHtml(progress.groupLabel||`묶음 ${Number(progress.groupIndex)+1}`)}<br><span class="muted">음원 ${counts.listen}/3 · 녹음 ${counts.record}/3 · 음원 재생 누적 ${fmtSec(progress.totalListenSec)}</span>`;
}
async function selectRound(roundId){
  if(isInteractionLocked()){$("roundSelect").value=state.round?.id||"";return alert("현재 녹음 또는 저장이 끝난 뒤 회차를 변경해 주세요.");}
  if(state.pendingRecording){$("roundSelect").value=state.round?.id||"";return alert("완료된 녹음의 ‘다시 저장’을 먼저 눌러 주세요. 다시 녹음할 필요는 없습니다.");}
  await stopAllMedia();state.round=state.rounds.find(round=>round.id===roundId)||null;state.groupIndex=null;state.progress=null;
  $("practiceSection").classList.add("hidden");$("floatingAudio").classList.add("hidden");
  if(!state.round){$("groupSection").classList.add("hidden");return;}
  const count=Math.ceil((state.round.questions?.length||0)/4),buttons=[];
  for(let index=0;index<count;index+=1){
    const snap=await getDoc(doc(db,"progress",progressId(state.student.studentNo,state.round.id,index))),counts=effectiveCounts(snap.exists()?snap.data():null),done=counts.listen===3&&counts.record===3;
    buttons.push(`<button type="button" class="btn group-btn ${done?"done":""}" data-group="${index}">${escapeHtml(groupLabel(state.round,index))}${done?" ✓":""}</button>`);
  }
  $("groupButtons").innerHTML=buttons.join("");$("groupSection").classList.remove("hidden");
  document.querySelectorAll("[data-group]").forEach(button=>button.addEventListener("click",()=>openGroup(Number(button.dataset.group))));
}
async function openGroup(index){
  if(isInteractionLocked())return alert("현재 녹음 또는 저장이 끝난 뒤 다른 묶음을 선택해 주세요.");
  if(state.pendingRecording)return alert("완료된 녹음의 ‘다시 저장’을 먼저 눌러 주세요. 다시 녹음할 필요는 없습니다.");
  await stopAllMedia();state.groupIndex=index;state.groupQuestions=(state.round.questions||[]).slice(index*4,index*4+4);
  const snap=await getDoc(doc(db,"progress",progressId(state.student.studentNo,state.round.id,index)));
  state.progress=snap.exists()?snap.data():{studentNo:state.student.studentNo,name:state.student.name,roundId:state.round.id,roundTitle:state.round.title,groupIndex:index,groupLabel:groupLabel(state.round,index),listenCount:0,recordCount:0,totalListenSec:0,totalRecordSec:0};
  $("practiceSection").classList.remove("hidden");$("practiceTitle").textContent=`${state.round.title} · ${groupLabel(state.round,index)}`;
  renderScript();renderProgress();configureAudio();setTimeout(()=>$("practiceSection").scrollIntoView({behavior:"smooth",block:"start"}),50);
}
function questionRows(question){if(Array.isArray(question?.rows)&&question.rows.length)return question.rows;return String(question?.text||"").split("\n").filter(Boolean).map(line=>({english:line,korean:""}));}
function renderScript(){
  $("scriptNumber").textContent=`${groupLabel(state.round,state.groupIndex)} 전체 대본`;
  $("scriptText").innerHTML=`<div class="group-script-list">${state.groupQuestions.map(question=>`<section class="question-script"><div class="question-script-title">${escapeHtml(question.number)}번</div><div class="bilingual-table" role="table" aria-label="${escapeHtml(question.number)}번 영어와 한글 대본"><div class="bilingual-head english-col" role="columnheader">영어</div><div class="bilingual-head korean-col" role="columnheader">한글</div>${questionRows(question).map(row=>`<div class="bilingual-cell english-col ${state.hideEnglish?"masked":""}" role="cell"><span>${escapeHtml(row.english)}</span></div><div class="bilingual-cell korean-col ${state.hideKorean?"masked":""}" role="cell"><span>${escapeHtml(row.korean)}</span></div>`).join("")}</div></section>`).join("")}</div>`;
  $("toggleEnglish").textContent=state.hideEnglish?"영어 보이기":"영어 가리기";$("toggleEnglish").setAttribute("aria-pressed",String(state.hideEnglish));
  $("toggleKorean").textContent=state.hideKorean?"한글 보이기":"한글 가리기";$("toggleKorean").setAttribute("aria-pressed",String(state.hideKorean));
}
function renderProgress(){
  const counts=effectiveCounts(state.progress),readNo=currentReadNo(),currentMode=mode();
  $("readSteps").innerHTML=Array.from({length:6},(_,index)=>{const step=index+1,type=step<=3?"listen":"record",done=step<=counts.listen||(step>3&&step<=3+counts.record);return `<div class="read-step ${type} ${done?"done":""} ${step===readNo?"active":""}">${step}회<br>${type==="listen"?"듣기":"녹음"}${done?" ✓":""}</div>`;}).join("");
  if(currentMode==="done"){
    $("readStatus").textContent="이 4문제 묶음의 필수 6회를 모두 완료했습니다.";$("readModePill").textContent="완료";$("readModePill").className="status-pill success";
    $("listenInfo").classList.add("hidden");$("recordInfo").classList.add("hidden");$("floatingAudio").classList.add("hidden");
  }else if(currentMode==="listen"){
    $("readStatus").textContent=`${readNo}회 듣기 · 묶음 전체 음원을 들으며 따라 읽기`;$("readModePill").textContent=`듣기 ${counts.listen}/3`;$("readModePill").className="status-pill";
    $("listenInfo").classList.remove("hidden");$("recordInfo").classList.add("hidden");if(audio.src)$("floatingAudio").classList.remove("hidden");
  }else{
    $("readStatus").textContent=`${readNo}회 녹음 · 4문제를 한 번에 읽기`;$("readModePill").textContent=`녹음 ${counts.record}/3`;$("readModePill").className="status-pill warn";
    $("listenInfo").classList.add("hidden");$("recordInfo").classList.remove("hidden");$("floatingAudio").classList.add("hidden");
  }
}

function hasSegmentValue(value){return value!==""&&value!==null&&value!==undefined&&Number.isFinite(Number(value));}
function getSegmentBounds(){
  const group=state.round?.groups?.[state.groupIndex]||{};
  if(group.audioUrl)return {start:0,end:null,source:"group"};
  if(hasSegmentValue(group.segmentStart)||hasSegmentValue(group.segmentEnd))return {start:hasSegmentValue(group.segmentStart)?Number(group.segmentStart):0,end:hasSegmentValue(group.segmentEnd)?Number(group.segmentEnd):null,source:"segment"};
  const timings=[...(state.round?.questionTimings||[])].filter(timing=>Number.isFinite(Number(timing.start))).sort((a,b)=>Number(a.start)-Number(b.start));
  const numbers=new Set(state.groupQuestions.map(question=>Number(question.number))),included=timings.filter(timing=>numbers.has(Number(timing.number)));
  if(included.length){const first=included[0],last=included[included.length-1],next=timings.find(timing=>Number(timing.start)>Number(last.start)),explicitEnd=hasSegmentValue(last.end)?Number(last.end):null;return {start:Number(first.start)||0,end:explicitEnd??(next?Number(next.start):null),source:"questionTimings"};}
  return {start:0,end:null,source:"whole"};
}
function configureAudio(){
  audio.pause();audio.removeAttribute("src");audio.load();state.activePlayedSec=0;state.lastPlayTick=0;state.segmentEnded=false;
  const group=state.round?.groups?.[state.groupIndex]||{},url=group.audioUrl||state.round?.wholeAudioUrl;
  if(!url){$("noAudioNotice").classList.remove("hidden");$("floatingAudio").classList.add("hidden");return;}
  $("noAudioNotice").classList.add("hidden");audio.src=url;audio.playbackRate=Number($("speedSelect").value||1);
  audio.onloadedmetadata=()=>{const {start,end}=getSegmentBounds();audio.currentTime=Math.min(start,Math.max(0,(audio.duration||start)-0.05));if(end&&end>audio.duration+0.25)console.warn("설정된 묶음 종료 시간이 음원 길이보다 깁니다.");};
  if(mode()==="listen")$("floatingAudio").classList.remove("hidden");
}
function updatePlayedTime(){if(!audio.paused&&state.lastPlayTick){const now=performance.now();state.activePlayedSec+=Math.max(0,(now-state.lastPlayTick)/1000);state.lastPlayTick=now;}}
async function toggleAudio(){
  if(mode()!=="listen"||!audio.src||state.completingListen)return;const {start,end}=getSegmentBounds();
  if(audio.paused){if(state.segmentEnded||(end&&audio.currentTime>=end-.15)||(!end&&audio.ended)){audio.currentTime=start;state.segmentEnded=false;state.activePlayedSec=0;}try{await audio.play();$("playPause").textContent="일시중지";}catch{$("playPause").textContent="재생";}}
  else{updatePlayedTime();audio.pause();$("playPause").textContent="재생";}
}
function learningSnapshot(readNo){
  const first=state.groupQuestions[0]?.number??state.groupIndex*4+1,last=state.groupQuestions[state.groupQuestions.length-1]?.number??state.groupIndex*4+4;
  return {studentNo:state.student.studentNo,studentName:state.student.name,roundId:state.round.id,roundTitle:state.round.title,groupIndex:state.groupIndex,groupLabel:groupLabel(state.round,state.groupIndex),questionStart:Number(first),questionEnd:Number(last),questionRange:`${first}-${last}번`,readNo,startedAtMs:Date.now()};
}
async function completeListen(){
  if(mode()!=="listen"||state.completingListen||state.segmentEnded)return;state.completingListen=true;updatePlayedTime();audio.pause();$("playPause").textContent="재생";
  const duration=Math.max(0,state.activePlayedSec);state.activePlayedSec=0;state.lastPlayTick=0;state.segmentEnded=true;
  const snapshot=learningSnapshot(currentReadNo()),attemptId=`listen-${uniqueId()}`;
  try{
    const result=await runTransaction(db,async transaction=>{
      const progressRef=doc(db,"progress",progressId(snapshot.studentNo,snapshot.roundId,snapshot.groupIndex)),logRef=doc(db,"activityLogs",attemptId);
      const progressSnap=await transaction.get(progressRef),logSnap=await transaction.get(logRef);if(logSnap.exists())return null;
      const current=progressSnap.exists()?progressSnap.data():{},listenCount=Math.min(3,(Number(current.listenCount)||0)+1),totalListenSec=(Number(current.totalListenSec)||0)+Math.round(duration),recordCount=Number(current.recordCount)||0,totalRecordSec=Number(current.totalRecordSec)||0;
      transaction.set(progressRef,{studentNo:snapshot.studentNo,name:snapshot.studentName,roundId:snapshot.roundId,roundTitle:snapshot.roundTitle,groupIndex:snapshot.groupIndex,groupLabel:snapshot.groupLabel,listenCount,recordCount,totalListenSec,totalRecordSec,updatedAt:serverTimestamp()},{merge:true});
      transaction.set(logRef,{studentNo:snapshot.studentNo,name:snapshot.studentName,roundId:snapshot.roundId,roundTitle:snapshot.roundTitle,groupIndex:snapshot.groupIndex,groupLabel:snapshot.groupLabel,questionStart:snapshot.questionStart,questionEnd:snapshot.questionEnd,questionRange:snapshot.questionRange,type:"listen",durationSec:Math.round(duration),readNo:snapshot.readNo,activityId:attemptId,createdAt:serverTimestamp()});
      return {listenCount,totalListenSec};
    });
    if(result){
      state.progress.listenCount=result.listenCount;state.progress.totalListenSec=result.totalListenSec;renderProgress();
      try{await loadLatestProgress();}catch(error){console.warn("듣기 저장 후 최신 진행 상황을 불러오지 못했습니다.",error);}
    }
    if(mode()==="listen"){audio.currentTime=getSegmentBounds().start;state.segmentEnded=false;}
  }catch(error){console.error("듣기 기록 저장 실패",error);state.segmentEnded=false;alert("듣기는 끝났지만 진행 상황을 저장하지 못했습니다. 인터넷 연결을 확인한 뒤 음원을 다시 재생해 주세요.");}
  finally{state.completingListen=false;}
}

function minimumRecordingSec(){const {start,end}=getSegmentBounds(),groupDuration=end&&end>start?end-start:Number.isFinite(audio.duration)?audio.duration-start:0;return groupDuration>0?Math.min(45,Math.max(12,Math.round(groupDuration*.4))):15;}
async function startRecording(){
  if(mode()!=="record"||state.busy||state.recording||state.startingRecorder)return;if(state.pendingRecording)return alert("완료된 녹음의 ‘다시 저장’을 눌러 주세요. 다시 녹음할 필요는 없습니다.");if(state.testRecording)return alert("휴대폰 녹음 테스트를 먼저 종료해 주세요.");
  state.startingRecorder=true;$("recordBtn").disabled=true;$("recordBtn").textContent="마이크 준비 중";
  let session;
  try{
    session=await createRecorderSession();session.snapshot=learningSnapshot(currentReadNo());session.snapshot.startedAtMs=Date.now();state.recording=session;
    session.recorder.ondataavailable=event=>{if(event.data?.size)session.chunks.push(event.data);};session.recorder.onerror=()=>failActiveRecording(session,"녹음 중 문제가 발생했습니다. 마이크 권한과 다른 앱의 마이크 사용 여부를 확인한 뒤 다시 시도해 주세요.");session.recorder.onstop=()=>finishRecording(session);
    session.stream.getAudioTracks().forEach(track=>track.addEventListener("ended",()=>{if(!session.intentionalTrackStop)failActiveRecording(session,"마이크 연결이 중간에 끊겼습니다. 진행 상황은 올라가지 않았습니다. 마이크 상태를 확인한 뒤 다시 시도해 주세요.");}));
    session.startedAtPerf=performance.now();session.recorder.start(1000);$("recordBtn").textContent="정지";$("recordBtn").classList.add("recording");$("recordStatus").textContent=`${session.snapshot.questionRange} 전체를 순서대로 읽고 정지하세요.`;
    state.recordTimerId=setInterval(()=>$("recordTimer").textContent=fmtClock((performance.now()-session.startedAtPerf)/1000),250);
  }catch(error){console.error("녹음 시작 실패",error);if(session)stopTracks(session);resetRecordUi("녹음 버튼을 누르면 시작합니다.");alert(error?.name==="UnsupportedError"?"이 브라우저에서는 웹 녹음을 지원하지 않습니다. Safari 또는 Chrome을 최신 버전으로 업데이트해 주세요.":explainMicrophoneError(error));}
  finally{state.startingRecorder=false;if(state.recording)$("recordBtn").disabled=false;}
}
function stopRecording(){const session=state.recording;if(!session||session.recorder.state==="inactive")return;session.manualStop=true;try{session.recorder.stop();}catch{failActiveRecording(session,"녹음을 정상적으로 종료하지 못했습니다. 진행 상황은 올라가지 않았습니다. 다시 시도해 주세요.");}}
function failActiveRecording(session,message){
  if(!session||session.failed)return;session.failed=true;clearInterval(state.recordTimerId);state.recordTimerId=null;$("recordStatus").textContent=message;
  if(session.recorder?.state!=="inactive"){try{session.recorder.stop();}catch{/* onstop 정리 */}}
  else{stopTracks(session);if(state.recording===session)state.recording=null;resetRecordUi(message);}
}
async function finishRecording(session){
  clearInterval(state.recordTimerId);state.recordTimerId=null;const duration=Math.max(0,(performance.now()-session.startedAtPerf)/1000);stopTracks(session);if(state.recording===session)state.recording=null;
  if(session.failed||!session.manualStop){resetRecordUi(session.failed?$("recordStatus").textContent:"녹음이 예상보다 일찍 종료되었습니다. 진행 상황은 올라가지 않았습니다. 다시 시도해 주세요.");return;}
  const minimum=minimumRecordingSec();if(duration<minimum){resetRecordUi(`녹음 시간이 너무 짧습니다. ${session.snapshot.questionRange} 문제를 모두 읽은 뒤 녹음을 종료해 주세요. (최소 약 ${minimum}초)`);return;}
  const mimeType=session.recorder.mimeType||session.chunks[0]?.type||"audio/webm",blob=new Blob(session.chunks,{type:mimeType});if(!blob.size){resetRecordUi("녹음 파일을 만들지 못했습니다. 진행 상황은 올라가지 않았습니다. 다시 시도해 주세요.");return;}
  state.pendingRecording={blob,mimeType,duration,snapshot:session.snapshot,submissionId:`record-${uniqueId()}`};await uploadPendingRecording();
}
function recordingExtension(mimeType){return mimeType.includes("mp4")?"m4a":mimeType.includes("ogg")?"ogg":"webm";}
async function uploadPendingRecording(){
  const pending=state.pendingRecording;if(!pending||state.busy)return;setBusy(true);$("recordBtn").textContent="저장 중";$("recordStatus").textContent="녹음을 저장하고 있습니다...";$("retrySavePanel").classList.add("hidden");
  const {snapshot}=pending,path=`recordings/${safePathPart(snapshot.studentNo)}/${safePathPart(snapshot.roundId)}/g${snapshot.groupIndex+1}/${safePathPart(pending.submissionId)}.${recordingExtension(pending.mimeType)}`;
  try{
    const storageRef=ref(storage,path);await uploadBytes(storageRef,pending.blob,{contentType:pending.mimeType});const recordingUrl=await getDownloadURL(storageRef);
    const result=await runTransaction(db,async transaction=>{
      const logRef=doc(db,"activityLogs",pending.submissionId),progressRef=doc(db,"progress",progressId(snapshot.studentNo,snapshot.roundId,snapshot.groupIndex));
      const logSnap=await transaction.get(logRef),progressSnap=await transaction.get(progressRef);if(logSnap.exists())return {duplicate:true,progress:progressSnap.data()||{}};
      const current=progressSnap.exists()?progressSnap.data():{},recordCount=Math.min(3,(Number(current.recordCount)||0)+1),totalRecordSec=(Number(current.totalRecordSec)||0)+Math.round(pending.duration),listenCount=Number(current.listenCount)||0,totalListenSec=Number(current.totalListenSec)||0;
      transaction.set(logRef,{studentNo:snapshot.studentNo,name:snapshot.studentName,roundId:snapshot.roundId,roundTitle:snapshot.roundTitle,groupIndex:snapshot.groupIndex,groupLabel:snapshot.groupLabel,questionStart:snapshot.questionStart,questionEnd:snapshot.questionEnd,questionRange:snapshot.questionRange,type:"record",durationSec:Math.round(pending.duration),readNo:snapshot.readNo,recordingUrl,recordingPath:path,mimeType:pending.mimeType,activityId:pending.submissionId,recordingStartedAtMs:snapshot.startedAtMs,createdAt:serverTimestamp()});
      transaction.set(progressRef,{studentNo:snapshot.studentNo,name:snapshot.studentName,roundId:snapshot.roundId,roundTitle:snapshot.roundTitle,groupIndex:snapshot.groupIndex,groupLabel:snapshot.groupLabel,listenCount,recordCount,totalListenSec,totalRecordSec,updatedAt:serverTimestamp()},{merge:true});
      return {duplicate:false,progress:{recordCount,totalRecordSec}};
    });
    if(state.round?.id===snapshot.roundId&&state.groupIndex===snapshot.groupIndex){state.progress.recordCount=Number(result.progress.recordCount)||state.progress.recordCount||0;state.progress.totalRecordSec=Number(result.progress.totalRecordSec)||state.progress.totalRecordSec||0;renderProgress();updateCurrentGroupButton();}
    state.pendingRecording=null;resetRecordUi(result.duplicate?"이미 저장된 녹음입니다. 진도는 한 번만 반영되었습니다.":"녹음 저장이 완료되었습니다.");
    try{await loadLatestProgress();}catch(error){console.warn("녹음 저장 후 최신 진행 상황을 불러오지 못했습니다.",error);}
  }catch(error){console.error("녹음 저장 실패",error);$("recordStatus").textContent="녹음은 완료되었습니다. 다시 녹음하지 말고 ‘다시 저장’을 눌러 주세요.";$("retrySavePanel").classList.remove("hidden");$("recordBtn").textContent="녹음 완료";}
  finally{setBusy(false);if(state.pendingRecording)$("recordBtn").disabled=true;}
}
function updateCurrentGroupButton(){const button=document.querySelector(`[data-group="${state.groupIndex}"]`);if(!button)return;const counts=effectiveCounts(state.progress),done=counts.listen===3&&counts.record===3;button.classList.toggle("done",done);button.textContent=`${groupLabel(state.round,state.groupIndex)}${done?" ✓":""}`;}
function resetRecordUi(message){$("recordBtn").disabled=false;$("recordBtn").textContent="녹음";$("recordBtn").classList.remove("recording");$("recordTimer").textContent="00:00";$("recordStatus").textContent=message;$("retrySavePanel").classList.add("hidden");}

async function toggleDeviceTest(){
  if(state.busy||state.recording)return;if(state.testRecording){state.testRecording.manualStop=true;try{state.testRecording.recorder.stop();}catch{failDeviceTest(state.testRecording,"테스트 녹음을 종료하지 못했습니다. 다시 시도해 주세요.");}return;}
  let session;
  try{
    session=await createRecorderSession();state.testRecording=session;session.recorder.ondataavailable=event=>{if(event.data?.size)session.chunks.push(event.data);};session.recorder.onerror=()=>failDeviceTest(session,"테스트 녹음 중 문제가 생겼습니다. 마이크 설정을 확인해 주세요.");session.recorder.onstop=()=>finishDeviceTest(session);
    session.stream.getAudioTracks().forEach(track=>track.addEventListener("ended",()=>{if(!session.intentionalTrackStop)failDeviceTest(session,"테스트 중 마이크 연결이 끊겼습니다. 기기 설정을 확인해 주세요.");}));session.startedAtPerf=performance.now();session.recorder.start(500);
    $("deviceTestBtn").textContent="테스트 녹음 정지";$("deviceTestStatus").textContent="짧게 말한 뒤 정지 버튼을 누르세요.";state.testTimerId=setInterval(()=>$("deviceTestTimer").textContent=fmtClock((performance.now()-session.startedAtPerf)/1000),250);
  }catch(error){console.error("기기 테스트 시작 실패",error);if(session)stopTracks(session);$("deviceTestStatus").textContent=error?.name==="UnsupportedError"?"이 브라우저는 녹음 기능을 지원하지 않습니다. 최신 Safari 또는 Chrome에서 시도해 주세요.":explainMicrophoneError(error);}
}
function failDeviceTest(session,message){if(!session||session.failed)return;session.failed=true;$("deviceTestStatus").textContent=message;if(session.recorder?.state!=="inactive"){try{session.recorder.stop();}catch{/* finish에서 정리 */}}else finishDeviceTest(session);}
function finishDeviceTest(session){
  clearInterval(state.testTimerId);state.testTimerId=null;stopTracks(session);if(state.testRecording===session)state.testRecording=null;$("deviceTestBtn").textContent="테스트 녹음 시작";$("deviceTestTimer").textContent="00:00";
  if(session.failed||!session.manualStop){if(!session.failed)$("deviceTestStatus").textContent="테스트 녹음이 예상보다 일찍 끝났습니다. 다시 시도해 주세요.";return;}
  const mimeType=session.recorder.mimeType||session.chunks[0]?.type||"audio/webm",blob=new Blob(session.chunks,{type:mimeType});if(!blob.size){$("deviceTestStatus").textContent="녹음된 소리가 없습니다. 마이크 권한을 확인하고 다시 시도해 주세요.";return;}
  if(state.testAudioUrl)URL.revokeObjectURL(state.testAudioUrl);state.testAudioUrl=URL.createObjectURL(blob);$("deviceTestAudio").src=state.testAudioUrl;$("deviceTestAudio").classList.remove("hidden");$("deviceTestStatus").textContent="이 휴대폰에서 녹음 기능을 정상적으로 사용할 수 있습니다. 아래 재생 버튼으로 목소리를 확인하세요.";
}
async function stopAllMedia(){
  if(!audio.paused){updatePlayedTime();audio.pause();}$("playPause").textContent="재생";
  if(state.testRecording){const session=state.testRecording;session.failed=true;try{if(session.recorder.state!=="inactive")session.recorder.stop();}catch{stopTracks(session);}}
}

$("loginForm").addEventListener("submit",async event=>{event.preventDefault();$("loginError").classList.add("hidden");try{await login($("studentNo").value.trim(),$("studentName").value.trim());}catch(error){$("loginError").textContent=error.message;$("loginError").classList.remove("hidden");}});
$("logoutBtn").addEventListener("click",async()=>{if(isInteractionLocked())return alert("녹음을 저장하고 있습니다. 저장이 끝난 뒤 나가 주세요.");if(state.pendingRecording)return alert("완료된 녹음의 ‘다시 저장’을 먼저 눌러 주세요.");await stopAllMedia();sessionStorage.removeItem("elisteningStudent");location.reload();});
$("roundSelect").addEventListener("change",event=>selectRound(event.target.value));
$("toggleEnglish").addEventListener("click",()=>{state.hideEnglish=!state.hideEnglish;renderScript();});$("toggleKorean").addEventListener("click",()=>{state.hideKorean=!state.hideKorean;renderScript();});
$("playPause").addEventListener("click",toggleAudio);$("back3").addEventListener("click",()=>{const {start}=getSegmentBounds();audio.currentTime=Math.max(start,audio.currentTime-3);});
$("forward3").addEventListener("click",()=>{const {end}=getSegmentBounds(),maximum=end??(Number.isFinite(audio.duration)?audio.duration:audio.currentTime+3);audio.currentTime=Math.max(0,Math.min(maximum,audio.currentTime+3));});
$("speedSelect").addEventListener("change",event=>{audio.playbackRate=Number(event.target.value);});$("recordBtn").addEventListener("click",()=>state.recording?stopRecording():startRecording());$("retrySaveBtn").addEventListener("click",uploadPendingRecording);$("deviceTestBtn").addEventListener("click",toggleDeviceTest);
audio.addEventListener("play",()=>{state.lastPlayTick=performance.now();});audio.addEventListener("pause",()=>{updatePlayedTime();state.lastPlayTick=0;});audio.addEventListener("timeupdate",()=>{const {end}=getSegmentBounds();if(end&&audio.currentTime>=end-.08&&!state.segmentEnded)completeListen();});audio.addEventListener("ended",()=>{if(!state.segmentEnded)completeListen();});
document.addEventListener("visibilitychange",()=>{if(document.hidden&&!audio.paused){updatePlayedTime();audio.pause();$("playPause").textContent="재생";}});
window.addEventListener("beforeunload",event=>{if(state.busy||state.pendingRecording||state.recording){event.preventDefault();event.returnValue="";}});
window.addEventListener("unload",()=>{stopTracks(state.recording);stopTracks(state.testRecording);if(state.testAudioUrl)URL.revokeObjectURL(state.testAudioUrl);});

const cached=sessionStorage.getItem("elisteningStudent");if(cached){try{state.student=JSON.parse(cached);enterApp().catch(()=>sessionStorage.removeItem("elisteningStudent"));}catch{sessionStorage.removeItem("elisteningStudent");}}
