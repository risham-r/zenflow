import { useState, useEffect, useRef, useCallback } from "react";
import { signInWithRedirect, getRedirectResult, signOut, onAuthStateChanged } from "firebase/auth";
import { doc, setDoc, getDoc } from "firebase/firestore";
import { auth, provider, db } from "./firebase";

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const FOCUS_PRESETS  = [15, 25, 45, 60, 90];
const SHORT_PRESETS  = [5, 10, 15];
const LONG_PRESETS   = [15, 20, 30];
const STREAK_MIN     = 25 * 60;
const SYNC_INTERVAL  = 30_000;
const OVERTIME_COLOR = "#D4A843";
const OVERTIME_GLOW  = "rgba(212,168,67,.45)";

const MODES = {
  focus:      { label:"Focus",       presets:FOCUS_PRESETS, default:25, color:"#6B9E78", glow:"rgba(107,158,120,.38)" },
  shortBreak: { label:"Short Break", presets:SHORT_PRESETS,  default:5,  color:"#C97D5B", glow:"rgba(201,125,91,.38)" },
  longBreak:  { label:"Long Break",  presets:LONG_PRESETS,   default:20, color:"#C97D5B", glow:"rgba(201,125,91,.28)" },
};

// ─── CHIME ────────────────────────────────────────────────────────────────────
function playChime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [523.25, 659.25, 783.99].forEach((freq, i) => {
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.type = "sine"; osc.frequency.value = freq;
      const t = ctx.currentTime + i * 0.28;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.13, t + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
      osc.start(t); osc.stop(t + 1.2);
    });
    setTimeout(() => ctx.close(), 4000);
  } catch {}
}

// ─── UTILS ────────────────────────────────────────────────────────────────────
const p2       = n  => String(n).padStart(2, "0");
const fmtClock = s  => `${p2(Math.floor(Math.abs(s)/60))}:${p2(Math.abs(s)%60)}`;
const fmtDur   = s  => { if(s<60)return`${s}s`; const h=Math.floor(s/3600),m=Math.floor((s%3600)/60); return h?`${h}h ${m}m`:`${m}m`; };
const fmtHours = s  => `${(s/3600).toFixed(1)}h`;
const fmtWall  = ts => new Date(ts).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});
const uid      = () => Date.now().toString(36)+Math.random().toString(36).slice(2);
const todayKey = () => new Date().toISOString().slice(0,10);
const weekStart= () => { const d=new Date(); d.setDate(d.getDate()-d.getDay()); return d.toISOString().slice(0,10); };
const load     = (k,fb) => { try{ const v=localStorage.getItem(k); return v?JSON.parse(v):fb; }catch{return fb;} };
const save     = (k,v)  => { try{ localStorage.setItem(k,JSON.stringify(v)); }catch{} };

function computeStreak(ds) {
  let streak=0; const d=new Date(), today=todayKey();
  for(let i=0;i<366;i++){
    const k=d.toISOString().slice(0,10);
    if((ds[k]||0)>=STREAK_MIN){ streak++; d.setDate(d.getDate()-1); }
    else if(k===today){ d.setDate(d.getDate()-1); }
    else break;
  }
  return streak;
}

function exportCSV(sessions, tasks) {
  const tm=Object.fromEntries(tasks.map(t=>[t.id,t.name]));
  const header="Date,Time,Task,Category,Goal (min),Overtime (min),Total (min)\n";
  const rows=sessions.map(s=>{
    const d=new Date(s.startedAt), task=tasks.find(t=>t.id===s.taskId);
    const parent=task?.parentId?tm[task.parentId]||"":"";
    return `"${d.toLocaleDateString()}","${fmtWall(s.startedAt)}","${tm[s.taskId]||"Untitled"}","${parent}",${Math.round((s.goalSeconds||s.durationSeconds)/60)},${Math.round((s.overtimeSeconds||0)/60)},${Math.round(s.durationSeconds/60)}`;
  }).join("\n");
  const url=URL.createObjectURL(new Blob([header+rows],{type:"text/csv"}));
  Object.assign(document.createElement("a"),{href:url,download:"zenflow-sessions.csv"}).click();
  URL.revokeObjectURL(url);
}

function getDaysInMonth(y,m){ return new Date(y,m+1,0).getDate(); }
function getFirstDay(y,m)   { return new Date(y,m,1).getDay(); }

// ─── CALENDAR ─────────────────────────────────────────────────────────────────
function CalendarGrid({ dailyStats, color }) {
  const now=new Date();
  const [vy,setVy]=useState(now.getFullYear());
  const [vm,setVm]=useState(now.getMonth());
  const MONTHS=["January","February","March","April","May","June","July","August","September","October","November","December"];
  const DAYS=["Su","Mo","Tu","We","Th","Fr","Sa"];
  const today=todayKey();
  const dim=getDaysInMonth(vy,vm), fd=getFirstDay(vy,vm);
  const mk=`${vy}-${p2(vm+1)}`;
  const vals=Array.from({length:dim},(_,i)=>dailyStats[`${mk}-${p2(i+1)}`]||0);
  const maxS=Math.max(...vals,1);
  const prevM=()=>vm===0?(setVm(11),setVy(y=>y-1)):setVm(m=>m-1);
  const nextM=()=>vm===11?(setVm(0),setVy(y=>y+1)):setVm(m=>m+1);
  const dayBg=n=>{ const s=dailyStats[`${mk}-${p2(n)}`]||0; if(!s)return{}; const a=Math.round((.15+Math.min(s/maxS,1)*.72)*255).toString(16).padStart(2,"0"); return{background:`${color}${a}`,boxShadow:s/maxS>.5?`0 0 7px ${color}55`:"none"}; };
  const cells=[]; for(let i=0;i<fd;i++)cells.push(null); for(let d=1;d<=dim;d++)cells.push(d);
  return (
    <div>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
        <button onClick={prevM} style={{background:"none",border:"none",color:"#555",cursor:"pointer",fontSize:18,padding:"2px 8px"}}>‹</button>
        <span style={{fontSize:12,color:"#aaa",letterSpacing:".06em"}}>{MONTHS[vm]} {vy}</span>
        <button onClick={nextM} style={{background:"none",border:"none",color:"#555",cursor:"pointer",fontSize:18,padding:"2px 8px"}}>›</button>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:3,marginBottom:4}}>
        {DAYS.map(d=><div key={d} style={{textAlign:"center",fontSize:9,color:"#333",letterSpacing:".04em"}}>{d}</div>)}
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:3}}>
        {cells.map((day,i)=>{
          if(!day)return<div key={`e${i}`}/>;
          const k=`${mk}-${p2(day)}`, isToday=k===today, has=(dailyStats[k]||0)>0;
          return <div key={day} title={has?fmtDur(dailyStats[k]):""} style={{height:28,borderRadius:6,display:"flex",alignItems:"center",justifyContent:"center",fontSize:10.5,cursor:has?"help":"default",color:isToday?"#fff":has?"#ccc":"#383838",border:isToday?`1px solid ${color}`:"1px solid transparent",transition:"all .2s",...dayBg(day)}}>{day}</div>;
        })}
      </div>
      <div style={{display:"flex",alignItems:"center",gap:5,marginTop:10,justifyContent:"flex-end"}}>
        <span style={{fontSize:9,color:"#333"}}>Less</span>
        {[.15,.38,.62,.86].map(a=><div key={a} style={{width:10,height:10,borderRadius:2,background:`${color}${Math.round(a*255).toString(16).padStart(2,"0")}`}}/>)}
        <span style={{fontSize:9,color:"#333"}}>More</span>
      </div>
    </div>
  );
}

// ─── ICONS ────────────────────────────────────────────────────────────────────
const FolderIcon  = ({color})=><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={color||"#6B9E78"} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>;
const ChevronIcon = ({open})=><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points={open?"18 15 12 9 6 15":"6 9 12 15 18 9"}/></svg>;
const DragHandle  = ()=><svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" style={{opacity:.25}}><circle cx="3" cy="2.5" r="1.2"/><circle cx="7" cy="2.5" r="1.2"/><circle cx="3" cy="7" r="1.2"/><circle cx="7" cy="7" r="1.2"/><circle cx="3" cy="11.5" r="1.2"/><circle cx="7" cy="11.5" r="1.2"/></svg>;

