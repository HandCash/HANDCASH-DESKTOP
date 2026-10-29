#!/usr/bin/env bash
# WebKitGTK + build tools for native-desktop (handcash-shell) on Ubuntu CI.
set -euo pipefail
sudo apt-get update
sudo apt-get install -y \
  build-essential \
  curl \
  file \
  libayatana-appindicator3-dev \
  libgtk-3-dev \
  librsvg2-dev \
  libssl-dev \
  libwebkit2gtk-4.1-dev \
  libxdo-dev \
  wget \
  zip
