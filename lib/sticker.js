/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║          lib/sticker.js — VA WhatsApp Bot                ║
 * ║                                                          ║
 * ║  Pack   : Mita AI                                        ║
 * ║  Author : VA                                             ║
 * ║                                                          ║
 * ║  Referensi utama:                                        ║
 * ║  • github.com/pedroslopez/whatsapp-web.js/issues/511     ║
 * ║  • github.com/AlenVelocity/wa-sticker-formatter          ║
 * ║  • github.com/WhiskeySockets/Baileys/issues/521          ║
 * ║                                                          ║
 * ║  Perbaikan vs versi lama:                                ║
 * ║  1. pix_fmt: yuv420p → yuva420p  (alpha channel wajib)   ║
 * ║  2. EXIF: raw TIFF bytes — BUKAN format JPEG Exif\0\0    ║
 * ║  3. Ukuran file dijaga < 100KB (quality 75 + strip meta) ║
 * ║  4. Fallback quality rendah jika masih > 100KB           ║
 * ║  5. Validasi ukuran file setelah konversi                ║
 * ╚══════════════════════════════════════════════════════════╝
 */

'use strict';

const webpmux    = require('node-webpmux');
const { execFile } = require('child_process');
const fs         = require('fs');
const path       = require('path');
const os         = require('os');
const crypto     = require('crypto');

// ─── Konfigurasi Pack ────────────────────────────────────────
const PACK_NAME   = 'Mita AI';
const PACK_AUTHOR = 'VA';
const PACK_ID     = 'com.va.mitaai';

// Batas ukuran WhatsApp
const MAX_STATIC_KB   = 100;
const MAX_ANIMATED_KB = 500;
const MAX_VIDEO_SEC   = 5;

// ─── Utility ─────────────────────────────────────────────────

function tmpFile(prefix, ext) {
    return path.join(os.tmpdir(), `${prefix}_${crypto.randomBytes(6).toString('hex')}.${ext}`);
}

function cleanUp(...files) {
    for (const f of files) {
        try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch (_) {}
    }
}

function checkFileSize(filePath, maxKB, label = 'stiker') {
    const kb = fs.statSync(filePath).size / 1024;
    if (kb > maxKB) {
        throw new Error(
            `Ukuran ${label} ${kb.toFixed(1)} KB melebihi batas ${maxKB} KB WhatsApp.`
        );
    }
}

// ─── EXIF Builder ─────────────────────────────────────────────
/**
 * Build EXIF buffer untuk metadata stiker WhatsApp.
 *
 * ✅ Format yang BENAR untuk WebP: raw TIFF bytes
 * ❌ Format SALAH: "Exif\0\0" + TIFF  ← itu format JPEG, bukan WebP
 *
 * Referensi byte layout (22 byte header + JSON):
 *   github.com/pedroslopez/whatsapp-web.js/issues/511
 *
 *   [0-1]   49 49           → "II" (little-endian)
 *   [2-3]   2A 00           → TIFF magic = 42
 *   [4-7]   08 00 00 00     → IFD offset = 8
 *   [8-9]   01 00           → jumlah entry = 1
 *   [10-11] 41 57           → Tag = 0x5741 ("WA")
 *   [12-13] 07 00           → Type = UNDEFINED (7)
 *   [14-17] 00 00 00 00     → Count ← diisi panjang JSON
 *   [18-21] 16 00 00 00     → Data offset = 22 (0x16)
 *   [22+]   <JSON bytes>
 */
function buildExif(packName, author, packId) {
    const jsonBuf = Buffer.from(JSON.stringify({
        'sticker-pack-id'        : packId,
        'sticker-pack-name'      : packName,
        'sticker-pack-publisher' : author,
        'android-app-store-link' : '',
        'ios-app-store-link'     : ''
    }), 'utf8');

    // Header tetap dari referensi komunitas WhatsApp bot
    const header = Buffer.from([
        0x49, 0x49,              // "II" LE
        0x2A, 0x00,              // TIFF magic 42
        0x08, 0x00, 0x00, 0x00, // IFD offset = 8
        0x01, 0x00,              // 1 entry
        0x41, 0x57,              // Tag 0x5741
        0x07, 0x00,              // Type UNDEFINED
        0x00, 0x00, 0x00, 0x00, // Count (diisi di bawah)
        0x16, 0x00, 0x00, 0x00  // Data offset = 22
    ]);

    header.writeUInt32LE(jsonBuf.length, 14); // isi Count

    return Buffer.concat([header, jsonBuf]);
}

