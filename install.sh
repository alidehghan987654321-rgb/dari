#!/usr/bin/env bash
# One-command setup on a fresh Ubuntu/Debian server. Log in as root and run:
#
 bash$| bash
#
# It installs Docker, downloads the code to /opt/dari, asks for the bot token
# and the website's domain, then starts the bot, the website and HTTPS.
# Running it again updates everything and keeps your settings.
set -euo pipefail

REPO="${DARI_REPO:-https://github.com/alidehghan987654321-rgb/dari.git}"
BRANCH="${DARI_BRANCH:-claude/telegram-video-downloader-bot-xwpwbv}"
DIR="${DARI_DIR:-/opt/dari}"

say() { printf '\n\033[1;35m==> %s\033[0m\n' "$*"; }
ask() { # ask VAR "question" [default]; reads from the terminal even under "curl | bash"
  local reply
  read -rp "$2" reply </dev/tty
  printf -v "$1" '%s' "${reply:-${3:-}}"
}

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run as root (e.g. 'sudo -i' first)." >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  say "Installing Docker"
  curl -fsSL https://get.docker.com | sh
fi
if ! command -v git >/dev/null 2>&1; then
  say "Installing git"
  apt-get update -qq && apt-get install -y -qq git
fi

if [ -d "$DIR/.git" ]; then
  say "Updating the code in $DIR"
  git -C "$DIR" pull --ff-only
else
  say "Downloading the code to $DIR"
  git clone -b "$BRANCH" "$REPO" "$DIR"
fi
cd "$DIR"

if [ ! -f .env ]; then
  say "Settings"
  token="${BOT_TOKEN:-}"
  until [[ "$token" =~ ^[0-9]+:[A-Za-z0-9_-]{30,}$ ]]; do
    [ -n "$token" ] && echo "That doesn't look like a bot token (e.g. 123456789:AAH...)."
    ask token "Telegram bot token from @BotFather: "
  done
  domain="${DOMAIN:-}"
  until [[ "$domain" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]]; do
    [ -n "$domain" ] && echo "Just the address please, e.g. dl.gryffin.uk (no https://)."
    ask domain "Website address [dl.gryffin.uk]: " "dl.gryffin.uk"
  done
  cp .env.example .env
  sed -i "s|^BOT_TOKEN=.*|BOT_TOKEN=$token|; s|^DOMAIN=.*|DOMAIN=$domain|" .env
  chmod 600 .env
fi
domain="$(sed -n 's/^DOMAIN=//p' .env)"

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  say "Opening ports 80 and 443 in the firewall"
  ufw allow 80/tcp && ufw allow 443/tcp
fi

say "Starting the bot, the website and HTTPS (the first time takes a few minutes)"
docker compose up -d --build

ip="$(curl -fsS -4 --max-time 10 https://api.ipify.org || hostname -I | awk '{print $1}')"
resolved="$(getent ahostsv4 "$domain" | awk 'NR==1 {print $1}' || true)"

say "Done"
echo "Telegram bot: running. Send it /start."
if [ "$resolved" = "$ip" ]; then
  echo "Website: https://$domain (give it a minute to get its HTTPS certificate)"
else
  echo "Website: one step left. In Cloudflare -> $domain's zone -> DNS -> Add record:"
  echo
  echo "    Type: A    Name: $domain    IPv4 address: $ip    Proxy status: DNS only"
  echo
  echo "Then open https://$domain a minute or two later."
  [ -n "$resolved" ] && echo "(Right now $domain points to $resolved, not to this server.)"
fi
echo
echo "Logs: cd $DIR && docker compose logs -f"
