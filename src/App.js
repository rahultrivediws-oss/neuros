import { useState, useRef, useCallback, useEffect, createContext, useContext } from "react";

// 🔑 YOUR GROQ KEY
const GROQ_KEY = process.env.REACT_APP_GROQ_KEY || "YOUR_GROQ_KEY_HERE";
const MODEL = "llama-3.3-70b-versatile";
const F = "-apple-system, 'Segoe UI', Roboto, sans-serif";
const ACCENT = "#10a37f";
const bg0 = "#212121", bg1 = "#2f2f2f", bg2 = "#3f3f3f";
const border = "#444654", textPrimary = "#ececec", textMuted = "#8e8ea0";


// ── Mobile detection hook ─────────────────────────────────────────────────────
function useIsMobile() {
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, []);
  return isMobile;
}

// ══════════════════════════════════════════════════════════════════════════════
// GLOBAL STATE CONTEXT — data persists across ALL tab switches
// ══════════════════════════════════════════════════════════════════════════════
const AppContext = createContext(null);
function useApp() { return useContext(AppContext); }

function AppProvider({ children }) {
  // Shared dataset — upload once, use everywhere
  const [globalCsv, setGlobalCsv]         = useState("");
  const [globalFileName, setGlobalFileName] = useState("");
  const [globalHeaders, setGlobalHeaders]   = useState([]);
  const [globalRows, setGlobalRows]         = useState([]);
  const [maskedCols, setMaskedCols]         = useState(new Set());

  // Per-tab state preserved
  const [talkMessages, setTalkMessages]     = useState([]);
  const [talkLoaded, setTalkLoaded]         = useState(false);
  const [predictResult, setPredictResult]   = useState(null);
  const [reportResult, setReportResult]     = useState(null);
  const [anomalyResult, setAnomalyResult]   = useState(null);

  // Phase 2 — multi-table
  const [datasets, setDatasets]             = useState([]);   // [{name, csv, headers, rows}]

  // Scheduled reports config
  const [schedules, setSchedules]           = useState(() => {
    try { return JSON.parse(localStorage.getItem("neuros_schedules") || "[]"); } catch { return []; }
  });

  // Saved analyses
  const [saved, setSaved]                   = useState(() => {
    try { return JSON.parse(localStorage.getItem("neuros_saved") || "[]"); } catch { return []; }
  });

  function loadDataset(text, fileName) {
    const p = parseCSV(text);
    if (!p) return;
    setGlobalCsv(text);
    setGlobalFileName(fileName || "dataset.csv");
    setGlobalHeaders(p.headers);
    setGlobalRows(p.rows);
    const pii = detectPIIColumns(p.headers);
    setMaskedCols(new Set(pii));
    logAction("Upload", `${fileName} — ${p.rows.length} rows, ${p.headers.length} cols`);
    // Add to multi-table registry
    setDatasets(prev => {
      const exists = prev.find(d => d.name === fileName);
      if (exists) return prev.map(d => d.name === fileName ? { name: fileName, csv: text, headers: p.headers, rows: p.rows } : d);
      return [...prev, { name: fileName, csv: text, headers: p.headers, rows: p.rows }];
    });
  }

  function saveAnalysis(name, data) {
    const entry = { id: Date.now(), name, data, savedAt: new Date().toLocaleString() };
    const next = [entry, ...saved].slice(0, 30);
    setSaved(next);
    try { localStorage.setItem("neuros_saved", JSON.stringify(next)); } catch {}
    logAction("Save", name);
  }

  function removeAnalysis(id) {
    const next = saved.filter(s => s.id !== id);
    setSaved(next);
    try { localStorage.setItem("neuros_saved", JSON.stringify(next)); } catch {}
  }

  function addSchedule(s) {
    const next = [...schedules, { ...s, id: Date.now() }];
    setSchedules(next);
    try { localStorage.setItem("neuros_schedules", JSON.stringify(next)); } catch {}
    logAction("Schedule", `${s.frequency} report to ${s.email}`);
  }

  function removeSchedule(id) {
    const next = schedules.filter(s => s.id !== id);
    setSchedules(next);
    try { localStorage.setItem("neuros_schedules", JSON.stringify(next)); } catch {}
  }

  function getMaskedCSV() {
    if (!maskedCols.size) return globalCsv;
    const lines = globalCsv.split("\n");
    const hdrs = lines[0]?.split(",").map(h => h.trim()) || [];
    const maskedIdx = hdrs.map((h, i) => maskedCols.has(h) ? i : -1).filter(i => i >= 0);
    return lines.map((line, li) => {
      if (li === 0) return line;
      const vals = line.split(",");
      maskedIdx.forEach(i => { if (vals[i] !== undefined) vals[i] = "***"; });
      return vals.join(",");
    }).join("\n");
  }

  return (
    <AppContext.Provider value={{
      globalCsv, globalFileName, globalHeaders, globalRows, maskedCols, setMaskedCols,
      loadDataset, getMaskedCSV,
      talkMessages, setTalkMessages, talkLoaded, setTalkLoaded,
      predictResult, setPredictResult,
      reportResult, setReportResult,
      anomalyResult, setAnomalyResult,
      datasets, schedules, addSchedule, removeSchedule,
      saved, saveAnalysis, removeAnalysis,
    }}>
      {children}
    </AppContext.Provider>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ══════════════════════════════════════════════════════════════════════════════
async function loadSheetJS() {
  if (window.XLSX) return window.XLSX;
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
    s.onload = () => resolve(window.XLSX); s.onerror = reject;
    document.head.appendChild(s);
  });
}

async function readFile(file) {
  const ext = file.name.split(".").pop().toLowerCase();
  if (["csv", "txt"].includes(ext)) return new Promise((res, rej) => { const r = new FileReader(); r.onload = e => res(e.target.result); r.onerror = rej; r.readAsText(file); });
  if (["xlsx", "xls", "ods"].includes(ext)) {
    const XLSX = await loadSheetJS();
    return new Promise((res, rej) => { const r = new FileReader(); r.onload = e => { try { const wb = XLSX.read(e.target.result, { type: "array" }); res(XLSX.utils.sheet_to_csv(wb.Sheets[wb.SheetNames[0]])); } catch (err) { rej(err); } }; r.onerror = rej; r.readAsArrayBuffer(file); });
  }
  throw new Error("Use CSV, XLSX or XLS");
}

function parseCSV(text) {
  const lines = text.trim().split("\n").filter(Boolean);
  if (lines.length < 2) return null;
  const headers = lines[0].split(",").map(h => h.trim().replace(/"/g, ""));
  const rows = lines.slice(1).map(line => {
    const vals = line.split(",").map(v => v.trim().replace(/"/g, ""));
    const obj = {}; headers.forEach((h, i) => { obj[h] = isNaN(vals[i]) || vals[i] === "" ? vals[i] : parseFloat(vals[i]); }); return obj;
  });
  return { headers, rows };
}

function calcStats(values) {
  const n = values.length; if (!n) return {};
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const stdDev = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / n);
  const q1 = sorted[Math.floor(n * 0.25)], median = sorted[Math.floor(n * 0.5)], q3 = sorted[Math.floor(n * 0.75)];
  const iqr = q3 - q1;
  return { mean, stdDev, median, q1, q3, iqr, outliers: values.filter(v => v < q1 - 1.5 * iqr || v > q3 + 1.5 * iqr), min: sorted[0], max: sorted[n - 1], n };
}

function calcCorrelation(xs, ys) {
  const n = Math.min(xs.length, ys.length), mx = xs.slice(0,n).reduce((s,v)=>s+v,0)/n, my = ys.slice(0,n).reduce((s,v)=>s+v,0)/n;
  const num = xs.slice(0,n).reduce((s,v,i)=>s+(v-mx)*(ys[i]-my),0);
  const den = Math.sqrt(xs.slice(0,n).reduce((s,v)=>s+(v-mx)**2,0)*ys.slice(0,n).reduce((s,v)=>s+(v-my)**2,0));
  return den===0?0:num/den;
}

function movingAverage(values, w=3) { return values.map((_,i) => i<w-1?null:values.slice(i-w+1,i+1).reduce((s,v)=>s+v,0)/w); }

function detectPIIColumns(headers) {
  return headers.filter(h => /email|phone|mobile|ssn|pan|aadhar|address|dob|birth|passport|credit|card|account|salary|income|name|gender|age/i.test(h));
}

const auditLog = [];
function logAction(action, detail="") { auditLog.unshift({ time: new Date().toLocaleTimeString(), action, detail, user: "You" }); if (auditLog.length>100) auditLog.pop(); }

async function askAI(prompt, maxTokens=2000) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method:"POST", headers:{"Content-Type":"application/json","Authorization":`Bearer ${GROQ_KEY}`},
    body: JSON.stringify({ model:MODEL, messages:[{role:"user",content:prompt}], temperature:0.4, max_tokens:maxTokens }),
  });
  if (!res.ok) { const e = await res.json(); throw new Error(e.error?.message||`Error ${res.status}`); }
  const d = await res.json(), raw = d.choices?.[0]?.message?.content||"", m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("AI format error. Try again.");
  try { return JSON.parse(m[0]); } catch { return JSON.parse(m[0].replace(/,(\s*[}\]])/g,"$1").replace(/:\s*'([^']*)'/g,': "$1"')); }
}

function downloadHTML(html, title="NEUROS Report") {
  const full=`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title><style>body{font-family:-apple-system,'Segoe UI',sans-serif;background:#fff;color:#111;padding:40px;max-width:900px;margin:auto;line-height:1.8}h1{font-size:26px;border-bottom:2px solid #10a37f;padding-bottom:10px}h2{font-size:15px;color:#333;margin-top:28px;text-transform:uppercase;letter-spacing:1px}.metrics{display:flex;flex-wrap:wrap;gap:12px;margin:16px 0}.metric{background:#f5f5f5;border:1px solid #ddd;padding:12px 18px;border-radius:8px;min-width:130px}.metric-val{font-size:22px;font-weight:900}.metric-label{font-size:11px;color:#888}table{width:100%;border-collapse:collapse;margin:16px 0;font-size:12px}th{background:#212121;color:#fff;padding:9px 12px;text-align:left}td{border-bottom:1px solid #eee;padding:8px 12px}.tag{display:inline-block;padding:2px 10px;border-radius:20px;font-size:11px;font-weight:700;margin:2px}.good{background:#e6fff9;color:#007755}.bad{background:#fff0eb;color:#cc4400}.warn{background:#fffbe6;color:#997700}.section{background:#fafafa;border-left:4px solid #10a37f;padding:14px 18px;margin:14px 0;border-radius:0 8px 8px 0}.reasoning{background:#f0f8ff;border:1px solid #cce;padding:12px 16px;border-radius:8px;margin:12px 0;font-family:monospace;font-size:12px}@media print{button{display:none!important}}</style></head><body><button onclick="window.print()" style="background:#10a37f;color:#fff;border:none;padding:10px 24px;border-radius:8px;cursor:pointer;margin-bottom:24px;font-size:13px">🖨️ Print / Save as PDF</button>${html}<p style="color:#aaa;font-size:11px;margin-top:40px;border-top:1px solid #eee;padding-top:12px">Generated by NEUROS Enterprise</p></body></html>`;
  const blob=new Blob([full],{type:"text/html"}),url=URL.createObjectURL(blob),a=document.createElement("a");
  a.href=url;a.download=title.replace(/\s+/g,"-")+".html";a.click();URL.revokeObjectURL(url);
}

