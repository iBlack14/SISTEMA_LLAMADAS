import { useCallback, useEffect, useRef, useState } from "react";
import { readBook,saveBook } from "./api";
import type { Access, BookResponse, User } from "./api";
import type { Campaign, DashboardData, LiveSocket, LiveState, Slot } from "./dashboard-types";

async function responseJson<T>(response:Response):Promise<T> {
 if(response.status===401){window.location.assign("/login");throw new Error("Inicia sesión.");}
 const data=await response.json();
 if(!response.ok || !data.ok)throw new Error(data.error || "No se pudo completar la solicitud.");
 return data as T;
}
export function useDashboard(){
 const [access,setAccess]=useState<Access|null>(null);
 const [user,setUser]=useState<User|null>(null);
 const [data,setData]=useState<DashboardData>({book:null,slots:[],campaign:null});
 const [live,setLive]=useState<LiveState>({});
 const [connected,setConnected]=useState(false);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");
 const [message,setMessage]=useState("Conectando con tu sesión…");
 const socketRef=useRef<LiveSocket|null>(null);
 const current=useRef<Access|null>(null);
 const refreshSerial=useRef(0);
 const actionPending=useRef(false);

 const refresh=useCallback(async(signal?:AbortSignal)=>{
  const auth=current.current;if(!auth)return;
  const serial=++refreshSerial.current;
  const headers={"X-Dashboard-Token":auth.token};
  const [book,pairing,campaign]=await Promise.all([
   fetch("/api/session/"+auth.code+"/contact-book",{headers,signal,cache:"no-store"}).then(responseJson<BookResponse>),
   fetch("/api/pairing/"+auth.code,{headers,signal,cache:"no-store"}).then(responseJson<{ok:boolean;pairingSlots:Slot[]}>),
   fetch("/api/session/"+auth.code+"/campaign",{headers,signal,cache:"no-store"}).then(responseJson<{ok:boolean;campaign:Campaign}>)
  ]);
  if(!signal?.aborted && serial===refreshSerial.current)setData({book:book.book,slots:pairing.pairingSlots,campaign:campaign.campaign});
 },[]);

 useEffect(()=>{
  const controller=new AbortController();let socket:LiveSocket|null=null;
  let authUser:User;let csrf="";let creating=false;let closed=false;
  let refreshTimer:ReturnType<typeof setTimeout>|undefined;
  function laterRefresh(){
   if(refreshTimer)return;
   refreshTimer=setTimeout(()=>{refreshTimer=undefined;refresh(controller.signal).catch(cause=>{
    if(!controller.signal.aborted)setError(cause.message);
   });},350);
  }
  (async()=>{
   try{
    const auth=await responseJson<{ok:boolean;user:User;csrfToken:string}>(await fetch("/api/auth/me",{signal:controller.signal,cache:"no-store"}));
    if(closed)return;
    authUser=auth.user;csrf=auth.csrfToken;setUser(authUser);
    if(typeof window.io!=="function")throw new Error("No se pudo cargar la conexión en vivo. Recarga la página.");
    const prefix="voip vc.auth."+authUser.id;
    let code=(localStorage.getItem(prefix+".dashboardSessionCode")||"").trim().toUpperCase();
    let token=localStorage.getItem(prefix+".dashboardToken."+code)||"";
    const clientKey=prefix+".dashboardClientId";
    let clientId=sessionStorage.getItem(clientKey);
    if(!clientId){clientId=crypto.randomUUID();sessionStorage.setItem(clientKey,clientId);}
    const adopt=(nextCode:string,nextToken:string)=>{
     code=nextCode;token=nextToken;creating=false;
     localStorage.setItem(prefix+".dashboardSessionCode",code);
     localStorage.setItem(prefix+".dashboardToken."+code,token);
     current.current={user:authUser,csrfToken:csrf,code,token};setAccess(current.current);
     setError("");setMessage("Sesión lista. Vincula un equipo para comenzar.");laterRefresh();
    };
    socket=window.io({autoConnect:false,auth:{client:"dashboard",userId:authUser.id},transports:["websocket"]});
    socketRef.current=socket;
    socket.on("connect",()=>{
     setConnected(true);
     if(code&&token)socket!.emit("session:join",{code,token,role:"dashboard",dashboardClientId:clientId});
     else if(!creating){creating=true;socket!.emit("session:create",{dashboardClientId:clientId});}
    });
    socket.on("disconnect",()=>{setConnected(false);setMessage("Conexión interrumpida. Reconectando…");});
    socket.on<{code:string;dashboardToken:string}>("session:created",payload=>adopt(payload.code,payload.dashboardToken));
    socket.on<{code:string;role:string}>("session:joined",payload=>{if(payload.role==="dashboard")adopt(payload.code,token);});
    socket.on<LiveState>("state:changed",state=>{setLive(state);laterRefresh();});
    socket.on<Campaign>("campaign:state",campaign=>{setData(previous=>({...previous,campaign}));laterRefresh();});
    socket.on<{message?:string;reason?:string}>("session:error",payload=>{
     creating=false;setError(payload.message||"No se pudo abrir tu sesión.");
     if(payload.reason==="FORBIDDEN"||payload.reason==="AUTH_REQUIRED")window.location.assign("/login");
    });
    socket.on<{message:string}>("call:error",payload=>setError(payload.message));
    socket.on<{message:string}>("connect_error",cause=>setError(cause.message==="AUTH_REQUIRED" ? "Inicia sesión para conectar." : "No se pudo conectar con el servidor."));
    socket.connect();
   }catch(cause){if(!closed)setError(cause instanceof Error?cause.message:"No se pudo cargar el panel.");}
  })();
  const accountChannel=typeof BroadcastChannel==="function"?new BroadcastChannel("calls-account"):null;
  if(accountChannel)accountChannel.onmessage=()=>window.location.assign("/");
  return()=>{closed=true;controller.abort();clearTimeout(refreshTimer);socket?.disconnect();socketRef.current=null;current.current=null;accountChannel?.close();};
 },[refresh]);

 const action=useCallback(async(path:string,body:unknown={},confirmation?:string,method="POST")=>{
  const auth=current.current;
  if(!auth||!connected||actionPending.current)return;
  if(confirmation&&!window.confirm(confirmation))return;
  actionPending.current=true;setBusy(true);setError("");setMessage("");
  try{
   const result=await responseJson<{ok:boolean;campaign?:Campaign;dispatched?:number}>(await fetch("/api/session/"+auth.code+path,{
    method,headers:{"Content-Type":"application/json","X-Dashboard-Token":auth.token,"X-CSRF-Token":auth.csrfToken},body:JSON.stringify(body)
   }));
   if(result.campaign)setData(previous=>({...previous,campaign:result.campaign!}));
   setMessage("Acción completada.");await refresh();return result;
  }catch(cause){setError(cause instanceof Error?cause.message:"No se pudo completar la acción.");}
  finally{actionPending.current=false;setBusy(false);}
 },[connected,refresh]);

 async function logout(){
  if(actionPending.current)return;
  setBusy(true);
  try{
   const result=await fetch("/api/auth/logout",{method:"POST",headers:{"X-CSRF-Token":current.current?.csrfToken||""}});
   await responseJson(result);new BroadcastChannel("calls-account").postMessage("changed");window.location.assign("/login");
  }catch(cause){setError(cause instanceof Error?cause.message:"No se pudo cerrar sesión.");setBusy(false);}
 }
 async function assignList(slotId:string,list:string){
  const auth=current.current;if(!auth||actionPending.current)return;
  actionPending.current=true;setBusy(true);setError("");
  try{
   const result=await readBook(auth);if(!result.book)throw new Error("Importa una base antes de asignar listas.");
   const saved=result.book.preferences.pairingListAssignments;
   const assignments=typeof saved==="object"&&saved!==null?saved as Record<string,string>:{};
   await saveBook(auth,{...result.book,preferences:{...result.book.preferences,pairingListAssignments:{...assignments,[slotId]:list}}},result.revision);
   await refresh();setMessage("Lista asignada al equipo.");
  }catch(cause){setError(cause instanceof Error?cause.message:"No se pudo asignar la lista.");}
  finally{actionPending.current=false;setBusy(false);}
 }
 function command(action:string,workerId:string){
  if(!connected||!current.current)return;
  socketRef.current?.emit("call:action",{action,workerId,commandId:crypto.randomUUID()});
  setMessage("Orden enviada al equipo. Esperando confirmación de estado.");
 }
 return {access,user,data,live,connected,busy,error,message,action,refresh,logout,assignList,command,socket:socketRef.current};
}
