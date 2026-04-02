const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const MAX_FILE_SIZE = 60 * 1024 * 1024; // 60MB (batas kirim WhatsApp)
const DOWNLOAD_DIR = path.join(os.tmpdir(), 'va_downloads');

// Buat folder download jika belum ada
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
 * @param {string} url
 * @returns {string|null} - Nama platform atau null
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
 * Download media (video/audio) dari URL menggunakan yt-dlp.
 *
 * @param {string} url - URL media
 * @param {'video'|'audio'} type - Tipe download
 * @returns {Promise<{ buffer: Buffer, filename: string, title: string, duration: number }>}
 */
async function downloadMedia(url, type = 'video') {
    const tmpId = crypto.randomBytes(8).toString('hex');
    const outputTemplate = path.join(DOWNLOAD_DIR, `${tmpId}.%(ext)s`);

    // Tentukan format berdasarkan tipe
    const formatArgs = type === 'audio'
        ? ['-x', '--audio-format', 'mp3', '--audio-quality', '128K']
        : ['-f', 'best[filesize<60M]/best', '--merge-output-format', 'mp4'];

    const args = [
        url,
        '-o', outputTemplate,
        '--no-playlist',          // jangan download playlist
        '--max-filesize', '60M',  // batas ukuran
        '--no-warnings',
        '--no-check-certificates',
        '--print', 'after_move:filepath',
        '--print', '%(title)s',
        '--print', '%(duration)s',
        ...formatArgs
    ];

    return new Promise((resolve, reject) => {
        execFile('yt-dlp', args, { timeout: 120000 }, (error, stdout, stderr) => {
            if (error) {
                // Bersihkan file yang mungkin tersisa
                cleanupTempFiles(tmpId);

                if (error.killed) {
                    return reject(new Error('Download timeout (>2 menit). Coba video yang lebih pendek.'));
                }
                if (stderr && stderr.includes('not supported')) {
                    return reject(new Error('URL ini tidak didukung.'));
                }
                if (stderr && stderr.includes('Private video')) {
                    return reject(new Error('Video ini private/tidak bisa diakses.'));
                }
                return reject(new Error('Gagal download. Pastikan URL valid dan coba lagi.'));
            }

            const lines = stdout.trim().split('\n');
            // yt-dlp prints: filepath, title, duration
            const filePath = lines[lines.length - 3]?.trim();
            const title = lines[lines.length - 2]?.trim() || 'Unknown';
            const duration = parseFloat(lines[lines.length - 1]) || 0;

            if (!filePath || !fs.existsSync(filePath)) {
                cleanupTempFiles(tmpId);
                return reject(new Error('File download tidak ditemukan.'));
            }

            const stats = fs.statSync(filePath);
            if (stats.size > MAX_FILE_SIZE) {
                cleanupTempFiles(tmpId);
                return reject(new Error('File terlalu besar (>60MB) untuk dikirim via WhatsApp.'));
            }

            try {
                const buffer = fs.readFileSync(filePath);
                const filename = path.basename(filePath);

                // Cleanup setelah baca
                cleanupTempFiles(tmpId);

                resolve({ buffer, filename, title, duration: Math.round(duration) });
            } catch (err) {
                cleanupTempFiles(tmpId);
                reject(new Error('Gagal membaca file download.'));
            }
        });
    });
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
