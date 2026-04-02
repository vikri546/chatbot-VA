#!/bin/bash
# ══════════════════════════════════════
#  Termux Setup Script - Chatbot VA
# ══════════════════════════════════════

echo "══════════════════════════════════════"
echo "  Setup Chatbot VA untuk Termux"
echo "══════════════════════════════════════"
echo ""

# 1. Update & upgrade packages
echo "📦 Updating packages..."
pkg update -y && pkg upgrade -y

# 2. Install Node.js, Git, FFmpeg & yt-dlp
echo "📦 Installing Node.js, Git, FFmpeg & yt-dlp..."
pkg install nodejs git ffmpeg python -y
pip install yt-dlp

# 3. Install npm dependencies
echo "📦 Installing npm dependencies..."
npm install

# 4. Selesai
echo ""
echo "══════════════════════════════════════"
echo "  ✅ Setup selesai!"
echo "══════════════════════════════════════"
echo ""
echo "Jalankan bot dengan:"
echo "  node index.js"
echo ""
