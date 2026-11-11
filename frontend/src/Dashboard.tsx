import { lazy, Suspense, useEffect, useState } from "react";
import type { Access, Contact } from "./api";
import { callStatus } from "./api";
import type { Slot, Worker } from "./dashboard-types";
import { useDashboard } from "./useDashboard";
import "./dashboard.css";
import { AudioPanel } from "./components/AudioPanel";
import { WorkerControls } from "./components/WorkerControls";

const Contacts=lazy(()=>import("./App").then(module=>({default:module.App})));
const stateLabel:Record<string,string>={idle:"Disponible",ended:"Disponible",failed:"Sin llamada",available:"Disponible",dialing:"Marcando",ringing:"Timbrando",in_call:"En llamada",running:"En curso",paused:"Pausada",completed:"Completada",stopped:"Detenida"};
function QrCode({slot,access}:{slot:Slot;access:Access}){
 const [url,setUrl]=useState("");const [error,setError]=useState(false);
 useEffect(()=>{
  const controller=new AbortController();let objectUrl="";
  setUrl("");setError(false);
  fetch("/api/pairing-qr/"+access.code+".svg?slot="+encodeURIComponent(slot.id),{
   signal:controller.signal,headers:{"X-Dashboard-Token":access.token},cache:"no-store"
  }).then(response=>{if(!response.ok)throw new Error();return response.blob();}).then(blob=>{
   if(controller.signal.aborted)return;objectUrl=URL.createObjectURL(blob);setUrl(objectUrl);
  }).catch(()=>{if(!controller.signal.aborted)setError(true);});
  return()=>{controller.abort();if(objectUrl)URL.revokeObjectURL(objectUrl);};
 },[slot.id,access.code,access.token]);
 return <div className="dash-qr">{url?<img src={url} alt={"Código QR para "+slot.label}/>:<span>{error?"No se pudo cargar el QR. Actualiza el panel.":"Preparando QR…"}</span>}</div>;
}

