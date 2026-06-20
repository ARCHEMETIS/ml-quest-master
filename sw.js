// Service worker — ทำให้ติดตั้งเป็นแอป (PWA) ได้ + เปิดแอปเชลล์ได้แม้ออฟไลน์
const CACHE = "mlq-v2";
const SHELL = ["/", "/index.html", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // API/ฟังก์ชัน: ให้วิ่งเน็ตปกติเสมอ (ห้าม cache เควส/แชต)
  if (url.pathname.includes("/netlify/functions/") || url.pathname.includes("/.netlify/")) return;
  if (e.request.method !== "GET") return;

  // static: cache-first + อัปเดตเบื้องหลัง (stale-while-revalidate)
  e.respondWith(
    caches.open(CACHE).then(async (c) => {
      const cached = await c.match(e.request);
      const network = fetch(e.request)
        .then((res) => { if (res && res.ok) c.put(e.request, res.clone()); return res; })
        .catch(() => cached);
      return cached || network;
    })
  );
});
