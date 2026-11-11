import { useEffect,useMemo,useState } from "react";
import { openAccess } from "./api";
import type { Access } from "./api";
import { Calendar,todayLima } from "./components/Calendar";
import type { Period } from "./components/Calendar";
import { Dialog } from "./components/Dialog";
import { resultLabel,sessionRequest } from "./session-api";
import type { Worker } from "./dashboard-types";
import "./modules.css";
export interface Attempt{
 attemptId:string;contactId:string;name:string;phone:string;list:string;
 workerId:string;workerName:string;shiftId:string;shiftLabel:string;
 reportDate:string;startedAt:string;answeredAt:string|null;endedAt:string|null;
 waitingSeconds:number;durationSeconds:number;totalSeconds:number;
 attemptNumber:number;technicalResult:string;disposition?:string;
}
const stamp=(value:string|null)=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString("es-PE",{timeZone:"America/Lima"}):"—";
const duration=(value:number)=>Number.isFinite(value)?Math.floor(value/60)+":"+String(value%60).padStart(2,"0"):"—";
const answered=(row:Attempt)=>!["buzon_de_voz","sin_servicio","no_disponible","numero_incorrecto","numero_inexistente"].includes(row.technicalResult)&&Boolean(row.answeredAt||row.technicalResult==="contesto");
export function Reports(){
 const [access,setAccess]=useState<Access|null>(null);const [rows,setRows]=useState<Attempt[]>([]);
 const [error,setError]=useState("");const [busy,setBusy]=useState(false);
 const [period,setPeriod]=useState<Period>({from:todayLima(),to:todayLima()});
 const [query,setQuery]=useState("");const [shift,setShift]=useState("");const [list,setList]=useState("");const [worker,setWorker]=useState("");const [result,setResult]=useState("");
 const [calling,setCalling]=useState<Attempt|null>(null);const [workers,setWorkers]=useState<Worker[]>([]);const [workerId,setWorkerId]=useState("");
 const [archives,setArchives]=useState<{id:string;date:string;rubro:string;pending:number;numbers:number}[]>([]);
 const [message,setMessage]=useState("");
 useEffect(()=>{const controller=new AbortController();
  openAccess(controller.signal).then(async auth=>{
   if(controller.signal.aborted)return;setAccess(auth);
   const data=await sessionRequest<{rows:Attempt[]}>(auth,"/reports/attempts",undefined,"GET",controller.signal);
   if(!controller.signal.aborted)setRows(data.rows);
  }).catch(cause=>{if(!controller.signal.aborted)setError(cause.message);});
  return()=>controller.abort();
 },[]);
 async function refresh(){if(!access)return;setBusy(true);setError("");try{const data=await sessionRequest<{rows:Attempt[]}>(access,"/reports/attempts");setRows(data.rows);}catch(cause){setError(cause instanceof Error?cause.message:"No se pudo cargar.");}finally{setBusy(false);}}
 const dates=useMemo(()=>{const map=new Map<string,number>();for(const row of rows)map.set(row.reportDate,(map.get(row.reportDate)||0)+1);return map;},[rows]);
 const filtered=useMemo(()=>rows.filter(row=>
  (!period.from||(row.reportDate>=period.from&&row.reportDate<=period.to))&&(!shift||row.shiftId===shift)&&(!list||row.list===list)&&(!worker||row.workerId===worker)&&(!result||row.technicalResult===result)&&
  [row.phone,row.name,row.list,resultLabel(row.technicalResult)].join(" ").toLowerCase().includes(query.toLowerCase().trim())
 ),[rows,period,shift,list,worker,result,query]);
 const options=(key:"shiftId"|"list"|"workerId"|"technicalResult")=>[...new Set(rows.map(row=>row[key]).filter(Boolean))];
 async function pdf(){
  setBusy(true);setError("");
  try{
   const [{jsPDF},{default:autoTable}]=await Promise.all([import("jspdf"),import("jspdf-autotable")]);
   const doc=new jsPDF({orientation:"landscape",format:"a3"});
   doc.setFontSize(17);doc.text("VOIP VC - Reporte de llamadas",14,17);doc.setFontSize(10);
   doc.text((period.from?period.from+" al "+period.to:"Todo el historial")+" | "+filtered.length+" intentos | "+filtered.filter(answered).length+" contestadas",14,25);
   autoTable(doc,{startY:32,head:[["Lista","Contacto","Número","Equipo","Intento","Inicio Lima","Conectó Lima","Fin Lima","Espera","Conectado","Total","Resultado técnico","Comercial"]],body:filtered.map(row=>[row.list,row.name,row.phone,row.workerName||row.workerId,row.attemptNumber,stamp(row.startedAt),stamp(row.answeredAt),stamp(row.endedAt),duration(row.waitingSeconds),duration(row.durationSeconds),duration(row.totalSeconds),resultLabel(row.technicalResult),resultLabel(row.disposition||"")]),styles:{fontSize:7,cellPadding:2},headStyles:{fillColor:[90,10,113]},alternateRowStyles:{fillColor:[249,242,252]}});
   doc.save("reporte-llamadas-"+(period.from||"completo")+".pdf");
  }catch(cause){setError(cause instanceof Error?cause.message:"No se pudo generar el PDF.");}
  finally{setBusy(false);}
 }
 async function prepare(row:Attempt){
  if(!access)return;
  try{const data=await sessionRequest<{workers:Worker[]}>(access,"/workers");const ready=data.workers.filter(item=>item.connected&&["idle","ended","available","failed"].includes(item.callState));setWorkers(ready);setWorkerId(ready[0]?.id||"");setCalling(row);setError("");}
  catch(cause){setError(cause instanceof Error?cause.message:"No se pudieron consultar los equipos.");}
 }
 async function dial(){
  if(!access||!calling)return;setBusy(true);
  try{await sessionRequest(access,"/workers/"+encodeURIComponent(workerId)+"/call-contact",{contactId:calling.contactId,contact:{id:calling.contactId,name:calling.name,phone:calling.phone,list:calling.list}});setCalling(null);setMessage("Llamada enviada. El historial anterior se conserva.");}
  catch(cause){setError(cause instanceof Error?cause.message:"No se pudo volver a llamar.");}finally{setBusy(false);}
 }
 async function loadArchives(){if(!access)return;try{const data=await sessionRequest<{reports:typeof archives}>(access,"/reports/daily");setArchives(data.reports);}catch(cause){setError(cause instanceof Error?cause.message:"No se pudo cargar.");}}
 async function continueArchive(id:string){if(!access||!confirm("¿Preparar los pendientes de esta campaña? Se aplicarán los bloqueos del historial."))return;setBusy(true);try{await sessionRequest(access,"/reports/"+encodeURIComponent(id)+"/continue",{});setMessage("Campaña preparada. Revisa el panel de llamadas.");}catch(cause){setError(cause instanceof Error?cause.message:"No se pudo continuar.");}finally{setBusy(false);}}
 return <div className="workspace"><header className="masthead"><a className="brand" href="/"><span className="brand-symbol">VC</span><span>Reportes<small>Calendario e historial de llamadas</small></span></a><div className="account"><a href="/">Volver a llamadas</a><a href="/panel/contacts">Contactos y listas</a></div></header><main className="reports-react"><div className="page-heading"><div><h1>Reportes de llamadas</h1><p>Fechas y horas de Lima. El historial conserva cada intento.</p></div><div className="module-actions"><button className="secondary" disabled={busy||!access} onClick={refresh}>Actualizar</button><button className="primary" disabled={busy||!filtered.length} onClick={pdf}>Descargar PDF</button></div></div>{error&&<p className="feedback error" role="alert">{error}</p>}{message&&<p role="status">{message}</p>}<Calendar period={period} onChange={setPeriod} counts={dates}/>
 <div className="filters report-selects">{([["Turno",shift,setShift,"shiftId"],["Lista",list,setList,"list"],["Equipo",worker,setWorker,"workerId"],["Resultado",result,setResult,"technicalResult"]] as const).map(([label,value,setValue,key])=><label key={label}>{label}<select value={value} onChange={e=>setValue(e.target.value)}><option value="">Todos</option>{options(key).map(option=><option key={option} value={option}>{key==="technicalResult"?resultLabel(option):key==="shiftId"?rows.find(row=>row.shiftId===option)?.shiftLabel||option:key==="workerId"?rows.find(row=>row.workerId===option)?.workerName||option:option}</option>)}</select></label>)}<label className="search">Buscar<input type="search" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Número, contacto, lista o resultado"/></label></div>
 <div className="report-summary"><span>{filtered.length} intentos</span><span>{filtered.filter(answered).length} contestadas</span><span>{duration(filtered.reduce((sum,row)=>sum+(row.durationSeconds||0),0))} tiempo conectado</span></div>
 <div className="report-groups">{[...new Set(filtered.map(row=>row.list))].map(name=><button key={name} onClick={()=>setList(name)}><strong>{name||"Sin lista"}</strong><span>{filtered.filter(row=>row.list===name).length} intentos</span></button>)}</div>
 <div className="table-scroll report-table" tabIndex={0} aria-label="Historial de llamadas"><table><thead><tr>{["Lista","Contacto","Número","Equipo","Intento","Inicio Lima","Conectó Lima","Fin Lima","Espera","Tiempo conectado","Tiempo total","Resultado técnico","Resultado comercial","Acción"].map(label=><th key={label}>{label}</th>)}</tr></thead><tbody>{filtered.map((row,index)=><tr key={row.attemptId||index}><td>{row.list}</td><td>{row.name}</td><td>{row.phone}</td><td>{row.workerName||row.workerId}</td><td>{row.attemptNumber}</td><td>{stamp(row.startedAt)}</td><td>{stamp(row.answeredAt)}</td><td>{stamp(row.endedAt)}</td><td>{duration(row.waitingSeconds)}</td><td>{duration(row.durationSeconds)}</td><td>{duration(row.totalSeconds)}</td><td>{resultLabel(row.technicalResult)}</td><td>{resultLabel(row.disposition||"")}</td><td><button className="text-button" disabled={busy||row.technicalResult==="numero_inexistente"} onClick={()=>prepare(row)}>Volver a llamar</button></td></tr>)}</tbody></table>{!filtered.length&&<p className="empty">No hay intentos para el período y filtros seleccionados.</p>}</div>
 <details className="archive-reports" onToggle={e=>{if(e.currentTarget.open)loadArchives();}}><summary>Campañas guardadas y pendientes</summary>{archives.filter(row=>!period.from||(row.date>=period.from&&row.date<=period.to)).map(row=><div key={row.id}><span>{row.date} · {row.rubro} · {row.numbers} números · {row.pending} pendientes</span><button className="secondary" disabled={busy||!row.pending} onClick={()=>continueArchive(row.id)}>Continuar pendientes</button></div>)}</details>
 </main>{calling&&<Dialog title={"Volver a llamar a "+calling.name} busy={busy} onClose={()=>setCalling(null)}><p>{calling.phone}. El servidor comprobará el bloqueo anual o permanente antes de permitir la llamada.</p><label>Equipo<select value={workerId} onChange={e=>setWorkerId(e.target.value)}>{workers.map(item=><option value={item.id} key={item.id}>{item.name}</option>)}</select></label>{!workers.length&&<p>No hay equipos disponibles.</p>}{error&&<p role="alert" className="feedback error">{error}</p>}<div className="editor-actions"><button className="primary" disabled={busy||!workerId} onClick={dial}>Enviar llamada</button></div></Dialog>}</div>;
}
