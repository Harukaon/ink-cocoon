// ============================================================
// 墨茧 InkCocoon · src/util.js
// ============================================================

/** 纯 JS base64（Worker 里 btoa 存在，但为兼容非 ASCII 用此实现） */
export function encodeBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** 安全 JSON 字符串化（截断保护） */
export function trunc(obj, n = 500) {
  try {
    return JSON.stringify(obj).slice(0, n);
  } catch {
    return String(obj).slice(0, n);
  }
}

/** 简单休眠（退避用） */
export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}