function Equipment({slot,worker,access,disabled,onAction}:{slot:Slot;worker?:Worker;access:Access;disabled:boolean;onAction:(path:string,body?:unknown)=>unknown}){
 const linked=Boolean(slot.deviceId);
 const online=Boolean(worker?.connected||slot.connected);
 return <article className={"dash-equipment "+(online?"online":"")}>
  <div className="dash-equipment-head"><h3>{slot.label||"Equipo"}</h3><span className={"dash-chip "+(online?"good":"")}>{online?"Conectado":linked?"Desconectado":"Sin vincular"}</span></div>
  {linked?<div className="dash-phone-info"><svg className="dash-phone-icon" width="34" height="52" viewBox="0 0 34 52" fill="none" aria-hidden="true"><rect x="3" y="2" width="28" height="48" rx="5" stroke="currentColor" strokeWidth="2.5"/><path d="M12 7h10M14 44h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg><strong>{slot.deviceName||worker?.name||"Android"}</strong><span>{worker?.paused?"Pausado":stateLabel[worker?.callState||"idle"]||worker?.callState}</span>{worker?.companyName&&<small>{worker.companyName}</small>}{worker?.phoneNumber&&<small>{worker.phoneNumber}</small>}</div>:<><QrCode slot={slot} access={access}/><p className="dash-equipment-help">Abre VOIP VC y escanea este QR.</p></>}
  {linked&&online&&worker&&<div className="dash-worker-actions"><button disabled={disabled} onClick={()=>onAction("/workers/"+encodeURIComponent(worker.id)+"/pause",{paused:!worker.paused})}>{worker.paused?"Reanudar equipo":"Pausar equipo"}</button><button className="dash-danger" disabled={disabled||!["dialing","ringing","in_call"].includes(worker.callState)} onClick={()=>onAction("/workers/"+encodeURIComponent(worker.id)+"/hangup")}>Colgar</button></div>}
 </article>;
}

export function Dashboard(){
 const panel=useDashboard();
 const [view,setView]=useState(()=>location.pathname.startsWith("/panel/contacts")?"contacts":"calls");
 useEffect(()=>{const changed=()=>setView(location.pathname.startsWith("/panel/contacts")?"contacts":"calls");window.addEventListener("popstate",changed);return()=>window.removeEventListener("popstate",changed);},[]);
 const {access,user,data,live,connected,busy,error,message,action}=panel;
 const [tab,setTab]=useState<"equipment"|"lists"|"activity">("equipment");
 const [query,setQuery]=useState("");
 const [selectedList,setSelectedList]=useState("");
 const [now,setNow]=useState(()=>Date.now());
 useEffect(()=>{const interval=setInterval(()=>setNow(Date.now()),30000);return()=>clearInterval(interval);},[]);
 const workers=live.phoneWorkers||[];
 const online=workers.filter(worker=>worker.connected);
 const available=online.filter(worker=>!worker.paused&&["idle","ended","failed","available"].includes(worker.callState));
 const active=workers.filter(worker=>["dialing","ringing","in_call"].includes(worker.callState));
 const campaign=data.campaign;
 const shift=campaign?.turn?.current||live.shiftManagement?.current||campaign?.turn?.detected||live.shiftManagement?.detected;
 const counts=campaign?.counts||{};
 const pending=(counts.pending||0)+(counts.retry_pending||0)+(counts.held||0);
 const storagePending=live.storage?.mode==="pending";
 const disabled=busy||!connected||!access;
 const contacts=data.book?.contacts||[];
 const eligible=(contact:Contact)=>callStatus(contact).kind==="available"&&/^\d{9}$/.test(contact.phone.replace(/^\+?51/,""));
 const selected=contacts.filter(contact=>(!selectedList||contact.list===selectedList)&&eligible(contact));
 const searched=contacts.filter(contact=>(!selectedList||contact.list===selectedList)&&[contact.name,contact.phone].join(" ").toLocaleLowerCase("es").includes(query.toLocaleLowerCase("es").trim()));
 const history=(campaign?.history||[]).slice(-8).reverse();
 const savedAssignments=data.book?.preferences.pairingListAssignments;
 const listAssignments=savedAssignments&&typeof savedAssignments==="object"?savedAssignments as Record<string,string>:{};
 const workerByList=new Map(data.slots.filter(slot=>slot.deviceId&&listAssignments[slot.id]).map(slot=>[listAssignments[slot.id],slot.deviceId]));
 const start=()=>action("/campaign/start",{listName:selectedList||"Asignación automática",maxAttempts:1,contacts:selected.map(contact=>({
  id:contact.id,name:contact.name,phone:contact.phone,note:contact.note,list:contact.list,targetWorkerId:workerByList.get(contact.list)||""
 }))});
 const turnPending=campaign?.turn?.pendingContacts||[];
 const uncalledPending=turnPending.filter(contact=>contact.status!=="exhausted"&&(contact.recoveryAttempts||0)<2);
 const recoverPending=()=>action("/campaign/start",{listName:"Pendientes del turno",maxAttempts:1,contacts:uncalledPending.map(contact=>({...contact,id:contact.id||crypto.randomUUID(),targetWorkerId:workerByList.get(contact.list)||""}))});
 return <div className="dash" onClick={event=>{
  const link=(event.target as Element).closest<HTMLAnchorElement>("a[href]");
  if(!link||event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey||link.target)return;
  const url=new URL(link.href);if(url.origin!==location.origin||!["/","/panel/contacts"].includes(url.pathname))return;
  event.preventDefault();window.history.pushState(null,"",url.pathname);setView(url.pathname==="/panel/contacts"?"contacts":"calls");
  if(url.pathname==="/")panel.refresh().catch(()=>{});
 }}>
  <aside className="dash-sidebar"><a className="dash-logo" href="/"><img src="/logo-vc-color.png" alt="VC"/><span>ViaVox<small>Gestión de llamadas</small></span></a>
   <nav aria-label="Navegación principal"><a className={view==="calls"?"active":undefined} href="/" aria-current={view==="calls"?"page":undefined}>Panel de llamadas</a><a className={view==="contacts"?"active":undefined} href="/panel/contacts" aria-current={view==="contacts"?"page":undefined}>Contactos y listas</a><a href="/panel/reports">Reportes y calendario</a>{user?.role==="ADMINISTRADOR"&&<a href="/admin/nucleo-red">Núcleo de Red</a>}</nav>
   <div className="dash-sidebar-bottom"><a href="/panel/contacts">Importar y administrar bases</a><a href="https://github.com/RikkaApps/Shizuku/releases/download/v13.5.4/shizuku-v13.5.4.r1049.0e53409-release.apk" target="_blank" rel="noopener noreferrer">Descargar Shizuku</a><div><strong>{user?.username||"Comprobando acceso…"}</strong><small>{user?.role==="ADMINISTRADOR"?"Administrador":"Operador"}</small></div><button disabled={busy||!user} onClick={panel.logout}>Cerrar sesión</button></div>
  </aside>
  <div className="dash-content">
   <header className="dash-topbar"><span className={"dash-connection "+(connected?"ready":"")}><i/>{connected?"Conexión en vivo":"Conectando…"}</span><span>{access?"Sesión "+access.code:"Preparando sesión"}</span><a href="/api/apk/download">Descargar APK</a><button className="dash-mobile-logout" disabled={busy||!user} onClick={panel.logout}>Salir</button></header>
   {view==="contacts"&&<Suspense fallback={<p role="status">Cargando contactos…</p>}>{access?<Contacts embedded providedAccess={access} onBookChanged={()=>{panel.refresh().catch(()=>{});}}/>:<p role="status">Preparando la sesión…</p>}</Suspense>}
   <main className="dash-main" hidden={view!=="calls"}>
    <div className="dash-heading"><div><h1>Panel de llamadas</h1><p>{new Date(now).toLocaleDateString("es-PE",{weekday:"long",day:"numeric",month:"long",timeZone:"America/Lima"})}</p></div><button className="dash-outline" disabled={disabled} onClick={()=>panel.refresh().catch(()=>{})}>Actualizar panel</button></div>
    <section className="dash-command" aria-label="Control de campaña">
     <div className="dash-command-title"><div><span className="dash-shift">{shift?.label||"Tu jornada de llamadas"}</span><h2>{campaign?.status==="running"?"Campaña en curso":campaign?.status==="paused"?"Listo para continuar":"Prepara tu próxima llamada"}</h2><p>{shift?.schedule||"Vincula los equipos, selecciona una lista y comienza."}</p></div><span className="dash-campaign-status">{stateLabel[campaign?.status||""]||"Sin campaña activa"}</span></div>
     <div className="dash-call-controls"><label>Lista a trabajar<select value={selectedList} disabled={busy||campaign?.status==="running"} onChange={event=>setSelectedList(event.target.value)}><option value="">Todas las listas</option>{(data.book?.lists||[]).map(list=><option key={list}>{list}</option>)}</select></label>
      {campaign?.status==="paused"?<button className="dash-primary" disabled={disabled||storagePending||!available.length} onClick={()=>action("/campaign/resume")}>Continuar llamadas</button>:<button className="dash-primary" disabled={disabled||storagePending||campaign?.status==="running"||!available.length||!selected.length} onClick={start}>Iniciar llamadas</button>}
      <button className="dash-light" disabled={disabled||campaign?.status!=="running"} onClick={()=>action("/campaign/pause")}>Pausar</button>
      <button className="dash-light" disabled={disabled||!["running","paused"].includes(campaign?.status||"")} onClick={()=>action("/campaign/stop",{},"¿Detener la campaña y colgar las llamadas en curso?")}>Detener</button>
     </div>
     {!available.length&&connected&&<p className="dash-command-hint">Vincula un equipo disponible para iniciar llamadas.</p>}
     {!!available.length&&!selected.length&&contacts.length>0&&<p className="dash-command-hint">No hay números disponibles en esta selección. Revisa los bloqueos en Contactos.</p>}
    </section>
    {error&&<div className="dash-alert error" role="alert">{error}</div>}
    {storagePending&&<div className="dash-alert error" role="alert">Hay datos pendientes de guardar. Las nuevas llamadas estarán bloqueadas hasta recuperar el guardado.</div>}
    {message&&<div className="dash-message" role="status">{message}</div>}
    <section className="dash-totals" aria-label="Resumen de llamadas"><div><span>Equipos conectados</span><strong>{online.length}<small> / {data.slots.length}</small></strong></div><div><span>Llamadas en curso</span><strong>{active.length}</strong></div><div><span>Pendientes de campaña</span><strong>{pending}</strong></div><div><span>Intentos en campaña</span><strong>{campaign?.history?.length||0}</strong></div></section>
    <div className="dash-section-heading"><div className="dash-tabs" role="tablist" aria-label="Contenido del panel">{([["equipment","Equipos"],["lists","Bases y listas"],["activity","Actividad reciente"]] as const).map(([value,label])=><button key={value} id={"tab-"+value} role="tab" aria-selected={tab===value} aria-controls={"section-"+value} onClick={()=>setTab(value)}>{label}</button>)}</div>{tab==="equipment"&&<button className="dash-outline" disabled={disabled||data.slots.length>=20} onClick={()=>action("/pairing-slots")}>Crear otro QR</button>}</div>
    {tab==="equipment"&&<section id="section-equipment" role="tabpanel" aria-labelledby="tab-equipment"><div className="dash-equipment-grid">{access&&data.slots.map(slot=><div key={slot.id}><Equipment slot={slot} access={access} worker={workers.find(worker=>worker.id===slot.deviceId)} disabled={disabled} onAction={action}/><WorkerControls slot={slot} worker={workers.find(worker=>worker.id===slot.deviceId)} book={data.book} campaign={campaign} disabled={disabled} action={action} assign={panel.assignList} command={panel.command}/></div>)}</div>{!data.slots.length&&<div className="dash-empty"><h3>{access?"Preparando tus equipos":"Conectando con tu sesión"}</h3><p>{access?"Los códigos QR aparecerán cuando se cargue la sesión.":"Inicia sesión para ver tus teléfonos y listas."}</p></div>}</section>}
    {tab==="lists"&&<section id="section-lists" role="tabpanel" aria-labelledby="tab-lists"><div className="dash-list-toolbar"><label>Buscar en esta selección<input type="search" value={query} onChange={event=>setQuery(event.target.value)} placeholder="Nombre o teléfono"/></label><a className="dash-outline" href="/panel/contacts">Importar base</a><a href="/panel/contacts">Editar notas y consultar listas</a></div><div className="dash-table-scroll"><table><thead><tr><th>Contacto</th><th>Lista</th><th>Teléfono</th><th>Estado</th></tr></thead><tbody>{searched.slice(0,20).map(contact=><tr key={contact.id}><td>{contact.name}</td><td>{contact.list}</td><td>{contact.phone}</td><td><span className={"dash-chip "+(eligible(contact)?"good":"")}>{callStatus(contact).label}</span></td></tr>)}</tbody></table>{!searched.length&&<div className="dash-empty"><h3>{contacts.length?"No hay coincidencias":"Importa tu primera base"}</h3><p>{contacts.length?"Prueba otra búsqueda o selecciona otra lista.":"Agrega los contactos para preparar tu campaña."}</p><a href="/panel/contacts">Abrir importación</a></div>}</div>{searched.length>20&&<p className="dash-footnote">Mostrando 20 de {searched.length}. <a href="/panel/contacts">Ver todos los contactos</a></p>}</section>}
    {tab==="activity"&&<section id="section-activity" role="tabpanel" aria-labelledby="tab-activity"><div className="dash-table-scroll"><table><thead><tr><th>Contacto</th><th>Teléfono</th><th>Resultado</th><th>Hora</th></tr></thead><tbody>{history.map((item,index)=><tr key={item.attemptId||index}><td>{item.name}</td><td>{item.phone}</td><td>{item.technicalResult==="numero_inexistente"?"No volver a llamar":item.technicalResult?.replaceAll("_"," ")||"Finalizada"}</td><td>{new Date(item.startedAt).toLocaleTimeString("es-PE",{hour:"2-digit",minute:"2-digit",timeZone:"America/Lima"})}</td></tr>)}</tbody></table>{!history.length&&<div className="dash-empty"><h3>Aún no hay intentos en esta campaña</h3><p>Los resultados aparecerán cuando terminen las llamadas.</p></div>}</div><p className="dash-footnote"><a href="/panel/reports">Abrir historial completo y calendario</a></p></section>}
    <details className="dash-pending"><summary>Pendientes del turno ({turnPending.length})</summary><div className="dash-table-scroll"><table><thead><tr><th>Lista</th><th>Contacto</th><th>Teléfono</th><th>Estado</th></tr></thead><tbody>{turnPending.map(contact=><tr key={contact.id}><td>{contact.list}</td><td>{contact.name}</td><td>{contact.phone}</td><td>{contact.status==="exhausted"?"Intentos agotados":"Pendiente"}</td></tr>)}</tbody></table>{!turnPending.length&&<p>No hay números pendientes del turno.</p>}</div><button className="dash-outline" disabled={disabled||!uncalledPending.length||!available.length||campaign?.status==="running"} onClick={recoverPending}>Llamar pendientes</button></details>
    <details className="dash-pending"><summary>Seguimientos con asesor ({campaign?.callbacks?.length||0})</summary>{campaign?.callbacks?.map((item,index)=><p key={item.id||index}>{item.name||item.phone||item.contactId} · {item.reason||"Solicitó asesor"} · {item.advisor||"Sin asesor asignado"}</p>)}</details>
    <AudioPanel socket={panel.socket} connected={connected}/>
    <footer className="dash-footer"><span>El avance se conserva al pausar o finalizar el turno.</span><button disabled={disabled||active.length>0} onClick={()=>action("/turn/finalize",{},"¿Finalizar este turno y desconectar los equipos? El historial se conservará.")}>Finalizar turno</button><button disabled={disabled||active.length>0} onClick={()=>action("/session/finalize",{},"¿Reiniciar la sesión operativa y desvincular los equipos? Se conservan la base y el historial.")}>Reiniciar sesión</button></footer>
   </main>
  </div>
 </div>;
}
