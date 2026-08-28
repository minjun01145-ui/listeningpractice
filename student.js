import { db, storage } from "./firebase.js";
import {
  collection, doc, getDoc, getDocs, setDoc, addDoc, serverTimestamp, increment
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js";
import {
  ref, uploadBytes, getDownloadURL
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-storage.js";

const $ = (id) => document.getElementById(id);
const state = {
  student: null, rounds: [], round: null, groupIndex: null, groupQuestions: [], questionPos: 0,
  progress: null, mediaRecorder: null, mediaStream: null, chunks: [], recordStartedAt: 0,
  recordTimerId: null, listenStartedAt: 0, activePlayedSec: 0, lastPlayTick: 0, segmentEnded: false,
  hideEnglish: false, hideKorean: false, questionListenSet: new Set(), questionPassPlayedSec: 0
};
const audio = $("practiceAudio");

function fmtSec(sec = 0) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(sec / 60); const s = sec % 60;
  return `${m}분 ${s}초`;
}
function fmtClock(sec = 0) {
  sec = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(sec/60)).padStart(2,'0')}:${String(sec%60).padStart(2,'0')}`;
}
function progressId(studentNo, roundId, groupIndex) { return `${studentNo}__${roundId}__g${groupIndex}`; }
function groupLabel(round, index) {
  const g = round.groups?.[index];
  return g?.label || `${index*4+1}-${Math.min(index*4+4, round.questions.length)}번`;
}
function effectiveCounts(p) { return { listen: Math.min(3, p?.listenCount || 0), record: Math.min(3, p?.recordCount || 0) }; }
function currentReadNo() {
  const c = effectiveCounts(state.progress);
  return Math.min(7, c.listen + c.record + 1);
}
function mode() {
  const n = currentReadNo();
  if (n <= 3) return "listen";
  if (n <= 6) return "record";
  return "done";
}

async function login(studentNo, name) {
  const snap = await getDoc(doc(db, "students", studentNo));
  if (!snap.exists() || String(snap.data().name).trim() !== name.trim()) throw new Error("학번 또는 이름이 등록 정보와 일치하지 않습니다.");
  state.student = { studentNo, name: snap.data().name };
  sessionStorage.setItem("elisteningStudent", JSON.stringify(state.student));
  await enterApp();
}

async function enterApp() {
  $("loginView").classList.add("hidden"); $("studentView").classList.remove("hidden");
  $("studentBadge").textContent = `${state.student.studentNo} ${state.student.name}`;
  await Promise.all([loadRounds(), loadLatestProgress()]);
}

async function loadRounds() {
  const snap = await getDocs(collection(db, "rounds"));
  state.rounds = snap.docs.map(d => ({ id:d.id, ...d.data() })).filter(r => r.visible !== false)
    .sort((a,b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
  $("roundSelect").innerHTML = `<option value="">회차를 선택하세요</option>` + state.rounds.map(r => `<option value="${r.id}">${escapeHtml(r.title || "이름 없는 회차")}</option>`).join("");
}

async function loadLatestProgress() {
  const snap = await getDocs(collection(db, "progress"));
  const list = snap.docs.map(d => ({id:d.id,...d.data()})).filter(p => p.studentNo === state.student.studentNo)
    .sort((a,b)=>(b.updatedAt?.seconds||0)-(a.updatedAt?.seconds||0));
  if (!list.length) { $("currentProgressCard").classList.add("hidden"); return; }
  const p = list[0]; const round = state.rounds.find(r=>r.id===p.roundId); const c=effectiveCounts(p);
  $("currentProgressCard").classList.remove("hidden");
  $("currentProgressStatus").textContent = c.listen===3 && c.record===3 ? "완료" : `${c.listen+c.record}/6`;
  $("currentProgressText").innerHTML = `<b>${escapeHtml(round?.title || p.roundTitle || "회차")}</b> · ${escapeHtml(p.groupLabel || `묶음 ${Number(p.groupIndex)+1}`)}<br><span class="muted">음원 ${c.listen}/3 · 녹음 ${c.record}/3 · 음원 재생 누적 ${fmtSec(p.totalListenSec)}</span>`;
}

async function selectRound(roundId) {
  state.round = state.rounds.find(r=>r.id===roundId) || null;
  state.groupIndex = null; state.progress = null;
  $("practiceSection").classList.add("hidden"); $("floatingAudio").classList.add("hidden");
  if (!state.round) { $("groupSection").classList.add("hidden"); return; }
  const count = Math.ceil((state.round.questions?.length || 0)/4);
  const buttons = [];
  for (let i=0;i<count;i++) {
    const pid = progressId(state.student.studentNo, state.round.id, i);
    const pSnap = await getDoc(doc(db,"progress",pid));
    const p = pSnap.exists() ? pSnap.data() : null; const c=effectiveCounts(p); const done=c.listen===3&&c.record===3;
    buttons.push(`<button class="btn group-btn ${done?'done':''}" data-group="${i}">${escapeHtml(groupLabel(state.round,i))}${done?' ✓':''}</button>`);
  }
  $("groupButtons").innerHTML = buttons.join(""); $("groupSection").classList.remove("hidden");
  document.querySelectorAll("[data-group]").forEach(btn => btn.addEventListener("click",()=>openGroup(Number(btn.dataset.group))));
}

async function openGroup(index) {
  await stopAllMedia();
  state.groupIndex=index; state.questionPos=0; state.groupQuestions = state.round.questions.slice(index*4,index*4+4);state.questionListenSet.clear();state.questionPassPlayedSec=0;
  const pid=progressId(state.student.studentNo,state.round.id,index); const snap=await getDoc(doc(db,"progress",pid));
  state.progress = snap.exists() ? snap.data() : { studentNo:state.student.studentNo, name:state.student.name, roundId:state.round.id, roundTitle:state.round.title, groupIndex:index, groupLabel:groupLabel(state.round,index), listenCount:0, recordCount:0, totalListenSec:0, totalRecordSec:0 };
  $("practiceSection").classList.remove("hidden");
  $("practiceTitle").textContent = `${state.round.title} · ${groupLabel(state.round,index)}`;
  renderScript(); renderProgress(); configureAudio();
  setTimeout(()=>$("practiceSection").scrollIntoView({behavior:"smooth", block:"start"}),50);
}

function renderScript() {
  const q=state.groupQuestions[state.questionPos]; if(!q)return;
  $("scriptNumber").textContent = `${q.number}번`;
  const rows=Array.isArray(q.rows)&&q.rows.length?q.rows:q.text?.split("\n").filter(Boolean).map(line=>({english:line,korean:""}))||[];
  $("scriptText").innerHTML=`<div class="bilingual-table" role="table" aria-label="영어와 한글 대본"><div class="bilingual-head english-col" role="columnheader">영어</div><div class="bilingual-head korean-col" role="columnheader">한글</div>${rows.map(r=>`<div class="bilingual-cell english-col ${state.hideEnglish?'masked':''}" role="cell"><span>${escapeHtml(r.english)}</span></div><div class="bilingual-cell korean-col ${state.hideKorean?'masked':''}" role="cell"><span>${escapeHtml(r.korean)}</span></div>`).join("")}</div>`;
  $("toggleEnglish").textContent=state.hideEnglish?"영어 보이기":"영어 가리기";$("toggleEnglish").setAttribute("aria-pressed",String(state.hideEnglish));
  $("toggleKorean").textContent=state.hideKorean?"한글 보이기":"한글 가리기";$("toggleKorean").setAttribute("aria-pressed",String(state.hideKorean));
  $("prevQuestion").disabled=state.questionPos===0; $("nextQuestion").disabled=state.questionPos===state.groupQuestions.length-1;
  $("scriptDots").innerHTML=state.groupQuestions.map((_,i)=>`<span class="dot ${i===state.questionPos?'active':''}"></span>`).join("");
}

function renderProgress() {
  const c=effectiveCounts(state.progress), n=currentReadNo(), m=mode();
  $("readSteps").innerHTML = Array.from({length:6},(_,i)=>{
    const step=i+1, type=step<=3?'listen':'record', done=step<=c.listen || (step>3 && step<=3+c.record), active=step===n;
    return `<div class="read-step ${type} ${done?'done':''} ${active?'active':''}">${step}회<br>${type==='listen'?'음원':'녹음'}</div>`;
  }).join("");
  if(m==="done") {
    $("readStatus").textContent="필수 6회 읽기를 모두 완료했습니다."; $("readModePill").textContent="완료"; $("readModePill").className="status-pill success";
    $("listenInfo").classList.add("hidden"); $("recordInfo").classList.add("hidden"); $("floatingAudio").classList.add("hidden");
  } else if(m==="listen") {
    $("readStatus").textContent=`${n}번째 읽기 · 음원을 들으며 따라 읽기`;
    $("readModePill").textContent=`음원 ${c.listen}/3`; $("readModePill").className="status-pill";
    $("listenInfo").classList.remove("hidden"); $("recordInfo").classList.add("hidden");
    if(audio.src) $("floatingAudio").classList.remove("hidden");
  } else {
    $("readStatus").textContent=`${n}번째 읽기 · 내 목소리 녹음`;
    $("readModePill").textContent=`녹음 ${c.record}/3`; $("readModePill").className="status-pill warn";
    $("listenInfo").classList.add("hidden"); $("recordInfo").classList.remove("hidden"); $("floatingAudio").classList.add("hidden");
  }
}

function configureAudio() {
  audio.pause(); audio.removeAttribute("src"); audio.load(); state.activePlayedSec=0; state.segmentEnded=false;
  const g=state.round.groups?.[state.groupIndex] || {};
  const url=g.audioUrl || state.round.wholeAudioUrl;
  if(!url) { $("noAudioNotice").classList.remove("hidden"); $("floatingAudio").classList.add("hidden"); return; }
  $("noAudioNotice").classList.add("hidden"); audio.src=url; audio.playbackRate=Number($("speedSelect").value||1);
  audio.onloadedmetadata=()=>{const {start}=getSegmentBounds();if(start>0)audio.currentTime=start;};
  if(mode()==="listen") $("floatingAudio").classList.remove("hidden");
}

function getSegmentBounds() {
  const g=state.round?.groups?.[state.groupIndex] || {};
  if(isQuestionTimingMode()){
    const q=state.groupQuestions[state.questionPos];const timings=[...(state.round.questionTimings||[])].sort((a,b)=>Number(a.number)-Number(b.number));
    const index=timings.findIndex(t=>Number(t.number)===Number(q?.number));const current=timings[index];const next=timings[index+1];
    return {start:Number(current?.start)||0,end:next?Number(next.start):null};
  }
  return { start: g.audioUrl ? 0 : (Number(g.segmentStart)||0), end: g.audioUrl ? null : (Number(g.segmentEnd)||null) };
}

function isQuestionTimingMode(){
  const g=state.round?.groups?.[state.groupIndex]||{};if(g.audioUrl||!state.round?.wholeAudioUrl||!state.groupQuestions.length)return false;
  const numbers=new Set((state.round.questionTimings||[]).map(t=>Number(t.number)));
  return state.groupQuestions.every(q=>numbers.has(Number(q.number)));
}

function changeQuestion(nextPos){
  if(nextPos<0||nextPos>=state.groupQuestions.length)return;
  updatePlayedTime();audio.pause();$("playPause").textContent="재생";state.lastPlayTick=0;state.activePlayedSec=0;
  state.questionPos=nextPos;renderScript();configureAudio();
}

async function toggleAudio() {
  if(mode()!=="listen" || !audio.src) return;
  const {start,end}=getSegmentBounds();
  if(audio.paused) {
    if(state.segmentEnded || (end && audio.currentTime>=end-.15) || (!end && audio.ended)) { audio.currentTime=start; state.segmentEnded=false; state.activePlayedSec=0; }
    state.lastPlayTick=performance.now(); await audio.play(); $("playPause").textContent="일시중지";
  } else { updatePlayedTime(); audio.pause(); $("playPause").textContent="재생"; }
}
function updatePlayedTime() {
  if(!audio.paused && state.lastPlayTick) {
    const now=performance.now(); state.activePlayedSec += Math.max(0,(now-state.lastPlayTick)/1000); state.lastPlayTick=now;
  }
}

async function completeListen() {
  if(mode()!=="listen") return;
  updatePlayedTime(); audio.pause(); $("playPause").textContent="재생";
  let duration=state.activePlayedSec; state.activePlayedSec=0; state.lastPlayTick=0; state.segmentEnded=true;
  if(duration<3) return;
  if(isQuestionTimingMode()){
    state.questionListenSet.add(state.questionPos);state.questionPassPlayedSec+=duration;
    if(state.questionListenSet.size<state.groupQuestions.length){
      const next=state.groupQuestions.findIndex((_,i)=>!state.questionListenSet.has(i));changeQuestion(next);return;
    }
    duration=state.questionPassPlayedSec;state.questionListenSet.clear();state.questionPassPlayedSec=0;
  }
  const readNo=currentReadNo(); const pid=progressId(state.student.studentNo,state.round.id,state.groupIndex);
  await setDoc(doc(db,"progress",pid), {
    studentNo:state.student.studentNo,name:state.student.name,roundId:state.round.id,roundTitle:state.round.title,
    groupIndex:state.groupIndex,groupLabel:groupLabel(state.round,state.groupIndex),listenCount:increment(1),totalListenSec:increment(Math.round(duration)),updatedAt:serverTimestamp()
  },{merge:true});
  await addDoc(collection(db,"activityLogs"),{
    studentNo:state.student.studentNo,name:state.student.name,roundId:state.round.id,roundTitle:state.round.title,groupIndex:state.groupIndex,groupLabel:groupLabel(state.round,state.groupIndex),
    type:"listen",durationSec:Math.round(duration),readNo,createdAt:serverTimestamp()
  });
  state.progress.listenCount=(state.progress.listenCount||0)+1; state.progress.totalListenSec=(state.progress.totalListenSec||0)+Math.round(duration);
  renderProgress(); await loadLatestProgress();
  if(mode()==="listen") { if(isQuestionTimingMode()){state.questionPos=0;renderScript();configureAudio();}else{const {start}=getSegmentBounds();audio.currentTime=start;state.segmentEnded=false;} }
}

async function startRecording() {
  if(mode()!=="record") return;
  if(!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { alert("이 브라우저에서는 웹 녹음을 지원하지 않습니다. Safari/Chrome을 최신 버전으로 업데이트해 주세요."); return; }
  try {
    state.mediaStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
    const candidates=["audio/webm;codecs=opus","audio/mp4","audio/webm","audio/ogg;codecs=opus"];
    const mime=candidates.find(t=>MediaRecorder.isTypeSupported?.(t)) || "";
    state.chunks=[]; state.mediaRecorder=new MediaRecorder(state.mediaStream, mime?{mimeType:mime}:undefined);
    state.mediaRecorder.ondataavailable=e=>{if(e.data?.size)state.chunks.push(e.data);};
    state.mediaRecorder.onstop=saveRecording;
    state.recordStartedAt=performance.now(); state.mediaRecorder.start(1000);
    $("recordBtn").textContent="정지"; $("recordBtn").classList.add("recording"); $("recordStatus").textContent="녹음 중입니다…";
    state.recordTimerId=setInterval(()=>$("recordTimer").textContent=fmtClock((performance.now()-state.recordStartedAt)/1000),250);
  } catch(err) { alert(`마이크를 사용할 수 없습니다. 브라우저의 마이크 권한을 확인해 주세요.\n${err.message}`); }
}
function stopRecording() { if(state.mediaRecorder?.state==="recording") state.mediaRecorder.stop(); }
async function saveRecording() {
  clearInterval(state.recordTimerId); state.recordTimerId=null;
  const duration=(performance.now()-state.recordStartedAt)/1000;
  $("recordBtn").textContent="저장 중"; $("recordBtn").disabled=true; $("recordStatus").textContent="녹음 파일을 저장하고 있습니다…";
  state.mediaStream?.getTracks().forEach(t=>t.stop()); state.mediaStream=null;
  if(duration<2) { resetRecordUi("녹음이 너무 짧아 제출하지 않았습니다."); return; }
  const mime=state.mediaRecorder?.mimeType || state.chunks[0]?.type || "audio/webm";
  const ext=mime.includes("mp4")?"m4a":mime.includes("ogg")?"ogg":"webm";
  const blob=new Blob(state.chunks,{type:mime});
  try {
    const path=`recordings/${state.student.studentNo}/${state.round.id}/g${state.groupIndex+1}/${Date.now()}.${ext}`;
    const sref=ref(storage,path); await uploadBytes(sref,blob,{contentType:mime}); const url=await getDownloadURL(sref);
    const readNo=currentReadNo();
    await addDoc(collection(db,"activityLogs"),{
      studentNo:state.student.studentNo,name:state.student.name,roundId:state.round.id,roundTitle:state.round.title,groupIndex:state.groupIndex,groupLabel:groupLabel(state.round,state.groupIndex),
      type:"record",durationSec:Math.round(duration),readNo,recordingUrl:url,recordingPath:path,mimeType:mime,createdAt:serverTimestamp()
    });
    const pid=progressId(state.student.studentNo,state.round.id,state.groupIndex);
    await setDoc(doc(db,"progress",pid),{
      studentNo:state.student.studentNo,name:state.student.name,roundId:state.round.id,roundTitle:state.round.title,groupIndex:state.groupIndex,groupLabel:groupLabel(state.round,state.groupIndex),
      recordCount:increment(1),totalRecordSec:increment(Math.round(duration)),updatedAt:serverTimestamp()
    },{merge:true});
    state.progress.recordCount=(state.progress.recordCount||0)+1; state.progress.totalRecordSec=(state.progress.totalRecordSec||0)+Math.round(duration);
    resetRecordUi("저장 완료되었습니다."); renderProgress(); await loadLatestProgress();
  } catch(err) { console.error(err); resetRecordUi("저장에 실패했습니다. 인터넷 연결을 확인하고 다시 녹음해 주세요."); }
}
function resetRecordUi(message) { $("recordBtn").disabled=false; $("recordBtn").textContent="녹음"; $("recordBtn").classList.remove("recording"); $("recordTimer").textContent="00:00"; $("recordStatus").textContent=message; }

async function stopAllMedia() {
  if(!audio.paused) { updatePlayedTime(); audio.pause(); }
  $("playPause").textContent="재생";
  if(state.mediaRecorder?.state==="recording") { state.mediaRecorder.onstop=null; state.mediaRecorder.stop(); }
  state.mediaStream?.getTracks().forEach(t=>t.stop()); state.mediaStream=null;
  clearInterval(state.recordTimerId); state.recordTimerId=null;
}
function escapeHtml(s="") { return String(s).replace(/[&<>'"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c])); }

$("loginForm").addEventListener("submit",async e=>{e.preventDefault(); $("loginError").classList.add("hidden"); try{await login($("studentNo").value.trim(),$("studentName").value.trim());}catch(err){$("loginError").textContent=err.message;$("loginError").classList.remove("hidden");}});
$("logoutBtn").addEventListener("click",async()=>{await stopAllMedia();sessionStorage.removeItem("elisteningStudent");location.reload();});
$("roundSelect").addEventListener("change",e=>selectRound(e.target.value));
$("prevQuestion").addEventListener("click",()=>changeQuestion(state.questionPos-1));
$("nextQuestion").addEventListener("click",()=>changeQuestion(state.questionPos+1));
$("toggleEnglish").addEventListener("click",()=>{state.hideEnglish=!state.hideEnglish;renderScript();});
$("toggleKorean").addEventListener("click",()=>{state.hideKorean=!state.hideKorean;renderScript();});
$("playPause").addEventListener("click",toggleAudio);
$("back3").addEventListener("click",()=>{const {start}=getSegmentBounds();audio.currentTime=Math.max(start,audio.currentTime-3);});
$("forward3").addEventListener("click",()=>{const {end}=getSegmentBounds();audio.currentTime=end?Math.min(end-.05,audio.currentTime+3):Math.min(audio.duration||Infinity,audio.currentTime+3);});
$("speedSelect").addEventListener("change",e=>audio.playbackRate=Number(e.target.value));
$("recordBtn").addEventListener("click",()=>state.mediaRecorder?.state==="recording"?stopRecording():startRecording());
audio.addEventListener("play",()=>{state.lastPlayTick=performance.now();});
audio.addEventListener("pause",()=>{updatePlayedTime();state.lastPlayTick=0;});
audio.addEventListener("timeupdate",()=>{const {end}=getSegmentBounds();if(end && audio.currentTime>=end-.08 && !state.segmentEnded){completeListen();}});
audio.addEventListener("ended",()=>{if(!state.segmentEnded)completeListen();});
window.addEventListener("beforeunload",()=>{state.mediaStream?.getTracks().forEach(t=>t.stop());});

const cached=sessionStorage.getItem("elisteningStudent");
if(cached){try{state.student=JSON.parse(cached);enterApp().catch(()=>sessionStorage.removeItem("elisteningStudent"));}catch{sessionStorage.removeItem("elisteningStudent");}}
