import { useState } from "react";
import type { Worker,Slot,Campaign } from "../dashboard-types";
import type { Book,Contact } from "../api";
import { Dialog } from "./Dialog";
export function WorkerControls({slot,worker,book,campaign,disabled,action,assign,command}:{slot:Slot;worker?:Worker;book:Book|null;campaign:Campaign|null;disabled:boolean;action:(path:string,body?:unknown,confirmation?:string,method?:string)=>unknown;assign:(slotId:string,list:string)=>unknown;command:(action:string,workerId:string)=>unknown}){
 const [result,setResult]=useState("interesado");const [reason,setReason]=useState("");const [advisor,setAdvisor]=useState("");
 const [reporting,setReporting]=useState(false);
 const saved=book?.preferences.pairingListAssignments;
 const assignments=saved&&typeof saved==="object"?saved as Record<string,string>:{};
 const assignedList=assignments[slot.id]||"";
 const active=campaign?.contacts?.find(contact=>contact.targetWorkerId===worker?.id&&["dialing","ringing","in_call"].includes(contact.status))||
  campaign?.contacts?.find(contact=>contact.id===worker?.activeContactId);
 const id=worker?.id||slot.deviceId;
 const prefix="/workers/"+encodeURIComponent(id);
 const selected=(book?.contacts||[]).filter(contact=>contact.list===assignedList&&!contact.doNotCall&&(!contact.callBlockedUntil||Date.parse(contact.callBlockedUntil)<=Date.now()));
 function independent(){
  if(!id)return;
  if(!campaign?.contacts?.length||campaign.status==="completed"||campaign.status==="stopped"){
   if(!assignedList||!selected.length)return;
   return action("/campaign/start",{listName:assignedList,maxAttempts:1,contacts:selected.map(contact=>({...contact,targetWorkerId:id}))});
  }
  return action(prefix+"/start-independent");
 }
 return <div className="worker-extra"><label>Lista asignada<select value={assignedList} disabled={disabled} onChange={e=>assign(slot.id,e.target.value)}><option value="">Sin asignar</option>{book?.lists.map(name=><option key={name}>{name}</option>)}</select></label>
 {slot.deviceId?<><div className="worker-extra-actions"><button disabled={disabled||!worker?.connected||(!assignedList&&!campaign?.contacts?.length)} onClick={independent}>Iniciar equipo</button><button disabled={disabled||!worker?.connected} onClick={()=>action(prefix+"/stop-independent")}>Detener equipo</button><button disabled={disabled||!worker?.connected} onClick={()=>command(worker?.speakerOn?"speaker_off":"speaker_on",id)}>{worker?.speakerOn?"Apagar altavoz":"Activar altavoz"}</button><button disabled={disabled||!worker?.connected} onClick={()=>command("mute",id)}>Silenciar micrófono</button><button disabled={disabled||!worker?.connected} onClick={()=>command("unmute",id)}>Activar micrófono</button><button disabled={disabled||!active} onClick={()=>action("/campaign/skip",{workerId:id})}>Saltar contacto</button><button disabled={disabled||!active} onClick={()=>setReporting(true)}>Registrar resultado</button><button disabled={disabled} onClick={()=>action(prefix+"/disconnect",{},"¿Desvincular este equipo? Se colgará su llamada actual y se conservará el historial.")}>Desvincular</button></div>{assignedList&&book&&<button className="text-button" disabled={disabled} onClick={async()=>{const next=book.lists.find(name=>name!==assignedList&&book.contacts.some(contact=>contact.list===name));if(next){const response=await action(prefix+"/switch-list",{currentList:assignedList,nextList:next},"¿Saltar a la siguiente lista conservando los pendientes?");if(response)assign(slot.id,next);}}}>Saltar a la siguiente lista</button>}</>:<button className="text-button" disabled={disabled} onClick={()=>action("/pairing-slots/"+encodeURIComponent(slot.id),{},"¿Eliminar este QR sin vincular?","DELETE")}>Eliminar QR</button>}
 {reporting&&active&&<Dialog title={"Resultado de "+active.name} onClose={()=>setReporting(false)} busy={disabled}><label>Resultado<select value={result} onChange={e=>setResult(e.target.value)}>{["interesado","no_interesado","agendado","requiere_asesor","sin_respuesta","numero_incorrecto","reintentar"].map(value=><option key={value} value={value}>{value.replaceAll("_"," ")}</option>)}</select></label><label>Motivo / resumen<textarea value={reason} onChange={e=>setReason(e.target.value)}/></label><label>Asesor<input value={advisor} onChange={e=>setAdvisor(e.target.value)}/></label><div className="editor-actions"><button className="primary" disabled={disabled} onClick={()=>{action("/campaign/result",{contactId:active.id,result,callbackReason:reason,transcriptSummary:reason,assignedAdvisor:advisor});setReporting(false);}}>Guardar resultado</button></div></Dialog>}
 </div>;
}
