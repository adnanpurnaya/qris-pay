/* ════════════════════════════════════════
       QRIS Modifier — EMV QR Code (TLV)
       ════════════════════════════════════════ */
function crc16(str) {
  let crc = 0xffff;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc;
}

function removeTLV(str, tag) {
  let result = "";
  let i = 0;
  while (i < str.length) {
    if (i + 4 > str.length) {
      result += str.slice(i);
      break;
    }
    const id = str.slice(i, i + 2);
    const len = parseInt(str.slice(i + 2, i + 4), 10);
    if (isNaN(len)) {
      result += str.slice(i);
      break;
    }
    const val = str.slice(i + 4, i + 4 + len);
    if (id !== tag) result += id + String(len).padStart(2, "0") + val;
    i += 4 + len;
  }
  return result;
}

function injectAmount(staticQR, amount) {
  if (!staticQR || staticQR.length < 20)
    throw new Error("String QRIS terlalu pendek / tidak valid");
  if (!staticQR.startsWith("000201"))
    throw new Error("Bukan format QRIS yang valid (harus diawali 000201)");
  const crcSuffix = staticQR.slice(-8);
  if (!/^6304[0-9A-Fa-f]{4}$/.test(crcSuffix))
    throw new Error("CRC tidak ditemukan di akhir string QRIS");
  let body = staticQR.slice(0, -8);
  body = removeTLV(body, "54");
  const amtStr = Math.round(amount).toString();
  const amtField = "54" + String(amtStr.length).padStart(2, "0") + amtStr;
  const idx58 = body.indexOf("5802");
  if (idx58 !== -1) {
    body = body.slice(0, idx58) + amtField + body.slice(idx58);
  } else {
    const idx59 = body.indexOf("5913");
    if (idx59 !== -1) {
      body = body.slice(0, idx59) + amtField + body.slice(idx59);
    } else {
      body += amtField;
    }
  }
  const forCRC = body + "6304";
  const crcHex = crc16(forCRC).toString(16).toUpperCase().padStart(4, "0");
  return forCRC + crcHex;
}

function extractMerchantName(qris) {
  try {
    let i = 0;
    while (i < qris.length) {
      if (i + 4 > qris.length) break;
      const tag = qris.substring(i, i + 2);
      const len = parseInt(qris.substring(i + 2, i + 4), 10);
      if (isNaN(len) || len < 0) break;
      const val = qris.substring(i + 4, i + 4 + len);
      if (tag === "59") return val.trim();
      i += 4 + len;
    }
  } catch (e) {}
  return "";
}

/* ════════════════════════════════════════
       Alpine App
       ════════════════════════════════════════ */
