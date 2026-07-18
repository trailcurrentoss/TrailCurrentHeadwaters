#!/usr/bin/env bash
# Rebuild the MapLibre sprite atlas served at /maps-static/sprites/*.
#
# When to run this:
#   - You bumped MAKI_VERSION below to pick up upstream icon changes.
#   - You added or edited an SVG under svgs/ (custom icons, OMT-class aliases).
#   - You want to reproduce the sprite from scratch to verify determinism.
#
# What this does:
#   1. Fetches Maki icons at $MAKI_VERSION into tmp/maki-*/ (skipped if present).
#   2. Rebuilds svgs/ from scratch — merges Maki icons (renamed to the
#      "<class>_11" convention the OpenMapTiles style expects) with icons
#      preserved from the current sprite (road shields, oneway, wave, etc.)
#      and OMT-class aliases (e.g. sports_centre → Maki 'pitch').
#   3. Runs spreet to produce sprite.{png,json} and sprite@2x.{png,json}
#      into ../../public/maps-static/sprites/.
#
# Requirements: bash, curl, tar, python3 (with Pillow), spreet on PATH.
# See README.md in this directory for install pointers.

set -euo pipefail

MAKI_VERSION="v8.0.0"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP_DIR="$SCRIPT_DIR/tmp"
SVGS_DIR="$SCRIPT_DIR/svgs"
DEST_DIR="$SCRIPT_DIR/../../public/maps-static/sprites"

# --- preflight ------------------------------------------------------------

need() {
    command -v "$1" >/dev/null 2>&1 || {
        echo "error: '$1' not found on PATH." >&2
        echo "  install pointers are in $SCRIPT_DIR/README.md" >&2
        exit 1
    }
}
need curl
need tar
need python3
need spreet

python3 -c "from PIL import Image" 2>/dev/null || {
    echo "error: Pillow (python3 PIL module) is required." >&2
    echo "  install with: python3 -m pip install --user Pillow" >&2
    echo "  or your distro's package (Debian/Ubuntu: sudo apt install python3-pil)" >&2
    exit 1
}

[ -d "$DEST_DIR" ] || {
    echo "error: destination $DEST_DIR does not exist." >&2
    echo "  are you running this from a clean checkout?" >&2
    exit 1
}

# --- fetch Maki -----------------------------------------------------------

MAKI_DIR="$TMP_DIR/maki-${MAKI_VERSION#v}"
if [ ! -d "$MAKI_DIR/icons" ]; then
    echo "==> fetching Maki $MAKI_VERSION"
    mkdir -p "$TMP_DIR"
    curl -sSfL "https://github.com/mapbox/maki/archive/refs/tags/${MAKI_VERSION}.tar.gz" \
        -o "$TMP_DIR/maki.tar.gz"
    tar xzf "$TMP_DIR/maki.tar.gz" -C "$TMP_DIR"
    rm "$TMP_DIR/maki.tar.gz"
fi
echo "==> Maki icons available at $MAKI_DIR/icons ($(ls "$MAKI_DIR/icons" | wc -l) files)"

# --- rebuild svgs/ --------------------------------------------------------

echo "==> rebuilding svgs/ from scratch"
rm -rf "$SVGS_DIR"
mkdir -p "$SVGS_DIR"

python3 - "$MAKI_DIR/icons" "$DEST_DIR" "$SVGS_DIR" << 'PYEOF'
"""Merge Maki icons + preserved sprite cutouts + OMT aliases into svgs/."""
import base64, fnmatch, io, json, os, re, shutil, sys
from PIL import Image

maki_dir, dest_dir, svgs_dir = sys.argv[1], sys.argv[2], sys.argv[3]

# 1) Preserve a fixed allowlist of icons from the CURRENT sprite. These are
#    project-custom / non-Maki icons (road shields, oneway arrow, wave
#    pattern, ferry terminals, etc.) that must survive rebuild. Everything
#    NOT on this list is regenerated from Maki + OMT aliases below — that
#    way an alias like sports_centre_11 stays a crisp Maki SVG on re-run
#    instead of getting frozen as a raster embed of the previous rebuild.
PROTECTED = {
    'oneway', 'wave', 'railway_11', 'ferry_terminal_11', 'bicycle_rental_11',
    # US road shields — style-specific artwork not in Maki
    'road_1', 'road_2', 'road_3', 'road_4', 'road_5', 'road_6',
    'us-highway_1', 'us-highway_2', 'us-highway_3',
    'us-interstate_1', 'us-interstate_2', 'us-interstate_3',
    'us-state_1', 'us-state_2', 'us-state_3',
    'us-state_4', 'us-state_5', 'us-state_6',
}