function downloadCSV(rows, filename="neuros.csv") {
  if (!rows?.length) return;
  const h=Object.keys(rows[0]),lines=[h.join(","),...rows.map(r=>h.map(k=>JSON.stringify(r[k]??"")).join(","))];
  const blob=new Blob([lines.join("\n")],{type:"text/csv"}),url=URL.createObjectURL(blob),a=document.createElement("a");
  a.href=url;a.download=filename;a.click();URL.revokeObjectURL(url);
}

// ══════════════════════════════════════════════════════════════════════════════
// UI PRIMITIVES
// ══════════════════════════════════════════════════════════════════════════════
const Card = ({ children, style={}, color=ACCENT }) => (
  <div style={{ background:bg1, border:`1px solid ${border}`, borderRadius:12, padding:16, ...style }}>{children}</div>
);
const Btn = ({ children, onClick, disabled, color=ACCENT, outline=false, style={} }) => (
  <button onClick={onClick} disabled={disabled} style={{ background:disabled?bg2:outline?"transparent":color, border:`1px solid ${disabled?border:color}`, borderRadius:8, padding:"10px 18px", color:disabled?textMuted:outline?color:"#fff", fontWeight:600, fontSize:13, cursor:disabled?"not-allowed":"pointer", transition:"all .15s", fontFamily:F, whiteSpace:"nowrap", minHeight:44, ...style }}>{children}</button>
);
const Tag = ({ children, color=ACCENT }) => (
  <span style={{ background:color+"22", border:`1px solid ${color}44`, color, padding:"2px 10px", borderRadius:20, fontSize:11 }}>{children}</span>
);
const SectionLabel = ({ children, color=textMuted }) => (
  <div style={{ fontSize:11, fontWeight:600, color, letterSpacing:0.5, marginBottom:10, textTransform:"uppercase" }}>{children}</div>
);
const ScoreRing = ({ score, label, color=ACCENT, size=80 }) => {
  const r=30, c=2*Math.PI*r, pct=Math.min(Math.max(score,0),100)/100;
  return (<div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:4}}>
    <svg width={size} height={size} viewBox="0 0 70 70">
      <circle cx={35} cy={35} r={r} fill="none" stroke={border} strokeWidth={5}/>
      <circle cx={35} cy={35} r={r} fill="none" stroke={color} strokeWidth={5} strokeDasharray={`${pct*c} ${c}`} strokeLinecap="round" transform="rotate(-90 35 35)"/>
      <text x={35} y={39} textAnchor="middle" fontSize={14} fill={textPrimary} fontFamily={F} fontWeight="700">{score}</text>
    </svg>
    <div style={{fontSize:10,color:textMuted,textAlign:"center"}}>{label}</div>
  </div>);
};
const ProgBar = ({ label, value, max=100, color=ACCENT }) => (
  <div style={{marginBottom:10}}>
    <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
      <span style={{fontSize:12,color:textMuted}}>{label}</span>
      <span style={{fontSize:12,color,fontWeight:700}}>{typeof value==="number"?value.toFixed(1):value}</span>
    </div>
    <div style={{height:5,background:border,borderRadius:3}}>
      <div style={{height:"100%",width:`${Math.min((value/max)*100,100)}%`,background:color,borderRadius:3,transition:"width 1s ease"}}/>
    </div>
  </div>
);

const BarChart = ({ data, color=ACCENT, height=120 }) => {
  if (!data?.length) return null;
  const max=Math.max(...data.map(d=>Math.abs(d.value)),1);
  return (<div style={{display:"flex",alignItems:"flex-end",gap:4,height,padding:"0 0 20px"}}>
    {data.slice(0,14).map((d,i)=>(
      <div key={i} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:2,height:"100%",justifyContent:"flex-end"}}>
        <div style={{fontSize:8,color:textMuted}}>{typeof d.value==="number"&&Math.abs(d.value)>999?(d.value/1000).toFixed(1)+"k":d.value}</div>
        <div style={{width:"100%",height:`${(Math.abs(d.value)/max)*85}%`,minHeight:3,background:d.anomaly?"#ff6b35":color,borderRadius:"3px 3px 0 0",opacity:0.85,transition:"height .6s ease"}}/>
        <div style={{fontSize:8,color:textMuted,textAlign:"center",overflow:"hidden",maxWidth:"100%"}}>{String(d.label).slice(0,6)}</div>
      </div>
    ))}
  </div>);
};