// ─── SESSION SUMMARY MODAL ────────────────────────────────────────────────────
function SummaryModal({ summary, onClose, accentColor, accentGlow }) {
  if(!summary)return null;
  const { goalSeconds, overtimeSeconds, taskName, parentName } = summary;
  const total=goalSeconds+overtimeSeconds, hasOT=overtimeSeconds>0;
  return (
    <div style={{position:"fixed",inset:0,zIndex:200,background:"rgba(0,0,0,0.75)",backdropFilter:"blur(14px)",display:"flex",alignItems:"center",justifyContent:"center"}} onClick={onClose}>
      <div style={{background:"#17171B",border:"1px solid rgba(255,255,255,0.1)",borderRadius:22,padding:"32px 36px",width:360,textAlign:"center",animation:"scaleIn .28s cubic-bezier(.34,1.56,.64,1)",boxShadow:"0 40px 100px rgba(0,0,0,0.85)"}} onClick={e=>e.stopPropagation()}>
        <div style={{fontSize:44,marginBottom:16,lineHeight:1}}>{hasOT?"🔥":"✅"}</div>
        <div style={{fontSize:19,fontWeight:600,color:"#e8e8e8",marginBottom:6}}>{hasOT?"Goal crushed!":"Goal reached!"}</div>
        <div style={{fontSize:12,color:"#555",marginBottom:22}}>
          {parentName&&<span style={{color:"#444"}}>{parentName} / </span>}
          <span style={{color:"#777"}}>{taskName||"Focus session"}</span>
        </div>
        <div style={{display:"flex",gap:10,marginBottom:22,justifyContent:"center"}}>
          <div style={{background:"rgba(107,158,120,0.1)",border:"1px solid rgba(107,158,120,0.22)",borderRadius:12,padding:"14px 18px",flex:1}}>
            <div style={{fontSize:9.5,color:"#6B9E78",letterSpacing:".1em",marginBottom:6}}>GOAL</div>
            <div style={{fontFamily:"'DM Mono',monospace",fontSize:26,fontWeight:300,color:"#6B9E78",lineHeight:1}}>{fmtDur(goalSeconds)}</div>
          </div>
          {hasOT&&(
            <div style={{background:"rgba(212,168,67,0.1)",border:"1px solid rgba(212,168,67,0.25)",borderRadius:12,padding:"14px 18px",flex:1}}>
              <div style={{fontSize:9.5,color:OVERTIME_COLOR,letterSpacing:".1em",marginBottom:6}}>OVERTIME</div>
              <div style={{fontFamily:"'DM Mono',monospace",fontSize:26,fontWeight:300,color:OVERTIME_COLOR,lineHeight:1}}>+{fmtDur(overtimeSeconds)}</div>
            </div>
          )}
        </div>
        <div style={{borderTop:"1px solid rgba(255,255,255,0.06)",paddingTop:18,marginBottom:24}}>
          <div style={{fontSize:10,color:"#444",letterSpacing:".1em",marginBottom:6}}>TOTAL FOCUS</div>
          <div style={{fontFamily:"'DM Mono',monospace",fontSize:36,fontWeight:300,color:"#e0e0e0",letterSpacing:"-.02em"}}>{fmtDur(total)}</div>
        </div>
        <button onClick={onClose} style={{width:"100%",padding:"12px 0",background:`linear-gradient(135deg,${accentColor},${accentColor}cc)`,border:"none",borderRadius:12,color:"#fff",fontSize:14,fontWeight:600,cursor:"pointer",fontFamily:"inherit",boxShadow:`0 4px 24px ${accentGlow}`,transition:"transform .15s cubic-bezier(.34,1.56,.64,1)"}}
          onMouseOver={e=>e.currentTarget.style.transform="scale(1.03)"} onMouseOut={e=>e.currentTarget.style.transform="scale(1)"}>
          Start New Session
        </button>
      </div>
    </div>
  );
}

