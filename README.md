# QRIS Pay

Aplikasi QRIS Generator berbasis PWA (Progressive Web App) menggunakan:

- Bootstrap 5
- Alpine.js
- QRIS EMV Parser
- node-qrcode
- jsQR

Mendukung:
- Generate QRIS dinamis dari QRIS statis
- Input nominal manual
- Keranjang produk
- Share invoice ke WhatsApp
- Scan QRIS via kamera / upload gambar
- Riwayat transaksi
- Offline mode (PWA)
- Install ke Android & iPhone

---

## Preview

![QRIS Pay](./assets/icon-512.png)

---

## Fitur

### Transaksi
- Generate QRIS nominal otomatis
- Input manual nominal
- Keranjang produk
- Invoice sederhana
- Download QR

### QRIS
- Support QRIS statis EMV
- Inject nominal otomatis
- CRC16 recalculation
- Auto detect merchant name

### PWA
- Installable
- Offline cache
- Mobile app feel
- Splash icon
- Theme color

### Keamanan
- PIN proteksi pengaturan
- Local storage persistence

---

## Struktur Project

```text
.
├── index.html
├── manifest.json
├── service-worker.js
├── README.md
└── assets/
    ├── css/
    ├── fonts/
    ├── icon-192.png
    ├── icon-512.png
    └── lib/
