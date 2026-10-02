/* Network capture service worker: works offline and sends the queue in the background. */
"use strict";
importScripts("shared.js");

const CACHE = "netmap-capture-v1";
const SHELL = ["./", "index.html", "app.js", "shared.js", "style.css", "manifest.webmanifest", "icon.svg", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "config.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Same-origin files: answer from the cache at once, refresh it in the background.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(event.request, { ignoreSearch: true });
      const fresh = fetch(event.request)
        .then((response) => {
          if (response.ok) cache.put(event.request, response.clone());
          return response;
        })
        .catch(() => cached);
      return cached || fresh;
    }),
  );
});

// Background sync (Chrome on Android): send waiting entries once the phone is online again.
self.addEventListener("sync", (event) => {
  if (event.tag !== "send-queue") return;
  event.waitUntil(
    self.NetmapCapture.sendQueue().then(async (result) => {
      for (const client of await self.clients.matchAll()) client.postMessage("queue-changed");
      if (result.error === "offline") throw new Error("still offline"); // let the browser retry
    }),
  );
});