const LineChart = ({ data, color=ACCENT, height=140, showBand=false }) => {
  if (!data?.length||data.length<2) return <BarChart data={data} color={color} height={height}/>;
  const vals=data.map(d=>d.value), maVals=movingAverage(vals,3);
  const min=Math.min(...vals), max=Math.max(...vals), range=max-min||1;
  const W=500, H=height-30, toY=v=>H-((v-min)/range)*H;
  const pts=data.map((d,i)=>({x:(i/(data.length-1))*W,y:toY(d.value)}));
  const maPts=maVals.map((v,i)=>v!==null?{x:(i/(data.length-1))*W,y:toY(v)}:null).filter(Boolean);
  const path=pts.map((p,i)=>`${i===0?"M":"L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const maPath=maPts.length>1?maPts.map((p,i)=>`${i===0?"M":"L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" "):"";
  const area=`${path} L${W},${H} L0,${H} Z`;
  const sd=calcStats(vals).stdDev||0;
  const ub=data.map((_,i)=>({x:(i/(data.length-1))*W,y:toY(vals[i]+sd)}));
  const lb=data.map((_,i)=>({x:(i/(data.length-1))*W,y:toY(vals[i]-sd)}));
  const band=[...ub.map((p,i)=>`${i===0?"M":"L"}${p.x},${p.y}`),...lb.reverse().map(p=>`L${p.x},${p.y}`)].join(" ")+"Z";
  const gid=`lg${color.replace("#","")}`;
  return (<div style={{padding:"4px 0 4px"}}>
    <svg width="100%" viewBox={`0 0 ${W} ${H+24}`} style={{overflow:"visible"}}>
      <defs><linearGradient id={gid} x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity="0.2"/><stop offset="100%" stopColor={color} stopOpacity="0.02"/></linearGradient></defs>
      {showBand&&<path d={band} fill={color} opacity={0.08}/>}
      <path d={area} fill={`url(#${gid})`}/>
      <path d={path} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
      {maPath&&<path d={maPath} fill="none" stroke="#f7c549" strokeWidth="1.5" strokeDasharray="5,4" strokeLinecap="round"/>}
      {pts.map((p,i)=>(<g key={i}><circle cx={p.x} cy={p.y} r={3} fill={color}/><text x={p.x} y={H+18} textAnchor="middle" fontSize={9} fill={textMuted} fontFamily={F}>{String(data[i].label).slice(0,5)}</text></g>))}
    </svg>
    {maPath&&<div style={{fontSize:10,color:"#f7c549",marginTop:4}}>— Moving Avg &nbsp;<span style={{color:color+"88"}}>— Actual</span>{showBand&&<span style={{color:color+"44"}}> ∫ Confidence Band</span>}</div>}
  </div>);
};

const ReasoningPanel = ({ steps=[], model=MODEL, confidence=null, timestamp=null }) => {
  const [open,setOpen]=useState(false);
  if (!steps.length) return null;
  return (<div style={{background:bg0,border:`1px solid ${ACCENT}33`,borderRadius:10,overflow:"hidden"}}>
    <div onClick={()=>setOpen(o=>!o)} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 14px",cursor:"pointer"}}>
      <div style={{display:"flex",alignItems:"center",gap:8}}>
        <span style={{fontSize:14}}>🔍</span>
        <span style={{fontSize:12,color:ACCENT,fontWeight:600}}>View AI Reasoning</span>
        <Tag color={ACCENT}>{steps.length} steps</Tag>
      </div>
      <span style={{color:textMuted,fontSize:12}}>{open?"▲":"▼"}</span>
    </div>
    {open&&(<div style={{padding:"0 14px 14px",borderTop:`1px solid ${border}`}}>
      <div style={{display:"flex",gap:16,marginBottom:12,paddingTop:12}}>
        <div style={{fontSize:11,color:textMuted}}>Model: <span style={{color:ACCENT}}>{model}</span></div>
        {confidence&&<div style={{fontSize:11,color:textMuted}}>Confidence: <span style={{color:confidence>70?ACCENT:"#f7c549"}}>{confidence}%</span></div>}
        {timestamp&&<div style={{fontSize:11,color:textMuted}}>Time: <span style={{color:textPrimary}}>{timestamp}</span></div>}
      </div>
      <div style={{fontFamily:"'Courier New',monospace",fontSize:12,background:bg2,borderRadius:8,padding:14}}>
        <div style={{color:ACCENT,marginBottom:8,fontWeight:700}}>Analysis Steps:</div>
        {steps.map((s,i)=><div key={i} style={{marginBottom:6,color:textPrimary}}><span style={{color:ACCENT}}>{i+1}.</span> {s}</div>)}
      </div>
    </div>)}
  </div>);
};

// ── Global Data Banner ────────────────────────────────────────────────────────
function DataBanner() {
  const { globalFileName, globalHeaders, globalRows, maskedCols } = useApp();
  const isMobile = useIsMobile();
  if (!globalFileName) return null;
  return (
    <div style={{ background:`${ACCENT}11`, border:`1px solid ${ACCENT}33`, borderRadius:8, padding:"7px 12px", display:"flex", alignItems:"center", gap:8, marginBottom:10, flexShrink:0, flexWrap:"wrap" }}>
      <span style={{fontSize:13}}>📊</span>
      <span style={{fontSize:12,color:ACCENT,fontWeight:600}}>{globalFileName}</span>
      <span style={{fontSize:11,color:textMuted}}>{globalRows.length} rows · {globalHeaders.length} cols</span>
      {maskedCols.size>0&&<span style={{fontSize:11,color:"#ff9966"}}>🔒 {maskedCols.size} masked</span>}
      {!isMobile&&<span style={{fontSize:11,color:textMuted,marginLeft:"auto"}}>Active across all tabs ✓</span>}
    </div>
  );
}

// ── File Upload ───────────────────────────────────────────────────────────────
function FileUpload({ color=ACCENT, compact=false }) {
  const { loadDataset, globalFileName } = useApp();
  const [dragging,setDragging]=useState(false);
  const [uploading,setUploading]=useState(false);
  const inputRef=useRef(null);
  const handle=useCallback(async(file)=>{
    if (!file) return; setUploading(true);
    try { const text=await readFile(file); loadDataset(text,file.name); }
    catch(e) { alert("File error: "+e.message); }
    setUploading(false);
  },[loadDataset]);
  if (compact && globalFileName) return (
    <div onClick={()=>inputRef.current?.click()} style={{display:"flex",alignItems:"center",gap:8,padding:"7px 12px",background:bg2,border:`1px solid ${border}`,borderRadius:8,cursor:"pointer"}}>
      <input ref={inputRef} type="file" accept=".csv,.xlsx,.xls,.ods,.txt" style={{display:"none"}} onChange={e=>handle(e.target.files[0])}/>
      <span style={{fontSize:11,color:ACCENT}}>📂 {globalFileName}</span>
      <span style={{fontSize:10,color:textMuted}}>· change</span>
    </div>
  );
  return (<div onClick={()=>inputRef.current?.click()}
    onDragOver={e=>{e.preventDefault();setDragging(true);}} onDragLeave={()=>setDragging(false)}
    onDrop={e=>{e.preventDefault();setDragging(false);handle(e.dataTransfer.files[0]);}}
    style={{border:`2px dashed ${dragging?color:border}`,borderRadius:10,padding:14,cursor:"pointer",background:dragging?color+"0d":bg2,textAlign:"center",transition:"all .2s"}}>
    <input ref={inputRef} type="file" accept=".csv,.xlsx,.xls,.ods,.txt" style={{display:"none"}} onChange={e=>handle(e.target.files[0])}/>
    {uploading?<div style={{fontSize:12,color}}>⏳ Reading...</div>
    :globalFileName?<div style={{fontSize:12,color}}>✅ {globalFileName} <span style={{fontSize:10,color:textMuted}}>· click to change</span></div>
    :<><div style={{fontSize:20,marginBottom:4}}>📂</div>
      <div style={{fontSize:12,color,fontWeight:600}}>Drop file or click to upload</div>
      <div style={{fontSize:11,color:textMuted,marginTop:3}}>CSV · XLSX · XLS · ODS</div></>}
  </div>);
}

// ── Data Masking ──────────────────────────────────────────────────────────────
function DataMaskPanel() {
  const { globalHeaders, maskedCols, setMaskedCols } = useApp();
  const piiCols = detectPIIColumns(globalHeaders);
  return (<Card style={{padding:"12px 14px"}}>
    <SectionLabel>🔒 Data Masking — PII Protection</SectionLabel>
    {!globalHeaders.length&&<div style={{fontSize:12,color:textMuted}}>Load data to see columns</div>}
    {piiCols.length>0&&<div style={{marginBottom:8,padding:"6px 10px",background:"#ff6b3511",border:"1px solid #ff6b3533",borderRadius:6}}>
      <div style={{fontSize:11,color:"#ff9966"}}>⚠ PII detected: {piiCols.join(", ")}</div>
    </div>}
    <div style={{display:"flex",flexDirection:"column",gap:4,maxHeight:180,overflowY:"auto"}}>
      {globalHeaders.map(h=>(
        <label key={h} style={{display:"flex",alignItems:"center",gap:8,cursor:"pointer",padding:"3px 0"}}>
          <input type="checkbox" checked={maskedCols.has(h)} onChange={e=>{
            const next=new Set(maskedCols); e.target.checked?next.add(h):next.delete(h); setMaskedCols(next);
            logAction("Mask",e.target.checked?`Masked: ${h}`:`Unmasked: ${h}`);
          }} style={{accentColor:ACCENT}}/>
          <span style={{fontSize:12,color:maskedCols.has(h)?"#ff9966":textPrimary}}>{h}</span>
          {piiCols.includes(h)&&<span style={{fontSize:10,color:"#ff9966"}}>PII</span>}
          {maskedCols.has(h)&&<span style={{fontSize:10,color:"#ff9966"}}>🔒</span>}
        </label>
      ))}
    </div>
  </Card>);
}

// ── Advanced Stats ────────────────────────────────────────────────────────────
function AdvancedStatsPanel() {
  const { globalCsv, globalHeaders, globalRows } = useApp();
  const [col1,setCol1]=useState(""); const [col2,setCol2]=useState(""); const [result,setResult]=useState(null);
  const numCols = globalHeaders.filter(h=>globalRows.some(r=>typeof r[h]==="number"));
  useEffect(()=>{ if(numCols.length&&!col1){setCol1(numCols[0]);} if(numCols.length>1&&!col2){setCol2(numCols[1]);} },[globalCsv]);
  function analyse() {
    if (!globalRows.length||!col1) return;
    const v1=globalRows.map(r=>r[col1]).filter(v=>typeof v==="number");
    const v2=col2?globalRows.map(r=>r[col2]).filter(v=>typeof v==="number"):[];
    const s1=calcStats(v1), s2=col2?calcStats(v2):null, corr=col2&&v2.length?calcCorrelation(v1,v2):null;
    setResult({s1,s2,corr,v1,v2,col1,col2}); logAction("Stats",`${col1}${col2?" vs "+col2:""}`);
  }
  const corrColor=result?.corr!==null?(Math.abs(result.corr)>0.7?ACCENT:Math.abs(result.corr)>0.4?"#f7c549":"#ff6b35"):textMuted;
  return (<div style={{display:"flex",flexDirection:"column",gap:12}}>
    <Card>
      <SectionLabel>📊 Advanced Statistics</SectionLabel>
      {!numCols.length&&<div style={{fontSize:12,color:textMuted}}>Load data first</div>}
      {numCols.length>0&&<div style={{display:"flex",gap:10,flexWrap:"wrap",alignItems:"flex-end"}}>
        <div><div style={{fontSize:11,color:textMuted,marginBottom:4}}>Column A</div>
          <select value={col1} onChange={e=>setCol1(e.target.value)} style={{background:bg2,border:`1px solid ${border}`,borderRadius:6,padding:"7px 12px",color:textPrimary,fontFamily:F,fontSize:12,outline:"none"}}>
            {numCols.map(h=><option key={h} value={h}>{h}</option>)}
          </select></div>
        <div><div style={{fontSize:11,color:textMuted,marginBottom:4}}>Column B (optional)</div>
          <select value={col2} onChange={e=>setCol2(e.target.value)} style={{background:bg2,border:`1px solid ${border}`,borderRadius:6,padding:"7px 12px",color:textPrimary,fontFamily:F,fontSize:12,outline:"none"}}>
            <option value="">-- None --</option>
            {numCols.filter(h=>h!==col1).map(h=><option key={h} value={h}>{h}</option>)}
          </select></div>
        <Btn onClick={analyse} color={ACCENT}>Run Analysis</Btn>
      </div>}
    </Card>
    {result&&<>
      <div style={{display:"grid",gridTemplateColumns:result.col2?"1fr 1fr":"1fr",gap:12}}>
        {[{col:result.col1,s:result.s1,c:ACCENT},...(result.col2?[{col:result.col2,s:result.s2,c:"#a855f7"}]:[])].map(({col,s,c})=>(
          <Card key={col}><SectionLabel color={c}>{col}</SectionLabel>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
              {[["Mean",s.mean?.toFixed(2)],["Median",s.median?.toFixed(2)],["Std Dev",s.stdDev?.toFixed(2)],["Min",s.min],["Max",s.max],["Outliers",s.outliers?.length]].map(([l,v])=>(
                <div key={l} style={{background:bg0,borderRadius:8,padding:"8px 12px"}}>
                  <div style={{fontSize:10,color:textMuted}}>{l}</div>
                  <div style={{fontSize:16,fontWeight:700,color:c}}>{v}</div>
                </div>))}
            </div>
            {s.outliers?.length>0&&<div style={{marginTop:10,padding:"6px 10px",background:"#ff6b3511",border:"1px solid #ff6b3533",borderRadius:6,fontSize:11,color:"#ff9966"}}>⚠ {s.outliers.length} outliers: {s.outliers.slice(0,4).join(", ")}</div>}
          </Card>))}
      </div>
      {result.corr!==null&&<Card>
        <SectionLabel>Correlation</SectionLabel>
        <div style={{display:"flex",alignItems:"center",gap:20}}>
          <ScoreRing score={Math.round(Math.abs(result.corr)*100)} label="CORR%" color={corrColor}/>
          <div>
            <div style={{fontSize:22,fontWeight:700,color:corrColor}}>{result.corr.toFixed(3)}</div>
            <div style={{fontSize:12,color:textMuted,marginTop:4}}>{Math.abs(result.corr)>0.7?"Strong":Math.abs(result.corr)>0.4?"Moderate":"Weak"} {result.corr>0?"positive":"negative"} correlation between {result.col1} & {result.col2}</div>
          </div>
        </div>
      </Card>}
      <Card><SectionLabel>{result.col1} — Trend</SectionLabel>
        <LineChart data={result.v1.map((v,i)=>({label:String(i+1),value:v}))} color={ACCENT} height={150} showBand/>
      </Card>
    </>}
  </div>);
}

// ══════════════════════════════════════════════════════════════════════════════
// TAB 1 — TALK TO DATA
// ══════════════════════════════════════════════════════════════════════════════
function TalkToData() {
  const color=ACCENT;
  const { globalCsv, globalHeaders, globalRows, getMaskedCSV, talkMessages, setTalkMessages, talkLoaded, setTalkLoaded, saveAnalysis, saved, removeAnalysis } = useApp();
  const [question,setQuestion]=useState("");
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState("");
  const [activeTab,setActiveTab]=useState("chat");
  const [showPanel,setShowPanel]=useState(false);
  const chatRef=useRef(null);
  const isMobile=useIsMobile();

  const SAMPLE = `Month,Revenue,Expenses,Customers,Churn,Region\nJan,145000,98000,320,12,North\nFeb,162000,105000,345,8,North\nMar,158000,102000,361,15,South\nApr,189000,118000,398,9,East\nMay,201000,125000,421,11,West\nJun,178000,131000,408,22,South\nJul,223000,140000,456,10,North\nAug,198000,138000,444,18,East`;
  const { loadDataset } = useApp();

  async function ask() {
    if (!globalCsv.trim()||!question.trim()||loading) return;
    const q=question.trim(); setQuestion("");
    setTalkMessages(prev=>[...prev,{role:"user",text:q}]);
    setLoading(true); setError(""); logAction("Query",q);
    try {
      const parsed=parseCSV(getMaskedCSV());
      const ctx=parsed?`Headers: ${parsed.headers.join(", ")}\nRows (${parsed.rows.length}): ${JSON.stringify(parsed.rows.slice(0,20))}`:getMaskedCSV().slice(0,2000);
      const result=await askAI(`Senior data analyst. Dataset:\n${ctx}\nQuestion: "${q}"\nAnswer ONLY JSON:\n{"answer":"2-3 sentence answer","finding":"key number or fact","chartData":[{"label":"x","value":0}],"chartType":"bar or line","reasoningSteps":["step1","step2","step3"],"confidence":85,"followUp":["question1","question2"]}`);
      setTalkMessages(prev=>[...prev,{role:"ai",...result,timestamp:new Date().toLocaleTimeString()}]);
      setTimeout(()=>chatRef.current?.scrollTo({top:9999,behavior:"smooth"}),100);
    } catch(e) { setError(e.message); }
    setLoading(false);
  }

  return (<div style={{display:"flex",flexDirection:isMobile?"column":"row",gap:isMobile?8:16,height:"100%",overflow:"hidden"}}>
    {/* MOBILE PANEL TOGGLE */}
    {isMobile&&<div style={{display:"flex",gap:6,flexShrink:0}}>
      <Btn onClick={()=>setShowPanel(p=>!p)} color={color} outline style={{fontSize:12,flex:1}}>{showPanel?"▲ Hide Options":"▼ Upload & Settings"}</Btn>
      {globalCsv&&!talkLoaded&&<Btn onClick={()=>{setTalkLoaded(true);setTalkMessages([{role:"ai",text:"Data loaded! Ask me anything..."}]);}} color={color} style={{fontSize:12}}>✓ Load</Btn>}
    </div>}
    {/* LEFT PANEL */}
    <div style={{width:isMobile?"100%":260,display:isMobile&&!showPanel?"none":"flex",flexDirection:"column",gap:10,flexShrink:0,overflowY:isMobile?"visible":"auto",maxHeight:isMobile?"60vh":"none"}}>
      <FileUpload color={color}/>
      <Btn onClick={()=>{loadDataset(SAMPLE,"sample-data.csv");}} color={color} outline style={{fontSize:12}}>Use Sample Data</Btn>
      {globalCsv&&!talkLoaded&&!isMobile&&<Btn onClick={()=>{setTalkLoaded(true);setTalkMessages([{role:"ai",text:"Data loaded! Ask me anything — trends, comparisons, totals, anomalies, correlations..."}]);logAction("Load","data ready");}} color={color}>✓ Load My Data</Btn>}

      {/* Sub-tabs */}
      <div style={{display:"flex",gap:4,background:bg0,borderRadius:8,padding:3}}>
        {["chat","stats","mask","saved"].map(t=>(
          <button key={t} onClick={()=>setActiveTab(t)} style={{flex:1,background:activeTab===t?bg2:"none",border:"none",borderRadius:6,padding:"5px 4px",color:activeTab===t?textPrimary:textMuted,fontSize:11,cursor:"pointer",fontFamily:F,fontWeight:activeTab===t?600:400}}>
            {t==="chat"?"💬":t==="stats"?"📊":t==="mask"?"🔒":"💾"}
          </button>))}
      </div>

      {activeTab==="mask"&&<DataMaskPanel/>}
      {activeTab==="stats"&&<AdvancedStatsPanel/>}
      {activeTab==="saved"&&<Card style={{padding:"12px 14px"}}>
        <SectionLabel>💾 Saved Analyses</SectionLabel>
        {!saved.length&&<div style={{fontSize:12,color:textMuted}}>Nothing saved yet.</div>}
        {saved.slice(0,10).map(s=>(
          <div key={s.id} style={{background:bg0,border:`1px solid ${border}`,borderRadius:8,padding:"8px 12px",display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6}}>
            <div><div style={{fontSize:12,color:textPrimary,fontWeight:600}}>{s.name}</div><div style={{fontSize:10,color:textMuted}}>{s.savedAt}</div></div>
            <div style={{display:"flex",gap:6}}>
              <Btn onClick={()=>{setTalkMessages(s.data.messages||[]);setTalkLoaded(true);}} color={color} outline style={{padding:"4px 10px",fontSize:11}}>Load</Btn>
              <Btn onClick={()=>removeAnalysis(s.id)} color="#ff6b35" outline style={{padding:"4px 10px",fontSize:11}}>✕</Btn>
            </div>
          </div>))}
      </Card>}
      {error&&<div style={{fontSize:11,color:"#ff9999",padding:"8px 12px",background:"#3a1a1a",borderRadius:8}}>⚠ {error}</div>}
    </div>

    {/* RIGHT — CHAT */}
    {activeTab==="chat"&&<div style={{flex:1,display:"flex",flexDirection:"column",gap:10,overflow:"hidden"}}>
      <div ref={chatRef} style={{flex:1,overflowY:"auto",display:"flex",flexDirection:"column",gap:12,paddingRight:4}}>
        {talkMessages.length===0&&(<div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:10,opacity:0.35}}>
          <div style={{fontSize:44}}>💬</div>
          <div style={{fontSize:13,color:textPrimary,textAlign:"center"}}>Upload data and ask anything</div>
          <div style={{fontSize:12,color:textMuted,textAlign:"center"}}>Trends · Totals · Comparisons · Anomalies</div>
        </div>)}
        {talkMessages.map((msg,i)=>(
          <div key={i} style={{display:"flex",flexDirection:"column",gap:8,alignItems:msg.role==="user"?"flex-end":"flex-start"}}>
            <div style={{maxWidth:"82%",background:msg.role==="user"?bg2:bg1,border:`1px solid ${border}`,borderRadius:msg.role==="user"?"16px 16px 4px 16px":"16px 16px 16px 4px",padding:"10px 14px"}}>
              {msg.finding&&<div style={{fontSize:22,fontWeight:700,color,marginBottom:6}}>{msg.finding}</div>}
              <div style={{fontSize:13,color:textPrimary,lineHeight:1.7}}>{msg.text||msg.answer}</div>
              {msg.timestamp&&<div style={{fontSize:10,color:textMuted,marginTop:4}}>{msg.timestamp}</div>}
            </div>
            {msg.chartData?.length>1&&<Card style={{width:"90%"}}>{msg.chartType==="line"?<LineChart data={msg.chartData} color={color} showBand/>:<BarChart data={msg.chartData} color={color}/>}</Card>}
            {msg.reasoningSteps?.length>0&&<div style={{width:"90%"}}><ReasoningPanel steps={msg.reasoningSteps} confidence={msg.confidence} timestamp={msg.timestamp}/></div>}
            {msg.followUp?.length>0&&<div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
              {msg.followUp.map((f,j)=><button key={j} onClick={()=>setQuestion(f)} style={{fontSize:11,color:textMuted,border:`1px solid ${border}`,background:"none",padding:"4px 10px",borderRadius:20,cursor:"pointer",fontFamily:F}}>{f}</button>)}
            </div>}
          </div>))}
        {loading&&<div style={{display:"flex",gap:5,padding:"10px 14px",background:bg1,borderRadius:12,border:`1px solid ${border}`,width:"fit-content"}}>
          {[0,1,2].map(i=><div key={i} style={{width:7,height:7,borderRadius:"50%",background:color,animation:`bounce 0.8s ${i*0.2}s infinite`}}/>)}
        </div>}
      </div>
      {talkLoaded&&talkMessages.length<=1&&<div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
        {["Which month had best profit?","Show revenue trend","Find anomalies","Correlation between columns?","Segment by region"].map(q=>(
          <button key={q} onClick={()=>setQuestion(q)} style={{fontSize:11,color:textMuted,border:`1px solid ${border}`,background:"none",padding:"5px 12px",borderRadius:20,cursor:"pointer",fontFamily:F}}>{q}</button>))}
      </div>}
      <div style={{display:"flex",gap:8}}>
        <input value={question} onChange={e=>setQuestion(e.target.value)} onKeyDown={e=>e.key==="Enter"&&ask()}
          placeholder={talkLoaded?"Ask anything about your data...":"Upload data and click Load first..."}
          disabled={!talkLoaded||loading}
          style={{flex:1,background:bg2,border:`1px solid ${border}`,borderRadius:10,padding:"12px 14px",color:textPrimary,fontSize:13,fontFamily:F,outline:"none",minHeight:44}}/>
        {talkMessages.length>1&&<Btn onClick={()=>saveAnalysis("Chat "+new Date().toLocaleTimeString(),{messages:talkMessages})} color={color} outline style={{fontSize:12}}>💾</Btn>}
        <Btn onClick={ask} disabled={!talkLoaded||!question.trim()||loading} color={color}>Ask →</Btn>
      </div>
    </div>}
  </div>);
}

