#!/usr/bin/env bash
# ==============================================================================
# VM 5: Setup & Hardening Script for Proxmox Challenge Execution Host
# ==============================================================================

set -euo pipefail

echo "=========================================================="
echo " Setting up VM 5 (Challenge Execution Host) on Proxmox VE"
echo "=========================================================="

if [ "$EUID" -ne 0 ]; then
  echo "[!] Please run with root privileges (sudo bash setup-challenge-host.sh)"
  exit 1
fi

CORE_BACKEND_IP="${1:-192.168.200.13}" # IP of VM 3

echo "[+] Updating apt repositories and installing prerequisites..."
apt-get update -y
apt-get install -y curl git ufw jq net-tools

# 1. Install Docker Engine
if ! command -v docker &> /dev/null; then
  echo "[+] Installing official Docker Engine..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
else
  echo "[+] Docker is already installed."
fi

# 2. Firewall Hardening: Only allow VM 3 to access Docker Socket Proxy on port 2375
echo "[+] Configuring UFW firewall rules for Docker API safety..."
ufw default deny incoming
ufw default allow outgoing

# Allow HTTP and HTTPS ingress from students/instructors
ufw allow 80/tcp comment 'Traefik HTTP Ingress'
ufw allow 443/tcp comment 'Traefik HTTPS Ingress'
ufw allow 22/tcp comment 'SSH Access'

# Allow Docker API (port 2375) ONLY from VM 3 (Core Backend)
ufw allow from "$CORE_BACKEND_IP" to any port 2375 proto tcp comment 'Docker API from VM 3'
echo "y" | ufw enable || true

# 3. Pre-pull the target image to ensure instantaneous student environment spins
echo "[+] Pre-pulling OWASP Juice Shop target image..."
docker pull bkimminich/juice-shop:v16.0.0

echo "=========================================================="
echo " VM 5 Setup Complete!"
echo " Next: Start Traefik and Socket Proxy with 'docker compose up -d'"
echo "=========================================================="

