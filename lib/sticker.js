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
 * Menggunakan ffmpeg (bukan sharp) agar kompatibel dengan Termux.
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
        // 1. Tulis gambar ke file temporary
        fs.writeFileSync(inputPath, imageBuffer);

        // 2. Convert ke WebP 512x512 menggunakan ffmpeg
        await convertImageToWebp(inputPath, outputPath);

        // 3. Baca hasil WebP
        const webpBuffer = fs.readFileSync(outputPath);

        // 4. Inject EXIF metadata
        return await addExifToWebp(webpBuffer);
    } finally {
        try { fs.unlinkSync(inputPath); } catch (_) {}
        try { fs.unlinkSync(outputPath); } catch (_) {}
    }
}

/**
 * Convert gambar ke WebP 512x512 menggunakan ffmpeg binary langsung.
 * Lebih reliable di Termux daripada fluent-ffmpeg.
 */
function convertImageToWebp(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        const args = [
            '-i', inputPath,
            '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=#00000000',
            '-vcodec', 'libwebp',
            '-quality', '80',
            '-y',              // overwrite output
            outputPath
        ];

        execFile('ffmpeg', args, { timeout: 30000 }, (error, stdout, stderr) => {
            if (error) {
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
        // 1. Tulis video buffer ke file temporary
        fs.writeFileSync(inputPath, videoBuffer);

        // 2. Cek durasi video
        const duration = await getVideoDuration(inputPath);
        if (duration > MAX_VIDEO_DURATION) {
            throw new Error(`Video terlalu panjang (${Math.round(duration)} detik). Maksimal ${MAX_VIDEO_DURATION} detik.`);
        }

        // 3. Convert video ke animated WebP 512x512
        await convertVideoToWebp(inputPath, outputPath);

        // 4. Baca hasil WebP
        const webpBuffer = fs.readFileSync(outputPath);

        // 5. Inject EXIF metadata
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
 * Convert video ke animated WebP 512x512 menggunakan ffmpeg binary langsung.
 */
function convertVideoToWebp(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        const args = [
            '-t', String(MAX_VIDEO_DURATION),
            '-i', inputPath,
            '-vcodec', 'libwebp',
            '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=#00000000,fps=15',
            '-loop', '0',
            '-an',
            '-vsync', '0',
            '-preset', 'default',
            '-quality', '50',
            '-compression_level', '6',
            '-y',
            outputPath
        ];

        execFile('ffmpeg', args, { timeout: 60000 }, (error) => {
            if (error) {
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
    const img = new webpmux.Image();
    await img.load(webpBuffer);

    const exifData = buildStickerExif(PACK_NAME, AUTHOR);
    img.exif = exifData;

    return await img.save(null);
}

/**
 * Membuat EXIF buffer untuk metadata stiker WhatsApp.
 */
function buildStickerExif(packName, author) {
    const json = JSON.stringify({
        'sticker-pack-id': 'com.va.bot.sticker',
        'sticker-pack-name': packName,
        'sticker-pack-publisher': author,
        'emojis': ['😀']
    });

    const exifHeader = Buffer.from([
        0x49, 0x49, // Little-endian
        0x2A, 0x00, // TIFF magic number
        0x08, 0x00, 0x00, 0x00, // Offset to first IFD
        0x01, 0x00, // Number of IFD entries (1)
        0x41, 0x57, // Tag: 0x5741 ("WA")
        0x07, 0x00, // Type: UNDEFINED
    ]);

    const jsonBuffer = Buffer.from(json, 'utf-8');
    const lenBuffer = Buffer.alloc(4);
    lenBuffer.writeUInt32LE(jsonBuffer.length, 0);

    const nextIFD = Buffer.alloc(4);
    const dataOffset = Buffer.alloc(4);
    dataOffset.writeUInt32LE(exifHeader.length + 4 + 4 + 4 + 4, 0);

    return Buffer.concat([exifHeader, lenBuffer, dataOffset, nextIFD, jsonBuffer]);
}

module.exports = { createSticker, createGifSticker };
