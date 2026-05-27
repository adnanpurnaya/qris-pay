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
          width: 240,
          margin: 2,
          color: { dark: "#000000", light: "#FFFFFF" },
          errorCorrectionLevel: "M",
        });
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

    // ⚡️ Fungsi share baru menggunakan Web Share API
    shareInvoice() {
      const text = this.invCaption;
      if (navigator.share) {
        navigator
          .share({ text })
          .then(() => this.popToast("✅ Invoice dibagikan"))
          .catch((err) => {
            if (err.name !== "AbortError") {
              this.popToast("❌ Gagal membagikan");
            }
          });
      } else {
        // Fallback ke clipboard
        navigator.clipboard
          .writeText(text)
          .then(() => this.popToast("📋 Invoice disalin ke clipboard"))
          .catch(() => this.popToast("❌ Gagal menyalin teks"));
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
