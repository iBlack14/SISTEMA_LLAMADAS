import type { Book } from "./api";
export interface Worker { id:string; name:string; connected:boolean; callState:string; paused?:boolean; activeContactId?:string; companyName?:string; phoneNumber?:string; speakerOn?:boolean }
export interface Slot { id:string; label:string; deviceId:string; deviceName:string; connected:boolean }
export interface Shift { label?:string; schedule?:string; date?:string }
export interface Campaign {
 status:string; listName?:string; counts:Record<string,number>;
 contacts?:{id:string;name:string;phone:string;list:string;status:string;note?:string;attempts?:number;technicalResult?:string;targetWorkerId?:string}[];
 callbacks?:{id?:string;contactId:string;name?:string;phone?:string;reason?:string;advisor?:string}[];
 history?:{attemptId?:string;contactId:string;phone:string;name:string;list:string;technicalResult:string;startedAt:string}[];
 turn?:{current?:Shift;detected?:Shift;pendingContacts?:{id:string;list:string;name:string;phone:string;status:string;recoveryAttempts?:number}[]};
}
export interface LiveState { phoneWorkers?:Worker[];storage?:{mode:string};shiftManagement?:Campaign["turn"];callState?:string }
export interface DashboardData { book:Book|null;slots:Slot[];campaign:Campaign|null }
export interface LiveSocket {
 on<T=void>(event:string,handler:(payload:T)=>void):LiveSocket;
 off<T=void>(event:string,handler:(payload:T)=>void):LiveSocket;
 emit(event:string,payload?:unknown):LiveSocket;
 connect():LiveSocket;disconnect():LiveSocket;
}
declare global { interface Window { io:(options:unknown)=>LiveSocket } }
