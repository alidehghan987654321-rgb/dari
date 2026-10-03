#!/usr/bin/env bash
# One-command setup of the product hunter (the sellers' website) on a fresh
# Ubuntu/Debian server. Log in as root and run:
#
#   curl -fsSL https://raw.githubusercontent.com/alidehghan987654321-rgb/dari/refs/heads/claude/trusting-cori-54e2u9/hunter/deploy/install.sh | bash
#
# It installs Docker, downloads the code to /opt/hunter, asks for the site's
# domain, then starts the website, the daily hunt and HTTPS. Running it again
# updates everything and keeps your settings and data. See hunter/DEPLOY.md.
set -euo pipefail

REPO="${HUNTER_REPO:-https://github.com/alidehghan987654321-rgb/dari.git}"
BRANCH="${HUNTER_BRANCH:-claude/trusting-cori-54e2u9}"
DIR="${HUNTER_DIR:-/opt/hunter}"
COMPOSE=(docker compose -f docker-compose.hunter.yml)

say() { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }
ask() { # ask VAR "question" [default]; reads from the terminal even under "curl | bash"
  local reply
  read -rp "$2" reply </dev/tty
  printf -v "$1" '%s' "${reply:-${3:-}}"
}
setting() { # setting NAME VALUE: set it in .env, adding the line if it's missing
  if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else printf '%s=%s\n' "$1" "$2" >> .env; fi
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
  domain="${HUNTER_DOMAIN:-}"
  until [[ "$domain" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$ ]]; do
    [ -n "$domain" ] && echo "Just the address please, e.g. shop.example.com (no https://)."
    ask domain "The site's address (e.g. shop.example.com): "
  done
  cp .env.example .env
  setting HUNTER_DOMAIN "$domain"
  setting HUNTER_PUBLIC_URL "https://$domain"
  setting HUNTER_PAYMENT zarinpal
  chmod 600 .env
fi
domain="$(sed -n 's/^HUNTER_DOMAIN=//p' .env)"

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  say "Opening ports 80 and 443 in the firewall"
  ufw allow 80/tcp && ufw allow 443/tcp
fi

say "Starting the website, the daily hunt and HTTPS (the first time takes a few minutes)"
"${COMPOSE[@]}" up -d --build

if ! "${COMPOSE[@]}" exec -T site python -c "from hunter.db import Database; import sys; sys.exit(0 if Database('/data/hunter.db').latest_hunt_time() else 1)"; then
  if grep -qE "^(KEEPA_API_KEY|APIFY_TOKEN)=.+" .env; then
    say "Running the first live hunt"
    "${COMPOSE[@]}" exec -T site python -m hunter hunt || echo "The hunt failed; see the output above and hunter/DEPLOY.md."
  else
    say "No data keys yet: loading the sample hunt so the site isn't empty"
    "${COMPOSE[@]}" exec -T site python -m hunter hunt --sample
  fi
fi

ip="$(curl -fsS -4 --max-time 10 https://api.ipify.org || hostname -I | awk '{print $1}')"
resolved="$(getent ahostsv4 "$domain" | awk 'NR==1 {print $1}' || true)"

say "Done"
if [ "$resolved" = "$ip" ]; then
  echo "Website: https://$domain (give it a minute to get its HTTPS certificate)"
else
  echo "One step left: add a DNS record for $domain at your domain's DNS provider:"
  echo
  echo "    Type: A    Name: $domain    Value: $ip    (Cloudflare: Proxy status 'DNS only')"
  echo
  echo "Then open https://$domain a minute or two later."
  [ -n "$resolved" ] && echo "(Right now $domain points to $resolved, not to this server.)"
fi
echo
echo "Next: sign up on the site, then make yourself the admin:"
echo "    cd $DIR && ${COMPOSE[*]} exec site python -m hunter make-admin YOUR@EMAIL"
echo "Keys (Keepa, Apify, Zarinpal) go in $DIR/.env; then run this script again."
echo "Logs: cd $DIR && ${COMPOSE[*]} logs -f"
