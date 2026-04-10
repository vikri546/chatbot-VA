const https = require('https');
const config = require('../config');

const API_KEY = config.GEMINI_API_KEY;
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// ─── Model Fallback Chain ────────────────────────────────────────────────────
// Jika model utama 503, otomatis turun ke model cadangan yang lebih stabil
const MODEL_CHAIN = [
    'gemini-2.5-pro',             // Model utama (paling stabil)
    'gemini-2.5-flash',           // Model utama
    'gemini-2.0-flash-001',       // Fallback 1
    'gemini-1.5-flash',           // Fallback 2
    'gemini-1.5-flash-8b',        // Fallback 3 (paling ringan, paling stabil)
];

// ─── Personality Module ──────────────────────────────────────────────────────
const { getActivePrompt } = require('./personality');

// ─── Chat History ────────────────────────────────────────────────────────────
const chatHistory = new Map();
const MAX_HISTORY = 20;

// ─── Circuit Breaker ─────────────────────────────────────────────────────────
// Jika server terus 503, hentikan sementara agar tidak buang request sia-sia
const circuitBreaker = {
    failures: 0,
    lastFailureTime: null,
    isOpen: false,
    FAILURE_THRESHOLD: 5,       // Buka circuit setelah 5 kegagalan berturut-turut
    RECOVERY_TIMEOUT: 60000,    // Coba lagi setelah 60 detik

    recordFailure() {
        this.failures++;
        this.lastFailureTime = Date.now();
        if (this.failures >= this.FAILURE_THRESHOLD) {
            this.isOpen = true;
            console.warn('[circuit-breaker] 🔴 OPEN — Gemini API tidak responsif, menunggu pemulihan...');
        }
    },

    recordSuccess() {
        this.failures = 0;
        this.isOpen = false;
        this.lastFailureTime = null;
    },

    canRequest() {
        if (!this.isOpen) return true;
        // Cek apakah sudah waktunya recovery
        const elapsed = Date.now() - this.lastFailureTime;
        if (elapsed >= this.RECOVERY_TIMEOUT) {
            this.isOpen = false;
            this.failures = Math.floor(this.FAILURE_THRESHOLD / 2); // Half-open state
            console.log('[circuit-breaker] 🟡 HALF-OPEN — Mencoba kembali...');
            return true;
        }
        return false;
    }
};

// ─── Request Queue ────────────────────────────────────────────────────────────
// Cegah request bersamaan dari user yang sama (mengurangi beban server)
const pendingRequests = new Map();

// ─── Retry Config ─────────────────────────────────────────────────────────────
const MAX_RETRIES = 5;
// Delay dasar (ms) — akan ditambah jitter acak untuk hindari thundering herd
const BASE_DELAYS = [2000, 5000, 10000, 20000, 30000];

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

/**
 * Hitung delay dengan exponential backoff + random jitter.
 * Jitter mencegah semua client retry di waktu yang sama (thundering herd).
 */
function getRetryDelay(attempt) {
    const base = BASE_DELAYS[attempt] || 30000;
    const jitter = Math.random() * base * 0.3; // ±30% jitter
    return Math.floor(base + jitter);
}

/**
 * Buat URL API Gemini untuk model tertentu.
 */
function makeApiUrl(model) {
    return `${API_BASE}/${model}:generateContent?key=${API_KEY}`;
}

/**
 * Ambil system prompt aktif untuk user.
 */
function getSystemPrompt(jid) {
    return getActivePrompt(jid);
}

// ─── Main Chat Function ───────────────────────────────────────────────────────

/**
 * Kirim pesan ke Gemini AI dengan retry, fallback model, dan circuit breaker.
 *
 * @param {string} jid - Chat ID user
 * @param {string} userMessage - Pesan dari user
 * @returns {Promise<string>} - Balasan dari AI
 */