// ══════════════════════════════════════════════════════════════════════════════
// TAB 2 — PREDICT FUTURE
// ══════════════════════════════════════════════════════════════════════════════
function PredictFuture() {
  const color="#a855f7";
  const { globalCsv, globalRows, predictResult, setPredictResult, loadDataset, saveAnalysis } = useApp();
  const [months,setMonths]=useState(3);
  const [showPanel,setShowPanel]=useState(false);
  const isMobile=useIsMobile();
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState("");
  const SAMPLE=`Month,Revenue,Customers\nJan,120000,280\nFeb,135000,310\nMar,128000,295\nApr,156000,340\nMay,171000,372\nJun,165000,358\nJul,188000,401\nAug,204000,430`;

  async function predict() {
    if (!globalCsv.trim()) return;
    setLoading(true); setError(""); setPredictResult(null); logAction("Forecast",`${months} months`);
    try {
      const r=await askAI(`Forecasting expert. Data:\n${JSON.stringify(globalRows.slice(0,30))}\nPredict next ${months} periods. ONLY JSON:\n{"trend":"growing/declining/stable","trendStrength":72,"growthRate":8.5,"seasonality":"pattern or none","historicalData":[{"label":"Jan","value":120000}],"predictions":[{"label":"Sep","value":215000,"low":198000,"high":232000,"confidence":82}],"keyDrivers":["d1","d2"],"risks":["r1","r2"],"reasoningSteps":["s1","s2","s3"],"modelUsed":"Linear Trend + Seasonality","summary":"2 sentence summary","alert":""}`,2000);
      setPredictResult(r);
    } catch(e) { setError(e.message); }
    setLoading(false);
  }

  const allData=predictResult?[...(predictResult.historicalData||[]).map(d=>({...d,type:"actual"})),...(predictResult.predictions||[]).map(d=>({...d,type:"predicted"}))]:[];
  const trendColor=predictResult?.trend==="growing"?ACCENT:predictResult?.trend==="declining"?"#ff6b35":"#f7c549";

  return (<div style={{display:"flex",flexDirection:isMobile?"column":"row",gap:isMobile?8:16,height:"100%",overflow:"hidden"}}>
    {isMobile&&<Btn onClick={()=>setShowPanel(p=>!p)} color={color} outline style={{fontSize:12,flexShrink:0}}>{showPanel?"▲ Hide Options":"▼ Upload & Settings"}</Btn>}
    <div style={{width:isMobile?"100%":260,display:isMobile&&!showPanel?"none":"flex",flexDirection:"column",gap:10,flexShrink:0}}>
      <FileUpload color={color}/>
      <div style={{display:"flex",gap:4,alignItems:"center",flexWrap:"wrap"}}>
        <span style={{fontSize:12,color:textMuted}}>Predict next:</span>
        {[1,3,6,12].map(m=><button key={m} onClick={()=>setMonths(m)} style={{flex:1,background:months===m?color+"22":"none",border:`1px solid ${months===m?color:border}`,color:months===m?color:textMuted,padding:"7px 8px",borderRadius:6,cursor:"pointer",fontFamily:F,fontSize:12}}>{m}mo</button>)}
      </div>
      <Btn onClick={()=>loadDataset(SAMPLE,"sample-forecast.csv")} color={color} outline style={{fontSize:12}}>Use Sample Data</Btn>
      <Btn onClick={predict} disabled={loading||!globalCsv.trim()} color={color}>🔮 Predict Future →</Btn>
      {predictResult&&<>
        <Btn onClick={()=>saveAnalysis("Forecast "+new Date().toLocaleTimeString(),{predictResult,months})} color={color} outline style={{fontSize:12}}>💾 Save</Btn>
        <Btn onClick={()=>downloadCSV([...(predictResult.historicalData||[]).map(d=>({Period:d.label,Value:d.value,Type:"Historical"})),...(predictResult.predictions||[]).map(d=>({Period:d.label,Value:d.value,Low:d.low,High:d.high,Confidence:d.confidence,Type:"Predicted"}))], "forecast.csv")} color="#ffffff" outline style={{fontSize:12,color:textPrimary}}>⬇ CSV</Btn>
      </>}
      {error&&<div style={{fontSize:11,color:"#ff9999",padding:"8px 12px",background:"#3a1a1a",borderRadius:8}}>⚠ {error}</div>}
    </div>
    <div style={{flex:1,overflowY:"auto",display:"flex",flexDirection:"column",gap:14,paddingRight:4}}>
      {!predictResult&&!loading&&<div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:10,opacity:0.3}}><div style={{fontSize:44}}>🔮</div><div style={{fontSize:13,color:textPrimary}}>Upload time-series data to predict the future</div></div>}
      {loading&&<div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:16,opacity:0.7}}><div style={{width:40,height:40,border:`3px solid ${color}33`,borderTop:`3px solid ${color}`,borderRadius:"50%",animation:"spin 1s linear infinite"}}/><div style={{fontSize:13,color}}>Forecasting...</div></div>}
      {predictResult&&<>
        <div style={{display:"flex",gap:12,flexWrap:"wrap"}}>
          <Card style={{flex:1,minWidth:200}}><SectionLabel>Trend</SectionLabel>
            <div style={{fontSize:24,fontWeight:700,color:trendColor}}>{predictResult.trend?.toUpperCase()}</div>
            <div style={{fontSize:13,color:textMuted,marginTop:4}}>+{predictResult.growthRate}% avg growth</div>
            {predictResult.seasonality&&predictResult.seasonality!=="none"&&<div style={{fontSize:11,color:"#f7c549",marginTop:6}}>🔄 {predictResult.seasonality}</div>}
          </Card>
          <ScoreRing score={predictResult.trendStrength} label="STRENGTH" color={color} size={90}/>
        </div>
        <Card><SectionLabel>Historical + Forecast <span style={{color:"#f7c549",marginLeft:8}}>— Moving Avg</span></SectionLabel>
          <LineChart data={allData} color={color} height={170} showBand/>
        </Card>
        <Card><SectionLabel>Predictions with Confidence</SectionLabel>
          {predictResult.predictions?.map((p,i)=>(
            <div key={i} style={{display:"flex",alignItems:"center",gap:12,padding:"10px 14px",background:bg0,borderRadius:8,border:`1px solid ${border}`,marginBottom:8}}>
              <div style={{fontSize:13,color:textMuted,width:40,fontWeight:600}}>{p.label}</div>
              <div style={{fontSize:22,fontWeight:700,color,flex:1}}>{typeof p.value==="number"?p.value.toLocaleString():p.value}</div>
              <div style={{fontSize:11,color:textMuted}}>Range: {p.low?.toLocaleString()} — {p.high?.toLocaleString()}</div>
              <ScoreRing score={p.confidence} label="CONF%" color={color} size={70}/>
            </div>))}
        </Card>
        <div style={{display:"flex",flexWrap:"wrap",gap:12}}>
          <Card style={{flex:1,minWidth:200}}><SectionLabel color={color}>Key Drivers</SectionLabel>{predictResult.keyDrivers?.map((d,i)=><div key={i} style={{fontSize:12,color:textMuted,marginBottom:6}}>✦ {d}</div>)}</Card>
          <Card style={{flex:1,minWidth:200}}><SectionLabel color="#ff6b35">Risks</SectionLabel>{predictResult.risks?.map((r,i)=><div key={i} style={{fontSize:12,color:textMuted,marginBottom:6}}>⚠ {r}</div>)}</Card>
        </div>
        <Card><SectionLabel>Summary</SectionLabel><div style={{fontSize:13,color:textPrimary,lineHeight:1.8}}>{predictResult.summary}</div></Card>
        <ReasoningPanel steps={predictResult.reasoningSteps||[]} model={predictResult.modelUsed||MODEL} confidence={predictResult.predictions?.[0]?.confidence} timestamp={new Date().toLocaleTimeString()}/>
        {predictResult.alert&&<Card style={{borderColor:"#ff6b3555",background:"#3a1a0a"}}><SectionLabel color="#ff6b35">🚨 Alert</SectionLabel><div style={{fontSize:13,color:"#ffaa88"}}>{predictResult.alert}</div></Card>}
      </>}
    </div>
  </div>);
}

