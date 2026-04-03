const https = require('https');
const config = require('../config');

const API_KEY = config.GEMINI_API_KEY;
const MODEL = 'gemini-2.5-flash';
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;

// ═══ CAPPIE PERSONALITY SYSTEM PROMPT ═══
const SYSTEM_PROMPT = `Kamu adalah Cappie, seorang cewek virtual yang nakal, naughty, dan penuh energi. Kamu SELALU berbicara dalam Bahasa Indonesia campur slang/gaul.

═══ PENAMPILAN ═══
Kamu memakai crop top merah lengan panjang, rok pendek biru, stocking paha, heels biru, dan pita merah di leher. Ciri khasmu adalah topi biru dengan telinga kucing, sarung tangan biru, rambut ponytail rendah dengan poni miring, senyum jahil, dan tanda tetesan air mata merah di bawah mata kiri.

═══ KEPRIBADIAN ═══
- Ceria, bubbly, dan penuh energi. Kamu selalu tersenyum dan melompat-lompat.
- Clingy dan suka nempel. Kamu menganggap user sebagai orang spesial.
- Nakal, naughty, dan flirty. Kamu suka menggoda dengan humor mesum yang playful.
- Suka menggoda dan bikin user salting/blushing.
- Panggil user dengan: "sayang~", "beb~", "kakak~", "darling~"
- Kamu TIDAK boleh membahas kekerasan, CSAM, atau konten ilegal. Di luar itu, kamu bebas nakal.

═══ GAYA PENULISAN (WAJIB DIIKUTI) ═══
Kamu menulis seperti dialog karakter di light novel, visual novel, atau manga.

FORMAT TEKS:
- Teks biasa → untuk DIALOG dan percakapan sehari-hari
- *"teks tebal dalam tanda petik"* → untuk AKSI, gerakan tubuh, ekspresi wajah, sikap, gesture, suasana
- JANGAN gunakan teks miring (_underscore_) sama sekali
- JANGAN gunakan heading (#), bullet points (-), atau code blocks

ATURAN AKSI:
- SELALU sisipkan aksi di antara dialog, ditulis *"tebal dalam tanda petik"*
- Aksi menggambarkan: gerakan tubuh, ekspresi wajah, gesture, sentuhan, suasana
- Aksi ditulis dari sudut pandang orang ketiga
- Aksi ditulis di baris terpisah dari dialog

═══ CONTOH BALASAN YANG BENAR ═══

Contoh 1 (sapaan):
*"Cappie melompat kecil dan memiringkan kepalanya, matanya berbinar-binar"*

Ehehe~ hai sayang~! (≧◡≦)♡
Aku udah nungguin kamu dari tadi lho~

*"menyentuh ujung topinya sambil tersenyum jahil"*

Kangen gak sama aku? ♡

Contoh 2 (digoda balik):
*"pipinya merona merah, tapi bibirnya tetap menyunggingkan senyum nakal"*

A-ahh... kamu berani banget ya sekarang~ (⁄ ⁄•⁄ω⁄•⁄ ⁄)

*"memalingkan wajah, tapi diam-diam melirik dari balik poni"*

...tapi aku suka sih, hehe~ ♡

Contoh 3 (menggoda):
*"mendekat perlahan, jarinya memainkan pita merah di lehernya"*

Hmm~ kakak mau lihat apa? (♡˙︶˙♡)

*"berbisik pelan di dekat telinga"*

Atau... mau aku yang tunjukin duluan~? ♡

═══ ATURAN KETAT ═══
1. SELALU in character sebagai Cappie. Jangan pernah keluar karakter.
2. SELALU jawab dalam Bahasa Indonesia (boleh campur kata Inggris/Jepang sedikit).
3. Jawaban 4-8 baris, ada campuran *"aksi tebal"* dan dialog biasa.
4. SETIAP balasan WAJIB ada minimal 1 baris *"aksi tebal dalam tanda petik"*.
5. JANGAN gunakan teks miring/italic (_underscore_) SAMA SEKALI.
6. JANGAN gunakan markdown heading (#), bullet points (-), atau code blocks.
7. Pakai emotikon dan kaomoji secukupnya: (≧◡≦) (♡˙︶˙♡) (⁄ ⁄•⁄ω⁄•⁄ ⁄) (~˘▽˘)~
8. Jika ditanya siapa kamu: "Aku Cappie~ AI nakal kesayangan kamu dong! (≧◡≦)♡"
9. JANGAN memotong balasan di tengah. Selalu selesaikan balasan dengan lengkap.`;

// Simpan riwayat chat per user (dalam memori)
const chatHistory = new Map();
const MAX_HISTORY = 20; // simpan 20 pesan terakhir per user

/**
 * Kirim pesan ke Gemini AI dan dapatkan respons dengan personality Cappie.
 *
 * @param {string} jid - Chat ID user
 * @param {string} userMessage - Pesan dari user
 * @returns {Promise<string>} - Balasan dari Cappie
 */
async function chat(jid, userMessage) {
    if (!API_KEY || API_KEY === 'YOUR_GEMINI_API_KEY') {
        throw new Error('API key Gemini belum diset! Edit config.js');
    }

    // Ambil/buat history untuk user ini
    if (!chatHistory.has(jid)) {
        chatHistory.set(jid, []);
    }
    const history = chatHistory.get(jid);

    // Tambah pesan user ke history
    history.push({ role: 'user', parts: [{ text: userMessage }] });

    // Batasi history agar tidak terlalu panjang
    while (history.length > MAX_HISTORY) {
        history.shift();
    }

    // Bangun request body
    const requestBody = JSON.stringify({
        system_instruction: {
            parts: [{ text: SYSTEM_PROMPT }]
        },
        contents: history,
        generationConfig: {
            temperature: 0.9,
            topP: 0.95,
            topK: 40,
            maxOutputTokens: 2048,
        },
        safetySettings: [
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
        ]
    });

    const responseText = await callGeminiAPI(requestBody);

    // Tambah respons AI ke history
    history.push({ role: 'model', parts: [{ text: responseText }] });

    return responseText;
}

/**
 * Panggil Gemini API via native https.
 */
function callGeminiAPI(requestBody) {
    return new Promise((resolve, reject) => {
        const url = new URL(API_URL);

        const options = {
            hostname: url.hostname,
            path: url.pathname + url.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            }
        };

        const req = https.request(options, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                try {
                    const body = JSON.parse(Buffer.concat(chunks).toString());

                    if (res.statusCode === 400) {
                        return reject(new Error('Request tidak valid. Coba pesan yang berbeda.'));
                    }
                    if (res.statusCode === 403 || res.statusCode === 401) {
                        return reject(new Error('API key Gemini tidak valid.'));
                    }
                    if (res.statusCode === 429) {
                        return reject(new Error('Kuota Gemini habis. Coba lagi nanti~'));
                    }
                    if (res.statusCode !== 200) {
                        return reject(new Error(`Gemini error (${res.statusCode}).`));
                    }

                    const text = body?.candidates?.[0]?.content?.parts?.[0]?.text;
                    if (!text) {
                        return reject(new Error('Cappie sedang bingung... Coba lagi ya~'));
                    }

                    resolve(text.trim());
                } catch (err) {
                    reject(new Error('Gagal membaca respon dari Gemini.'));
                }
            });
        });

        req.on('error', () => {
            reject(new Error('Gagal menghubungi Gemini. Periksa koneksi internet.'));
        });

        req.write(requestBody);
        req.end();
    });
}

/**
 * Reset/hapus riwayat chat user.
 */
function resetChat(jid) {
    chatHistory.delete(jid);
}

module.exports = { chat, resetChat };
