import test from "node:test";
import assert from "node:assert/strict";
import { UserWorkspaces } from "./user-workspace.js";
import { AuthService } from "./auth/service.js";

function fixture() {
  const sessions = new Map();
  const mappings = new Map();
  const grants = new Map();
  let created = 0;
  let failSave = false;
  const pool = { async query(sql, args) {
    if (sql.startsWith("SELECT session_code FROM auth_user_workspaces")) {
      return [[...(mappings.has(args[0]) ? [{session_code:mappings.get(args[0])}] : [])]];
    }
    if (sql.includes("SELECT a.session_code")) return [[...(grants.get(args[0]) || [])]
      .filter(code => ![...mappings.values()].includes(code)).map(session_code => ({session_code}))];
    if (sql.startsWith("INSERT INTO auth_user_workspaces")) {
      assert.ok(!mappings.has(args[0]));
      assert.ok(![...mappings.values()].includes(args[1]));
      mappings.set(args[0], args[1]);
      return [{}];
    }
    throw new Error("Unexpected query");
  }};
  const options = {
    getPool:()=>pool, getSessions:()=>sessions,
    create:()=>{const code=String(++created).padStart(6,"0");const session={updatedAt:Date.now()};sessions.set(code,session);return{code,session};},
    save:async()=>{if(failSave)throw new Error("storage offline");},
    grant:async(user,code)=>{grants.set(user.id,new Set([...(grants.get(user.id)||[]),code]));}
  };
  return {sessions,mappings,grants,options,manager:new UserWorkspaces(options),
    created:()=>created, fail:()=>{failSave=true;}};
}
test("same account survives new manager and simultaneous browsers without creating more workspaces",async()=>{
  const f=fixture();
  const first=await Promise.all(Array.from({length:8},()=>f.manager.open({id:1})));
  assert.equal(new Set(first.map(item=>item.code)).size,1);
  first[0].session.contactBook={contacts:[{phone:"900000001"}]};
  const reopened=await new UserWorkspaces(f.options).open({id:1},"BOGUS1");
  assert.equal(reopened.code,first[0].code);
  assert.equal(reopened.session.contactBook.contacts.length,1);
  assert.equal(f.created(),1);
});
test("different users cannot select another user's workspace by sending its code",async()=>{
  const f=fixture();
  const a=await f.manager.open({id:1});
  const b=await f.manager.open({id:2},a.code);
  assert.notEqual(a.code,b.code);
  assert.equal(b.session.ownerUserId,2);
});
test("migration preserves existing authorized data and ignores unauthorized browser hints",async()=>{
  const f=fixture();
  const old={contactBook:{contacts:[{phone:"900000002"}]},updatedAt:123};
  f.sessions.set("OLD001",old);
  f.sessions.set("OTHER1",{contactBook:{contacts:[{phone:"secret"}]}});
  f.grants.set(1,new Set(["OLD001"]));
  const selected=await f.manager.open({id:1},"OTHER1");
  assert.equal(selected.code,"OLD001");
  assert.equal(selected.session,old);
  assert.equal(f.created(),0);
});
test("storage failure never publishes an account mapping",async()=>{
  const f=fixture();f.fail();
  await assert.rejects(f.manager.open({id:1}),/storage offline/);
  assert.equal(f.mappings.size,0);
});
test("missing persisted account data fails without silently creating a replacement",async()=>{
  const f=fixture();f.mappings.set(1,"LOST01");
  await assert.rejects(f.manager.open({id:1}),/recuperar/);
  assert.equal(f.created(),0);
});
test("operational access requires a grant even outside production",async()=>{
  const auth=new AuthService({query:async()=>[[]]},{origins:[]});
  assert.equal(await auth.canAccess({id:1},"OTHER1"),false);
  assert.equal(await auth.canAccess(null,"OTHER1"),false);
});