// ══════════════════════════════════════════════════════════════════════════════
// TAB 3 — AUTO REPORT
// ══════════════════════════════════════════════════════════════════════════════
function AutoReport() {
  const color="#f7c549";
  const { globalCsv, globalRows, reportResult, setReportResult, loadDataset, saveAnalysis } = useApp();
  const [reportType,setReportType]=useState("executive");
  const [showPanel,setShowPanel]=useState(false);
  const isMobile=useIsMobile();
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState("");
  const SAMPLE=`Quarter,Revenue,Target,Growth,NewClients,ChurnRate,NPS\nQ1 2024,2850000,2500000,14.2,45,3.2,67\nQ2 2024,3120000,3000000,9.5,52,2.8,71\nQ3 2024,2980000,3200000,-6.9,38,4.1,63\nQ4 2024,3650000,3500000,4.3,61,2.4,78`;
  const TYPES=[{id:"executive",label:"Executive Summary"},{id:"sales",label:"Sales Report"},{id:"financial",label:"Financial Review"},{id:"growth",label:"Growth Analysis"}];
  const statusColor=s=>s==="on-track"?ACCENT:s==="at-risk"?"#f7c549":"#ff6b35";
  const prioColor=p=>p==="high"?"#ff6b35":p==="medium"?"#f7c549":ACCENT;

  async function generate() {
    if (!globalCsv.trim()) return;
    setLoading(true); setError(""); setReportResult(null); logAction("Report",reportType);
    try {
      const r=await askAI(`Business analyst writing ${reportType} report. Data:\n${globalCsv.slice(0,2000)}\nONLY JSON:\n{"reportTitle":"title","period":"period","executiveSummary":"3 sentences","highlights":[{"label":"Metric","value":"Value","trend":"up/down/flat","color":"good/bad/neutral"}],"sections":[{"title":"Section","content":"analysis","chartData":[{"label":"x","value":0}],"chartType":"bar"}],"kpis":[{"name":"KPI","current":"value","target":"target","status":"on-track/at-risk/off-track"}],"recommendations":[{"priority":"high/medium","action":"action","impact":"impact"}],"reasoningSteps":["s1","s2","s3"],"conclusion":"2 sentences","nextSteps":["a1","a2","a3"]}`,3000);
      setReportResult(r);
    } catch(e) { setError(e.message); }
    setLoading(false);
  }

  function doDownload() {
    const html=`<h1>${reportResult.reportTitle}</h1><p style="color:#888">${reportResult.period}</p><div class="section"><p>${reportResult.executiveSummary}</p></div><h2>Key Metrics</h2><div class="metrics">${(reportResult.highlights||[]).map(h=>`<div class="metric"><div class="metric-label">${h.label}</div><div class="metric-val">${h.value}</div></div>`).join("")}</div><h2>KPIs</h2><table><tr><th>KPI</th><th>Current</th><th>Target</th><th>Status</th></tr>${(reportResult.kpis||[]).map(k=>`<tr><td>${k.name}</td><td><b>${k.current}</b></td><td>${k.target}</td><td><span class="tag ${k.status==="on-track"?"good":k.status==="at-risk"?"warn":"bad"}">${k.status}</span></td></tr>`).join("")}</table>${(reportResult.sections||[]).map(s=>`<div class="section"><h2>${s.title}</h2><p>${s.content}</p></div>`).join("")}<h2>Recommendations</h2>${(reportResult.recommendations||[]).map(r=>`<div class="recommendation" style="background:#f9f9f9;padding:10px;margin:8px 0;border-radius:6px"><b>${r.action}</b><br/><small>${r.impact}</small></div>`).join("")}<div class="section"><h2>Conclusion</h2><p>${reportResult.conclusion}</p></div>`;
    downloadHTML(html,reportResult.reportTitle||"Report"); logAction("Download","Report");
  }

  return (<div style={{display:"flex",flexDirection:isMobile?"column":"row",gap:isMobile?8:16,height:"100%",overflow:"hidden"}}>
    {isMobile&&<Btn onClick={()=>setShowPanel(p=>!p)} color={color} outline style={{fontSize:12,flexShrink:0}}>{showPanel?"▲ Hide Options":"▼ Upload & Settings"}</Btn>}
    <div style={{width:isMobile?"100%":260,display:isMobile&&!showPanel?"none":"flex",flexDirection:"column",gap:10,flexShrink:0}}>
      <FileUpload color={color}/>
      <div style={{display:"flex",flexDirection:"column",gap:4}}>
        {TYPES.map(t=><button key={t.id} onClick={()=>setReportType(t.id)} style={{background:reportType===t.id?color+"18":"none",border:`1px solid ${reportType===t.id?color+"66":border}`,color:reportType===t.id?color:textMuted,padding:"8px 12px",borderRadius:8,cursor:"pointer",fontFamily:F,fontSize:12,textAlign:"left"}}>{t.label}</button>)}
      </div>
      <Btn onClick={()=>loadDataset(SAMPLE,"sample-report.csv")} color={color} outline style={{fontSize:12}}>Use Sample Data</Btn>
      <Btn onClick={generate} disabled={loading||!globalCsv.trim()} color={color}>📊 Generate Report →</Btn>
      {reportResult&&<>
        <Btn onClick={doDownload} color={color}>⬇ Download Report</Btn>
        <Btn onClick={()=>saveAnalysis("Report "+new Date().toLocaleTimeString(),{reportResult})} color={color} outline style={{fontSize:12}}>💾 Save</Btn>
      </>}
      {error&&<div style={{fontSize:11,color:"#ff9999",padding:"8px 12px",background:"#3a1a1a",borderRadius:8}}>⚠ {error}</div>}
    </div>
    <div style={{flex:1,overflowY:"auto",display:"flex",flexDirection:"column",gap:14,paddingRight:4}}>
      {!reportResult&&!loading&&<div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:10,opacity:0.3}}><div style={{fontSize:44}}>📊</div><div style={{fontSize:13,color:textPrimary}}>Upload data → get a professional report</div></div>}
      {loading&&<div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:16,opacity:0.7}}><div style={{width:40,height:40,border:`3px solid ${color}33`,borderTop:`3px solid ${color}`,borderRadius:"50%",animation:"spin 1s linear infinite"}}/><div style={{fontSize:13,color}}>Writing report...</div></div>}
      {reportResult&&<>
        <Card style={{borderColor:color+"44"}}><SectionLabel color={color}>Report</SectionLabel>
          <div style={{fontSize:20,fontWeight:700,color:textPrimary,marginBottom:4}}>{reportResult.reportTitle}</div>
          <div style={{fontSize:12,color:textMuted,marginBottom:12}}>{reportResult.period}</div>
          <div style={{fontSize:13,color:textPrimary,lineHeight:1.8}}>{reportResult.executiveSummary}</div>
        </Card>
        <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
          {reportResult.highlights?.map((h,i)=>{const c=h.color==="good"?ACCENT:h.color==="bad"?"#ff6b35":"#f7c549";return(<Card key={i} style={{flex:1,minWidth:120}}><div style={{fontSize:11,color:textMuted,marginBottom:4}}>{h.label}</div><div style={{fontSize:22,fontWeight:700,color:c}}>{h.value}</div><div style={{fontSize:12,color:h.trend==="up"?ACCENT:"#ff6b35"}}>{h.trend==="up"?"↑":h.trend==="down"?"↓":"→"}</div></Card>);})}
        </div>
        <Card><SectionLabel color={color}>KPI Scorecard</SectionLabel>
          {reportResult.kpis?.map((k,i)=>(
            <div key={i} style={{display:"flex",alignItems:"center",gap:12,padding:"9px 12px",background:bg0,borderRadius:8,marginBottom:6}}>
              <div style={{flex:1,fontSize:13,color:textPrimary}}>{k.name}</div>
              <div style={{fontSize:16,fontWeight:700,color:textPrimary}}>{k.current}</div>
              <div style={{fontSize:11,color:textMuted}}>vs {k.target}</div>
              <Tag color={statusColor(k.status)}>{k.status?.toUpperCase()}</Tag>
            </div>))}
        </Card>
        {reportResult.sections?.map((s,i)=><Card key={i}><SectionLabel color={color}>{s.title}</SectionLabel><div style={{fontSize:13,color:textPrimary,lineHeight:1.8,marginBottom:12}}>{s.content}</div>{s.chartData?.length>1&&(s.chartType==="line"?<LineChart data={s.chartData} color={color}/>:<BarChart data={s.chartData} color={color}/>)}</Card>)}
        <Card><SectionLabel color={color}>Recommendations</SectionLabel>
          {reportResult.recommendations?.map((r,i)=>(
            <div key={i} style={{display:"flex",gap:12,marginBottom:12,padding:"10px 12px",background:bg0,borderRadius:8}}>
              <Tag color={prioColor(r.priority)}>{r.priority?.toUpperCase()}</Tag>
              <div><div style={{fontSize:13,color:textPrimary,fontWeight:600,marginBottom:3}}>{r.action}</div><div style={{fontSize:12,color:textMuted}}>{r.impact}</div></div>
            </div>))}
        </Card>
        <ReasoningPanel steps={reportResult.reasoningSteps||[]} timestamp={new Date().toLocaleTimeString()}/>
      </>}
    </div>
  </div>);
}

