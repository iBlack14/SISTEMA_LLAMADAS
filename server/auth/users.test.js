import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import express from "express";
import http from "node:http";
import { AuthService } from "./service.js";
import { validateNewUser } from "./users.js";

const digest = value => createHash("sha256").update(value).digest("hex");
const secret = "Synthetic-test-password-123";
const valid = { username:"ventas.uno", password:secret, passwordConfirmation:secret };
test("new user validation rejects malformed roles, names and passwords",()=>{
  for(const change of [
    {role:"SUPERADMIN"},{role:1},{username:"bad username"},
    {username:"ab"},{password:"short"},{password:"x".repeat(257)},
    {passwordConfirmation:"different"}
  ]) assert.throws(()=>validateNewUser({...valid,...change}));
  assert.throws(()=>validateNewUser(null));
  assert.equal(validateNewUser({...valid,username:" VENTAS.UNO "}).username,"ventas.uno");
  assert.equal(validateNewUser(valid).role,"EMPLEADO");
  assert.equal(validateNewUser({...valid,role:"ADMINISTRADOR"}).role,"ADMINISTRADOR");
});

test("user management enforces login, admin role, CSRF and hashes new credentials",async t=>{
  const csrf="a".repeat(64), adminToken="1".repeat(64), salesToken="2".repeat(64);
  const users=[
    {id:1,username:"admin",role:"ADMINISTRADOR",active:1,auth_version:1,password_hash:"never-return-this"},
    {id:2,username:"existing.sales",role:"EMPLEADO",active:1,auth_version:1,password_hash:"never-return-this"}
  ];
  const sessions=new Map([[digest(adminToken),1],[digest(salesToken),2]]);
  let inserts=0, failList=false;
  const pool={async query(sql,args=[]){
    if(sql.includes("FROM auth_sessions s JOIN auth_users")){
      const row=users.find(item=>item.id===sessions.get(args[0]));
      return [row?[{...row,csrf_token:csrf}]:[]];
    }
    if(sql.startsWith("UPDATE auth_sessions"))return [{}];
    if(sql.startsWith("SELECT id,username,role,active,created_at")){
      if(failList)throw new Error("storage unavailable");
      return [users];
    }
    if(sql.startsWith("INSERT INTO auth_users")){
      if(users.some(item=>item.username===args[0]))throw Object.assign(new Error("duplicate"),{code:"ER_DUP_ENTRY"});
      inserts++;
      users.push({id:users.length+1,username:args[0],password_hash:args[1],role:args[2],active:1,auth_version:1});
      return [{insertId:users.length}];
    }
    if(sql.startsWith("SELECT * FROM auth_users WHERE username"))return [users.filter(item=>item.username===args[0])];
    if(sql.includes("INSERT INTO auth_sessions")){
      sessions.set(args[0],args[1]);return [{}];
    }
    throw new Error("Unexpected database query");
  }};
  const auth=new AuthService(pool,{origins:[]});
  const app=express();app.use(express.json());app.use(auth.middleware());auth.routes(app,()=>{});
  app.get("/admin/nucleo-red",auth.requireAdmin,(req,res)=>res.json({ok:true}));
  const server=http.createServer(app);
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  const base="http://127.0.0.1:"+server.address().port;
  auth.origins.add(base);
  const request=(path,token,body,headers={})=>fetch(base+path,{
    method:body===undefined?"GET":"POST",
    headers:{...(token?{Cookie:"calls_local_sid="+token}:{}),
      ...(body===undefined?{}:{"Content-Type":"application/json",Origin:base,"X-CSRF-Token":csrf}),...headers},
    ...(body===undefined?{}:{body:JSON.stringify(body)})
  });
  try{
    await t.test("anonymous and sales users cannot list or create accounts",async()=>{
      for(const [token,status] of [[null,401],[salesToken,403]]){
        assert.equal((await request("/api/admin/users",token)).status,status);
        assert.equal((await request("/api/admin/users",token,{...valid,role:"ADMINISTRADOR"})).status,status);
        assert.equal((await request("/admin/nucleo-red",token)).status,status);
      }
      assert.equal(inserts,0);
    });
    await t.test("administrator listing never exposes password hashes",async()=>{
      const response=await request("/api/admin/users",adminToken);
      assert.equal(response.status,200);
      const data=await response.json();
      assert.equal(data.users.length,2);
      assert.ok(!JSON.stringify(data).includes("never-return-this"));
      assert.ok(!Object.hasOwn(data.users[0],"password_hash"));
    });
    await t.test("missing CSRF or foreign origins cannot create accounts",async()=>{
      assert.equal((await request("/api/admin/users",adminToken,valid,{"X-CSRF-Token":""})).status,403);
      assert.equal((await request("/api/admin/users",adminToken,valid,{Origin:"http://foreign.invalid"})).status,403);
      assert.equal(inserts,0);
    });
    await t.test("invalid input creates no account",async()=>{
      assert.equal((await request("/api/admin/users",adminToken,{...valid,role:"SUPERADMIN"})).status,400);
      assert.equal(inserts,0);
    });
    await t.test("administrator creates a sales account with a one-way hash",async()=>{
      const response=await request("/api/admin/users",adminToken,valid);
      assert.equal(response.status,201);
      const data=await response.json();
      assert.equal(data.user.role,"EMPLEADO");
      assert.equal(data.user.username,valid.username);
      assert.ok(!JSON.stringify(data).includes(secret));
      assert.ok(!Object.hasOwn(data.user,"password_hash"));
      assert.match(users.at(-1).password_hash,/^scrypt\$/);
      assert.notEqual(users.at(-1).password_hash,secret);
      assert.equal(inserts,1);
    });
    await t.test("new sales login redirects to calls and cannot open the core or user APIs",async()=>{
      const response=await request("/api/auth/login",null,{username:valid.username,password:secret});
      assert.equal(response.status,200);
      assert.equal((await response.json()).redirect,"/");
      const token=response.headers.get("set-cookie").match(/calls_local_sid=([a-f0-9]{64})/)[1];
      assert.equal((await request("/admin/nucleo-red",token)).status,403);
      assert.equal((await request("/api/admin/users",token)).status,403);
      assert.equal((await request("/api/admin/users",token,{...valid,role:"ADMINISTRADOR"})).status,403);
    });
    await t.test("duplicate usernames preserve the existing account",async()=>{
      const response=await request("/api/admin/users",adminToken,valid);
      assert.equal(response.status,409);
      assert.equal(inserts,1);
    });
    await t.test("database failure returns a retryable error",async()=>{
      failList=true;
      assert.equal((await request("/api/admin/users",adminToken)).status,503);
    });
  }finally{
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
  }
});
