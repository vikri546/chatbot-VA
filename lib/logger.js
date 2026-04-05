/**
 * Logger utility - Clean terminal activity log
 * Format: [HH:MM:SS] TYPE | message
 */

function timestamp() {
    const now = new Date();
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    const s = String(now.getSeconds()).padStart(2, '0');
    return `${h}:${m}:${s}`;
}

function formatUser(jid) {
    if (!jid) return '';
    // Ambil nomor dari jid (6281xxx@s.whatsapp.net → 6281xxx)
    return jid.split('@')[0];
}

const log = {
    info(msg) {
        console.log(`[${timestamp()}]  INFO | ${msg}`);
    },
    chat(jid, action, detail = '') {
        const user = formatUser(jid);
        const extra = detail ? ` — ${detail}` : '';
        console.log(`[${timestamp()}]  CHAT | ${user} > ${action}${extra}`);
    },
    done(jid, action) {
        const user = formatUser(jid);
        console.log(`[${timestamp()}]    OK | ${user} < ${action}`);
    },
    fail(jid, action, error = '') {
        const user = formatUser(jid);
        const extra = error ? ` — ${error}` : '';
        console.log(`[${timestamp()}]  FAIL | ${user} < ${action}${extra}`);
    },
    sys(msg) {
        console.log(`[${timestamp()}]   SYS | ${msg}`);
    },
    warn(msg) {
        console.log(`[${timestamp()}]  WARN | ${msg}`);
    }
};

module.exports = log;
