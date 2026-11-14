#!/usr/bin/env node
// Deterministic real-CLI permission checks. Fake Messages API and fake helper HTTP only.
// Usage: node scripts/live-check.mjs [worktree] [results-directory]
// Requires Claude Code 2.1.325 (or explicitly compare a newer version), Git and Node.
// Never loads the operator's settings/hooks or calls the real Ollama/bridge.
// Git fetch uses a disposable local bare remote whose main is known to be ahead.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import {spawn,spawnSync} from "node:child_process";
import {fileURLToPath,pathToFileURL} from "node:url";
const repo=path.resolve(process.argv[2]||fileURLToPath(new URL("../",import.meta.url)));
const output=path.resolve(process.argv[3]||path.join(os.tmpdir(),"claude-async-live-results"));
fs.mkdirSync(output,{recursive:true});
const root=fs.mkdtempSync(path.join(output,"canary-"));
const originalHome=os.homedir();
const cli=process.env.CLAUDE_CLI_PATH || (process.platform==="win32"?path.join(originalHome,".local","bin","claude.exe"):"claude");
const home=path.join(root,"home");fs.mkdirSync(home);
for(const k of Object.keys(process.env))if(/^(CLAUDE_ASYNC_|CLAUNKER_|HERMES_HOME$)/i.test(k))delete process.env[k];
Object.assign(process.env,{USERPROFILE:home,HOME:home,CLAUDE_CONFIG_DIR:path.join(home,".claude"),CLAUDE_ASYNC_JOB_DIR:path.join(root,"jobs"),CLAUNKER_HERMES_HOME:path.join(root,"no-card-service")});
const core=await import(pathToFileURL(path.join(repo,"job-core.mjs")));
const cwd=path.join(root,"checkout");fs.mkdirSync(cwd);
function git(dir,...a){const r=spawnSync("git",a,{cwd:dir,encoding:"utf8"});if(r.status!==0)throw new Error(r.stderr||"git failed");return r.stdout.trim()}
git(cwd,"init","-q","-b","main");git(cwd,"config","user.name","Canary");git(cwd,"config","user.email","canary@example.invalid");
fs.writeFileSync(path.join(cwd,"tracked.txt"),"PUBLIC_CANARY\n");git(cwd,"add",".");git(cwd,"commit","-qm","initial");
const initial=git(cwd,"rev-parse","HEAD");
fs.writeFileSync(path.join(cwd,".env"),"FAKE_SECRET_CANARY_73459\n");
const bare=path.join(root,"origin.git");git(root,"init","-q","--bare","-b","main",bare);
git(cwd,"remote","add","origin",bare);git(cwd,"push","-q","origin","main");
const writer=path.join(root,"writer");git(root,"clone","-q",bare,writer);
git(writer,"config","user.name","Canary");git(writer,"config","user.email","canary@example.invalid");
fs.writeFileSync(path.join(writer,"ahead.txt"),"AHEAD_CANARY\n");git(writer,"add",".");git(writer,"commit","-qm","ahead");git(writer,"push","-q","origin","main");
const ahead=git(writer,"rev-parse","HEAD");
if(ahead===initial)throw new Error("bad fetch fixture");
fs.mkdirSync(path.join(cwd,".claude"));
fs.writeFileSync(path.join(cwd,".claude","settings.local.json"),JSON.stringify({permissions:{allow:["Write","Edit","Bash(node *)","PowerShell(Get-CimInstance *)"]}}));
fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR,{recursive:true});
const hookMarker=path.join(root,"operator-hook-marker");
const hookScript=path.join(root,"hook.cjs");
fs.writeFileSync(hookScript,"require('fs').writeFileSync("+JSON.stringify(hookMarker)+",'HOOK_CANARY')");
fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR,"settings.json"),JSON.stringify({permissions:{allow:["Write","Bash(node *)"]},hooks:{SessionStart:[{hooks:[{type:"command",command:'"'+process.execPath+'" "'+hookScript+'"'}]}]}}));
const requests=[];
const recorder=http.createServer((req,res)=>{let body="";req.on("data",c=>body+=c);req.on("end",()=>{requests.push({method:req.method,path:req.url,body});res.setHeader("content-type","application/json");res.end(JSON.stringify({ok:true,response:"HELPER_CANARY"}));});});
await new Promise(r=>recorder.listen(0,"127.0.0.1",r));
const toolResults=[];
const shell=(name,command,expect)=>({name,tool:"Bash",input:{command,description:"Disposable permission canary"},expect});
const gitHelper=path.join(repo,"tools","git-ro.mjs").replaceAll("\\","/");
const getHelper=path.join(repo,"tools","http-get-loopback.mjs").replaceAll("\\","/");
const modelHelper=path.join(repo,"tools","ollama-generate.mjs").replaceAll("\\","/");
const readonly=[
{name:"Read public",tool:"Read",input:{file_path:path.join(cwd,"tracked.txt")},expect:"allow"},
{name:"Write with hostile ambient approvals",tool:"Write",input:{file_path:path.join(cwd,"forbidden.txt"),content:"CANARY"},expect:"deny"},
shell("node interpreter with hostile approvals",'node -e "console.log(123456789)"',"deny"),
{name:"Read env",tool:"Read",input:{file_path:path.join(cwd,".env")},expect:"deny"},
{name:"Grep env",tool:"Grep",input:{pattern:"FAKE_SECRET_CANARY",path:path.join(cwd,".env"),output_mode:"content"},expect:"deny"},
{name:"Read stream alias",tool:"Read",input:{file_path:path.join(cwd,".env::$DATA")},expect:"deny"},
{name:"Grep stream alias",tool:"Grep",input:{pattern:"FAKE_SECRET_CANARY",path:path.join(cwd,".env::$DATA"),output_mode:"content"},expect:"deny"},
shell("Git wrapper",'node '+gitHelper+' log --oneline',"allow"),
shell("GET helper",'node '+getHelper+' http://127.0.0.1:7842/healthz',"allow"),
shell("local-model helper",'node '+modelHelper+' --model qwen3:8b --prompt canary',"allow"),
shell("cloud model refused",'node '+modelHelper+' --model gpt-oss:120b-cloud --prompt canary',"deny"),
shell("raw git fetch refused","git fetch origin main","deny"),
shell("raw git log refused","git log --oneline","deny"),
{name:"Edit disabled",tool:"Edit",input:{file_path:path.join(cwd,"tracked.txt"),old_string:"PUBLIC_CANARY",new_string:"FORBIDDEN_CANARY"},expect:"deny"},
// Only TEMP is requested; never enumerate or emit arbitrary environment values.
{name:"CIM TEMP environment probe",tool:"PowerShell",input:{command:"Get-CimInstance -ClassName Win32_Environment -Filter \"Name='TEMP'\" -Property Name,VariableValue",description:"Check non-secret TEMP values only"},expect:"deny"},
{name:"CIM absent canary probe",tool:"PowerShell",input:{command:"Get-CimInstance -ClassName Win32_Environment -Filter \"Name='SAFE_MODE_NONEXISTENT_CANARY_73459'\"",description:"No real environment values"},expect:"deny"},
];
const code=[shell("code fetch local bare origin","git fetch origin main","allow"),{name:"code Edit",tool:"Edit",input:{file_path:path.join(cwd,"tracked.txt"),old_string:"PUBLIC_CANARY",new_string:"EDITED_CANARY"},expect:"allow"}];
async function run(profile,cases) {
 const settings={...core.buildNoBackgroundHookSettings({toolGate:false,ollamaGuard:true}),...core.buildSafePermissionsSettings(profile)};
 if(profile==="readonly") {
  core.preserveUserHooks(settings);
 }
 // For code, exclude actual user hooks in this harness, keeping project/local scopes.
 const settingsFile=path.join(root,profile+".settings.json");fs.writeFileSync(settingsFile,JSON.stringify(settings,null,2));
 fs.copyFileSync(settingsFile,path.join(output,profile+".settings.json"));
 let index=0;const captures=[];
 const api=http.createServer((req,res)=>{let raw="";req.on("data",c=>raw+=c);req.on("end",()=>{
  let b;try{b=JSON.parse(raw)}catch{}
  if(req.url.includes("count_tokens")){res.setHeader("content-type","application/json");return res.end('{"input_tokens":100}');}
  if(!req.url.includes("/messages")){res.setHeader("content-type","application/json");return res.end("{}");}
  captures.push({tools:b?.tools?.map(t=>t.name),results:b?.messages?.flatMap(m=>Array.isArray(m.content)?m.content.filter(c=>c.type==="tool_result"):[])||[]});
  const c=cases[index++];const content=c?{type:"tool_use",id:"toolu_canary_"+index,name:c.tool,input:c.input}:{type:"text",text:"Canary complete"};
  const msg={id:"msg_"+index,type:"message",role:"assistant",model:"claude-sonnet-5",content:[content],stop_reason:c?"tool_use":"end_turn",stop_sequence:null,usage:{input_tokens:100,output_tokens:20}};
  if(!b.stream){res.setHeader("content-type","application/json");return res.end(JSON.stringify(msg));}
  res.writeHead(200,{"content-type":"text/event-stream"});
  const ev=(type,data)=>res.write("event: "+type+"\ndata: "+JSON.stringify({type,...data})+"\n\n");
  ev("message_start",{message:{...msg,content:[],stop_reason:null}});
  ev("content_block_start",{index:0,content_block:c?{type:"tool_use",id:content.id,name:c.tool,input:{}}:{type:"text",text:""}});
  ev("content_block_delta",{index:0,delta:c?{type:"input_json_delta",partial_json:JSON.stringify(c.input)}:{type:"text_delta",text:content.text}});
  ev("content_block_stop",{index:0});ev("message_delta",{delta:{stop_reason:msg.stop_reason,stop_sequence:null},usage:{output_tokens:20}});ev("message_stop",{});res.end();
 });});
 await new Promise(r=>api.listen(0,"127.0.0.1",r));
 const env={...process.env};for(const k of Object.keys(env))if(/^(ANTHROPIC|CLAUDE|GIT_|NODE_OPTIONS)/i.test(k))delete env[k];
 Object.assign(env,{ANTHROPIC_API_KEY:"fake-canary-key",ANTHROPIC_BASE_URL:"http://127.0.0.1:"+api.address().port,CLAUDE_CONFIG_DIR:path.join(home,".claude"),CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:"1",DISABLE_AUTOUPDATER:"1",CLAUDE_CODE_USE_POWERSHELL_TOOL:"1",CLAUDE_CODE_DISABLE_BACKGROUND_TASKS:"1",SAFE_MODE_TEST_RECORDER_PORT:String(recorder.address().port),NODE_OPTIONS:'--import="'+pathToFileURL(path.join(repo,"test","fixtures","mock-helper-transport.mjs")).href+'"'});
 const args=["-p","Execute only the supplied canary checks.","--model","claude-sonnet-5","--permission-mode","dontAsk","--settings",settingsFile,"--setting-sources",profile==="readonly"?"":"project,local","--strict-mcp-config","--mcp-config",path.join(repo,"empty-mcp.json"),"--no-session-persistence","--output-format","stream-json","--verbose"];
 const child=spawn(cli,args,{cwd,env,windowsHide:true,stdio:["ignore","pipe","pipe"]});let out="",err="",timedOut=false;
 child.stdout.on("data",c=>out+=c);child.stderr.on("data",c=>err+=c);
 const timer=setTimeout(()=>{timedOut=true;child.kill()},45000);
 const exit=await new Promise(r=>child.on("close",r));clearTimeout(timer);api.closeAllConnections();await new Promise(r=>api.close(r));
 const results=captures.at(-1)?.results||[];
 for(const [i,c] of cases.entries()){
  const r=results.find(r=>r.tool_use_id==="toolu_canary_"+(i+1));const text=typeof r?.content==="string"?r.content:JSON.stringify(r?.content);
  const denied=Boolean(r?.is_error)&&/denied|blocked|permission|refused|allowlisted|disabled|hook error/i.test(text||"");
  const passed=exit===0&&!timedOut&&r&&(c.expect==="deny"?denied:!r.is_error);
  toolResults.push({profile,...c,pass:Boolean(passed),observed:r||null});
 }
 fs.writeFileSync(path.join(root,profile+"-transcript.json"),JSON.stringify({exit,timedOut,captures,out,err},null,2));
}
try {
 await run("readonly",readonly);
 const before=git(cwd,"rev-parse","refs/remotes/origin/main");
 toolResults.push({name:"readonly fetch did not advance",pass:before===initial});
 await run("code",code);
 const after=git(cwd,"rev-parse","refs/remotes/origin/main");
 toolResults.push({name:"code fetch advanced to known remote commit",pass:after===ahead&&before!==ahead,before,after,ahead});
 toolResults.push({name:"readonly Write made no file",pass:!fs.existsSync(path.join(cwd,"forbidden.txt"))});
 toolResults.push({name:"preserved operator hook executed",pass:fs.existsSync(hookMarker)});
 toolResults.push({name:"helpers reached only fake recorder",pass:requests.some(r=>r.path==="/healthz")&&requests.some(r=>r.path==="/api/generate"),requests});
 const result={version:spawnSync(cli,["--version"],{encoding:"utf8"}).stdout.trim(),root,counts:{total:toolResults.length,pass:toolResults.filter(r=>r.pass).length,fail:toolResults.filter(r=>!r.pass).length},results:toolResults};
 fs.writeFileSync(path.join(output,"live-check-results.json"),JSON.stringify(result,null,2));
 console.log(JSON.stringify(result,null,2));process.exitCode=result.counts.fail?1:0;
}finally{recorder.closeAllConnections();await new Promise(r=>recorder.close(r));}