async function chat(jid, userMessage) {
    if (!API_KEY) {
        throw new Error('API key Gemini belum diset! Edit config.js');
    }

    // Cegah request dobel dari user yang sama
    if (pendingRequests.has(jid)) {
        throw new Error('Masih memproses pesan sebelumnya, tunggu sebentar~');
    }
    pendingRequests.set(jid, true);

    try {
        // Inisialisasi history jika belum ada
        if (!chatHistory.has(jid)) {
            chatHistory.set(jid, []);
        }
        const history = chatHistory.get(jid);

        // Tambah pesan user ke history
        history.push({ role: 'user', parts: [{ text: userMessage }] });

        // Batasi panjang history
        while (history.length > MAX_HISTORY) {
            history.shift();
        }

        // Build request body
        const requestBody = JSON.stringify({
            system_instruction: {
                parts: [{ text: getSystemPrompt(jid) }]
            },
            contents: history,
            generationConfig: {
                temperature: 0.9,
                topP: 0.95,
                topK: 40,
                maxOutputTokens: 2048,
            },
            safetySettings: [
                { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE' },
                { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_NONE' },
                { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
                { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
            ]
        });

        const responseText = await callGeminiWithFallback(requestBody);

        // Tambah respons AI ke history
        history.push({ role: 'model', parts: [{ text: responseText }] });

        return responseText;
    } finally {
        pendingRequests.delete(jid);
    }
}

// ─── Fallback + Retry Logic ───────────────────────────────────────────────────

/**
 * Coba model satu per satu jika 503 terus terjadi (model fallback chain).
 */
async function callGeminiWithFallback(requestBody) {
    let lastError;

    for (let modelIndex = 0; modelIndex < MODEL_CHAIN.length; modelIndex++) {
        const model = MODEL_CHAIN[modelIndex];
        const apiUrl = makeApiUrl(model);

        if (modelIndex > 0) {
            console.log(`[gemini] ⚠️ Beralih ke model fallback: ${model}`);
        }

        try {
            const result = await callGeminiWithRetry(apiUrl, requestBody, model);
            if (modelIndex > 0) {
                console.log(`[gemini] ✅ Berhasil dengan model fallback: ${model}`);
            }
            return result;
        } catch (err) {
            lastError = err;

            // Jangan coba model lain kalau bukan error server (503/500/502)
            if (err.noRetry || err.noFallback) throw err;

            // Hanya fallback jika masih ada model berikutnya
            if (modelIndex < MODEL_CHAIN.length - 1) {
                console.log(`[gemini] Model ${model} tidak tersedia, mencoba model berikutnya...`);
                continue;
            }
        }
    }

    throw lastError || new Error('Semua model Gemini tidak tersedia saat ini. Coba lagi nanti.');
}

/**
 * Retry dengan exponential backoff + jitter untuk satu model.
 */
async function callGeminiWithRetry(apiUrl, requestBody, modelName) {
    // Cek circuit breaker
    if (!circuitBreaker.canRequest()) {
        const waitSec = Math.ceil((circuitBreaker.RECOVERY_TIMEOUT - (Date.now() - circuitBreaker.lastFailureTime)) / 1000);
        throw new Error(`Server Gemini sedang kelebihan beban. Coba lagi dalam ~${waitSec} detik.`);
    }

    let lastError;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
            const result = await _doGeminiRequest(apiUrl, requestBody);
            circuitBreaker.recordSuccess();
            return result;
        } catch (err) {
            lastError = err;

            // Error non-retryable (400, 401, 403, SAFETY) — langsung lempar
            if (err.noRetry) throw err;

            circuitBreaker.recordFailure();

            if (attempt < MAX_RETRIES - 1) {
                const delay = getRetryDelay(attempt);
                console.log(`[gemini] Retry ${attempt + 1}/${MAX_RETRIES} untuk ${modelName} setelah ${delay}ms — ${err.message}`);
                await sleep(delay);
            }
        }
    }

    throw lastError;
}

// ─── Low-level HTTP Request ───────────────────────────────────────────────────

function _doGeminiRequest(apiUrl, requestBody) {
    return new Promise((resolve, reject) => {
        const url = new URL(apiUrl);

        const options = {
            hostname: url.hostname,
            path: url.pathname + url.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(requestBody),
            }
        };

        const req = https.request(options, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString();
                let body;

                try {
                    body = JSON.parse(raw);
                } catch {
                    return reject(new Error('Gagal membaca respons Gemini, mencoba ulang...'));
                }

                // ── Non-retryable errors ──
                if (res.statusCode === 400) {
                    const errMsg = body?.error?.message || 'Request tidak valid.';
                    const err = new Error(`Request tidak valid: ${errMsg}`);
                    err.noRetry = true;
                    err.noFallback = true;
                    return reject(err);
                }
                if (res.statusCode === 401 || res.statusCode === 403) {
                    const err = new Error('API key Gemini tidak valid atau tidak punya akses.');
                    err.noRetry = true;
                    err.noFallback = true;
                    return reject(err);
                }

                // ── Retryable errors ──
                if (res.statusCode === 429) {
                    const retryAfter = res.headers['retry-after'];
                    const msg = retryAfter
                        ? `Kuota Gemini penuh, coba lagi dalam ${retryAfter} detik`
                        : 'Kuota Gemini penuh, menunggu...';
                    return reject(new Error(msg));
                }
                if (res.statusCode === 503 || res.statusCode === 500 || res.statusCode === 502) {
                    const serverMsg = body?.error?.message || '';
                    return reject(new Error(`Server Gemini sibuk (${res.statusCode})${serverMsg ? ': ' + serverMsg : ''}`));
                }
                if (res.statusCode === 504) {
                    return reject(new Error('Gemini timeout dari sisi server (504), mencoba ulang...'));
                }
                if (res.statusCode !== 200) {
                    return reject(new Error(`Gemini error tidak terduga (${res.statusCode})`));
                }

                // ── Parse response ──
                const text = body?.candidates?.[0]?.content?.parts?.[0]?.text;
                if (!text) {
                    const finishReason = body?.candidates?.[0]?.finishReason;
                    if (finishReason === 'SAFETY') {
                        const err = new Error('Pesan diblokir filter keamanan Gemini. Coba topik lain~');
                        err.noRetry = true;
                        err.noFallback = true;
                        return reject(err);
                    }
                    if (finishReason === 'RECITATION') {
                        const err = new Error('Respons diblokir karena recitation policy.');
                        err.noRetry = true;
                        return reject(err);
                    }
                    // Respons kosong — bisa retry
                    return reject(new Error('Respons kosong dari Gemini, mencoba ulang...'));
                }

                resolve(text.trim());
            });
        });

        req.on('error', (e) => {
            reject(new Error(`Koneksi ke Gemini gagal: ${e.message}`));
        });

        req.setTimeout(35000, () => {
            req.destroy();
            reject(new Error('Gemini timeout (35s), mencoba ulang...'));
        });

        req.write(requestBody);
        req.end();
    });
}

