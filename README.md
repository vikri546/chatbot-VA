# WhatsApp Chatbot VA 🤖

WhatsApp chatbot menggunakan [Baileys](https://github.com/WhiskeySockets/Baileys) yang dioptimalkan untuk **Termux**.
Koneksi menggunakan **pairing code** (tanpa scan QR).

## ✨ Fitur

- 🖼️ **Buat Stiker** — Kirim gambar dengan caption `.stiker` atau `.sticker`
- 🎬 **GIF Stiker** — Kirim video (maks 5 detik) dengan caption `.stiker` → stiker animasi
- 🌤️ **Cuaca** — Cek info cuaca realtime: `.cuaca Jakarta`
- 📲 **QR Code** — Buat QR code dari teks/link: `.qr https://google.com`
- ⏰ **Reminder** — Set pengingat otomatis: `.ingatkan 30m Minum obat`
- 📦 Nama paket stiker: **Copyright VA 2026**
- 📋 **Menu** — Ketik `.menu` atau `.help`

## 📱 Setup di Termux

### 1. Install Dependencies Termux

```bash
pkg update && pkg upgrade -y
pkg install nodejs git ffmpeg -y
```

> ⚠️ **ffmpeg wajib diinstall** untuk fitur GIF stiker (konversi video ke animated WebP).

### 2. Clone Repository

```bash
git clone https://github.com/USERNAME/chatbot-VA.git
cd chatbot-VA
```

> Ganti `USERNAME` dengan GitHub username kamu.

### 3. Install Node Modules

```bash
npm install
```

### 4. Jalankan Bot

```bash
node index.js
```

### 5. Hubungkan ke WhatsApp

1. Masukkan nomor telepon di terminal (format: `6281234567890`)
2. Catat **pairing code** yang muncul
3. Buka **WhatsApp** di HP → **Settings** → **Linked Devices**
4. Tap **Link a Device**
5. Tap **Link with phone number instead**
6. Masukkan pairing code

✅ Bot akan terhubung dan siap digunakan!

## 🎨 Cara Pakai

| Perintah                     | Fungsi                                                         |
| ---------------------------- | -------------------------------------------------------------- |
| `.stiker` / `.sticker`       | Kirim **gambar** dengan caption ini → stiker                   |
| `.stiker` / `.sticker`       | Kirim **video** (maks 5 detik) dengan caption ini → GIF stiker |
| `.cuaca [kota]`              | Cek info cuaca realtime (contoh: `.cuaca Jakarta`)             |
| `.qr [teks/url]`             | Buat QR code dari teks atau link                               |
| `.ingatkan [durasi] [pesan]` | Set pengingat (d=detik, m=menit, j=jam)                        |
| `.listreminder`              | Lihat daftar pengingat aktif                                   |
| `.hapusreminder [id]`        | Batalkan pengingat                                             |
| `.menu` / `.help`            | Menampilkan daftar perintah                                    |

## ⚡ Setup Cepat (Opsional)

Gunakan script otomatis:

```bash
bash termux-setup.sh
```

## 📝 Catatan

- Session tersimpan di folder `auth_info/` — jangan dihapus kecuali ingin login ulang
- Jika bot terputus, otomatis akan reconnect
- Jika terkena logout, hapus folder `auth_info/` lalu jalankan ulang
- Butuh **Node.js 18+** dan **ffmpeg**

## 📄 Lisensi

MIT © VA 2026
