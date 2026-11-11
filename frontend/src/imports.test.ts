import test from "node:test";
import assert from "node:assert/strict";
import { fromRows,normalizePhone } from "./imports.ts";
test("imports Spanish headers, Peru prefixes and removes duplicate numbers within the same batch",()=>{
 const rows=[["Nombre","Teléfono","Nota"],["Uno","+51 900 000 001","Llamar"],["Duplicado","900000001",""],["Otro","900000002","Visitar"],["Inválido","123",""]];
 const contacts=fromRows(rows,"Comercios");
 assert.equal(contacts.length,2);assert.equal(contacts[0].phone,"900000001");
 assert.equal(contacts[0].note,"Llamar");assert.equal(contacts[1].list,"Comercios");
});
test("recognizes English headers in a different column order",()=>{
 const rows=[["Phone","Note","Name"],["936613758","Seguimiento","Empresa"]];
 const [contact]=fromRows(rows,"Servicios");
 assert.equal(contact.name,"Empresa");assert.equal(contact.note,"Seguimiento");assert.equal(contact.phone,"936613758");
 assert.equal(normalizePhone("+51 (936) 613-758"),"936613758");
});
