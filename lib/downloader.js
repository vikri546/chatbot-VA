const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const MAX_FILE_SIZE = 60 * 1024 * 1024; // 60MB
const DOWNLOAD_DIR = path.join(os.tmpdir(), 'va_downloads');

// Buat folder download
if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

// Platform yang didukung
const SUPPORTED_PLATFORMS = {
    'youtube.com': 'YouTube',
    'youtu.be': 'YouTube',
    'instagram.com': 'Instagram',
    'tiktok.com': 'TikTok',
    'facebook.com': 'Facebook',
    'fb.watch': 'Facebook',
    'twitter.com': 'Twitter/X',
    'x.com': 'Twitter/X',
};

/**
 * Deteksi platform dari URL.
 */
function detectPlatform(url) {
    try {
        const hostname = new URL(url).hostname.replace(/^www\./, '').replace(/^m\./, '');
        for (const [domain, name] of Object.entries(SUPPORTED_PLATFORMS)) {
            if (hostname.includes(domain)) return name;
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * Ambil info media (title, duration) dari URL menggunakan yt-dlp --dump-json.
 */
function getMediaInfo(url) {
    return new Promise((resolve) => {
        const cmd = `yt-dlp --dump-json --no-warnings --no-check-certificates --no-playlist "${url}" 2>/dev/null`;

        exec(cmd, { timeout: 30000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
            if (error || !stdout) {
                resolve({ title: 'Unknown', duration: 0 });
                return;
            }
            try {
                const info = JSON.parse(stdout.trim().split('\n')[0]);
                resolve({
                    title: (info.title || info.fulltitle || 'Unknown').substring(0, 100),
                    duration: Math.round(info.duration || 0)
                });
            } catch {
                resolve({ title: 'Unknown', duration: 0 });
            }
        });
    });
}

/**
 * Download media dari URL menggunakan yt-dlp.
 *
 * @param {string} url - URL media
 * @param {'video'|'audio'} type - Tipe download
 * @returns {Promise<{ buffer: Buffer, filename: string, title: string, duration: number, ext: string }>}
 */
async function downloadMedia(url, type = 'video') {
    const tmpId = crypto.randomBytes(8).toString('hex');

    // Ambil info dulu
    const info = await getMediaInfo(url);

    // Tentukan output path dan format args
    let formatArgs;
    let outputPath;

    if (type === 'audio') {
        outputPath = path.join(DOWNLOAD_DIR, `${tmpId}.mp3`);
        formatArgs = `-x --audio-format mp3 --audio-quality 128K`;
    } else {
        outputPath = path.join(DOWNLOAD_DIR, `${tmpId}.mp4`);
        formatArgs = `-f "bv*+ba/b/best" --merge-output-format mp4`;
    }

    // Build command
    // Menggunakan exec (bukan execFile) agar shell bisa resolve PATH di Termux
    const cmd = [
        'yt-dlp',
        `"${url}"`,
        '-o', `"${path.join(DOWNLOAD_DIR, `${tmpId}.%(ext)s`)}"`,
        '--no-playlist',
        '--no-warnings',
        '--no-check-certificates',
        '--restrict-filenames',
        '--socket-timeout', '30',
        formatArgs
    ].join(' ');

    console.log(`[DL] Command: ${cmd.substring(0, 120)}...`);

    await new Promise((resolve, reject) => {
        exec(cmd, { timeout: 180000, maxBuffer: 50 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) {
                console.log(`[DL] Error: ${error.message}`);
                if (stderr) console.log(`[DL] Stderr: ${stderr.substring(0, 500)}`);

                if (error.killed) {
                    return reject(new Error('Download timeout (>3 menit). Coba yang lebih pendek.'));
                }

                // Cek error spesifik
                const errMsg = (stderr || '') + (error.message || '');
                if (errMsg.includes('Unsupported URL') || errMsg.includes('not supported')) {
                    return reject(new Error('URL ini tidak didukung oleh yt-dlp.'));
                }
                if (errMsg.includes('Private') || errMsg.includes('private')) {
                    return reject(new Error('Konten ini private/tidak bisa diakses.'));
                }
                if (errMsg.includes('404') || errMsg.includes('not found') || errMsg.includes('Not Found')) {
                    return reject(new Error('Konten tidak ditemukan. Cek URL-nya.'));
                }
                if (errMsg.includes('login') || errMsg.includes('Login')) {
                    return reject(new Error('Konten ini butuh login. Tidak bisa didownload.'));
                }
                if (errMsg.includes('yt-dlp: not found') || errMsg.includes('command not found')) {
                    return reject(new Error('yt-dlp belum terinstall! Jalankan: pip install yt-dlp'));
                }

                return reject(new Error('Gagal download. Pastikan URL valid dan coba lagi.'));
            }
            resolve();
        });
    });

    // Cari file hasil download (ekstensi bisa bervariasi)
    const downloadedFile = findDownloadedFile(tmpId);

    if (!downloadedFile) {
        cleanupTempFiles(tmpId);
        throw new Error('File download tidak ditemukan. Mungkin URL tidak valid.');
    }

    const stats = fs.statSync(downloadedFile);
    if (stats.size > MAX_FILE_SIZE) {
        cleanupTempFiles(tmpId);
        throw new Error('File terlalu besar (>60MB) untuk dikirim via WhatsApp.');
    }

    if (stats.size < 1000) {
        cleanupTempFiles(tmpId);
        throw new Error('File download kosong/rusak. Coba URL lain.');
    }

    try {
        const buffer = fs.readFileSync(downloadedFile);
        const ext = path.extname(downloadedFile).replace('.', '').toLowerCase();
        const filename = path.basename(downloadedFile);

        cleanupTempFiles(tmpId);

        return { buffer, filename, title: info.title, duration: info.duration, ext };
    } catch (err) {
        cleanupTempFiles(tmpId);
        throw new Error('Gagal membaca file download.');
    }
}

/**
 * Cari file yang sudah didownload berdasarkan tmpId.
 * yt-dlp bisa menghasilkan ekstensi berbeda (mp4, webm, mkv, mp3, m4a, dll)
 */
function findDownloadedFile(tmpId) {
    try {
        const files = fs.readdirSync(DOWNLOAD_DIR);
        for (const file of files) {
            if (file.startsWith(tmpId)) {
                return path.join(DOWNLOAD_DIR, file);
            }
        }
    } catch (_) {}
    return null;
}

/**
 * Bersihkan file temporary berdasarkan ID.
 */
function cleanupTempFiles(tmpId) {
    try {
        const files = fs.readdirSync(DOWNLOAD_DIR);
        for (const file of files) {
            if (file.startsWith(tmpId)) {
                fs.unlinkSync(path.join(DOWNLOAD_DIR, file));
            }
        }
    } catch (_) {}
}

/**
 * Format durasi detik ke string mm:ss atau hh:mm:ss.
 */
function formatDuration(seconds) {
    if (!seconds || seconds <= 0) return 'N/A';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
}

module.exports = { downloadMedia, detectPlatform, formatDuration };
