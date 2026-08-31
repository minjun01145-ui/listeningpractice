import { db, storage } from "./firebase.js";
import {
  collection, doc, getDoc, getDocs, setDoc, addDoc, deleteDoc, updateDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js";
import {
  ref, uploadBytes, getDownloadURL, deleteObject
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-storage.js";

const $=id=>document.getElementById(id);
const state={students:[],rounds:[],parsedQuestions:[]};
function escapeHtml(s=""){return String(s).replace(/[&<>'"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]));}
function fmtSec(sec=0){sec=Math.max(0,Math.round(Number(sec)||0));return `${Math.floor(sec/60)}분 ${sec%60}초`;}
function fmtDate(ts){if(!ts)return "-"; const d=ts.toDate?ts.toDate():new Date(ts);return d.toLocaleString("ko-KR",{month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"});}
function groupLabel(round,index){return round.groups?.[index]?.label||`${index*4+1}-${Math.min(index*4+4,round.questions.length)}번`;}

function parseQuestions(text){
  const lines=text.replace(/\r/g,"").split("\n"); const out=[]; let current=null;
  const numberRe=/^\s*(?:문제\s*)?(?:\[(\d{1,3})\]|(\d{1,3})\s*번|(\d{1,3})\s*[.)])\s*$/;
  const finish=()=>{if(current?.rows.length)out.push({...current,text:current.rows.map(r=>`${r.english}\t${r.korean}`).join("\n")});};
  for(const line of lines){
    const m=line.match(numberRe);
    if(m){finish();current={number:Number(m[1]||m[2]||m[3]),rows:[]};continue;}
    if(!current||!line.trim())continue;
    const tab=line.indexOf("\t");
    if(tab<0)continue;
    const english=line.slice(0,tab).trim();const korean=line.slice(tab+1).trim();
    if(english&&korean)current.rows.push({english,korean});
  }
  finish();return out;
}
function buildGroups(questions){return Array.from({length:Math.ceil(questions.length/4)},(_,i)=>({index:i,label:`${questions[i*4]?.number ?? i*4+1}-${questions[Math.min(i*4+3,questions.length-1)]?.number ?? i*4+4}번`,audioUrl:"",audioPath:"",segmentStart:"",segmentEnd:""}));}
function parseQuestionTimings(text){
  const normalized=text.replace(/<br\s*\/?\s*>/gi,"\n").replace(/\*\*/g,"");
  const re=/(\d{1,3})\s*번\s*(?:\||:|-)?\s*(\d{1,3}):([0-5]\d)(?::([0-5]\d))?/g;
  const byNumber=new Map();let match;
  while((match=re.exec(normalized))){
    const number=Number(match[1]);const a=Number(match[2]);const b=Number(match[3]);const c=match[4]===undefined?null:Number(match[4]);
    byNumber.set(number,{number,start:c===null?a*60+b:a*3600+b*60+c});
  }
  return [...byNumber.values()].sort((a,b)=>a.number-b.number);
}
function formatTimestamp(sec){sec=Math.max(0,Math.floor(Number(sec)||0));const h=Math.floor(sec/3600),m=Math.floor((sec%3600)/60),s=sec%60;return h?`${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`:`${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;}
function timingsToText(timings=[]){return timings.map(t=>`${t.number}번\t${formatTimestamp(t.start)}`).join("\n");}
function showPreview(){const qs=state.parsedQuestions;const rowCount=qs.reduce((sum,q)=>sum+q.rows.length,0);$("parseSummary").textContent=qs.length?`${qs.length}문제 · 영어/한글 ${rowCount}줄 인식 · ${Math.ceil(qs.length/4)}개 묶음`:`번호와 탭으로 구분된 영어/한글 문장을 인식하지 못했습니다.`;$("scriptPreview").classList.toggle("hidden",!qs.length);$("scriptPreview").innerHTML=qs.map(q=>`<div class="preview-q"><b>${q.number}번</b><div class="bilingual-preview">${q.rows.map(r=>`<div>${escapeHtml(r.english)}</div><div>${escapeHtml(r.korean)}</div>`).join("")}</div></div>`).join("");}

async function loadStudents(){const snap=await getDocs(collection(db,"students"));state.students=snap.docs.map(d=>({studentNo:d.id,...d.data()})).sort((a,b)=>a.studentNo.localeCompare(b.studentNo,"ko",{numeric:true}));$("studentTableBody").innerHTML=state.students.map(s=>`<tr><td>${escapeHtml(s.studentNo)}</td><td>${escapeHtml(s.name)}</td><td><button class="btn danger small" data-del-student="${escapeHtml(s.studentNo)}">삭제</button></td></tr>`).join("")||`<tr><td colspan="3" class="muted">등록된 학생이 없습니다.</td></tr>`;document.querySelectorAll("[data-del-student]").forEach(b=>b.addEventListener("click",()=>deleteStudent(b.dataset.delStudent)));}
async function addStudent(no,name){no=no.trim();name=name.trim();if(!no||!name)throw new Error("학번과 이름을 입력하세요.");if(no.includes("/"))throw new Error("학번에는 / 문자를 사용할 수 없습니다.");await setDoc(doc(db,"students",no),{name,updatedAt:serverTimestamp()},{merge:true});}
async function deleteStudent(no){if(!confirm(`${no} 학생을 삭제할까요?`))return;await deleteDoc(doc(db,"students",no));await loadStudents();}
function parseStudentRows(text){return text.split(/\r?\n/).map(l=>l.trim()).filter(Boolean).map(line=>{let parts;if(line.includes("\t"))parts=line.split("\t");else if(line.includes(","))parts=line.split(",");else parts=line.split(/\s+/);const no=(parts.shift()||"").trim();const name=parts.join(" ").trim();return {no,name};}).filter(x=>x.no&&x.name);}

async function saveRound(){
  const title=$("roundTitle").value.trim(); if(!title)return alert("회차 이름을 입력하세요.");
  state.parsedQuestions=parseQuestions($("scriptInput").value);
  if(!state.parsedQuestions.length)return alert("번호 줄과 탭으로 구분된 영어/한글 문장을 인식하지 못했습니다. 예시 형식을 확인해 주세요.");
  const button=$("saveRoundBtn");button.disabled=true;button.textContent="저장 중…";
  try{
    const refDoc=await addDoc(collection(db,"rounds"),{title,questions:state.parsedQuestions,groups:buildGroups(state.parsedQuestions),visible:true,wholeAudioUrl:"",wholeAudioPath:"",createdAt:serverTimestamp(),updatedAt:serverTimestamp()});
    $("roundTitle").value="";$("scriptInput").value="";state.parsedQuestions=[];showPreview();alert(`회차를 저장했습니다. (${refDoc.id})`);await loadRounds();
  }catch(error){
    console.error("회차 저장 실패",error);
    const permissionDenied=error?.code==="permission-denied";
    alert(permissionDenied?"회차 저장 권한이 없습니다. Firestore 보안 규칙이 배포되었는지 확인해 주세요.":`회차 저장에 실패했습니다.\n${error?.message||error}`);
  }finally{button.disabled=false;button.textContent="회차 저장";}
}
async function loadRounds(){const snap=await getDocs(collection(db,"rounds"));state.rounds=snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>(b.createdAt?.seconds||0)-(a.createdAt?.seconds||0));renderRounds();}
function renderRounds(){
  $("roundList").innerHTML=state.rounds.map(r=>{
    const groupEditors=(r.groups||buildGroups(r.questions||[])).map((g,i)=>`<div class="group-editor">
      <b>${escapeHtml(g.label||groupLabel(r,i))}</b>
      <div class="grid-2" style="margin-top:8px">
        <div><label class="help">이 묶음 전용 음원</label><input type="file" accept="audio/*" data-group-audio="${r.id}|${i}">${g.audioUrl?`<audio class="audio-mini" controls src="${escapeHtml(g.audioUrl)}"></audio>`:""}</div>
        <div><label class="help">전체 음원을 쓸 때 구간(초)</label><div class="row"><input class="input" type="number" step="0.1" min="0" placeholder="시작" value="${escapeHtml(g.segmentStart??"")}" data-seg-start="${r.id}|${i}"><input class="input" type="number" step="0.1" min="0" placeholder="끝" value="${escapeHtml(g.segmentEnd??"")}" data-seg-end="${r.id}|${i}"><button class="btn small" data-save-seg="${r.id}|${i}">저장</button></div></div>
      </div></div>`).join("");
    const timingText=timingsToText(r.questionTimings||[]);
    return `<div class="round-card"><div class="section-title"><div><h3 style="margin:0">${escapeHtml(r.title)}</h3><div class="help">${r.questions?.length||0}문제 · ${r.groups?.length||0}묶음 · 문항 시간 ${r.questionTimings?.length||0}개 · 학생에게 ${r.visible===false?'숨김':'표시 중'}</div></div><div class="row wrap"><button class="btn small" data-toggle-round="${r.id}">${r.visible===false?'표시':'숨김'}</button><button class="btn danger small" data-delete-round="${r.id}">회차 삭제</button></div></div>
      <div><label class="help">전체 음원 1개 (선택사항)</label><input type="file" accept="audio/*" data-whole-audio="${r.id}">${r.wholeAudioUrl?`<audio class="audio-mini" controls src="${escapeHtml(r.wholeAudioUrl)}"></audio>`:""}</div>
      <div class="timing-editor"><label><b>문항별 시작 시간 일괄 입력</b></label><p class="help">표 전체를 그대로 붙여넣거나, 각 줄에 <b>1번 01:41</b> 형식으로 입력하세요. 각 문항은 다음 문항 시작 전까지 재생됩니다.</p><textarea class="input" data-question-timings="${r.id}" placeholder="1번 01:41\n2번 02:28">${escapeHtml(timingText)}</textarea><div class="row wrap"><button class="btn primary small" data-save-question-timings="${r.id}">문항 시간 저장</button><span class="help" data-timing-summary="${r.id}">${timingText?`${r.questionTimings.length}개 저장됨`:"저장된 문항 시간이 없습니다."}</span></div></div>${groupEditors}</div>`;
  }).join("")||`<div class="muted">등록된 회차가 없습니다.</div>`;
  document.querySelectorAll("[data-whole-audio]").forEach(el=>el.addEventListener("change",e=>uploadWholeAudio(e,el.dataset.wholeAudio)));
  document.querySelectorAll("[data-group-audio]").forEach(el=>el.addEventListener("change",e=>{const [rid,i]=el.dataset.groupAudio.split("|");uploadGroupAudio(e,rid,Number(i));}));
  document.querySelectorAll("[data-question-timings]").forEach(el=>el.addEventListener("input",()=>{const count=parseQuestionTimings(el.value).length;document.querySelector(`[data-timing-summary="${CSS.escape(el.dataset.questionTimings)}"]`).textContent=count?`${count}개 문항 시간 인식`:"인식된 문항 시간이 없습니다.";}));
  document.querySelectorAll("[data-save-question-timings]").forEach(b=>b.addEventListener("click",()=>saveQuestionTimings(b.dataset.saveQuestionTimings)));
  document.querySelectorAll("[data-save-seg]").forEach(b=>b.addEventListener("click",()=>{const [rid,i]=b.dataset.saveSeg.split("|");saveSegment(rid,Number(i));}));
  document.querySelectorAll("[data-toggle-round]").forEach(b=>b.addEventListener("click",()=>toggleRound(b.dataset.toggleRound)));
  document.querySelectorAll("[data-delete-round]").forEach(b=>b.addEventListener("click",()=>deleteRound(b.dataset.deleteRound)));
}
async function uploadWholeAudio(e,roundId){const file=e.target.files?.[0];if(!file)return;const path=`teacher-audio/${roundId}/whole-${Date.now()}-${safeName(file.name)}`;const sref=ref(storage,path);e.target.disabled=true;try{await uploadBytes(sref,file,{contentType:file.type});const url=await getDownloadURL(sref);await updateDoc(doc(db,"rounds",roundId),{wholeAudioUrl:url,wholeAudioPath:path,updatedAt:serverTimestamp()});await loadRounds();}finally{e.target.disabled=false;}}
async function uploadGroupAudio(e,roundId,index){const file=e.target.files?.[0];if(!file)return;const round=state.rounds.find(r=>r.id===roundId);const groups=[...(round.groups||buildGroups(round.questions||[]))];const path=`teacher-audio/${roundId}/g${index+1}-${Date.now()}-${safeName(file.name)}`;const sref=ref(storage,path);e.target.disabled=true;try{await uploadBytes(sref,file,{contentType:file.type});const url=await getDownloadURL(sref);groups[index]={...groups[index],audioUrl:url,audioPath:path};await updateDoc(doc(db,"rounds",roundId),{groups,updatedAt:serverTimestamp()});await loadRounds();}finally{e.target.disabled=false;}}
async function saveQuestionTimings(roundId){
  const input=document.querySelector(`[data-question-timings="${CSS.escape(roundId)}"]`);const timings=parseQuestionTimings(input.value);
  if(!timings.length)return alert("문항 번호와 시간을 인식하지 못했습니다. 예: 1번 01:41");
  if(timings.some((t,i)=>i>0&&t.start<=timings[i-1].start))return alert("문항 시간은 번호 순서대로 뒤의 문항이 더 늦어야 합니다.");
  const round=state.rounds.find(r=>r.id===roundId);const questionNumbers=new Set((round?.questions||[]).map(q=>Number(q.number)));const matched=timings.filter(t=>questionNumbers.has(t.number));
  if(!matched.length)return alert("이 회차의 문항 번호와 일치하는 시간이 없습니다.");
  await updateDoc(doc(db,"rounds",roundId),{questionTimings:matched,updatedAt:serverTimestamp()});alert(`${matched.length}개 문항 시간을 저장했습니다.`);await loadRounds();
}
async function saveSegment(roundId,index){const round=state.rounds.find(r=>r.id===roundId);const groups=[...(round.groups||[])];const start=document.querySelector(`[data-seg-start="${CSS.escape(roundId+'|'+index)}"]`).value;const end=document.querySelector(`[data-seg-end="${CSS.escape(roundId+'|'+index)}"]`).value;if(start!==""&&end!==""&&Number(end)<=Number(start))return alert("끝 초는 시작 초보다 커야 합니다.");groups[index]={...groups[index],segmentStart:start===""?"":Number(start),segmentEnd:end===""?"":Number(end)};await updateDoc(doc(db,"rounds",roundId),{groups,updatedAt:serverTimestamp()});alert("구간을 저장했습니다.");}
async function toggleRound(roundId){const round=state.rounds.find(r=>r.id===roundId);await updateDoc(doc(db,"rounds",roundId),{visible:round.visible===false,updatedAt:serverTimestamp()});await loadRounds();}
async function deleteRound(roundId){if(!confirm("회차를 삭제할까요? 학생의 기존 진도 기록은 남습니다."))return;await deleteDoc(doc(db,"rounds",roundId));await loadRounds();}
function safeName(name){return name.replace(/[^a-zA-Z0-9가-힣._-]/g,"_").slice(-80);}

async function loadProgress(){
  const [pSnap,sSnap,rSnap]=await Promise.all([getDocs(collection(db,"progress")),getDocs(collection(db,"students")),getDocs(collection(db,"rounds"))]);
  const students=sSnap.docs.map(d=>({studentNo:d.id,...d.data()}));const rounds=new Map(rSnap.docs.map(d=>[d.id,{id:d.id,...d.data()}]));
  const plist=pSnap.docs.map(d=>({id:d.id,...d.data()}));
  const byStudent=new Map();for(const p of plist){const prev=byStudent.get(p.studentNo);if(!prev||(p.updatedAt?.seconds||0)>(prev.updatedAt?.seconds||0))byStudent.set(p.studentNo,p);}
  $("progressTableBody").innerHTML=students.sort((a,b)=>a.studentNo.localeCompare(b.studentNo,"ko",{numeric:true})).map(s=>{const p=byStudent.get(s.studentNo);if(!p)return `<tr><td>${escapeHtml(s.studentNo)}</td><td>${escapeHtml(s.name)}</td><td class="muted">시작 전</td><td>-</td><td>-</td><td>-</td><td><button class="btn ghost small" data-detail="${escapeHtml(s.studentNo)}">상세</button></td></tr>`;const round=rounds.get(p.roundId);return `<tr><td>${escapeHtml(s.studentNo)}</td><td>${escapeHtml(s.name)}</td><td>${escapeHtml(round?.title||p.roundTitle||"")}<br>${escapeHtml(p.groupLabel||"")} · ${(p.listenCount||0)+(p.recordCount||0)}/6</td><td>${p.listenCount||0}회<br>${fmtSec(p.totalListenSec)}</td><td>${p.recordCount||0}개<br>${fmtSec(p.totalRecordSec)}</td><td>${fmtDate(p.updatedAt)}</td><td><button class="btn primary small" data-detail="${escapeHtml(s.studentNo)}">상세</button></td></tr>`;}).join("");
  document.querySelectorAll("[data-detail]").forEach(b=>b.addEventListener("click",()=>showStudentDetail(b.dataset.detail)));
}
async function showStudentDetail(studentNo){
  const studentSnap=await getDoc(doc(db,"students",studentNo));const name=studentSnap.exists()?studentSnap.data().name:"";
  const [pSnap,lSnap]=await Promise.all([getDocs(collection(db,"progress")),getDocs(collection(db,"activityLogs"))]);
  const ps=pSnap.docs.map(d=>d.data()).filter(p=>p.studentNo===studentNo).sort((a,b)=>(b.updatedAt?.seconds||0)-(a.updatedAt?.seconds||0));
  const logs=lSnap.docs.map(d=>({id:d.id,...d.data()})).filter(l=>l.studentNo===studentNo).sort((a,b)=>(b.createdAt?.seconds||0)-(a.createdAt?.seconds||0));
  $("detailTitle").textContent=`${studentNo} ${name} 상세`;
  const summary=ps.length?`<h3>묶음별 진도</h3>${ps.map(p=>`<div class="log-item"><b>${escapeHtml(p.roundTitle||"")} · ${escapeHtml(p.groupLabel||"")}</b><br>음원 ${p.listenCount||0}/3 (${fmtSec(p.totalListenSec)}) · 녹음 ${p.recordCount||0}/3 (${fmtSec(p.totalRecordSec)})<br><span class="help">최근 ${fmtDate(p.updatedAt)}</span></div>`).join("")}`:`<div class="muted">진도 기록이 없습니다.</div>`;
  const history=logs.length?`<h3>활동 기록</h3>${logs.map(l=>{const attempt=l.type==='record'?`녹음 ${Math.max(1,Number(l.readNo||4)-3)}회`:`듣기 ${Math.max(1,Number(l.readNo||1))}회`;return `<div class="log-item"><div class="row" style="justify-content:space-between"><b>${l.type==='record'?'🎙 녹음':'▶ 음원 재생'} · ${escapeHtml(l.roundTitle||"")} · ${escapeHtml(l.groupLabel||l.questionRange||"")}</b><span class="help">${fmtDate(l.createdAt)}</span></div><div>${attempt} · ${fmtSec(l.durationSec)}</div>${l.recordingUrl?`<audio class="audio-mini" controls src="${escapeHtml(l.recordingUrl)}"></audio>`:""}</div>`;}).join("")}`:`<div class="muted">활동 기록이 없습니다.</div>`;
  $("detailBody").innerHTML=summary+history;$("detailModal").classList.remove("hidden");
}

// 탭
for(const b of document.querySelectorAll(".tab-btn")){b.addEventListener("click",()=>{document.querySelectorAll(".tab-btn").forEach(x=>x.classList.toggle("active",x===b));document.querySelectorAll(".tab-panel").forEach(p=>p.classList.add("hidden"));$("tab-"+b.dataset.tab).classList.remove("hidden");if(b.dataset.tab==="progress")loadProgress();if(b.dataset.tab==="rounds")loadRounds();});}
$("parseScriptBtn").addEventListener("click",()=>{state.parsedQuestions=parseQuestions($("scriptInput").value);showPreview();});
$("scriptInput").addEventListener("input",()=>{state.parsedQuestions=[];$("parseSummary").textContent="";$("scriptPreview").classList.add("hidden");});
$("saveRoundBtn").addEventListener("click",saveRound);
$("singleAddBtn").addEventListener("click",async()=>{try{await addStudent($("singleNo").value,$("singleName").value);$("singleNo").value="";$("singleName").value="";await loadStudents();}catch(e){alert(e.message);}});
$("bulkAddBtn").addEventListener("click",async()=>{const rows=parseStudentRows($("bulkStudents").value);if(!rows.length)return alert("인식된 학생이 없습니다.");let ok=0;for(const r of rows){try{await addStudent(r.no,r.name);ok++;}catch(e){console.warn(r,e);}}$("bulkResult").textContent=`${ok}명 등록/갱신 완료`;await loadStudents();});
$("refreshStudents").addEventListener("click",loadStudents);$("refreshRounds").addEventListener("click",loadRounds);$("refreshProgress").addEventListener("click",loadProgress);$("closeModal").addEventListener("click",()=>$("detailModal").classList.add("hidden"));$("detailModal").addEventListener("click",e=>{if(e.target===$("detailModal"))$("detailModal").classList.add("hidden");});

loadStudents();loadRounds();
