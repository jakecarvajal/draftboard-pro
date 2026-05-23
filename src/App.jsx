import { useState, useMemo, useCallback, useEffect, useRef, useReducer } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// CLERK AUTH — imported conditionally so the app still works without Clerk
// ─────────────────────────────────────────────────────────────────────────────
let useUser, SignIn, UserButton;
try {
  ({ useUser, SignIn, UserButton } = await import("@clerk/clerk-react"));
} catch {
  useUser = () => ({ isSignedIn: true, user: { id: "local" } });
  SignIn = () => null;
  UserButton = () => null;
}

// ─────────────────────────────────────────────────────────────────────────────
// LIVE DATA — fetched from Google Sheets via SheetDB
// ─────────────────────────────────────────────────────────────────────────────
// STEP: Replace the URL below with your actual SheetDB endpoint
// Example: "https://sheetdb.io/api/v1/abc123def456"
const SHEETDB_URL = "https://sheetdb.io/api/v1/REPLACE_WITH_YOUR_ID";

function parsePlayer(row) {
  const bool = (v) => v === "TRUE" || v === "true" || v === "1";
  const num  = (v) => v === "" || v == null ? null : Number(v);
  const str  = (v) => v === "" || v == null ? null : String(v);
  return {
    id:        Number(row.id),
    name:      row.name,
    pos:       row.pos,
    school:    row.school,
    conf:      row.conf,
    year:      Number(row.year),
    age:       Number(row.age),
    ht:        row.ht,
    wt:        Number(row.wt),
    bats:      row.bats,
    throws:    row.throws,
    hometown:  row.hometown,
    isPitcher: bool(row.isPitcher),
    juco: bool(row.isPitcher) ? null : {
      avg:     num(row.juco_avg),   obp:     num(row.juco_obp),
      slg:     num(row.juco_slg),   ops:     num(row.juco_ops),
      iso:     num(row.juco_iso),   bbPct:   num(row.juco_bbPct),
      kPct:    num(row.juco_kPct),  sb:      num(row.juco_sb),
      cs:      num(row.juco_cs),    pa:      num(row.juco_pa),
      hr:      num(row.juco_hr),    rbi:     num(row.juco_rbi),
      doubles: num(row.juco_doubles), triples: num(row.juco_triples),
    },
    jucoP: !bool(row.isPitcher) ? null : {
      era:  num(row.jucoP_era),  whip: num(row.jucoP_whip),
      k9:   num(row.jucoP_k9),  bb9:  num(row.jucoP_bb9),
      fip:  num(row.jucoP_fip), ip:   num(row.jucoP_ip),
      velo: num(row.jucoP_velo), gs:  num(row.jucoP_gs),
      sv:   num(row.jucoP_sv),
    },
    proj: {
      ops:   num(row.proj_ops),   obp:   num(row.proj_obp),
      slg:   num(row.proj_slg),   floor: num(row.proj_floor),
      ceil:  num(row.proj_ceil),  era:   num(row.proj_era),
      fip:   num(row.proj_fip),   k9:    num(row.proj_k9),
      bb9:   num(row.proj_bb9),
    },
    probs: {
      d1PA:       num(row.probs_d1PA),
      d1IP:       num(row.probs_d1IP),
      avgStarter: num(row.probs_avgStarter),
      retained:   num(row.probs_retained),
      pro:        num(row.probs_pro),
    },
    gemScore:  Number(row.gemScore),
    riskScore: Number(row.riskScore),
    surplus:   Number(row.surplus),
    trend:     row.trend,
    confAdj:   Number(row.confAdj),
    status:    row.status,
    dest:      str(row.dest),
    flag:      str(row.flag),
    notes:     row.notes,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CONFERENCE METADATA
// ─────────────────────────────────────────────────────────────────────────────
const CONF_DATA = {
  "ACCAC":     {rating:0.90,transfers:142,d1Rate:68,history:[0.86,0.87,0.88,0.89,0.90],opsMult:0.880,eraMult:1.144,alumni:["Easton Rulli → NM State","Devon Parks → transferring","Marcus Hill → Arizona"]},
  "NJCAA R14": {rating:0.88,transfers:118,d1Rate:64,history:[0.84,0.85,0.86,0.87,0.88],opsMult:0.861,eraMult:1.168,alumni:["Darius Webb → available","Cole Ramsey → available","Malik Johnson → UTSA"]},
  "GCAC":      {rating:0.84,transfers:97, d1Rate:59,history:[0.80,0.81,0.82,0.83,0.84],opsMult:0.822,eraMult:1.221,alumni:["Marco Delgado → available","Jordan Patel → available","Elijah Brooks → FIU"]},
  "MCCAA":     {rating:0.79,transfers:63, d1Rate:51,history:[0.75,0.76,0.77,0.78,0.79],opsMult:0.772,eraMult:1.299,alumni:["Tyler Bosh → available","Derek Novak → available","Cody Farmer → available"]},
  "NJCAA R1":  {rating:0.81,transfers:88, d1Rate:55,history:[0.77,0.78,0.79,0.80,0.81],opsMult:0.792,eraMult:1.266,alumni:["Griffin Walsh → available","Ryan Kowalski → available","Patrick Doyle → available"]},
};

const ALERTS = [
  {id:"a1",type:"Portal Entry",time:"2h ago",title:"Darius Webb entered transfer portal",body:"CF/San Jacinto · Gem Score 86 · HOT TARGET.",playerId:1,read:false},
  {id:"a2",type:"Commitment",time:"5h ago",title:"Easton Rulli committed to NM State (C-USA)",body:"Projection validated: .812 proj OPS.",playerId:2,read:false},
  {id:"a3",type:"Portal Entry",time:"11h ago",title:"Marco Delgado entered portal",body:"SP/Gulf Coast State · Gem Score 81 · HOT ARM.",playerId:3,read:true},
  {id:"a4",type:"Stat Update",time:"1d ago",title:"Cole Ramsey stats updated — 2 additional IP",body:"ERA moved from 2.52 to 2.44.",playerId:16,read:true},
  {id:"a5",type:"Model Update",time:"1d ago",title:"ACCAC conference strength coefficient updated",body:"0.89 → 0.90 after post-season recalculation.",playerId:null,read:true},
  {id:"a6",type:"Portal Entry",time:"2d ago",title:"Cole Ramsey entered portal",body:"SP/Blinn College · Gem Score 80 · HOT.",playerId:16,read:true},
  {id:"a7",type:"Commitment",time:"3d ago",title:"Malik Johnson committed to UTSA",body:"CF/Hill College · Gem Score 75.",playerId:17,read:true},
  {id:"a8",type:"System",time:"4d ago",title:"Weekly model refresh complete",body:"52 player projections updated.",playerId:null,read:true},
];

// ─────────────────────────────────────────────────────────────────────────────
// HOOKS
// ─────────────────────────────────────────────────────────────────────────────
function useLocalStorage(key, initial) {
  const [val, setVal] = useState(() => {
    try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : initial; }
    catch { return initial; }
  });
  const set = useCallback((v) => {
    const next = typeof v === "function" ? v(val) : v;
    setVal(next);
    try { localStorage.setItem(key, JSON.stringify(next)); } catch {}
  }, [key, val]);
  return [val, set];
}

function useFocusTrap(ref, active) {
  useEffect(() => {
    if (!active || !ref.current) return;
    const el = ref.current;
    const focusable = el.querySelectorAll('button,input,textarea,select,[tabindex]:not([tabindex="-1"])');
    const first = focusable[0], last = focusable[focusable.length - 1];
    const prev = document.activeElement;
    if (first) first.focus();
    const onKey = (e) => {
      if (e.key !== "Tab") return;
      if (e.shiftKey) { if (document.activeElement === first) { e.preventDefault(); last?.focus(); } }
      else { if (document.activeElement === last) { e.preventDefault(); first?.focus(); } }
    };
    el.addEventListener("keydown", onKey);
    return () => { el.removeEventListener("keydown", onKey); if (prev) prev.focus(); };
  }, [active, ref]);
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
const fmt3 = (n) => n == null ? "—" : Number(n).toFixed(3);
const fmt2 = (n) => n == null ? "—" : Number(n).toFixed(2);
const fmtK = (n) => n == null ? "—" : `$${(Number(n)/1000).toFixed(1)}k`;
const gemColor  = (s) => s >= 80 ? "#4ade80" : s >= 65 ? "#f6ad55" : s >= 45 ? "#94a3b8" : "#f87171";
const riskColor = (s) => s <= 30 ? "#4ade80" : s <= 45 ? "#fbbf24" : "#f87171";
const riskLabel = (s) => s <= 30 ? "LOW" : s <= 45 ? "MED" : "HIGH";
const flagColors   = {"HOT":["rgba(239,68,68,.15)","#fc8181"],"RISING":["rgba(34,197,94,.12)","#4ade80"],"WATCH":["rgba(251,191,36,.12)","#fbbf24"]};
const statusColors = {"available":["rgba(148,163,184,.08)","#94a3b8"],"committed":["rgba(74,222,128,.1)","#4ade80"],"signed":["rgba(147,197,253,.1)","#93c5fd"],"drafted":["rgba(167,139,250,.1)","#a78bfa"]};
const initials = (n) => n.split(" ").map(w=>w[0]).join("").toUpperCase().slice(0,2);
const getMainStat  = (p) => p.isPitcher ? (p.jucoP?.era ?? null) : (p.juco?.ops ?? null);
const getProjStat  = (p) => p.isPitcher ? (p.proj?.era ?? null) : (p.proj?.ops ?? null);
const getStatLabel = (p) => p.isPitcher ? "ERA" : "OPS";

function filterPlayers(players, filters) {
  return players.filter(p => {
    if (filters.search) { const q = filters.search.toLowerCase(); if (!p.name.toLowerCase().includes(q) && !p.school.toLowerCase().includes(q) && !p.pos.toLowerCase().includes(q)) return false; }
    if (filters.positions.length && !filters.positions.includes(p.pos)) return false;
    if (filters.conferences.length && !filters.conferences.includes(p.conf)) return false;
    if (filters.statuses.length && !filters.statuses.includes(p.status)) return false;
    if (filters.years.length && !filters.years.includes(p.year)) return false;
    if (filters.flags.length && !filters.flags.includes(p.flag)) return false;
    if (p.gemScore < filters.gemRange[0] || p.gemScore > filters.gemRange[1]) return false;
    if (p.riskScore < filters.riskRange[0] || p.riskScore > filters.riskRange[1]) return false;
    if (p.age < filters.ageRange[0] || p.age > filters.ageRange[1]) return false;
    return true;
  });
}

function sortPlayers(players, sort) {
  return [...players].sort((a, b) => {
    const col = sort.primary.col, dir = sort.primary.dir === "desc" ? -1 : 1;
    const va = col === "stat" ? (getMainStat(a) ?? -99) : (a[col] ?? -99);
    const vb = col === "stat" ? (getMainStat(b) ?? -99) : (b[col] ?? -99);
    return (va - vb) * dir;
  });
}

const INIT_FILTERS = {search:"",positions:[],conferences:[],statuses:["available","committed"],years:[2025,2024],gemRange:[0,100],riskRange:[0,100],ageRange:[19,22],flags:[]};
const INIT_SORT    = {primary:{col:"gemScore",dir:"desc"},secondary:null};

const S = {
  card:    {background:"rgba(255,255,255,.03)",border:"1px solid rgba(255,255,255,.06)",borderRadius:10,padding:"14px 16px"},
  label:   {fontSize:10,fontWeight:600,letterSpacing:".08em",color:"#4a5568",textTransform:"uppercase",marginBottom:6},
  mono:    {fontFamily:"'DM Mono',monospace"},
  divider: {height:1,background:"rgba(255,255,255,.05)",margin:"14px 0"},
};

// ─────────────────────────────────────────────────────────────────────────────
// UI PRIMITIVES
// ─────────────────────────────────────────────────────────────────────────────
function ProbBar({label,value,color="#4ade80"}) {
  return (
    <div style={{marginBottom:10}}>
      <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
        <span style={{fontSize:12,color:"#94a3b8"}}>{label}</span>
        <span style={{...S.mono,fontSize:12,fontWeight:500,color}}>{value}%</span>
      </div>
      <div role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100} aria-label={`${label}: ${value}%`}
        style={{height:4,background:"rgba(255,255,255,.08)",borderRadius:2,overflow:"hidden"}}>
        <div style={{width:`${value}%`,height:"100%",background:color,opacity:.75,borderRadius:2}} />
      </div>
    </div>
  );
}

function ShapBar({label,value,max=0.06}) {
  const pct = Math.min(Math.abs(value)/max*50,50), pos = value >= 0;
  const color = pos ? "#22c55e" : "#f87171", prefix = pos ? "+" : "−";
  return (
    <div style={{display:"flex",alignItems:"center",gap:10,padding:"5px 0",borderBottom:"1px solid rgba(255,255,255,.04)"}}>
      <span style={{fontSize:12,color:"#94a3b8",flex:1}}>{label}</span>
      <div style={{width:120,height:4,background:"rgba(255,255,255,.08)",borderRadius:2,position:"relative"}}>
        <div style={{position:"absolute",top:0,height:4,borderRadius:2,background:color,...(pos?{left:"50%",width:`${pct}%`}:{right:"50%",width:`${pct}%`})}} />
        <div style={{position:"absolute",top:-5,left:"50%",width:1,height:14,background:"rgba(255,255,255,.15)"}} />
      </div>
      <span style={{...S.mono,fontSize:12,fontWeight:500,color,minWidth:48,textAlign:"right"}}>{prefix}{Math.abs(value).toFixed(3)}</span>
    </div>
  );
}

function Avatar({name,size=36}) {
  const colors = ["#3C3489","#085041","#712B13","#0C447C","#633806"];
  const idx = name.charCodeAt(0) % colors.length;
  return (
    <div aria-hidden="true" style={{width:size,height:size,borderRadius:"50%",background:`${colors[idx]}33`,border:`1px solid ${colors[idx]}55`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:size*0.35,fontWeight:600,color:`${colors[idx]}cc`,flexShrink:0,fontFamily:"'DM Mono',monospace"}}>
      {initials(name)}
    </div>
  );
}

function Badge({text,type}) {
  const [bg,col] = type === "flag" ? (flagColors[text]||["rgba(255,255,255,.08)","#94a3b8"]) : type === "status" ? (statusColors[text]||["rgba(255,255,255,.08)","#94a3b8"]) : ["rgba(255,255,255,.08)","#94a3b8"];
  return <span style={{display:"inline-block",fontSize:10,fontWeight:600,letterSpacing:".06em",padding:"2px 8px",borderRadius:3,background:bg,color:col,textTransform:"uppercase"}}>{text}</span>;
}

function Sparkline({p}) {
  const v1 = p.isPitcher ? (p.jucoP?.era??4) : (p.juco?.ops??.700);
  const v2 = v1*(p.isPitcher?.97:1.03), v3 = p.isPitcher?(p.proj?.era??3.5):(p.proj?.ops??.780);
  const pts=[v1,v2,v3], mn=Math.min(...pts)-.02, mx=Math.max(...pts)+.02;
  const toY=v=>20-((v-mn)/(mx-mn))*18, path=pts.map((v,i)=>`${i===0?"M":"L"}${i*24+4},${toY(v)}`).join(" ");
  const trend=p.isPitcher?(v3<v1):(v3>v1);
  return <svg width="52" height="20" aria-hidden="true" style={{display:"block"}}>
    <path d={path} fill="none" stroke={trend?"#22c55e":"#f87171"} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    {pts.map((v,i)=><circle key={i} cx={i*24+4} cy={toY(v)} r="2" fill={i===2?"#f6ad55":trend?"#22c55e":"#f87171"}/>)}
  </svg>;
}

// ─────────────────────────────────────────────────────────────────────────────
// FILTER SIDEBAR
// ─────────────────────────────────────────────────────────────────────────────
function FilterSidebar({filters,onFilter,onReset}) {
  const positions=["SP","RP","C","1B","2B","3B","SS","LF","CF","RF","DH"], confs=Object.keys(CONF_DATA);
  const toggle=(key,val)=>{const curr=filters[key];onFilter(key,curr.includes(val)?curr.filter(x=>x!==val):[...curr,val]);};
  const activeCount=[filters.positions.length,filters.conferences.length<5?1:0,filters.statuses.length<4?1:0,filters.years.length<3?1:0,filters.flags.length,filters.gemRange[0]>0||filters.gemRange[1]<100?1:0,filters.riskRange[0]>0||filters.riskRange[1]<100?1:0].reduce((a,b)=>a+b,0);
  return (
    <div style={{width:220,flexShrink:0,borderRight:"1px solid rgba(255,255,255,.06)",overflowY:"auto",padding:"16px 14px",display:"flex",flexDirection:"column",gap:18}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <span style={{...S.label,marginBottom:0}}>Filters{activeCount>0?` (${activeCount})`:""}</span>
        <button onClick={onReset} style={{background:"none",border:"none",cursor:"pointer",fontSize:11,color:"#4a5568",fontFamily:"'DM Sans',sans-serif",padding:0}} aria-label="Reset all filters">Reset</button>
      </div>
      <fieldset style={{border:"none",padding:0,margin:0}}>
        <legend style={{...S.label,display:"block",marginBottom:8}}>Position</legend>
        <div style={{display:"flex",flexWrap:"wrap",gap:4}}>
          {positions.map(pos=>(
            <button key={pos} onClick={()=>toggle("positions",pos)} aria-pressed={filters.positions.includes(pos)}
              style={{padding:"3px 8px",borderRadius:3,fontSize:11,fontWeight:600,cursor:"pointer",background:filters.positions.includes(pos)?"rgba(246,173,85,.15)":"rgba(255,255,255,.04)",border:filters.positions.includes(pos)?"1px solid rgba(246,173,85,.4)":"1px solid rgba(255,255,255,.08)",color:filters.positions.includes(pos)?"#f6ad55":"#718096",fontFamily:"'DM Mono',monospace"}}>
              {pos}
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset style={{border:"none",padding:0,margin:0}}>
        <legend style={{...S.label,display:"block",marginBottom:8}}>Conference</legend>
        {confs.map(c=>(
          <label key={c} style={{display:"flex",alignItems:"center",gap:8,marginBottom:6,cursor:"pointer"}}>
            <input type="checkbox" checked={filters.conferences.length===0||filters.conferences.includes(c)} onChange={()=>{if(filters.conferences.length===0)onFilter("conferences",confs.filter(x=>x!==c));else toggle("conferences",c);}} style={{accentColor:"#f6ad55",width:14,height:14}}/>
            <span style={{fontSize:12,color:"#94a3b8"}}>{c}</span>
          </label>
        ))}
      </fieldset>
      <fieldset style={{border:"none",padding:0,margin:0}}>
        <legend style={{...S.label,display:"block",marginBottom:8}}>Status</legend>
        {["available","committed","signed","drafted"].map(s=>(
          <label key={s} style={{display:"flex",alignItems:"center",gap:8,marginBottom:6,cursor:"pointer"}}>
            <input type="checkbox" checked={filters.statuses.length===0||filters.statuses.includes(s)} onChange={()=>{if(filters.statuses.length===0)onFilter("statuses",["available","committed","signed","drafted"].filter(x=>x!==s));else toggle("statuses",s);}} style={{accentColor:"#f6ad55",width:14,height:14}}/>
            <span style={{fontSize:12,color:"#94a3b8",textTransform:"capitalize"}}>{s}</span>
          </label>
        ))}
      </fieldset>
      <fieldset style={{border:"none",padding:0,margin:0}}>
        <legend style={{...S.label,display:"block",marginBottom:8}}>Year</legend>
        {[2025,2024,2023].map(y=>(
          <label key={y} style={{display:"flex",alignItems:"center",gap:8,marginBottom:6,cursor:"pointer"}}>
            <input type="checkbox" checked={filters.years.includes(y)} onChange={()=>toggle("years",y)} style={{accentColor:"#f6ad55",width:14,height:14}}/>
            <span style={{fontSize:12,color:"#94a3b8"}}>{y}</span>
          </label>
        ))}
      </fieldset>
      <div>
        <label htmlFor="gem-min" style={{...S.label,display:"block"}}>Gem Score ≥ <span style={{color:"#f6ad55"}}>{filters.gemRange[0]}</span></label>
        <input id="gem-min" type="range" min={0} max={100} value={filters.gemRange[0]} onChange={e=>onFilter("gemRange",[+e.target.value,filters.gemRange[1]])} style={{width:"100%",accentColor:"#f6ad55",cursor:"pointer"}}/>
      </div>
      <div>
        <label htmlFor="risk-max" style={{...S.label,display:"block"}}>Risk Score ≤ <span style={{color:"#f6ad55"}}>{filters.riskRange[1]}</span></label>
        <input id="risk-max" type="range" min={0} max={100} value={filters.riskRange[1]} onChange={e=>onFilter("riskRange",[filters.riskRange[0],+e.target.value])} style={{width:"100%",accentColor:"#f6ad55",cursor:"pointer"}}/>
      </div>
      <fieldset style={{border:"none",padding:0,margin:0}}>
        <legend style={{...S.label,display:"block",marginBottom:8}}>Flags</legend>
        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
          {["HOT","RISING","WATCH"].map(f=>(
            <button key={f} onClick={()=>toggle("flags",f)} aria-pressed={filters.flags.includes(f)}
              style={{padding:"3px 10px",borderRadius:3,fontSize:11,fontWeight:600,cursor:"pointer",background:filters.flags.includes(f)?(flagColors[f]?.[0]||"transparent"):"rgba(255,255,255,.04)",border:`1px solid ${filters.flags.includes(f)?(flagColors[f]?.[1]||"#94a3b8")+"55":"rgba(255,255,255,.08)"}`,color:filters.flags.includes(f)?(flagColors[f]?.[1]||"#94a3b8"):"#718096",fontFamily:"'DM Mono',monospace"}}>
              {f}
            </button>
          ))}
        </div>
      </fieldset>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PLAYER ROW
// ─────────────────────────────────────────────────────────────────────────────
const PlayerRow = ({p,selected,onSelect,onWatch,onCompare,watched,inCompare}) => {
  const mainStat=getMainStat(p), projStat=getProjStat(p), isERA=p.isPitcher;
  const statColor = mainStat!=null?(isERA?(mainStat<2.5?"#f6ad55":mainStat<3.5?"#a78bfa":"#e2e8f0"):(mainStat>1.0?"#f6ad55":mainStat>.900?"#a78bfa":"#e2e8f0")):"#e2e8f0";
  return (
    <tr role="row" tabIndex={0} aria-selected={selected} onClick={()=>onSelect(p.id)} onKeyDown={e=>(e.key==="Enter"||e.key===" ")&&onSelect(p.id)}
      style={{borderBottom:"1px solid rgba(255,255,255,.04)",cursor:"pointer",background:selected?"rgba(246,173,85,.06)":"transparent",outline:selected?"2px solid rgba(246,173,85,.3)":"none",transition:"background .1s"}}>
      <td style={{padding:"10px 8px",width:36}}>
        <input type="checkbox" checked={inCompare} onChange={e=>{e.stopPropagation();onCompare(p.id);}} onClick={e=>e.stopPropagation()} aria-label={`Select ${p.name} for comparison`} style={{accentColor:"#f6ad55",width:14,height:14,cursor:"pointer"}}/>
      </td>
      <td style={{padding:"10px 8px",minWidth:200}}>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <Avatar name={p.name} size={28}/>
          <div>
            <div style={{display:"flex",alignItems:"center",gap:6}}>
              <span style={{fontSize:13,fontWeight:500,color:"#e2e8f0"}}>{p.name}</span>
              {p.flag && <Badge text={p.flag} type="flag"/>}
            </div>
            <div style={{fontSize:11,color:"#4a5568",marginTop:1}}>{p.pos} · {p.school}</div>
          </div>
        </div>
      </td>
      <td style={{padding:"10px 8px",textAlign:"right"}}>
        <span style={{...S.mono,fontSize:13,fontWeight:500,color:statColor}}>{mainStat!=null?(isERA?fmt2(mainStat):fmt3(mainStat)):"—"}</span>
        <div style={{fontSize:10,color:"#4a5568"}}>{getStatLabel(p)}</div>
      </td>
      <td style={{padding:"10px 8px",textAlign:"right"}}>
        <span style={{...S.mono,fontSize:13,fontWeight:500,color:"#93c5fd"}}>{projStat!=null?(isERA?fmt2(projStat):fmt3(projStat)):"—"}</span>
        <div style={{fontSize:10,color:"#4a5568"}}>C-USA</div>
      </td>
      <td style={{padding:"10px 8px"}}><Sparkline p={p}/></td>
      <td style={{padding:"10px 8px"}}>
        <div style={{display:"flex",alignItems:"center",gap:6,justifyContent:"flex-end"}}>
          <span style={{...S.mono,fontSize:13,fontWeight:500,color:gemColor(p.gemScore)}}>{p.gemScore}</span>
        </div>
        <div style={{height:3,borderRadius:2,background:"rgba(255,255,255,.08)",overflow:"hidden",marginTop:3,width:56,marginLeft:"auto"}}>
          <div style={{width:`${p.gemScore}%`,height:"100%",background:gemColor(p.gemScore),borderRadius:2}}/>
        </div>
      </td>
      <td style={{padding:"10px 8px",textAlign:"right"}}>
        <span style={{...S.mono,fontSize:12,color:riskColor(p.riskScore)}}>{p.riskScore}</span>
        <div style={{fontSize:10,color:riskColor(p.riskScore),opacity:.7}}>{riskLabel(p.riskScore)}</div>
      </td>
      <td style={{padding:"10px 8px",textAlign:"right"}}><span style={{...S.mono,fontSize:12,color:"#a78bfa"}}>{fmtK(p.surplus)}</span></td>
      <td style={{padding:"10px 8px",textAlign:"right"}}><span style={{...S.mono,fontSize:12,color:"#94a3b8"}}>{p.isPitcher?(p.probs.d1IP??0):(p.probs.d1PA??0)}%</span></td>
      <td style={{padding:"10px 8px",textAlign:"center"}}><Badge text={p.status} type="status"/></td>
      <td style={{padding:"10px 8px",textAlign:"center",width:40}}>
        <button onClick={e=>{e.stopPropagation();onWatch(p.id);}} aria-label={watched?`Remove ${p.name} from watchlist`:`Add ${p.name} to watchlist`}
          style={{background:"none",border:"none",cursor:"pointer",fontSize:16,color:watched?"#f6ad55":"#2d3748",lineHeight:1,padding:4,minWidth:44,minHeight:44,display:"flex",alignItems:"center",justifyContent:"center"}}>
          ★
        </button>
      </td>
    </tr>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// PLAYER DETAIL PANEL
// ─────────────────────────────────────────────────────────────────────────────
function PlayerDetailPanel({player,onClose,watched,onWatch,notes,onNote}) {
  const [tab,setTab]=useState("overview"), [noteText,setNoteText]=useState(""), [noteTags,setNoteTags]=useState([]);
  const panelRef=useRef(null);
  useFocusTrap(panelRef,!!player);
  useEffect(()=>{if(player)setTab("overview");},[player?.id]);
  if(!player) return null;
  const p=player, mainStat=getMainStat(p), projStat=getProjStat(p), isERA=p.isPitcher, playerNotes=notes[p.id]||[];
  const tags=["Contact","Power","Speed","Defense","Character","Injury Concern"];
  const handleAddNote=()=>{if(!noteText.trim())return;onNote(p.id,{text:noteText,timestamp:new Date().toISOString(),tags:[...noteTags]});setNoteText("");setNoteTags([]);};
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="detail-player-name" ref={panelRef}
      style={{position:"fixed",top:0,right:0,height:"100vh",width:"min(520px,100vw)",background:"#0c111b",borderLeft:"1px solid rgba(255,255,255,.08)",zIndex:100,display:"flex",flexDirection:"column",overflowY:"auto",animation:"slideInRight .2s ease"}}>
      <div style={{padding:"20px 24px 0",flexShrink:0}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:4}}>
          <div>
            <h2 id="detail-player-name" style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:30,letterSpacing:1,color:"#f6ad55",lineHeight:1,margin:0}}>{p.name.toUpperCase()}</h2>
            <p style={{fontSize:12,color:"#718096",margin:"4px 0 0"}}>{p.pos} · {p.bats}/{p.throws} · {p.ht} {p.wt}lb · Age {p.age} · {p.hometown}</p>
          </div>
          <button onClick={onClose} aria-label="Close player detail panel" style={{background:"none",border:"none",color:"#4a5568",cursor:"pointer",fontSize:20,padding:4,minWidth:44,minHeight:44,display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
        </div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:14}}>
          <Badge text={p.status} type="status"/>
          {p.dest&&<span style={{fontSize:12,color:"#4ade80"}}>→ {p.dest}</span>}
          {p.flag&&<Badge text={p.flag} type="flag"/>}
          <span style={{fontSize:11,color:"#4a5568"}}>{p.school} · {p.conf} · {p.year}</span>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:8,marginBottom:14}}>
          {[["JUCO "+getStatLabel(p),mainStat!=null?(isERA?fmt2(mainStat):fmt3(mainStat)):"—","#f6ad55"],["PROJ "+getStatLabel(p),projStat!=null?(isERA?fmt2(projStat):fmt3(projStat)):"—","#93c5fd"],["GEM",p.gemScore,gemColor(p.gemScore)],["RISK",`${p.riskScore} ${riskLabel(p.riskScore)}`,riskColor(p.riskScore)],["SURP",fmtK(p.surplus),"#a78bfa"]].map(([l,v,c])=>(
            <div key={l} style={{...S.card,padding:"8px 10px",textAlign:"center"}}>
              <div style={{fontSize:9,color:"#4a5568",letterSpacing:".08em",textTransform:"uppercase",marginBottom:3}}>{l}</div>
              <div style={{...S.mono,fontSize:14,fontWeight:500,color:c}}>{v}</div>
            </div>
          ))}
        </div>
        <div role="tablist" style={{display:"flex",gap:0,borderBottom:"1px solid rgba(255,255,255,.06)"}}>
          {["overview","stats","projections","comps","notes"].map(t=>(
            <button key={t} role="tab" aria-selected={tab===t} onClick={()=>setTab(t)}
              style={{background:"none",border:"none",borderBottom:tab===t?"2px solid #f6ad55":"2px solid transparent",cursor:"pointer",fontFamily:"'DM Sans',sans-serif",fontSize:12,fontWeight:500,padding:"8px 12px",color:tab===t?"#f6ad55":"#718096",transition:"all .15s",textTransform:"capitalize"}}>
              {t}
            </button>
          ))}
        </div>
      </div>
      <div style={{padding:"18px 24px",flex:1}}>
        {tab==="overview"&&(
          <div>
            <p style={{fontSize:13,color:"#94a3b8",lineHeight:1.7,marginBottom:16}}>{p.notes}</p>
            <div style={S.divider}/>
            <div style={S.label}>Physical Profile</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:16}}>
              {[["Height",p.ht],["Weight",p.wt+"lb"],["Bats",p.bats],["Throws",p.throws]].map(([l,v])=>(
                <div key={l} style={{...S.card,padding:"8px 12px"}}><div style={{fontSize:10,color:"#4a5568"}}>{l}</div><div style={{...S.mono,fontSize:14,color:"#e2e8f0",marginTop:2}}>{v}</div></div>
              ))}
            </div>
            <div style={{display:"flex",gap:8}}>
              <button onClick={()=>onWatch(p.id)} style={{flex:1,padding:"9px 0",borderRadius:6,cursor:"pointer",background:watched?"rgba(246,173,85,.15)":"rgba(255,255,255,.04)",border:`1px solid ${watched?"rgba(246,173,85,.4)":"rgba(255,255,255,.08)"}`,color:watched?"#f6ad55":"#718096",fontFamily:"'DM Sans',sans-serif",fontSize:12,fontWeight:500}}>
                {watched?"★ Watchlisted":"☆ Add to Watchlist"}
              </button>
              <button onClick={()=>alert("Export feature coming in v2.")} style={{flex:1,padding:"9px 0",borderRadius:6,cursor:"pointer",background:"rgba(147,197,253,.08)",border:"1px solid rgba(147,197,253,.2)",color:"#93c5fd",fontFamily:"'DM Sans',sans-serif",fontSize:12,fontWeight:500}}>↗ Export Report</button>
            </div>
          </div>
        )}
        {tab==="stats"&&(
          <div>
            <div style={S.label}>Raw {p.year} JUCO Stats — {p.school}</div>
            {!isERA&&p.juco?(
              <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:7,marginBottom:16}}>
                {[["AVG",fmt3(p.juco.avg)],["OBP",fmt3(p.juco.obp)],["SLG",fmt3(p.juco.slg)],["OPS",fmt3(p.juco.ops),"#f6ad55"],["ISO",fmt3(p.juco.iso)],["BB%",p.juco.bbPct+"%"],["K%",p.juco.kPct+"%"],["PA",p.juco.pa],["HR",p.juco.hr],["SB",`${p.juco.sb}-${p.juco.sb+p.juco.cs}`],["2B",p.juco.doubles],["3B",p.juco.triples]].map(([l,v,c])=>(
                  <div key={l} style={{...S.card,padding:"8px 10px"}}><div style={{fontSize:9,color:"#4a5568",textTransform:"uppercase"}}>{l}</div><div style={{...S.mono,fontSize:15,fontWeight:500,color:c||"#a5b4fc",marginTop:2}}>{v}</div></div>
                ))}
              </div>
            ):p.jucoP?(
              <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:7,marginBottom:16}}>
                {[["ERA",fmt2(p.jucoP.era),"#f6ad55"],["WHIP",fmt2(p.jucoP.whip)],["FIP",fmt2(p.jucoP.fip)],["K/9",p.jucoP.k9?.toFixed(1)],["BB/9",p.jucoP.bb9?.toFixed(1)],["IP",p.jucoP.ip],["Velo",p.jucoP.velo+" mph"],["GS",p.jucoP.gs],["SV",p.jucoP.sv]].map(([l,v,c])=>(
                  <div key={l} style={{...S.card,padding:"8px 10px"}}><div style={{fontSize:9,color:"#4a5568",textTransform:"uppercase"}}>{l}</div><div style={{...S.mono,fontSize:15,fontWeight:500,color:c||"#a5b4fc",marginTop:2}}>{v}</div></div>
                ))}
              </div>
            ):null}
            <div style={{...S.card,padding:"12px 14px"}}>
              <div style={S.label}>Conference Context</div>
              {[["Conf-adj percentile",p.confAdj+"th","#f6ad55"],["Conference strength",(CONF_DATA[p.conf]?.rating||0).toFixed(2),"#93c5fd"],["YoY trend",p.trend,p.trend?.startsWith("+")?"#4ade80":"#f87171"]].map(([l,v,c])=>(
                <div key={l} style={{display:"flex",justifyContent:"space-between",fontSize:13,color:"#94a3b8",marginBottom:6}}>
                  <span>{l}</span><span style={{...S.mono,color:c}}>{v}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {tab==="projections"&&(
          <div>
            <div style={S.label}>C-USA Projection Breakdown</div>
            <div style={{...S.card,marginBottom:14}}>
              {[["1. Raw JUCO stat",mainStat!=null?(isERA?fmt2(mainStat):fmt3(mainStat)):"—","#e2e8f0"],["2. Park factor applied",isERA?fmt2((mainStat||3.5)*1.04):fmt3((mainStat||.800)/1.07),"#94a3b8"],["3. Conference strength",`×${(CONF_DATA[p.conf]?.rating||0).toFixed(2)}`,"#94a3b8"],["4. Age adjustment",p.age<=20?"+0.3% boost":p.age>=22?"-1.2% discount":"neutral","#94a3b8"],["5. Projected C-USA stat",projStat!=null?(isERA?fmt2(projStat):fmt3(projStat)):"—","#93c5fd"]].map(([step,val,col])=>(
                <div key={step} style={{display:"flex",justifyContent:"space-between",padding:"7px 0",borderBottom:"1px solid rgba(255,255,255,.04)"}}>
                  <span style={{fontSize:12,color:"#94a3b8"}}>{step}</span>
                  <span style={{...S.mono,fontSize:12,fontWeight:500,color:col}}>{val}</span>
                </div>
              ))}
            </div>
            <div style={S.label}>80% Confidence Interval</div>
            <div style={{...S.card,padding:"14px 16px",marginBottom:14}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:8,fontSize:12}}>
                <span style={{...S.mono,color:"#f87171"}}>{isERA?fmt2(p.proj.floor):fmt3(p.proj.floor)} floor</span>
                <span style={{...S.mono,color:"#93c5fd",fontWeight:600,fontSize:16}}>{projStat!=null?(isERA?fmt2(projStat):fmt3(projStat)):"—"}</span>
                <span style={{...S.mono,color:"#4ade80"}}>{isERA?fmt2(p.proj.ceil):fmt3(p.proj.ceil)} ceil</span>
              </div>
              <div style={{height:8,background:"rgba(255,255,255,.06)",borderRadius:4,position:"relative",overflow:"hidden"}}>
                <div style={{position:"absolute",left:"10%",width:"80%",height:"100%",background:"rgba(147,197,253,.2)",borderRadius:4}}/>
                <div style={{position:"absolute",left:"45%",width:3,height:"100%",background:"#93c5fd",borderRadius:2}}/>
              </div>
            </div>
            <div style={S.label}>Variable Contributions (SHAP)</div>
            <div style={S.card}>
              {isERA?[["K/9 (strikeout rate)",-0.048],["BB/9 (command)",(p.jucoP?.bb9||3)<3?-0.022:0.028],["Velo (stuff)",(p.jucoP?.velo||88)>=93?-0.038:0.018],["YoY ERA trend",p.trend?.startsWith("−")?-0.032:0.024],["Conference discount",0.031],["Age factor",p.age<=20?-0.018:0.014]]:[["K% (contact)",(p.juco?.kPct||15)<12?-0.054:(p.juco?.kPct||15)>18?0.028:-0.018],["ISO (power)",(p.juco?.iso||.150)>0.220?-0.042:0.022],["YoY trajectory",p.trend?.startsWith("+")?-0.036:0.024],["BB% (discipline)",(p.juco?.bbPct||8)>10?-0.028:0.018],["Conference discount",0.032],["Age factor",p.age<=20?-0.019:p.age>=22?0.016:0.004]].map(([label,val])=><ShapBar key={label} label={label} value={val}/>)}
            </div>
            <div style={S.divider}/>
            <div style={S.label}>Success Probabilities</div>
            <ProbBar label={`P(${isERA?"30+ IP":"100+ PA"}, yr 1)`} value={isERA?(p.probs.d1IP||0):(p.probs.d1PA||0)} color="#22c55e"/>
            <ProbBar label="P(above-avg C-USA starter)" value={p.probs.avgStarter||0} color="#4ade80"/>
            <ProbBar label="P(roster retained yr 2)" value={p.probs.retained||0} color="#93c5fd"/>
            <ProbBar label="P(pro opportunity)" value={p.probs.pro||0} color="#a78bfa"/>
          </div>
        )}
        {tab==="comps"&&(
          <div>
            <div style={S.label}>Historical Comparable Players</div>
            {[{name:"Yainer Diaz",school:"San Jacinto JC → Houston (2018)",stat:isERA?"ERA 2.31 JUCO":"OPS .924 JUCO",outcome:isERA?"3.44 ERA D1, MLB (Astros)":"D1 OPS .831, MiLB, reached MLB",score:84},{name:"Chase Davis",school:"Scottsdale CC → Arizona (2021)",stat:isERA?"ERA 2.74 JUCO":"OPS 1.050 JUCO",outcome:isERA?"4.01 ERA D1, drafted R4":"D1 OPS .851, drafted R3",score:79},{name:"Tyler Szeliga",school:"Mesa CC → Grand Canyon (2020)",stat:isERA?"ERA 3.12 JUCO":"OPS .934 JUCO",outcome:isERA?"4.22 ERA D1, undrafted":"D1 OPS .798, 3 seasons retained",score:71}].map(c=>(
              <div key={c.name} style={{...S.card,marginBottom:10}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
                  <div>
                    <div style={{fontSize:13,fontWeight:500,color:"#e2e8f0",marginBottom:2}}>{c.name}</div>
                    <div style={{fontSize:11,color:"#4a5568"}}>{c.school}</div>
                  </div>
                  <div style={{...S.card,padding:"4px 10px",borderRadius:20}}><span style={{...S.mono,fontSize:12,color:"#f6ad55"}}>{c.score}% match</span></div>
                </div>
                <div style={{...S.divider,margin:"10px 0"}}/>
                <div style={{display:"flex",justifyContent:"space-between",fontSize:12}}>
                  <div><span style={{color:"#4a5568"}}>JUCO: </span><span style={{...S.mono,color:"#f6ad55"}}>{c.stat}</span></div>
                  <div><span style={{color:"#4a5568"}}>D1: </span><span style={{...S.mono,color:"#4ade80"}}>{c.outcome}</span></div>
                </div>
              </div>
            ))}
          </div>
        )}
        {tab==="notes"&&(
          <div>
            <div style={S.label}>Scouting Notes</div>
            <div style={{marginBottom:14}}>
              <textarea value={noteText} onChange={e=>setNoteText(e.target.value)} placeholder="Add your scouting observations…" aria-label="Scouting note text"
                style={{width:"100%",minHeight:80,background:"rgba(255,255,255,.04)",border:"1px solid rgba(255,255,255,.08)",borderRadius:8,padding:10,color:"#e2e8f0",fontFamily:"'DM Sans',sans-serif",fontSize:13,resize:"vertical",outline:"none",boxSizing:"border-box"}}/>
              <div style={{display:"flex",flexWrap:"wrap",gap:6,margin:"8px 0"}}>
                {["Contact","Power","Speed","Defense","Character","Injury Concern"].map(t=>(
                  <button key={t} onClick={()=>setNoteTags(prev=>prev.includes(t)?prev.filter(x=>x!==t):[...prev,t])} aria-pressed={noteTags.includes(t)}
                    style={{padding:"3px 10px",borderRadius:12,fontSize:11,cursor:"pointer",background:noteTags.includes(t)?"rgba(246,173,85,.15)":"rgba(255,255,255,.04)",border:`1px solid ${noteTags.includes(t)?"rgba(246,173,85,.4)":"rgba(255,255,255,.08)"}`,color:noteTags.includes(t)?"#f6ad55":"#718096",fontFamily:"'DM Sans',sans-serif"}}>
                    {t}
                  </button>
                ))}
              </div>
              <button onClick={handleAddNote} style={{padding:"8px 20px",background:"rgba(246,173,85,.15)",border:"1px solid rgba(246,173,85,.3)",borderRadius:6,cursor:"pointer",color:"#f6ad55",fontFamily:"'DM Sans',sans-serif",fontSize:12,fontWeight:500}}>Add Note</button>
            </div>
            {playerNotes.length===0?<p style={{fontSize:13,color:"#4a5568",fontStyle:"italic"}}>No notes yet. Use this space to track your scouting observations.</p>
              :playerNotes.slice(0,3).map((n,i)=>(
                <div key={i} style={{...S.card,marginBottom:8}}>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
                    <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>{n.tags?.map(t=><Badge key={t} text={t} type="pos"/>)}</div>
                    <span style={{fontSize:10,color:"#4a5568"}}>{new Date(n.timestamp).toLocaleDateString()}</span>
                  </div>
                  <p style={{fontSize:12,color:"#94a3b8",margin:0,lineHeight:1.6}}>{n.text}</p>
                </div>
              ))
            }
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPARE MODAL
// ─────────────────────────────────────────────────────────────────────────────
function CompareModal({players,onClose}) {
  const ref=useRef(null);
  useFocusTrap(ref,true);
  const maxSurplus=Math.max(...players.map(p=>p.surplus)), minRisk=Math.min(...players.map(p=>p.riskScore));
  return (
    <div role="dialog" aria-modal="true" aria-label="Compare players"
      style={{position:"fixed",inset:0,background:"rgba(0,0,0,.8)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:20,animation:"fadeIn .2s"}}
      onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div ref={ref} style={{background:"#0c111b",border:"1px solid rgba(255,255,255,.08)",borderRadius:12,maxWidth:960,width:"100%",maxHeight:"90vh",overflowY:"auto",padding:24}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
          <h2 style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:22,letterSpacing:1,color:"#e2e8f0",margin:0}}>PLAYER COMPARISON</h2>
          <div style={{display:"flex",gap:10}}>
            <button onClick={()=>alert("PDF export coming in v2.")} style={{padding:"7px 16px",background:"rgba(255,255,255,.04)",border:"1px solid rgba(255,255,255,.08)",borderRadius:6,cursor:"pointer",color:"#94a3b8",fontFamily:"'DM Sans',sans-serif",fontSize:12}}>Export PDF</button>
            <button onClick={onClose} aria-label="Close comparison" style={{background:"none",border:"none",color:"#4a5568",cursor:"pointer",fontSize:20,minWidth:44,minHeight:44,display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
          </div>
        </div>
        <div style={{display:"grid",gridTemplateColumns:`repeat(${players.length},1fr)`,gap:12}}>
          {players.map(p=>{
            const mainStat=getMainStat(p), projStat=getProjStat(p);
            return (
              <div key={p.id} style={{...S.card,padding:16,position:"relative"}}>
                {p.surplus===maxSurplus&&<span style={{position:"absolute",top:10,right:10,fontSize:9,fontWeight:700,padding:"2px 6px",borderRadius:3,background:"rgba(167,139,250,.15)",color:"#a78bfa",letterSpacing:".06em"}}>BEST VALUE</span>}
                {p.riskScore===minRisk&&<span style={{position:"absolute",top:10,right:p.surplus===maxSurplus?82:10,fontSize:9,fontWeight:700,padding:"2px 6px",borderRadius:3,background:"rgba(74,222,128,.1)",color:"#4ade80",letterSpacing:".06em"}}>SAFEST</span>}
                <Avatar name={p.name} size={40}/>
                <h3 style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:18,color:"#f6ad55",margin:"8px 0 2px",letterSpacing:.5}}>{p.name}</h3>
                <p style={{fontSize:11,color:"#4a5568",margin:"0 0 12px"}}>{p.pos} · {p.school}</p>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,marginBottom:12}}>
                  {[["JUCO "+getStatLabel(p),mainStat!=null?(p.isPitcher?fmt2(mainStat):fmt3(mainStat)):"—","#f6ad55"],["PROJ "+getStatLabel(p),projStat!=null?(p.isPitcher?fmt2(projStat):fmt3(projStat)):"—","#93c5fd"],["GEM",p.gemScore,gemColor(p.gemScore)],["RISK",`${p.riskScore} ${riskLabel(p.riskScore)}`,riskColor(p.riskScore)],["SURP",fmtK(p.surplus),"#a78bfa"],["CONF ADJ",p.confAdj+"th","#94a3b8"]].map(([l,v,c])=>(
                    <div key={l} style={{background:"rgba(255,255,255,.03)",borderRadius:6,padding:"6px 8px"}}>
                      <div style={{fontSize:9,color:"#4a5568",textTransform:"uppercase",letterSpacing:".06em"}}>{l}</div>
                      <div style={{...S.mono,fontSize:13,fontWeight:500,color:c,marginTop:2}}>{v}</div>
                    </div>
                  ))}
                </div>
                <ProbBar label={p.isPitcher?"IP prob":"PA prob"} value={p.isPitcher?(p.probs.d1IP||0):(p.probs.d1PA||0)} color="#22c55e"/>
                <ProbBar label="Pro prob" value={p.probs.pro||0} color="#a78bfa"/>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// COMMAND PALETTE
// ─────────────────────────────────────────────────────────────────────────────
function CommandPalette({players,onClose,onSelect}) {
  const [q,setQ]=useState(""), [cursor,setCursor]=useState(0);
  const ref=useRef(null), inputRef=useRef(null);
  useFocusTrap(ref,true);
  useEffect(()=>{inputRef.current?.focus();},[]);
  const results=useMemo(()=>{if(!q.trim())return[];const lq=q.toLowerCase();return players.filter(p=>p.name.toLowerCase().includes(lq)||p.school.toLowerCase().includes(lq)||p.pos.toLowerCase().includes(lq)).slice(0,12);},[q,players]);
  const hitters=results.filter(p=>!p.isPitcher), pitchers=results.filter(p=>p.isPitcher);
  const onKey=(e)=>{if(e.key==="Escape")onClose();if(e.key==="ArrowDown"){e.preventDefault();setCursor(c=>Math.min(c+1,results.length-1));}if(e.key==="ArrowUp"){e.preventDefault();setCursor(c=>Math.max(c-1,0));}if(e.key==="Enter"&&results[cursor]){onSelect(results[cursor].id);onClose();}};
  const ResultItem=({p})=>{const idx=results.indexOf(p);return(<div role="option" aria-selected={cursor===idx} onClick={()=>{onSelect(p.id);onClose();}} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 16px",cursor:"pointer",background:cursor===idx?"rgba(246,173,85,.08)":"transparent",transition:"background .1s"}}><Avatar name={p.name} size={28}/><div style={{flex:1}}><div style={{fontSize:13,color:"#e2e8f0"}}>{p.name}</div><div style={{fontSize:11,color:"#4a5568"}}>{p.pos} · {p.school} · {p.conf}</div></div><span style={{...S.mono,fontSize:11,padding:"2px 8px",borderRadius:3,background:"rgba(255,255,255,.05)",color:gemColor(p.gemScore)}}>{p.gemScore}</span><Badge text={p.status} type="status"/></div>);};
  return (
    <div role="dialog" aria-label="Search players" aria-modal="true" style={{position:"fixed",inset:0,background:"rgba(0,0,0,.85)",zIndex:300,display:"flex",alignItems:"flex-start",justifyContent:"center",padding:"80px 20px 20px",animation:"fadeIn .15s"}} onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div ref={ref} style={{background:"#0f1623",border:"1px solid rgba(255,255,255,.1)",borderRadius:12,width:"100%",maxWidth:560,overflow:"hidden"}} onKeyDown={onKey}>
        <div style={{display:"flex",alignItems:"center",gap:10,padding:"12px 16px",borderBottom:"1px solid rgba(255,255,255,.06)"}}>
          <span style={{color:"#4a5568",fontSize:16}}>⌕</span>
          <input ref={inputRef} value={q} onChange={e=>{setQ(e.target.value);setCursor(0);}} placeholder="Search players, schools, positions…" aria-label="Search players" style={{flex:1,background:"none",border:"none",color:"#e2e8f0",fontSize:14,fontFamily:"'DM Sans',sans-serif",outline:"none"}}/>
          <kbd style={{fontSize:11,color:"#4a5568",border:"1px solid rgba(255,255,255,.1)",borderRadius:4,padding:"2px 6px",fontFamily:"'DM Mono',monospace"}}>ESC</kbd>
        </div>
        {q.trim()===""?<p style={{padding:"20px 16px",fontSize:13,color:"#4a5568",margin:0}}>Type to search players…</p>
          :results.length===0?<p style={{padding:"20px 16px",fontSize:13,color:"#4a5568",margin:0}}>No players match your search.</p>
          :<div role="listbox" aria-label="Search results" style={{maxHeight:400,overflowY:"auto"}}>
            {hitters.length>0&&<><div style={{...S.label,padding:"8px 16px 4px",marginBottom:0}}>Hitters ({hitters.length})</div>{hitters.map(p=><ResultItem key={p.id} p={p}/>)}</>}
            {pitchers.length>0&&<><div style={{...S.label,padding:"8px 16px 4px",marginBottom:0}}>Pitchers ({pitchers.length})</div>{pitchers.map(p=><ResultItem key={p.id} p={p}/>)}</>}
          </div>
        }
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// HOME VIEW
// ─────────────────────────────────────────────────────────────────────────────
function HomeView({players,watchlist,alerts,onNav,onSelect}) {
  const available=players.filter(p=>p.status==="available"), hotTargets=players.filter(p=>p.flag==="HOT");
  const avgGem=players.length?Math.round(players.reduce((a,p)=>a+p.gemScore,0)/players.length):0;
  const topGems=[...available].sort((a,b)=>b.gemScore-a.gemScore).slice(0,5);
  const watchPlayers=watchlist.slice(0,3).map(id=>players.find(p=>p.id===id)).filter(Boolean);
  const confStats=Object.entries(CONF_DATA).map(([conf,d])=>{const cp=players.filter(p=>p.conf===conf);return{conf,count:cp.length,avail:cp.filter(p=>p.status==="available").length,avgGem:cp.length?Math.round(cp.reduce((a,p)=>a+p.gemScore,0)/cp.length):0};}).sort((a,b)=>b.avgGem-a.avgGem);
  return (
    <div style={{padding:"24px 28px",overflowY:"auto",flex:1}}>
      <h1 style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:28,letterSpacing:1,color:"#e2e8f0",margin:"0 0 20px"}}>SCOUT OVERVIEW</h1>
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12,marginBottom:24}}>
        {[["Players Available",available.length,"#4ade80"],["Avg Gem Score",avgGem,"#f6ad55"],["HOT Targets",hotTargets.length,"#fc8181"],["Commitments",players.filter(p=>p.status==="committed").length,"#93c5fd"]].map(([label,val,col])=>(
          <div key={label} style={{...S.card,padding:"16px 18px"}}><div style={{...S.label,marginBottom:4}}>{label}</div><div style={{...S.mono,fontSize:28,fontWeight:500,color:col,lineHeight:1}}>{val}</div></div>
        ))}
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:18,marginBottom:18}}>
        <div>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
            <h2 style={{...S.label,fontSize:11,marginBottom:0}}>Top 5 Hidden Gems</h2>
            <button onClick={()=>onNav("board")} style={{background:"none",border:"none",cursor:"pointer",fontSize:11,color:"#f6ad55",fontFamily:"'DM Sans',sans-serif"}}>View All →</button>
          </div>
          {topGems.map((p,i)=>(
            <div key={p.id} onClick={()=>onSelect(p.id)} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 0",borderBottom:"1px solid rgba(255,255,255,.04)",cursor:"pointer"}}>
              <span style={{...S.mono,fontSize:13,color:"#4a5568",width:16}}>{i+1}</span>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:13,color:"#e2e8f0",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{p.name}</div>
                <div style={{fontSize:11,color:"#4a5568"}}>{p.pos} · {p.school}</div>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <div style={{width:48,height:3,background:"rgba(255,255,255,.06)",borderRadius:2,overflow:"hidden"}}><div style={{width:`${p.gemScore}%`,height:"100%",background:gemColor(p.gemScore)}}/></div>
                <span style={{...S.mono,fontSize:12,color:gemColor(p.gemScore),minWidth:24}}>{p.gemScore}</span>
              </div>
            </div>
          ))}
        </div>
        <div>
          <h2 style={{...S.label,marginBottom:10}}>Conference Leaderboard</h2>
          <table style={{width:"100%",borderCollapse:"collapse"}}>
            <thead><tr>{["Conf","Players","Avail","Avg Gem"].map(h=><th key={h} scope="col" style={{...S.label,marginBottom:0,padding:"0 0 6px",textAlign:h==="Conf"?"left":"right"}}>{h}</th>)}</tr></thead>
            <tbody>{confStats.map(row=>(
              <tr key={row.conf} style={{borderBottom:"1px solid rgba(255,255,255,.04)"}}>
                <td style={{padding:"7px 0",fontSize:12,color:"#e2e8f0"}}>{row.conf}</td>
                <td style={{...S.mono,fontSize:12,color:"#94a3b8",textAlign:"right",padding:"7px 0"}}>{row.count}</td>
                <td style={{...S.mono,fontSize:12,color:"#4ade80",textAlign:"right",padding:"7px 0"}}>{row.avail}</td>
                <td style={{...S.mono,fontSize:12,color:gemColor(row.avgGem),textAlign:"right",padding:"7px 0"}}>{row.avgGem}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </div>
      <div style={{marginBottom:18}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
          <h2 style={{...S.label,fontSize:11,marginBottom:0}}>Recent Portal Activity</h2>
          <button onClick={()=>onNav("alerts")} style={{background:"none",border:"none",cursor:"pointer",fontSize:11,color:"#f6ad55",fontFamily:"'DM Sans',sans-serif"}}>View All →</button>
        </div>
        <ul style={{margin:0,padding:0,listStyle:"none"}}>
          {alerts.slice(0,5).map(a=>(
            <li key={a.id} style={{display:"flex",gap:12,padding:"10px 0",borderBottom:"1px solid rgba(255,255,255,.04)"}}>
              <div style={{width:7,height:7,borderRadius:"50%",background:a.type==="Portal Entry"?"#22c55e":a.type==="Commitment"?"#4ade80":a.type==="Stat Update"?"#93c5fd":"#f6ad55",marginTop:4,flexShrink:0}}/>
              <div style={{flex:1}}><div style={{fontSize:13,color:"#e2e8f0"}}>{a.title}</div><div style={{fontSize:11,color:"#4a5568",marginTop:2}}>{a.body}</div></div>
              <span style={{...S.mono,fontSize:10,color:"#4a5568",flexShrink:0}}>{a.time}</span>
            </li>
          ))}
        </ul>
      </div>
      {watchPlayers.length>0&&(
        <div>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
            <h2 style={{...S.label,fontSize:11,marginBottom:0}}>Watchlist Snapshot</h2>
            <button onClick={()=>onNav("watchlist")} style={{background:"none",border:"none",cursor:"pointer",fontSize:11,color:"#f6ad55",fontFamily:"'DM Sans',sans-serif"}}>View Full →</button>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10}}>
            {watchPlayers.map(p=>(
              <div key={p.id} onClick={()=>onSelect(p.id)} style={{...S.card,cursor:"pointer",padding:"12px 14px"}}>
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}><Avatar name={p.name} size={28}/><div><div style={{fontSize:12,fontWeight:500,color:"#e2e8f0"}}>{p.name}</div><div style={{fontSize:10,color:"#4a5568"}}>{p.pos} · {p.conf}</div></div></div>
                <div style={{display:"flex",justifyContent:"space-between"}}><span style={{...S.mono,fontSize:14,color:gemColor(p.gemScore)}}>{p.gemScore}</span><Badge text={p.status} type="status"/></div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// WATCHLIST VIEW
// ─────────────────────────────────────────────────────────────────────────────
function WatchlistView({players,watchlist,priorities,onRemove,onPriority,onSelect,onReorder}) {
  const [dragId,setDragId]=useState(null);
  const watchPlayers=watchlist.map(id=>players.find(p=>p.id===id)).filter(Boolean);
  const avail=watchPlayers.filter(p=>p.status==="available").length;
  const avgGem=watchPlayers.length?Math.round(watchPlayers.reduce((a,p)=>a+p.gemScore,0)/watchPlayers.length):0;
  if(watchPlayers.length===0) return <div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:12}}><div style={{fontSize:32}}>☆</div><p style={{fontSize:14,color:"#4a5568",textAlign:"center"}}>Your watchlist is empty.<br/>Star players on the Scout Board to track them here.</p></div>;
  return (
    <div style={{padding:"24px 28px",overflowY:"auto",flex:1}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
        <div>
          <h1 style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:26,letterSpacing:1,color:"#e2e8f0",margin:0}}>WATCHLIST</h1>
          <p style={{fontSize:12,color:"#4a5568",margin:"4px 0 0"}}>{watchPlayers.length} players · {avail} available · avg gem score {avgGem}</p>
        </div>
        <div style={{display:"flex",gap:8}}>
          <button onClick={()=>alert("PDF export coming in v2.")} style={{padding:"7px 14px",background:"rgba(255,255,255,.04)",border:"1px solid rgba(255,255,255,.08)",borderRadius:6,cursor:"pointer",color:"#94a3b8",fontFamily:"'DM Sans',sans-serif",fontSize:12}}>Export PDF</button>
          <button onClick={()=>{navigator.clipboard?.writeText(window.location.href);alert("Link copied!");}} style={{padding:"7px 14px",background:"rgba(255,255,255,.04)",border:"1px solid rgba(255,255,255,.08)",borderRadius:6,cursor:"pointer",color:"#94a3b8",fontFamily:"'DM Sans',sans-serif",fontSize:12}}>Share</button>
        </div>
      </div>
      {watchPlayers.map(p=>(
        <div key={p.id} draggable onDragStart={()=>setDragId(p.id)} onDragOver={e=>e.preventDefault()} onDrop={()=>{if(dragId&&dragId!==p.id)onReorder(dragId,p.id);setDragId(null);}}
          style={{display:"flex",alignItems:"center",gap:12,padding:"12px 14px",marginBottom:6,background:"rgba(255,255,255,.03)",border:"1px solid rgba(255,255,255,.06)",borderRadius:8,cursor:"grab",opacity:dragId===p.id?.5:1,transition:"opacity .15s"}}>
          <span aria-hidden="true" style={{color:"#2d3748",cursor:"grab",fontSize:14}}>⠿</span>
          <Avatar name={p.name} size={32}/>
          <div style={{flex:1,cursor:"pointer"}} onClick={()=>onSelect(p.id)}>
            <div style={{fontSize:13,fontWeight:500,color:"#e2e8f0"}}>{p.name}</div>
            <div style={{fontSize:11,color:"#4a5568"}}>{p.pos} · {p.school} · {p.conf}</div>
          </div>
          <div style={{display:"flex",gap:6}}>
            {["Tier 1","Tier 2","Backup"].map(tier=>(
              <button key={tier} onClick={()=>onPriority(p.id,priorities[p.id]===tier?null:tier)}
                style={{padding:"3px 8px",borderRadius:3,fontSize:10,fontWeight:600,cursor:"pointer",background:priorities[p.id]===tier?"rgba(246,173,85,.15)":"rgba(255,255,255,.04)",border:`1px solid ${priorities[p.id]===tier?"rgba(246,173,85,.4)":"rgba(255,255,255,.08)"}`,color:priorities[p.id]===tier?"#f6ad55":"#718096",fontFamily:"'DM Sans',sans-serif"}}>
                {tier}
              </button>
            ))}
          </div>
          <span style={{...S.mono,fontSize:14,color:gemColor(p.gemScore),minWidth:28}}>{p.gemScore}</span>
          <Badge text={p.status} type="status"/>
          <button onClick={()=>onRemove(p.id)} aria-label={`Remove ${p.name} from watchlist`} style={{background:"none",border:"none",cursor:"pointer",color:"#4a5568",fontSize:16,minWidth:44,minHeight:44,display:"flex",alignItems:"center",justifyContent:"center"}}>×</button>
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CONFERENCES VIEW
// ─────────────────────────────────────────────────────────────────────────────
function ConferencesView({players}) {
  const [expanded,setExpanded]=useState(null);
  const years=[2021,2022,2023,2024,2025];
  return (
    <div style={{padding:"24px 28px",overflowY:"auto",flex:1}}>
      <h1 style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:26,letterSpacing:1,color:"#e2e8f0",margin:"0 0 4px"}}>CONFERENCE RANKINGS</h1>
      <p style={{fontSize:12,color:"#4a5568",margin:"0 0 20px"}}>ACCAC → C-USA translation engine · Updated post-2025 season</p>
      <div style={{...S.card,marginBottom:18,display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:16}}>
        <div><div style={S.label}>2025 C-USA League Avgs</div><div style={{fontSize:12,color:"#94a3b8",lineHeight:1.8}}>Team AVG: <span style={{...S.mono,color:"#e2e8f0"}}>.275</span><br/>Team OPS: <span style={{...S.mono,color:"#f6ad55"}}>.793</span><br/>Team ERA: <span style={{...S.mono,color:"#93c5fd"}}>5.85</span></div></div>
        <div><div style={S.label}>Batting Leaders</div><div style={{fontSize:12,color:"#94a3b8",lineHeight:1.8}}>Top OPS: <span style={{...S.mono,color:"#f6ad55"}}>.995</span> K.Hayes, WKU<br/>Avg catcher OPS: <span style={{...S.mono,color:"#e2e8f0"}}>.718</span></div></div>
        <div><div style={S.label}>Pitching Leaders</div><div style={{fontSize:12,color:"#94a3b8",lineHeight:1.8}}>Avg starter ERA: <span style={{...S.mono,color:"#e2e8f0"}}>5.02</span><br/>Best FIP: <span style={{...S.mono,color:"#4ade80"}}>3.14</span><br/>Avg K/9: <span style={{...S.mono,color:"#e2e8f0"}}>9.1</span></div></div>
      </div>
      <table style={{width:"100%",borderCollapse:"collapse",marginBottom:16}}>
        <thead><tr style={{borderBottom:"1px solid rgba(255,255,255,.08)"}}>
          {["Conference","Strength","Transfers","D1 Success","OPS Mult","ERA Mult","Trend"].map(h=><th key={h} scope="col" style={{...S.label,marginBottom:0,padding:"0 12px 10px",textAlign:h==="Conference"?"left":"right",fontWeight:600}}>{h}</th>)}
        </tr></thead>
        <tbody>
          {Object.entries(CONF_DATA).sort((a,b)=>b[1].rating-a[1].rating).map(([conf,d])=>[
            <tr key={conf} onClick={()=>setExpanded(expanded===conf?null:conf)} style={{borderBottom:"1px solid rgba(255,255,255,.04)",cursor:"pointer",background:expanded===conf?"rgba(246,173,85,.04)":"transparent"}}>
              <td style={{padding:"12px 12px",fontSize:13,color:"#e2e8f0"}}><span style={{color:"#4a5568",fontSize:10,marginRight:8}}>{expanded===conf?"▼":"▶"}</span>{conf}</td>
              <td style={{...S.mono,fontSize:15,fontWeight:500,textAlign:"right",padding:"12px 12px",color:d.rating>=.88?"#f6ad55":d.rating>=.82?"#93c5fd":"#718096"}}>{d.rating.toFixed(2)}</td>
              <td style={{...S.mono,fontSize:13,textAlign:"right",padding:"12px 12px",color:"#94a3b8"}}>{d.transfers}</td>
              <td style={{...S.mono,fontSize:13,textAlign:"right",padding:"12px 12px",color:"#4ade80"}}>{d.d1Rate}%</td>
              <td style={{...S.mono,fontSize:13,textAlign:"right",padding:"12px 12px",color:"#a5b4fc"}}>{d.opsMult.toFixed(3)}</td>
              <td style={{...S.mono,fontSize:13,textAlign:"right",padding:"12px 12px",color:"#a5b4fc"}}>{d.eraMult.toFixed(3)}</td>
              <td style={{...S.mono,fontSize:11,textAlign:"right",padding:"12px 12px",color:"#4ade80"}}>+0.01 ↑</td>
            </tr>,
            expanded===conf&&<tr key={conf+"_exp"}><td colSpan={7} style={{padding:"0 12px 16px",background:"rgba(255,255,255,.02)"}}>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,paddingTop:12}}>
                <div>
                  <div style={S.label}>5-Year Strength History</div>
                  <div style={{display:"flex",alignItems:"flex-end",gap:4,height:48}}>
                    {d.history.map((v,i)=>(
                      <div key={i} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:3}}>
                        <div style={{width:"100%",background:`${d.rating>=.88?"#f6ad55":d.rating>=.82?"#93c5fd":"#718096"}55`,height:`${((v-0.6)/(1.0-0.6))*44}px`,borderRadius:"2px 2px 0 0",minHeight:6}}/>
                        <span style={{...S.mono,fontSize:9,color:"#4a5568"}}>{years[i]}</span>
                      </div>
                    ))}
                  </div>
                  <div style={{display:"flex",gap:4,marginTop:4}}>{d.history.map((v,i)=><span key={i} style={{...S.mono,fontSize:9,color:"#94a3b8",flex:1,textAlign:"center"}}>{v.toFixed(2)}</span>)}</div>
                </div>
                <div>
                  <div style={S.label}>Notable Alumni</div>
                  <ul style={{margin:0,padding:"0 0 0 12px",listStyle:"disc"}}>{d.alumni.map(a=><li key={a} style={{fontSize:12,color:"#94a3b8",marginBottom:4}}>{a}</li>)}</ul>
                </div>
              </div>
              <div style={{marginTop:12}}>
                <div style={S.label}>Top Players in Dataset</div>
                <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                  {players.filter(p=>p.conf===conf).sort((a,b)=>b.gemScore-a.gemScore).slice(0,5).map(p=>(
                    <div key={p.id} style={{...S.card,padding:"6px 10px",display:"flex",alignItems:"center",gap:8}}><span style={{fontSize:12,color:"#e2e8f0"}}>{p.name}</span><span style={{...S.mono,fontSize:11,color:gemColor(p.gemScore)}}>{p.gemScore}</span></div>
                  ))}
                </div>
              </div>
            </td></tr>
          ])}
        </tbody>
      </table>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ALERTS VIEW
// ─────────────────────────────────────────────────────────────────────────────
function AlertsView({alerts,alertsRead,onRead,onReadAll}) {
  const [filter,setFilter]=useState("All"), [expanded,setExpanded]=useState(null);
  const types=["All","Portal Entry","Commitment","Stat Update","Model Update","System"];
  const filtered=filter==="All"?alerts:alerts.filter(a=>a.type===filter);
  const unread=alerts.filter(a=>!alertsRead.includes(a.id)).length;
  return (
    <div style={{padding:"24px 28px",overflowY:"auto",flex:1}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
        <div>
          <h1 style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:26,letterSpacing:1,color:"#e2e8f0",margin:0}}>PORTAL ALERTS</h1>
          <p style={{fontSize:12,color:"#4a5568",margin:"4px 0 0"}}>{unread} unread · last 7 days</p>
        </div>
        <button onClick={onReadAll} style={{padding:"7px 14px",background:"rgba(255,255,255,.04)",border:"1px solid rgba(255,255,255,.08)",borderRadius:6,cursor:"pointer",color:"#94a3b8",fontFamily:"'DM Sans',sans-serif",fontSize:12}}>Mark all read</button>
      </div>
      <div style={{display:"flex",gap:6,marginBottom:18,flexWrap:"wrap"}}>
        {types.map(t=><button key={t} onClick={()=>setFilter(t)} aria-pressed={filter===t} style={{padding:"4px 12px",borderRadius:4,fontSize:11,fontWeight:600,cursor:"pointer",background:filter===t?"rgba(246,173,85,.15)":"rgba(255,255,255,.04)",border:`1px solid ${filter===t?"rgba(246,173,85,.4)":"rgba(255,255,255,.08)"}`,color:filter===t?"#f6ad55":"#718096",fontFamily:"'DM Sans',sans-serif"}}>{t}</button>)}
      </div>
      {filtered.length===0?<p style={{fontSize:14,color:"#4a5568",textAlign:"center",padding:"40px 0"}}>You're all caught up. New portal activity will appear here.</p>
        :<ul style={{margin:0,padding:0,listStyle:"none"}}>
          {filtered.map(a=>{const isRead=alertsRead.includes(a.id),isExp=expanded===a.id,dotColor=a.type==="Portal Entry"?"#22c55e":a.type==="Commitment"?"#4ade80":a.type==="Stat Update"?"#93c5fd":a.type==="Model Update"?"#f6ad55":"#718096";return(
            <li key={a.id} style={{marginBottom:6}}>
              <div onClick={()=>{setExpanded(isExp?null:a.id);onRead(a.id);}} style={{display:"flex",gap:12,padding:"12px 14px",cursor:"pointer",borderRadius:8,background:isRead?"rgba(255,255,255,.02)":"rgba(255,255,255,.05)",border:`1px solid ${isRead?"rgba(255,255,255,.04)":"rgba(255,255,255,.1)"}`,transition:"background .1s"}}>
                <div style={{width:8,height:8,borderRadius:"50%",background:dotColor,marginTop:4,flexShrink:0}}/>
                <div style={{flex:1}}>
                  <div style={{display:"flex",gap:8,alignItems:"center"}}>
                    <span style={{fontSize:13,color:isRead?"#94a3b8":"#e2e8f0",fontWeight:isRead?400:500}}>{a.title}</span>
                    <span style={{fontSize:10,padding:"2px 6px",borderRadius:3,background:"rgba(255,255,255,.05)",color:"#4a5568"}}>{a.type}</span>
                  </div>
                  {isExp&&<p style={{fontSize:12,color:"#94a3b8",margin:"6px 0 0",lineHeight:1.6}}>{a.body}</p>}
                </div>
                <span style={{...S.mono,fontSize:10,color:"#4a5568",flexShrink:0}}>{a.time}</span>
              </div>
            </li>
          );})}
        </ul>
      }
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SETTINGS VIEW
// ─────────────────────────────────────────────────────────────────────────────
function SettingsView({settings,onSave}) {
  const [local,setLocal]=useState(settings);
  const s=(key,val)=>setLocal(prev=>({...prev,[key]:val}));
  return (
    <div style={{padding:"24px 28px",overflowY:"auto",flex:1,maxWidth:640}}>
      <h1 style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:26,letterSpacing:1,color:"#e2e8f0",margin:"0 0 24px"}}>SETTINGS</h1>
      {[{title:"Profile",fields:[{label:"Program Name",key:"programName",type:"text",placeholder:"e.g. UTSA Baseball"},{label:"Conference",key:"conference",type:"text",placeholder:"e.g. Conference USA"},{label:"Head Coach",key:"headCoach",type:"text",placeholder:"e.g. Coach Smith"}]},{title:"Projection Settings",fields:[{label:"Target Competition Level",key:"targetLevel",type:"select",opts:["C-USA","Sun Belt","MWC","MAC","WAC","Big West"]},{label:"Annual Scholarship Budget ($)",key:"budget",type:"number",placeholder:"35000"}]}].map(section=>(
        <div key={section.title} style={{...S.card,marginBottom:16}}>
          <h2 style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:16,color:"#f6ad55",letterSpacing:.5,margin:"0 0 14px"}}>{section.title.toUpperCase()}</h2>
          {section.fields.map(f=>(
            <div key={f.key} style={{marginBottom:12}}>
              <label htmlFor={f.key} style={{...S.label,display:"block",marginBottom:6}}>{f.label}</label>
              {f.type==="select"?<select id={f.key} value={local[f.key]||""} onChange={e=>s(f.key,e.target.value)} style={{width:"100%",background:"rgba(255,255,255,.05)",border:"1px solid rgba(255,255,255,.08)",color:"#e2e8f0",borderRadius:6,padding:"7px 10px",fontFamily:"'DM Sans',sans-serif",fontSize:13}}>{f.opts.map(o=><option key={o}>{o}</option>)}</select>
                :<input id={f.key} type={f.type} value={local[f.key]||""} onChange={e=>s(f.key,e.target.value)} placeholder={f.placeholder} style={{width:"100%",background:"rgba(255,255,255,.05)",border:"1px solid rgba(255,255,255,.08)",color:"#e2e8f0",borderRadius:6,padding:"7px 10px",fontFamily:"'DM Sans',sans-serif",fontSize:13,boxSizing:"border-box"}}/>}
            </div>
          ))}
        </div>
      ))}
      <div style={{...S.card,marginBottom:16}}>
        <h2 style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:16,color:"#f6ad55",letterSpacing:.5,margin:"0 0 14px"}}>ALERT PREFERENCES</h2>
        {[{label:"New portal entries matching roster needs",key:"alertNeeds"},{label:"Gem score > 75 players enter portal",key:"alertGem"},{label:"Commitments in target conferences",key:"alertCommit"}].map(opt=>(
          <label key={opt.key} style={{display:"flex",alignItems:"center",gap:10,marginBottom:10,cursor:"pointer"}}>
            <input type="checkbox" checked={!!local[opt.key]} onChange={e=>s(opt.key,e.target.checked)} style={{accentColor:"#f6ad55",width:16,height:16}}/>
            <span style={{fontSize:13,color:"#94a3b8"}}>{opt.label}</span>
          </label>
        ))}
      </div>
      <button onClick={()=>onSave(local)} style={{padding:"10px 24px",background:"rgba(246,173,85,.15)",border:"1px solid rgba(246,173,85,.3)",borderRadius:6,cursor:"pointer",color:"#f6ad55",fontFamily:"'DM Sans',sans-serif",fontSize:13,fontWeight:500}}>Save Settings</button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SCOUT BOARD
// ─────────────────────────────────────────────────────────────────────────────
function ScoutBoard({players,filters,onFilter,onReset,sort,onSort,selected,onSelect,watchlist,onWatch,compareIds,onCompare}) {
  const filtered=useMemo(()=>filterPlayers(players,filters),[players,filters]);
  const sorted=useMemo(()=>sortPlayers(filtered,sort),[filtered,sort]);
  const activeFilterCount=[filters.positions.length,filters.conferences.length&&filters.conferences.length<5?1:0,filters.statuses.length&&filters.statuses.length<4?1:0,filters.years.length&&filters.years.length<3?1:0,filters.flags.length,filters.gemRange[0]>0||filters.gemRange[1]<100?1:0,filters.riskRange[0]>0||filters.riskRange[1]<100?1:0].reduce((a,b)=>a+b,0);
  const thStyle=(col)=>({padding:"0 8px 8px",fontSize:10,fontWeight:600,letterSpacing:".08em",color:sort.primary.col===col?"#f6ad55":"#4a5568",textTransform:"uppercase",textAlign:col==="name"?"left":"right",userSelect:"none",cursor:"pointer",background:"#0f1623",position:"sticky",top:0,zIndex:2,whiteSpace:"nowrap"});
  const onColSort=(col)=>{if(sort.primary.col===col)onSort({...sort,primary:{col,dir:sort.primary.dir==="desc"?"asc":"desc"}});else onSort({...sort,primary:{col,dir:"desc"}});};
  return (
    <div style={{display:"flex",flex:1,overflow:"hidden"}}>
      <FilterSidebar filters={filters} onFilter={onFilter} onReset={onReset}/>
      <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
        <div style={{padding:"10px 16px",borderBottom:"1px solid rgba(255,255,255,.06)",display:"flex",alignItems:"center",gap:10,background:"#0c111b",flexShrink:0,flexWrap:"wrap"}}>
          <div style={{position:"relative",flex:"0 0 200px"}}>
            <label htmlFor="search" style={{position:"absolute",left:-9999,top:0}}>Search players</label>
            <input id="search" type="search" placeholder="Search player or school…" value={filters.search} onChange={e=>onFilter("search",e.target.value)} style={{width:"100%",background:"rgba(255,255,255,.05)",border:"1px solid rgba(255,255,255,.08)",color:"#e2e8f0",borderRadius:6,padding:"6px 10px",fontFamily:"'DM Sans',sans-serif",fontSize:13,boxSizing:"border-box"}}/>
          </div>
          <div aria-live="polite" aria-atomic="true" style={{fontSize:12,color:"#4a5568"}}>
            Showing <strong style={{color:"#e2e8f0"}}>{sorted.length}</strong> of {players.length} players{activeFilterCount>0&&` · ${activeFilterCount} filter${activeFilterCount>1?"s":""} active`}
          </div>
          {compareIds.length>1&&<div style={{marginLeft:"auto"}}><button onClick={()=>onCompare("__open__")} style={{padding:"7px 16px",background:"rgba(147,197,253,.15)",border:"1px solid rgba(147,197,253,.3)",borderRadius:6,cursor:"pointer",color:"#93c5fd",fontFamily:"'DM Sans',sans-serif",fontSize:12,fontWeight:500}}>Compare ({compareIds.length})</button></div>}
          <button onClick={()=>{const header=["Name","Pos","School","Conf","Year","JUCO OPS","Proj OPS","Gem","Risk","Surplus","Status"];const rows=sorted.map(p=>[p.name,p.pos,p.school,p.conf,p.year,getMainStat(p)?.toFixed(3)??"",getProjStat(p)?.toFixed(3)??"",p.gemScore,p.riskScore,p.surplus,p.status]);const csv=[header,...rows].map(r=>r.join(",")).join("\n");const a=document.createElement("a");a.href="data:text/csv;charset=utf-8,"+encodeURIComponent(csv);a.download="draftboard_export.csv";a.click();}} style={{padding:"6px 12px",background:"rgba(255,255,255,.04)",border:"1px solid rgba(255,255,255,.08)",borderRadius:6,cursor:"pointer",color:"#718096",fontFamily:"'DM Sans',sans-serif",fontSize:11,marginLeft:"auto"}}>Export CSV</button>
        </div>
        <div style={{overflowY:"auto",flex:1,overflowX:"auto"}}>
          <table role="grid" style={{width:"100%",borderCollapse:"collapse",minWidth:700}}>
            <thead>
              <tr>
                <th scope="col" style={{...thStyle(""),textAlign:"center",width:36}}><span style={{position:"absolute",left:-9999}}>Select</span></th>
                <th scope="col" aria-sort={sort.primary.col==="name"?(sort.primary.dir==="asc"?"ascending":"descending"):"none"} style={{...thStyle("name"),textAlign:"left"}} onClick={()=>onColSort("name")}>Player {sort.primary.col==="name"?sort.primary.dir==="asc"?"↑":"↓":""}</th>
                <th scope="col" style={thStyle("stat")} onClick={()=>onColSort("stat")}>JUCO</th>
                <th scope="col" style={thStyle("projStat")} onClick={()=>onColSort("projStat")}>Proj</th>
                <th scope="col" style={thStyle("")}>Trend</th>
                <th scope="col" aria-sort={sort.primary.col==="gemScore"?(sort.primary.dir==="asc"?"ascending":"descending"):"none"} style={{...thStyle("gemScore"),textAlign:"right"}} onClick={()=>onColSort("gemScore")}>Gem {sort.primary.col==="gemScore"?sort.primary.dir==="asc"?"↑":"↓":""}</th>
                <th scope="col" aria-sort={sort.primary.col==="riskScore"?(sort.primary.dir==="asc"?"ascending":"descending"):"none"} style={thStyle("riskScore")} onClick={()=>onColSort("riskScore")}>Risk {sort.primary.col==="riskScore"?sort.primary.dir==="asc"?"↑":"↓":""}</th>
                <th scope="col" aria-sort={sort.primary.col==="surplus"?(sort.primary.dir==="asc"?"ascending":"descending"):"none"} style={thStyle("surplus")} onClick={()=>onColSort("surplus")}>Surplus {sort.primary.col==="surplus"?sort.primary.dir==="asc"?"↑":"↓":""}</th>
                <th scope="col" style={thStyle("")}>D1 Prob</th>
                <th scope="col" style={thStyle("")}>Status</th>
                <th scope="col" style={{...thStyle(""),textAlign:"center",width:44}}>★</th>
              </tr>
            </thead>
            <tbody>
              {sorted.length===0?<tr><td colSpan={11} style={{padding:"40px",textAlign:"center",fontSize:14,color:"#4a5568"}}>No players match your filters. Try broadening your position or conference selection.</td></tr>
                :sorted.map(p=><PlayerRow key={p.id} p={p} selected={selected===p.id} onSelect={onSelect} onWatch={onWatch} onCompare={onCompare} watched={watchlist.includes(p.id)} inCompare={compareIds.includes(p.id)}/>)}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TOP NAV
// ─────────────────────────────────────────────────────────────────────────────
function TopNav({view,onNav,watchlistCount,unreadAlerts,onCmd,settings,UserButtonComponent}) {
  const navItems=[{id:"home",label:"Home"},{id:"board",label:"Scout Board"},{id:"watchlist",label:`Watchlist (${watchlistCount})`},{id:"conferences",label:"Conferences"},{id:"alerts",label:`Alerts${unreadAlerts>0?` (${unreadAlerts})`:""}`}];
  return (
    <nav aria-label="Main navigation" style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"0 24px",height:52,borderBottom:"1px solid rgba(255,255,255,.07)",background:"#0a0f1a",position:"sticky",top:0,zIndex:10,flexShrink:0}}>
      <div style={{display:"flex",alignItems:"center",gap:20}}>
        <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:22,letterSpacing:2,color:"#f6ad55",lineHeight:1}}>DRAFTBOARD<span style={{color:"#4a5568",marginLeft:2}}>PRO</span></div>
        <div style={{width:1,height:20,background:"rgba(255,255,255,.08)"}}/>
        {navItems.map(({id,label})=>(
          <button key={id} onClick={()=>onNav(id)} aria-current={view===id?"page":undefined}
            style={{background:view===id?"rgba(246,173,85,.08)":"none",border:"none",cursor:"pointer",fontFamily:"'DM Sans',sans-serif",fontSize:13,padding:"6px 10px",borderRadius:4,color:view===id?"#f6ad55":"#718096",transition:"all .15s"}}>
            {label}
          </button>
        ))}
      </div>
      <div style={{display:"flex",alignItems:"center",gap:8}}>
        <div style={{...S.mono,fontSize:11,color:"#4a5568"}}>PORTAL <span style={{color:"#4ade80"}}>● LIVE</span></div>
        <button onClick={onCmd} aria-label="Open command palette (⌘K)" style={{background:"rgba(255,255,255,.04)",border:"1px solid rgba(255,255,255,.08)",borderRadius:6,cursor:"pointer",color:"#718096",fontFamily:"'DM Mono',monospace",fontSize:11,padding:"4px 10px"}}>⌘K</button>
        <button onClick={()=>onNav("settings")} aria-label="Open settings" style={{background:"none",border:"none",cursor:"pointer",color:"#718096",fontSize:16,minWidth:36,minHeight:36,display:"flex",alignItems:"center",justifyContent:"center"}}>⚙</button>
        {UserButtonComponent
          ? <UserButtonComponent afterSignOutUrl="/"/>
          : <div style={{width:30,height:30,borderRadius:"50%",background:"linear-gradient(135deg,#f6ad55,#ed8936)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:700,color:"#0c111b",fontFamily:"'DM Mono',monospace",cursor:"default"}}>
              {(settings.headCoach||"C").charAt(0).toUpperCase()}
            </div>
        }
      </div>
    </nav>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ROOT APP
// ─────────────────────────────────────────────────────────────────────────────
export default function App() {
  // ── Auth ──────────────────────────────────────────────────────────────────
  const clerkAvailable = !!import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
  const authHook = clerkAvailable ? useUser() : { isSignedIn: true, user: { id: "local" } };
  const { isSignedIn, user } = authHook;
  const userId = user?.id || "local";

  // ── Live data fetch ────────────────────────────────────────────────────────
  const [players, setPlayers]     = useState([]);
  const [dataLoading, setLoading] = useState(true);
  const [dataError, setError]     = useState(null);

  useEffect(() => {
    if (SHEETDB_URL.includes("REPLACE_WITH_YOUR_ID")) {
      // Demo mode: load a minimal placeholder set so the app still renders
      setPlayers([]);
      setLoading(false);
      return;
    }
    fetch(SHEETDB_URL)
      .then(res => { if (!res.ok) throw new Error(`SheetDB ${res.status}`); return res.json(); })
      .then(rows => { setPlayers(rows.map(parsePlayer)); setLoading(false); })
      .catch(err => { setError(err.message); setLoading(false); });
  }, []);

  // ── Persistent state (user-scoped) ─────────────────────────────────────────
  const [watchlist,      setWatchlist]      = useLocalStorage(`dbp_watchlist_${userId}`,      []);
  const [watchPriorities,setWatchPriorities]= useLocalStorage(`dbp_priorities_${userId}`,      {});
  const [notes,          setNotes]          = useLocalStorage(`dbp_notes_${userId}`,           {});
  const [settings,       setSettings]       = useLocalStorage(`dbp_settings_${userId}`,        {programName:"",conference:"C-USA",headCoach:"",targetLevel:"C-USA",budget:35000,alertNeeds:true,alertGem:true,alertCommit:true});
  const [alertsRead,     setAlertsRead]     = useLocalStorage(`dbp_alertsread_${userId}`,      ["a3","a4","a5","a6","a7","a8"]);

  // ── UI state ───────────────────────────────────────────────────────────────
  const [view,        setView]       = useState("home");
  const [selected,    setSelected]   = useState(null);
  const [filters,     setFilters]    = useState(INIT_FILTERS);
  const [sort,        setSort]       = useState(INIT_SORT);
  const [compareIds,  setCompareIds] = useState([]);
  const [compareOpen, setCmpOpen]    = useState(false);
  const [cmdOpen,     setCmdOpen]    = useState(false);

  const unreadAlerts   = ALERTS.filter(a => !alertsRead.includes(a.id)).length;
  const selPlayer      = useMemo(() => selected ? players.find(p => p.id === selected) : null, [selected, players]);
  const comparePlayers = useMemo(() => compareIds.map(id => players.find(p => p.id === id)).filter(Boolean), [compareIds, players]);

  // ── Global keyboard shortcuts ──────────────────────────────────────────────
  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") { e.preventDefault(); setCmdOpen(true); }
      if (e.key === "Escape") { setSelected(null); setCmdOpen(false); setCmpOpen(false); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const onFilter  = (key, val) => setFilters(f => ({...f, [key]: val}));
  const onReset   = () => setFilters(INIT_FILTERS);
  const onWatch   = (id) => setWatchlist(w => w.includes(id) ? w.filter(x => x !== id) : [...w, id]);
  const onPriority= (id, tier) => setWatchPriorities(p => ({...p, [id]: tier}));
  const onReorder = (fromId, toId) => setWatchlist(w => { const a=[...w],fi=a.indexOf(fromId),ti=a.indexOf(toId); if(fi<0||ti<0)return a; a.splice(fi,1); a.splice(ti,0,fromId); return a; });
  const onNote    = (pid, note) => setNotes(n => ({...n, [pid]: [...(n[pid]||[]), note]}));
  const onCompare = (id) => {
    if (id==="__open__") { setCmpOpen(true); return; }
    setCompareIds(ids => ids.includes(id) ? ids.filter(x=>x!==id) : ids.length<4 ? [...ids,id] : ids);
  };

  // ── Auth gate ──────────────────────────────────────────────────────────────
  if (clerkAvailable && !isSignedIn) {
    return (
      <div style={{minHeight:"100vh",background:"#0c111b",display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:24}}>
        <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&family=Bebas+Neue&display=swap" rel="stylesheet"/>
        <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:36,letterSpacing:3,color:"#f6ad55"}}>DRAFTBOARD PRO</div>
        <div style={{fontSize:13,color:"#4a5568"}}>Sign in to access recruiting analytics</div>
        {SignIn && <SignIn/>}
      </div>
    );
  }

  // ── Loading / error states ─────────────────────────────────────────────────
  if (dataLoading) return (
    <div style={{minHeight:"100vh",background:"#0c111b",display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:16}}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&family=Bebas+Neue&display=swap" rel="stylesheet"/>
      <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:28,letterSpacing:2,color:"#f6ad55"}}>DRAFTBOARD PRO</div>
      <div style={{fontSize:13,color:"#4a5568",fontFamily:"'DM Sans',sans-serif"}}>Loading player data…</div>
    </div>
  );

  if (dataError) return (
    <div style={{minHeight:"100vh",background:"#0c111b",display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:16}}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&family=Bebas+Neue&display=swap" rel="stylesheet"/>
      <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:28,letterSpacing:2,color:"#f87171"}}>DATA ERROR</div>
      <div style={{fontSize:13,color:"#94a3b8",fontFamily:"'DM Sans',sans-serif",maxWidth:400,textAlign:"center"}}>
        Could not load player data: {dataError}.<br/>Check that your SheetDB URL is correct and the sheet is public.
      </div>
    </div>
  );

  // ── Main render ────────────────────────────────────────────────────────────
  return (
    <div style={{minHeight:"100vh",background:"#0c111b",color:"#e2e8f0",fontFamily:"'DM Sans','Helvetica Neue',sans-serif",display:"flex",flexDirection:"column"}}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&family=Bebas+Neue&display=swap" rel="stylesheet"/>
      <style>{`
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:4px;height:4px}
        ::-webkit-scrollbar-track{background:#0c111b}
        ::-webkit-scrollbar-thumb{background:#2d3748;border-radius:2px}
        :focus-visible{outline:2px solid #f6ad55!important;outline-offset:2px}
        button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,[tabindex]:focus-visible{outline:2px solid #f6ad55!important;outline-offset:2px}
        @keyframes fadeIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
        @keyframes slideInRight{from{transform:translateX(100%)}to{transform:translateX(0)}}
        @media(prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}}
        input[type=range]{-webkit-appearance:none;appearance:none;height:4px;border-radius:2px;background:rgba(255,255,255,.1);cursor:pointer}
        input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;border-radius:50%;background:#f6ad55;cursor:pointer}
      `}</style>

      <TopNav view={view} onNav={setView} watchlistCount={watchlist.length} unreadAlerts={unreadAlerts} onCmd={()=>setCmdOpen(true)} settings={settings} UserButtonComponent={clerkAvailable?UserButton:null}/>

      <main style={{display:"flex",flex:1,overflow:"hidden",position:"relative"}}>
        {view==="home"       && <HomeView players={players} watchlist={watchlist} alerts={ALERTS} onNav={setView} onSelect={id=>{setSelected(id);setView("board");}}/>}
        {view==="board"      && <ScoutBoard players={players} filters={filters} onFilter={onFilter} onReset={onReset} sort={sort} onSort={setSort} selected={selected} onSelect={setSelected} watchlist={watchlist} onWatch={onWatch} compareIds={compareIds} onCompare={onCompare}/>}
        {view==="watchlist"  && <WatchlistView players={players} watchlist={watchlist} priorities={watchPriorities} onRemove={onWatch} onPriority={onPriority} onSelect={id=>{setSelected(id);setView("board");}} onReorder={onReorder}/>}
        {view==="conferences"&& <ConferencesView players={players}/>}
        {view==="alerts"     && <AlertsView alerts={ALERTS} alertsRead={alertsRead} onRead={id=>setAlertsRead(a=>a.includes(id)?a:[...a,id])} onReadAll={()=>setAlertsRead(ALERTS.map(a=>a.id))}/>}
        {view==="settings"   && <SettingsView settings={settings} onSave={setSettings}/>}
        {selPlayer && <PlayerDetailPanel player={selPlayer} onClose={()=>setSelected(null)} watched={watchlist.includes(selPlayer.id)} onWatch={onWatch} notes={notes} onNote={onNote}/>}
      </main>

      {cmdOpen      && <CommandPalette players={players} onClose={()=>setCmdOpen(false)} onSelect={id=>{setSelected(id);setView("board");}}/>}
      {compareOpen  && comparePlayers.length>1 && <CompareModal players={comparePlayers} onClose={()=>{setCmpOpen(false);setCompareIds([]);}}/>}
    </div>
  );
}

