import { randomBytes, scrypt as derive, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(derive);
const parameters = { N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 };
let active = 0;
const waiting = [];

async function deriveKey(password, salt) {
  if (active >= 2) {
    if (waiting.length >= 8) throw new Error("PASSWORD_QUEUE_FULL");
    await new Promise(resolve => waiting.push(resolve));
  } else active++;
  try { return await scrypt(password, salt, 64, parameters); }
  finally {
    if (waiting.length) waiting.shift()();
    else active--;
  }
}

export async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const key = await deriveKey(password, salt);
  return `scrypt$131072$8$1$${salt}$${key.toString("hex")}`;
}

export async function verifyPassword(password, encoded) {
  const [algorithm, n, r, p, salt, hash] = String(encoded).split("$");
  if (algorithm !== "scrypt" || n !== "131072" || r !== "8" || p !== "1"
      || !/^[a-f0-9]{32}$/.test(salt) || !/^[a-f0-9]{128}$/.test(hash)) return false;
  const key = await deriveKey(password, salt);
  return timingSafeEqual(key, Buffer.from(hash, "hex"));
}
