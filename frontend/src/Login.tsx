import { useState } from "react";
import "./network.css";
export function Login(){
 const [username,setUsername]=useState("");const [password,setPassword]=useState("");
 const [error,setError]=useState("");const [busy,setBusy]=useState(false);
 async function submit(event:React.FormEvent){
  event.preventDefault();if(busy)return;setBusy(true);setError("");
  try{
   const response=await fetch("/api/auth/login",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({username,password})});
   const data=await response.json();
   if(!response.ok||!data.ok)throw new Error(data.error||"No se pudo iniciar sesión.");
   setPassword("");
   const channel=typeof BroadcastChannel==="function"?new BroadcastChannel("calls-account"):null;
   channel?.postMessage("changed");channel?.close();
   location.replace(data.redirect==="/admin/nucleo-red"?data.redirect:"/");
  }catch(cause){setError(cause instanceof Error?cause.message:"No se pudo conectar.");setBusy(false);}
 }
 return <main className="login-react"><div className="login-intro"><img src="/logo-vc-color.png" alt="VC"/><h1>Gestión de llamadas</h1><p>Tus equipos, bases y resultados en un solo sistema.</p></div><form className="login-form" onSubmit={submit}><h2>Iniciar sesión</h2><label>Usuario<input autoComplete="username" autoCapitalize="none" spellCheck={false} required maxLength={80} value={username} onChange={e=>setUsername(e.target.value)}/></label><label>Contraseña<input type="password" autoComplete="current-password" required maxLength={256} value={password} onChange={e=>setPassword(e.target.value)}/></label>{error&&<p className="feedback error" role="alert">{error}</p>}<button className="primary" disabled={busy}>{busy?"Ingresando…":"Ingresar"}</button></form></main>;
}
