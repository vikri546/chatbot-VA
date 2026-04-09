const makeWASocket = require('@whiskeysockets/baileys').default;
const { 
    useMultiFileAuthState, 
    DisconnectReason, 
    downloadMediaMessage,
    downloadContentFromMessage,
    Browsers,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const { createSticker, createGifSticker, stickerToImage, changeStickerAuthor } = require('./lib/sticker');
const { getWeather } = require('./lib/weather');
const { generateQR } = require('./lib/qrcode');
const { parseDuration, setReminder, cancelReminder, getReminders, formatRemaining } = require('./lib/reminder');
const { textToSpeech } = require('./lib/tts');
const { downloadMedia, downloadImage, detectPlatform, formatDuration } = require('./lib/downloader');
const { chat: geminiChat, resetChat: geminiReset, setCustomPrompt, clearCustomPrompt, analyzeImage: geminiAnalyzeImage, analyzeWebsite: geminiAnalyzeWebsite } = require('./lib/gemini');
const { CHARACTERS, searchCharacter, getAllCharacters, getCharacterByIndex, setPending, getPending, clearPending, setUserPersonality, getUserPersonality, resetUserPersonality } = require('./lib/personality');
const log = require('./lib/logger');

// ══════════════════════════════════════════════
//  WhatsApp Chatbot VA - Mode Nomor HP
//  Optimized for Termux (Anti Timeout)
// ══════════════════════════════════════════════

const logger = pino({ level: 'silent' });

const autoStickerUsers = new Map();
const AUTH_DIR = 'auth_info';
const SESSION_FILE = path.join(AUTH_DIR, '.session_created');
const SESSION_MAX_AGE = 30 * 24 * 60 * 60 * 1000;

// ─── ASCII Design Tokens ───────────────────────────────────────
const D = {
    LINE  : '─────────────────────────────',
    THIN  : '·····························',
    TOP   : '┌─────────────────────────────┐',
    BOT   : '└─────────────────────────────┘',
    FTOP  : '╔═════════════════════════════╗',
    FBOT  : '╚═════════════════════════════╝',
    FMID  : '╠═════════════════════════════╣',
    ok    : '[+]',
    err   : '[!]',
    warn  : '[~]',
    proc  : '[..]',
    arrow : '>>',
    dot   : ' ·',
};

// ─── Message Builders ──────────────────────────────────────────

/** Header kotak penuh */
function header(title) {
    const pad = Math.max(0, 29 - title.length);
    const left  = Math.floor(pad / 2);
    const right = pad - left;
    return (
        `╔═════════════════════════════╗\n` +
        `║${' '.repeat(left)}${title}${' '.repeat(right)}║\n` +
        `╚═════════════════════════════╝`
    );
}

/** Section label kecil */
function section(label) {
    return `┌─ ${label} ${'─'.repeat(Math.max(0, 26 - label.length))}`;
}

function checkSessionExpiry() {
    if (!fs.existsSync(SESSION_FILE)) return;
    try {
        const created = parseInt(fs.readFileSync(SESSION_FILE, 'utf-8').trim());
        if (Date.now() - created >= SESSION_MAX_AGE) {
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
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(query, (answer) => { rl.close(); resolve(answer.trim()); });
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

    const { version, isLatest } = await fetchLatestBaileysVersion();
    log.info(`WA Web v${version.join('.')} (latest: ${isLatest})`);

    const sock = makeWASocket({
        version,
        auth: state,
        logger: logger,
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome'),
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

    if (phoneNumber && !sock.authState.creds.registered) {
        log.sys('Menghubungkan ke server WhatsApp...');
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

// ══════════════════════════════════════════════════════════════
//  HANDLE MESSAGE
// ══════════════════════════════════════════════════════════════

async function handleMessage(sock, msg) {
    const jid = msg.key.remoteJid;
    const messageType = Object.keys(msg.message)[0];
    const caption = getCaption(msg);

    const contextInfo = msg.message?.extendedTextMessage?.contextInfo
                     || msg.message?.imageMessage?.contextInfo
                     || msg.message?.videoMessage?.contextInfo
                     || null;
    const quotedMsg  = contextInfo?.quotedMessage || null;
    const quotedType = quotedMsg ? Object.keys(quotedMsg)[0] : null;

    const isDirectImage  = messageType === 'imageMessage';
    const isDirectVideo  = messageType === 'videoMessage';
    const isQuotedImage  = quotedType  === 'imageMessage';
    const isQuotedVideo  = quotedType  === 'videoMessage';
    const hasImage       = isDirectImage || isQuotedImage;
    const hasVideo       = isDirectVideo || isQuotedVideo;
    const isQuotedSticker = quotedType  === 'stickerMessage';

    const isStickerCommand = caption &&
        (caption.toLowerCase() === '.stiker' || caption.toLowerCase() === '.sticker');

    async function getMediaBuffer(type) {
        if (type === 'image') {
            if (isDirectImage) return await downloadMediaMessage(msg, 'buffer', {});
            if (isQuotedImage) return await downloadQuotedMedia(quotedMsg.imageMessage, 'image');
        }
        if (type === 'video') {
            if (isDirectVideo) return await downloadMediaMessage(msg, 'buffer', {});
            if (isQuotedVideo) return await downloadQuotedMedia(quotedMsg.videoMessage, 'video');
        }
        return null;
    }

    // ─── STIKER TO IMAGE ──────────────────────────────────────
    if (caption && caption.toLowerCase() === '.toimg' && isQuotedSticker) {
        log.chat(jid, 'Stiker to Image');
        await sock.sendMessage(jid, { react: { text: '⏳', key: msg.key } });
        try {
            const stickerBuffer = await downloadQuotedMedia(quotedMsg.stickerMessage, 'sticker');
            const imageBuffer   = await stickerToImage(stickerBuffer);
            await sock.sendMessage(jid, { image: imageBuffer, mimetype: 'image/png' }, { quoted: msg });
            await sock.sendMessage(jid, { react: { text: '✅', key: msg.key } });
            log.done(jid, 'Stiker to Image dikirim');
        } catch (err) {
            log.fail(jid, 'Stiker to Image gagal', err.message);
            await sock.sendMessage(jid, { react: { text: '❌', key: msg.key } });
            await sock.sendMessage(jid, {
                text: `${D.err} Gagal convert stiker ke gambar.\n\nPastikan stiker valid lalu coba lagi.`
            }, { quoted: msg });
        }
        return;
    }

    // ─── CHANGE AUTHOR ────────────────────────────────────────
    if (caption && caption.toLowerCase().startsWith('.author') && isQuotedSticker) {
        const newAuthor = caption.slice(7).trim();
        if (!newAuthor) {
            await sock.sendMessage(jid, {
                text: `${D.err} Nama author tidak boleh kosong.\n\n${D.arrow} .author [nama]\n   Contoh: .author Nama Kamu`
            }, { quoted: msg });
            return;
        }
        log.chat(jid, 'Change Author', newAuthor);
        await sock.sendMessage(jid, { react: { text: '⏳', key: msg.key } });
        try {
            const stickerBuffer = await downloadQuotedMedia(quotedMsg.stickerMessage, 'sticker');
            const newSticker    = await changeStickerAuthor(stickerBuffer, newAuthor);
            await sock.sendMessage(jid, { sticker: newSticker }, { quoted: msg });
            await sock.sendMessage(jid, { react: { text: '✅', key: msg.key } });
            log.done(jid, `Author diganti: ${newAuthor}`);
        } catch (err) {
            log.fail(jid, 'Change Author gagal', err.message);
            await sock.sendMessage(jid, { react: { text: '❌', key: msg.key } });
            await sock.sendMessage(jid, {
                text: `${D.err} Gagal mengubah author stiker.\n\n${err.message}`
            }, { quoted: msg });
        }
        return;
    }

    // ─── AUTOSTICKER ON / OFF ─────────────────────────────────
    if (caption && caption.toLowerCase().startsWith('.autosticker')) {
        const mode = caption.slice(12).trim().toLowerCase();

        if (mode === 'on') {
            autoStickerUsers.set(jid, { count: 0 });
            log.chat(jid, 'Autosticker ON');
            await sock.sendMessage(jid, {
                text: `${D.ok} *Autosticker aktif.*\n\nSetiap gambar yang dikirim akan otomatis dijadikan stiker.\n\n${D.arrow} .autosticker off  — nonaktifkan`
            }, { quoted: msg });
            return;
        }
        if (mode === 'off') {
            const data  = autoStickerUsers.get(jid);
            const total = data?.count || 0;
            autoStickerUsers.delete(jid);
            log.chat(jid, 'Autosticker OFF', `${total} stiker dibuat`);
            await sock.sendMessage(jid, {
                text: `${D.warn} *Autosticker nonaktif.*\n\nTotal stiker dibuat  : ${total}`
            }, { quoted: msg });
            return;
        }

        const status = autoStickerUsers.has(jid) ? 'aktif' : 'nonaktif';
        await sock.sendMessage(jid, {
            text: `Status autosticker  : *${status}*\n\n${D.arrow} .autosticker on   — aktifkan\n${D.arrow} .autosticker off  — nonaktifkan`
        }, { quoted: msg });
        return;
    }

    // ─── AUTOSTICKER: AUTO CONVERT ────────────────────────────
    if (isDirectImage && !caption && autoStickerUsers.has(jid)) {
        const data = autoStickerUsers.get(jid);
        data.count++;
        log.chat(jid, `Autosticker #${data.count}`);
        await sock.sendMessage(jid, { react: { text: '⏳', key: msg.key } });
        try {
            const buffer        = await downloadMediaMessage(msg, 'buffer', {});
            const stickerBuffer = await createSticker(buffer);
            await sock.sendMessage(jid, { sticker: stickerBuffer }, { quoted: msg });
            await sock.sendMessage(jid, { react: { text: '✅', key: msg.key } });
            log.done(jid, `Autosticker #${data.count} dikirim`);
        } catch (err) {
            log.fail(jid, 'Autosticker gagal', err.message);
            await sock.sendMessage(jid, { react: { text: '❌', key: msg.key } });
        }
        return;
    }

    // ─── STIKER GAMBAR ────────────────────────────────────────
    if (hasImage && isStickerCommand) {
        log.chat(jid, 'Stiker gambar', isQuotedImage ? 'via reply' : 'langsung');
        await sock.sendMessage(jid, { react: { text: '⏳', key: msg.key } });
        try {
            const buffer        = await getMediaBuffer('image');
            const stickerBuffer = await createSticker(buffer);
            await sock.sendMessage(jid, { sticker: stickerBuffer }, { quoted: msg });
            await sock.sendMessage(jid, { react: { text: '✅', key: msg.key } });
            log.done(jid, 'Stiker gambar dikirim');
        } catch (err) {
            log.fail(jid, 'Stiker gambar gagal', err.message);
            await sock.sendMessage(jid, { react: { text: '❌', key: msg.key } });
            await sock.sendMessage(jid, {
                text: `${D.err} Gagal membuat stiker.\n\nPastikan gambar valid lalu coba lagi.`
            }, { quoted: msg });
        }
    }

    // ─── GIF STIKER ───────────────────────────────────────────
    if (hasVideo && isStickerCommand) {
        const videoDuration = isDirectVideo
            ? (msg.message.videoMessage?.seconds || 0)
            : (quotedMsg?.videoMessage?.seconds || 0);
        log.chat(jid, 'GIF stiker', `${videoDuration}s${isQuotedVideo ? ' via reply' : ''}`);

        if (videoDuration > 5) {
            await sock.sendMessage(jid, { react: { text: '❌', key: msg.key } });
            await sock.sendMessage(jid, {
                text: `${D.err} Video terlalu panjang.\n\nMaksimal *5 detik* untuk GIF stiker.\nDurasi video kamu  : ${videoDuration} detik`
            }, { quoted: msg });
            return;
        }

        await sock.sendMessage(jid, { react: { text: '⏳', key: msg.key } });
        try {
            const buffer        = await getMediaBuffer('video');
            const stickerBuffer = await createGifSticker(buffer);
            await sock.sendMessage(jid, { sticker: stickerBuffer }, { quoted: msg });
            await sock.sendMessage(jid, { react: { text: '✅', key: msg.key } });
            log.done(jid, 'GIF stiker dikirim');
        } catch (err) {
            log.fail(jid, 'GIF stiker gagal', err.message);
            await sock.sendMessage(jid, { react: { text: '❌', key: msg.key } });
            await sock.sendMessage(jid, {
                text: `${D.err} Gagal membuat GIF stiker.\n\n${err.message}`
            }, { quoted: msg });
        }
    }

    // ─── CUACA ────────────────────────────────────────────────
    if (caption && caption.toLowerCase().startsWith('.cuaca')) {
        const city = caption.slice(6).trim();
        if (!city) {
            await sock.sendMessage(jid, {
                text: `${D.err} Nama kota tidak boleh kosong.\n\n${D.arrow} .cuaca [kota]\n   Contoh: .cuaca Jakarta`
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
            await sock.sendMessage(jid, { text: `${D.err} ${err.message}` }, { quoted: msg });
        }
    }

    // ─── QR CODE ──────────────────────────────────────────────
    if (caption && caption.toLowerCase().startsWith('.qr')) {
        const text = caption.slice(3).trim();
        if (!text) {
            await sock.sendMessage(jid, {
                text: `${D.err} Teks tidak boleh kosong.\n\n${D.arrow} .qr [teks / url]\n   Contoh: .qr https://google.com`
            }, { quoted: msg });
            return;
        }
        log.chat(jid, 'QR code');
        await sock.sendMessage(jid, { react: { text: '⏳', key: msg.key } });
        try {
            const qrBuffer = await generateQR(text);
            await sock.sendMessage(jid, {
                image: qrBuffer,
                caption: `QR CODE\n${D.LINE}\nIsi  : ${text}\n\nCopyright VA 2026`
            }, { quoted: msg });
            await sock.sendMessage(jid, { react: { text: '✅', key: msg.key } });
            log.done(jid, 'QR code dikirim');
        } catch (err) {
            log.fail(jid, 'QR code gagal', err.message);
            await sock.sendMessage(jid, { react: { text: '❌', key: msg.key } });
            await sock.sendMessage(jid, { text: `${D.err} Gagal membuat QR code. Coba lagi.` }, { quoted: msg });
        }
    }

    // ─── REMINDER ─────────────────────────────────────────────
    if (caption && (caption.toLowerCase().startsWith('.ingatkan') || caption.toLowerCase().startsWith('.reminder'))) {
        const prefix   = caption.toLowerCase().startsWith('.ingatkan') ? '.ingatkan' : '.reminder';
        const args     = caption.slice(prefix.length).trim();
        const spaceIdx = args.indexOf(' ');

        if (!args || spaceIdx === -1) {
            await sock.sendMessage(jid, {
                text: [
                    `${D.err} Format tidak valid.`,
                    ``,
                    `${D.arrow} .ingatkan [durasi] [pesan]`,
                    ``,
                    `   Contoh`,
                    `   .ingatkan 30m  Minum obat`,
                    `   .ingatkan 2j   Meeting kantor`,
                    `   .ingatkan 10d  Cek oven`,
                    ``,
                    `   d = detik  |  m = menit  |  j = jam`
                ].join('\n')
            }, { quoted: msg });
            return;
        }

        const durationStr  = args.slice(0, spaceIdx);
        const reminderText = args.slice(spaceIdx + 1).trim();
        const parsed       = parseDuration(durationStr);

        if (!parsed) {
            await sock.sendMessage(jid, {
                text: `${D.err} Format durasi tidak valid.\n\nGunakan: *30d* (detik)  *30m* (menit)  *2j* (jam)\nMaksimal 24 jam.`
            }, { quoted: msg });
            return;
        }
        if (!reminderText) {
            await sock.sendMessage(jid, {
                text: `${D.err} Pesan pengingat tidak boleh kosong.\n\n${D.arrow} .ingatkan 30m Minum obat`
            }, { quoted: msg });
            return;
        }

        const id = setReminder(jid, parsed.ms, reminderText, async (targetJid, text, remId) => {
            await sock.sendMessage(targetJid, {
                text: [
                    `PENGINGAT`,
                    D.LINE,
                    `${D.dot} ID     #${remId}`,
                    `${D.dot} Pesan  ${text}`,
                    ``,
                    `Copyright VA 2026`
                ].join('\n')
            });
            log.done(targetJid, `Reminder #${remId} terkirim`);
        });

        await sock.sendMessage(jid, {
            text: [
                `${D.ok} *Pengingat berhasil diset.*`,
                ``,
                `${D.dot} ID     : #${id}`,
                `${D.dot} Pesan  : ${reminderText}`,
                `${D.dot} Dalam  : ${parsed.label}`,
                ``,
                `${D.arrow} .listreminder         lihat daftar`,
                `${D.arrow} .hapusreminder ${id}   batalkan`
            ].join('\n')
        }, { quoted: msg });

        log.chat(jid, `Reminder #${id}`, `"${reminderText}" dalam ${parsed.label}`);
    }

    // ─── LIST REMINDER ────────────────────────────────────────
    if (caption && caption.toLowerCase() === '.listreminder') {
        const reminders = getReminders(jid);
        if (reminders.length === 0) {
            await sock.sendMessage(jid, {
                text: `${D.warn} Tidak ada pengingat aktif.`
            }, { quoted: msg });
            return;
        }
        const lines = [
            `PENGINGAT AKTIF`,
            D.LINE
        ];
        for (const r of reminders) {
            lines.push(`${D.dot} #${r.id}  ${r.text}`);
            lines.push(`       sisa  ${formatRemaining(r.remainingMs)}`);
        }
        lines.push('');
        lines.push(`${D.arrow} .hapusreminder [id]  batalkan`);
        await sock.sendMessage(jid, { text: lines.join('\n') }, { quoted: msg });
    }

    // ─── HAPUS REMINDER ───────────────────────────────────────
    if (caption && caption.toLowerCase().startsWith('.hapusreminder')) {
        const idStr = caption.slice(14).trim();
        const id    = parseInt(idStr);
        if (!idStr || isNaN(id)) {
            await sock.sendMessage(jid, {
                text: `${D.err} Masukkan ID reminder.\n\n${D.arrow} .hapusreminder [id]\n${D.arrow} .listreminder  lihat daftar`
            }, { quoted: msg });
            return;
        }
        const success = cancelReminder(id);
        await sock.sendMessage(jid, {
            text: success
                ? `${D.ok} Pengingat *#${id}* berhasil dibatalkan.`
                : `${D.err} Pengingat *#${id}* tidak ditemukan atau sudah selesai.`
        }, { quoted: msg });
    }

    // ─── TEXT TO SPEECH ───────────────────────────────────────
    if (caption && caption.toLowerCase().startsWith('.tts')) {
        const ttsText = caption.slice(4).trim();
        if (!ttsText) {
            await sock.sendMessage(jid, {
                text: [
                    `${D.err} Teks tidak boleh kosong.`,
                    ``,
                    `${D.arrow} .tts [teks]`,
                    `   Contoh: .tts Halo selamat pagi`,
                    ``,
                    `   Maks 1000 karakter`
                ].join('\n')
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
            await sock.sendMessage(jid, { text: `${D.err} ${err.message}` }, { quoted: msg });
        }
    }

    // ─── DOWNLOAD VIDEO ───────────────────────────────────────
    if (caption && caption.toLowerCase().startsWith('.dl')) {
        const url = caption.slice(3).trim();
        if (!url) {
            await sock.sendMessage(jid, {
                text: [
                    `${D.err} URL tidak boleh kosong.`,
                    ``,
                    `${D.arrow} .dl  [url]   download video`,
                    `${D.arrow} .mp3 [url]   download audio`,
                    ``,
                    `   Platform: YouTube  Instagram  TikTok  Facebook  X`
                ].join('\n')
            }, { quoted: msg });
            return;
        }
        const platform = detectPlatform(url);
        if (!platform) {
            await sock.sendMessage(jid, {
                text: `${D.err} URL tidak didukung.\n\nPlatform: YouTube  Instagram  TikTok  Facebook  X`
            }, { quoted: msg });
            return;
        }
        log.chat(jid, `Download video [${platform}]`, url.substring(0, 50));
        await sock.sendMessage(jid, { react: { text: '⬇️', key: msg.key } });
        await sock.sendMessage(jid, {
            text: `${D.proc} Mendownload dari *${platform}*...\n\nMohon tunggu, proses ini bisa memakan waktu.`
        }, { quoted: msg });
        try {
            const result = await downloadMedia(url, 'video');
            const ext    = result.ext;
            if (['mp4', 'webm', 'mkv', 'mov'].includes(ext)) {
                await sock.sendMessage(jid, {
                    video: result.buffer,
                    caption: `${result.title}\n${D.LINE}\nDurasi : ${formatDuration(result.duration)}\nSumber : ${platform}`,
                    mimetype: 'video/mp4'
                }, { quoted: msg });
            } else if (['jpg', 'jpeg', 'png', 'webp'].includes(ext)) {
                await sock.sendMessage(jid, {
                    image: result.buffer,
                    caption: `${result.title}\n${platform}`,
                    mimetype: `image/${ext === 'jpg' ? 'jpeg' : ext}`
                }, { quoted: msg });
            } else {
                await sock.sendMessage(jid, {
                    document: result.buffer,
                    fileName: result.filename,
                    mimetype: 'application/octet-stream',
                    caption: `${result.title}  |  ${platform}`
                }, { quoted: msg });
            }
            await sock.sendMessage(jid, { react: { text: '✅', key: msg.key } });
            log.done(jid, `Video [${platform}] dikirim`);
        } catch (err) {
            log.fail(jid, 'Download gagal', err.message);
            await sock.sendMessage(jid, { react: { text: '❌', key: msg.key } });
            await sock.sendMessage(jid, { text: `${D.err} ${err.message}` }, { quoted: msg });
        }
    }

    // ─── DOWNLOAD AUDIO ───────────────────────────────────────
    if (caption && caption.toLowerCase().startsWith('.mp3')) {
        const url = caption.slice(4).trim();
        if (!url) {
            await sock.sendMessage(jid, {
                text: `${D.err} URL tidak boleh kosong.\n\n${D.arrow} .mp3 [url]\n   Contoh: .mp3 https://youtube.com/watch?v=xxx`
            }, { quoted: msg });
            return;
        }
        const platform = detectPlatform(url);
        if (!platform) {
            await sock.sendMessage(jid, { text: `${D.err} URL tidak didukung.` }, { quoted: msg });
            return;
        }
        log.chat(jid, `Download audio [${platform}]`, url.substring(0, 50));
        await sock.sendMessage(jid, { react: { text: '🎵', key: msg.key } });
        await sock.sendMessage(jid, {
            text: `${D.proc} Mendownload audio dari *${platform}*...`
        }, { quoted: msg });
        try {
            const result = await downloadMedia(url, 'audio');
            await sock.sendMessage(jid, {
                audio: result.buffer,
                mimetype: 'audio/mpeg',
                ptt: false,
                fileName: `${result.title}.mp3`
            }, { quoted: msg });
            await sock.sendMessage(jid, { react: { text: '✅', key: msg.key } });
            log.done(jid, `Audio [${platform}] dikirim`);
        } catch (err) {
            log.fail(jid, 'Download audio gagal', err.message);
            await sock.sendMessage(jid, { react: { text: '❌', key: msg.key } });
            await sock.sendMessage(jid, { text: `${D.err} ${err.message}` }, { quoted: msg });
        }
    }

    // ─── DOWNLOAD GAMBAR ──────────────────────────────────────
    if (caption && caption.toLowerCase().startsWith('.jpg')) {
        const url = caption.slice(4).trim();
        if (!url) {
            await sock.sendMessage(jid, {
                text: `${D.err} URL tidak boleh kosong.\n\n${D.arrow} .jpg [url]\n   Download gambar dari YT  IG  TT  FB  X`
            }, { quoted: msg });
            return;
        }
        const platform = detectPlatform(url);
        if (!platform) {
            await sock.sendMessage(jid, { text: `${D.err} URL tidak didukung.` }, { quoted: msg });
            return;
        }
        log.chat(jid, `Download gambar [${platform}]`, url.substring(0, 50));
        await sock.sendMessage(jid, { react: { text: '⏳', key: msg.key } });
        try {
            const result = await downloadImage(url);
            await sock.sendMessage(jid, {
                image: result.buffer,
                caption: `${result.title}\n${platform}`,
                mimetype: 'image/jpeg'
            }, { quoted: msg });
            await sock.sendMessage(jid, { react: { text: '✅', key: msg.key } });
            log.done(jid, `Gambar [${platform}] dikirim`);
        } catch (err) {
            log.fail(jid, 'Download gambar gagal', err.message);
            await sock.sendMessage(jid, { react: { text: '❌', key: msg.key } });
            await sock.sendMessage(jid, { text: `${D.err} ${err.message}` }, { quoted: msg });
        }
    }

    // ─── PERSONALITY: PENDING PILIHAN ────────────────────────
    const pending = getPending(jid);
    if (pending && caption && /^\d+$/.test(caption.trim())) {
        const choice  = parseInt(caption.trim());
        const results = pending.results;

        if (choice < 1 || choice > results.length) {
            await sock.sendMessage(jid, {
                text: `${D.err} Pilihan tidak valid. Masukkan angka 1 - ${results.length}`
            }, { quoted: msg });
            return;
        }

        const selected    = results[choice - 1];
        clearPending(jid);

        const oldPersonality = getUserPersonality(jid);
        const oldName        = oldPersonality ? oldPersonality.name : 'Mita (Default)';

        setUserPersonality(jid, selected.name, selected.series, selected.prompt, selected.id);
        setCustomPrompt(jid, selected.prompt);

        log.done(jid, `Personality: ${selected.name}`);
        await sock.sendMessage(jid, {
            text: [
                `${D.ok} *Personality berhasil diganti.*`,
                ``,
                `${D.dot} Dari  : ${oldName}`,
                `${D.dot} Ke    : ${selected.name}  (${selected.series})`,
                ``,
                selected.desc,
                ``,
                `${D.arrow} .personality reset  kembali ke Mita`
            ].join('\n')
        }, { quoted: msg });
        return;
    }

    // ─── PERSONALITY COMMAND ──────────────────────────────────
    if (caption && caption.toLowerCase().startsWith('.personality')) {
        const arg = caption.slice(12).trim();

        // Reset
        if (arg.toLowerCase() === 'reset') {
            const old = getUserPersonality(jid);
            resetUserPersonality(jid);
            clearCustomPrompt(jid);
            clearPending(jid);
            log.chat(jid, 'Personality reset');
            await sock.sendMessage(jid, {
                text: `${D.ok} *Personality direset ke Mita (Default).*` +
                      (old ? `\n\nSebelumnya  : ${old.name}` : '')
            }, { quoted: msg });
            return;
        }

        // Tampilkan daftar (tanpa argumen)
        if (!arg) {
            const current     = getUserPersonality(jid);
            const currentName = current ? `${current.name}  (${current.series})` : 'Mita (Default)';
            const all         = getAllCharacters();
            const lines = [
                `PERSONALITY`,
                D.LINE,
                `Aktif saat ini  : *${currentName}*`,
                ``,
                `DAFTAR KARAKTER MISIDE`
            ];
            all.forEach((c, i) => {
                const mark = (current && current.name === c.name) || (!current && i === 0) ? '  <' : '';
                lines.push(`${D.dot} ${i + 1}.  ${c.name}${mark}`);
                lines.push(`       ${c.desc}`);
            });
            lines.push('');
            lines.push(`${D.arrow} .personality [nama / nomor]  ganti`);
            lines.push(`${D.arrow} .personality reset           default`);
            await sock.sendMessage(jid, { text: lines.join('\n') }, { quoted: msg });
            return;
        }

        // Pilih berdasarkan nomor
        if (/^\d+$/.test(arg)) {
            const choice = parseInt(arg);
            const all    = getAllCharacters();
            if (choice < 1 || choice > all.length) {
                await sock.sendMessage(jid, {
                    text: `${D.err} Nomor tidak valid.\n\n${D.arrow} .personality  lihat daftar karakter`
                }, { quoted: msg });
                return;
            }
            const selected   = all[choice - 1];
            const oldP       = getUserPersonality(jid);
            const oldName    = oldP ? oldP.name : 'Mita (Default)';
            setUserPersonality(jid, selected.name, selected.series, selected.prompt, selected.id);
            setCustomPrompt(jid, selected.prompt);
            log.done(jid, `Personality: ${selected.name}`);
            await sock.sendMessage(jid, {
                text: [
                    `${D.ok} *Personality berhasil diganti.*`,
                    ``,
                    `${D.dot} Dari  : ${oldName}`,
                    `${D.dot} Ke    : ${selected.name}  (${selected.series})`,
                    ``,
                    selected.desc,
                    ``,
                    `${D.arrow} .personality reset  kembali ke Mita`
                ].join('\n')
            }, { quoted: msg });
            return;
        }

        // Cari berdasarkan nama
        log.chat(jid, 'Personality search', arg);
        const results = searchCharacter(arg);

        if (results.length === 0) {
            const all   = getAllCharacters();
            const lines = [`${D.err} Karakter *${arg}* tidak ditemukan.`, ``, `TERSEDIA`];
            all.forEach((c, i) => { lines.push(`${D.dot} ${i + 1}.  ${c.name}  (${c.series})`); });
            await sock.sendMessage(jid, { text: lines.join('\n') }, { quoted: msg });
            return;
        }

        // 1 hasil — langsung ganti
        if (results.length === 1) {
            const selected = results[0];
            const oldP     = getUserPersonality(jid);
            const oldName  = oldP ? oldP.name : 'Mita (Default)';
            setUserPersonality(jid, selected.name, selected.series, selected.prompt, selected.id);
            setCustomPrompt(jid, selected.prompt);
            log.done(jid, `Personality: ${selected.name}`);
            await sock.sendMessage(jid, {
                text: [
                    `${D.ok} *Personality berhasil diganti.*`,
                    ``,
                    `${D.dot} Dari  : ${oldName}`,
                    `${D.dot} Ke    : ${selected.name}  (${selected.series})`,
                    ``,
                    selected.desc,
                    ``,
                    `${D.arrow} .personality reset  kembali ke Mita`
                ].join('\n')
            }, { quoted: msg });
            return;
        }

        // Beberapa hasil — tampilkan pilihan
        setPending(jid, results);
        const lines = [`Ditemukan *${results.length}* karakter untuk "${arg}"`, D.LINE];
        results.forEach((r, i) => {
            lines.push(`${D.dot} ${i + 1}.  ${r.name}  (${r.series})`);
            lines.push(`       ${r.desc}`);
        });
        lines.push('');
        lines.push(`Ketik angkanya untuk memilih  —  berlaku 2 menit`);
        await sock.sendMessage(jid, { text: lines.join('\n') }, { quoted: msg });
        log.done(jid, `Personality: ${results.length} hasil`);
        return;
    }

    // ─── AI CHAT ──────────────────────────────────────────────
    if (caption && caption.toLowerCase().startsWith('.ai')) {
        const userMsg = caption.slice(3).trim();
        if (!userMsg) {
            await sock.sendMessage(jid, {
                text: [
                    `${D.err} Pesan tidak boleh kosong.`,
                    ``,
                    `${D.arrow} .ai [pesan]`,
                    `   Contoh: .ai Halo Mita!`,
                    ``,
                    `${D.arrow} .resetai  reset riwayat percakapan`
                ].join('\n')
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
            await sock.sendMessage(jid, { text: `${D.err} ${err.message}` }, { quoted: msg });
        }
    }

    // ─── RESET AI ─────────────────────────────────────────────
    if (caption && caption.toLowerCase() === '.resetai') {
        geminiReset(jid);
        await sock.sendMessage(jid, {
            text: `${D.ok} Riwayat percakapan direset. Mita sudah lupa semuanya~`
        }, { quoted: msg });
    }

    // ─── ANALYZE IMAGE ────────────────────────────────────────
    if (caption && caption.toLowerCase().startsWith('.analyzeimg')) {
        const extraPrompt = caption.slice(11).trim();
        if (!hasImage) {
            await sock.sendMessage(jid, {
                text: `${D.err} Tidak ada gambar.\n\nKirim gambar dengan caption *.analyzeimg*\natau reply gambar dengan *.analyzeimg*`
            }, { quoted: msg });
            return;
        }
        log.chat(jid, 'Analyze Image', isQuotedImage ? 'via reply' : 'langsung');
        await sock.sendMessage(jid, { react: { text: '⏳', key: msg.key } });
        try {
            const buffer = await getMediaBuffer('image');
            const result = await geminiAnalyzeImage(jid, buffer, extraPrompt);
            await sock.sendMessage(jid, { text: result }, { quoted: msg });
            await sock.sendMessage(jid, { react: { text: '✅', key: msg.key } });
            log.done(jid, 'Analyze Image dikirim');
        } catch (err) {
            log.fail(jid, 'Analyze Image gagal', err.message);
            await sock.sendMessage(jid, { react: { text: '❌', key: msg.key } });
            await sock.sendMessage(jid, { text: `${D.err} ${err.message}` }, { quoted: msg });
        }
        return;
    }

    // ─── ANALYZE WEBSITE ──────────────────────────────────────
    if (caption && caption.toLowerCase().startsWith('.analyzeweb')) {
        const url = caption.slice(11).trim();
        if (!url) {
            await sock.sendMessage(jid, {
                text: `${D.err} URL tidak boleh kosong.\n\n${D.arrow} .analyzeweb [url]\n   Contoh: .analyzeweb https://google.com`
            }, { quoted: msg });
            return;
        }
        try { new URL(url); } catch {
            await sock.sendMessage(jid, {
                text: `${D.err} URL tidak valid. Pastikan dimulai dengan https://`
            }, { quoted: msg });
            return;
        }
        log.chat(jid, 'Analyze Website', url.substring(0, 50));
        await sock.sendMessage(jid, { react: { text: '⏳', key: msg.key } });
        await sock.sendMessage(jid, {
            text: `${D.proc} Menganalisis *${new URL(url).hostname}*...`
        }, { quoted: msg });
        try {
            const result = await geminiAnalyzeWebsite(jid, url);
            await sock.sendMessage(jid, { text: result }, { quoted: msg });
            await sock.sendMessage(jid, { react: { text: '✅', key: msg.key } });
            log.done(jid, 'Analyze Website dikirim');
        } catch (err) {
            log.fail(jid, 'Analyze Website gagal', err.message);
            await sock.sendMessage(jid, { react: { text: '❌', key: msg.key } });
            await sock.sendMessage(jid, { text: `${D.err} ${err.message}` }, { quoted: msg });
        }
        return;
    }

    // ─── PING / NETWORK ───────────────────────────────────────
    if (caption && caption.toLowerCase() === '.ping') {
        const startTime = Date.now();
        log.chat(jid, 'Ping check');
        await sock.sendMessage(jid, { react: { text: '📡', key: msg.key } });

        const { exec } = require('child_process');

        const [pingResult, networkInfo, uptimeInfo] = await Promise.all([
            new Promise((resolve) => {
                exec('ping -c 3 -W 5 google.com', { timeout: 15000 }, (err, stdout) => {
                    if (err) return resolve({ ok: false, error: 'Tidak dapat terhubung ke internet' });
                    const avgMatch  = stdout.match(/(?:avg|mdev)[^=]*=\s*[\d.]+\/([\d.]+)/);
                    const lossMatch = stdout.match(/([\d.]+)% packet loss/);
                    resolve({
                        ok   : true,
                        avg  : avgMatch  ? parseFloat(avgMatch[1]).toFixed(1) : 'N/A',
                        loss : lossMatch ? lossMatch[1] : '0'
                    });
                });
            }),
            new Promise((resolve) => {
                exec('termux-wifi-connectioninfo 2>/dev/null', { timeout: 5000 }, (err, stdout) => {
                    if (!err && stdout.trim().startsWith('{')) {
                        try {
                            const wifi = JSON.parse(stdout.trim());
                            return resolve({
                                type   : 'WiFi',
                                name   : wifi.ssid || 'Unknown',
                                ip     : wifi.ip || 'N/A',
                                speed  : wifi.link_speed_mbps ? `${wifi.link_speed_mbps} Mbps` : 'N/A',
                                signal : wifi.rssi ? `${wifi.rssi} dBm` : 'N/A',
                                freq   : wifi.frequency_mhz ? `${wifi.frequency_mhz} MHz` : 'N/A'
                            });
                        } catch {}
                    }
                    exec(
                        'ip route get 8.8.8.8 2>/dev/null | head -1 && ip addr show 2>/dev/null | grep "inet " | grep -v 127.0.0',
                        { timeout: 5000 },
                        (err2, stdout2) => {
                            const lines    = (stdout2 || '').trim().split('\n');
                            const devMatch = lines[0]?.match(/dev\s+(\S+)/);
                            const srcMatch = lines[0]?.match(/src\s+([\d.]+)/);
                            const iface    = devMatch ? devMatch[1] : 'unknown';
                            const ip       = srcMatch ? srcMatch[1] : 'N/A';
                            resolve({
                                type   : iface.startsWith('wlan') ? 'WiFi' : 'Data / Ethernet',
                                name   : iface,
                                ip,
                                speed  : 'N/A',
                                signal : 'N/A',
                                freq   : 'N/A'
                            });
                        }
                    );
                });
            }),
            new Promise((resolve) => {
                const mem    = process.memoryUsage();
                const uptime = process.uptime();
                const h = Math.floor(uptime / 3600);
                const m = Math.floor((uptime % 3600) / 60);
                const s = Math.floor(uptime % 60);
                resolve({
                    uptime  : h > 0 ? `${h}j ${m}m ${s}s` : `${m}m ${s}s`,
                    memUsed : (mem.rss / 1024 / 1024).toFixed(1),
                    memHeap : (mem.heapUsed / 1024 / 1024).toFixed(1)
                });
            })
        ]);

        const responseTime = Date.now() - startTime;

        const col = (label, value) => `  ${label.padEnd(12)}${value}`;

        const lines = [
            `NETWORK STATUS`,
            `─────────────────────────────`,
            `KONEKSI`,
            col('Tipe',    networkInfo.type),
            col('Nama',    networkInfo.name),
            col('IP',      networkInfo.ip),
            ...(networkInfo.speed  !== 'N/A' ? [col('Kecepatan', networkInfo.speed)]  : []),
            ...(networkInfo.signal !== 'N/A' ? [col('Sinyal',    networkInfo.signal)] : []),
            ...(networkInfo.freq   !== 'N/A' ? [col('Frekuensi', networkInfo.freq)]   : []),
            ``,
            `LATENCY`,
            ...(pingResult.ok
                ? [col('Google', `${pingResult.avg} ms`), col('Loss', `${pingResult.loss}%`)]
                : [col('Status', pingResult.error)]
            ),
            col('Bot', `${responseTime} ms`),
            ``,
            `SYSTEM`,
            col('Uptime', uptimeInfo.uptime),
            col('RAM',    `${uptimeInfo.memUsed} MB`),
            col('Heap',   `${uptimeInfo.memHeap} MB`),
            `─────────────────────────────`
        ];

        await sock.sendMessage(jid, { text: lines.join('\n') }, { quoted: msg });
        await sock.sendMessage(jid, { react: { text: '✅', key: msg.key } });
        log.done(jid, `Ping: ${pingResult.ok ? pingResult.avg + 'ms' : 'offline'} | Bot: ${responseTime}ms`);
        return;
    }

    // ─── MENU ─────────────────────────────────────────────────
    if (caption && (caption.toLowerCase() === '.menu' || caption.toLowerCase() === '.help')) {
        const menu = [
            `╔═════════════════════════════╗`,
            `║         CHATBOT  VA         ║`,
            `╚═════════════════════════════╝`,
            ``,
            `STIKER`,
            `  >> .stiker / .sticker`,
            `     Kirim / reply gambar atau video`,
            `     (maks 5 detik) lalu ketik perintah.`,
            ``,
            `  >> .autosticker on / off`,
            `     Auto-convert setiap gambar masuk.`,
            ``,
            `  >> .toimg`,
            `     Reply stiker — convert ke gambar.`,
            ``,
            `  >> .author [nama]`,
            `     Reply stiker — ganti nama author.`,
            ``,
            `─────────────────────────────`,
            `UTILITAS`,
            `  >> .cuaca [kota]`,
            `  >> .qr [teks / url]`,
            `  >> .tts [teks]`,
            `  >> .ping`,
            ``,
            `─────────────────────────────`,
            `DOWNLOAD`,
            `  >> .dl  [url]    video`,
            `  >> .mp3 [url]    audio`,
            `  >> .jpg [url]    gambar`,
            `     Platform: YT  IG  TT  FB  X`,
            ``,
            `─────────────────────────────`,
            `REMINDER`,
            `  >> .ingatkan [durasi] [pesan]`,
            `     Contoh: .ingatkan 30m Minum obat`,
            `     d = detik  |  m = menit  |  j = jam`,
            ``,
            `  >> .listreminder`,
            `  >> .hapusreminder [id]`,
            ``,
            `─────────────────────────────`,
            `AI  &  PERSONALITY`,
            `  >> .ai [pesan]`,
            `  >> .resetai`,
            `  >> .personality [nama / nomor]`,
            `  >> .personality reset`,
            ``,
            `─────────────────────────────`,
            `ANALISIS`,
            `  >> .analyzeimg    jelaskan gambar`,
            `  >> .analyzeweb [url]`,
            ``,
            `─────────────────────────────`,
            `                  Copyright VA 2026`
        ].join('\n');

        await sock.sendMessage(jid, {
            image: { url: 'https://d2vrvpw63099lz.cloudfront.net/whatsapp-bots/whatsapp-bots.png' },
            caption: menu,
            mimetype: 'image/png'
        }, { quoted: msg });
    }
}

// ──────────────────────────────────────────────────────────────

async function downloadQuotedMedia(mediaMsg, type) {
    const stream = await downloadContentFromMessage(mediaMsg, type);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
}

function getCaption(msg) {
    if (!msg.message) return '';
    const messageType = Object.keys(msg.message)[0];
    switch (messageType) {
        case 'imageMessage':        return msg.message.imageMessage?.caption || '';
        case 'videoMessage':        return msg.message.videoMessage?.caption || '';
        case 'extendedTextMessage': return msg.message.extendedTextMessage?.text || '';
        case 'conversation':        return msg.message.conversation || '';
        default:                    return '';
    }
}

startBot().catch((err) => {
    console.log(`[!] Fatal error: ${err.message}`);
    process.exit(1);
});