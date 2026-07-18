# Map sprite atlas — build tooling

MapLibre needs a **sprite** — a packed PNG atlas plus a JSON index — to render
POI icons, road shields, and other symbol layers. The runtime files live at
`containers/frontend/public/maps-static/sprites/` and are what the browser
actually loads (via the `sprite` property in each map style at
`containers/frontend/public/maps-static/styles/*/style.json`). This directory
holds everything needed to **regenerate** them from source.

## When to run this

Rebuild the sprite when any of the following change:

- **Icon source SVGs** — you added or edited a file under `svgs/`.
- **Upstream Maki version** — bump `MAKI_VERSION` in `build.sh` (currently
  pinned to `v8.0.0`) and re-run.
- **OMT-class alias mapping** — you added a new mapping in the `OMT_ALIASES`
  dict inside `build.sh` (e.g. a new OpenMapTiles POI class value that isn't
  a direct Maki icon name).
- You changed a **protected icon** (see below).

You do **not** need to rebuild the sprite for normal app changes. The output
files are committed to the repo so contributors don't need this toolchain to
run the app.

## Prerequisites

The build script is Linux/macOS-friendly (`bash`), needs `curl`, `tar`,
`python3` with **Pillow**, and the **spreet** sprite builder on `PATH`.

**Install spreet** (any one of):

- `cargo install spreet` if you have the Rust toolchain
- `brew install flother/tap/spreet` on macOS
- Download the pre-built binary from
  [github.com/flother/spreet/releases](https://github.com/flother/spreet/releases)
  and put it on `PATH`. Example for Linux x86_64:
  ```
  curl -sSfL https://github.com/flother/spreet/releases/download/v0.13.1/spreet-x86_64-unknown-linux-musl.tar.gz | tar xz -C /tmp
  sudo mv /tmp/spreet /usr/local/bin/spreet
  spreet --version   # 0.13.1
  ```

**Install Pillow** (Python image library):
```
python3 -m pip install --user Pillow   # or your distro's python3-pil package
```

## Build

```
./build.sh
```

That's it. The script:

1. Fetches [Maki v8.0.0](https://github.com/mapbox/maki) into `tmp/` (cached
   after first run).
2. Rebuilds `svgs/` from scratch by combining:
   - **Protected icons** extracted from the current sprite (road shields,
     `oneway`, `wave`, ferry terminal, bicycle rental — things Maki doesn't
     supply under matching names). Extracted as base64-embedded SVGs so
     spreet can bundle them alongside real SVGs.
   - **Maki icons** renamed from `foo-bar.svg` to `foo_bar_11.svg` — the
     `_11` suffix and underscore convention the OpenMapTiles v3 style
     expects at runtime.
   - **OMT-class aliases** — extra `<class>_11.svg` files that map
     OpenMapTiles POI class values (`sports_centre`, `office`, `town_hall`,
     etc.) to the closest Maki icon, so POIs whose OSM class doesn't match a
     Maki filename still render an icon instead of triggering a
     `styleimagemissing` console warning.
3. Runs `spreet` twice — once at `--ratio 1`, once at `--retina` — and
   installs the four output files into
   `containers/frontend/public/maps-static/sprites/`:
   - `sprite.png` + `sprite.json` (1× — for standard-DPI devices)
   - `sprite@2x.png` + `sprite@2x.json` (2× — for retina / hi-DPI devices)

Commit the four output files plus any `svgs/` changes. Do **not** commit
`bin/` or `tmp/` — they're gitignored.

## Adding a custom icon

1. Drop `myicon_11.svg` into `svgs/`. Keep it around 15×15 (Maki's native
   size) so it doesn't render disproportionately large in the atlas.
2. Reference it from a style file (`containers/frontend/public/maps-static/styles/*/style.json`)
   in a symbol layer's `layout.icon-image`, e.g. `"icon-image": "myicon_11"`.
3. Run `./build.sh`.
4. Commit the updated sprite files + your new SVG.

**Note:** `./build.sh` rebuilds `svgs/` from scratch every run, so any
custom SVG you add must be re-created by the script or it'll disappear on
the next rebuild. In practice this means either:
- Add it to the `PROTECTED` allowlist (embeds it via extraction from the
  current sprite — okay for one-offs).
- Or add a rule to `build.sh` that copies it from a permanent source
  directory (best for icons you own and want to iterate on as real SVG).

## Editing which icons are protected

The `PROTECTED` set inside `build.sh` lists icons that must be preserved
verbatim from the current sprite instead of being regenerated from Maki.
It's a fixed constant so the build is idempotent — anything on the list
survives rebuild as an embedded PNG inside a wrapper SVG; anything **not**
on the list must come from either Maki or the `OMT_ALIASES` dict.

If you add an icon to `PROTECTED`, run the build once with the icon
already present in the current sprite so the script can extract it. From
then on it's frozen (further Maki upgrades won't touch it) unless you
remove it from the list.

## Adding an OMT-class alias

If MapLibre logs `Image "<class>_11" could not be loaded` for an
OpenMapTiles POI class that isn't yet aliased, add a line to the
`OMT_ALIASES` dict in `build.sh` mapping the class name to the closest
Maki icon stem (hyphenated, no size suffix — e.g. `'my_class': 'shop'`).
Re-run `./build.sh`.

## Debugging: what's in the current sprite?

```
python3 -c "import json; d=json.load(open('../../public/maps-static/sprites/sprite.json')); print(len(d), 'icons'); print('\n'.join(sorted(d)))"
```

## Licensing

Maki icons are CC0 (public domain dedication). The OpenMapTiles style JSON
files are BSD-3-Clause. See `containers/frontend/public/THIRD_PARTY_LICENSES.md`
for the full attribution and source pointers.
