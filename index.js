const makeWASocket = require('@whiskeysockets/baileys').default;
const { 
    useMultiFileAuthState, 
    DisconnectReason, 
    downloadMediaMessage,
    Browsers,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const { createSticker, createGifSticker } = require('./lib/sticker');
const { getWeather } = require('./lib/weather');
const { generateQR } = require('./lib/qrcode');
const { parseDuration, setReminder, cancelReminder, getReminders, formatRemaining } = require('./lib/reminder');
const { textToSpeech } = require('./lib/tts');
const { downloadMedia, detectPlatform, formatDuration } = require('./lib/downloader');
const { chat: geminiChat, resetChat: geminiReset } = require('./lib/gemini');
const log = require('./lib/logger');

// ══════════════════════════════════════════════
//  WhatsApp Chatbot VA - Mode Nomor HP
//  Optimized for Termux (Anti Timeout)
// ══════════════════════════════════════════════

const logger = pino({ level: 'silent' });
const AUTH_DIR = 'auth_info';
const SESSION_FILE = path.join(AUTH_DIR, '.session_created');
const SESSION_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 hari dalam ms

function checkSessionExpiry() {
    if (!fs.existsSync(SESSION_FILE)) return;

    try {
        const created = parseInt(fs.readFileSync(SESSION_FILE, 'utf-8').trim());
        const age = Date.now() - created;

        if (age >= SESSION_MAX_AGE) {
            log.warn('Session expired (lebih dari 30 hari)');
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
            log.sys('Session lama dihapus. Silakan pairing ulang.');
        }
    } catch (_) {}
}

function saveSessionTimestamp() {
    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
    if (!fs.existsSync(SESSION_FILE)) fs.writeFileSync(SESSION_FILE, String(Date.now()));
}

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

async function startBot() {
    console.log('');
    console.log('  ┌─────────────────────────────┐');
    console.log('  │    WhatsApp Chatbot VA       │');
    console.log('  └─────────────────────────────┘');
    console.log('');

    checkSessionExpiry();

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    // KUNCI PERBAIKAN: Minta nomor HP SEBELUM membuka koneksi ke WhatsApp
    // Mencegah error "Connection Closed" karena timeout saat mengetik.
    let phoneNumber = '';
    if (!state.creds.registered) {
        log.sys('Belum terhubung ke WhatsApp');
        const input = await askQuestion('Masukkan nomor telepon bot (contoh: 6281234567890): ');
        phoneNumber = input.replace(/[^0-9]/g, '');

        if (!phoneNumber || phoneNumber.length < 10) {
            log.fail(null, 'Nomor telepon tidak valid');
            process.exit(1);
        }
    }

    // Ambil versi WA Web terbaru
    const { version, isLatest } = await fetchLatestBaileysVersion();
    log.info(`WA Web v${version.join('.')} (latest: ${isLatest})`);

    // Buka koneksi HANYA setelah nomor didapatkan
    const sock = makeWASocket({
        version,
        auth: state,
        logger: logger,
        printQRInTerminal: false, // Wajib false untuk mode nomor HP
        browser: Browsers.ubuntu('Chrome'), // Menyamar sebagai PC
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
        markOnlineOnConnect: true
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            log.warn(`Koneksi terputus (code: ${statusCode})`);

            if (statusCode === 401 || statusCode === DisconnectReason.loggedOut) {
                log.warn('Sesi ditolak. Menghapus data login...');
                fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                process.exit(0);
            }

            if (shouldReconnect) {
                log.sys('Mencoba reconnect...');
                startBot();
            }
        }

        if (connection === 'open') {
            saveSessionTimestamp();
            log.sys('Terhubung ke WhatsApp');
            log.sys('Bot siap menerima pesan');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
            try {
                if (msg.key.fromMe) continue;
                if (msg.key.remoteJid === 'status@broadcast') continue;
                if (!msg.message) continue;

                await handleMessage(sock, msg);
            } catch (err) {
                log.fail(msg.key?.remoteJid, 'Error handling pesan', err.message);
            }
        }
    });

    // Request Pairing Code SETELAH event terpasang dan koneksi socket mulai berjalan
    if (phoneNumber && !sock.authState.creds.registered) {
        log.sys('Menghubungkan ke server WhatsApp...');
        
        // Jeda 3 detik agar koneksi websocket benar-benar terbuka
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(phoneNumber);
                const formattedCode = code?.match(/.{1,4}/g)?.join('-') || code;
                
                log.info(`PAIRING CODE: ${formattedCode}`);
                console.log('');
                console.log('  1. Buka WhatsApp di HP');
                console.log('  2. Settings > Perangkat Tertaut');
                console.log('  3. Tautkan Perangkat');
                console.log('  4. Tautkan dengan nomor telepon');
                console.log('  5. Masukkan kode di atas');
                console.log('');
                log.warn('Tunggu sampai TERHUBUNG sebelum menutup terminal');
            } catch (error) {
                log.fail(null, 'Gagal meminta pairing code', error.message);
                log.info('Coba hapus folder auth_info dan jalankan ulang');
            }
        }, 3000); 
    }
}

