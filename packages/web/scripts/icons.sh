#!/usr/bin/env bash
# Regenerates the logo and every icon under public/ from the two brand
# lockups in src/brand/ (transparent PNGs of the full "purview" wordmark):
#
#   lockup-light.png  pale ink, for dark themes (printed in white here)
#   lockup-dark.png   navy ink, for light themes
#
# The eye mark is cropped off the left of the light lockup and set on the
# app's dark background: rounded for favicons and PWA icons, full-bleed (with
# the safe-zone margin) for the maskable and Apple touch icons.
#
# Usage: packages/web/scripts/icons.sh   (needs ImageMagick 7: `magick`)
set -euo pipefail

cd "$(dirname "$0")/.."
BRAND=src/brand
PUBLIC=public
BG="#0c0d10"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Drop the generator's near-invisible halo (alpha under 5%), then trim.
clean() { magick "$1" -channel A -fx 'a<0.05?0:a' +channel -trim +repage "$2"; }

clean "$BRAND/lockup-light.png" "$TMP/lockup-light.png"
clean "$BRAND/lockup-dark.png" "$TMP/lockup-dark.png"
# The pale ink reads washed out on dark themes: make it white. It is the only
# low-chroma color in the lockup, so the cyan accent is left untouched.
magick "$TMP/lockup-light.png" -channel RGB \
  -fx 'max(max(r,g),b) - min(min(r,g),b) < 0.4 ? 1 : u' +channel "$TMP/lockup-light.png"

# The home-screen logos: 96px tall (4x the 24px they render at).
for ink in light dark; do
  magick "$TMP/lockup-$ink.png" -resize x96 -strip "src/assets/logo-$ink.png"
done

# The mark: everything left of the wordmark's "p".
magick "$TMP/lockup-light.png" -crop 700x10000+0+0 +repage -trim +repage "$TMP/mark.png"

# icon <size> <mark width as % of size> <corner radius as % of size> <out>
icon() {
  local size=$1 pct=$2 radius=$3 out=$4
  local w=$((size * pct / 100)) r=$((size * radius / 100)) tile
  # A zero-radius roundrectangle draws nothing, so full-bleed is a plain fill.
  if [ "$r" -eq 0 ]; then tile=(xc:"$BG"); else
    tile=(xc:none -fill "$BG" -draw "roundrectangle 0,0 $((size - 1)),$((size - 1)) $r,$r"); fi
  magick -size "${size}x${size}" "${tile[@]}" \
    \( "$TMP/mark.png" -resize "${w}x" \) -gravity center -composite \
    -strip "$out"
}

icon 512 72 22 "$PUBLIC/pwa-512x512.png"
icon 192 72 22 "$PUBLIC/pwa-192x192.png"
icon 512 56 0 "$PUBLIC/maskable-icon-512x512.png"
icon 192 56 0 "$PUBLIC/maskable-icon-192x192.png"
icon 180 68 0 "$PUBLIC/apple-touch-icon.png"
# Tab-sized: the mark fills more of the tile, or its strokes blur away.
icon 48 84 20 "$TMP/48.png"
icon 32 84 20 "$PUBLIC/favicon-32x32.png"
icon 16 90 18 "$PUBLIC/favicon-16x16.png"
magick "$PUBLIC/favicon-16x16.png" "$PUBLIC/favicon-32x32.png" "$TMP/48.png" "$PUBLIC/favicon.ico"
