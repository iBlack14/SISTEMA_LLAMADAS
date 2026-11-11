import { useEffect, useState } from "react";
import type { User } from "./api";
export interface Account { user:User;csrfToken:string }
export async function readJson<T>(response:Response):Promise<T>{
 const data=await response.json().catch(()=>({}));
 if(response.status===401){location.assign("/login");throw new Error("Inicia sesión.");}
 if(!response.ok || data.ok===false)throw new Error(data.error||"No se pudo completar la solicitud.");
 return data as T;
}
export async function getAccount(signal?:AbortSignal):Promise<Account>{
 return readJson<Account>(await fetch("/api/auth/me",{signal,cache:"no-store"}));
}
export async function signOut(csrfToken:string){
 await readJson(await fetch("/api/auth/logout",{method:"POST",headers:{"X-CSRF-Token":csrfToken}}));
 const channel=typeof BroadcastChannel==="function"?new BroadcastChannel("calls-account"):null;
 channel?.postMessage("changed");channel?.close();location.assign("/login");
}
export function useAccount(adminOnly=false){
 const [account,setAccount]=useState<Account|null>(null);
 const [error,setError]=useState("");
 useEffect(()=>{
  const controller=new AbortController();
  getAccount(controller.signal).then(value=>{
   if(controller.signal.aborted)return;
   if(adminOnly&&value.user.role!=="ADMINISTRADOR"){location.replace("/");return;}
   setAccount(value);
  }).catch(cause=>{if(!controller.signal.aborted)setError(cause.message);});
  const channel=typeof BroadcastChannel==="function"?new BroadcastChannel("calls-account"):null;
  if(channel)channel.onmessage=()=>location.assign("/");
  return()=>{controller.abort();channel?.close();};
 },[adminOnly]);
 return {account,error};
}
