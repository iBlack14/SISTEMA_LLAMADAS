export function shortDeviceId(deviceId) {
  const bytes = new TextEncoder().encode(String(deviceId || ""));
  let hash = 0x811c9dc5;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  return String(hash % 100000).padStart(5, "0");
}
