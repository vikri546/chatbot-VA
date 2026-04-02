const https = require('https');
const config = require('../config');

const API_KEY = config.ELEVENLABS_API_KEY;
const VOICE_ID = config.ELEVENLABS_VOICE_ID;
const API_URL = `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`;

/**
 * Konversi teks menjadi audio menggunakan ElevenLabs API.
 * Menggunakan custom voice yang sudah di-design/clone.
 *
 * @param {string} text - Teks yang akan di-convert ke suara
 * @returns {Promise<Buffer>} - Buffer audio MP3
 */
async function textToSpeech(text) {
    // Limit teks agar tidak boros kuota
    if (text.length > 1000) {
        throw new Error('Teks terlalu panjang! Maksimal 1000 karakter.');
    }

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

module.exports = { textToSpeech };