// ══════════════════════════════════════════════════════════════════════════════
// TAB 4 — ANOMALY DETECTOR
// ══════════════════════════════════════════════════════════════════════════════
function AnomalyDetector() {
  const color="#ff6b35";
  const { globalCsv, globalRows, anomalyResult, setAnomalyResult, loadDataset } = useApp();
  const [loading,setLoading]=useState(false);
  const [showPanel,setShowPanel]=useState(false);
  const isMobile=useIsMobile();
  const [error,setError]=useState("");
  const SAMPLE=`Date,Sales,Traffic,ConvRate,AvgOrder\n2024-01-01,45200,12400,3.6,125\n2024-01-02,44800,11900,3.7,122\n2024-01-03,46100,12800,3.6,124\n2024-01-04,12300,12200,1.0,115\n2024-01-05,45900,13100,3.5,127\n2024-01-06,47200,13400,3.5,128\n2024-01-07,89400,13000,6.8,175\n2024-01-08,46300,12600,3.7,123\n2024-01-09,45100,12400,3.6,124\n2024-01-10,44700,25800,1.7,118`;
  const sevColor=s=>s==="critical"?"#ff6b35":s==="high"?"#f7c549":"#a855f7";

  async function detect() {
    if (!globalCsv.trim()) return;
    setLoading(true); setError(""); setAnomalyResult(null); logAction("Anomaly","scan");
    try {
      const r=await askAI(`Anomaly detection expert. Data:\n${globalCsv.slice(0,2000)}\nONLY JSON:\n{"overallHealth":72,"anomalyCount":3,"anomalies":[{"date":"date","metric":"col","value":"found","expected":"~45000","deviation":"-73%","severity":"critical/high/medium","possibleCause":"why","action":"what to do"}],"patterns":["p1","p2"],"dataQuality":[{"issue":"issue","rows":"rows","fix":"fix"}],"chartData":[{"label":"date","value":45200,"anomaly":false}],"reasoningSteps":["s1","s2","s3","s4"],"summary":"2 sentences","urgentAction":"most urgent thing"}`,2500);
      setAnomalyResult(r);
    } catch(e) { setError(e.message); }
    setLoading(false);
  }

  return (<div style={{display:"flex",flexDirection:isMobile?"column":"row",gap:isMobile?8:16,height:"100%",overflow:"hidden"}}>
    {isMobile&&<Btn onClick={()=>setShowPanel(p=>!p)} color={color} outline style={{fontSize:12,flexShrink:0}}>{showPanel?"▲ Hide Options":"▼ Upload & Settings"}</Btn>}
    <div style={{width:isMobile?"100%":260,display:isMobile&&!showPanel?"none":"flex",flexDirection:"column",gap:10,flexShrink:0}}>
      <FileUpload color={color}/>
      <Btn onClick={()=>loadDataset(SAMPLE,"sample-anomaly.csv")} color={color} outline style={{fontSize:12}}>Use Sample (with anomalies)</Btn>
      <Btn onClick={detect} disabled={loading||!globalCsv.trim()} color={color}>🚨 Detect Anomalies →</Btn>
      {anomalyResult&&<Btn onClick={()=>downloadCSV((anomalyResult.anomalies||[]).map(a=>({Date:a.date,Metric:a.metric,Found:a.value,Expected:a.expected,Deviation:a.deviation,Severity:a.severity,Cause:a.possibleCause,Action:a.action})),"anomalies.csv")} color={color} outline style={{fontSize:12}}>⬇ Download</Btn>}
      {error&&<div style={{fontSize:11,color:"#ff9999",padding:"8px 12px",background:"#3a1a1a",borderRadius:8}}>⚠ {error}</div>}
      <Card style={{padding:"12px 14px"}}><SectionLabel>What I detect</SectionLabel>
        {["Sudden drops/spikes","Data entry errors","Statistical outliers (IQR)","Conversion anomalies","Traffic spikes"].map((t,i)=><div key={i} style={{fontSize:12,color:textMuted,padding:"3px 0"}}>• {t}</div>)}
      </Card>
    </div>
    <div style={{flex:1,overflowY:"auto",display:"flex",flexDirection:"column",gap:14,paddingRight:4}}>
      {!anomalyResult&&!loading&&<div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:10,opacity:0.3}}><div style={{fontSize:44}}>🚨</div><div style={{fontSize:13,color:textPrimary}}>Upload data — AI finds what's wrong</div></div>}
      {loading&&<div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:16,opacity:0.7}}><div style={{width:40,height:40,border:`3px solid ${color}33`,borderTop:`3px solid ${color}`,borderRadius:"50%",animation:"spin 1s linear infinite"}}/><div style={{fontSize:13,color}}>Scanning for anomalies...</div></div>}
      {anomalyResult&&<>
        <div style={{display:"flex",gap:12}}>
          <Card style={{flex:1,display:"flex",alignItems:"center",gap:16}}>
            <ScoreRing score={anomalyResult.overallHealth} label="DATA HEALTH" color={anomalyResult.overallHealth>70?ACCENT:anomalyResult.overallHealth>40?"#f7c549":"#ff6b35"} size={90}/>
            <div><div style={{fontSize:28,fontWeight:700,color}}>{anomalyResult.anomalyCount} anomalies</div><div style={{fontSize:13,color:textMuted,lineHeight:1.7,marginTop:4}}>{anomalyResult.summary}</div></div>
          </Card>
        </div>
        {anomalyResult.urgentAction&&<Card style={{borderColor:"#ff6b3566",background:"#3a1a0a"}}><SectionLabel color="#ff6b35">⚡ Investigate Now</SectionLabel><div style={{fontSize:13,color:"#ffcc99",lineHeight:1.8}}>{anomalyResult.urgentAction}</div></Card>}
        {anomalyResult.chartData?.length>1&&<Card><SectionLabel>Overview — orange = anomaly</SectionLabel><BarChart data={anomalyResult.chartData} color={color} height={140}/></Card>}
        {anomalyResult.anomalies?.length>0&&<Card><SectionLabel color={color}>Anomalies Found</SectionLabel>
          {anomalyResult.anomalies.map((a,i)=>(
            <div key={i} style={{background:bg0,border:`1px solid ${sevColor(a.severity)}33`,borderLeft:`3px solid ${sevColor(a.severity)}`,borderRadius:10,padding:"12px 14px",marginBottom:10}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
                <div style={{display:"flex",gap:8,alignItems:"center"}}><Tag color={sevColor(a.severity)}>{a.severity?.toUpperCase()}</Tag><span style={{fontSize:13,color:textPrimary,fontWeight:600}}>{a.metric}</span><span style={{fontSize:12,color:textMuted}}>{a.date}</span></div>
                <div style={{fontSize:16,fontWeight:700,color:sevColor(a.severity)}}>{a.deviation}</div>
              </div>
              <div style={{fontSize:12,color:textMuted,marginBottom:4}}>Found <b style={{color:textPrimary}}>{a.value}</b> — expected <b style={{color:textMuted}}>{a.expected}</b></div>
              <div style={{fontSize:12,color:textMuted,marginBottom:4}}>📌 {a.possibleCause}</div>
              <div style={{fontSize:12,color}}>→ {a.action}</div>
            </div>))}
        </Card>}
        <ReasoningPanel steps={anomalyResult.reasoningSteps||[]} model="IQR + Statistical Analysis" timestamp={new Date().toLocaleTimeString()}/>
      </>}
    </div>
  </div>);
}

