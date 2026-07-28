# Updating maps on a Headwaters device

Headwaters ships without any map data pre-installed. Every device gets its maps by uploading a **map bundle** through the PWA. Same process for the first-time install and every future update — one flow to learn.

A map bundle is a single `.zip` produced by `build/maps/build.sh` on your dev machine. It contains everything the device needs to render maps, search for places, and compute driving routes — 100% offline:

- `tiles.pmtiles` — vector map tiles (PMTiles v3)
- `photon_data.tar` — search index (Photon geocoder); unpacked to `photon_data/` on the device
- `valhalla_tiles.tar` — routing tiles (Valhalla); **stays packed** on the device
- `manifest.json` — region, build date, per-artifact SHA256s

Routing reads its tiles straight out of `valhalla_tiles.tar`, so the device deliberately leaves that one packed instead of unpacking it. Unpacking it is what caused long routes to freeze the device in July 2026 — see [`LongRouteFreeze.md`](LongRouteFreeze.md).

If you're just getting started, you'll build a bundle once, upload it once, and never think about it again until you want fresher OSM data or a new region.

---

## Prerequisites

**On your build machine** (Linux, macOS, or WSL2):

- Docker Engine + Docker Compose v2 plugin
- ~600 GB free disk (working space for North America; less for smaller regions — see the sizing table in [`build/maps/README.md`](../build/maps/README.md))
- A reasonable CPU. First-time NA build is ~6–12 hours; subsequent runs skip already-built stages and finish in minutes.

**On the device:**

- Storage: **512 GB or 1 TB NVMe recommended** — a full North America bundle is ~130 GB and needs headroom for extraction + one retained previous version for rollback.
- The PWA reachable from a browser (typically `https://headwaters.local`).

---

## First-time install

The very first bundle upload on a fresh device is exactly the same as any subsequent update. The device boots without any map data, and the map area of the PWA shows "No map data installed — go to Maps page to install" until you upload.

1. **Pick your region.** The plan ships with several presets:

   | Region YAML | Description | Approx. bundle size |
   |---|---|---|
   | `north-america.yaml` | US + Canada + Mexico (default) | ~130 GB |
   | `united-states.yaml` | US only | ~123 GB |
   | `california.yaml` | California only (fast for testing) | ~91 GB |
   | `europe.yaml` | Europe | ~133 GB |
   | `japan.yaml` | Japan | ~10 GB |
   | `australia.yaml` | Australia | ~12 GB |

   You can also **add your own** — copy any of the shipped YAMLs, edit the Geofabrik URL + bounding box, and it's picked up automatically. See ["Add a new region"](../build/maps/README.md#adding-a-new-region) in the build README.

2. **Build the bundle on your dev machine.** From the repo root:

   ```bash
   ./build/maps/build.sh --region north-america
   ```

   First run pulls docker images, downloads the OSM extract, and builds tiles — expect several hours for NA. Subsequent runs skip already-built stages. Output lands at `build/maps/dist/maps-<date>.zip`.

3. **Verify the bundle** (optional but recommended before every upload):

   ```bash
   ./build/maps/verify-bundle.sh
   ```

   Checks that the manifest matches, all four artifacts are present, and every SHA256 checksum is correct. Takes a few minutes.

4. **Upload to the device** via the PWA:

   1. Open `https://<device>.local/` in a browser.
   2. Sidebar → **Maps**.
   3. Under **Upload Map Bundle**, click **Browse** and pick your `maps-<date>.zip`.
   4. Click **Upload Bundle**.
   5. Watch the progress bar. For a ~130 GB bundle over gigabit Ethernet, expect ~30 minutes. Over Wi-Fi it depends on link quality — plan accordingly.

5. **Watch the device apply it.** After the upload completes the status transitions through:
   - **Uploaded** — zip fully received on the device
   - **Verifying** — device is computing SHA256 of the zip and each artifact
   - **Extracting** — device is unzipping and extracting the `.tar` files inside
   - **Applied** — new bundle is live; the map, search, and routing all light up

   Total post-upload time for North America is roughly 15–25 minutes on the CM5's NVMe.

6. **Verify from the map view.** Sidebar → **Map**. You should see the region rendered. Search for a city — should return results. Right-click (or long-press) on the map and pick **Route to here** — should compute a route.

---

## Loading from USB / SD card (sneakernet)

For very large bundles (North America ~130 GB) or install locations without a fast network to the device, you can copy the `.zip` onto a USB drive or SD card and load it directly on the device — no upload over Wi-Fi/Ethernet required.

1. **Copy the `.zip` onto a USB drive or SD card** on your build machine. Any filesystem readable by the CM5 works (FAT32, exFAT, ext4, NTFS). The file must be named `maps-*.zip` (matches the bundle output pattern from `build/maps/build.sh`).

2. **Plug the drive into the device.** Any free USB port on the CM5 IO board, or the SD card slot. The device auto-mounts removable drives read-only at boot and on plug-in.

3. **Open the Maps page** in the PWA. Within ~10 seconds of the drive being detected, a new card appears:

   > **Load from external storage**
   > Detected: `maps-2026.07.13.zip` on `MY-USB-STICK` (128.8 GB)
   > [Import]

