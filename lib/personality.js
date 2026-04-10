/**
 * ═══ Personality Manager ═══
 *
 * Mengelola pergantian personality chatbot AI.
 * Karakter disimpan di lib/prompts/mitas.js
 * Tidak ada koneksi ke Fandom — semua lokal.
 */

'use strict';

const { CHARACTERS, DEFAULT_CHARACTER } = require('./prompts/mitas');

// State per-user: active personality
const userPersonalities = new Map(); // jid → character key

/**
 * Daftar semua karakter yang tersedia.
 * Return array of { key, name }
 */
function listCharacters() {
    return Object.entries(CHARACTERS).map(([key, val]) => ({
        key,
        name: val.name,
        isDefault: key === DEFAULT_CHARACTER
    }));
}

/**
 * Cari karakter berdasarkan nama (case-insensitive, partial match).
 * Return { key, name } atau null.
 */
function findCharacter(query) {
    const q = query.toLowerCase().trim();

    // Exact match dulu
    if (CHARACTERS[q]) {
        return { key: q, name: CHARACTERS[q].name };
    }

    // Partial match
    const found = Object.entries(CHARACTERS).find(([key, val]) =>
        key.includes(q) || val.name.toLowerCase().includes(q)
    );

    return found ? { key: found[0], name: found[1].name } : null;
}

/**
 * Ambil prompt personality dari karakter.
 */
function getCharacterPrompt(key) {
    const char = CHARACTERS[key];
    return char ? char.prompt : CHARACTERS[DEFAULT_CHARACTER].prompt;
}

/**
 * Set personality aktif untuk user.
 */
function setUserPersonality(jid, characterKey) {
    userPersonalities.set(jid, characterKey);
}

/**
 * Ambil personality aktif user.
 * Return { key, name } atau default.
 */
function getUserPersonality(jid) {
    const key = userPersonalities.get(jid) || DEFAULT_CHARACTER;
    const char = CHARACTERS[key];
    return {
        key,
        name: char ? char.name : CHARACTERS[DEFAULT_CHARACTER].name,
        isDefault: key === DEFAULT_CHARACTER
    };
}

/**
 * Reset personality ke default.
 */
function resetUserPersonality(jid) {
    userPersonalities.delete(jid);
}

/**
 * Ambil prompt aktif untuk user (untuk dipakai di gemini.js).
 */
function getActivePrompt(jid) {
    const key = userPersonalities.get(jid) || DEFAULT_CHARACTER;
    return getCharacterPrompt(key);
}

/**
 * Ambil info karakter (nama + bagian PENAMPILAN dan KEPRIBADIAN dari prompt).
 */
function getCharacterInfo(query) {
    const found = findCharacter(query);
    if (!found) return null;

    const char = CHARACTERS[found.key];
    const prompt = char.prompt;

    // Extract PENAMPILAN section
    const appearMatch = prompt.match(/═══ PENAMPILAN ═══\n([\s\S]*?)(?=\n═══)/);
    const appear = appearMatch ? appearMatch[1].trim() : 'Tidak tersedia.';

    // Extract KEPRIBADIAN section
    const persMatch = prompt.match(/═══ KEPRIBADIAN ═══\n([\s\S]*?)(?=\n═══)/);
    const pers = persMatch ? persMatch[1].trim() : 'Tidak tersedia.';

    return {
        key: found.key,
        name: char.name,
        appearance: appear,
        personality: pers
    };
}

module.exports = {
    listCharacters,
    findCharacter,
    getCharacterPrompt,
    getCharacterInfo,
    setUserPersonality,
    getUserPersonality,
    resetUserPersonality,
    getActivePrompt,
    DEFAULT_CHARACTER
};
