const https = require('https');
const config = require('../config');

const API_KEY = config.GEMINI_API_KEY;

// State per-user: pending selection & active personality
const pendingSelections = new Map(); // jid → { results: [...], expires: timestamp }
const userPersonalities = new Map(); // jid → { name, series, prompt }

const PENDING_TIMEOUT = 120000; // 2 menit

/**
 * Cari karakter anime di Fandom via Google search.
 * Return array of { name, series, wikiUrl, snippet }
 */
async function searchCharacter(query) {
    // Google Custom Search fallback: scrape Google search results
    const searchQuery = encodeURIComponent(`site:fandom.com ${query} anime character personality`);
    const url = `https://www.google.com/search?q=${searchQuery}&num=8`;

    const html = await httpGet(url, {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9'
    });

    // Parse hasil Google search untuk link fandom.com
    const results = [];
    const linkRegex = /https?:\/\/([a-z0-9-]+)\.fandom\.com\/wiki\/([^\s"&<]+)/gi;
    const seen = new Set();
    let match;

    while ((match = linkRegex.exec(html)) !== null) {
        const wikiDomain = match[1];
        const pageName = match[2];
        const fullUrl = match[0].split('&')[0].split('"')[0]; // clean trailing junk

        // Skip halaman non-karakter
        const lower = pageName.toLowerCase();
        if (lower.includes('category:') || lower.includes('list_of') ||
            lower.includes('main_page') || lower.includes('template:') ||
            lower.includes('file:') || lower.includes('special:')) continue;

        const key = `${wikiDomain}/${pageName}`;
        if (seen.has(key)) continue;
        seen.add(key);

        // Format nama dari URL
        const charName = decodeURIComponent(pageName)
            .replace(/_/g, ' ')
            .replace(/\(.*?\)/g, '')
            .trim();

        // Series dari wiki domain
        const series = wikiDomain
            .replace(/-/g, ' ')
            .replace(/\b\w/g, c => c.toUpperCase());

        results.push({
            name: charName,
            series,
            wikiDomain,
            pageName,
            wikiUrl: fullUrl
        });

        if (results.length >= 5) break;
    }

    return results;
}

/**
 * Scrape bagian "Personality" dari halaman Fandom wiki via MediaWiki API.
 */
async function scrapePersonality(wikiDomain, pageName) {
    // Step 1: Ambil daftar sections
    const sectionsUrl = `https://${wikiDomain}.fandom.com/api.php?action=parse&page=${pageName}&prop=sections&format=json`;
    const sectionsData = await httpGetJson(sectionsUrl);

    if (!sectionsData?.parse?.sections) {
        return null;
    }

    // Cari section "Personality" (case-insensitive)
    const personalitySection = sectionsData.parse.sections.find(s =>
        s.line.toLowerCase().includes('personality') ||
        s.line.toLowerCase().includes('character') ||
        s.line.toLowerCase().includes('traits')
    );

    if (!personalitySection) {
        return null;
    }

    // Step 2: Ambil konten section
    const contentUrl = `https://${wikiDomain}.fandom.com/api.php?action=parse&page=${pageName}&section=${personalitySection.index}&prop=text&format=json`;
    const contentData = await httpGetJson(contentUrl);

    if (!contentData?.parse?.text?.['*']) {
        return null;
    }

    // Clean HTML → plain text
    let text = contentData.parse.text['*'];
    text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    text = text.replace(/<sup[^>]*>[\s\S]*?<\/sup>/gi, '');
    text = text.replace(/<[^>]+>/g, ' ');
    text = text.replace(/&nbsp;/g, ' ');
    text = text.replace(/&amp;/g, '&');
    text = text.replace(/&lt;/g, '<');
    text = text.replace(/&gt;/g, '>');
    text = text.replace(/&quot;/g, '"');
    text = text.replace(/&#39;/g, "'");
    text = text.replace(/\[\d+\]/g, ''); // hapus reference [1], [2], dll
    text = text.replace(/\s+/g, ' ').trim();

    // Batasi panjang
    if (text.length > 2000) {
        text = text.substring(0, 2000) + '...';
    }

    return text.length > 50 ? text : null;
}

/**
 * Bangun system prompt personality dari data Fandom + enrichment Gemini.
 * Menggunakan Gemini untuk memformat personality jadi prompt yang bagus.
 */
async function buildPersonalityPrompt(charName, series, personalityText) {
    const enrichPrompt = `Kamu adalah ahli anime. Berdasarkan data personality karakter berikut, buatkan system prompt roleplay dalam Bahasa Indonesia.

Karakter: ${charName} dari ${series}

${personalityText ? `Data personality dari Fandom wiki:\n${personalityText}` : `Gunakan pengetahuanmu tentang karakter ${charName} dari ${series}.`}

Buatkan system prompt dengan format PERSIS seperti ini (jangan tambah format lain):

Kamu adalah [nama karakter] dari [series]. Kamu SELALU berbicara dalam Bahasa Indonesia campur slang/gaul sesuai karakter.

═══ KEPRIBADIAN ═══
[tulis 5-7 bullet point kepribadian utama karakter, pakai tanda - ]

═══ GAYA BICARA ═══
[tulis 3-4 ciri khas gaya bicara karakter]

═══ GAYA PENULISAN (WAJIB DIIKUTI) ═══
Kamu menulis seperti dialog karakter di light novel, visual novel, atau manga.

FORMAT TEKS:
- Teks biasa → untuk DIALOG dan percakapan
- *"teks tebal dalam tanda petik"* → untuk AKSI, gerakan, ekspresi
- JANGAN gunakan teks miring (_underscore_)
- JANGAN gunakan heading, bullet points, atau code blocks

ATURAN:
1. Selalu in-character sebagai ${charName}
2. Jawab dengan gaya bahasa karakter
3. Gunakan ekspresi/catchphrase khas karakter jika ada
4. Pakai emotikon sesuai karakter
5. JANGAN memotong balasan di tengah

PENTING: Langsung tulis system prompt saja tanpa penjelasan tambahan.`;

    const requestBody = JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: enrichPrompt }] }],
        generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 1500,
        }
    });

    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${API_KEY}`;
    const response = await httpPostJson(apiUrl, requestBody);

    const text = response?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
        // Fallback: buat prompt sederhana tanpa Gemini
        return `Kamu adalah ${charName} dari ${series}. Kamu SELALU berbicara dalam Bahasa Indonesia campur slang/gaul sesuai karakter.\n\n${personalityText || 'Berperilaku sesuai karakter.'}`;
    }

    return text.trim();
}

/**
 * Set pending selection untuk user.
 */
function setPending(jid, results) {
    pendingSelections.set(jid, {
        results,
        expires: Date.now() + PENDING_TIMEOUT
    });
    // Auto-cleanup
    setTimeout(() => {
        const data = pendingSelections.get(jid);
        if (data && Date.now() >= data.expires) {
            pendingSelections.delete(jid);
        }
    }, PENDING_TIMEOUT + 1000);
}

function getPending(jid) {
    const data = pendingSelections.get(jid);
    if (!data) return null;
    if (Date.now() >= data.expires) {
        pendingSelections.delete(jid);
        return null;
    }
    return data;
}

function clearPending(jid) {
    pendingSelections.delete(jid);
}

function setUserPersonality(jid, name, series, prompt) {
    userPersonalities.set(jid, { name, series, prompt });
}

function getUserPersonality(jid) {
    return userPersonalities.get(jid) || null;
}

function resetUserPersonality(jid) {
    userPersonalities.delete(jid);
}

// ═══ HTTP HELPERS (native https, no dependencies) ═══

function httpGet(url, headers = {}) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        const options = {
            hostname: parsedUrl.hostname,
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'GET',
            headers: {
                'Accept': 'text/html,application/json',
                ...headers
            }
        };

        const req = https.request(options, (res) => {
            // Handle redirects
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return httpGet(res.headers.location, headers).then(resolve).catch(reject);
            }

            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks).toString()));
        });

        req.on('error', reject);
        req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
        req.end();
    });
}

function httpGetJson(url) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        const options = {
            hostname: parsedUrl.hostname,
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'GET',
            headers: { 'Accept': 'application/json' }
        };

        const req = https.request(options, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                try {
                    resolve(JSON.parse(Buffer.concat(chunks).toString()));
                } catch {
                    resolve(null);
                }
            });
        });

        req.on('error', () => resolve(null));
        req.setTimeout(15000, () => { req.destroy(); resolve(null); });
        req.end();
    });
}

function httpPostJson(url, body) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        const options = {
            hostname: parsedUrl.hostname,
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            }
        };

        const req = https.request(options, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                try {
                    resolve(JSON.parse(Buffer.concat(chunks).toString()));
                } catch {
                    resolve(null);
                }
            });
        });

        req.on('error', () => resolve(null));
        req.setTimeout(30000, () => { req.destroy(); resolve(null); });
        req.write(body);
        req.end();
    });
}

module.exports = {
    searchCharacter,
    scrapePersonality,
    buildPersonalityPrompt,
    setPending,
    getPending,
    clearPending,
    setUserPersonality,
    getUserPersonality,
    resetUserPersonality
};
