const CACHE_NAME = "qrispay-v1";

const urlsToCache = [
  "./",
  "./index.html",

  "./manifest.json",

  "./assets/css/app.css",

  "./assets/icon-192.png",
  "./assets/icon-512.png",

  "./assets/lib/bootstrap/css/bootstrap.min.css",
  "./assets/lib/bootstrap-icons/bootstrap-icons.min.css",

  "./assets/lib/node-qrcode/qrcode.min.js",
  "./assets/lib/jsqr/jsQR.min.js",
  "./assets/lib/alpinejs/alpinejs.min.js",

  "./assets/fonts/dm-mono-v16-latin-300.woff2",
  "./assets/fonts/dm-mono-v16-latin-500.woff2",
  "./assets/fonts/dm-mono-v16-latin-regular.woff2",
  "./assets/fonts/plus-jakarta-sans-v12-latin-500.woff2",
  "./assets/fonts/plus-jakarta-sans-v12-latin-600.woff2",
  "./assets/fonts/plus-jakarta-sans-v12-latin-700.woff2",
  "./assets/fonts/plus-jakarta-sans-v12-latin-800.woff2",
  "./assets/fonts/plus-jakarta-sans-v12-latin-regular.woff2",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(urlsToCache))
  );
});

self.addEventListener("fetch", (event) => {
  event.respondWith(
    caches
      .match(event.request)
      .then((response) => response || fetch(event.request))
  );
});
