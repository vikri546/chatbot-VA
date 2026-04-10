#!/bin/bash
# ══════════════════════════════════════
#  Termux Setup Script - Chatbot VA
# ══════════════════════════════════════

echo "══════════════════════════════════════"
echo "  Setup Chatbot VA untuk Termux"
echo "══════════════════════════════════════"
echo ""

# 1. Update & upgrade packages
echo "📦 [1/9] Updating packages..."
pkg update -y && pkg upgrade -y

# 2. Install Node.js, Git, FFmpeg, Python & build tools
echo "📦 [2/9] Installing core packages & build tools..."
pkg install nodejs git ffmpeg python make clang pkg-config libvips -y

# 3. Install yt-dlp via pip
echo "📦 [3/9] Installing yt-dlp..."
pip install yt-dlp

# 4. Install X11 repo & xorgproto (dependency untuk native modules)
echo "📦 [4/9] Installing X11 repo & xorgproto..."
pkg install x11-repo -y && pkg install xorgproto -y

# 5. Install node-gyp (global & lokal)
echo "📦 [5/9] Installing node-gyp..."
npm install -g node-gyp
npm install node-gyp

# 6. Install node-addon-api
echo "📦 [6/9] Installing node-addon-api..."
npm install node-addon-api

# 7. Bersihkan cache npm
echo "📦 [7/9] Cleaning npm cache..."
npm cache clean --force

# 8. Install baileys dengan --ignore-scripts
echo "📦 [8/9] Installing @whiskeysockets/baileys..."
npm install @whiskeysockets/baileys@latest --ignore-scripts

# 9. Install sisa npm dependencies
echo "📦 [9/9] Installing remaining dependencies..."
npm install

# Selesai
echo ""
echo "══════════════════════════════════════"
echo "  ✅ Setup selesai!"
echo "══════════════════════════════════════"
echo ""
echo "Ulangi instalasi node-gyp dan node-addon-api jika ada error"
echo ""
echo "Jalankan bot dengan:"
echo "  node index.js"
echo ""