import {test} from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {spawn} from "node:child_process";
import {getLoopback} from "../tools/http-get-loopback.mjs";
import {generate} from "../tools/ollama-generate.mjs";

for(const kind of ["get","ollama"])test(kind+": trickle deadline closes the socket and lets a child exit",async()=>{
 let closed=false, received=false;
 const server=http.createServer((req,res)=>{received=true;req.resume();res.writeHead(200);res.write("x");const tick=setInterval(()=>res.write("x"),20);res.on("close",()=>{closed=true;clearInterval(tick)});});
 await new Promise(r=>server.listen(0,"127.0.0.1",r));
 const port=server.address().port;
 const mod=new URL("../tools/"+(kind==="get"?"http-get-loopback.mjs":"ollama-generate.mjs"),import.meta.url).href;
 const call=kind==="get"?'getLoopback("http://127.0.0.1:'+port+'/healthz",{timeoutMs:150,allowedTargets:[{port:'+port+',path:"/healthz"}]})':'generate(["--model","qwen3:8b","--prompt","canary"],{deadlineMs:150,port:'+port+'})';
 const exported=kind==="get"?"getLoopback":"generate";
 const script='import {'+exported+'} from '+JSON.stringify(mod)+';const r=await '+call+';console.log(JSON.stringify(r));process.exitCode=r.exitCode;';
 const child=spawn(process.execPath,["--input-type=module","-e",script],{stdio:["ignore","pipe","pipe"]});
 let out="";child.stdout.on("data",c=>out+=c);
 let killed=false;const timer=setTimeout(()=>{killed=true;child.kill()},3000);
 try{
  const code=await new Promise(r=>child.on("close",r));clearTimeout(timer);
  assert.equal(killed,false,"child must exit on its own");assert.ok(received);assert.notEqual(code,0);
  const result=JSON.parse(out);assert.equal(result.ok,false);assert.match(result.error,/deadline/);
  await new Promise(r=>setTimeout(r,50));assert.ok(closed,"server must observe socket closure");
 }finally{clearTimeout(timer);child.kill();server.closeAllConnections();await new Promise(r=>server.close(r));}
});
