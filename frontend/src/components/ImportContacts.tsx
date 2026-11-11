import { useState } from "react";
import type { Book } from "../api";
import { fromHtml,parseFiles } from "../imports";
import type { Batch } from "../imports";
import { Dialog } from "./Dialog";
export function ImportContacts({book,commit,onClose}:{book:Book;commit:(book:Book)=>Promise<void>;onClose:()=>void}){
 const [batches,setBatches]=useState<Batch[]>([]);const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");const [url,setUrl]=useState("");
 const [list,setList]=useState("Importación web");
 async function files(files:FileList|null){
  if(!files)return;setBusy(true);setError("");
  try{setBatches(await parseFiles([...files]));}catch(cause){setError(cause instanceof Error?cause.message:"No se pudo leer el archivo.");}
  finally{setBusy(false);}
 }
 async function website(){
  setBusy(true);setError("");
  try{
   const response=await fetch("/api/fetch-url?url="+encodeURIComponent(url),{cache:"no-store"});
   const data=await response.json();if(!response.ok||!data.ok)throw new Error(data.error||"No se pudo leer la URL.");
   const contacts=fromHtml(data.html||"",list);
   if(!contacts.length)throw new Error("No hay una tabla con contactos válidos en esa URL.");
   setBatches([{list,contacts}]);
  }catch(cause){setError(cause instanceof Error?cause.message:"No se pudo leer la URL.");}
  finally{setBusy(false);}
 }
 async function save(){
  setBusy(true);setError("");
  try{
   const seen=new Set(book.contacts.map(contact=>JSON.stringify([contact.list,contact.phone])));
   const contacts=batches.flatMap(batch=>batch.contacts).filter(contact=>{
    const key=JSON.stringify([contact.list,contact.phone]);if(seen.has(key))return false;seen.add(key);return true;
   });
   if(contacts.length+book.contacts.length>100000)throw new Error("La base admite hasta 100000 contactos.");
   await commit({...book,lists:[...new Set([...book.lists,...batches.map(batch=>batch.list)])],contacts:[...book.contacts,...contacts]});
   onClose();
  }catch(cause){setError(cause instanceof Error?cause.message:"No se pudo guardar.");}
  finally{setBusy(false);}
 }
 return <Dialog title="Importar contactos" onClose={onClose} busy={busy}><p>Word, Excel, CSV o TXT. Cada archivo crea una lista; los duplicados de la misma lista se omiten.</p><label>Archivos<input type="file" multiple accept=".docx,.xlsx,.xls,.csv,.txt" disabled={busy} onChange={e=>files(e.target.files)}/></label><details><summary>Importar desde una URL</summary><label>Nombre de lista<input value={list} onChange={e=>setList(e.target.value)}/></label><label>URL pública<input type="url" value={url} onChange={e=>setUrl(e.target.value)}/></label><button type="button" className="secondary" disabled={busy||!url||!list.trim()} onClick={website}>Leer tabla</button></details>{error&&<p role="alert" className="feedback error">{error}</p>}{busy&&<p role="status">Procesando…</p>}{batches.length>0&&<><h3>Vista previa · {batches.reduce((sum,batch)=>sum+batch.contacts.length,0)} contactos</h3><div className="import-preview">{batches.map((batch,index)=><div key={index}><strong>{batch.list} ({batch.contacts.length})</strong><ul>{batch.contacts.slice(0,5).map(contact=><li key={contact.id}>{contact.name} · {contact.phone}</li>)}</ul></div>)}</div><button className="primary" disabled={busy} onClick={save}>Guardar importación</button></>}</Dialog>;
}
