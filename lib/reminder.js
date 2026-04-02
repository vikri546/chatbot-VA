/**
 * Modul Reminder/Pengingat
 * Menyimpan pengingat di memori dan mengirim notifikasi saat waktunya tiba.
 */

// Simpan semua active reminders { id: { jid, text, timer, createdAt, duration } }
const activeReminders = new Map();
let reminderCounter = 0;

/**
 * Parse durasi dari string ke milliseconds.
 * Format yang didukung:
 *   30d  → 30 detik
 *   30m  → 30 menit
 *   2j   → 2 jam
 *   1h   → 1 jam (alias)
 *   1s   → 1 detik (alias)
 *
 * @param {string} input - String durasi (contoh: "30m", "2j", "1h")
 * @returns {{ ms: number, label: string } | null}
 */
function parseDuration(input) {
    const match = input.match(/^(\d+)(d|m|j|h|s)$/i);
    if (!match) return null;

    const value = parseInt(match[1]);
    const unit = match[2].toLowerCase();

    const units = {
        'd': { ms: 1000, label: 'detik' },
        's': { ms: 1000, label: 'detik' },
        'm': { ms: 60 * 1000, label: 'menit' },
        'j': { ms: 60 * 60 * 1000, label: 'jam' },
        'h': { ms: 60 * 60 * 1000, label: 'jam' },
    };

    const u = units[unit];
    if (!u || value <= 0) return null;

    // Max 24 jam
    const ms = value * u.ms;
    if (ms > 24 * 60 * 60 * 1000) return null;

    return { ms, label: `${value} ${u.label}` };
}

/**
 * Set reminder baru.
 *
 * @param {string} jid - Chat ID tujuan
 * @param {number} delayMs - Delay dalam milliseconds
 * @param {string} text - Pesan pengingat
 * @param {Function} callback - Fungsi yang dipanggil saat reminder aktif: callback(jid, text, id)
 * @returns {number} - ID reminder
 */
function setReminder(jid, delayMs, text, callback) {
    const id = ++reminderCounter;

    const timer = setTimeout(() => {
        callback(jid, text, id);
        activeReminders.delete(id);
    }, delayMs);

    activeReminders.set(id, {
        jid,
        text,
        timer,
        createdAt: Date.now(),
        duration: delayMs
    });

    return id;
}

/**
 * Hapus reminder berdasarkan ID.
 *
 * @param {number} id - ID reminder
 * @returns {boolean} - true jika berhasil dihapus
 */
function cancelReminder(id) {
    const reminder = activeReminders.get(id);
    if (!reminder) return false;

    clearTimeout(reminder.timer);
    activeReminders.delete(id);
    return true;
}

/**
 * Dapatkan daftar reminder aktif untuk JID tertentu.
 *
 * @param {string} jid - Chat ID
 * @returns {Array<{ id: number, text: string, remainingMs: number }>}
 */
function getReminders(jid) {
    const result = [];
    const now = Date.now();

    for (const [id, r] of activeReminders) {
        if (r.jid === jid) {
            const elapsed = now - r.createdAt;
            const remaining = Math.max(0, r.duration - elapsed);
            result.push({
                id,
                text: r.text,
                remainingMs: remaining
            });
        }
    }

    return result;
}

/**
 * Format milliseconds ke string yang readable.
 */
function formatRemaining(ms) {
    const totalSeconds = Math.ceil(ms / 1000);
    if (totalSeconds < 60) return `${totalSeconds} detik`;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}d` : `${minutes} menit`;
    const hours = Math.floor(minutes / 60);
    const remainMinutes = minutes % 60;
    return remainMinutes > 0 ? `${hours}j ${remainMinutes}m` : `${hours} jam`;
}

module.exports = { parseDuration, setReminder, cancelReminder, getReminders, formatRemaining };
