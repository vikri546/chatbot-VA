const QRCode = require('qrcode');

/**
 * Generate QR code dari teks/URL, return sebagai buffer PNG.
 *
 * @param {string} text - Teks atau URL untuk di-encode ke QR
 * @returns {Promise<Buffer>} - Buffer gambar PNG QR code
 */
async function generateQR(text) {
    const buffer = await QRCode.toBuffer(text, {
        type: 'png',
        width: 512,
        margin: 2,
        color: {
            dark: '#000000',
            light: '#FFFFFF'
        },
        errorCorrectionLevel: 'M'
    });

    return buffer;
}

module.exports = { generateQR };
