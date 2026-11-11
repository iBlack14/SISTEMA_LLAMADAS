import { useState } from "react";
export const todayLima=()=>new Intl.DateTimeFormat("en-CA",{timeZone:"America/Lima",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
export interface Period{from:string;to:string}
const months=["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
export function Calendar({period,onChange,counts}:{period:Period;onChange:(period:Period)=>void;counts:Map<string,number>}){
 const [year,setYear]=useState(()=>Number((period.from||todayLima()).slice(0,4)));
 const [start,setStart]=useState("");
 const [draft,setDraft]=useState(period);
 const [error,setError]=useState("");
 function apply(next:Period){
  if((next.from&&!next.to)||(!next.from&&next.to)||next.from>next.to){setError("Elige un rango completo, con la fecha inicial antes de la final.");return;}
  setStart("");setError("");setDraft(next);onChange(next);
 }
 return <section className="calendar-react"><div className="calendar-tools"><div className="module-actions"><button className="secondary" onClick={()=>apply({from:todayLima(),to:todayLima()})}>Hoy</button><button className="secondary" onClick={()=>{const date=new Date(todayLima()+"T12:00:00Z");date.setUTCDate(date.getUTCDate()-6);apply({from:date.toISOString().slice(0,10),to:todayLima()});}}>Últimos 7 días</button><button className="secondary" onClick={()=>apply({from:todayLima().slice(0,8)+"01",to:todayLima()})}>Este mes</button><button className="secondary" onClick={()=>apply({from:"",to:""})}>Todo el historial</button></div><form className="date-range" onSubmit={e=>{e.preventDefault();apply(draft);}}><label>Desde<input type="date" value={draft.from} onChange={e=>setDraft({...draft,from:e.target.value})}/></label><label>Hasta<input type="date" value={draft.to} onChange={e=>setDraft({...draft,to:e.target.value})}/></label><button className="primary">Aplicar período</button></form></div>{error&&<p role="alert" className="feedback error">{error}</p>}<div className="calendar-year"><h2>Calendario anual</h2><button className="secondary" aria-label="Año anterior" onClick={()=>setYear(year-1)}>‹</button><strong>{year}</strong><button className="secondary" aria-label="Año siguiente" onClick={()=>setYear(year+1)}>›</button></div><p role="status">{start?"Inicio: "+start+". Ahora elige el día final.":"Elige el día inicial y después el día final. Para un solo día, selecciónalo dos veces."}</p><div className="calendar-months">{months.map((name,month)=>{
 const offset=new Date(Date.UTC(year,month,1)).getUTCDay();const days=new Date(Date.UTC(year,month+1,0)).getUTCDate();
 return <article key={name}><h3>{name}</h3><div className="calendar-days">{["D","L","M","M","J","V","S"].map((day,index)=><b key={"day"+index}>{day}</b>)}{Array.from({length:offset},(_,index)=><i key={"blank"+index}/>)}{Array.from({length:days},(_,index)=>{
 const date=year+"-"+String(month+1).padStart(2,"0")+"-"+String(index+1).padStart(2,"0");
 const selected=Boolean(start?start===date:period.from&&date>=period.from&&date<=period.to);
 return <button key={date} aria-pressed={selected} className={selected?"selected":""} aria-label={date+", "+(counts.get(date)||0)+" intentos"} onClick={()=>{if(!start){setStart(date);setDraft({from:date,to:""});}else apply({from:start<date?start:date,to:start<date?date:start});}}>{index+1}{counts.has(date)&&<small aria-hidden="true">•</small>}</button>;
 })}</div></article>;
 })}</div></section>;
}
