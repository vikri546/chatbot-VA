const webpmux = require('node-webpmux');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PACK_NAME = 'Copyright VA 2026';
const AUTHOR = 'VA Bot';
const MAX_VIDEO_DURATION = 5; // detik

/**
 * Konversi buffer gambar menjadi stiker WhatsApp (WebP 512x512)
 * Menggunakan ffmpeg agar kompatibel dengan Termux.
 *
 * @param {Buffer} imageBuffer - Buffer gambar input (jpeg/png/webp)
 * @returns {Promise<Buffer>} - Buffer stiker WebP siap kirim
 */
async function createSticker(imageBuffer) {
    const tmpId = crypto.randomBytes(8).toString('hex');
    const tmpDir = os.tmpdir();
    const inputPath = path.join(tmpDir, `va_img_${tmpId}.png`);
    const outputPath = path.join(tmpDir, `va_stk_${tmpId}.webp`);

    try {
        fs.writeFileSync(inputPath, imageBuffer);
        await convertImageToWebp(inputPath, outputPath);
        const webpBuffer = fs.readFileSync(outputPath);
        return await addExifToWebp(webpBuffer);
    } finally {
        try { fs.unlinkSync(inputPath); } catch (_) {}
        try { fs.unlinkSync(outputPath); } catch (_) {}
    }
}

/**
 * Convert gambar ke WebP 512x512 (lossy, VP8).
 * WhatsApp WAJIB format VP8 lossy, bukan VP8L lossless.
 */
function convertImageToWebp(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        const args = [
            '-i', inputPath,
            '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=#00000000',
            '-vcodec', 'libwebp',
            '-lossless', '0',       // WAJIB: force lossy VP8 (bukan VP8L)
            '-quality', '80',
            '-pix_fmt', 'yuva420p', // support transparency
            '-y',
            outputPath
        ];

        execFile('ffmpeg', args, { timeout: 30000 }, (error, stdout, stderr) => {
            if (error) {
                console.log('FFmpeg error:', stderr);
                return reject(new Error('Gagal convert gambar ke stiker. Pastikan ffmpeg terinstall.'));
            }
            if (!fs.existsSync(outputPath)) {
                return reject(new Error('File stiker tidak berhasil dibuat.'));
            }
            resolve();
        });
    });
}

/**
 * Konversi buffer video menjadi stiker animasi (GIF stiker) WhatsApp.
 * Video akan dipotong max 5 detik, di-convert ke animated WebP 512x512.
 *
 * @param {Buffer} videoBuffer - Buffer video input (mp4/3gp/dll)
 * @returns {Promise<Buffer>} - Buffer stiker animasi WebP siap kirim
 */
async function createGifSticker(videoBuffer) {
    const tmpId = crypto.randomBytes(8).toString('hex');
    const tmpDir = os.tmpdir();
    const inputPath = path.join(tmpDir, `va_vid_${tmpId}.mp4`);
    const outputPath = path.join(tmpDir, `va_gif_${tmpId}.webp`);

    try {
        fs.writeFileSync(inputPath, videoBuffer);

        const duration = await getVideoDuration(inputPath);
        if (duration > MAX_VIDEO_DURATION) {
            throw new Error(`Video terlalu panjang (${Math.round(duration)} detik). Maksimal ${MAX_VIDEO_DURATION} detik.`);
        }

        await convertVideoToWebp(inputPath, outputPath);
        const webpBuffer = fs.readFileSync(outputPath);
        return await addExifToWebp(webpBuffer);
    } finally {
        try { fs.unlinkSync(inputPath); } catch (_) {}
        try { fs.unlinkSync(outputPath); } catch (_) {}
    }
}

/**
 * Dapatkan durasi video dalam detik menggunakan ffprobe.
 */
