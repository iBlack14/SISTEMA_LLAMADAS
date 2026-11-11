import { useEffect,useMemo,useRef,useState } from "react";
import { callStatus,openAccess,readBook,saveBook } from "./api";
import type { Access,Book,Contact } from "./api";
import { Dialog } from "./components/Dialog";
import { ImportContacts } from "./components/ImportContacts";
import { WhatsApp } from "./components/WhatsApp";
import { downloadBlob,sessionRequest } from "./session-api";
import { normalizePhone } from "./imports";
import type { Worker } from "./dashboard-types";

export function App({embedded=false,providedAccess,onBookChanged}:{embedded?:boolean;providedAccess?:Access;onBookChanged?:()=>void}={}){
 const [access,setAccess]=useState<Access|null>(null);const [book,setBook]=useState<Book|null>(null);
 const revision=useRef(0);const writing=useRef(false);
 const [loading,setLoading]=useState(true);const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");const [notice,setNotice]=useState("");
 const [list,setList]=useState("");const [query,setQuery]=useState("");const [filter,setFilter]=useState("all");const [page,setPage]=useState(1);
 const [editing,setEditing]=useState<Contact|null>(null);const [importing,setImporting]=useState(false);
 const [listDialog,setListDialog]=useState(false);const [listName,setListName]=useState("");
 const [whatsapp,setWhatsApp]=useState<Contact|null>(null);const [calling,setCalling]=useState<Contact|null>(null);
 const [workers,setWorkers]=useState<Worker[]>([]);const [workerId,setWorkerId]=useState("");
 const [reminders,setReminders]=useState(false);
 async function load(auth:Access,signal?:AbortSignal){
  const result=await readBook(auth,signal);
  if(signal?.aborted)return;
  revision.current=result.revision;
  setBook(result.book||{contacts:[],lists:["Principal"],calledCounts:{},contactRowStatus:{},callDurations:{},dismissedReminderIds:{},preferences:{}});
 }
 useEffect(()=>{
  const controller=new AbortController();
  (providedAccess?Promise.resolve(providedAccess):openAccess(controller.signal)).then(async auth=>{
   if(controller.signal.aborted)return;setAccess(auth);await load(auth,controller.signal);
  }).catch(cause=>{if(!controller.signal.aborted)setError(cause.message);}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
  return()=>controller.abort();
 },[providedAccess]);
 async function refresh(){if(!access){location.assign("/");return;}setLoading(true);setError("");try{await load(access);}catch(cause){setError(cause instanceof Error?cause.message:"No se pudo actualizar.");}finally{setLoading(false);}}
 async function commit(next:Book){
  if(!access||writing.current)throw new Error("Espera a que termine el guardado actual.");
  writing.current=true;setBusy(true);setError("");
  try{
   revision.current=await saveBook(access,next,revision.current);setBook(next);
   await load(access);onBookChanged?.();setNotice("Cambios guardados.");
  }finally{writing.current=false;setBusy(false);}
 }
 async function mutate(next:Book){try{await commit(next);}catch(cause){setError(cause instanceof Error?cause.message:"No se pudo guardar.");}}
 const rows=useMemo(()=>(book?.contacts||[]).filter(contact=>
  (!list||contact.list===list)&&(filter==="all"||callStatus(contact).kind===filter)&&
  [contact.name,contact.phone,contact.note].join(" ").toLocaleLowerCase("es").includes(query.toLocaleLowerCase("es").trim())
 ),[book,list,query,filter]);
 const pages=Math.max(1,Math.ceil(rows.length/40));const currentPage=Math.min(page,pages);
 const counts=new Map<string,number>();for(const contact of book?.contacts||[])counts.set(contact.list,(counts.get(contact.list)||0)+1);
 const pendingReminders=(book?.contacts||[]).filter(contact=>/llamar|callback|recordar/i.test(contact.note)&&!book?.dismissedReminderIds[contact.id]);
 async function saveContact(event:React.FormEvent){
  event.preventDefault();if(!book||!editing)return;
  const phone=normalizePhone(editing.phone);
  if(!/^\d{6,15}$/.test(phone)){setError("Introduce un teléfono válido.");return;}
  if(book.contacts.some(item=>item.id!==editing.id&&item.list===editing.list&&normalizePhone(item.phone)===phone)){setError("Ese teléfono ya existe en esta lista.");return;}
  try{
   const contact={...editing,phone};const exists=book.contacts.some(item=>item.id===contact.id);
   await commit({...book,lists:[...new Set([...book.lists,contact.list])],contacts:exists?book.contacts.map(item=>item.id===contact.id?contact:item):[...book.contacts,contact]});setEditing(null);
  }catch(cause){setError(cause instanceof Error?cause.message:"No se pudo guardar.");}
 }
 async function prepareCall(contact:Contact){
  if(!access)return;setError("");
  try{
   const result=await sessionRequest<{workers:Worker[]}>(access,"/workers");
   const ready=result.workers.filter(worker=>worker.connected&&["idle","ended","failed","available"].includes(worker.callState));
   setWorkers(ready);setWorkerId(ready[0]?.id||"");setCalling(contact);
  }catch(cause){setError(cause instanceof Error?cause.message:"No se pudieron consultar los equipos.");}
 }
 async function dial(){
  if(!access||!calling||!workerId)return;setBusy(true);
  try{await sessionRequest(access,"/workers/"+encodeURIComponent(workerId)+"/call-contact",{contactId:calling.id,contact:calling});setCalling(null);setNotice("Orden de llamada enviada. Consulta el estado en el panel.");await load(access);}
  catch(cause){setError(cause instanceof Error?cause.message:"No se pudo llamar.");}finally{setBusy(false);}
 }
 function exportWord(){
  const esc=(text:string)=>text.replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]!));
  const html='<html><head><meta charset="UTF-8"></head><body><h1>Contactos</h1><table><tr><th>Lista</th><th>Nombre</th><th>Teléfono</th><th>Nota</th></tr>'+rows.map(contact=>'<tr>'+[contact.list,contact.name,contact.phone,contact.note].map(value=>'<td>'+esc(value)+'</td>').join("")+'</tr>').join("")+'</table></body></html>';
  downloadBlob(new Blob([html],{type:"application/msword"}),"contactos.doc");
 }
 return <div className={embedded?"contacts-embedded":"workspace"}>{!embedded&&<header className="masthead"><a className="brand" href="/"><span className="brand-symbol">VC</span><span>Gestión de llamadas<small>Contactos y listas</small></span></a><div className="account">{access?.user.username}<a href="/">Volver a llamadas</a><a href="/panel/reports">Reportes</a></div></header>}
 <div className="body-layout"><aside className="list-panel"><h2>Mis listas</h2><button className={"list-item "+(!list?"selected":"")} onClick={()=>{setList("");setPage(1);}}>Todas las listas <span>{book?.contacts.length||0}</span></button>{book?.lists.map(name=><button key={name} className={"list-item "+(list===name?"selected":"")} onClick={()=>{setList(name);setPage(1);}}>{name}<span>{counts.get(name)||0}</span></button>)}<button className="secondary" disabled={!book||busy} onClick={()=>{setListName("");setListDialog(true);}}>Nueva lista</button></aside>
 <main><div className="page-heading"><div><h1>{list||"Todos los contactos"}</h1><p>Bases importadas, notas y estado de cada número.</p></div><button className="secondary" disabled={loading||busy} onClick={refresh}>Actualizar</button></div>
 {error&&<p className="feedback error" role="alert">{error}</p>}{notice&&<p className="feedback success" role="status">{notice}</p>}
 <div className="module-actions"><button className="primary" disabled={!book||busy} onClick={()=>setImporting(true)}>Importar base</button><button className="secondary" disabled={!book||busy} onClick={()=>{setError("");setEditing({id:crypto.randomUUID(),name:"",phone:"",note:"",list:list||"Principal"});}}>Agregar contacto</button><button className="secondary" disabled={!rows.length} onClick={exportWord}>Exportar Word</button><button className="secondary" onClick={()=>setReminders(!reminders)}>Recordatorios ({pendingReminders.length})</button>{list&&list!=="Principal"&&<button className="text-button" disabled={busy} onClick={()=>{if(book&&confirm("¿Eliminar la lista "+list+" y sus contactos? El historial de llamadas se conserva.")){mutate({...book,lists:book.lists.filter(name=>name!==list),contacts:book.contacts.filter(contact=>contact.list!==list)});setList("");}}}>Eliminar lista</button>}<button className="text-button" disabled={!book?.contacts.length||busy} onClick={()=>{if(book&&confirm("¿Eliminar todas las listas y contactos? El historial se conserva."))mutate({...book,contacts:[],lists:["Principal"],calledCounts:{},contactRowStatus:{},callDurations:{},dismissedReminderIds:{}});}}>Eliminar todo</button></div>
 {reminders&&<section className="reminders"><h2>Recordatorios</h2>{pendingReminders.map(contact=><div key={contact.id}><strong>{contact.name}</strong><p>{contact.note}</p><button className="secondary" disabled={busy} onClick={()=>book&&mutate({...book,dismissedReminderIds:{...book.dismissedReminderIds,[contact.id]:true}})}>Descartar recordatorio</button></div>)}{!pendingReminders.length&&<p>No hay recordatorios pendientes.</p>}</section>}
 <div className="filters"><label className="search">Buscar contacto<input type="search" value={query} onChange={e=>{setQuery(e.target.value);setPage(1);}} placeholder="Nombre, teléfono o nota…"/></label><label>Estado<select value={filter} onChange={e=>{setFilter(e.target.value);setPage(1);}}><option value="all">Todos los estados</option><option value="available">Disponibles</option><option value="waiting">Llamados anteriormente</option><option value="blocked">No volver a llamar</option></select></label></div>
 <div className="table-caption" role="status"><span>{loading?"Cargando…":rows.length+" contactos"}</span><span>{access&&"Sesión "+access.code}</span></div>
 <div className="table-scroll" tabIndex={0} aria-label="Contactos"><table><thead><tr><th>Contacto / lista</th><th>Teléfono</th><th>Estado</th><th>Nota</th><th>Acciones</th></tr></thead><tbody>{rows.slice((currentPage-1)*40,currentPage*40).map(contact=>{
 const status=callStatus(contact);
 return <tr key={contact.id}><td><strong>{contact.name}</strong><small>{contact.list}</small></td><td>{contact.phone}<small>{book?.calledCounts[contact.id]||0} intentos</small></td><td><span className={"status "+status.kind}>{status.label}</span>{contact.callBlockedUntil&&<small>Disponible el {new Date(contact.callBlockedUntil).toLocaleDateString("es-PE",{timeZone:"America/Lima"})}</small>}</td><td className="note">{contact.note||"Sin nota"}</td><td><div className="row-actions"><button className="text-button" disabled={busy} onClick={()=>{setError("");setEditing({...contact});}}>Editar</button><button className="text-button" disabled={busy||status.kind!=="available"} onClick={()=>prepareCall(contact)}>Llamar</button><button className="text-button" disabled={busy} onClick={()=>setWhatsApp(contact)}>WhatsApp</button><button className="text-button" disabled={busy} onClick={()=>book&&confirm("¿Eliminar a "+contact.name+"?")&&mutate({...book,contacts:book.contacts.filter(item=>item.id!==contact.id)})}>Eliminar</button></div></td></tr>;
 })}</tbody></table>{!loading&&!rows.length&&<div className="empty"><h2>No hay contactos en esta selección</h2><p>Importa una base o cambia los filtros.</p></div>}</div>
 <nav className="pagination" aria-label="Páginas de contactos"><button className="secondary" disabled={currentPage===1} onClick={()=>setPage(currentPage-1)}>Anterior</button><span>Página {currentPage} de {pages}</span><button className="secondary" disabled={currentPage===pages} onClick={()=>setPage(currentPage+1)}>Siguiente</button></nav>
 </main></div>
 {editing&&book&&<Dialog title={book.contacts.some(contact=>contact.id===editing.id)?"Editar contacto":"Nuevo contacto"} busy={busy} onClose={()=>setEditing(null)}><form onSubmit={saveContact}><label>Nombre<input autoFocus required value={editing.name} onChange={e=>setEditing({...editing,name:e.target.value})}/></label><label>Teléfono<input required value={editing.phone} onChange={e=>setEditing({...editing,phone:e.target.value})}/></label><label>Lista<select value={editing.list} onChange={e=>setEditing({...editing,list:e.target.value})}>{book.lists.map(name=><option key={name}>{name}</option>)}</select></label><label>Nota<textarea rows={4} value={editing.note} onChange={e=>setEditing({...editing,note:e.target.value})}/></label>{error&&<p className="feedback error" role="alert">{error}</p>}<div className="editor-actions"><button className="primary" disabled={busy}>Guardar contacto</button></div></form></Dialog>}
 {listDialog&&book&&<Dialog title="Nueva lista" busy={busy} onClose={()=>setListDialog(false)}><form onSubmit={async e=>{e.preventDefault();try{const name=listName.trim();if(!name)return;await commit({...book,lists:[...new Set([...book.lists,name])]});setList(name);setListDialog(false);}catch(cause){setError(cause instanceof Error?cause.message:"No se pudo crear.");}}}><label>Nombre<input autoFocus required maxLength={80} value={listName} onChange={e=>setListName(e.target.value)}/></label>{error&&<p role="alert">{error}</p>}<div className="editor-actions"><button className="primary" disabled={busy}>Crear lista</button></div></form></Dialog>}
 {importing&&book&&<ImportContacts book={book} commit={commit} onClose={()=>setImporting(false)}/>}
 {whatsapp&&book&&access&&<WhatsApp contact={whatsapp} book={book} access={access} commit={commit} onClose={()=>setWhatsApp(null)}/>}
 {calling&&<Dialog title={"Llamar a "+calling.name} busy={busy} onClose={()=>setCalling(null)}><p>{calling.phone}</p><label>Equipo disponible<select value={workerId} onChange={e=>setWorkerId(e.target.value)}>{workers.map(worker=><option key={worker.id} value={worker.id}>{worker.name}</option>)}</select></label>{!workers.length&&<p>No hay equipos disponibles. Vincula uno desde el panel de llamadas.</p>}{error&&<p className="feedback error" role="alert">{error}</p>}<div className="editor-actions"><button className="primary" disabled={busy||!workerId} onClick={dial}>Enviar llamada</button></div></Dialog>}
 </div>;
}