4. **Click Import.** The device streams the file from the removable drive into staging on the NVMe (with SHA256 verification), then continues through the normal Verifying → Extracting → Applied flow. No copy over the network happens.

5. **Unplug the drive** once the status leaves "Uploading" (safe from that point on — the bytes are on the NVMe).

The auto-mount is **read-only**, `noexec`, `nosuid`, `nodev` — a customer USB drive cannot execute anything on the device and cannot be written to. You can only load `.zip` files matching the bundle naming pattern; other files on the drive are ignored.

If multiple bundles are on the same drive (or across multiple drives plugged in), each shows up as a separate row and you pick which to load.

---

## Updating to a fresh OSM extract

OSM data refreshes daily. You'll want to rebuild bundles periodically — how often is up to you.

1. **Rebuild** (same command as first-time — the build script incrementally updates the local OSM extract with `pyosmium-up-to-date`):

   ```bash
   ./build/maps/build.sh --region north-america
   ```

2. **Upload** the new zip via the PWA Maps page.

3. **The device retains the previous version.** After a successful apply, the previous bundle stays on disk as `versions/<previous-date>/`. If the new one has a problem, use the **Roll back to previous version** button on the Maps page to instantly switch back.

4. **Only one previous version is kept.** After a third successful apply, the oldest gets pruned automatically.

---

## Changing region

If you upload a bundle whose region differs from the currently-installed one (e.g. going from North America to Europe), the device notices and pauses before applying. A yellow bar appears on the upload row:

> **Region change: North America → Europe**
> [Cancel] [Confirm & apply]

- **Confirm & apply** — the new region is applied, replacing the old.
- **Cancel** — the staged zip is deleted, nothing changes.

This catches the "wrong bundle uploaded to the wrong vehicle" mistake — you have to explicitly agree before regions swap.

---

## Rollback

The Maps page has a **Roll back to previous version** button that appears whenever the device has at least two versions installed. Clicking it flips the `current` symlink back to the retained previous bundle and restarts the search + routing containers. Live within 30 seconds. The bundle you just rolled back FROM is not deleted — a second click of the rollback button (in a fresh session) would switch back to it.

---

## Troubleshooting

**Upload failed with "network error" around 5 minutes in.** This was a known Node HTTP timeout bug — long since fixed. If you see it, the CM5 is on an older backend than expected. Push a fresh OTA (`create-deployment-package.sh` + upload via Deployments page) and try again.

**Upload succeeds but sits at "Verifying" for a long time.** SHA256 of a ~90 GB zip takes 3–4 min at the CM5's ~400 MB/s crypto throughput. NA (~130 GB) takes ~5–6 min. If it's been more than 15 minutes on Verifying, check the device's `map-watcher.service` journal — an unusual bundle layout may have tripped the verifier.

**Upload succeeds, applied, but the map area still shows "No map data".** Reload the PWA — the frontend caches the no-bundle state and only re-checks on page load. If it still shows no-map, check `data/maps/current` on the device — should be a symlink to `versions/<date>/`.

**Search returns nothing.** Check that the `photon` container is running: `docker ps | grep photon`. If it's not running, `map-watcher` may have failed to start it after apply — run `docker compose --profile maps up -d photon` on the device to bring it up manually.

**Route request fails immediately.** Same as above but for `valhalla` container. Once brought up, Valhalla takes ~30–60 s to fully load its tile index before it will answer requests.

**The whole device freezes while planning a long route, with the NVMe activity light solid.** This was a real fault, fixed in July 2026 — routing was re-reading the same tiles off the drive endlessly and starving every other service of disk. If you ever see it again, don't reach for more RAM; read [`LongRouteFreeze.md`](LongRouteFreeze.md), which covers the symptoms, the diagnosis steps, and how to confirm routing is on the fast path (`docker logs trailcurrent-valhalla-1 | grep -iE "extract|degraded"` should say `Tile extract successfully loaded`).

**First startup after a software update takes several minutes, with heavy disk activity.** Expected and one-time, if the bundle already on the device predates the packed-tar change: routing rebuilds `valhalla_tiles.tar` from the unpacked directory once. It won't recur, and new bundle uploads skip it.

**Upload rejected with "region-mismatch" in a browser response.** Not a bug — the device is asking for confirmation because you're changing regions. Look at the upload row in the Maps page; there should be a yellow confirmation bar.

---

## Data licensing

Every map bundle contains OpenStreetMap data, licensed under **[ODbL 1.0](https://opendatacommons.org/licenses/odbl/)**.

If you **redistribute a bundle** (or a derivative of the OSM data extracted from a bundle) to anyone outside your household or organization, you must comply with the ODbL — including attribution and share-alike obligations. The bundle's `manifest.json` includes an `odbl_notice` field summarizing this inside the artifact itself.

If you're just building and uploading bundles for your own devices, the ODbL requires attribution in the running app — which is already satisfied by the "© OpenStreetMap contributors" attribution rendered on the map view. No further action needed.

See [`THIRD_PARTY_LICENSES.md`](../THIRD_PARTY_LICENSES.md) for the full list of components + upstream licenses.
