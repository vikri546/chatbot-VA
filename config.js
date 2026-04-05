/**
 * Konfigurasi Bot
 * API keys bisa diset via environment variable ATAU langsung di sini.
 * Env variable lebih aman agar tidak terexpose di GitHub.
 *
 * Contoh set env di Termux:
 *   export GEMINI_API_KEY="AIzaSy..."
 *   export ELEVENLABS_API_KEY="sk_..."
 *   node index.js
 */
module.exports = {
    // OpenWeatherMap API Key
    WEATHER_API_KEY: process.env.WEATHER_API_KEY || '3c014f078af93a3c7256a2233d0e45a4',

    // ElevenLabs TTS
    ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY || 'sk_15880d36e3621323e219e039327be3a67e6b486a556ac266',
    ELEVENLABS_VOICE_ID: process.env.ELEVENLABS_VOICE_ID || 'uiKKvPjCcr7oozt1Oief',

    // Google Gemini AI
    // PENTING: Buat API key baru di https://aistudio.google.com/apikey
    // Key lama sudah di-revoke karena terexpose di GitHub
    GEMINI_API_KEY: process.env.GEMINI_API_KEY || 'GANTI_DENGAN_API_KEY_BARU',

    // Sticker metadata
    STICKER_PACK_NAME: 'Copyright VA 2026',
    STICKER_AUTHOR: '',
};
