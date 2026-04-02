const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');
const readline = require('readline');
const { createSticker, createGifSticker } = require('./lib/sticker');
const { getWeather } = require('./lib/weather');

// ══════════════════════════════════════════════
//  WhatsApp Chatbot VA - Sticker Bot
//  Menggunakan Baileys + Pairing Code
//  Optimized for Termux
// ══════════════════════════════════════════════

const logger = pino({ level: 'silent' }); // silent agar terminal bersih

/**
 * Minta input dari user di terminal
 */
function askQuestion(query) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    return new Promise((resolve) => {
        rl.question(query, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

/**
 * Fungsi utama untuk menjalankan bot
 */
async function startBot() {
    console.log('══════════════════════════════════════');
    console.log('  WhatsApp Chatbot VA - Sticker Bot');
    console.log('══════════════════════════════════════\n');

    // 1. Load atau buat session baru
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');

    // 2. Buat koneksi WhatsApp
    const sock = makeWASocket({
        auth: state,
        logger: logger,
        printQRInTerminal: false, // WAJIB false untuk pairing code
        browser: ['Chatbot VA', 'Chrome', '1.0.0']
    });

    // 3. Jika belum terdaftar, minta pairing code
    if (!sock.authState.creds.registered) {
        console.log('📱 Belum terhubung ke WhatsApp.\n');

        const phoneNumber = await askQuestion('Masukkan nomor telepon (contoh: 6281234567890): ');

        // Bersihkan nomor dari karakter yang tidak perlu
        const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');

        if (!cleanNumber || cleanNumber.length < 10) {
            console.log('❌ Nomor telepon tidak valid!');
            process.exit(1);
        }

        // Tunggu sebentar sebelum request pairing code
        await new Promise(resolve => setTimeout(resolve, 3000));

        const code = await sock.requestPairingCode(cleanNumber);
        console.log(`\n🔑 Pairing Code: ${code}`);
        console.log('\n📋 Cara memasukkan kode:');
        console.log('   1. Buka WhatsApp di HP');
        console.log('   2. Buka Settings > Linked Devices');
        console.log('   3. Tap "Link a Device"');
        console.log('   4. Tap "Link with phone number instead"');
        console.log('   5. Masukkan kode di atas\n');
    }

    // 4. Simpan credentials saat update
    sock.ev.on('creds.update', saveCreds);

    // 5. Handle koneksi
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            console.log(`\n⚠️  Koneksi terputus (code: ${statusCode})`);

            if (shouldReconnect) {
                console.log('🔄 Mencoba reconnect...\n');
                startBot();
            } else {
                console.log('❌ Logged out. Hapus folder auth_info/ dan jalankan ulang.');
                process.exit(0);
            }
        }

        if (connection === 'open') {
            console.log('✅ Terhubung ke WhatsApp!\n');
            console.log('📌 Cara pakai:');
            console.log('   🖼️  Kirim gambar + caption .stiker → stiker biasa');
            console.log('   🎬 Kirim video (maks 5 detik) + caption .stiker → GIF stiker\n');
            console.log('⏳ Menunggu pesan masuk...\n');
        }
    });

    // 6. Handle pesan masuk
    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
            try {
                // Abaikan pesan dari bot sendiri / broadcast / status
                if (msg.key.fromMe) continue;
                if (msg.key.remoteJid === 'status@broadcast') continue;
                if (!msg.message) continue;

                await handleMessage(sock, msg);
            } catch (err) {
                console.log(`❌ Error handling pesan: ${err.message}`);
            }
        }
    });
}

/**
 * Handle pesan masuk
 */
