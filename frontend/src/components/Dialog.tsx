import { useEffect,useRef } from "react";
import type { ReactNode } from "react";
export function Dialog({title,children,onClose,busy=false}:{title:string;children:ReactNode;onClose:()=>void;busy?:boolean}){
 const ref=useRef<HTMLDialogElement>(null);
 const heading=useRef("dialog-"+crypto.randomUUID());
 useEffect(()=>{ref.current?.showModal();},[]);
 return <dialog ref={ref} className="editor-dialog" aria-labelledby={heading.current} onCancel={e=>{e.preventDefault();if(!busy)onClose();}}>
  <section className="editor"><div className="dialog-heading"><h2 id={heading.current}>{title}</h2><button type="button" disabled={busy} onClick={onClose} aria-label="Cerrar">×</button></div>{children}</section>
 </dialog>;
}
