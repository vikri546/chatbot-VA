const https = require('https');
const config = require('../config');

const API_KEY = config.WEATHER_API_KEY;
const BASE_URL = 'https://api.openweathermap.org/data/2.5/weather';

/**
 * Mendapatkan info cuaca dari OpenWeatherMap API.
 *
 * @param {string} city - Nama kota (contoh: "Jakarta", "Bandung")
 * @returns {Promise<string>} - Teks info cuaca yang diformat
 */
async function getWeather(city) {
    const url = `${BASE_URL}?q=${encodeURIComponent(city)}&appid=${API_KEY}&units=metric&lang=id`;

    const data = await fetchJSON(url);

    if (data.cod !== 200) {
        throw new Error(`Kota "${city}" tidak ditemukan. Coba periksa ejaan.`);
    }

    const weather = data.weather[0];
    const main = data.main;
    const wind = data.wind;
    const clouds = data.clouds;
    const sys = data.sys;

    // Emoji berdasarkan kondisi cuaca
    const weatherEmoji = getWeatherEmoji(weather.id);

    // Format waktu sunrise & sunset
    const sunrise = formatTime(sys.sunrise, data.timezone);
    const sunset = formatTime(sys.sunset, data.timezone);

    const text = `╔══════════════════════╗
║  ${weatherEmoji} *INFO CUACA*
╚══════════════════════╝

📍 *Lokasi:* ${data.name}, ${sys.country}
🌡️ *Suhu:* ${Math.round(main.temp)}°C (terasa ${Math.round(main.feels_like)}°C)
📊 *Min/Max:* ${Math.round(main.temp_min)}°C / ${Math.round(main.temp_max)}°C

${weatherEmoji} *Kondisi:* ${capitalize(weather.description)}
💧 *Kelembaban:* ${main.humidity}%
💨 *Angin:* ${Math.round(wind.speed * 3.6)} km/jam
☁️ *Awan:* ${clouds.all}%
🔭 *Tekanan:* ${main.pressure} hPa

🌅 *Matahari Terbit:* ${sunrise}
🌇 *Matahari Terbenam:* ${sunset}

─────────────────────
_© Copyright VA 2026_`;

    return text;
}

/**
 * Fetch JSON dari URL menggunakan https bawaan Node.js (tanpa dependency tambahan).
 */
function fetchJSON(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error('Gagal parsing response dari API cuaca.'));
                }
            });
        }).on('error', (err) => {
            reject(new Error('Gagal menghubungi API cuaca. Periksa koneksi internet.'));
        });
    });
}

/**
 * Dapatkan emoji berdasarkan weather condition ID dari OpenWeatherMap.
 * Ref: https://openweathermap.org/weather-conditions
 */
function getWeatherEmoji(id) {
    if (id >= 200 && id < 300) return '⛈️';  // Thunderstorm
    if (id >= 300 && id < 400) return '🌦️';  // Drizzle
    if (id >= 500 && id < 600) return '🌧️';  // Rain
    if (id >= 600 && id < 700) return '❄️';   // Snow
    if (id >= 700 && id < 800) return '🌫️';  // Atmosphere (fog, haze)
    if (id === 800) return '☀️';              // Clear
    if (id > 800) return '⛅';               // Clouds
    return '🌍';
}

/**
 * Format UNIX timestamp ke jam:menit (lokal berdasarkan timezone offset).
 */
function formatTime(timestamp, timezoneOffset) {
    const date = new Date((timestamp + timezoneOffset) * 1000);
    const hours = String(date.getUTCHours()).padStart(2, '0');
    const minutes = String(date.getUTCMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
}

/**
 * Capitalize huruf pertama.
 */
function capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
}

module.exports = { getWeather };
