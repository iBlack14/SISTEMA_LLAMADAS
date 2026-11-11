import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import mysql from "mysql2/promise";
import dotenv from "dotenv";
import { assertXamppConfig } from "./auth/config.js";
import { UserWorkspaces } from "./user-workspace.js";
import { AuthService } from "./auth/service.js";

test("MySQL account mapping and isolation (all test rows are rolled back)",{
  skip:process.env.WORKSPACE_MYSQL_TEST!=="1"
},async()=>{
  dotenv.config({path:new URL("../.env",import.meta.url),quiet:true});
  assertXamppConfig();
  const connection=await mysql.createConnection({
    host:"127.0.0.1",port:3306,user:process.env.DB_USER,
    password:process.env.DB_PASSWORD,database:process.env.DB_NAME
  });
  try{
    await connection.beginTransaction();
    const suffix=randomBytes(6).toString("hex");
    const users=[];
    for(let index=0;index<2;index++){
      const [insert]=await connection.query(
        "INSERT INTO auth_users(username,password_hash,role,active) VALUES (?,?,'EMPLEADO',0)",
        ["workspace_test_"+suffix+"_"+index,"disabled-transaction-only"]);
      users.push({id:insert.insertId});
    }
    const sessions=new Map();let count=0;
    const auth=new AuthService(connection,{origins:[]});
    const options={
      getPool:()=>connection,getSessions:()=>sessions,
      create:()=>{const code=randomBytes(3).toString("hex").toUpperCase();const session={contactBook:{contacts:[]}};sessions.set(code,session);count++;return{code,session};},
      save:async()=>{},grant:(user,code)=>auth.grant(user,code)
    };
    const original=await new UserWorkspaces(options).open(users[0]);
    original.session.contactBook.contacts.push({phone:"900000001"});
    const secondBrowser=await new UserWorkspaces(options).open(users[0]);
    assert.equal(secondBrowser.code,original.code);
    assert.equal(secondBrowser.session.contactBook.contacts.length,1);
    const other=await new UserWorkspaces(options).open(users[1],original.code);
    assert.notEqual(other.code,original.code);
    assert.equal(count,2);
    assert.equal(await auth.canAccess(users[0],original.code),true);
    assert.equal(await auth.canAccess(users[1],original.code),false);
  }finally{
    await connection.rollback();
    await connection.end();
  }
});