// ─── TASK LIST ────────────────────────────────────────────────────────────────
function TaskList({ tasks, taskStats, activeTaskId, setActiveTaskId, setTasks, isRunning, liveSession, mode, accentColor, accentGlow }) {
  const [collapsed,setCollapsed]=useState(()=>load("pomo_collapsed",{}));
  useEffect(()=>save("pomo_collapsed",collapsed),[collapsed]);
  const dragId=useRef(null);
  const [dropTarget,setDropTarget]=useState(null);
  const toggleCol=id=>setCollapsed(p=>({...p,[id]:!p[id]}));
  const parents=tasks.filter(t=>!t.parentId).sort((a,b)=>a.createdAt-b.createdAt);
  const childrenOf=id=>tasks.filter(t=>t.parentId===id).sort((a,b)=>a.createdAt-b.createdAt);
  const hasChildren=id=>tasks.some(t=>t.parentId===id);
  const liveFocus=isRunning&&mode==="focus"?liveSession:0;
  const ownSecs=id=>(taskStats[id]||0)+(activeTaskId===id?liveFocus:0);
  const parentTotal=id=>{ const ch=childrenOf(id); const la=activeTaskId===id?liveFocus:ch.some(c=>c.id===activeTaskId)?liveFocus:0; return (taskStats[id]||0)+ch.reduce((a,c)=>a+(taskStats[c.id]||0),0)+la; };
  const indentUnder=(tid,pid)=>{ if(tid===pid||hasChildren(tid))return; const p=tasks.find(t=>t.id===pid); if(p?.parentId)return; setTasks(prev=>prev.map(t=>t.id===tid?{...t,parentId:pid}:t)); };
  const unindent=tid=>setTasks(prev=>prev.map(t=>t.id===tid?{...t,parentId:null}:t));
  const removeTask=id=>{ setTasks(prev=>{ const orphans=prev.filter(t=>t.parentId===id).map(t=>({...t,parentId:null})); return [...prev.filter(t=>t.id!==id&&t.parentId!==id),...orphans]; }); if(activeTaskId===id)setActiveTaskId(null); };
  const onDragStart=(e,id)=>{ dragId.current=id; e.dataTransfer.effectAllowed="move"; };
  const onDragOver=(e,id,zone)=>{ e.preventDefault(); e.stopPropagation(); setDropTarget({id,zone}); };
  const onDrop=(e,tid)=>{ e.preventDefault(); const src=dragId.current; if(!src||src===tid){setDropTarget(null);return;} if(dropTarget?.zone==="child") indentUnder(src,tid); else { const tTask=tasks.find(t=>t.id===tid); if(!tTask?.parentId){ setTasks(prev=>{ const filt=prev.filter(t=>t.id!==src); const ti=filt.findIndex(t=>t.id===tid); const st=prev.find(t=>t.id===src); if(!st)return prev; filt.splice(dropTarget?.zone==="above"?ti:ti+1,0,{...st,parentId:null}); return filt; }); } } dragId.current=null; setDropTarget(null); };
  const onDragEnd=()=>{ dragId.current=null; setDropTarget(null); };
  const base={display:"flex",alignItems:"center",gap:8,cursor:"pointer",transition:"background .18s"};
  return (
    <div>
      {parents.map(parent=>{
        const kids=childrenOf(parent.id), isPar=hasChildren(parent.id), isCol=collapsed[parent.id];
        const isActive=activeTaskId===parent.id, pTotal=isPar?parentTotal(parent.id):ownSecs(parent.id);
        const dropChild=dropTarget?.id===parent.id&&dropTarget?.zone==="child";
        const dropAbove=dropTarget?.id===parent.id&&dropTarget?.zone==="above";
        return (
          <div key={parent.id}>
            {dropAbove&&<div style={{height:2,background:accentColor,borderRadius:1,margin:"0 12px"}}/>}
            <div className="task-row" draggable onDragStart={e=>onDragStart(e,parent.id)}
              onDragOver={e=>{ const r=e.currentTarget.getBoundingClientRect(),y=e.clientY-r.top,h=r.height; onDragOver(e,parent.id,y<h*.28?"above":y>h*.72?"below":"child"); }}
              onDragLeave={()=>setDropTarget(null)} onDrop={e=>onDrop(e,parent.id)} onDragEnd={onDragEnd}
              onClick={()=>setActiveTaskId(parent.id)}
              style={{...base,padding:"10px 16px",borderBottom:"1px solid rgba(255,255,255,0.025)",background:dropChild?"rgba(107,158,120,0.1)":isActive?"rgba(255,255,255,0.045)":"transparent",outline:dropChild?`1px solid ${accentColor}44`:"none"}}>
              <span style={{color:"#444",cursor:"grab",flexShrink:0,display:"flex"}} onClick={e=>e.stopPropagation()}><DragHandle/></span>
              {isPar?(
                <button onClick={e=>{e.stopPropagation();toggleCol(parent.id);}} style={{background:"none",border:"none",cursor:"pointer",padding:0,display:"flex",alignItems:"center",gap:4,color:accentColor,flexShrink:0}}>
                  <FolderIcon color={accentColor}/><span style={{color:"#444",display:"flex"}}><ChevronIcon open={!isCol}/></span>
                </button>
              ):(
                <div style={{width:7,height:7,borderRadius:"50%",flexShrink:0,background:isActive?accentColor:"rgba(255,255,255,0.12)",boxShadow:isActive?`0 0 7px ${accentColor}`:"none",transition:"all .3s"}}/>
              )}
              <span style={{flex:1,fontSize:isPar?13.5:13,fontWeight:isPar?500:400,color:isActive?"#eee":isPar?"#c0c0c0":"#888",transition:"color .2s"}}>{parent.name}</span>
              {pTotal>0&&<span style={{fontSize:11,color:isPar?accentColor+"99":"#484848",fontFamily:"'DM Mono',monospace"}}>{fmtDur(pTotal)}</span>}
              {isRunning&&isActive&&liveSession>0&&mode==="focus"&&<span style={{fontSize:10,color:accentColor,fontFamily:"'DM Mono',monospace"}}>+{fmtDur(liveSession)}</span>}
              <span style={{display:"flex",gap:3,flexShrink:0}} onClick={e=>e.stopPropagation()}>
                <button onClick={()=>removeTask(parent.id)} style={{background:"none",border:"none",color:"#2e2e2e",cursor:"pointer",fontSize:15,lineHeight:1,padding:"0 1px",transition:"color .2s"}} onMouseOver={e=>e.currentTarget.style.color="#777"} onMouseOut={e=>e.currentTarget.style.color="#2e2e2e"}>×</button>
              </span>
            </div>
            {!isCol&&kids.map(child=>{
              const cSecs=ownSecs(child.id), cActive=activeTaskId===child.id;
              return(
                <div key={child.id} className="task-row" draggable onDragStart={e=>onDragStart(e,child.id)} onDragOver={e=>onDragOver(e,child.id,"child")} onDragLeave={()=>setDropTarget(null)} onDrop={e=>e.preventDefault()} onDragEnd={onDragEnd}
                  onClick={()=>setActiveTaskId(child.id)}
                  style={{...base,padding:"8px 16px 8px 36px",borderBottom:"1px solid rgba(255,255,255,0.02)",borderLeft:`2px solid ${accentColor}22`,background:cActive?"rgba(255,255,255,0.04)":"transparent"}}>
                  <span style={{color:"#444",cursor:"grab",display:"flex",flexShrink:0}} onClick={e=>e.stopPropagation()}><DragHandle/></span>
                  <div style={{width:5,height:5,borderRadius:"50%",flexShrink:0,background:cActive?accentColor:"rgba(255,255,255,0.18)",boxShadow:cActive?`0 0 6px ${accentColor}`:"none",transition:"all .3s"}}/>
                  <span style={{flex:1,fontSize:12.5,fontWeight:300,color:cActive?"#ddd":"#666",transition:"color .2s"}}>{child.name}</span>
                  {cSecs>0&&<span style={{fontSize:11,color:"#404040",fontFamily:"'DM Mono',monospace"}}>{fmtDur(cSecs+(isRunning&&cActive&&mode==="focus"?liveSession:0))}</span>}
                  {isRunning&&cActive&&liveSession>0&&mode==="focus"&&<span style={{fontSize:10,color:accentColor,fontFamily:"'DM Mono',monospace"}}>+{fmtDur(liveSession)}</span>}
                  <span style={{display:"flex",gap:3}} onClick={e=>e.stopPropagation()}>
                    <button onClick={()=>unindent(child.id)} style={{background:"none",border:"none",color:"#2e2e2e",cursor:"pointer",fontSize:12,lineHeight:1,padding:"0 2px",transition:"color .2s"}} onMouseOver={e=>e.currentTarget.style.color="#777"} onMouseOut={e=>e.currentTarget.style.color="#2e2e2e"}>⇤</button>
                    <button onClick={()=>removeTask(child.id)} style={{background:"none",border:"none",color:"#2e2e2e",cursor:"pointer",fontSize:15,lineHeight:1,padding:"0 1px",transition:"color .2s"}} onMouseOver={e=>e.currentTarget.style.color="#777"} onMouseOut={e=>e.currentTarget.style.color="#2e2e2e"}>×</button>
                  </span>
                </div>
              );
            })}
            {dropChild&&kids.length===0&&!isCol&&<div style={{padding:"6px 36px",fontSize:11,color:accentColor,opacity:.7,borderLeft:`2px solid ${accentColor}22`}}>Drop here to nest</div>}
          </div>
        );
      })}
    </div>
  );
}

