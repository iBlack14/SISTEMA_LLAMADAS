import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { runtimeIdentity,runtimeLockName,probeRuntime } from "./runtime-instance.js";

test("instance identity distinguishes projects and database configurations",()=>{
  const env={DB_NAME:"calls",DB_PORT:"3306",PORT:"3000"};
  assert.equal(runtimeIdentity(env,"."),runtimeIdentity({...env},"."));
  assert.notEqual(runtimeIdentity(env,"."),runtimeIdentity(env,"../other-project"));
  assert.notEqual(runtimeIdentity(env,"."),runtimeIdentity({...env,DB_NAME:"other"},"."));
  assert.notEqual(runtimeLockName(env),runtimeLockName({...env,DB_NAME:"other"}));
  assert.ok(runtimeLockName(env).length<=64);
});
test("startup reuses only its own verified server and detects absent or foreign services",async()=>{
  let body={ok:true,application:"voip-vc",instance:"test-instance"};
  const server=http.createServer((req,res)=>{res.setHeader("Content-Type","application/json");res.end(JSON.stringify(body));});
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  const port=server.address().port;
  try{
    assert.equal(await probeRuntime(port,"test-instance"),"same");
    assert.equal(await probeRuntime(port,"different-instance"),"other");
    body={ok:true};
    assert.equal(await probeRuntime(port,"test-instance"),"other");
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  assert.equal(await probeRuntime(port,"test-instance"),"absent");
});
