const https = require('https');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const config = require('../config');

const API_KEY = config.ELEVENLABS_API_KEY;
const VOICE_ID = config.ELEVENLABS_VOICE_ID;
const API_URL = `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`;

/**
 * Konversi teks menjadi audio menggunakan ElevenLabs API.
 * Output dalam format OGG Opus agar kompatibel dengan WhatsApp voice note.
 *
 * @param {string} text - Teks yang akan di-convert ke suara
 * @returns {Promise<Buffer>} - Buffer audio OGG Opus
 */
async function textToSpeech(text) {
    if (text.length > 1000) {
        throw new Error('Teks terlalu panjang! Maksimal 1000 karakter.');
    }

    // 1. Dapatkan MP3 dari ElevenLabs
    const mp3Buffer = await fetchElevenLabsAudio(text);

    // 2. Convert MP3 → OGG Opus via ffmpeg (wajib untuk WhatsApp voice note)
    const oggBuffer = await convertToOggOpus(mp3Buffer);

    return oggBuffer;
}

/**
 * Fetch audio MP3 dari ElevenLabs API.
 */
function fetchElevenLabsAudio(text) {
    const requestBody = JSON.stringify({
        text: text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
            style: 0.3,
            use_speaker_boost: true
        }
    });

    return new Promise((resolve, reject) => {
        const url = new URL(API_URL);

        const options = {
            hostname: url.hostname,
            path: url.pathname,
            method: 'POST',
            headers: {
                'Accept': 'audio/mpeg',
                'Content-Type': 'application/json',
                'xi-api-key': API_KEY
            }
        };

        const req = https.request(options, (res) => {
            if (res.statusCode === 401) {
                reject(new Error('API key ElevenLabs tidak valid.'));
                return;
            }
            if (res.statusCode === 429) {
                reject(new Error('Kuota ElevenLabs habis. Coba lagi nanti.'));
                return;
            }
            if (res.statusCode !== 200) {
                reject(new Error(`ElevenLabs error (${res.statusCode}). Coba lagi.`));
                return;
            }

            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const buffer = Buffer.concat(chunks);
                if (buffer.length < 100) {
                    reject(new Error('Audio kosong. Coba teks yang berbeda.'));
                } else {
                    resolve(buffer);
                }
            });
        });

        req.on('error', () => {
            reject(new Error('Gagal menghubungi ElevenLabs. Periksa koneksi internet.'));
        });

        req.write(requestBody);
        req.end();
    });
}

/**
 * Convert buffer MP3 → OGG Opus menggunakan ffmpeg.
 * WhatsApp voice note WAJIB format OGG Opus.
 *
 * @param {Buffer} mp3Buffer - Buffer audio MP3
 * @returns {Promise<Buffer>} - Buffer audio OGG Opus
 */
function convertToOggOpus(mp3Buffer) {
    const tmpId = crypto.randomBytes(8).toString('hex');
    const tmpDir = os.tmpdir();
    const inputPath = path.join(tmpDir, `va_tts_${tmpId}.mp3`);
    const outputPath = path.join(tmpDir, `va_tts_${tmpId}.ogg`);

    return new Promise((resolve, reject) => {
        // Tulis MP3 ke temp file
        fs.writeFileSync(inputPath, mp3Buffer);

        const args = [
            '-i', inputPath,
            '-acodec', 'libopus',    // Encode ke Opus
            '-ar', '48000',          // Sample rate 48kHz (standar Opus)
            '-ac', '1',              // Mono
            '-b:a', '64k',           // Bitrate
            '-vbr', 'on',
            '-application', 'voip',  // Optimized untuk voice
            '-y',
            outputPath
        ];

        execFile('ffmpeg', args, { timeout: 30000 }, (error, stdout, stderr) => {
            try {
                if (error) {
                    console.log('FFmpeg TTS error:', stderr);
                    reject(new Error('Gagal convert audio. Pastikan ffmpeg terinstall.'));
                    return;
                }

                if (!fs.existsSync(outputPath)) {
                    reject(new Error('File audio OGG tidak berhasil dibuat.'));
                    return;
                }

                const oggBuffer = fs.readFileSync(outputPath);
                resolve(oggBuffer);
            } finally {
                // Cleanup temp files
                try { fs.unlinkSync(inputPath); } catch (_) {}
                try { fs.unlinkSync(outputPath); } catch (_) {}
            }
        });
    });
}

module.exports = { textToSpeech };
