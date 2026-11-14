import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runCli, gitEnv } from "../tools/git-ro.mjs";

test("committed inspection does not execute clean filters, index hooks, or lazy-fetch SSH", async () => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"git-ro-markers-"));
 const repo=path.join(root,"repo");fs.mkdirSync(repo);
 const git=(...a)=>{const r=spawnSync("git",a,{cwd:repo,encoding:"utf8"});assert.equal(r.status,0,r.stderr);return r.stdout.trim()};
 try {
  git("init","-q","-b","main");git("config","user.name","Canary");git("config","user.email","canary@example.invalid");
  fs.writeFileSync(path.join(repo,"tracked.txt"),"initial\n");git("add",".");git("commit","-qm","initial");
  git("branch","diff");
  const namedDiff=await runCli(["diff","diff","diff","--","tracked.txt"],repo);
  assert.equal(namedDiff.exitCode,0,namedDiff.stderr);assert.equal(namedDiff.stdout,"");
  const oid=git("rev-parse","HEAD:tracked.txt");
  const marker=path.join(root,"marker");
  const filter=path.join(root,"filter.cjs");
  fs.writeFileSync(filter,"require('fs').writeFileSync("+JSON.stringify(marker)+",'ran');process.stdin.pipe(process.stdout)");
  git("config","filter.canary.clean",'node "'+filter.replaceAll("\\","/")+'"');
  fs.writeFileSync(path.join(repo,".gitattributes"),"tracked.txt filter=canary\n");
  fs.writeFileSync(path.join(repo,"tracked.txt"),"UNCOMMITTED_CANARY\n");
  const hooks=path.join(root,"hooks");fs.mkdirSync(hooks);
  fs.writeFileSync(path.join(hooks,"post-index-change"),'#!/bin/sh\necho ran > "'+marker.replaceAll("\\","/")+'"\n',{mode:0o755});
  git("config","core.hooksPath",hooks.replaceAll("\\","/"));
  const calls=[["log","-p"],["show","HEAD"],["diff","HEAD","HEAD"],["rev-parse","--verify","HEAD"],["branch","list"],["remote","-v"],["worktree","list"],["ls-files","--cached"]];
  for(const a of calls){const r=await runCli(a,repo);assert.equal(r.exitCode,0,r.stderr);assert.ok(!r.stdout.includes("UNCOMMITTED_CANARY"));assert.ok(!fs.existsSync(marker),a.join(" "));}
  for(const a of [["status"],["describe","--dirty"],["diff"],["diff","--cached"],["ls-files","--others"],["ls-files","--ignored"],["ls-files","--stage"],["show",":tracked.txt"]])assert.notEqual((await runCli(a,repo)).exitCode,0,a.join(" "));
  const ssh=path.join(root,"ssh.cjs");fs.writeFileSync(ssh,"require('fs').writeFileSync("+JSON.stringify(marker)+",'ran');process.exit(1)");
  git("config","remote.origin.url","ssh://127.0.0.1/canary");
  git("config","remote.origin.promisor","true");git("config","core.repositoryformatversion","1");git("config","extensions.partialClone","origin");
  git("config","core.sshCommand",'node "'+ssh.replaceAll("\\","/")+'"');
  fs.unlinkSync(path.join(repo,".git","objects",oid.slice(0,2),oid.slice(2)));
  const r=await runCli(["show",oid],repo);assert.notEqual(r.exitCode,0);assert.ok(!fs.existsSync(marker),"lazy fetch must not execute fake SSH");
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test("environment excludes inherited Git controls and unrelated secrets case-insensitively",()=>{
 const e=gitEnv({Path:"canary",SystemRoot:"C:/Windows",GIT_DIR:"evil",git_config_count:"1",Git_Config_Global:"evil",TOKEN:"SECRET",NODE_OPTIONS:"evil"});
 assert.equal(e.Path,"canary");for(const key of ["GIT_DIR","git_config_count","Git_Config_Global","TOKEN","NODE_OPTIONS"])assert.equal(e[key],undefined);
 assert.equal(e.GIT_NO_LAZY_FETCH,"1");assert.equal(e.GIT_OPTIONAL_LOCKS,"0");
});

test("non-worktrees, missing executables, and oversized output are failures",async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"git-ro-errors-"));
 const git=(...a)=>{const r=spawnSync("git",a,{cwd:root,encoding:"utf8"});assert.equal(r.status,0,r.stderr)};
 try {
  const outside=await runCli(["diff","HEAD","HEAD"],root);assert.notEqual(outside.exitCode,0);
  git("init","-q","-b","main");git("config","user.name","Canary");git("config","user.email","canary@example.invalid");
  fs.writeFileSync(path.join(root,"big.txt"),"X".repeat(3*1024*1024));git("add",".");git("commit","-qm","big");
  const big=await runCli(["show","HEAD:big.txt"],root);assert.notEqual(big.exitCode,0);assert.match(big.stderr,/output truncated/);
  const old={...process.env};try{for(const k of Object.keys(process.env))if(k.toLowerCase()==="path")delete process.env[k];process.env.PATH=root;
   const failed=await runCli(["log"],root);assert.notEqual(failed.exitCode,0);assert.match(failed.stderr,/failed/);
  }finally{for(const k of Object.keys(process.env))if(k.toLowerCase()==="path")delete process.env[k];for(const [k,v]of Object.entries(old))if(k.toLowerCase()==="path")process.env[k]=v;}
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