// ─── Image Analysis ───────────────────────────────────────────────────────────

/**
 * Analisis gambar menggunakan Gemini Vision.
 *
 * @param {string} jid - Chat ID user
 * @param {Buffer} imageBuffer - Buffer gambar
 * @param {string} [userPrompt] - Prompt tambahan dari user
 * @returns {Promise<string>}
 */
async function analyzeImage(jid, imageBuffer, userPrompt = '') {
    if (!API_KEY) {
        throw new Error('API key Gemini belum diset!');
    }

    const base64Image = imageBuffer.toString('base64');
    const personality = getSystemPrompt(jid);

    const prompt = userPrompt
        ? `Analisis gambar ini dan jawab: ${userPrompt}`
        : 'Analisis dan jelaskan gambar ini secara detail. Apa yang kamu lihat? Jelaskan konteks, objek, warna, suasana, dan hal menarik lainnya.';

    const requestBody = JSON.stringify({
        system_instruction: { parts: [{ text: personality }] },
        contents: [{
            role: 'user',
            parts: [
                { inline_data: { mime_type: 'image/jpeg', data: base64Image } },
                { text: prompt }
            ]
        }],
        generationConfig: { temperature: 0.8, maxOutputTokens: 2048 }
    });

    // Gunakan model utama dulu, fallback jika 503
    return await callGeminiWithFallback(requestBody);
}

// ─── Website Analysis ─────────────────────────────────────────────────────────

/**
 * Fetch konten website lalu analisis dengan Gemini.
 *
 * @param {string} jid - Chat ID user
 * @param {string} url - URL website
 * @returns {Promise<string>}
 */
async function analyzeWebsite(jid, url) {
    if (!API_KEY) {
        throw new Error('API key Gemini belum diset!');
    }

    const html = await fetchUrl(url);
    if (!html || html.length < 100) {
        throw new Error('Gagal mengambil konten website atau halaman kosong.');
    }

    // Strip HTML → plain text
    let text = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
        .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
        .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, ' ')
        .trim();

    if (text.length > 8000) text = text.substring(0, 8000) + '...';

    const personality = getSystemPrompt(jid);

    const requestBody = JSON.stringify({
        system_instruction: { parts: [{ text: personality }] },
        contents: [{
            role: 'user',
            parts: [{
                text: `Analisis website berikut secara detail: apa isinya, topik utama, dan informasi penting yang ada.\n\nURL: ${url}\n\nKonten:\n${text}`
            }]
        }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 2048 }
    });

    return await callGeminiWithFallback(requestBody);
}

// ─── HTTP Fetch Helper ────────────────────────────────────────────────────────

function fetchUrl(url, redirectCount = 0) {
    if (redirectCount > 5) return Promise.reject(new Error('Terlalu banyak redirect.'));
    const lib = url.startsWith('https') ? https : require('http');
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        const options = {
            hostname: parsedUrl.hostname,
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36',
                'Accept': 'text/html'
            }
        };

        const req = lib.request(options, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return fetchUrl(res.headers.location, redirectCount + 1).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                return reject(new Error(`Website error (${res.statusCode})`));
            }
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks).toString()));
        });

        req.on('error', () => reject(new Error('Gagal mengakses website. Cek URL-nya.')));
        req.setTimeout(15000, () => { req.destroy(); reject(new Error('Website timeout.')); });
        req.end();
    });
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * Reset riwayat chat user.
 */
function resetChat(jid) {
    chatHistory.delete(jid);
}

/**
 * Cek status circuit breaker (untuk debugging/monitoring).
 */
function getCircuitStatus() {
    return {
        isOpen: circuitBreaker.isOpen,
        failures: circuitBreaker.failures,
        lastFailureTime: circuitBreaker.lastFailureTime,
    };
}

module.exports = { chat, resetChat, analyzeImage, analyzeWebsite, getCircuitStatus };