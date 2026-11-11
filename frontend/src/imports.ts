import type { Contact } from "./api";
export interface Batch { list:string;contacts:Contact[] }
export function normalizePhone(input:unknown){
 let phone=String(input??"").trim().replace(/\D/g,"");
 if(phone.length===11&&phone.startsWith("51"))phone=phone.slice(2);
 return phone;
}
const label=(value:unknown)=>String(value??"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().trim();
export function fromRows(rows:unknown[][],list:string):Contact[]{
 const index=rows.findIndex(row=>row.some(cell=>/^(telefono|phone|tel|celular|movil|numero|whatsapp)(\b|\s)/.test(label(cell))));
 const header=index>=0?rows[index].map(label):[];
 const find=(regex:RegExp,fallback:number)=>{const i=header.findIndex(value=>regex.test(value));return i>=0?i:fallback;};
 const phoneColumn=find(/telefono|phone|^tel$|celular|movil|numero|whatsapp/,1);
 const nameColumn=find(/nombre|name|empresa|contacto|razon/,0);
 const noteColumn=find(/nota|note|observacion|web|sitio/,2);
 const seen=new Set<string>();
 return rows.slice(index>=0?index+1:0).flatMap(row=>{
  const phone=normalizePhone(row[phoneColumn]);
  if(!/^\d{6,15}$/.test(phone)||seen.has(phone))return [];
  seen.add(phone);
  return [{id:crypto.randomUUID(),name:String(row[nameColumn]||"Contacto").trim(),phone,list,note:String(row[noteColumn]||"").trim()}];
 });
}
export function fromHtml(html:string,list:string):Contact[]{
 const doc=new DOMParser().parseFromString(html,"text/html");
 const rows=[...doc.querySelectorAll("tr")].map(row=>[...row.querySelectorAll("td,th")].map(cell=>cell.textContent||""));
 return fromRows(rows,list);
}
export async function parseFiles(files:File[]):Promise<Batch[]>{
 const batches:Batch[]=[];
 for(const file of files){
  if(file.size>20*1024*1024)throw new Error(file.name+": el archivo supera 20 MB.");
  const list=file.name.replace(/\.[^.]+$/,"");const content=await file.arrayBuffer();
  if(/\.docx$/i.test(file.name)){
   const mammoth=await import("mammoth");
   const result=await mammoth.convertToHtml({arrayBuffer:content});
   let contacts=fromHtml(result.value,list);
   if(!contacts.length){
    const raw=await mammoth.extractRawText({arrayBuffer:content});
    contacts=fromRows(raw.value.split(/\r?\n/).filter(Boolean).map(line=>line.split(/[;\t,]/)),list);
   }
   if(!contacts.length)throw new Error(file.name+": no se detectaron columnas de contactos.");
   batches.push({list,contacts});
  }else{
   const XLSX=await import("xlsx");
   const workbook=XLSX.read(content,{type:"array",cellDates:false});
   for(const sheet of workbook.SheetNames){
    const sheetList=workbook.SheetNames.length>1?list+" · "+sheet:list;
    const rows=XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheet],{header:1,defval:"",raw:false});
    const contacts=fromRows(rows,sheetList);
    if(contacts.length)batches.push({list:sheetList,contacts});
   }
  }
 }
 if(!batches.length)throw new Error("No se detectaron contactos válidos. Revisa las columnas Nombre y Teléfono.");
 return batches;
}