function App() {
  return {
    tab: "transaksi",
    subScreen: null,
    merchant: "Toko Saya",
    qrisStatic: "",

    manualRaw: "",
    quickAmts: [5000, 10000, 20000, 25000, 50000, 100000],
    numKeys: [
      { v: "1", t: "d" },
      { v: "2", t: "d" },
      { v: "3", t: "d" },
      { v: "4", t: "d" },
      { v: "5", t: "d" },
      { v: "6", t: "d" },
      { v: "7", t: "d" },
      { v: "8", t: "d" },
      { v: "9", t: "d" },
      { v: "000", t: "000" },
      { v: "0", t: "d" },
      { v: "⌫", t: "del" },
    ],

    products: [
      { id: 1, name: "Nasi Goreng", price: 25000, emoji: "🍳" },
      { id: 2, name: "Es Teh Manis", price: 5000, emoji: "🧊" },
      { id: 3, name: "Ayam Bakar", price: 35000, emoji: "🍗" },
      { id: 4, name: "Mie Goreng", price: 20000, emoji: "🍜" },
      { id: 5, name: "Jus Alpukat", price: 15000, emoji: "🥑" },
      { id: 6, name: "Tempe Goreng", price: 8000, emoji: "🟫" },
      { id: 7, name: "Sate Ayam", price: 30000, emoji: "🍢" },
      { id: 8, name: "Air Mineral", price: 3000, emoji: "💧" },
    ],
    cart: {},

    qrImg: null,
    finalAmt: 0,
    invNo: "",
    invTime: "",
    invItems: [],

    history: [],
    histFilter: "all",

    cfgName: "",
    cfgQris: "",
    cfgProductsJson: "",
    cfgNewPin: "",

    savedPin: "",
    pinLocked: false,
    pinInput: "",
    pinError: "",

    scanner: { open: false, stream: null, intervalId: null },

    toast: { show: false, msg: "" },

    get cartTotal() {
      return Object.entries(this.cart).reduce((s, [id, q]) => {
        const p = this.products.find((x) => x.id == id);
        return s + (p ? p.price * q : 0);
      }, 0);
    },
    get cartCount() {
      return Object.values(this.cart).reduce((s, q) => s + q, 0);
    },
    get cartLines() {
      return Object.entries(this.cart)
        .filter(([, q]) => q > 0)
        .map(([id, qty]) => {
          const p = this.products.find((x) => x.id == id);
          return { ...p, qty, sub: p.price * qty };
        });
    },
    get todayTotal() {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      return this.history
        .filter((h) => h.ts >= today.getTime())
        .reduce((s, h) => s + h.amount, 0);
    },
    get todayCount() {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      return this.history.filter((h) => h.ts >= today.getTime()).length;
    },
    get filteredHistory() {
      const now = new Date();
      let start = 0;
      if (this.histFilter === "today") {
        const d = new Date(now);
        d.setHours(0, 0, 0, 0);
        start = d.getTime();
      } else if (this.histFilter === "week") {
        const d = new Date(now);
        d.setDate(d.getDate() - d.getDay());
        d.setHours(0, 0, 0, 0);
        start = d.getTime();
      } else if (this.histFilter === "month") {
        const d = new Date(now.getFullYear(), now.getMonth(), 1);
        start = d.getTime();
      }
      if (start === 0) return [...this.history];
      return this.history.filter((h) => h.ts >= start);
    },
    get histSummary() {
      const now = new Date();
      const todayStart = new Date(now);
      todayStart.setHours(0, 0, 0, 0);
      const weekStart = new Date(now);
      weekStart.setDate(weekStart.getDate() - weekStart.getDay());
      weekStart.setHours(0, 0, 0, 0);
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

      const todayH = this.history.filter((h) => h.ts >= todayStart.getTime());
      const weekH = this.history.filter((h) => h.ts >= weekStart.getTime());
      const monthH = this.history.filter((h) => h.ts >= monthStart.getTime());

      return {
        todayAmt: todayH.reduce((s, h) => s + h.amount, 0),
        todayCnt: todayH.length,
        weekAmt: weekH.reduce((s, h) => s + h.amount, 0),
        weekCnt: weekH.length,
        monthAmt: monthH.reduce((s, h) => s + h.amount, 0),
        monthCnt: monthH.length,
      };
    },

    rupiah(n) {
      return new Intl.NumberFormat("id-ID", {
        style: "currency",
        currency: "IDR",
        minimumFractionDigits: 0,
      }).format(n);
    },
    fmtNum(s) {
      return parseInt(s || "0").toLocaleString("id-ID");
    },
    shortRupiah(n) {
      if (n >= 1000000) return n / 1000000 + "jt";
      if (n >= 1000) return n / 1000 + "rb";
      return n.toString();
    },

    numTap(k) {
      if (k.t === "del") {
        this.manualRaw = this.manualRaw.slice(0, -1);
      } else {
        const next = (this.manualRaw + k.v).replace(/^0+/, "") || "";
        if (next.length <= 9) this.manualRaw = next;
      }
    },

    addCart(id) {
      this.cart[id] = (this.cart[id] || 0) + 1;
    },
    delCart(id) {
      if ((this.cart[id] || 0) > 0) this.cart[id]--;
    },
    clearCart() {
      this.cart = {};
    },

    switchTab(t) {
      if (t === "pengaturan" && this.savedPin) {
        this.pinLocked = true;
        this.pinInput = "";
        this.pinError = "";
        return;
      }
      this.tab = t;
      this.subScreen = null;
      if (t === "pengaturan") this.loadCfg();
    },

    unlockPin() {
      if (this.pinInput === this.savedPin) {
        this.pinLocked = false;
        this.pinError = "";
        this.pinInput = "";
        this.tab = "pengaturan";
        this.loadCfg();
      } else {
        this.pinError = "PIN salah. Coba lagi.";
        this.pinInput = "";
      }
    },
    setPin() {
      if (this.cfgNewPin.length >= 4) {
        this.savedPin = this.cfgNewPin;
        localStorage.setItem("qk_pin", this.savedPin);
        this.cfgNewPin = "";
        this.popToast("✅ PIN berhasil diset");
      }
    },
    removePin() {
      this.savedPin = "";
      localStorage.removeItem("qk_pin");
      this.popToast("🔓 PIN dihapus");
    },

    syncMerchantName() {
      const name = extractMerchantName(this.cfgQris);

      if (name && name.length > 2) {
        this.cfgName = name;
      }
    },

    extractMerchantCity(qris) {
      try {
        let i = 0;

        while (i < qris.length) {
          if (i + 4 > qris.length) break;

          const tag = qris.substring(i, i + 2);
          const len = parseInt(qris.substring(i + 2, i + 4), 10);

          if (isNaN(len)) break;

          const val = qris.substring(i + 4, i + 4 + len);

          // tag 60 = kota
          if (tag === "60") return val.trim();

          i += 4 + len;
        }
      } catch (e) {}

      return "";
    },

    async renderInvoiceCanvas() {
      if (!this.qrImg) return null;

      const loadImage = (src) =>
        new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = reject;
          img.src = src;
        });

      const formatDate = () =>
        new Date().toLocaleString("id-ID", {
          dateStyle: "medium",
          timeStyle: "short",
        });

      const city = this.extractMerchantCity(this.qrisStatic);
      const itemCount = this.invItems?.length || 0;

      // --- Fungsi pembantu untuk sudut membulat ---
      function roundRect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
      }

      // --- Hitung tinggi minimum yang dibutuhkan ---
      let y = 740; // posisi awal item setelah header & info
      const rowHeight = 76;
      const emptyRowY = y; // simpan untuk fallback

      if (itemCount) {
        y += itemCount * rowHeight;
      } else {
        y += rowHeight; // ruang untuk "Pembayaran Manual"
      }

      const boxTop = y + 40;
      const boxHeight = 760; // tinggi blok total + QR
      const iconGroupBottom = boxTop + 940 + 120; // akhir grup ikon
      const footerHeight = 130;
      const minCanvasHeight = iconGroupBottom + footerHeight + 60; // padding bawah

      // Tetapkan tinggi kanvas, minimal 1920 px (agar tidak terlalu pendek)
      const W = 1080;
      const H = Math.max(1920, minCanvasHeight);

      const canvas = document.createElement("canvas");
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext("2d");

      // ========= BACKGROUND =========
      const bg = ctx.createLinearGradient(0, 0, 0, H);
      bg.addColorStop(0, "#f9f9fb");
      bg.addColorStop(1, "#e8ecf1");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);

      // ========= KARTU UTAMA =========
      ctx.fillStyle = "#ffffff";
      ctx.shadowColor = "rgba(0,0,0,0.05)";
      ctx.shadowBlur = 40;
      ctx.shadowOffsetY = 12;
      roundRect(ctx, 40, 40, W - 80, H - 80, 40);
      ctx.fill();
      ctx.shadowColor = "transparent";

      // ========= HEADER =========
      ctx.textAlign = "center";

      // Lingkaran logo
      const logoGrad = ctx.createLinearGradient(0, 0, 0, 200);
      logoGrad.addColorStop(0, "#e63946");
      logoGrad.addColorStop(1, "#b71c1c");
      ctx.fillStyle = logoGrad;
      ctx.beginPath();
      ctx.arc(W / 2, 150, 80, 0, Math.PI * 2);
      ctx.fill();

      // Lingkaran dalam (stroke)
      ctx.strokeStyle = "rgba(255,255,255,0.3)";
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.arc(W / 2, 150, 66, 0, Math.PI * 2);
      ctx.stroke();

      // Teks "QRIS"
      ctx.fillStyle = "#fff";
      ctx.font = "bold 30px 'Segoe UI', sans-serif";
      ctx.fillText("QRIS", W / 2, 162);

      // Nama merchant
      ctx.fillStyle = "#0a0a0a";
      ctx.font = "bold 56px 'Segoe UI', sans-serif";
      ctx.fillText(this.merchant || "Merchant", W / 2, 310);

      // Alamat
      ctx.fillStyle = "#6b7280";
      ctx.font = "26px 'Segoe UI', sans-serif";
      ctx.fillText(city ? `📍 ${city}` : "📍 Indonesia", W / 2, 360);

      // Garis pembatas
      ctx.strokeStyle = "#e5e7eb";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(100, 420);
      ctx.lineTo(W - 100, 420);
      ctx.stroke();

      // ========= INFO INVOICE =========
      ctx.textAlign = "left";
      ctx.fillStyle = "#6b7280";
      ctx.font = "22px 'Segoe UI', sans-serif";
      ctx.fillText("No. Invoice", 100, 500);
      ctx.fillStyle = "#d90429";
      ctx.font = "bold 28px 'Courier New', monospace";
      ctx.fillText(this.invNo || "-", 100, 545);

      ctx.fillStyle = "#6b7280";
      ctx.font = "22px 'Segoe UI', sans-serif";
      ctx.fillText("Tanggal", 620, 500);
      ctx.fillStyle = "#1f2937";
      ctx.font = "26px 'Segoe UI', sans-serif";
      ctx.fillText(formatDate(), 620, 545);

      // ========= HEADER TABEL =========
      ctx.fillStyle = "#d90429";
      roundRect(ctx, 60, 610, W - 120, 64, 16);
      ctx.fill();

      ctx.fillStyle = "#fff";
      ctx.font = "bold 22px 'Segoe UI', sans-serif";
      ctx.fillText("ITEM", 90, 650);
      ctx.fillText("QTY", 710, 650);
      ctx.fillText("SUBTOTAL", 830, 650);

      // ========= DAFTAR ITEM =========
      y = 740; // reset ke posisi awal item
      ctx.font = "28px 'Segoe UI', sans-serif";

      if (itemCount) {
        this.invItems.forEach((it, idx) => {
          // Baris item
          ctx.fillStyle = "#111827";
          ctx.textAlign = "left";
          ctx.fillText(`${it.emoji || "🍽️"}  ${it.name}`, 90, y);

          ctx.fillText(String(it.qty), 725, y);

          ctx.textAlign = "right";
          ctx.fillText(this.rupiah(it.sub), W - 90, y);

          // Garis pemisah antar item
          ctx.strokeStyle = "#f3f4f6";
          ctx.beginPath();
          ctx.moveTo(80, y + 28);
          ctx.lineTo(W - 80, y + 28);
          ctx.stroke();

          y += rowHeight;
        });
      } else {
        ctx.fillStyle = "#4b5563";
        ctx.textAlign = "left";
        ctx.fillText("Pembayaran Manual", 90, y);
        y += rowHeight;
      }

      // ========= BLOK TOTAL + QR =========
      const boxY = y + 40;
      const cardGrad = ctx.createLinearGradient(0, boxY, 0, boxY + boxHeight);
      cardGrad.addColorStop(0, "#ffffff");
      cardGrad.addColorStop(1, "#f8f9fa");
      ctx.fillStyle = cardGrad;
      roundRect(ctx, 60, boxY, W - 120, boxHeight, 32);
      ctx.fill();

      // Garis vertikal pemisah
      ctx.strokeStyle = "#e5e7eb";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(W / 2, boxY + 30);
      ctx.lineTo(W / 2, boxY + 190);
      ctx.stroke();

      // Total
      ctx.textAlign = "left";
      ctx.fillStyle = "#374151";
      ctx.font = "bold 32px 'Segoe UI', sans-serif";
      ctx.fillText("TOTAL", 100, boxY + 80);
      ctx.fillStyle = "#d90429";
      ctx.font = "bold 68px 'Segoe UI', sans-serif";
      ctx.fillText(this.rupiah(this.finalAmt), 100, boxY + 160);

      // Metode pembayaran
      ctx.fillStyle = "#6b7280";
      ctx.font = "26px 'Segoe UI', sans-serif";
      ctx.fillText("Metode Pembayaran", 600, boxY + 80);
      ctx.fillStyle = "#111827";
      ctx.font = "bold 42px 'Segoe UI', sans-serif";
      ctx.fillText("QRIS", 600, boxY + 138);
      ctx.fillStyle = "#4b5563";
      ctx.font = "20px 'Segoe UI', sans-serif";
      ctx.fillText("QR Code Standar", 600, boxY + 180);
      ctx.fillText("Pembayaran Nasional", 600, boxY + 208);

      // Label scan
      ctx.fillStyle = "#6b7280";
      ctx.font = "24px 'Segoe UI', sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Scan QRIS untuk pembayaran", W / 2, boxY + 270);

      // ========= QR CODE =========
      const qr = await loadImage(this.qrImg);
      const qrSize = 430;
      ctx.fillStyle = "#fff";
      ctx.shadowColor = "rgba(0,0,0,0.1)";
      ctx.shadowBlur = 24;
      ctx.shadowOffsetY = 8;
      roundRect(
        ctx,
        (W - qrSize) / 2 - 24,
        boxY + 310,
        qrSize + 48,
        qrSize + 48,
        24
      );
      ctx.fill();
      ctx.shadowColor = "transparent";

      ctx.drawImage(qr, (W - qrSize) / 2, boxY + 334, qrSize, qrSize);

      // Teks bawah QR
      ctx.fillStyle = "#0a0a0a";
      ctx.font = "bold 27px 'Segoe UI', sans-serif";
      ctx.fillText("SATU QRIS UNTUK SEMUA", W / 2, boxY + 840);

      // ========= LANGKAH PEMBAYARAN =========
      const iconY = boxY + 940;
      const icons = [
        ["📱", "Buka Aplikasi", "E-Wallet / Bank"],
        ["📋", "Pilih Menu", "QRIS"],
        ["📷", "Scan QR Code", "di Atas"],
        ["✅", "Konfirmasi", "Pembayaran"],
      ];

      icons.forEach((ico, idx) => {
        const x = 170 + idx * 240;
        // Lingkaran ikon
        ctx.fillStyle = "#f3f4f6";
        ctx.beginPath();
        ctx.arc(x, iconY, 52, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#d1d5db";
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.font = "38px 'Segoe UI', sans-serif";
        ctx.fillStyle = "#d90429";
        ctx.textAlign = "center";
        ctx.fillText(ico[0], x, iconY + 14);

        ctx.font = "bold 19px 'Segoe UI', sans-serif";
        ctx.fillStyle = "#1f2937";
        ctx.fillText(ico[1], x, iconY + 92);

        ctx.font = "18px 'Segoe UI', sans-serif";
        ctx.fillStyle = "#6b7280";
        ctx.fillText(ico[2], x, iconY + 120);
      });

      // ========= FOOTER =========
      const footGrad = ctx.createLinearGradient(0, H - 180, 0, H);
      footGrad.addColorStop(0, "#e63946");
      footGrad.addColorStop(1, "#b71c1c");
      ctx.fillStyle = footGrad;
      roundRect(ctx, 40, H - 170, W - 80, 130, 0);
      ctx.fill();

      ctx.textAlign = "center";
      ctx.fillStyle = "#fff";
      ctx.font = "bold 28px 'Segoe UI', sans-serif";
      ctx.fillText("Terima kasih telah berbelanja 🙏", W / 2, H - 105);
      ctx.font = "22px 'Segoe UI', sans-serif";
      ctx.fillText(
        "Barang yang sudah dibeli tidak dapat dikembalikan",
        W / 2,
        H - 65
      );

      return canvas.toDataURL("image/png", 1.0);
    },

    async generateQRIS(amount) {
      if (!amount || amount <= 0) return;
      if (!this.qrisStatic) {
        this.popToast("⚠️ Setup QRIS statis di Pengaturan dulu");
        return;
      }
      if (typeof QRCode === "undefined") {
        this.popToast(
          "⚠️ Library QRCode tidak tersedia. Periksa koneksi internet Anda."
        );
        return;
      }
      try {
        const modified = injectAmount(this.qrisStatic, amount);
        this.finalAmt = amount;
        this.invNo = this.makeInvNo();
        this.invTime = new Date().toLocaleString("id-ID", {
          dateStyle: "long",
          timeStyle: "short",
        });
        this.invItems = [...this.cartLines];
        this.qrImg = await QRCode.toDataURL(modified, {
          width: 1024,
          margin: 2,
          color: { dark: "#000000", light: "#FFFFFF" },
          errorCorrectionLevel: "H",
        });
        this.clearCart();
        this.history.unshift({
          no: this.invNo,
          amount,
          time: this.invTime,
          ts: Date.now(),
        });
        this.saveHistory();
        this.subScreen = "result";
      } catch (e) {
        this.popToast("❌ " + e.message);
      }
    },
    makeInvNo() {
      const d = new Date(),
        p = (x) => String(x).padStart(2, "0");
      return `INV${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(
        d.getHours()
      )}${p(d.getMinutes())}${p(d.getSeconds())}`;
    },

    get invCaption() {
      const lines =
        this.invItems.length > 0
          ? this.invItems
              .map((i) => `  • ${i.name} ×${i.qty}  →  ${this.rupiah(i.sub)}`)
              .join("\n")
          : "  • Pembayaran manual";
      return (
        `🧾 *INVOICE PEMBAYARAN*\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `📋 No Invoice  : *${this.invNo}*\n` +
        `🏪 Merchant    : ${this.merchant}\n` +
        `📅 Tanggal     : ${this.invTime}\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `${lines}\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `💰 *TOTAL: ${this.rupiah(this.finalAmt)}*\n\n` +
        `📲 _Scan QRIS untuk melakukan pembayaran_\n` +
        `_Terima kasih telah berbelanja di ${this.merchant}_ 🙏`
      );
    },

    async shareInvoice() {
      try {
        const rendered = await this.renderInvoiceCanvas();

        const res = await fetch(rendered);
        const blob = await res.blob();

        const file = new File([blob], `invoice-${this.invNo}.png`, {
          type: "image/png",
        });

        const shareData = {
          title: `Invoice ${this.invNo}`,
          text: `Invoice pembayaran ${this.rupiah(this.finalAmt)}`,
          files: [file],
        };

        if (navigator.share && navigator.canShare?.(shareData)) {
          await navigator.share(shareData);
          this.popToast("✅ Invoice berhasil dibagikan");
          return;
        }

        // fallback download
        const a = document.createElement("a");
        a.href = rendered;
        a.download = `invoice-${this.invNo}.png`;
        a.click();

        this.popToast("✅ Invoice berhasil diunduh");
      } catch (e) {
        console.error(e);
        this.popToast("❌ Gagal membuat invoice");
      }
    },

    dlQR() {
      if (!this.qrImg) return;
      const a = document.createElement("a");
      a.href = this.qrImg;
      a.download = `qris-${this.invNo}.png`;
      a.click();
      this.popToast("✅ QR berhasil diunduh");
    },
    newTxn() {
      this.cart = {};
      this.manualRaw = "";
      this.qrImg = null;
      this.invItems = [];
      this.subScreen = null;
    },

    async openScanner() {
      this.scanner.open = true;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
        });
        this.scanner.stream = stream;
        const video = this.$refs.scannerVideo;
        video.srcObject = stream;
        video.play();
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        this.scanner.intervalId = setInterval(() => {
          if (!this.scanner.open) return;
          if (video.readyState === video.HAVE_ENOUGH_DATA) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const imageData = ctx.getImageData(
              0,
              0,
              canvas.width,
              canvas.height
            );
            const code = jsQR(imageData.data, canvas.width, canvas.height);
            if (code && code.data) {
              this.onQrisScanned(code.data);
            }
          }
        }, 400);
      } catch (e) {
        this.popToast("⚠️ Tidak bisa mengakses kamera");
        this.scanner.open = false;
      }
    },
    stopScanner() {
      this.scanner.open = false;
      if (this.scanner.intervalId) clearInterval(this.scanner.intervalId);
      if (this.scanner.stream) {
        this.scanner.stream.getTracks().forEach((t) => t.stop());
        this.scanner.stream = null;
      }
    },
    onQrisScanned(data) {
      this.cfgQris = data;
      const extracted = extractMerchantName(data);
      if (extracted) this.cfgName = extracted;
      this.stopScanner();
      this.popToast("✅ QRIS berhasil dipindai");
    },
    async handleQrisUpload(event) {
      const file = event.target.files[0];
      if (!file) return;
      try {
        const img = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const i = new Image();
            i.onload = () => resolve(i);
            i.onerror = reject;
            i.src = reader.result;
          };
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        const canvas = document.createElement("canvas");
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(imageData.data, canvas.width, canvas.height);
        if (code && code.data) {
          this.onQrisScanned(code.data);
        } else {
          this.popToast("⚠️ QR tidak terdeteksi di gambar");
        }
      } catch (e) {
        this.popToast("⚠️ Gagal membaca gambar");
      }
      event.target.value = "";
    },

    loadCfg() {
      this.cfgName = this.merchant;
      this.cfgQris = this.qrisStatic;
      this.cfgProductsJson = JSON.stringify(this.products, null, 2);
    },
    saveAllSettings() {
      this.merchant = this.cfgName.trim() || "Toko Saya";
      this.qrisStatic = this.cfgQris.trim();
      try {
        const parsed = JSON.parse(this.cfgProductsJson);
        if (Array.isArray(parsed) && parsed.length > 0) this.products = parsed;
        else throw new Error("Array kosong");
      } catch (e) {
        this.popToast("⚠️ Format JSON produk tidak valid");
        return;
      }
      localStorage.setItem("qk_name", this.merchant);
      localStorage.setItem("qk_qris", this.qrisStatic);
      localStorage.setItem("qk_products", JSON.stringify(this.products));
      this.popToast("✅ Pengaturan tersimpan");
    },
    logout() {
      if (
        confirm(
          "Yakin ingin logout? Semua data akan dihapus dan tidak bisa dikembalikan."
        )
      ) {
        localStorage.clear();
        this.merchant = "Toko Saya";
        this.qrisStatic = "";
        this.products = [
          { id: 1, name: "Nasi Goreng", price: 25000, emoji: "🍳" },
          { id: 2, name: "Es Teh Manis", price: 5000, emoji: "🧊" },
          { id: 3, name: "Ayam Bakar", price: 35000, emoji: "🍗" },
          { id: 4, name: "Mie Goreng", price: 20000, emoji: "🍜" },
        ];
        this.history = [];
        this.savedPin = "";
        this.pinLocked = false;
        this.tab = "transaksi";
        this.subScreen = null;
        this.cart = {};
        this.popToast("👋 Logout berhasil. Data direset.");
      }
    },

    saveHistory() {
      localStorage.setItem(
        "qk_history",
        JSON.stringify(this.history.slice(0, 200))
      );
    },
    loadHistory() {
      const raw = localStorage.getItem("qk_history");
      if (raw) {
        try {
          this.history = JSON.parse(raw);
        } catch (e) {}
      }
    },

    popToast(msg) {
      this.toast = { show: true, msg };
      setTimeout(() => (this.toast.show = false), 2600);
    },

    init() {
      this.merchant = localStorage.getItem("qk_name") || "Toko Saya";
      this.qrisStatic = localStorage.getItem("qk_qris") || "";
      this.savedPin = localStorage.getItem("qk_pin") || "";
      const savedProd = localStorage.getItem("qk_products");
      if (savedProd) {
        try {
          this.products = JSON.parse(savedProd);
        } catch (e) {}
      }
      this.loadHistory();
      this.cfgName = this.merchant;
      this.cfgQris = this.qrisStatic;
      this.cfgProductsJson = JSON.stringify(this.products, null, 2);
    },
  };
}
