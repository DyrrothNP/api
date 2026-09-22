import {spawn} from 'node:child_process';
export class ProcessError extends Error{constructor(message,code=null){super(message);this.code=code;this.name='ProcessError'}}
export function killTree(child){if(!child||child.killed)return;try{child.kill('SIGTERM')}catch{};setTimeout(()=>{try{if(!child.killed)child.kill('SIGKILL')}catch{}},1000).unref()}
export function run(command,args,{timeout=120000,onStdout,onStderr}={}){
 const child=spawn(command,args,{stdio:['ignore','pipe','pipe']});let stdout='',stderr='',done=false,timer;
 const promise=new Promise((resolve,reject)=>{
  const finish=(fn,v)=>{if(done)return;done=true;clearTimeout(timer);fn(v)};
  child.stdout.on('data',d=>{const s=d.toString();stdout+=s;onStdout?.(s)});
  child.stderr.on('data',d=>{const s=d.toString();stderr+=s;onStderr?.(s)});
  child.once('error',e=>finish(reject,new ProcessError(e.message)));
  child.once('close',(code,signal)=>code===0?finish(resolve,{stdout,stderr,code,signal}):finish(reject,new ProcessError(stderr.trim()||`Process exited with code ${code??'unknown'}`,code)));
  timer=setTimeout(()=>{killTree(child);finish(reject,new ProcessError('Process timeout'))},timeout);
 });
 return {child,promise};
}
