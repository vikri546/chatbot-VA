const sharp = require('sharp');
const webpmux = require('node-webpmux');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PACK_NAME = 'Copyright VA 2026';
const AUTHOR = 'VA Bot';
const MAX_VIDEO_DURATION = 5; // detik

/**
 * Konversi buffer gambar menjadi stiker WhatsApp (WebP 512x512)
 * dengan metadata EXIF untuk nama paket & author.
 *
 * @param {Buffer} imageBuffer - Buffer gambar input (jpeg/png/webp)
 * @returns {Promise<Buffer>} - Buffer stiker WebP siap kirim
 */
async function createSticker(imageBuffer) {
    // 1. Resize & convert ke WebP 512x512
    const webpBuffer = await sharp(imageBuffer)
        .resize(512, 512, {
            fit: 'contain',
            background: { r: 0, g: 0, b: 0, alpha: 0 } // transparan
        })
        .webp({ quality: 80 })
        .toBuffer();

    // 2. Inject EXIF metadata
    return await addExifToWebp(webpBuffer);
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
    const inputPath = path.join(tmpDir, `va_input_${tmpId}.mp4`);
    const outputPath = path.join(tmpDir, `va_output_${tmpId}.webp`);

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
        // Bersihkan file temporary
        try { fs.unlinkSync(inputPath); } catch (_) {}
        try { fs.unlinkSync(outputPath); } catch (_) {}
    }
}

/**
 * Dapatkan durasi video dalam detik.
 */
function getVideoDuration(filePath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) return reject(err);
            const duration = metadata?.format?.duration || 0;
            resolve(parseFloat(duration));
        });
    });
}

/**
 * Convert video ke animated WebP 512x512 menggunakan ffmpeg.
 */
function convertVideoToWebp(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .inputOptions(['-t', String(MAX_VIDEO_DURATION)]) // max 5 detik
            .outputOptions([
                '-vcodec', 'libwebp',
                '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=#00000000,fps=15',
                '-loop', '0',        // infinite loop
                '-an',               // tanpa audio
                '-vsync', '0',
                '-preset', 'default',
                '-quality', '50',    // compress agar ukuran kecil
                '-compression_level', '6'
            ])
            .toFormat('webp')
            .save(outputPath)
            .on('end', resolve)
            .on('error', reject);
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