// ─── Inject EXIF ─────────────────────────────────────────────
async function injectExif(webpBuffer) {
    try {
        const img = new webpmux.Image();
        await img.load(webpBuffer);
        img.exif = buildExif(PACK_NAME, PACK_AUTHOR, PACK_ID);
        return await img.save(null);
    } catch (err) {
        console.warn('[sticker] EXIF inject gagal:', err.message);
        return webpBuffer; // fallback: kirim tanpa metadata
    }
}

// ─── FFmpeg Runner ────────────────────────────────────────────
function runFFmpeg(args, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
        execFile('ffmpeg', args, { timeout: timeoutMs }, (err, _out, stderr) => {
            if (err) {
                const hint = (stderr || '')
                    .split('\n').filter(Boolean).slice(-4).join(' | ');
                reject(new Error(hint || err.message));
            } else {
                resolve();
            }
        });
    });
}

function getVideoDuration(filePath) {
    return new Promise((resolve, reject) => {
        execFile('ffprobe', [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            filePath
        ], { timeout: 10000 }, (err, stdout) => {
            if (err) return reject(new Error('ffprobe gagal membaca durasi.'));
            resolve(parseFloat(stdout.trim()) || 0);
        });
    });
}

// Vfilter scale+pad 512×512 transparan
const VF_SCALE = [
    'scale=512:512:force_original_aspect_ratio=decrease',
    'pad=512:512:(ow-iw)/2:(oh-ih)/2:color=#00000000'
].join(',');

// ─── Static Stiker ────────────────────────────────────────────
/**
 * Gambar → Stiker WhatsApp (WebP 512×512, ≤ 100 KB)
 *
 * Kunci:
 *  • pix_fmt yuva420p  → WebP dengan alpha (WAJIB agar bisa disimpan & dipakai)
 *  • lossless 0        → VP8 lossy (WhatsApp tidak support VP8L)
 *  • map_metadata -1   → strip metadata untuk hemat ukuran
 *
 * @param   {Buffer} imageBuffer
 * @returns {Promise<Buffer>}
 */
async function createSticker(imageBuffer) {
    const inp = tmpFile('va_in', 'png');
    const out = tmpFile('va_stk', 'webp');

    try {
        fs.writeFileSync(inp, imageBuffer);

        await runFFmpeg([
            '-i', inp,
            '-vf', VF_SCALE,
            '-vcodec', 'libwebp',
            '-lossless', '0',         // VP8 lossy ← WAJIB
            '-quality', '75',
            '-compression_level', '6',
            '-pix_fmt', 'yuva420p',   // alpha channel ← WAJIB
            '-map_metadata', '-1',
            '-y', out
        ]);

        if (!fs.existsSync(out)) throw new Error('File output tidak terbentuk.');

        // Jika masih > 100KB, coba lagi dengan quality 50
        const kb = fs.statSync(out).size / 1024;
        if (kb > MAX_STATIC_KB) {
            cleanUp(out);
            return await createStickerFallback(imageBuffer);
        }

        const buf = fs.readFileSync(out);
        return await injectExif(buf);

    } catch (err) {
        throw new Error(`Gagal membuat stiker: ${err.message}`);
    } finally {
        cleanUp(inp, out);
    }
}

/** Fallback: quality 50 untuk gambar resolusi tinggi */
async function createStickerFallback(imageBuffer) {
    const inp = tmpFile('va_inlq', 'png');
    const out = tmpFile('va_stklq', 'webp');

    try {
        fs.writeFileSync(inp, imageBuffer);

        await runFFmpeg([
            '-i', inp,
            '-vf', VF_SCALE,
            '-vcodec', 'libwebp',
            '-lossless', '0',
            '-quality', '50',
            '-compression_level', '6',
            '-pix_fmt', 'yuva420p',
            '-map_metadata', '-1',
            '-y', out
        ]);

        if (!fs.existsSync(out)) throw new Error('Fallback output tidak terbentuk.');
        checkFileSize(out, MAX_STATIC_KB, 'stiker (fallback)');

        const buf = fs.readFileSync(out);
        return await injectExif(buf);
    } finally {
        cleanUp(inp, out);
    }
}

