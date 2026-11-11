import { useEffect,useRef,useState } from "react";
import type { LiveSocket } from "../dashboard-types";
export function AudioPanel({socket,connected}:{socket:LiveSocket|null;connected:boolean}){
 const [listening,setListening]=useState(false);const [speaking,setSpeaking]=useState(false);const [error,setError]=useState("");
 const ctx=useRef<AudioContext|null>(null);const stream=useRef<MediaStream|null>(null);
 const processor=useRef<ScriptProcessorNode|null>(null);const source=useRef<MediaStreamAudioSourceNode|null>(null);
 const playAt=useRef(0);const enabled=useRef(false);const alive=useRef(true);
 function context(){if(!ctx.current||ctx.current.state==="closed")ctx.current=new AudioContext();return ctx.current;}
 function stopMic(){processor.current?.disconnect();source.current?.disconnect();stream.current?.getTracks().forEach(track=>track.stop());processor.current=null;source.current=null;stream.current=null;setSpeaking(false);}
 useEffect(()=>{
  alive.current=true;
  const bytes=(payload:ArrayBuffer|ArrayBufferView)=>payload instanceof ArrayBuffer?payload.slice(0):new Uint8Array(payload.buffer,payload.byteOffset,payload.byteLength).slice().buffer;
  const play=async(payload:ArrayBuffer|ArrayBufferView,encoded=false)=>{
   if(!enabled.current)return;
   try{
    const audio=context();await audio.resume();const data=bytes(payload);
    let buffer:AudioBuffer;
    const header=new Uint8Array(data.slice(0,4));
    const compressed=encoded&&((header[0]===73&&header[1]===68&&header[2]===51)||(header[0]===255&&(header[1]&224)===224)||(header[0]===82&&header[1]===73&&header[2]===70));
    if(compressed)buffer=await audio.decodeAudioData(data);
    else{
     const pcm=new Int16Array(data.slice(0,data.byteLength-data.byteLength%2));const floats=new Float32Array(pcm.length);
     for(let i=0;i<pcm.length;i++)floats[i]=pcm[i]/32768;
     buffer=audio.createBuffer(1,floats.length,16000);buffer.copyToChannel(floats,0);
    }
    if(!enabled.current||audio.state==="closed")return;
    const output=audio.createBufferSource();output.buffer=buffer;output.connect(audio.destination);
    playAt.current=Math.max(audio.currentTime+.02,Math.min(playAt.current,audio.currentTime+1));output.start(playAt.current);playAt.current+=buffer.duration;
   }catch{if(alive.current)setError("No se pudo reproducir el audio.");}
  };
  const phone=(data:ArrayBuffer|ArrayBufferView)=>{void play(data);};const bot=(data:ArrayBuffer|ArrayBufferView)=>{void play(data,true);};
  socket?.on("audio:phone",phone);socket?.on("audio:bot",bot);
  return()=>{alive.current=false;enabled.current=false;socket?.off("audio:phone",phone);socket?.off("audio:bot",bot);processor.current?.disconnect();source.current?.disconnect();stream.current?.getTracks().forEach(track=>track.stop());ctx.current?.close().catch(()=>{});ctx.current=null;};
 },[socket]);
 useEffect(()=>{if(!connected){stopMic();setListening(false);enabled.current=false;}},[connected]);
 async function toggleListening(){
  setError("");const next=!listening;enabled.current=next;setListening(next);
  if(next){try{await context().resume();}catch{setError("No se pudo activar el audio del navegador.");}}
 }
 async function toggleMic(){
  if(speaking){stopMic();return;}setError("");
  try{
   const media=await navigator.mediaDevices.getUserMedia({audio:true,video:false});
   if(!alive.current||!connected){media.getTracks().forEach(track=>track.stop());return;}
   const audio=context();await audio.resume();stream.current=media;
   source.current=audio.createMediaStreamSource(media);processor.current=audio.createScriptProcessor(1024,1,1);
   processor.current.onaudioprocess=event=>{
    const input=event.inputBuffer.getChannelData(0);const ratio=audio.sampleRate/16000;const pcm=new Int16Array(Math.floor(input.length/ratio));
    for(let i=0;i<pcm.length;i++){const sample=Math.max(-1,Math.min(1,input[Math.floor(i*ratio)]));pcm[i]=sample<0?sample*32768:sample*32767;}
    socket?.emit("audio:dashboard",pcm.buffer);
   };
   source.current.connect(processor.current);processor.current.connect(audio.destination);setSpeaking(true);
  }catch{setError("Permite el micrófono del navegador para hablar desde la computadora.");stopMic();}
 }
 return <details className="dash-audio"><summary>Audio de la computadora</summary><p>Activa el audio sólo cuando quieras escuchar o hablar desde este navegador.</p><div><button disabled={!connected} aria-pressed={listening} onClick={toggleListening}>{listening?"Dejar de escuchar":"Escuchar equipo"}</button><button disabled={!connected} aria-pressed={speaking} onClick={toggleMic}>{speaking?"Apagar micrófono":"Hablar desde la computadora"}</button></div>{error&&<p role="alert">{error}</p>}</details>;
}
