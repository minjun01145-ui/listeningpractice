import { db, storage } from "./firebase.js";
import {
  collection, doc, getDoc, getDocs, setDoc, addDoc, deleteDoc, updateDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js";
import {
  ref, uploadBytes, getDownloadURL, deleteObject
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-storage.js";
import { getQuestionGroupLabel, getQuestionGroupRanges } from "./question-groups.js?v=20260914-1";

const $=id=>document.getElementById(id);
const GRADES=["중1","중2","중3","고1"];
const state={students:[],rounds:[],parsedQuestions:[],expandedRoundIds:new Set(),managementStudentNos:new Set(),progressView:"all",progressData:null};
function escapeHtml(s=""){return String(s).replace(/[&<>'"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]));}
function fmtSec(sec=0){sec=Math.max(0,Math.round(Number(sec)||0));return `${Math.floor(sec/60)}분 ${sec%60}초`;}
function fmtDate(ts){if(!ts)return "-"; const d=ts.toDate?ts.toDate():new Date(ts);return d.toLocaleString("ko-KR",{month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"});}
function koreaDateKey(value=new Date()){const date=value?.toDate?value.toDate():value,parts=new Intl.DateTimeFormat("en-US",{timeZone:"Asia/Seoul",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(date),part=type=>parts.find(item=>item.type===type)?.value||"";return `${part("year")}-${part("month")}-${part("day")}`;}
function weekDates(dateKey){const anchor=new Date(`${dateKey}T12:00:00+09:00`),mondayOffset=(anchor.getUTCDay()+6)%7;anchor.setUTCDate(anchor.getUTCDate()-mondayOffset);return Array.from({length:7},(_,index)=>{const date=new Date(anchor);date.setUTCDate(anchor.getUTCDate()+index);return {date,key:koreaDateKey(date)};});}
function isExamPrepRound(round){return round?.isExamPrep===true;}
function groupRanges(round){
  if(isExamPrepRound(round)&&Array.isArray(round.groups))return round.groups.map((group,index)=>({start:Number(group.startIndex)||0,end:Number(group.endIndex)||Number(group.startIndex)||index+1}));
  return getQuestionGroupRanges(round?.questions||[]);
}
function groupLabel(round,index){
  if(isExamPrepRound(round))return round?.groups?.[index]?.label||`시험대비 ${index+1}`;
  return getQuestionGroupLabel(round?.questions||[],index);
}
function progressGoal(round){return isExamPrepRound(round)?{listen:0,record:5,total:5}:{listen:3,record:3,total:6};}

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
function buildGroups(questions){return getQuestionGroupRanges(questions).map((_,index)=>({index,label:getQuestionGroupLabel(questions,index),audioUrl:"",audioPath:"",segmentStart:"",segmentEnd:""}));}
function parseLooseQuestions(text){
  const lines=text.replace(/\r/g,"").split("\n"),out=[];let current=null;
  const numberRe=/^\s*(?:문제\s*)?(?:\[(\d{1,3})\]|(\d{1,3})\s*번|(\d{1,3})\s*[.)])\s*$/;
  const finish=()=>{if(current?.rows.length)out.push({...current,text:current.rows.map(row=>`${row.english}\t${row.korean}`).join("\n")});current=null;};
  for(const line of lines){const match=line.match(numberRe);if(match){finish();current={number:Number(match[1]||match[2]||match[3]),rows:[]};continue;}if(!line.trim())continue;if(!current)current={number:null,rows:[]};const tab=line.indexOf("\t"),english=(tab<0?line:line.slice(0,tab)).trim(),korean=tab<0?"":line.slice(tab+1).trim();if(english)current.rows.push({english,korean});}
  finish();return out;
}
function readExamPrepInputs(){return [1,2,3].map(index=>({title:$("prepTitle"+index).value.trim(),questions:parseLooseQuestions($("prepScript"+index).value)}));}
function buildExamPrepData(sections){
  const questions=[],groups=[];
  sections.forEach((section,index)=>{const startIndex=questions.length;section.questions.forEach(question=>{questions.push({...question,displayNumber:question.number,number:questions.length+1});});groups.push({index,label:section.title,startIndex,endIndex:questions.length,audioUrl:"",audioPath:"",segmentStart:"",segmentEnd:""});});
  return {questions,groups};
}
function questionsToText(questions=[],useDisplayNumber=false){return questions.map(question=>{const number=useDisplayNumber?question.displayNumber:question.number,heading=number!==null&&number!==undefined?`${number}번\n`:"",rows=(question.rows||[]).map(row=>row.korean?`${row.english}\t${row.korean}`:row.english).join("\n");return heading+rows;}).join("\n\n");}
function examPrepSectionsFromRound(round){return groupRanges(round).slice(0,3).map((range,index)=>({title:groupLabel(round,index),questions:(round.questions||[]).slice(range.start,range.end)}));}
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
function showPreview(){
  if($("isExamPrep").checked){
    const sections=readExamPrepInputs(),valid=sections.filter(section=>section.title&&section.questions.length),rowCount=valid.reduce((sum,section)=>sum+section.questions.reduce((n,q)=>n+q.rows.length,0),0);
    $("parseSummary").textContent=valid.length?`${valid.length}/3개 덩어리 · 영어/한글 ${rowCount}줄 인식 · 각 5회 녹음`:"제목과 Tab으로 구분된 영어/한글 내용을 입력하세요.";
    $("scriptPreview").classList.toggle("hidden",!valid.length);$("scriptPreview").innerHTML=valid.map(section=>`<div class="preview-q"><b>${escapeHtml(section.title)}</b><div class="bilingual-preview">${section.questions.flatMap(q=>q.rows).map(row=>`<div>${escapeHtml(row.english)}</div><div>${escapeHtml(row.korean)}</div>`).join("")}</div></div>`).join("");return;
  }
  const qs=state.parsedQuestions,rowCount=qs.reduce((sum,q)=>sum+q.rows.length,0);$("parseSummary").textContent=qs.length?`${qs.length}문제 · 영어/한글 ${rowCount}줄 인식 · ${getQuestionGroupRanges(qs).length}개 묶음`:`번호와 탭으로 구분된 영어/한글 문장을 인식하지 못했습니다.`;$("scriptPreview").classList.toggle("hidden",!qs.length);$("scriptPreview").innerHTML=qs.map(q=>`<div class="preview-q"><b>${q.number}번</b><div class="bilingual-preview">${q.rows.map(r=>`<div>${escapeHtml(r.english)}</div><div>${escapeHtml(r.korean)}</div>`).join("")}</div></div>`).join("");
}

async function loadStudents(){const snap=await getDocs(collection(db,"students"));state.students=snap.docs.map(d=>({studentNo:d.id,...d.data()})).sort((a,b)=>a.studentNo.localeCompare(b.studentNo,"ko",{numeric:true}));$("studentTableBody").innerHTML=state.students.map(s=>`<tr><td>${escapeHtml(s.studentNo)}</td><td>${escapeHtml(s.name)}</td><td><button class="btn danger small" data-del-student="${escapeHtml(s.studentNo)}">삭제</button></td></tr>`).join("")||`<tr><td colspan="3" class="muted">등록된 학생이 없습니다.</td></tr>`;document.querySelectorAll("[data-del-student]").forEach(b=>b.addEventListener("click",()=>deleteStudent(b.dataset.delStudent)));}
async function addStudent(no,name){no=no.trim();name=name.trim();if(!no||!name)throw new Error("학번과 이름을 입력하세요.");if(no.includes("/"))throw new Error("학번에는 / 문자를 사용할 수 없습니다.");await setDoc(doc(db,"students",no),{name,updatedAt:serverTimestamp()},{merge:true});}
async function deleteStudent(no){if(!confirm(`${no} 학생을 삭제할까요?`))return;await deleteDoc(doc(db,"students",no));await loadStudents();}
function parseStudentRows(text){return text.split(/\r?\n/).map(l=>l.trim()).filter(Boolean).map(line=>{let parts;if(line.includes("\t"))parts=line.split("\t");else if(line.includes(","))parts=line.split(",");else parts=line.split(/\s+/);const no=(parts.shift()||"").trim();const name=parts.join(" ").trim();return {no,name};}).filter(x=>x.no&&x.name);}

async function saveRound(){
  const title=$("roundTitle").value.trim(); if(!title)return alert("회차 이름을 입력하세요.");
  const grade=$("roundGrade").value;if(!GRADES.includes(grade))return alert("학년을 선택하세요.");
  const isExamPrep=$("isExamPrep").checked;let questions,groups;
  if(isExamPrep){
    const sections=readExamPrepInputs();if(sections.some(section=>!section.title))return alert("시험대비 3덩어리의 제목을 모두 입력하세요.");if(sections.some(section=>!section.questions.length))return alert("시험대비 3덩어리의 내용을 모두 입력하세요.");({questions,groups}=buildExamPrepData(sections));
  }else{
    state.parsedQuestions=parseQuestions($("scriptInput").value);if(!state.parsedQuestions.length)return alert("번호 줄과 탭으로 구분된 영어/한글 문장을 인식하지 못했습니다. 예시 형식을 확인해 주세요.");questions=state.parsedQuestions;groups=buildGroups(questions);
  }
  const button=$("saveRoundBtn");button.disabled=true;button.textContent="저장 중…";
  try{
    const refDoc=await addDoc(collection(db,"rounds"),{title,grade,isExamPrep,questions,groups,visible:true,wholeAudioUrl:"",wholeAudioPath:"",createdAt:serverTimestamp(),updatedAt:serverTimestamp()});
    $("roundTitle").value="";$("roundGrade").value="";$("scriptInput").value="";$("isExamPrep").checked=false;for(let index=1;index<=3;index+=1){$("prepTitle"+index).value="";$("prepScript"+index).value="";}$("regularScriptField").classList.remove("hidden");$("examPrepFields").classList.add("hidden");state.parsedQuestions=[];showPreview();alert(`회차를 저장했습니다. (${refDoc.id})`);await loadRounds();
  }catch(error){
    console.error("회차 저장 실패",error);
    const permissionDenied=error?.code==="permission-denied";
    alert(permissionDenied?"회차 저장 권한이 없습니다. Firestore 보안 규칙이 배포되었는지 확인해 주세요.":`회차 저장에 실패했습니다.\n${error?.message||error}`);
  }finally{button.disabled=false;button.textContent="회차 저장";}
}
async function loadRounds(){const snap=await getDocs(collection(db,"rounds"));state.rounds=snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>(b.createdAt?.seconds||0)-(a.createdAt?.seconds||0));renderRounds();}
function renderRounds(){
  $("roundList").innerHTML=state.rounds.map(r=>{
    const expanded=state.expandedRoundIds.has(r.id);
    const groupEditors=isExamPrepRound(r)?`<div class="notice">시험대비 세트: ${(r.groups||[]).map(group=>escapeHtml(group.label)).join(" → ")} 순서가 한 번 더 반복되어 6개 항목으로 표시되며, 모든 항목은 언제나 열려 있습니다.</div>`:(r.groups||buildGroups(r.questions||[])).map((g,i)=>`<div class="group-editor">
      <b>${escapeHtml(g.label||groupLabel(r,i))}</b>
      <div class="grid-2" style="margin-top:8px">
        <div><label class="help">이 묶음 전용 음원</label><input type="file" accept="audio/*" data-group-audio="${r.id}|${i}">${g.audioUrl?`<audio class="audio-mini" controls src="${escapeHtml(g.audioUrl)}"></audio>`:""}</div>
        <div><label class="help">전체 음원을 쓸 때 구간(초)</label><div class="row"><input class="input" type="number" step="0.1" min="0" placeholder="시작" value="${escapeHtml(g.segmentStart??"")}" data-seg-start="${r.id}|${i}"><input class="input" type="number" step="0.1" min="0" placeholder="끝" value="${escapeHtml(g.segmentEnd??"")}" data-seg-end="${r.id}|${i}"><button class="btn small" data-save-seg="${r.id}|${i}">저장</button></div></div>
      </div></div>`).join("");
    const timingText=timingsToText(r.questionTimings||[]);
    const typeLabel=isExamPrepRound(r)?`<span class="status-pill warn">시험대비</span> · 3덩어리×2회(총 6개 항목) · 항목당 5회 녹음`:`일반 세트 · 문항 시간 ${r.questionTimings?.length||0}개`;
    const scriptEditor=isExamPrepRound(r)?`<div class="round-edit-section"><h4>시험대비 제목·내용 수정</h4><div class="exam-prep-grid">${examPrepSectionsFromRound(r).map((section,index)=>`<div class="exam-prep-editor"><div class="field"><label>${index+1}번 덩어리 제목</label><input class="input" value="${escapeHtml(section.title)}" data-exam-title="${r.id}|${index}"></div><div class="field"><label>${index+1}번 덩어리 내용</label><textarea class="input" data-exam-script="${r.id}|${index}">${escapeHtml(questionsToText(section.questions,true))}</textarea></div></div>`).join("")}</div><button class="btn primary" data-save-exam-script="${r.id}">세 덩어리 저장</button></div>`:`<div class="round-edit-section"><h4>대본 수정</h4><p class="help">번호는 한 줄에, 각 문장은 영어 → Tab 키 → 한글 순서로 입력하세요. 문항 수가 바뀌면 묶음도 다시 나눕니다.</p><textarea class="input round-script-textarea" data-round-script="${r.id}">${escapeHtml(questionsToText(r.questions||[]))}</textarea><button class="btn primary" data-save-round-script="${r.id}">대본 저장</button></div>`;
    const audioEditors=isExamPrepRound(r)?"":`<div><label class="help">전체 음원 1개 (선택사항)</label><input type="file" accept="audio/*" data-whole-audio="${r.id}">${r.wholeAudioUrl?`<audio class="audio-mini" controls src="${escapeHtml(r.wholeAudioUrl)}"></audio>`:""}</div>
      <div class="timing-editor"><label><b>문항별 시작 시간 일괄 입력</b></label><p class="help">표 전체를 그대로 붙여넣거나, 각 줄에 <b>1번 01:41</b> 형식으로 입력하세요. 각 문항은 다음 문항 시작 전까지 재생됩니다.</p><textarea class="input" data-question-timings="${r.id}" placeholder="1번 01:41\n2번 02:28">${escapeHtml(timingText)}</textarea><div class="row wrap"><button class="btn primary small" data-save-question-timings="${r.id}">문항 시간 저장</button><span class="help" data-timing-summary="${r.id}">${timingText?`${r.questionTimings.length}개 저장됨`:"저장된 문항 시간이 없습니다."}</span></div></div>`;
    const gradeOptions=`<option value="">학년 미지정</option>${GRADES.map(grade=>`<option value="${grade}" ${r.grade===grade?"selected":""}>${grade}</option>`).join("")}`;
    return `<div class="round-card ${expanded?"expanded":""}"><div class="section-title round-summary"><div><h3>${escapeHtml(r.title)}</h3><div class="help">${r.grade?escapeHtml(r.grade):'<span class="status-pill warn">학년 미지정</span>'} · ${r.questions?.length||0}문제 · ${groupRanges(r).length}묶음 · ${typeLabel} · 학생에게 ${r.visible===false?'숨김':'표시 중'}</div></div><div class="row wrap"><button class="btn primary small" data-expand-round="${r.id}" aria-expanded="${expanded}">${expanded?'접기':'펼치기'}</button><button class="btn small" data-toggle-round="${r.id}">${r.visible===false?'표시':'숨김'}</button><button class="btn danger small" data-delete-round="${r.id}">회차 삭제</button></div></div><div class="round-details ${expanded?"":"hidden"}"><div class="round-edit-section"><h4>회차 이름·학년 수정</h4><div class="row wrap"><input class="input grow" value="${escapeHtml(r.title)}" data-round-title="${r.id}" maxlength="100"><select class="input round-grade-select" data-round-grade="${r.id}">${gradeOptions}</select><button class="btn primary" data-save-round-title="${r.id}">이름·학년 저장</button></div></div>${scriptEditor}${audioEditors}${groupEditors}</div></div>`;
  }).join("")||`<div class="muted">등록된 회차가 없습니다.</div>`;
  document.querySelectorAll("[data-expand-round]").forEach(button=>button.addEventListener("click",()=>{const roundId=button.dataset.expandRound;if(state.expandedRoundIds.has(roundId))state.expandedRoundIds.delete(roundId);else state.expandedRoundIds.add(roundId);renderRounds();}));
  document.querySelectorAll("[data-save-round-title]").forEach(button=>button.addEventListener("click",()=>saveRoundTitle(button.dataset.saveRoundTitle)));
  document.querySelectorAll("[data-save-round-script]").forEach(button=>button.addEventListener("click",()=>saveRegularRoundScript(button.dataset.saveRoundScript)));
  document.querySelectorAll("[data-save-exam-script]").forEach(button=>button.addEventListener("click",()=>saveExamRoundScript(button.dataset.saveExamScript)));
  document.querySelectorAll("[data-whole-audio]").forEach(el=>el.addEventListener("change",e=>uploadWholeAudio(e,el.dataset.wholeAudio)));
  document.querySelectorAll("[data-group-audio]").forEach(el=>el.addEventListener("change",e=>{const [rid,i]=el.dataset.groupAudio.split("|");uploadGroupAudio(e,rid,Number(i));}));
  document.querySelectorAll("[data-question-timings]").forEach(el=>el.addEventListener("input",()=>{const count=parseQuestionTimings(el.value).length;document.querySelector(`[data-timing-summary="${CSS.escape(el.dataset.questionTimings)}"]`).textContent=count?`${count}개 문항 시간 인식`:"인식된 문항 시간이 없습니다.";}));
  document.querySelectorAll("[data-save-question-timings]").forEach(b=>b.addEventListener("click",()=>saveQuestionTimings(b.dataset.saveQuestionTimings)));
  document.querySelectorAll("[data-save-seg]").forEach(b=>b.addEventListener("click",()=>{const [rid,i]=b.dataset.saveSeg.split("|");saveSegment(rid,Number(i));}));
  document.querySelectorAll("[data-toggle-round]").forEach(b=>b.addEventListener("click",()=>toggleRound(b.dataset.toggleRound)));
  document.querySelectorAll("[data-delete-round]").forEach(b=>b.addEventListener("click",()=>deleteRound(b.dataset.deleteRound)));
}
async function saveRoundTitle(roundId){
  const input=document.querySelector(`[data-round-title="${CSS.escape(roundId)}"]`),gradeInput=document.querySelector(`[data-round-grade="${CSS.escape(roundId)}"]`),title=input?.value.trim(),grade=gradeInput?.value||"";if(!title)return alert("회차 이름을 입력하세요.");if(!GRADES.includes(grade))return alert("학년을 선택하세요.");
  await updateDoc(doc(db,"rounds",roundId),{title,grade,updatedAt:serverTimestamp()});alert("회차 이름과 학년을 저장했습니다.");await loadRounds();
}
async function saveRegularRoundScript(roundId){
  const round=state.rounds.find(item=>item.id===roundId),input=document.querySelector(`[data-round-script="${CSS.escape(roundId)}"]`),questions=parseQuestions(input?.value||"");if(!questions.length)return alert("번호 줄과 Tab으로 구분된 영어/한글 문장을 인식하지 못했습니다.");
  const oldGroups=round?.groups||[],groups=buildGroups(questions).map((group,index)=>({...group,audioUrl:oldGroups[index]?.audioUrl||"",audioPath:oldGroups[index]?.audioPath||"",segmentStart:oldGroups[index]?.segmentStart??"",segmentEnd:oldGroups[index]?.segmentEnd??""})),numbers=new Set(questions.map(question=>Number(question.number))),questionTimings=(round?.questionTimings||[]).filter(timing=>numbers.has(Number(timing.number)));
  await updateDoc(doc(db,"rounds",roundId),{questions,groups,questionTimings,updatedAt:serverTimestamp()});alert("대본과 문제 묶음을 다시 저장했습니다.");await loadRounds();
}
async function saveExamRoundScript(roundId){
  const sections=[0,1,2].map(index=>{const key=CSS.escape(`${roundId}|${index}`),title=document.querySelector(`[data-exam-title="${key}"]`)?.value.trim()||"",text=document.querySelector(`[data-exam-script="${key}"]`)?.value||"";return {title,questions:parseLooseQuestions(text)};});
  if(sections.some(section=>!section.title))return alert("시험대비 3덩어리의 제목을 모두 입력하세요.");if(sections.some(section=>!section.questions.length))return alert("시험대비 3덩어리의 내용을 모두 입력하세요.");
  const {questions,groups}=buildExamPrepData(sections);await updateDoc(doc(db,"rounds",roundId),{questions,groups,updatedAt:serverTimestamp()});alert("시험대비 제목과 내용을 저장했습니다.");await loadRounds();
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
async function deleteRound(roundId){if(!confirm("회차를 삭제할까요? 학생의 기존 진도 기록은 남습니다."))return;await deleteDoc(doc(db,"rounds",roundId));state.expandedRoundIds.delete(roundId);await loadRounds();}
function safeName(name){return name.replace(/[^a-zA-Z0-9가-힣._-]/g,"_").slice(-80);}

async function loadProgress(){
  const [pSnap,sSnap,rSnap,lSnap,groupSnap]=await Promise.all([getDocs(collection(db,"progress")),getDocs(collection(db,"students")),getDocs(collection(db,"rounds")),getDocs(collection(db,"activityLogs")),getDoc(doc(db,"settings","managementGroup"))]);
  const students=sSnap.docs.map(d=>({studentNo:d.id,...d.data()})).sort((a,b)=>a.studentNo.localeCompare(b.studentNo,"ko",{numeric:true})),rounds=new Map(rSnap.docs.map(d=>[d.id,{id:d.id,...d.data()}])),progress=pSnap.docs.map(d=>({id:d.id,...d.data()})),logs=lSnap.docs.map(d=>({id:d.id,...d.data()}));
  state.managementStudentNos=new Set(groupSnap.exists()&&Array.isArray(groupSnap.data().studentNos)?groupSnap.data().studentNos:[]);state.progressData={students,rounds,progress,logs};renderProgressView();
}
function renderProgressView(){
  if(!state.progressData)return;const managed=state.progressView==="managed";$("progressViewTitle").textContent=managed?"관리그룹 주간 현황":"학생별 현재 진도";$("showAllProgress").className=`btn ${managed?"ghost":"primary"} small`;$("showManagedProgress").className=`btn ${managed?"primary":"ghost"} small`;$("managementEditControls").classList.toggle("hidden",managed);$("managementWeekControls").classList.toggle("hidden",!managed);$("managementGroupCount").textContent=`${state.managementStudentNos.size}명 관리 중`;if(managed)renderManagedWeeklyProgress();else renderAllProgress();
}
function renderAllProgress(){
  const {students,rounds,progress}=state.progressData,byStudent=new Map();for(const item of progress){const prev=byStudent.get(item.studentNo);if(!prev||(item.updatedAt?.seconds||0)>(prev.updatedAt?.seconds||0))byStudent.set(item.studentNo,item);}
  $("progressTableHead").innerHTML=`<tr><th>관리</th><th>학번</th><th>이름</th><th>최근 위치</th><th>음원 재생</th><th>녹음</th><th>최근 활동</th><th>열람</th></tr>`;
  $("progressTableBody").innerHTML=students.map(student=>{const checked=state.managementStudentNos.has(student.studentNo)?"checked":"",item=byStudent.get(student.studentNo);if(!item)return `<tr><td><input type="checkbox" data-manage-student="${escapeHtml(student.studentNo)}" ${checked} aria-label="${escapeHtml(student.name)} 관리그룹 선택"></td><td>${escapeHtml(student.studentNo)}</td><td>${escapeHtml(student.name)}</td><td class="muted">시작 전</td><td>-</td><td>-</td><td>-</td><td><button class="btn ghost small" data-detail="${escapeHtml(student.studentNo)}">상세</button></td></tr>`;const round=rounds.get(item.roundId),goal=progressGoal(round),isExam=isExamPrepRound(round)||Number.isInteger(item.sessionIndex);return `<tr><td><input type="checkbox" data-manage-student="${escapeHtml(student.studentNo)}" ${checked} aria-label="${escapeHtml(student.name)} 관리그룹 선택"></td><td>${escapeHtml(student.studentNo)}</td><td>${escapeHtml(student.name)}</td><td>${escapeHtml(round?.title||item.roundTitle||"")}<br>${escapeHtml(item.groupLabel||"")}${isExam?` · ${Number(item.sessionIndex)+1}번 항목`:""} · ${(item.listenCount||0)+(item.recordCount||0)}/${isExam?5:goal.total}</td><td>${isExam?"음원 없음":`${item.listenCount||0}회<br>${fmtSec(item.totalListenSec)}`}</td><td>${item.recordCount||0}/${isExam?5:goal.record}회<br>${fmtSec(item.totalRecordSec)}</td><td>${fmtDate(item.updatedAt)}</td><td><button class="btn primary small" data-detail="${escapeHtml(student.studentNo)}">상세</button></td></tr>`;}).join("");
  const boxes=[...document.querySelectorAll("[data-manage-student]")];$("selectAllStudents").checked=Boolean(boxes.length)&&boxes.every(box=>box.checked);boxes.forEach(box=>box.addEventListener("change",()=>{$("selectAllStudents").checked=boxes.every(item=>item.checked);}));bindDetailButtons();
}
function isCompletionLog(log){return log.type==="record"&&Number(log.readNo)>=(Number.isInteger(log.sessionIndex)?5:6);}
function renderManagedWeeklyProgress(){
  const {students,logs}=state.progressData,managed=students.filter(student=>state.managementStudentNos.has(student.studentNo)),dates=weekDates($("managementWeek").value||koreaDateKey()),dayNames=["월","화","수","목","금","토","일"];
  $("managementWeek").value=dates[0].key;$("managementWeekLabel").textContent=`${dates[0].key} ~ ${dates[6].key}`;$("progressTableHead").innerHTML=`<tr><th>학번</th><th>이름</th>${dates.map((item,index)=>`<th class="weekly-day-head">${dayNames[index]}<br><span>${item.key.slice(5)}</span></th>`).join("")}<th>주간 완료</th><th>열람</th></tr>`;
  $("progressTableBody").innerHTML=managed.map(student=>{let completedDays=0;const days=dates.map(item=>{const dayLogs=logs.filter(log=>log.studentNo===student.studentNo&&log.createdAt&&koreaDateKey(log.createdAt)===item.key),complete=dayLogs.some(isCompletionLog),status=complete?"complete":dayLogs.length?"partial":"none",symbol=complete?"○":dayLogs.length?"△":"×";if(complete)completedDays+=1;return `<td class="weekly-cell"><span class="weekly-status ${status}" title="${item.key} · ${dayLogs.length}회 활동">${symbol}</span></td>`;}).join("");return `<tr><td>${escapeHtml(student.studentNo)}</td><td>${escapeHtml(student.name)}</td>${days}<td><b>${completedDays}/7일</b></td><td><button class="btn primary small" data-detail="${escapeHtml(student.studentNo)}">상세</button></td></tr>`;}).join("")||`<tr><td colspan="11" class="muted">관리그룹에 등록된 학생이 없습니다. 전체 학생 보기에서 학생을 체크해 저장하세요.</td></tr>`;bindDetailButtons();
}
function bindDetailButtons(){document.querySelectorAll("[data-detail]").forEach(button=>button.addEventListener("click",()=>showStudentDetail(button.dataset.detail)));}
async function saveManagementGroup(){const studentNos=[...document.querySelectorAll("[data-manage-student]:checked")].map(box=>box.dataset.manageStudent);await setDoc(doc(db,"settings","managementGroup"),{studentNos,updatedAt:serverTimestamp()});state.managementStudentNos=new Set(studentNos);$("managementGroupCount").textContent=`${studentNos.length}명 관리 중`;alert(`${studentNos.length}명을 관리그룹으로 저장했습니다.`);}
function shiftManagementWeek(days){const current=$("managementWeek").value||koreaDateKey(),date=new Date(`${current}T12:00:00+09:00`);date.setUTCDate(date.getUTCDate()+days);$("managementWeek").value=koreaDateKey(date);renderManagedWeeklyProgress();}
async function showStudentDetail(studentNo){
  const studentSnap=await getDoc(doc(db,"students",studentNo));const name=studentSnap.exists()?studentSnap.data().name:"";
  const [pSnap,lSnap]=await Promise.all([getDocs(collection(db,"progress")),getDocs(collection(db,"activityLogs"))]);
  const ps=pSnap.docs.map(d=>d.data()).filter(p=>p.studentNo===studentNo).sort((a,b)=>(b.updatedAt?.seconds||0)-(a.updatedAt?.seconds||0));
  const logs=lSnap.docs.map(d=>({id:d.id,...d.data()})).filter(l=>l.studentNo===studentNo).sort((a,b)=>(b.createdAt?.seconds||0)-(a.createdAt?.seconds||0));
  $("detailTitle").textContent=`${studentNo} ${name} 상세`;
  const summary=ps.length?`<h3>묶음별 진도</h3>${ps.map(p=>{const round=state.rounds.find(r=>r.id===p.roundId),isExam=isExamPrepRound(round)||Number.isInteger(p.sessionIndex);return `<div class="log-item"><b>${escapeHtml(p.roundTitle||"")} · ${escapeHtml(p.groupLabel||"")}${isExam?` · ${Number(p.sessionIndex)+1}번 항목`:""}</b><br>${isExam?`녹음 ${p.recordCount||0}/5 (${fmtSec(p.totalRecordSec)})`:`음원 ${p.listenCount||0}/3 (${fmtSec(p.totalListenSec)}) · 녹음 ${p.recordCount||0}/3 (${fmtSec(p.totalRecordSec)})`}<br><span class="help">최근 ${fmtDate(p.updatedAt)}</span></div>`;}).join("")}`:`<div class="muted">진도 기록이 없습니다.</div>`;
  const history=logs.length?`<h3>활동 기록</h3>${logs.map(l=>{const isExam=Number.isInteger(l.sessionIndex),attempt=l.type==='record'?`녹음 ${isExam?Math.max(1,Number(l.readNo)||1):Math.max(1,Number(l.readNo||4)-3)}회`:`듣기 ${Math.max(1,Number(l.readNo||1))}회`;return `<div class="log-item"><div class="row" style="justify-content:space-between"><b>${l.type==='record'?'🎙 녹음':'▶ 음원 재생'} · ${escapeHtml(l.roundTitle||"")} · ${escapeHtml(l.groupLabel||l.questionRange||"")}${isExam?` · ${Number(l.sessionIndex)+1}번 항목`:""}</b><span class="help">${fmtDate(l.createdAt)}</span></div><div>${attempt} · ${fmtSec(l.durationSec)}</div>${l.recordingUrl?`<audio class="audio-mini" controls src="${escapeHtml(l.recordingUrl)}"></audio>`:""}</div>`;}).join("")}`:`<div class="muted">활동 기록이 없습니다.</div>`;
  $("detailBody").innerHTML=summary+history;$("detailModal").classList.remove("hidden");
}

// 탭
for(const b of document.querySelectorAll(".tab-btn")){b.addEventListener("click",()=>{document.querySelectorAll(".tab-btn").forEach(x=>x.classList.toggle("active",x===b));document.querySelectorAll(".tab-panel").forEach(p=>p.classList.add("hidden"));$("tab-"+b.dataset.tab).classList.remove("hidden");if(b.dataset.tab==="progress")loadProgress();if(b.dataset.tab==="rounds")loadRounds();});}
$("parseScriptBtn").addEventListener("click",()=>{state.parsedQuestions=parseQuestions($("scriptInput").value);showPreview();});
$("scriptInput").addEventListener("input",()=>{state.parsedQuestions=[];$("parseSummary").textContent="";$("scriptPreview").classList.add("hidden");});
$("isExamPrep").addEventListener("change",event=>{$("regularScriptField").classList.toggle("hidden",event.target.checked);$("examPrepFields").classList.toggle("hidden",!event.target.checked);$("parseSummary").textContent="";$("scriptPreview").classList.add("hidden");});
for(let index=1;index<=3;index+=1){$("prepTitle"+index).addEventListener("input",()=>{$("parseSummary").textContent="";$("scriptPreview").classList.add("hidden");});$("prepScript"+index).addEventListener("input",()=>{$("parseSummary").textContent="";$("scriptPreview").classList.add("hidden");});}
$("saveRoundBtn").addEventListener("click",saveRound);
$("singleAddBtn").addEventListener("click",async()=>{try{await addStudent($("singleNo").value,$("singleName").value);$("singleNo").value="";$("singleName").value="";await loadStudents();}catch(e){alert(e.message);}});
$("bulkAddBtn").addEventListener("click",async()=>{const rows=parseStudentRows($("bulkStudents").value);if(!rows.length)return alert("인식된 학생이 없습니다.");let ok=0;for(const r of rows){try{await addStudent(r.no,r.name);ok++;}catch(e){console.warn(r,e);}}$("bulkResult").textContent=`${ok}명 등록/갱신 완료`;await loadStudents();});
$("refreshStudents").addEventListener("click",loadStudents);$("refreshRounds").addEventListener("click",loadRounds);$("refreshProgress").addEventListener("click",loadProgress);$("closeModal").addEventListener("click",()=>$("detailModal").classList.add("hidden"));$("detailModal").addEventListener("click",e=>{if(e.target===$("detailModal"))$("detailModal").classList.add("hidden");});
$("showAllProgress").addEventListener("click",()=>{state.progressView="all";renderProgressView();});
$("showManagedProgress").addEventListener("click",()=>{state.progressView="managed";renderProgressView();});
$("saveManagementGroup").addEventListener("click",saveManagementGroup);
$("selectAllStudents").addEventListener("change",event=>{document.querySelectorAll("[data-manage-student]").forEach(box=>{box.checked=event.target.checked;});});
$("managementWeek").addEventListener("change",()=>{if(state.progressView==="managed")renderManagedWeeklyProgress();});
$("previousWeek").addEventListener("click",()=>shiftManagementWeek(-7));
$("nextWeek").addEventListener("click",()=>shiftManagementWeek(7));
$("managementWeek").value=koreaDateKey();

loadStudents();loadRounds();