with open(os.path.join(dest_dir, 'sprite.json')) as f:
    sprite_meta = json.load(f)
img = Image.open(os.path.join(dest_dir, 'sprite.png')).convert('RGBA')
maki_names = {os.path.splitext(f)[0] for f in os.listdir(maki_dir) if f.endswith('.svg')}

preserved = 0
for name in PROTECTED:
    if name not in sprite_meta:
        # Sprite doesn't have this protected icon — likely a first build
        # after adding it to the list. Warn but continue.
        print(f'  warning: protected icon {name!r} not in current sprite; skipping')
        continue
    meta = sprite_meta[name]
    x, y, w, h = meta['x'], meta['y'], meta['width'], meta['height']
    buf = io.BytesIO()
    img.crop((x, y, x + w, y + h)).save(buf, format='PNG')
    b64 = base64.b64encode(buf.getvalue()).decode('ascii')
    svg = (
        f'<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<svg xmlns="http://www.w3.org/2000/svg" '
        f'xmlns:xlink="http://www.w3.org/1999/xlink" '
        f'width="{w}" height="{h}" viewBox="0 0 {w} {h}">\n'
        f'  <image width="{w}" height="{h}" '
        f'xlink:href="data:image/png;base64,{b64}"/>\n'
        f'</svg>\n'
    )
    with open(os.path.join(svgs_dir, f'{name}.svg'), 'w') as out:
        out.write(svg)
    preserved += 1

# 2) Copy Maki SVGs, renaming <foo-bar>.svg → <foo_bar>_11.svg to match
#    the "{class}_11" naming the OpenMapTiles style expects at runtime.
existing = set(os.listdir(svgs_dir))
copied = 0
for fn in sorted(os.listdir(maki_dir)):
    if not fn.endswith('.svg'):
        continue
    dest_name = f'{fn[:-4].replace("-", "_")}_11.svg'
    if dest_name in existing:
        continue
    shutil.copy(os.path.join(maki_dir, fn), os.path.join(svgs_dir, dest_name))
    copied += 1

