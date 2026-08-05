#!/bin/bash
set -e
REPO="$HOME/TIB-site"
SRC="$HOME/Library/Mobile Documents/com~apple~CloudDocs/Throttled In Bond/Brand/Web Development/Claude Dev HTML File Repository"
LATEST=$(ls -1 "$SRC"/tib-site-index_*.html | sort -V | tail -1)
echo "Deploying $(basename "$LATEST") ..."
cp "$LATEST" "$REPO/index.html"
for f in robots.txt llms.txt sitemap.xml; do
  [ -f "$SRC/$f" ] && cp "$SRC/$f" "$REPO/$f"
done
cd "$REPO"
git add -A
git commit -m "${1:-Update site}"
git pull --rebase origin main
git push origin main
echo "Done — live in 1-2 minutes."