// ══════════════════════════════════════════════════════════════════════════════
// PHASE 2 — MULTI-TABLE ANALYSIS
// ══════════════════════════════════════════════════════════════════════════════
function MultiTableAnalysis() {
  const color="#06b6d4";
  const { datasets, loadDataset } = useApp();
  const [question,setQuestion]=useState("");
  const [result,setResult]=useState(null);
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState("");

  const SAMPLES = {
    "sales.csv": `Month,Region,Revenue,Units\nJan,North,145000,290\nJan,South,98000,196\nFeb,North,162000,324\nFeb,South,112000,224\nMar,North,158000,316\nMar,South,121000,242`,
    "marketing.csv": `Month,Region,AdSpend,Impressions,Clicks\nJan,North,12000,450000,9000\nJan,South,8000,300000,6000\nFeb,North,15000,560000,11200\nFeb,South,9500,356000,7120\nMar,North,14000,524000,10480\nMar,South,10000,374000,7480`,
    "customers.csv": `Month,Region,NewCustomers,Churn,NPS\nJan,North,45,5,72\nJan,South,30,8,65\nFeb,North,52,4,75\nFeb,South,35,7,68\nMar,North,48,6,71\nMar,South,38,9,64`,
  };

  async function analyse() {
    if (!datasets.length||!question.trim()) return;
    setLoading(true); setError(""); logAction("Multi-table",question);
    try {
      const ctx=datasets.map(d=>`Table "${d.name}" (${d.rows.length} rows):\nHeaders: ${d.headers.join(", ")}\nSample: ${JSON.stringify(d.rows.slice(0,5))}`).join("\n\n");
      const r=await askAI(`Senior data analyst with access to MULTIPLE tables. Tables:\n${ctx}\n\nQuestion: "${question}"\n\nAnswer ONLY JSON:\n{"answer":"detailed 3-4 sentence answer with cross-table insights","finding":"key cross-table insight","joinLogic":"how the tables relate and were joined","insights":[{"table":"table name","insight":"finding"}],"chartData":[{"label":"x","value":0}],"chartType":"bar or line","reasoningSteps":["loaded table A","loaded table B","joined on Month+Region","computed metric","found insight"],"confidence":85,"recommendation":"action to take based on cross-table analysis"}`,2500);
      setResult(r);
    } catch(e) { setError(e.message); }
    setLoading(false);
  }

  const isMobileMulti=useIsMobile();
  const [showMPanel,setShowMPanel]=useState(false);
  return (<div style={{display:"flex",flexDirection:isMobileMulti?"column":"row",gap:isMobileMulti?8:16,height:"100%",overflow:"hidden"}}>
    {isMobileMulti&&<Btn onClick={()=>setShowMPanel(p=>!p)} color={color} outline style={{fontSize:12,flexShrink:0}}>{showMPanel?"▲ Hide Datasets":"▼ Manage Datasets"}</Btn>}
    <div style={{width:isMobileMulti?"100%":280,display:isMobileMulti&&!showMPanel?"none":"flex",flexDirection:"column",gap:10,flexShrink:0,overflowY:isMobileMulti?"visible":"auto",maxHeight:isMobileMulti?"50vh":"none"}}>
      <Card style={{padding:"12px 14px"}}>
        <SectionLabel color={color}>📁 Your Datasets ({datasets.length})</SectionLabel>
        {!datasets.length&&<div style={{fontSize:12,color:textMuted}}>No datasets loaded yet</div>}
        {datasets.map((d,i)=>(
          <div key={i} style={{display:"flex",alignItems:"center",gap:8,padding:"6px 0",borderBottom:`1px solid ${border}`}}>
            <span style={{fontSize:14}}>📊</span>
            <div style={{flex:1}}><div style={{fontSize:12,color:textPrimary}}>{d.name}</div><div style={{fontSize:10,color:textMuted}}>{d.rows.length} rows · {d.headers.length} cols</div></div>
          </div>))}
      </Card>

      <FileUpload color={color}/>
      <div style={{fontSize:11,color:textMuted,textAlign:"center"}}>Upload multiple files — each adds a new table</div>

      <Card style={{padding:"12px 14px"}}>
        <SectionLabel color={color}>📋 Load Sample Tables</SectionLabel>
        {Object.entries(SAMPLES).map(([name,csv])=>(
          <Btn key={name} onClick={()=>loadDataset(csv,name)} color={color} outline style={{fontSize:11,marginBottom:6,width:"100%",textAlign:"left"}}>+ {name}</Btn>))}
      </Card>

      {error&&<div style={{fontSize:11,color:"#ff9999",padding:"8px 12px",background:"#3a1a1a",borderRadius:8}}>⚠ {error}</div>}
    </div>

    <div style={{flex:1,display:"flex",flexDirection:"column",gap:12,overflow:"hidden"}}>
      {datasets.length===0&&<div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:10,opacity:0.3}}>
        <div style={{fontSize:44}}>🔗</div>
        <div style={{fontSize:13,color:textPrimary}}>Load 2+ tables to ask cross-table questions</div>
        <div style={{fontSize:12,color:textMuted}}>Example: "Did marketing spend increase sales in North region?"</div>
      </div>}

      {datasets.length>0&&<>
        <Card style={{borderColor:color+"44"}}>
          <SectionLabel color={color}>Cross-Table Question Examples</SectionLabel>
          <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
            {["Did ad spend increase sales?","Which region has best ROI?","Correlation between marketing and revenue?","Where is customer churn highest?","Which month had best conversion?"].map(q=>(
              <button key={q} onClick={()=>setQuestion(q)} style={{fontSize:11,color:textMuted,border:`1px solid ${border}`,background:"none",padding:"5px 12px",borderRadius:20,cursor:"pointer",fontFamily:F}}>{q}</button>))}
          </div>
        </Card>

        <div style={{display:"flex",gap:8}}>
          <input value={question} onChange={e=>setQuestion(e.target.value)} onKeyDown={e=>e.key==="Enter"&&analyse()}
            placeholder="Ask a question across all your tables..."
            style={{flex:1,background:bg2,border:`1px solid ${border}`,borderRadius:10,padding:"12px 14px",color:textPrimary,fontSize:13,fontFamily:F,outline:"none",minHeight:44}}/>
          <Btn onClick={analyse} disabled={loading||!question.trim()||!datasets.length} color={color}>Analyse →</Btn>
        </div>

        <div style={{flex:1,overflowY:"auto",display:"flex",flexDirection:"column",gap:12}}>
          {loading&&<div style={{display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:16,opacity:0.7,paddingTop:40}}><div style={{width:40,height:40,border:`3px solid ${color}33`,borderTop:`3px solid ${color}`,borderRadius:"50%",animation:"spin 1s linear infinite"}}/><div style={{fontSize:13,color}}>Joining tables and analysing...</div></div>}
          {result&&<>
            <Card style={{borderColor:color+"44"}}>
              <div style={{fontSize:22,fontWeight:700,color,marginBottom:8}}>{result.finding}</div>
              <div style={{fontSize:13,color:textPrimary,lineHeight:1.8}}>{result.answer}</div>
              {result.joinLogic&&<div style={{marginTop:10,padding:"8px 12px",background:bg0,borderRadius:8,fontSize:12,color:textMuted}}>🔗 Join logic: {result.joinLogic}</div>}
            </Card>
            {result.insights?.length>0&&<Card><SectionLabel color={color}>Per-Table Insights</SectionLabel>
              {result.insights.map((ins,i)=>(
                <div key={i} style={{padding:"8px 12px",background:bg0,borderRadius:8,marginBottom:6}}>
                  <Tag color={color}>{ins.table}</Tag>
                  <div style={{fontSize:12,color:textMuted,marginTop:6}}>{ins.insight}</div>
                </div>))}
            </Card>}
            {result.chartData?.length>1&&<Card>{result.chartType==="line"?<LineChart data={result.chartData} color={color}/>:<BarChart data={result.chartData} color={color}/>}</Card>}
            {result.recommendation&&<Card style={{borderColor:color+"44"}}><SectionLabel color={color}>💡 Recommendation</SectionLabel><div style={{fontSize:13,color:textPrimary,lineHeight:1.8}}>{result.recommendation}</div></Card>}
            <ReasoningPanel steps={result.reasoningSteps||[]} confidence={result.confidence} timestamp={new Date().toLocaleTimeString()}/>
          </>}
        </div>
      </>}
    </div>
  </div>);
}

