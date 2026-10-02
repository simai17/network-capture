/* Network capture: encryption, local queue and upload.
   Used by the page, by the service worker (background sync) and by tests (Node). */
"use strict";
(function (root) {
  const INFO = new TextEncoder().encode("netmap-inbox-v1");
  const ALG = "ECDH-P256+HKDF-SHA256+A256GCM";
  const DB_NAME = "netmap-capture";

  function b64(bytes) {
    let out = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(out);
  }
  const unb64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  const utf8 = (text) => new TextEncoder().encode(text);

  /** Encrypt an entry for the laptop. Only the laptop's private key can open it. */
  async function encryptEntry(publicKeyB64, kid, payload) {
    const subtle = root.crypto.subtle;
    const recipient = await subtle.importKey("raw", unb64(publicKeyB64), { name: "ECDH", namedCurve: "P-256" }, false, []);
    const eph = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const shared = await subtle.deriveBits({ name: "ECDH", public: recipient }, eph.privateKey, 256);
    const epk = new Uint8Array(await subtle.exportKey("raw", eph.publicKey));
    const hkdf = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
    const key = await subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: epk, info: INFO }, hkdf, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
    const iv = root.crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv, additionalData: INFO }, key, utf8(JSON.stringify(payload))));
    return { v: 1, alg: ALG, kid, epk: b64(epk), iv: b64(iv), ct: b64(ct) };
  }

  // ------------------------------------------------------------ IndexedDB
  function openDb() {
    return new Promise((resolve, reject) => {
      const req = root.indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore("queue", { keyPath: "id" });
        req.result.createObjectStore("kv");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function run(storeName, mode, fn) {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const result = fn(tx.objectStore(storeName));
        tx.oncomplete = () => resolve(result && "result" in result ? result.result : undefined);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }

  const kvGet = (key) => run("kv", "readonly", (s) => s.get(key));
  const kvSet = (key, value) => run("kv", "readwrite", (s) => s.put(value, key));
  const kvDelete = (key) => run("kv", "readwrite", (s) => s.delete(key));
  const queueAll = async () => ((await run("queue", "readonly", (s) => s.getAll())) || []).sort((a, b) => a.created.localeCompare(b.created));
  const queuePut = (item) => run("queue", "readwrite", (s) => s.put(item));
  const queueDelete = (id) => run("queue", "readwrite", (s) => s.delete(id));

  // --------------------------------------------------------------- upload
  let sending = null;

  /** Upload everything in the queue. Safe to call from page and service worker at once:
   *  each entry has a fixed file name, and an existing file counts as delivered. */
  function sendQueue() {
    if (!sending) sending = doSend().finally(() => { sending = null; });
    return sending;
  }

  async function doSend() {
    const settings = (await kvGet("settings")) || {};
    const items = await queueAll();
    const result = { sent: 0, failed: 0, waiting: items.length, error: "" };
    if (!items.length) return result;
    if (!settings.repo || !settings.token) return { ...result, error: "setup" };
    for (const item of items) {
      const url = `https://api.github.com/repos/${settings.repo}/contents/inbox/${item.file}`;
      let response;
      try {
        response = await fetch(url, {
          method: "PUT",
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${settings.token}`,
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            message: `Add ${item.kind} entry`,
            content: b64(utf8(JSON.stringify(item.envelope))),
            branch: settings.branch || "main",
          }),
        });
      } catch {
        return { ...result, waiting: result.waiting, error: "offline" };
      }
      if (response.status === 200 || response.status === 201) {
        await queueDelete(item.id);
        result.sent++;
        result.waiting--;
        continue;
      }
      let message = "";
      try { message = (await response.json()).message || ""; } catch { /* no body */ }
      if (response.status === 422 && /sha/i.test(message)) {
        await queueDelete(item.id); // already uploaded earlier
        result.sent++;
        result.waiting--;
        continue;
      }
      if ([401, 403, 404].includes(response.status)) {
        return { ...result, error: "auth", status: response.status, message };
      }
      item.error = `${response.status} ${message}`.trim();
      await queuePut(item);
      result.failed++;
    }
    return result;
  }

  const api = { encryptEntry, b64, unb64, kvGet, kvSet, kvDelete, queueAll, queuePut, queueDelete, sendQueue };
  root.NetmapCapture = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