# 3) OMT-class aliases: OpenMapTiles emits POI class values (e.g. 'sports_centre',
#    'office', 'town_hall') that don't 1:1-match Maki filenames. Map each to
#    the closest Maki source so those POIs render an icon instead of tripping
#    a styleimagemissing warning.
OMT_ALIASES = {
    'sports_centre': 'pitch',            'stadium': 'stadium',
    'swimming_pool': 'swimming',         'water_park': 'swimming',
    'place_of_worship': 'religious-christian',
    'religious_christian': 'religious-christian',
    'religious_muslim': 'religious-muslim',
    'religious_jewish': 'religious-jewish',
    'office': 'commercial',              'town_hall': 'town-hall',
    'college': 'college',                'kindergarten': 'school',
    'convention_centre': 'town-hall',    'community_centre': 'town-hall',
    'arts_centre': 'art-gallery',        'nightclub': 'bar',
    'food_court': 'restaurant',          'fast_food': 'fast-food',
    'ice_cream': 'ice-cream',            'guest_house': 'lodging',
    'apartment': 'lodging',              'chalet': 'lodging',
    'alpine_hut': 'shelter',             'wilderness_hut': 'shelter',
    'camp_site': 'campsite',             'caravan_site': 'campsite',
    'picnic_site': 'picnic-site',        'viewpoint': 'viewpoint',
    'monument': 'monument',              'memorial': 'monument',
    'archaeological_site': 'attraction', 'artwork': 'art-gallery',
    'attraction': 'attraction',          'castle': 'castle',
    'ruins': 'castle',                   'zoo': 'zoo',
    'theme_park': 'amusement-park',      'amusement_arcade': 'amusement-park',
    'water_slide': 'swimming',           'clinic': 'hospital',
    'doctors': 'doctor',                 'social_facility': 'town-hall',
    'nursing_home': 'lodging',           'bureau_de_change': 'bank',
    'atm': 'bank',                       'post_office': 'post',
    'post_box': 'post',                  'letter_box': 'post',
    'vending_machine': 'convenience',    'marketplace': 'grocery',
    'grocery': 'grocery',                'convenience': 'convenience',
    'supermarket': 'grocery',            'department_store': 'shop',
    'mall': 'shop',                      'shop': 'shop',
    'fuel': 'fuel',                      'charging_station': 'charging-station',
    'parking': 'parking',                'bicycle_parking': 'bicycle',
    'car_wash': 'car',                   'car_rental': 'car',
    'car_repair': 'car-repair',          'taxi': 'car',
    'boat_rental': 'harbor',             'ferry': 'ferry',
    'harbor': 'harbor',                  'lighthouse': 'lighthouse',
    'water': 'drinking-water',           'drinking_water': 'drinking-water',
    'shower': 'toilet',                  'toilets': 'toilet',
    'waste_basket': 'waste-basket',      'recycling': 'recycling',
    'bench': 'bench',                    'shelter': 'shelter',
    'telephone': 'telephone',            'fountain': 'fountain',
    'clock': 'clock',                    'information': 'information',
    'guidepost': 'information',          'bicycle_repair_station': 'bicycle',
    'compressed_air': 'car-repair',      'firehose': 'fire-station',
    'fire_extinguisher': 'fire-station', 'defibrillator': 'hospital',
    'emergency_phone': 'emergency-phone','siren': 'emergency-phone',
    'hunting_stand': 'observation-tower','watchtower': 'observation-tower',
    'observation_tower': 'observation-tower',
    'communications_tower': 'communications-tower',
    'water_tower': 'water',              'water_well': 'water',
    'mineshaft': 'mine',                 'adit': 'mine',
    'mine': 'mine',                      'quarry': 'landmark',
    'natural': 'landmark',               'peak': 'mountain',
    'mountain': 'mountain',              'volcano': 'volcano',
    'saddle': 'mountain',                'cave_entrance': 'entrance',
    'entrance': 'entrance',              'toll_booth': 'toll',
    # Land-use / natural-area classes — OMT surfaces these through the same
    # {class}_11 icon lookup as POIs, so they need aliases even though they
    # aren't strictly "point-of-interest" categories.
    'brownfield': 'landuse',             'landuse': 'landuse',
    'residential': 'landuse',            'commercial': 'commercial',
    'industrial': 'industry',            'retail': 'shop',
    'military': 'landmark',              'construction': 'construction',
    'farmland': 'farm',                  'farmyard': 'farm',
    'orchard': 'farm',                   'vineyard': 'farm',
    'allotments': 'farm',                'greenhouse_horticulture': 'farm',
    'meadow': 'park',                    'grass': 'park',
    'forest': 'park',                    'wood': 'park',
    'scrub': 'natural',                  'heath': 'natural',
    'wetland': 'wetland',                'beach': 'beach',
    'nature_reserve': 'landmark',        'protected_area': 'landmark',
    'grave_yard': 'cemetery',            'ice_rink': 'skateboard',
    'pitch': 'pitch',                    'park': 'park',
    'garden': 'garden',                  'dog_park': 'dog-park',
    'playground': 'playground',
}
alias_written = 0
alias_missing = []
for alias, maki_stem in OMT_ALIASES.items():
    src = os.path.join(maki_dir, f'{maki_stem}.svg')
    dest_name = f'{alias}_11.svg'
    dest_path = os.path.join(svgs_dir, dest_name)
    if not os.path.exists(src):
        alias_missing.append((alias, maki_stem))
        continue
    if os.path.exists(dest_path):
        continue
    shutil.copy(src, dest_path)
    alias_written += 1

total = len([f for f in os.listdir(svgs_dir) if f.endswith('.svg')])
print(f'  preserved {preserved} non-Maki icons from existing sprite')
print(f'  copied {copied} Maki v8 icons')
print(f'  wrote {alias_written} OMT-class aliases '
      f'({len(alias_missing)} aliases skipped — Maki source missing)')
print(f'  total SVGs: {total}')
PYEOF

# --- run spreet -----------------------------------------------------------

OUT="$TMP_DIR/out"
rm -rf "$OUT"
mkdir -p "$OUT"

echo "==> spreet @1x"
spreet --ratio 1 "$SVGS_DIR" "$OUT/sprite"
echo "==> spreet @2x"
spreet --retina  "$SVGS_DIR" "$OUT/sprite@2x"

# --- install into public/ -------------------------------------------------

echo "==> installing sprite files into $DEST_DIR"
cp "$OUT/sprite.png"     "$DEST_DIR/sprite.png"
cp "$OUT/sprite.json"    "$DEST_DIR/sprite.json"
cp "$OUT/sprite@2x.png"  "$DEST_DIR/sprite@2x.png"
cp "$OUT/sprite@2x.json" "$DEST_DIR/sprite@2x.json"

# --- report ---------------------------------------------------------------

icon_count=$(python3 -c "import json,sys; print(len(json.load(open('$DEST_DIR/sprite.json'))))")
echo
echo "done. sprite atlas has $icon_count icons."
echo "commit the updated sprite files + any new svgs/ changes."