/**
 * Handle pesan masuk
 */
async function handleMessage(sock, msg) {
    const jid = msg.key.remoteJid;
    const messageType = Object.keys(msg.message)[0];
    const caption = getCaption(msg);

    const isImage = messageType === 'imageMessage' ||
                    (messageType === 'extendedTextMessage' && msg.message.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage);
    const isVideo = messageType === 'videoMessage';

    const isStickerCommand = caption &&
        (caption.toLowerCase() === '.stiker' || caption.toLowerCase() === '.sticker');

    // ═══ STIKER GAMBAR ═══
    if (isImage && isStickerCommand) {
        log.chat(jid, 'Stiker gambar');

        await sock.sendMessage(jid, { react: { text: '⏳', key: msg.key } });

        try {
            const buffer = await downloadMediaMessage(msg, 'buffer', {});
            const stickerBuffer = await createSticker(buffer);
            await sock.sendMessage(jid, { sticker: stickerBuffer }, { quoted: msg });
            await sock.sendMessage(jid, { react: { text: '✅', key: msg.key } });
            log.done(jid, 'Stiker gambar dikirim');
        } catch (err) {
            log.fail(jid, 'Stiker gambar gagal', err.message);
            await sock.sendMessage(jid, { react: { text: '❌', key: msg.key } });
            await sock.sendMessage(jid, {
                text: '❌ Gagal membuat stiker. Pastikan gambar valid dan coba lagi.'
            }, { quoted: msg });
        }
    }

    // ═══ GIF STIKER (VIDEO) ═══
    if (isVideo && isStickerCommand) {
        const videoDuration = msg.message.videoMessage?.seconds || 0;
        log.chat(jid, 'GIF stiker', `${videoDuration}s`);

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
            log.done(jid, 'GIF stiker dikirim');
        } catch (err) {
            log.fail(jid, 'GIF stiker gagal', err.message);
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

        log.chat(jid, 'Cuaca', city);
        await sock.sendMessage(jid, { react: { text: '⏳', key: msg.key } });

        try {
            const result = await getWeather(city);
            await sock.sendMessage(jid, { text: result }, { quoted: msg });
            await sock.sendMessage(jid, { react: { text: '✅', key: msg.key } });
            log.done(jid, 'Cuaca dikirim');
        } catch (err) {
            log.fail(jid, 'Cuaca gagal', err.message);
            await sock.sendMessage(jid, { react: { text: '❌', key: msg.key } });
            await sock.sendMessage(jid, {
                text: `❌ ${err.message}`
            }, { quoted: msg });
        }
    }

    // ═══ QR CODE GENERATOR ═══
    if (caption && caption.toLowerCase().startsWith('.qr')) {
        const text = caption.slice(3).trim();

        if (!text) {
            await sock.sendMessage(jid, {
                text: '❌ Masukkan teks atau URL!\n\nContoh: *.qr https://google.com*'
            }, { quoted: msg });
            return;
        }

        log.chat(jid, 'QR code');
        await sock.sendMessage(jid, { react: { text: '⏳', key: msg.key } });

        try {
            const qrBuffer = await generateQR(text);
            await sock.sendMessage(jid, {
                image: qrBuffer,
                caption: `📲 *QR Code*\n\n📝 *Isi:* ${text}\n\n_© Copyright VA 2026_`
            }, { quoted: msg });
            await sock.sendMessage(jid, { react: { text: '✅', key: msg.key } });
            log.done(jid, 'QR code dikirim');
        } catch (err) {
            log.fail(jid, 'QR code gagal', err.message);
            await sock.sendMessage(jid, { react: { text: '❌', key: msg.key } });
            await sock.sendMessage(jid, {
                text: '❌ Gagal membuat QR code. Coba lagi.'
            }, { quoted: msg });
        }
    }

    // ═══ REMINDER / PENGINGAT ═══
    if (caption && (caption.toLowerCase().startsWith('.ingatkan') || caption.toLowerCase().startsWith('.reminder'))) {
        const prefix = caption.toLowerCase().startsWith('.ingatkan') ? '.ingatkan' : '.reminder';
        const args = caption.slice(prefix.length).trim();
        const spaceIdx = args.indexOf(' ');

        if (!args || spaceIdx === -1) {
            await sock.sendMessage(jid, {
                text: `❌ Format salah!\n\n*Cara pakai:*\n.ingatkan [durasi] [pesan]\n\n*Contoh:*\n.ingatkan 30m Minum obat\n.ingatkan 2j Meeting kantor\n.ingatkan 10d Cek oven\n\n*Durasi:* d=detik, m=menit, j=jam`
            }, { quoted: msg });
            return;
        }

        const durationStr = args.slice(0, spaceIdx);
        const reminderText = args.slice(spaceIdx + 1).trim();
        const parsed = parseDuration(durationStr);

        if (!parsed) {
            await sock.sendMessage(jid, {
                text: '❌ Durasi tidak valid!\n\nGunakan format: *30d* (detik), *30m* (menit), *2j* (jam)\nMaksimal 24 jam.'
            }, { quoted: msg });
            return;
        }

        if (!reminderText) {
            await sock.sendMessage(jid, {
                text: '❌ Masukkan pesan pengingat!\n\nContoh: .ingatkan 30m *Minum obat*'
            }, { quoted: msg });
            return;
        }

        const id = setReminder(jid, parsed.ms, reminderText, async (targetJid, text, remId) => {
            await sock.sendMessage(targetJid, {
                text: `⏰ *PENGINGAT!*\n\n📝 ${text}\n\n_Reminder #${remId} — © Copyright VA 2026_`
            });
            log.done(targetJid, `Reminder #${remId} terkirim`);
        });

        await sock.sendMessage(jid, {
            text: `✅ Pengingat berhasil diset!\n\n⏰ *ID:* #${id}\n📝 *Pesan:* ${reminderText}\n⏱️ *Dalam:* ${parsed.label}\n\n_Ketik .listreminder untuk melihat daftar_\n_Ketik .hapusreminder ${id} untuk membatalkan_`
        }, { quoted: msg });

        log.chat(jid, `Reminder #${id}`, `"${reminderText}" dalam ${parsed.label}`);
    }

    // ═══ LIST REMINDER ═══
    if (caption && caption.toLowerCase() === '.listreminder') {
        const reminders = getReminders(jid);

        if (reminders.length === 0) {
            await sock.sendMessage(jid, {
                text: '📝 Tidak ada pengingat aktif.'
            }, { quoted: msg });
            return;
        }

        let listText = `⏰ *Daftar Pengingat Aktif:*\n\n`;
        for (const r of reminders) {
            listText += `🔹 *#${r.id}* — ${r.text}\n   ⏱️ Sisa: ${formatRemaining(r.remainingMs)}\n\n`;
        }
        listText += `_Ketik .hapusreminder [id] untuk membatalkan_`;

        await sock.sendMessage(jid, { text: listText }, { quoted: msg });
    }

    // ═══ HAPUS REMINDER ═══
    if (caption && caption.toLowerCase().startsWith('.hapusreminder')) {
        const idStr = caption.slice(14).trim();
        const id = parseInt(idStr);

        if (!idStr || isNaN(id)) {
            await sock.sendMessage(jid, {
                text: '❌ Masukkan ID reminder!\n\nContoh: *.hapusreminder 1*\nKetik *.listreminder* untuk melihat daftar.'
            }, { quoted: msg });
            return;
        }

        const success = cancelReminder(id);
        if (success) {
            await sock.sendMessage(jid, {
                text: `✅ Pengingat *#${id}* berhasil dibatalkan.`
            }, { quoted: msg });
        } else {
            await sock.sendMessage(jid, {
                text: `❌ Pengingat *#${id}* tidak ditemukan atau sudah selesai.`
            }, { quoted: msg });
        }
    }

    // ═══ TEXT TO SPEECH (ElevenLabs) ═══
    if (caption && caption.toLowerCase().startsWith('.tts')) {
        const ttsText = caption.slice(4).trim();

        if (!ttsText) {
            await sock.sendMessage(jid, {
                text: '❌ Masukkan teks!\n\n*Cara pakai:*\n.tts Halo selamat pagi\n.tts Apa kabar hari ini?\n\n_Maks 1000 karakter_'
            }, { quoted: msg });
            return;
        }

        log.chat(jid, 'TTS', `"${ttsText.substring(0, 40)}..."`);
        await sock.sendMessage(jid, { react: { text: '⏳', key: msg.key } });

        try {
            const audioBuffer = await textToSpeech(ttsText);
            await sock.sendMessage(jid, {
                audio: audioBuffer,
                mimetype: 'audio/ogg; codecs=opus',
                ptt: true
            }, { quoted: msg });
            await sock.sendMessage(jid, { react: { text: '✅', key: msg.key } });
            log.done(jid, 'TTS dikirim');
        } catch (err) {
            log.fail(jid, 'TTS gagal', err.message);
            await sock.sendMessage(jid, { react: { text: '❌', key: msg.key } });
            await sock.sendMessage(jid, {
                text: `❌ ${err.message}`
            }, { quoted: msg });
        }
    }

    // ═══ DOWNLOAD MEDIA (VIDEO) ═══
    if (caption && caption.toLowerCase().startsWith('.dl')) {
        const url = caption.slice(3).trim();

        if (!url) {
            await sock.sendMessage(jid, {
                text: '❌ Masukkan URL!\n\n*Cara pakai:*\n.dl [url] → download video\n.mp3 [url] → download audio\n\n*Platform:* YouTube, Instagram,\nTikTok, Facebook, Twitter/X'
            }, { quoted: msg });
            return;
        }

        const platform = detectPlatform(url);
        if (!platform) {
            await sock.sendMessage(jid, {
                text: '❌ URL tidak didukung!\n\n*Platform yang didukung:*\nYouTube, Instagram, TikTok,\nFacebook, Twitter/X'
            }, { quoted: msg });
            return;
        }

        log.chat(jid, `Download video [${platform}]`, url.substring(0, 50));
        await sock.sendMessage(jid, { react: { text: '⬇️', key: msg.key } });
        await sock.sendMessage(jid, {
            text: `⏳ Sedang mendownload video dari *${platform}*...\n_Harap tunggu, ini bisa memakan waktu._`
        }, { quoted: msg });

        try {
            const result = await downloadMedia(url, 'video');
            const ext = result.ext;

            if (['mp4', 'webm', 'mkv', 'mov'].includes(ext)) {
                await sock.sendMessage(jid, {
                    video: result.buffer,
                    caption: `*${result.title}*\nDurasi: ${formatDuration(result.duration)} | ${platform}`,
                    mimetype: 'video/mp4'
                }, { quoted: msg });
            } else if (['jpg', 'jpeg', 'png', 'webp'].includes(ext)) {
                await sock.sendMessage(jid, {
                    image: result.buffer,
                    caption: `*${result.title}*\n${platform}`,
                    mimetype: `image/${ext === 'jpg' ? 'jpeg' : ext}`
                }, { quoted: msg });
            } else {
                await sock.sendMessage(jid, {
                    document: result.buffer,
                    fileName: result.filename,
                    mimetype: 'application/octet-stream',
                    caption: `*${result.title}* | ${platform}`
                }, { quoted: msg });
            }

            await sock.sendMessage(jid, { react: { text: '✅', key: msg.key } });
            log.done(jid, `Video [${platform}] dikirim`);
        } catch (err) {
            log.fail(jid, 'Download gagal', err.message);
            await sock.sendMessage(jid, { react: { text: '❌', key: msg.key } });
            await sock.sendMessage(jid, {
                text: `❌ ${err.message}`
            }, { quoted: msg });
        }
    }

    // ═══ DOWNLOAD MEDIA (AUDIO/MP3) ═══
    if (caption && caption.toLowerCase().startsWith('.mp3')) {
        const url = caption.slice(4).trim();

        if (!url) {
            await sock.sendMessage(jid, {
                text: '❌ Masukkan URL!\n\nContoh: *.mp3 https://youtube.com/watch?v=xxx*'
            }, { quoted: msg });
            return;
        }

        const platform = detectPlatform(url);
        if (!platform) {
            await sock.sendMessage(jid, {
                text: '❌ URL tidak didukung!'
            }, { quoted: msg });
            return;
        }

        log.chat(jid, `Download audio [${platform}]`, url.substring(0, 50));
        await sock.sendMessage(jid, { react: { text: '🎵', key: msg.key } });
        await sock.sendMessage(jid, {
            text: `⏳ Sedang mendownload audio dari *${platform}*...`
        }, { quoted: msg });

        try {
            const result = await downloadMedia(url, 'audio');
            await sock.sendMessage(jid, {
                audio: result.buffer,
                mimetype: 'audio/mpeg',
                ptt: false, // kirim sebagai audio, bukan voice note
                fileName: `${result.title}.mp3`
            }, { quoted: msg });

            await sock.sendMessage(jid, { react: { text: '✅', key: msg.key } });
            log.done(jid, `Audio [${platform}] dikirim`);
        } catch (err) {
            log.fail(jid, 'Download audio gagal', err.message);
            await sock.sendMessage(jid, { react: { text: '❌', key: msg.key } });
            await sock.sendMessage(jid, {
                text: `❌ ${err.message}`
            }, { quoted: msg });
        }
    }

    // ═══ AI CHAT (Cappie / Gemini) ═══
    if (caption && caption.toLowerCase().startsWith('.ai')) {
        const userMsg = caption.slice(3).trim();

        if (!userMsg) {
            await sock.sendMessage(jid, {
                text: '❌ Tulis pesannya dong~\n\nContoh: *.ai Halo Cappie!*\n\nKetik *.resetai* untuk reset percakapan.'
            }, { quoted: msg });
            return;
        }

        log.chat(jid, 'AI chat', `"${userMsg.substring(0, 40)}..."`);
        await sock.sendMessage(jid, { react: { text: '💋', key: msg.key } });

        try {
            const reply = await geminiChat(jid, userMsg);
            await sock.sendMessage(jid, { text: reply }, { quoted: msg });
            await sock.sendMessage(jid, { react: { text: '💕', key: msg.key } });
            log.done(jid, 'AI reply dikirim');
        } catch (err) {
            log.fail(jid, 'AI gagal', err.message);
            await sock.sendMessage(jid, { react: { text: '❌', key: msg.key } });
            await sock.sendMessage(jid, {
                text: `❌ ${err.message}`
            }, { quoted: msg });
        }
    }

    // ═══ RESET AI CHAT ═══
    if (caption && caption.toLowerCase() === '.resetai') {
        geminiReset(jid);
        await sock.sendMessage(jid, {
            text: '✅ Riwayat chat AI direset~ Cappie sudah lupa semuanya! (≧◡≦)'
        }, { quoted: msg });
    }

    // Menu / help command
    if (caption && (caption.toLowerCase() === '.menu' || caption.toLowerCase() === '.help')) {
        const menuText = `┌─────────────────────────┐
│      *CHATBOT VA*       │
└─────────────────────────┘

*Stiker*
  .stiker / .sticker
  Kirim gambar atau video
  (maks 5 detik) dengan
  caption ini.

*Cuaca*
  .cuaca [kota]
  Contoh: .cuaca Jakarta

*QR Code*
  .qr [teks/url]
  Contoh: .qr https://google.com

*Reminder*
  .ingatkan [durasi] [pesan]
  .listreminder
  .hapusreminder [id]
  Contoh: .ingatkan 30m Makan

*Text-to-Speech*
  .tts [teks]
  Contoh: .tts Halo selamat pagi

*Download Media*
  .dl [url]  — download video
  .mp3 [url] — download audio
  Support: YT, IG, TT, FB, X

*AI Chat*
  .ai [pesan]
  .resetai — reset riwayat

*Lainnya*
  .menu / .help

─────────────────────────
           Copyright VA 2026`;

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