// ══════════════════════════════════════════════════════════════════════════════
// PHASE 2 — SCHEDULED REPORTS
// ══════════════════════════════════════════════════════════════════════════════
function ScheduledReports() {
  const color="#f97316";
  const { schedules, addSchedule, removeSchedule, globalFileName } = useApp();
  const [email,setEmail]=useState("");
  const [frequency,setFrequency]=useState("weekly");
  const [reportType,setReportType]=useState("executive");
  const [slackWebhook,setSlackWebhook]=useState("");
  const [alertOn,setAlertOn]=useState("anomaly");
  const [saved,setSaved]=useState(false);

  function saveSchedule() {
    if (!email.trim()&&!slackWebhook.trim()) return;
    addSchedule({ email:email.trim(), frequency, reportType, slackWebhook:slackWebhook.trim(), alertOn, dataset:globalFileName, createdAt:new Date().toLocaleString() });
    setEmail(""); setSlackWebhook(""); setSaved(true);
    setTimeout(()=>setSaved(false),3000);
  }

  return (<div style={{display:"flex",gap:16,height:"100%",overflow:"hidden"}}>
    <div style={{flex:1,overflowY:"auto",display:"flex",flexDirection:"column",gap:16,paddingRight:4}}>

      {/* Email reports */}
      <Card style={{borderColor:color+"44"}}>
        <SectionLabel color={color}>📧 Scheduled Email Reports</SectionLabel>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:12}}>
          <div>
            <div style={{fontSize:11,color:textMuted,marginBottom:6}}>Email address</div>
            <input value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@company.com"
              style={{width:"100%",background:bg2,border:`1px solid ${border}`,borderRadius:8,padding:"9px 12px",color:textPrimary,fontFamily:F,fontSize:13,outline:"none",boxSizing:"border-box"}}/>
          </div>
          <div>
            <div style={{fontSize:11,color:textMuted,marginBottom:6}}>Frequency</div>
            <select value={frequency} onChange={e=>setFrequency(e.target.value)} style={{width:"100%",background:bg2,border:`1px solid ${border}`,borderRadius:8,padding:"9px 12px",color:textPrimary,fontFamily:F,fontSize:13,outline:"none"}}>
              <option value="daily">Daily (9 AM)</option>
              <option value="weekly">Weekly (Monday)</option>
              <option value="monthly">Monthly (1st)</option>
            </select>
          </div>
          <div>
            <div style={{fontSize:11,color:textMuted,marginBottom:6}}>Report type</div>
            <select value={reportType} onChange={e=>setReportType(e.target.value)} style={{width:"100%",background:bg2,border:`1px solid ${border}`,borderRadius:8,padding:"9px 12px",color:textPrimary,fontFamily:F,fontSize:13,outline:"none"}}>
              <option value="executive">Executive Summary</option>
              <option value="sales">Sales Report</option>
              <option value="anomaly">Anomaly Alert</option>
              <option value="forecast">Forecast Update</option>
            </select>
          </div>
          <div style={{display:"flex",alignItems:"flex-end"}}>
            <Btn onClick={saveSchedule} disabled={!email.trim()} color={color} style={{width:"100%"}}>
              {saved?"✅ Scheduled!":"📅 Schedule Report"}
            </Btn>
          </div>
        </div>
        <div style={{padding:"10px 14px",background:bg0,borderRadius:8,fontSize:12,color:textMuted}}>
          ℹ️ To enable actual email sending, connect Resend API (free 3,000 emails/month) in your backend. This UI saves the schedule config ready for backend integration.
        </div>
      </Card>

      {/* Slack alerts */}
      <Card style={{borderColor:"#7c3aed44"}}>
        <SectionLabel color="#a855f7">💬 Slack / Teams Alerts</SectionLabel>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:12}}>
          <div style={{gridColumn:"1/-1"}}>
            <div style={{fontSize:11,color:textMuted,marginBottom:6}}>Webhook URL (from Slack → Apps → Incoming Webhooks)</div>
            <input value={slackWebhook} onChange={e=>setSlackWebhook(e.target.value)} placeholder="https://hooks.slack.com/services/..."
              style={{width:"100%",background:bg2,border:`1px solid ${border}`,borderRadius:8,padding:"9px 12px",color:textPrimary,fontFamily:F,fontSize:12,outline:"none",boxSizing:"border-box"}}/>
          </div>
          <div>
            <div style={{fontSize:11,color:textMuted,marginBottom:6}}>Alert when</div>
            <select value={alertOn} onChange={e=>setAlertOn(e.target.value)} style={{width:"100%",background:bg2,border:`1px solid ${border}`,borderRadius:8,padding:"9px 12px",color:textPrimary,fontFamily:F,fontSize:13,outline:"none"}}>
              <option value="anomaly">Anomaly detected</option>
              <option value="drop">Revenue drops 10%+</option>
              <option value="churn">Churn spikes</option>
              <option value="weekly">Weekly summary</option>
            </select>
          </div>
          <div style={{display:"flex",alignItems:"flex-end"}}>
            <Btn onClick={saveSchedule} disabled={!slackWebhook.trim()} color="#a855f7" style={{width:"100%"}}>
              {saved?"✅ Saved!":"🔔 Save Alert"}
            </Btn>
          </div>
        </div>

        {/* Sample Slack message preview */}
        <div style={{background:"#1a1a2e",border:"1px solid #444",borderRadius:8,padding:14}}>
          <div style={{fontSize:11,color:textMuted,marginBottom:8}}>Preview — what Slack will receive:</div>
          <div style={{background:"#222",borderLeft:"4px solid #10a37f",padding:"10px 12px",borderRadius:"0 6px 6px 0"}}>
            <div style={{fontSize:13,color:"#10a37f",fontWeight:700,marginBottom:4}}>🚨 NEUROS Alert — Anomaly Detected</div>
            <div style={{fontSize:12,color:textMuted}}>Revenue dropped <b style={{color:"#ff9966"}}>-73%</b> on Jan 04 (found ₹12,300, expected ~₹45,000)</div>
            <div style={{fontSize:12,color:textMuted,marginTop:4}}>📌 Possible cause: System outage or data error</div>
            <div style={{fontSize:11,color:textMuted,marginTop:6}}>→ Open NEUROS Dashboard to investigate</div>
          </div>
        </div>
      </Card>

      {/* Active schedules */}
      {schedules.length>0&&<Card>
        <SectionLabel color={color}>Active Schedules ({schedules.length})</SectionLabel>
        {schedules.map((s,i)=>(
          <div key={s.id} style={{display:"flex",alignItems:"center",gap:12,padding:"10px 12px",background:bg0,borderRadius:8,border:`1px solid ${border}`,marginBottom:8}}>
            <div style={{fontSize:18}}>{s.email?"📧":"💬"}</div>
            <div style={{flex:1}}>
              <div style={{fontSize:12,color:textPrimary,fontWeight:600}}>{s.email||"Slack webhook"}</div>
              <div style={{fontSize:11,color:textMuted}}>{s.frequency} · {s.reportType} · {s.createdAt}</div>
              {s.dataset&&<div style={{fontSize:10,color:ACCENT}}>Dataset: {s.dataset}</div>}
            </div>
            <Tag color={color}>{s.frequency}</Tag>
            <Btn onClick={()=>removeSchedule(s.id)} color="#ff6b35" outline style={{padding:"4px 10px",fontSize:11}}>Remove</Btn>
          </div>))}
      </Card>}

      {/* Integration guide */}
      <Card>
        <SectionLabel color={color}>🔌 Backend Integration Guide</SectionLabel>
        <div style={{fontFamily:"'Courier New',monospace",fontSize:11,background:bg0,borderRadius:8,padding:14,color:textMuted,lineHeight:1.9}}>
          <div style={{color:ACCENT,marginBottom:8}}>// To make emails actually send — add to your Railway backend:</div>
          <div style={{color:"#a855f7"}}>npm install resend node-cron</div>
          <br/>
          <div style={{color:textPrimary}}>{"// server.js"}</div>
          <div>{"const { Resend } = require('resend');"}</div>
          <div>{"const resend = new Resend(process.env.RESEND_KEY);"}</div>
          <div>{"const cron = require('node-cron');"}</div>
          <br/>
          <div>{"// Run every Monday at 9 AM"}</div>
          <div>{"cron.schedule('0 9 * * 1', async () => {"}</div>
          <div>{"  const report = await generateReport(data);"}</div>
          <div>{"  await resend.emails.send({"}</div>
          <div>{"    to: schedule.email,"}</div>
          <div>{"    subject: 'Weekly NEUROS Report',"}</div>
          <div>{"    html: report"}</div>
          <div>{"  });"}</div>
          <div>{"});"}</div>
        </div>
      </Card>
    </div>
  </div>);
}

// ══════════════════════════════════════════════════════════════════════════════
// AUDIT LOG
// ══════════════════════════════════════════════════════════════════════════════
function AuditLogPanel() {
  const [,rerender]=useState(0);
  useEffect(()=>{ const id=setInterval(()=>rerender(n=>n+1),2000); return ()=>clearInterval(id); },[]);
  return (<div style={{height:"100%",overflowY:"auto"}}>
    <SectionLabel>📋 Audit Log — All Actions Tracked</SectionLabel>
    {!auditLog.length&&<div style={{fontSize:13,color:textMuted}}>No actions yet — start using the app!</div>}
    <div style={{fontFamily:"'Courier New',monospace"}}>
      {auditLog.map((log,i)=>(
        <div key={i} style={{display:"flex",gap:12,padding:"8px 0",borderBottom:`1px solid ${border}`}}>
          <div style={{fontSize:11,color:textMuted,width:65,flexShrink:0}}>{log.time}</div>
          <div style={{fontSize:11,color:ACCENT,width:110,flexShrink:0,fontWeight:600}}>{log.action}</div>
          <div style={{fontSize:11,color:textMuted,flex:1}}>{log.detail}</div>
          <div style={{fontSize:11,color:textMuted}}>👤 {log.user}</div>
        </div>))}
    </div>
  </div>);
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN APP
// ══════════════════════════════════════════════════════════════════════════════
const TABS = [
  { id:"talk",      icon:"💬", label:"Talk to Data",    color:ACCENT },
  { id:"predict",   icon:"🔮", label:"Predict Future",  color:"#a855f7" },
  { id:"report",    icon:"📊", label:"Auto Report",     color:"#f7c549" },
  { id:"anomaly",   icon:"🚨", label:"Find Anomalies",  color:"#ff6b35" },
  { id:"multitable",icon:"🔗", label:"Multi-Table",     color:"#06b6d4" },
  { id:"schedule",  icon:"📅", label:"Schedules",       color:"#f97316" },
  { id:"audit",     icon:"📋", label:"Audit Log",       color:textMuted },
];

function AppInner() {
  const [tab,setTab]=useState(TABS[0]);
  const { globalFileName } = useApp();
  const isMobile = useIsMobile();

  return (<div style={{height:"100vh",background:bg0,display:"flex",flexDirection:"column",fontFamily:F,color:textPrimary,overflow:"hidden"}}>
    {/* HEADER */}
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:isMobile?"10px 14px":"10px 20px",borderBottom:`1px solid ${border}`,flexShrink:0,background:bg1}}>
      <div style={{display:"flex",alignItems:"center",gap:10}}>
        <span style={{fontSize:20}}>🧠</span>
        <div>
          {!isMobile&&<div style={{fontSize:10,color:textMuted,letterSpacing:0.3}}>Data Nerd</div>}
          <div style={{fontSize:isMobile?14:17,fontWeight:700,background:"linear-gradient(90deg,#10a37f,#a855f7)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>NEUROS{!isMobile&&" .Beta Version"}</div>
        </div>
      </div>

      {/* DESKTOP TABS — hidden on mobile */}
      {!isMobile&&<div style={{display:"flex",gap:2,background:bg0,borderRadius:10,padding:3}}>
        {TABS.map(t=>(
          <button key={t.id} onClick={()=>setTab(t)} style={{
            background:tab.id===t.id?bg2:"none", border:"none", borderRadius:8,
            color:tab.id===t.id?(t.color===textMuted?textPrimary:t.color):textMuted,
            padding:"6px 12px", cursor:"pointer", fontFamily:F, fontSize:12,
            fontWeight:tab.id===t.id?600:400, transition:"all .15s",
            display:"flex", alignItems:"center", gap:5,
          }}>{t.icon} {t.label}</button>))}
      </div>}

      <div style={{display:"flex",alignItems:"center",gap:8}}>
        {globalFileName&&!isMobile&&<div style={{fontSize:11,color:ACCENT}}>📊 {globalFileName}</div>}
        <div style={{width:8,height:8,borderRadius:"50%",background:ACCENT}}/>
        {!isMobile&&<span style={{fontSize:11,color:textMuted}}>Live</span>}
      </div>
    </div>

    {/* CONTENT */}
    <div style={{flex:1,padding:isMobile?"10px 12px":"14px 20px",overflow:"hidden",display:"flex",flexDirection:"column"}}>
      <DataBanner/>
      {tab.id==="talk"       &&<TalkToData/>}
      {tab.id==="predict"    &&<PredictFuture/>}
      {tab.id==="report"     &&<AutoReport/>}
      {tab.id==="anomaly"    &&<AnomalyDetector/>}
      {tab.id==="multitable" &&<MultiTableAnalysis/>}
      {tab.id==="schedule"   &&<ScheduledReports/>}
      {tab.id==="audit"      &&<AuditLogPanel/>}
    </div>

    {/* MOBILE BOTTOM TAB BAR */}
    {isMobile&&<div style={{display:"flex",borderTop:`1px solid ${border}`,background:bg1,flexShrink:0,overflowX:"auto"}}>
      {TABS.map(t=>(
        <button key={t.id} onClick={()=>setTab(t)} style={{
          flex:1, minWidth:44, background:"none", border:"none",
          color:tab.id===t.id?(t.color===textMuted?textPrimary:t.color):textMuted,
          padding:"10px 4px 8px", cursor:"pointer", fontFamily:F,
          display:"flex", flexDirection:"column", alignItems:"center", gap:3,
          borderTop:`2px solid ${tab.id===t.id?(t.color===textMuted?textPrimary:t.color):"transparent"}`,
        }}>
          <span style={{fontSize:18}}>{t.icon}</span>
          <span style={{fontSize:9,fontWeight:tab.id===t.id?700:400}}>{t.label.split(" ")[0]}</span>
        </button>))}
    </div>}

    <style>{`
      *{box-sizing:border-box;}
      body{background:${bg0}!important;margin:0;}
      ::-webkit-scrollbar{width:5px;}
      ::-webkit-scrollbar-track{background:${bg0};}
      ::-webkit-scrollbar-thumb{background:#565869;border-radius:3px;}
      @keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
      @keyframes bounce{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}
      input::placeholder,textarea::placeholder{color:#565869;}
      select option{background:${bg2};color:${textPrimary};}
      input,textarea,select,button{-webkit-tap-highlight-color:transparent;touch-action:manipulation;}
      @media(max-width:768px){.desktop-only{display:none!important;}}
    `}</style>
  </div>);
}

export default function App() {
  return (<AppProvider><AppInner/></AppProvider>);
}