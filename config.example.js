/**
 * Konfigurasi Bot (Template)
 * Copy file ini ke config.js dan isi API keys:
 *   cp config.example.js config.js
 */
module.exports = {
    WEATHER_API_KEY: process.env.WEATHER_API_KEY || '',             // OpenWeatherMap API Key
    ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY || '',       // ElevenLabs API Key
    ELEVENLABS_VOICE_ID: process.env.ELEVENLABS_VOICE_ID || '',     // ElevenLabs Voice ID
    GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',               // Gemini API Key
    STICKER_PACK_NAME: 'Copyright VA 2026',                         // Nama pack stiker
    STICKER_AUTHOR: '',                                             // Author stiker
};
