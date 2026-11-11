import { useEffect,useState } from "react";
import type { Access,Book,Contact } from "../api";
import { Dialog } from "./Dialog";
export function WhatsApp({contact,book,access,commit,onClose}:{contact:Contact;book:Book;access:Access;commit:(book:Book)=>Promise<void>;onClose:()=>void}){
 const [message,setMessage]=useState("");const [file,setFile]=useState<File|null>(null);
 const [busy,setBusy]=useState(false);const [error,setError]=useState("");
 const [connected,setConnected]=useState(false);const [qr,setQr]=useState("");
 const templates=Array.isArray(book.preferences.whatsappPresetMessages)?book.preferences.whatsappPresetMessages as string[]:[];
 useEffect(()=>{
  const controller=new AbortController();
  const refresh=async()=>{try{
   const response=await fetch("/api/whatsapp/status",{signal:controller.signal,cache:"no-store"});
   if(!response.ok)throw new Error("La integración de WhatsApp no está disponible en este servidor.");
   const status=await response.json();const linked=Boolean(status.connected||status.linked||status.status==="connected"||status.state==="open");
   setConnected(linked);
   if(!linked){const response=await fetch("/api/whatsapp/qr",{signal:controller.signal,cache:"no-store"});const data=await response.json();if(!controller.signal.aborted)setQr(data.qr||data.qrImage||"");}
  }catch(cause){if(!controller.signal.aborted)setError(cause instanceof Error?cause.message:"No se pudo conectar WhatsApp.");}};
  refresh();const interval=setInterval(refresh,10000);
  return()=>{controller.abort();clearInterval(interval);};
 },[]);
 async function send(){
  setBusy(true);setError("");
  try{
   const body=new FormData();body.append("to",contact.phone.length===9?"+51"+contact.phone:contact.phone);body.append("message",message);if(file)body.append("file",file);
   const response=await fetch("/api/whatsapp/send-message",{method:"POST",headers:{"X-CSRF-Token":access.csrfToken},body});
   const result=await response.json();if(!response.ok||!result.ok)throw new Error(result.error||"No se pudo enviar.");
   onClose();
  }catch(cause){setError(cause instanceof Error?cause.message:"No se pudo enviar.");}finally{setBusy(false);}
 }
 async function saveTemplate(){try{await commit({...book,preferences:{...book.preferences,whatsappPresetMessages:[...templates,message]}});}catch(cause){setError(cause instanceof Error?cause.message:"No se pudo guardar.");}}
 return <Dialog title={"WhatsApp · "+contact.name} onClose={onClose} busy={busy}><p>{contact.phone} · {connected?"Cuenta conectada":"Sin conexión"}</p>{error&&<p className="feedback error" role="alert">{error}</p>}{qr&&/^(data:image\/|https:\/\/)/.test(qr)&&<img className="wa-qr" src={qr} alt="QR de WhatsApp"/>}{templates.map((template,index)=><button key={index} className="secondary template-button" onClick={()=>setMessage(template)}>{template}</button>)}<label>Mensaje<textarea rows={4} value={message} onChange={e=>setMessage(e.target.value)}/></label><label>Archivo opcional<input type="file" onChange={e=>setFile(e.target.files?.[0]||null)}/></label><div className="editor-actions"><button className="secondary" disabled={busy||!message.trim()} onClick={saveTemplate}>Guardar como plantilla</button><button className="primary" disabled={busy||!connected||(!message.trim()&&!file)} onClick={send}>Enviar mensaje</button></div><a target="_blank" rel="noopener noreferrer" href={"https://wa.me/"+(contact.phone.length===9?"51":"")+contact.phone+"?text="+encodeURIComponent(message)}>Abrir en WhatsApp</a></Dialog>;
}
