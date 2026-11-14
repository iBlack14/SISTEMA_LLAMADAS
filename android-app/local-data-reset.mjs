// One-time local maintenance. Requires the application server to be stopped.
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
dotenv.config({path:fileURLToPath(new URL('../.env',import.meta.url)),quiet:true});
if (!process.argv.includes('--confirm-local-reset')) throw Error('Explicit reset flag required');
if (!['localhost','127.0.0.1'].includes(process.env.DB_HOST) || process.env.DB_NAME !== 'llamdas' || process.env.APP_ENV === 'easypanel' || Number(process.env.DB_PORT||3306)!==3306) throw Error('Expected local llamdas:3306');
const listening = await new Promise(resolve => {
 const s=net.connect({host:'127.0.0.1',port:Number(process.env.PORT||3000)});
 s.once('connect',()=>{s.destroy();resolve(true);});
 s.once('error',()=>resolve(false));
});
if(listening) throw Error('Stop server first');
const db=await mysql.createConnection({host:'127.0.0.1',port:3306,user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:'llamdas'});
try {
 await db.beginTransaction();
 const [rows]=await db.query('SELECT id,data FROM sessions FOR UPDATE');
 let contacts=0;
 for(const row of rows){
  const s=typeof row.data==='string'?JSON.parse(row.data):row.data;
  if((s.phoneWorkers||[]).some(w=>['dialing','ringing','in_call'].includes(w.callState))) throw Error('Active call: reset cancelled');
  contacts+=(s.contactBook?.contacts||[]).length;
  if(s.contactBook){
   s.contactBook.contacts=[];
   for(const key of ['calledCounts','contactRowStatus','callDurations','dismissedReminderIds']) s.contactBook[key]={};
  }
  s.contactBookRevision=Number(s.contactBookRevision||0)+1;
  delete s.campaign;
  s.reportArchive=[];
  s.hasCallHistory=false;
  s.messageContacts=[];
  s.callState='idle';
  for(const key of ['lastNumber','lastCompanyName','lastContactName','lastImageUrl']) s[key]='';
  if(s.shiftManagement){
   s.shiftManagement.currentReport=[];
   for(const shift of s.shiftManagement.history||[]) shift.report=[];
  }
  for(const w of s.phoneWorkers||[]){
   w.callState='idle'; w.activeContactId=null;
   w.lastNumber='';w.lastCompanyName='';
  }
  s.updatedAt=Date.now();
  await db.execute('UPDATE sessions SET data=? WHERE id=?',[JSON.stringify(s),row.id]);
 }
 const removed={contacts};
 for(const table of ['vc_call_attempts','vc_call_contacts','vc_call_campaigns','vc_call_turns']){
  const [r]=await db.query('DELETE FROM '+table);removed[table]=r.affectedRows;
 }
 await db.commit();
 console.log(JSON.stringify({database:'llamdas',removed}));
 const [check]=await db.query('SELECT COUNT(*) AS remainingCalls FROM vc_call_attempts');
 console.log(check);
} catch(e){await db.rollback();throw e;} finally {await db.end();}
