import type { Access } from "./api";
import { readJson } from "./account";
export async function sessionRequest<T>(access:Access,path:string,body?:unknown,method=body===undefined?"GET":"POST",signal?:AbortSignal):Promise<T>{
 return readJson<T>(await fetch("/api/session/"+access.code+path,{method,signal,cache:"no-store",headers:{"Content-Type":"application/json","X-Dashboard-Token":access.token,...(method!=="GET"?{"X-CSRF-Token":access.csrfToken}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})}));
}
export function downloadBlob(blob:Blob,filename:string){
 const url=URL.createObjectURL(blob);const link=document.createElement("a");
 link.href=url;link.download=filename;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export const resultLabel=(value:string)=>({numero_inexistente:"No volver a llamar",numero_llamado_anteriormente:"Número llamado anteriormente",buzon_de_voz:"Buzón de voz",sin_servicio:"Sin servicio",no_disponible:"No disponible",contesto:"Contestó",sin_respuesta:"Sin respuesta",no_contactado:"No contactado",numero_incorrecto:"Número incorrecto",interesado:"Interesado",no_interesado:"Sin interés",agendado:"Agendado",requiere_asesor:"Requiere asesor",reintentar:"Reintentar"}[value]||value.replaceAll("_"," ")||"Sin resultado");