async function handleMessage(sock, msg) {
    const jid = msg.key.remoteJid;
    const messageType = Object.keys(msg.message)[0];
    const caption = getCaption(msg);

    // Cek apakah pesan berisi gambar/video + caption .stiker/.sticker
    const isImage = messageType === 'imageMessage' ||
                    (messageType === 'extendedTextMessage' && msg.message.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage);
    const isVideo = messageType === 'videoMessage';

    const isStickerCommand = caption &&
        (caption.toLowerCase() === '.stiker' || caption.toLowerCase() === '.sticker');

    // ═══ STIKER GAMBAR ═══
    if (isImage && isStickerCommand) {
        console.log(`📨 Menerima permintaan stiker gambar dari ${jid}`);

        await sock.sendMessage(jid, { react: { text: '⏳', key: msg.key } });

        try {
            const buffer = await downloadMediaMessage(msg, 'buffer', {});
            const stickerBuffer = await createSticker(buffer);
            await sock.sendMessage(jid, { sticker: stickerBuffer }, { quoted: msg });
            await sock.sendMessage(jid, { react: { text: '✅', key: msg.key } });
            console.log(`✅ Stiker gambar berhasil dikirim ke ${jid}`);
        } catch (err) {
            console.log(`❌ Gagal membuat stiker gambar: ${err.message}`);
            await sock.sendMessage(jid, { react: { text: '❌', key: msg.key } });
            await sock.sendMessage(jid, {
                text: '❌ Gagal membuat stiker. Pastikan gambar valid dan coba lagi.'
            }, { quoted: msg });
        }
    }

    // ═══ GIF STIKER (VIDEO) ═══
    if (isVideo && isStickerCommand) {
        const videoDuration = msg.message.videoMessage?.seconds || 0;
        console.log(`🎬 Menerima permintaan GIF stiker dari ${jid} (durasi: ${videoDuration}s)`);

        // Cek durasi dari metadata pesan
        if (videoDuration > 5) {
            await sock.sendMessage(jid, { react: { text: '❌', key: msg.key } });
            await sock.sendMessage(jid, {
                text: '❌ Video terlalu panjang! Maksimal *5 detik* untuk GIF stiker.'
            }, { quoted: msg });
            return;
        }

        await sock.sendMessage(jid, { react: { text: '⏳', key: msg.key } });

        try {
            const buffer = await downloadMediaMessage(msg, 'buffer', {});
            const stickerBuffer = await createGifSticker(buffer);
            await sock.sendMessage(jid, { sticker: stickerBuffer }, { quoted: msg });
            await sock.sendMessage(jid, { react: { text: '✅', key: msg.key } });
            console.log(`✅ GIF stiker berhasil dikirim ke ${jid}`);
        } catch (err) {
            console.log(`❌ Gagal membuat GIF stiker: ${err.message}`);
            await sock.sendMessage(jid, { react: { text: '❌', key: msg.key } });
            await sock.sendMessage(jid, {
                text: `❌ Gagal membuat GIF stiker. ${err.message}`
            }, { quoted: msg });
        }
    }

    // ═══ CUACA ═══
    if (caption && caption.toLowerCase().startsWith('.cuaca')) {
        const city = caption.slice(6).trim();

        if (!city) {
            await sock.sendMessage(jid, {
                text: '❌ Masukkan nama kota!\n\nContoh: *.cuaca Jakarta*'
            }, { quoted: msg });
            return;
        }

        console.log(`🌤️ Permintaan cuaca "${city}" dari ${jid}`);
        await sock.sendMessage(jid, { react: { text: '⏳', key: msg.key } });

        try {
            const result = await getWeather(city);
            await sock.sendMessage(jid, { text: result }, { quoted: msg });
            await sock.sendMessage(jid, { react: { text: '✅', key: msg.key } });
            console.log(`✅ Info cuaca "${city}" dikirim ke ${jid}`);
        } catch (err) {
            console.log(`❌ Gagal ambil cuaca: ${err.message}`);
            await sock.sendMessage(jid, { react: { text: '❌', key: msg.key } });
            await sock.sendMessage(jid, {
                text: `❌ ${err.message}`
            }, { quoted: msg });
        }
    }

    // Menu / help command
    if (caption && (caption.toLowerCase() === '.menu' || caption.toLowerCase() === '.help')) {
        const menuText = `╔══════════════════════╗
║  *CHATBOT VA*  🤖
╚══════════════════════╝

📌 *Daftar Perintah:*

🖼️ *.stiker* / *.sticker*
   Kirim *gambar* dengan caption ini
   untuk dijadikan stiker.

🎬 *.stiker* / *.sticker*
   Kirim *video* (maks 5 detik)
   dengan caption ini untuk dijadikan
   GIF stiker animasi.

🌤️ *.cuaca* [kota]
   Cek info cuaca realtime.
   Contoh: .cuaca Jakarta

ℹ️ *.menu* / *.help*
   Menampilkan menu ini.

📦 Nama paket: *Copyright VA 2026*
─────────────────────
_© Copyright VA 2026_`;

        await sock.sendMessage(jid, { text: menuText }, { quoted: msg });
    }
}

/**
 * Ambil caption dari berbagai tipe pesan
 */
function getCaption(msg) {
    if (!msg.message) return '';

    const messageType = Object.keys(msg.message)[0];

    switch (messageType) {
        case 'imageMessage':
            return msg.message.imageMessage?.caption || '';
        case 'videoMessage':
            return msg.message.videoMessage?.caption || '';
        case 'extendedTextMessage':
            return msg.message.extendedTextMessage?.text || '';
        case 'conversation':
            return msg.message.conversation || '';
        default:
            return '';
    }
}

// Jalankan bot
startBot().catch((err) => {
    console.log(`❌ Fatal error: ${err.message}`);
    process.exit(1);
});