// ─── DEEP DIVE ────────────────────────────────────────────────────────────────
function DeepDive({ tasks, taskStats, activeTaskId, isRunning, liveSession, mode, accentColor }) {
  const childrenOf=id=>tasks.filter(t=>t.parentId===id);
  const hasChildren=id=>tasks.some(t=>t.parentId===id);
  const liveFocus=isRunning&&mode==="focus"?liveSession:0;
  const ownSecs=id=>(taskStats[id]||0)+(activeTaskId===id?liveFocus:0);
  const parentTotal=id=>{ const ch=childrenOf(id); const la=activeTaskId===id?liveFocus:ch.some(c=>c.id===activeTaskId)?liveFocus:0; return (taskStats[id]||0)+ch.reduce((a,c)=>a+(taskStats[c.id]||0),0)+la; };
  const parents=tasks.filter(t=>!t.parentId).map(t=>({...t,total:hasChildren(t.id)?parentTotal(t.id):ownSecs(t.id)})).sort((a,b)=>b.total-a.total);
  const maxTotal=parents.reduce((a,p)=>Math.max(a,p.total),1);
  if(!parents.length)return<div style={{textAlign:"center",color:"#303030",fontSize:13,padding:"22px 0"}}>No task data yet — start a focus session!</div>;
  return(
    <div style={{display:"flex",flexDirection:"column",gap:18}}>
      {parents.map(parent=>{
        const kids=childrenOf(parent.id).map(c=>({...c,secs:ownSecs(c.id)})).sort((a,b)=>b.secs-a.secs);
        const isPar=hasChildren(parent.id), barW=Math.max(3,(parent.total/maxTotal)*100), directSecs=ownSecs(parent.id);
        return(
          <div key={parent.id}>
            <div style={{marginBottom:7}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                <div style={{display:"flex",alignItems:"center",gap:7}}>
                  {isPar?<FolderIcon color={accentColor}/>:<div style={{width:6,height:6,borderRadius:"50%",background:accentColor,opacity:.65}}/>}
                  <span style={{fontSize:13.5,fontWeight:isPar?500:400,color:"#c8c8c8"}}>{parent.name}</span>
                </div>
                <span style={{fontFamily:"'DM Mono',monospace",fontSize:12,color:isPar?accentColor+"99":"#555"}}>{parent.total>0?fmtDur(parent.total):"—"}</span>
              </div>
              <div style={{height:3,background:"rgba(255,255,255,0.045)",borderRadius:2,overflow:"hidden"}}>
                <div style={{height:"100%",width:`${barW}%`,background:`linear-gradient(90deg,${accentColor}77,${accentColor})`,borderRadius:2,transition:"width 1s ease"}}/>
              </div>
            </div>
            {isPar&&(
              <div style={{paddingLeft:20,borderLeft:`1px solid ${accentColor}28`,display:"flex",flexDirection:"column",gap:8,marginTop:4}}>
                {kids.map(child=>{ const cb=Math.max(2,(child.secs/Math.max(parent.total,1))*100); return(
                  <div key={child.id}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
                      <div style={{display:"flex",alignItems:"center",gap:6}}><div style={{width:4,height:4,borderRadius:"50%",background:accentColor,opacity:.45}}/><span style={{fontSize:12.5,fontWeight:300,color:"#777"}}>{child.name}</span></div>
                      <span style={{fontFamily:"'DM Mono',monospace",fontSize:11,color:"#484848"}}>{child.secs>0?fmtDur(child.secs):"—"}</span>
                    </div>
                    <div style={{height:2,background:"rgba(255,255,255,0.03)",borderRadius:2,overflow:"hidden"}}><div style={{height:"100%",width:`${cb}%`,background:`${accentColor}66`,borderRadius:2,transition:"width 1s ease"}}/></div>
                  </div>
                ); })}
                {isPar&&directSecs>0&&(
                  <div>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
                      <div style={{display:"flex",alignItems:"center",gap:6}}><div style={{width:4,height:4,borderRadius:"50%",background:"#555",opacity:.6}}/><span style={{fontSize:12.5,fontWeight:300,color:"#555",fontStyle:"italic"}}>uncategorized</span></div>
                      <span style={{fontFamily:"'DM Mono',monospace",fontSize:11,color:"#484848"}}>{fmtDur(directSecs)}</span>
                    </div>
                    <div style={{height:2,background:"rgba(255,255,255,0.03)",borderRadius:2,overflow:"hidden"}}><div style={{height:"100%",width:`${Math.max(2,(directSecs/Math.max(parent.total,1))*100)}%`,background:"#55555566",borderRadius:2}}/></div>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function PomodoroApp() {
  const [user,setUser]         = useState(null);
  const [authLoading,setAuthLoading] = useState(true); // true while Firebase checks session
  const [showAuth,setShowAuth] = useState(false);
  const [syncing,setSyncing]   = useState(false);
  const [mode,setMode]         = useState("focus");
  const [duration,setDuration] = useState(MODES.focus.default*60);
  const [timeLeft,setTimeLeft] = useState(MODES.focus.default*60);
  const [isRunning,setRunning] = useState(false);
  const [isOvertime,setOT]     = useState(false);
  const [chimeFired,setChime]  = useState(false);
  const [showPicker,setPicker] = useState(false);
  const [selMins,setSelMins]   = useState(MODES.focus.default);
  const [tasks,setTasks]       = useState(()=>load("pomo_tasks",[]));
  const [activeTaskId,setATId] = useState(()=>load("pomo_activeTask",null));
  const [newTask,setNewTask]   = useState("");
  const [iFocus,setIFocus]     = useState(false);
  const [addMode,setAddMode]   = useState("task");
  const inputRef=useRef(null);
  const [dailyStats,setDS]     = useState(()=>load("pomo_dailyStats",{}));
  const [taskStats,setTS]      = useState(()=>load("pomo_taskStats",{}));
  const [sessions,setSessions] = useState(()=>load("pomo_sessions",[]));
  const [showAn,setShowAn]     = useState(false);
  const [aTab,setATab]         = useState("overview");
  const [liveSession,setLive]  = useState(0);
  const [summary,setSummary]   = useState(null);

  const tickRef    =useRef(null);
  const sesSecsRef =useRef(0);
  const sesStartRef=useRef(null);
  const goalRef    =useRef(0);
  const lastSync   =useRef(Date.now());
  const modeRef    =useRef(mode);
  const atIdRef    =useRef(activeTaskId);
  const tasksRef   =useRef(tasks);
  const otRef      =useRef(false);
  const liveRef    =useRef(0);
  const saveTimer  =useRef(null);

  useEffect(()=>{ modeRef.current=mode; },[mode]);
  useEffect(()=>{ atIdRef.current=activeTaskId; },[activeTaskId]);
  useEffect(()=>{ tasksRef.current=tasks; },[tasks]);
  useEffect(()=>{ otRef.current=isOvertime; },[isOvertime]);
  useEffect(()=>{ liveRef.current=liveSession; },[liveSession]);

  useEffect(()=>save("pomo_tasks",tasks),[tasks]);
  useEffect(()=>save("pomo_dailyStats",dailyStats),[dailyStats]);
  useEffect(()=>save("pomo_taskStats",taskStats),[taskStats]);
  useEffect(()=>save("pomo_activeTask",activeTaskId),[activeTaskId]);
  useEffect(()=>save("pomo_sessions",sessions),[sessions]);
  useEffect(()=>{ if(Notification.permission==="default")Notification.requestPermission(); },[]);

  // ── FIREBASE: Load user data from Firestore ──
  const loadFromFirestore = async (uid) => {
    try {
      const snap = await getDoc(doc(db, "users", uid));
      if (snap.exists()) {
        const data = snap.data();
        if (data.tasks)      { setTasks(data.tasks);      save("pomo_tasks", data.tasks); }
        if (data.dailyStats) { setDS(data.dailyStats);    save("pomo_dailyStats", data.dailyStats); }
        if (data.taskStats)  { setTS(data.taskStats);     save("pomo_taskStats", data.taskStats); }
        if (data.sessions)   { setSessions(data.sessions);save("pomo_sessions", data.sessions); }
      }
    } catch (err) {
      console.error("Firestore load error:", err);
    }
  };

  // ── FIREBASE: Save user data to Firestore (debounced) ──
  const saveToFirestore = useCallback((uid, data) => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        await setDoc(doc(db, "users", uid), data, { merge: true });
      } catch (err) {
        console.error("Firestore save error:", err);
      }
    }, 2000); // debounce 2s
  }, []);

  // ── FIREBASE: Auth state listener ──
 // Handle redirect result when page loads back
useEffect(() => {
  getRedirectResult(auth).then(async (result) => {
    if (result?.user) {
      setUser(result.user);
      setSyncing(true);
      await loadFromFirestore(result.user.uid);
      setSyncing(false);
    }
  }).catch(console.error);

  // Listen for auth state changes
  const unsub = onAuthStateChanged(auth, async (firebaseUser) => {
    if (firebaseUser) {
      setUser(firebaseUser);
      setSyncing(true);
      await loadFromFirestore(firebaseUser.uid);
      setSyncing(false);
    } else {
      setUser(null);
    }
    setAuthLoading(false);
  });

  return () => unsub();
}, []);
  // ── FIREBASE: Auto-save when data changes ──
  useEffect(() => {
    if (!user) return;
    saveToFirestore(user.uid, { tasks, dailyStats, taskStats, sessions });
  }, [tasks, dailyStats, taskStats, sessions, user, saveToFirestore]);

  // ── FIREBASE: Sign in with Google ──
  const handleSignIn = async () => {
    try {
      await signInWithRedirect(auth, provider);
    } catch (err) {
      console.error("Sign-in error:", err);
    }
  };

  // ── FIREBASE: Sign out ──
  const handleSignOut = async () => {
    try {
      await signOut(auth);
      setUser(null);
    } catch (err) {
      console.error("Sign-out error:", err);
    }
  };

  const commitSeconds=useCallback((secs)=>{
    if(secs<=0||modeRef.current!=="focus")return;
    const today=todayKey(), taskId=atIdRef.current;
    const task=tasksRef.current.find(t=>t.id===taskId);
    const parentId=task?.parentId||null;
    setDS(p=>({...p,[today]:(p[today]||0)+secs}));
    if(taskId)   setTS(p=>({...p,[taskId]:(p[taskId]||0)+secs}));
    if(parentId) setTS(p=>({...p,[parentId]:(p[parentId]||0)+secs}));
  },[]);

  const commitSession=useCallback((goalSecs,totalSecs)=>{
    if(totalSecs<5||modeRef.current!=="focus")return;
    setSessions(p=>[...p,{id:uid(),taskId:atIdRef.current,durationSeconds:totalSecs,goalSeconds:goalSecs,overtimeSeconds:Math.max(0,totalSecs-goalSecs),startedAt:sesStartRef.current||Date.now()-totalSecs*1000,date:todayKey()}]);
  },[]);

  useEffect(()=>{
    if(isRunning){
      tickRef.current=setInterval(()=>{
        setTimeLeft(prev=>{
          if(prev===1&&!otRef.current){
            setOT(true); otRef.current=true;
            if(Notification.permission==="granted")
              new Notification("Zenflow",{body:"Goal reached! Timer running in overtime 🔥"});
          }
          sesSecsRef.current+=1;
          setLive(s=>{ liveRef.current=s+1; return s+1; });
          if(Date.now()-lastSync.current>=SYNC_INTERVAL){
            commitSeconds(sesSecsRef.current); sesSecsRef.current=0; lastSync.current=Date.now();
          }
          return prev-1;
        });
      },1000);
    } else clearInterval(tickRef.current);
    return ()=>clearInterval(tickRef.current);
  },[isRunning,commitSeconds]);

  useEffect(()=>{ if(isOvertime&&!chimeFired){ playChime(); setChime(true); } },[isOvertime,chimeFired]);

  const endSession=useCallback(()=>{
    clearInterval(tickRef.current);
    commitSeconds(sesSecsRef.current);
    const total=liveRef.current;
    const goal=goalRef.current;
    commitSession(goal, total);
    const taskId=atIdRef.current, task=tasksRef.current.find(t=>t.id===taskId);
    const parent=task?.parentId?tasksRef.current.find(t=>t.id===task.parentId):null;
    setSummary({ goalSeconds:goal, overtimeSeconds:Math.max(0,total-goal), taskName:task?.name||null, parentName:parent?.name||null });
    sesSecsRef.current=0; setRunning(false); setOT(false); otRef.current=false; setChime(false); setLive(0); liveRef.current=0;
    setTimeLeft(duration);
  },[duration,commitSeconds,commitSession]);

  const toggleTimer=()=>{
    if(!isRunning){
      if(timeLeft===duration){ sesStartRef.current=Date.now(); goalRef.current=duration; setOT(false); otRef.current=false; setChime(false); }
      setRunning(true);
    } else {
      commitSeconds(sesSecsRef.current); sesSecsRef.current=0; setRunning(false);
    }
  };

  const resetTimer=()=>{
    if(isRunning){ commitSeconds(sesSecsRef.current); sesSecsRef.current=0; }
    setRunning(false); setOT(false); otRef.current=false; setChime(false); setTimeLeft(duration); setLive(0); liveRef.current=0;
  };

  const switchMode=m=>{
    if(isRunning){ commitSeconds(sesSecsRef.current); sesSecsRef.current=0; }
    setRunning(false); setOT(false); otRef.current=false; setChime(false);
    setMode(m); const mins=MODES[m].default;
    setSelMins(mins); setDuration(mins*60); setTimeLeft(mins*60); setLive(0); liveRef.current=0; setPicker(false);
  };

  const selectDur=mins=>{
    setSelMins(mins); const secs=mins*60; setDuration(secs); setTimeLeft(secs);
    setRunning(false); setOT(false); otRef.current=false; setChime(false);
    sesSecsRef.current=0; setLive(0); liveRef.current=0; setPicker(false);
  };

  const handleAdd=e=>{
    e.preventDefault(); const name=newTask.trim(); if(!name)return;
    const activeTask=tasks.find(t=>t.id===activeTaskId);
    let parentId=null;
    if(addMode==="task"&&activeTask&&!activeTask.parentId) parentId=activeTask.id;
    const t={id:uid(),name,parentId,createdAt:Date.now()};
    setTasks(p=>[...p,t]); if(!activeTaskId)setATId(t.id);
    setNewTask(""); inputRef.current?.focus();
  };

  const cfg=MODES[mode];
  const dispColor=isOvertime&&mode==="focus"?OVERTIME_COLOR:cfg.color;
  const dispGlow =isOvertime&&mode==="focus"?OVERTIME_GLOW:cfg.glow;
  const today=todayKey(), ws=weekStart();
  const liveFocus=isRunning&&mode==="focus"?liveSession:0;
  const todayS=(dailyStats[today]||0)+liveFocus;
  const weekS=Object.entries(dailyStats).filter(([k])=>k>=ws).reduce((a,[,v])=>a+v,0)+liveFocus;
  const allS=Object.values(dailyStats).reduce((a,v)=>a+v,0)+liveFocus;
  const streak=computeStreak(dailyStats);
  const todaySes=sessions.filter(s=>s.date===today).sort((a,b)=>b.startedAt-a.startedAt);
  const taskMap=Object.fromEntries(tasks.map(t=>[t.id,t.name]));
  const activeTask=tasks.find(t=>t.id===activeTaskId);
  const activeParent=activeTask?.parentId?tasks.find(t=>t.id===activeTask.parentId):null;
  const R=120, CIRC=2*Math.PI*R;
  const dashOff=isOvertime?0:CIRC*(1-Math.max(0,timeLeft)/duration);
  const overtimeSecs=isOvertime?Math.abs(timeLeft):0;

  if(authLoading){
    return(
      <div style={{minHeight:"100vh",background:"#0E0E10",display:"flex",alignItems:"center",justifyContent:"center"}}>
        <div style={{width:8,height:8,borderRadius:"50%",background:"#6B9E78",animation:"pulse 1.5s infinite",boxShadow:"0 0 16px #6B9E78"}}/>
        <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}`}</style>
      </div>
    );
  }

  return(
    <div style={{minHeight:"100vh",background:"#0E0E10",color:"#E8E8E8",fontFamily:"'Sora','DM Sans',system-ui,sans-serif",position:"relative",overflowX:"hidden"}}>
      <div style={{position:"fixed",inset:0,pointerEvents:"none",zIndex:0,background:`radial-gradient(ellipse 65% 52% at 50% -4%,${dispGlow} 0%,transparent 68%)`,transition:"background 1.2s ease"}}/>
      <div style={{position:"fixed",inset:0,pointerEvents:"none",zIndex:0,opacity:.28,backgroundImage:`url("data:image/svg+xml,%3Csvg width='500' height='500' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.72' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.045'/%3E%3C/svg%3E")`}}/>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Sora:wght@300;400;500;600;700&family=DM+Mono:wght@300;400;500&display=swap');
        *{box-sizing:border-box;margin:0;padding:0;}
        ::-webkit-scrollbar{width:3px;}::-webkit-scrollbar-thumb{background:#252525;border-radius:2px;}
        @keyframes fadeIn    {from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
        @keyframes pulse     {0%,100%{opacity:1}50%{opacity:.4}}
        @keyframes scaleIn   {from{opacity:0;transform:scale(.93)}to{opacity:1;transform:scale(1)}}
        @keyframes slideDown {from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}
        @keyframes tabIn     {from{opacity:0;transform:translateX(5px)}to{opacity:1;transform:translateX(0)}}
        @keyframes otPulse   {0%,100%{opacity:1;transform:scale(1)}50%{opacity:.75;transform:scale(1.03)}}
        @keyframes ringGlow  {0%,100%{filter:drop-shadow(0 0 8px ${OVERTIME_COLOR}88)}50%{filter:drop-shadow(0 0 24px ${OVERTIME_COLOR})}}
        @keyframes stripSlide{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:translateY(0)}}
        .btn-spring{transition:transform .15s cubic-bezier(.34,1.56,.64,1),background .3s,box-shadow .3s;}
        .btn-spring:hover{transform:scale(1.07);}
        .btn-spring:active{transform:scale(.94);}
        .task-row:hover{background:rgba(255,255,255,0.05)!important;}
        .mode-btn{transition:all .3s cubic-bezier(.34,1.56,.64,1);}
        .mode-btn:hover{transform:translateY(-1px);}
        .analytics-slide{animation:slideDown .28s ease;}
        .tab-content{animation:tabIn .22s ease;}
        .preset-item{transition:all .2s cubic-bezier(.34,1.56,.64,1);}
        .preset-item:hover{transform:scale(1.1);}
        .ring-tr{transition:stroke-dashoffset 1.05s linear,stroke 1.2s ease;}
        .ring-normal{filter:drop-shadow(0 0 9px currentColor);}
        .ring-ot{animation:ringGlow 2.2s ease-in-out infinite;}
        .add-btn{transition:transform .2s cubic-bezier(.34,1.56,.64,1),background .3s,box-shadow .3s;}
        .add-btn:hover{transform:scale(1.12) rotate(8deg);}
        .ot-num{animation:otPulse 2.5s ease-in-out infinite;}
        .ot-strip{animation:stripSlide .4s ease;}
        .end-btn-ot{transition:all .2s ease;}
        .end-btn-ot:hover{transform:scale(1.04);background:rgba(212,168,67,0.25)!important;}
      `}</style>

      {/* HEADER */}
      <header style={{position:"relative",zIndex:10,display:"flex",alignItems:"center",justifyContent:"space-between",padding:"20px 28px",borderBottom:"1px solid rgba(255,255,255,0.05)"}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div style={{width:8,height:8,borderRadius:"50%",background:dispColor,boxShadow:`0 0 12px ${dispColor}`,transition:"background .8s,box-shadow .8s",animation:isRunning?"pulse 2s infinite":"none"}}/>
          <span style={{fontWeight:600,fontSize:15,letterSpacing:".06em",color:"#bbb"}}>ZENFLOW</span>
          {syncing&&<span style={{fontSize:10,color:"#6B9E78",letterSpacing:".06em",opacity:.7}}>syncing…</span>}
        </div>

        {user ? (
          /* ── SIGNED IN: show avatar + name + sign-out ── */
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <div style={{textAlign:"right"}}>
              <div style={{fontSize:12.5,color:"#888",fontWeight:500}}>{user.displayName}</div>
              <div style={{fontSize:10,color:"#383838"}}>{user.email}</div>
            </div>
            <div style={{position:"relative"}}>
              <img
                src={user.photoURL}
                alt={user.displayName}
                style={{width:34,height:34,borderRadius:"50%",border:`2px solid ${dispColor}`,objectFit:"cover",transition:"border-color .8s",cursor:"pointer"}}
                title="Click to sign out"
                onClick={handleSignOut}
              />
              <div style={{position:"absolute",bottom:-1,right:-1,width:10,height:10,borderRadius:"50%",background:"#6B9E78",border:"2px solid #0E0E10"}}/>
            </div>
          </div>
        ) : (
          /* ── SIGNED OUT: sign-in button ── */
          <button className="btn-spring" onClick={()=>setShowAuth(true)} style={{background:"rgba(255,255,255,0.055)",border:"1px solid rgba(255,255,255,0.09)",color:"#999",borderRadius:8,padding:"7px 14px",fontSize:12.5,cursor:"pointer",fontFamily:"inherit"}}>
            Sign in with Google
          </button>
        )}
      </header>

      <main style={{position:"relative",zIndex:1,maxWidth:540,margin:"0 auto",padding:"32px 20px 80px",animation:"fadeIn .55s ease"}}>

        {/* Mode tabs */}
        <div style={{display:"flex",gap:5,background:"rgba(255,255,255,0.03)",borderRadius:12,padding:4,marginBottom:36,border:"1px solid rgba(255,255,255,0.06)"}}>
          {Object.entries(MODES).map(([key,m])=>(
            <button key={key} className="mode-btn" onClick={()=>switchMode(key)} style={{flex:1,padding:"9px 0",border:"none",cursor:"pointer",borderRadius:9,fontSize:12.5,fontWeight:500,fontFamily:"inherit",letterSpacing:".03em",background:mode===key?(isOvertime&&key==="focus"?OVERTIME_COLOR:m.color):"transparent",color:mode===key?"#fff":"#555",boxShadow:mode===key?`0 2px 18px ${isOvertime&&key==="focus"?OVERTIME_GLOW:m.glow}`:"none"}}>{m.label}</button>
          ))}
        </div>

        {/* Active task chip */}
        <div style={{textAlign:"center",marginBottom:12,minHeight:28}}>
          {activeTask?(
            <div style={{display:"inline-flex",alignItems:"center",gap:7,background:"rgba(255,255,255,0.05)",border:"1px solid rgba(255,255,255,0.09)",borderRadius:20,padding:"5px 14px",fontSize:12.5,color:"#aaa",animation:"scaleIn .25s ease"}}>
              <div style={{width:6,height:6,borderRadius:"50%",background:dispColor,animation:isRunning?"pulse 1.5s infinite":"none",transition:"background .8s"}}/>
              {activeParent&&<span style={{color:"#555",fontSize:11}}>{activeParent.name} /</span>}
              {activeTask.name}
              {isRunning&&liveSession>0&&<span style={{color:dispColor,fontFamily:"'DM Mono',monospace",fontSize:11,transition:"color .8s"}}>+{fmtDur(liveSession)}</span>}
            </div>
          ):(
            <span style={{fontSize:12,color:"#272727"}}>No active task — add one below</span>
          )}
        </div>

        {/* TIMER RING */}
        <div style={{display:"flex",justifyContent:"center",marginBottom:28,position:"relative"}}>
          <div style={{position:"relative",width:280,height:280}}>
            <svg width={280} height={280} style={{transform:"rotate(-90deg)"}}>
              <circle cx={140} cy={140} r={R} fill="none" stroke="rgba(255,255,255,0.042)" strokeWidth={6}/>
              <circle cx={140} cy={140} r={R} fill="none"
                stroke={dispColor} strokeWidth={isOvertime?7:6} strokeLinecap="round"
                strokeDasharray={CIRC} strokeDashoffset={dashOff}
                className={`ring-tr ${isOvertime&&isRunning?"ring-ot":"ring-normal"}`}
                style={{color:dispColor,transition:"stroke 1.2s ease,stroke-width .4s ease"}}
              />
            </svg>
            <div style={{position:"absolute",inset:0,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:6}}>
              {!isOvertime&&(
                <button className="btn-spring" onClick={()=>setPicker(p=>!p)} style={{background:"transparent",border:"none",cursor:"pointer",fontSize:11,color:"#3e3e3e",letterSpacing:".09em",fontFamily:"inherit",display:"flex",alignItems:"center",gap:4}}>
                  {selMins} MIN <span style={{transform:showPicker?"rotate(180deg)":"rotate(0)",transition:"transform .25s",display:"inline-block",fontSize:9}}>▼</span>
                </button>
              )}
              {isOvertime&&<div style={{fontSize:10,color:"#4a4a4a",letterSpacing:".07em",fontFamily:"'DM Mono',monospace"}}>goal {fmtDur(duration)} ✓</div>}
              <div className={isOvertime&&isRunning?"ot-num":""} style={{fontFamily:"'DM Mono',monospace",fontSize:isOvertime?54:62,fontWeight:300,letterSpacing:"-.02em",lineHeight:1,color:dispColor,textShadow:isRunning?`0 0 40px ${dispGlow}`:"none",transition:"color .6s,font-size .3s,text-shadow .5s"}}>
                {isOvertime?`+${fmtClock(overtimeSecs)}`:fmtClock(timeLeft)}
              </div>
              <div style={{display:"flex",alignItems:"center",gap:6,marginTop:2}}>
                {isOvertime&&isRunning?(
                  <div style={{background:`${OVERTIME_COLOR}22`,border:`1px solid ${OVERTIME_COLOR}44`,borderRadius:20,padding:"3px 11px",fontSize:10.5,fontWeight:500,color:OVERTIME_COLOR,letterSpacing:".07em",animation:"otPulse 2.5s ease-in-out infinite"}}>OVERTIME</div>
                ):(
                  <div style={{fontSize:10.5,color:"#282828",letterSpacing:".12em"}}>{isRunning?cfg.label.toUpperCase():timeLeft===duration?"READY":"PAUSED"}</div>
                )}
              </div>
            </div>
            {showPicker&&!isOvertime&&(
              <div style={{position:"absolute",left:"50%",top:"calc(100% + 12px)",transform:"translateX(-50%)",background:"#18181C",border:"1px solid rgba(255,255,255,0.1)",borderRadius:13,padding:14,zIndex:50,boxShadow:"0 24px 64px rgba(0,0,0,0.75)",animation:"slideDown .2s ease",minWidth:172}}>
                <div style={{fontSize:9.5,color:"#3a3a3a",letterSpacing:".12em",marginBottom:9}}>DURATION</div>
                <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
                  {MODES[mode].presets.map(m=>(
                    <button key={m} className="btn-spring preset-item" onClick={()=>selectDur(m)} style={{background:selMins===m?cfg.color:"rgba(255,255,255,0.07)",border:"none",borderRadius:7,padding:"7px 12px",color:selMins===m?"#fff":"#999",fontSize:13,fontWeight:500,cursor:"pointer",fontFamily:"inherit"}}>{m}m</button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* CONTROLS */}
        <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:12,marginBottom:isOvertime&&isRunning?16:44}}>
          <button className="btn-spring" onClick={resetTimer} title="Reset" style={{width:44,height:44,borderRadius:"50%",background:"rgba(255,255,255,0.05)",border:"1px solid rgba(255,255,255,0.08)",color:"#666",cursor:"pointer",fontSize:18,display:"flex",alignItems:"center",justifyContent:"center"}}>↺</button>
          <button className="btn-spring" onClick={toggleTimer} style={{width:72,height:72,borderRadius:"50%",background:dispColor,border:"none",color:"#fff",cursor:"pointer",fontSize:23,display:"flex",alignItems:"center",justifyContent:"center",boxShadow:`0 4px 32px ${dispGlow}`,transition:"background .8s,box-shadow .8s"}}>
            {isRunning?"⏸":"▶"}
          </button>
          {mode==="focus"?(
            <button className="end-btn-ot" onClick={endSession} title="End session" style={{height:44,borderRadius:22,padding:"0 16px",background:isOvertime?`${OVERTIME_COLOR}18`:"rgba(255,255,255,0.05)",border:`1px solid ${isOvertime?OVERTIME_COLOR+"55":"rgba(255,255,255,0.08)"}`,color:isOvertime?OVERTIME_COLOR:"#666",cursor:"pointer",fontSize:12,fontFamily:"inherit",display:"flex",alignItems:"center",gap:6,fontWeight:isOvertime?500:400,letterSpacing:".03em"}}>
              <span style={{fontSize:13}}>◼</span>End
            </button>
          ):(
            <button className="btn-spring" onClick={()=>{ const m=["focus","shortBreak","longBreak"]; switchMode(m[(m.indexOf(mode)+1)%3]); }} style={{width:44,height:44,borderRadius:"50%",background:"rgba(255,255,255,0.05)",border:"1px solid rgba(255,255,255,0.08)",color:"#666",cursor:"pointer",fontSize:15,display:"flex",alignItems:"center",justifyContent:"center"}}>⏭</button>
          )}
        </div>

        {/* OVERTIME STRIP */}
        {isOvertime&&isRunning&&(
          <div className="ot-strip" style={{marginBottom:32,background:`linear-gradient(135deg,${OVERTIME_COLOR}0d,${OVERTIME_COLOR}06)`,border:`1px solid ${OVERTIME_COLOR}2e`,borderRadius:12,padding:"11px 18px",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
            <div style={{display:"flex",alignItems:"center",gap:10}}>
              <span style={{fontSize:18}}>🔥</span>
              <div>
                <div style={{fontSize:12.5,color:OVERTIME_COLOR,fontWeight:500}}>In the zone — keep going</div>
                <div style={{fontSize:10.5,color:"#4e4e4e",marginTop:2,fontFamily:"'DM Mono',monospace"}}>
                  <span style={{color:"#6B9E78"}}>{fmtDur(duration)}</span>
                  <span style={{color:"#3a3a3a"}}> goal + </span>
                  <span style={{color:OVERTIME_COLOR}}>{fmtDur(overtimeSecs)}</span>
                  <span style={{color:"#3a3a3a"}}> overtime</span>
                </div>
              </div>
            </div>
            <button className="end-btn-ot" onClick={endSession} style={{background:`${OVERTIME_COLOR}22`,border:`1px solid ${OVERTIME_COLOR}55`,borderRadius:9,padding:"7px 14px",color:OVERTIME_COLOR,fontSize:12,fontWeight:500,cursor:"pointer",fontFamily:"inherit",letterSpacing:".04em",flexShrink:0}}>End Session</button>
          </div>
        )}

        {/* TASKS */}
        <section style={{background:"rgba(255,255,255,0.025)",border:"1px solid rgba(255,255,255,0.06)",borderRadius:16,overflow:"hidden",marginBottom:14}}>
          <div style={{padding:"16px 18px 12px"}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
              <div style={{fontSize:11,color:"#404040",letterSpacing:".1em"}}>TASKS & CATEGORIES</div>
              <div style={{display:"flex",background:"rgba(255,255,255,0.04)",borderRadius:7,padding:2,gap:2,border:"1px solid rgba(255,255,255,0.06)"}}>
                {["task","category"].map(m=>(
                  <button key={m} onClick={()=>setAddMode(m)} style={{background:addMode===m?"rgba(255,255,255,0.08)":"transparent",border:"none",borderRadius:5,padding:"3px 9px",fontSize:10.5,color:addMode===m?"#ccc":"#444",cursor:"pointer",fontFamily:"inherit",transition:"all .2s",letterSpacing:".04em"}}>
                    {m==="task"?"Sub-task":"Category"}
                  </button>
                ))}
              </div>
            </div>
            <form onSubmit={handleAdd} style={{display:"flex",gap:8}}>
              <input ref={inputRef} value={newTask} onChange={e=>setNewTask(e.target.value)} onFocus={()=>setIFocus(true)} onBlur={()=>setIFocus(false)} onKeyDown={e=>{if(e.key==="Enter"){e.preventDefault();handleAdd(e);}}}
                placeholder={addMode==="category"?"New category…":"New sub-task under active category…"}
                style={{flex:1,background:"rgba(255,255,255,0.05)",border:`1px solid ${iFocus?dispColor+"88":"rgba(255,255,255,0.07)"}`,borderRadius:9,padding:"9px 13px",color:"#ddd",fontSize:13.5,fontFamily:"inherit",outline:"none",boxShadow:iFocus?`0 0 0 3px ${dispColor}18`:"none",transition:"border-color .3s,box-shadow .3s"}}/>
              <button type="submit" className="add-btn" style={{background:dispColor,border:"none",borderRadius:9,width:40,color:"#fff",fontSize:20,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:iFocus?`0 0 18px ${dispGlow}`:"none",transition:"background .3s,box-shadow .3s"}}>+</button>
            </form>
            {tasks.length>1&&<div style={{fontSize:10.5,color:"#2e2e2e",marginTop:8}}>↕ Drag to nest · ⇤ to un-nest</div>}
          </div>
          {tasks.length>0?(
            <div style={{borderTop:"1px solid rgba(255,255,255,0.04)"}}>
              <TaskList tasks={tasks} taskStats={taskStats} activeTaskId={activeTaskId} setActiveTaskId={setATId} setTasks={setTasks} isRunning={isRunning} liveSession={liveSession} mode={mode} accentColor={dispColor} accentGlow={dispGlow}/>
            </div>
          ):(
            <div style={{padding:"14px 18px",textAlign:"center",color:"#282828",fontSize:13}}>Add a category, then add sub-tasks inside it</div>
          )}
        </section>

        {/* ANALYTICS */}
        <section style={{background:"rgba(255,255,255,0.025)",border:"1px solid rgba(255,255,255,0.06)",borderRadius:16,overflow:"hidden"}}>
          <button onClick={()=>setShowAn(p=>!p)} style={{width:"100%",background:"none",border:"none",padding:"15px 18px",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"space-between",color:"#555",fontFamily:"inherit"}}>
            <span style={{fontSize:11,letterSpacing:".1em"}}>ANALYTICS</span>
            <span style={{transform:showAn?"rotate(180deg)":"rotate(0)",transition:"transform .3s",fontSize:11}}>▼</span>
          </button>
          {showAn&&(
            <div className="analytics-slide" style={{borderTop:"1px solid rgba(255,255,255,0.04)"}}>
              <div style={{display:"flex",padding:"10px 14px 0",gap:2,borderBottom:"1px solid rgba(255,255,255,0.04)"}}>
                {[{id:"overview",label:"Overview"},{id:"deepdive",label:"Deep Dive"},{id:"history",label:"History"}].map(tab=>(
                  <button key={tab.id} onClick={()=>setATab(tab.id)} style={{background:"none",border:"none",cursor:"pointer",fontFamily:"inherit",padding:"7px 14px",fontSize:12,color:aTab===tab.id?"#ddd":"#3e3e3e",fontWeight:aTab===tab.id?500:400,borderBottom:aTab===tab.id?`2px solid ${dispColor}`:"2px solid transparent",transition:"all .25s",marginBottom:-1}}>{tab.label}</button>
                ))}
              </div>
              <div style={{padding:"18px 18px 22px"}}>
                {aTab==="overview"&&(
                  <div className="tab-content">
                    <div style={{display:"flex",alignItems:"center",gap:14,marginBottom:16,background:streak>0?"rgba(107,158,120,0.07)":"rgba(255,255,255,0.02)",border:`1px solid ${streak>0?"rgba(107,158,120,0.2)":"rgba(255,255,255,0.05)"}`,borderRadius:13,padding:"14px 18px"}}>
                      <span style={{fontSize:28,lineHeight:1}}>{streak>0?"🔥":"❄️"}</span>
                      <div style={{flex:1}}>
                        <div style={{fontFamily:"'DM Mono',monospace",fontSize:28,fontWeight:300,color:streak>0?"#6B9E78":"#242424",lineHeight:1}}>{streak} Day{streak!==1?"s":""}</div>
                        <div style={{fontSize:10.5,color:"#404040",marginTop:3}}>{streak>0?"current streak — keep it up!":"complete a 25m session to start your streak"}</div>
                      </div>
                      {streak>=7&&<div style={{fontSize:11,color:"#6B9E78",background:"rgba(107,158,120,0.1)",borderRadius:6,padding:"3px 8px"}}>🏆 Week</div>}
                    </div>
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
                      {[{label:"Today",s:todayS},{label:"This Week",s:weekS},{label:"All Time",s:allS}].map(({label,s})=>(
                        <div key={label} style={{background:"rgba(255,255,255,0.03)",border:"1px solid rgba(255,255,255,0.055)",borderRadius:12,padding:"13px 14px"}}>
                          <div style={{fontSize:9.5,color:"#333",letterSpacing:".08em",marginBottom:5}}>{label.toUpperCase()}</div>
                          <div style={{fontFamily:"'DM Mono',monospace",fontSize:21,fontWeight:400,color:s>0?dispColor:"#1e1e1e",transition:"color .8s"}}>{s>0?fmtHours(s):"—"}</div>
                          {s>0&&<div style={{fontSize:9,color:"#333",marginTop:3}}>{fmtDur(s)}</div>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {aTab==="deepdive"&&(
                  <div className="tab-content">
                    <DeepDive tasks={tasks} taskStats={taskStats} activeTaskId={activeTaskId} isRunning={isRunning} liveSession={liveSession} mode={mode} accentColor={dispColor}/>
                  </div>
                )}
                {aTab==="history"&&(
                  <div className="tab-content">
                    <CalendarGrid dailyStats={dailyStats} color={dispColor}/>
                    <div style={{borderTop:"1px solid rgba(255,255,255,0.04)",margin:"20px 0 16px"}}/>
                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:13}}>
                      <div style={{fontSize:11,color:"#383838",letterSpacing:".09em"}}>TODAY'S SESSIONS</div>
                      {sessions.length>0&&<button className="btn-spring" onClick={()=>exportCSV(sessions,tasks)} style={{background:"rgba(255,255,255,0.05)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:7,padding:"4px 11px",color:"#666",fontSize:11,cursor:"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",gap:5}}>↓ Export CSV</button>}
                    </div>
                    {todaySes.length===0?(
                      <div style={{textAlign:"center",color:"#262626",fontSize:13,padding:"16px 0"}}>No sessions logged today yet.</div>
                    ):(
                      <div style={{display:"flex",flexDirection:"column",gap:6}}>
                        {todaySes.map(s=>{
                          const task=tasks.find(t=>t.id===s.taskId), parent=task?.parentId?tasks.find(t=>t.id===task.parentId):null;
                          const hasOT=(s.overtimeSeconds||0)>0;
                          return(
                            <div key={s.id} style={{background:"rgba(255,255,255,0.022)",border:`1px solid ${hasOT?OVERTIME_COLOR+"22":"rgba(255,255,255,0.045)"}`,borderRadius:9,padding:"9px 13px"}}>
                              <div style={{display:"flex",alignItems:"center",gap:10}}>
                                <span style={{fontFamily:"'DM Mono',monospace",fontSize:11,color:"#444",flexShrink:0,minWidth:46}}>{fmtWall(s.startedAt)}</span>
                                <div style={{width:1,height:15,background:"rgba(255,255,255,0.06)",flexShrink:0}}/>
                                <div style={{flex:1,overflow:"hidden"}}>
                                  {parent&&<div style={{fontSize:9.5,color:"#444",marginBottom:1}}>{parent.name}</div>}
                                  <span style={{fontSize:13,color:"#888",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",display:"block"}}>{taskMap[s.taskId]||"Untitled"}</span>
                                </div>
                                <div style={{display:"flex",alignItems:"center",gap:5,flexShrink:0}}>
                                  <span style={{fontFamily:"'DM Mono',monospace",fontSize:11,color:"#6B9E78",background:"#6B9E7818",borderRadius:5,padding:"2px 7px"}}>{fmtDur(s.goalSeconds||s.durationSeconds)}</span>
                                  {hasOT&&<span style={{fontFamily:"'DM Mono',monospace",fontSize:11,color:OVERTIME_COLOR,background:OVERTIME_COLOR+"18",borderRadius:5,padding:"2px 7px"}}>+{fmtDur(s.overtimeSeconds)}</span>}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </section>
      </main>

      {/* SUMMARY MODAL */}
      <SummaryModal summary={summary} accentColor={cfg.color} accentGlow={cfg.glow} onClose={()=>{ setSummary(null); setTimeLeft(duration); }}/>

      {/* AUTH MODAL */}
      {showAuth&&(
        <div style={{position:"fixed",inset:0,zIndex:100,background:"rgba(0,0,0,0.78)",backdropFilter:"blur(10px)",display:"flex",alignItems:"center",justifyContent:"center"}} onClick={()=>setShowAuth(false)}>
          <div style={{background:"#16161A",border:"1px solid rgba(255,255,255,0.09)",borderRadius:20,padding:34,width:340,animation:"scaleIn .25s ease",boxShadow:"0 40px 100px rgba(0,0,0,0.85)"}} onClick={e=>e.stopPropagation()}>
            <div style={{textAlign:"center",marginBottom:26}}>
              <div style={{width:10,height:10,borderRadius:"50%",background:dispColor,margin:"0 auto 16px",boxShadow:`0 0 24px ${dispColor}`}}/>
              <h2 style={{fontSize:20,fontWeight:600,marginBottom:9,color:"#e0e0e0"}}>Sign in to Zenflow</h2>
              <p style={{fontSize:13,color:"#444",lineHeight:1.65}}>Sync your sessions, streaks & stats across all devices.</p>
            </div>
            <button className="btn-spring" onClick={handleSignIn} style={{width:"100%",padding:"13px 0",background:"#fff",color:"#111",border:"none",borderRadius:12,fontSize:14,fontWeight:600,cursor:"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",justifyContent:"center",gap:10}}>
              <svg width={18} height={18} viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
              Continue with Google
            </button>
            <p style={{fontSize:11,color:"#2a2a2a",textAlign:"center",marginTop:16}}>Your data is encrypted and never shared.</p>
          </div>
        </div>
      )}
    </div>
  );
}