function getVideoDuration(filePath) {
    return new Promise((resolve, reject) => {
        const args = [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            filePath
        ];

        execFile('ffprobe', args, { timeout: 10000 }, (error, stdout) => {
            if (error) return reject(new Error('Gagal membaca durasi video.'));
            const duration = parseFloat(stdout.trim()) || 0;
            resolve(duration);
        });
    });
}

/**
 * Convert video ke animated WebP 512x512 (lossy VP8).
 */
function convertVideoToWebp(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        const args = [
            '-t', String(MAX_VIDEO_DURATION),
            '-i', inputPath,
            '-vcodec', 'libwebp',
            '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=#00000000,fps=15',
            '-lossless', '0',          // WAJIB: force lossy VP8
            '-loop', '0',
            '-an',
            '-vsync', '0',
            '-preset', 'default',
            '-quality', '50',
            '-compression_level', '6',
            '-pix_fmt', 'yuva420p',
            '-y',
            outputPath
        ];

        execFile('ffmpeg', args, { timeout: 60000 }, (error, stdout, stderr) => {
            if (error) {
                console.log('FFmpeg error:', stderr);
                return reject(new Error('Gagal convert video ke GIF stiker.'));
            }
            if (!fs.existsSync(outputPath)) {
                return reject(new Error('File GIF stiker tidak berhasil dibuat.'));
            }
            resolve();
        });
    });
}

/**
 * Inject EXIF metadata (pack name & author) ke buffer WebP.
 */
async function addExifToWebp(webpBuffer) {
    try {
        const img = new webpmux.Image();
        await img.load(webpBuffer);

        const exifData = buildStickerExif(PACK_NAME, AUTHOR);
        img.exif = exifData;

        return await img.save(null);
    } catch (err) {
        // Jika EXIF injection gagal, kembalikan WebP tanpa EXIF
        // (stiker tetap bisa dikirim, cuma tanpa nama paket)
        console.log('⚠️ EXIF injection gagal, kirim tanpa metadata:', err.message);
        return webpBuffer;
    }
}

/**
 * Membuat EXIF buffer untuk metadata stiker WhatsApp.
 * Format: TIFF header + IFD entry (tag 0x5741) + JSON data
 */
function buildStickerExif(packName, author) {
    const json = JSON.stringify({
        'sticker-pack-id': 'com.va.bot.sticker',
        'sticker-pack-name': packName,
        'sticker-pack-publisher': author,
        'emojis': ['😀']
    });

    const jsonBuffer = Buffer.from(json, 'utf-8');

    // TIFF Header (8 bytes)
    // Bytes 0-1: Byte order (II = little-endian)
    // Bytes 2-3: Magic number (42)
    // Bytes 4-7: Offset to first IFD (8)
    //
    // IFD (at offset 8):
    // Bytes 8-9: Number of entries (1)
    // Entry 0 (12 bytes):
    //   Bytes 10-11: Tag (0x5741 = "WA")
    //   Bytes 12-13: Type (7 = UNDEFINED)
    //   Bytes 14-17: Count (length of JSON)
    //   Bytes 18-21: Offset to data (26)
    // Bytes 22-25: Next IFD offset (0 = none)
    //
    // Data (at offset 26):
    //   JSON string

    const exif = Buffer.alloc(26 + jsonBuffer.length);

    // TIFF header
    exif.write('II', 0);             // Little endian
    exif.writeUInt16LE(0x002A, 2);   // TIFF magic
    exif.writeUInt32LE(8, 4);        // Offset to IFD

    // IFD
    exif.writeUInt16LE(1, 8);        // 1 entry
    exif.writeUInt16LE(0x5741, 10);  // Tag: "WA"
    exif.writeUInt16LE(7, 12);       // Type: UNDEFINED
    exif.writeUInt32LE(jsonBuffer.length, 14); // Count
    exif.writeUInt32LE(26, 18);      // Offset to data
    exif.writeUInt32LE(0, 22);       // Next IFD: none

    // JSON data
    jsonBuffer.copy(exif, 26);

    return exif;
}

module.exports = { createSticker, createGifSticker };
