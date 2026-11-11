import { useCallback,useEffect,useRef,useState } from "react";
import { readJson,signOut,useAccount } from "./account";
import type { LiveSocket } from "./dashboard-types";
import "./network.css";
interface Metrics{total:number;answered:number;unanswered:number;inProgress:number;inoperable:number}
interface Activity{attemptId:string;name:string;list:string|null;startedAt:string|null;endedAt:string|null;durationSeconds:number|null;result:string|null;category:string}
interface Equipment{number:number;name:string;deviceId:string|null;state:string;calling:boolean;metrics:Metrics|null;pending:number|null;rubro:string|null;schedule:string|null;lastActivityAt:string|null;historyVersion:string;scopeReason?:string;simulated?:boolean;turn?:{id:string;label:string;startedAt:string};activity?:Activity[]}
interface Snapshot{generatedAt:string;equipment:Equipment[];overflow:number;summary:{metrics:Metrics|null;pending:number|null;label:string;scope:string};unavailable?:boolean}
const date=(value:string|null|undefined)=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString("es-PE",{timeZone:"America/Lima"}):"Sin datos";
const results:Record<string,string>={contesto:"Contestó",sin_respuesta:"Sin respuesta",no_contactado:"No contactado",buzon_de_voz:"Buzón de voz",sin_servicio:"Sin servicio",numero_inexistente:"No volver a llamar",no_disponible:"No disponible"};
const number=(value:number|null|undefined)=>typeof value==="number"?value.toLocaleString("es-PE"):"—";
export function Network(){
 const {account,error:accountError}=useAccount(true);
 const [snapshot,setSnapshot]=useState<Snapshot|null>(null);
 const [histories,setHistories]=useState<Record<number,{key:string;rows:Activity[]}>>({});
 const [error,setError]=useState("");const [busy,setBusy]=useState(false);
 const [query,setQuery]=useState("");const [filter,setFilter]=useState("all");
 const [online,setOnline]=useState(false);const [received,setReceived]=useState(0);
 const [clock,setClock]=useState(Date.now());
 const detailKey=useRef("");const historyRequest=useRef(0);
 const refresh=useCallback(async()=>{
  setBusy(true);try{
   const data=await readJson<Snapshot>(await fetch("/api/admin/network",{cache:"no-store"}));
   if(!data.equipment)throw new Error("No se pudo cargar Núcleo de Red.");
   setSnapshot(data);setReceived(Date.now());setError("");
  }catch(cause){setError(cause instanceof Error?cause.message:"No se pudo actualizar.");}
  finally{setBusy(false);}
 },[]);
 useEffect(()=>{
  if(!account)return;
  let socket:LiveSocket|null=null;let closed=false;const controller=new AbortController();
  refresh();
  socket=window.io({autoConnect:false,auth:{client:"dashboard",userId:account.user.id},transports:["websocket"]});
  socket.on("connect",()=>{setOnline(true);socket!.emit("admin:subscribe",(result:{ok?:boolean})=>{if(!result?.ok)setOnline(false);});});
  socket.on<Snapshot>("admin:network",data=>{
   if(data.unavailable||!Array.isArray(data.equipment)){setReceived(0);return;}
   if(!closed){setSnapshot(data);setReceived(Date.now());setError("");}
  });
  socket.on("disconnect",()=>setOnline(false));
  socket.on<{message:string}>("connect_error",cause=>{setOnline(false);setError(cause.message);if(["AUTH_REQUIRED","AUTH_CHANGED"].includes(cause.message))location.assign("/login");});
  socket.connect();
  const interval=setInterval(()=>setClock(Date.now()),1000);
  return()=>{closed=true;controller.abort();socket?.disconnect();clearInterval(interval);};
 },[account,refresh]);
 useEffect(()=>{
  if(!snapshot||!account)return;
  const key=snapshot.equipment.map(item=>[item.number,item.deviceId,item.turn?.id,item.historyVersion].join(":")).join("|");
  if(key===detailKey.current)return;
  const request=++historyRequest.current;const controller=new AbortController();
  const timer=setTimeout(()=>{
   fetch("/api/admin/network/activity?equipment="+snapshot.equipment.map(item=>item.number).join(","),{signal:controller.signal,cache:"no-store"})
    .then(readJson<{equipment:Equipment[]}>).then(data=>{
     if(controller.signal.aborted||request!==historyRequest.current)return;
     detailKey.current=key;
     setHistories(Object.fromEntries(data.equipment.map(item=>[item.number,{key:[item.deviceId,item.turn?.id,item.historyVersion].join(":"),rows:item.activity||[]}])));
    }).catch(()=>{if(!controller.signal.aborted)setError("No se pudo actualizar el historial de los equipos.");});
  },400);
  return()=>{controller.abort();clearTimeout(timer);};
 },[snapshot,account]);
 const live=online&&received>0&&clock-received<6000;
 const state=(item:Equipment)=>!live?"Sin datos":item.state==="Sin vincular"?"Sin vincular":item.state;
 const equipment=snapshot?.equipment||[];
 const displayed=equipment.filter(item=>(filter==="all"||state(item)===filter)&&[item.number,item.name,item.rubro].join(" ").toLocaleLowerCase("es").includes(query.toLocaleLowerCase("es")));
 const offline=live?equipment.filter(item=>item.state==="Desconectado"):[];
 const metrics=snapshot?.summary.metrics;
 function download(){
  if(!snapshot)return;
  const link=document.createElement("a");const url=URL.createObjectURL(new Blob([JSON.stringify(snapshot,null,2)],{type:"application/json"}));
  link.href=url;link.download="nucleo-red-"+new Date().toISOString().slice(0,10)+".json";link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
 }
 return <div className="net"><header className="net-header"><a className="net-brand" href="/admin/nucleo-red"><img src="/logo-vc-color.png" alt="VC"/><span>Núcleo de Red<small>Supervisión de equipos</small></span></a><nav><a href="/">Panel de llamadas</a><span>{account?.user.username}</span><button disabled={!account} onClick={()=>account&&signOut(account.csrfToken).catch(cause=>setError(cause.message))}>Cerrar sesión</button></nav></header>
 <main className="net-main"><div className="net-title"><div><h1>Núcleo de Red</h1><p role="status">{live?"En vivo · Conectado al servidor":"Sin conexión en vivo · Datos sin verificar"} · Actualizado {date(snapshot?.generatedAt)}</p></div><div className="net-actions"><button disabled={busy||!account} onClick={refresh}>Actualizar</button><button disabled={!snapshot} onClick={download}>Descargar registro</button></div></div>
 {(error||accountError)&&<p role="alert" className="net-error">{error||accountError}</p>}
 <section className="net-overview"><h2>Estado general de dispositivos</h2><div className="net-indicators">{equipment.map(item=><button key={item.number} data-state={state(item)} onClick={()=>document.getElementById("equipment-"+item.number)?.scrollIntoView({behavior:"smooth",block:"center"})} aria-label={"Equipo "+item.number+": "+state(item)}><strong>{String(item.number).padStart(2,"0")}</strong><span>{state(item)}</span></button>)}</div><p>{snapshot?.overflow? snapshot.overflow+" equipos adicionales fuera de las diez posiciones.":"Diez posiciones de supervisión."} {received>0&&"Última actualización hace "+Math.max(0,Math.floor((clock-received)/1000))+" s."}</p></section>
 <section className="net-metrics" aria-label="Métricas del turno">{[["Intentos del turno",metrics?.total],["Contestadas",metrics?.answered],["Pendientes",snapshot?.summary.pending],["En curso",metrics?.inProgress]].map(([label,value])=><div key={String(label)}><span>{label}</span><strong>{number(value as number|null|undefined)}</strong></div>)}</section>
 {!metrics&&<p className="net-muted">{snapshot?.summary.scope||"No hay un turno verificable para consolidar el resumen."}</p>}
 {offline.length>0&&<div className="net-error" role="status">Alerta de enlace: {offline.map(item=>"Equipo "+item.number).join(", ")} fuera de línea.</div>}
 <section className="net-filters"><label>Buscar equipo<input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Número, equipo o rubro"/></label><div aria-label="Filtrar por estado">{["all","En llamada","Marcando","Disponible","Desconectado","Sin vincular","Sin datos"].map(value=><button key={value} aria-pressed={filter===value} onClick={()=>setFilter(value)}>{value==="all"?"Todos":value} ({equipment.filter(item=>value==="all"||state(item)===value).length})</button>)}</div></section>
 <section className="net-grid">{displayed.map(item=>{
  const cached=histories[item.number];const key=[item.deviceId,item.turn?.id,item.historyVersion].join(":");
  const rows=cached?.key===key?cached.rows:null;
  return <article className="net-card" id={"equipment-"+item.number} key={item.number} data-state={state(item)}><header><div><h2>Equipo {String(item.number).padStart(2,"0")}</h2><small>{item.name} {item.rubro?" · "+item.rubro:""}</small></div><span className="net-state">{state(item)}</span></header>
   <div className="net-card-stats"><span>Total <strong>{number(item.metrics?.total)}</strong></span><span>Contestadas <strong>{number(item.metrics?.answered)}</strong></span><span>Pendientes <strong>{number(item.pending)}</strong></span></div>
   {live&&item.calling&&<p className="net-active">{state(item)} · Estado confirmado por Android</p>}
   <p className="net-muted">{item.schedule||item.scopeReason||item.turn?.label||"Sin turno verificable"}</p>
   <div className="net-table"><table><thead><tr><th>Contacto / lista</th><th>Hora</th><th>Duración</th><th>Resultado</th></tr></thead><tbody>{rows?.map(row=><tr key={row.attemptId}><td>{row.name}<small>{row.list}</small></td><td>{date(row.startedAt)}</td><td>{row.endedAt?(row.durationSeconds===null?"—":Math.floor(row.durationSeconds/60)+":"+String(row.durationSeconds%60).padStart(2,"0")):"En curso"}</td><td>{row.endedAt?results[row.result||""]||row.result||"Sin clasificar":"En curso"}</td></tr>)}</tbody></table>{!rows?.length&&<p className="net-muted">{rows===null?"Actualizando actividad…":item.metrics?"No hay intentos en este turno.":"Sin datos para un turno verificable."}</p>}</div>
   <footer>Última actividad: {date(item.lastActivityAt)} {item.simulated&&<strong>Prueba simulada</strong>}</footer></article>;
 })}</section>{!displayed.length&&<p className="net-muted">No hay equipos que coincidan con la selección.</p>}</main></div>;
}