// ─── Animated / GIF Stiker ────────────────────────────────────
/**
 * Video → GIF Stiker WhatsApp (animated WebP, ≤ 500 KB, ≤ 5 detik)
 *
 * @param   {Buffer} videoBuffer
 * @returns {Promise<Buffer>}
 */
async function createGifSticker(videoBuffer) {
    const inp = tmpFile('va_vid', 'mp4');
    const out = tmpFile('va_gif', 'webp');

    try {
        fs.writeFileSync(inp, videoBuffer);

        const duration = await getVideoDuration(inp);
        if (duration > MAX_VIDEO_SEC) {
            throw new Error(
                `Video terlalu panjang (${Math.round(duration)}s). Maksimal ${MAX_VIDEO_SEC} detik.`
            );
        }

        const vfAnim = VF_SCALE + ',fps=12'; // 12fps hemat ukuran, cukup halus

        await runFFmpeg([
            '-t', String(MAX_VIDEO_SEC),
            '-i', inp,
            '-vcodec', 'libwebp',
            '-vf', vfAnim,
            '-lossless', '0',
            '-loop', '0',             // loop selamanya
            '-an',                    // no audio
            '-vsync', '0',
            '-preset', 'default',
            '-quality', '50',
            '-compression_level', '6',
            '-pix_fmt', 'yuva420p',
            '-map_metadata', '-1',
            '-y', out
        ], 60000);

        if (!fs.existsSync(out)) throw new Error('File GIF stiker tidak terbentuk.');
        checkFileSize(out, MAX_ANIMATED_KB, 'GIF stiker');

        const buf = fs.readFileSync(out);
        return await injectExif(buf);

    } catch (err) {
        throw new Error(`Gagal membuat GIF stiker: ${err.message}`);
    } finally {
        cleanUp(inp, out);
    }
}

// ─── Stiker → Gambar ──────────────────────────────────────────
/**
 * Stiker WebP → gambar PNG (ambil frame pertama jika animated)
 *
 * @param   {Buffer} webpBuffer
 * @returns {Promise<Buffer>}
 */
async function stickerToImage(webpBuffer) {
    const inp = tmpFile('va_s2i_in', 'webp');
    const out = tmpFile('va_s2i_out', 'png');

    try {
        fs.writeFileSync(inp, webpBuffer);

        await runFFmpeg([
            '-i', inp,
            '-vframes', '1',
            '-y', out
        ], 15000);

        if (!fs.existsSync(out)) throw new Error('File gambar tidak terbentuk.');
        return fs.readFileSync(out);

    } catch (err) {
        throw new Error(`Gagal convert stiker ke gambar: ${err.message}`);
    } finally {
        cleanUp(inp, out);
    }
}

// ─── Ganti Author ─────────────────────────────────────────────
/**
 * Ganti metadata author/pack pada stiker WebP yang sudah ada.
 * Re-inject EXIF baru tanpa ubah konten visual.
 *
 * @param   {Buffer} webpBuffer
 * @param   {string} newAuthor
 * @param   {string} [newPack]   default: PACK_NAME
 * @returns {Promise<Buffer>}
 */
async function changeStickerAuthor(webpBuffer, newAuthor, newPack = PACK_NAME) {
    try {
        const img = new webpmux.Image();
        await img.load(webpBuffer);
        img.exif = buildExif(newPack, newAuthor, PACK_ID);
        return await img.save(null);
    } catch (err) {
        throw new Error(`Gagal mengubah author stiker: ${err.message}`);
    }
}

// ─── Exports ──────────────────────────────────────────────────
module.exports = {
    createSticker,
    createGifSticker,
    stickerToImage,
    changeStickerAuthor
};