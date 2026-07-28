# When long routes froze the device

In July 2026 two Headwaters devices locked up hard while a route was being planned in the maps screen. Both times the only way back was pulling power. This document explains what was happening, why it was so hard to spot, what we changed, and how to recognise it if anything like it ever returns.

If you only read one paragraph: **routing was reading the same map data off the drive over and over in an endless loop, and that starved every other program on the device of disk access.** Nothing had crashed and nothing had run out of memory. The fix was to change how routing reads its map data.

---

## What you would see

- You were in the maps screen planning a long route — Denver to New York, or Denver to Alaska.
- The screen stopped responding.
- The device stopped answering entirely: no web interface, no remote login.
- **The activity light on the NVMe drive was solid, not flickering.** This turned out to be the single most useful clue.
- Pulling power and starting again was the only recovery.
- Nothing useful appeared in the logs. No crash message, no error.

Short routes never triggered it. It took a very long one.

---

## What was actually going on

Think of route planning as one worker looking things up in an enormous library of map books — about 23 GB of them — kept in a warehouse down the hall. The warehouse is the NVMe drive.

The map library was stored as thousands of separate books. Every time the worker needed to check something, they walked to the warehouse, **photocopied a whole book**, and stacked the copy on their desk. The desk held about 1 GB of copies.

Here is the problem. When the desk filled up, the worker didn't tidy it — they **swept the entire desk into the bin** and started over, including the book they were reading at that very moment. So they immediately walked back to the warehouse to re-copy it. The desk filled again. They swept it again. Forever.

On a short route the desk never filled, so nothing went wrong. On Denver to New York it filled almost at once, and the worker spent the rest of eternity walking back and forth. **That is what the solid drive light was** — the sound of endless trips down the hall.

### Why the whole device froze, not just the map

Every other program on the device occasionally needs that same hallway — including the one that serves the web interface, the one that handles remote logins, and the one that writes down error messages.

None of them could get through. One worker was monopolising it.

So the device looked completely dead when in fact it was frantically busy. And there was no error message explaining it, because **the program whose job is writing error messages also couldn't get down the hallway.**

That is why this took a while to identify. Every instinct says "something crashed" or "it ran out of memory." Neither was true.

---

## Why more memory was not the answer

This is worth recording, because buying an 8 GB module was the obvious first thought and it would not have helped.

The desk's size was set by a **written rule** — a setting that said "1 GB" — not by how much memory the device had. A bigger room does not change the rule. The worker would have filled the same small desk and swept it at exactly the same moment.

Supporting evidence gathered at the time:

- Not a single out-of-memory event had ever been recorded on the device, across every startup in its logs.
- At rest the device used 1.1 GB of its 4 GB, with 2.9 GB free.
- Routing itself never grew past about 1 GB. It was not memory-starved. It was **disk**-starved.

---

## What we changed

Two changes, both free — no new hardware, and roughly no extra storage.

### 1. Stop unpacking the routing map

The map bundle arrives as a sealed box. The device used to unpack it onto shelves and throw the box away. But for route planning, **the box itself is the more useful form** — it can be read directly, and the operating system then manages what stays in memory, which it is very good at. No photocopying, no desk, nothing to overflow.

So the device now keeps the box and skips building the shelves.

Address search is the opposite case: it genuinely needs its contents unpacked. That was left exactly as it was, and search is unaffected.

### 2. Fix the desk-sweeping

If routing ever does end up back on the desk, it now removes only the one book untouched the longest, and never the one being read right now. The worker keeps working instead of starting over.

This second change is a safety net. The first change means the desk isn't used at all — but the desk is what silently got used here, so it is worth having both.

---

## What it looks like now

Measured on the device straight after the fix went out, using the exact two routes that had frozen it:

| Route | Distance | Result |
|---|---|---|
| Denver → New York City | 2,863 km (25.8 h drive) | **worked, 2.1 seconds** |
| Denver → Anchorage, Alaska | 5,143 km (52.2 h drive) | **worked, 1.5 seconds** |
| 5 of the Alaska route at once | — | all worked, 1.0–2.0 s each |

And the device stayed completely healthy throughout:

| Check | Result |
|---|---|
| Memory in use | 1.6 GB of 4 GB, 2.4 GB still free |
| All services running | 6 of 6 |
| Web interface | responding |
| Out-of-memory or stall events | none |
| Address search | working (Denver, Colorado / Iowa / Pennsylvania) |
| Storage | 254 GB used, 660 GB free |

Both routes had previously required a power cycle. They now finish in under three seconds.

---

## One-time effects after the fix

- **The first startup after the update took several minutes.** The bundle already on the device had its box thrown away, so the device rebuilt one from the shelves. That is steady, ordinary disk work — not the fault, and it only happens once. New map uploads skip it entirely.
- **Storage went up by about 23 GB** on the existing bundle, because it now holds both the shelves and the box. The next map bundle you upload will only hold the box, so this goes away on the next map update.

---

## If something like this ever happens again

Symptoms to match: device unreachable, drive light solid, nothing in the logs.

1. **Look at the drive activity light first.** Solid means something is reading or writing continuously. Flickering or dark points somewhere else entirely.
2. **Check whether the kernel is still alive** — from another machine, `ping headwaters.local`. If ping replies but nothing else works, the device is busy rather than crashed, and the fault is starvation of some shared resource.
3. **After restarting, read the previous session's log**, because the current one won't have the answer:
   ```
   sudo journalctl -k -b -1 --no-pager | grep -iE "oom|killed process|blocked for more than"
   ```
   Genuinely running out of memory leaves a `Killed process` line. **Silence here does not mean memory was fine** — it can also mean the logger couldn't write. Treat silence as "no evidence," not "not memory."
4. **Confirm routing is using the box, not the shelves:**
   ```
   docker logs trailcurrent-valhalla-1 2>&1 | grep -iE "extract|degraded"
   ```
   Healthy looks like `Tile extract successfully loaded with tile count: 29987`.
   The warning signs are `Tile extract could not be loaded` and `Skipping tar building. Expect degraded performance` — either means it has fallen back to the slow path that caused this.

---

## A related issue, not yet fixed

While investigating this we found a separate problem worth knowing about. The address-search service runs as the **root** user and is given the whole map folder rather than just its own part of it. On startup it takes ownership of everything in that folder — including the routing files and the routing configuration.

Consequences:

- The device's own map-management service loses the ability to write to an applied bundle. That is why the desk-sweeping fix (change 2 above) only takes effect on the **next** map bundle you upload, rather than on the bundle already installed.
- It quietly undoes the ownership checks that run before services start.

This has not been changed, because narrowing that folder is exactly the sort of change that could break address search, and it deserves its own testing rather than being folded into a routing fix.

---

## Technical appendix

For anyone working on the code. The plain-language sections above are accurate but deliberately avoid naming things.

**The two access modes.** Valhalla reads routing tiles either from a directory (`mjolnir.tile_dir`) or from a single uncompressed tar it memory-maps (`mjolnir.tile_extract`). With the extract, tile residency is handled by the kernel page cache at page granularity, and clean read-only pages are dropped for free — tiles never land on Valhalla's heap, so its tile cache cannot overflow. Directory mode reads whole tile files into Valhalla's own heap, counted against `mjolnir.max_cache_size`.

**The configuration that caused it.** The applied bundle's `valhalla.json` had:

```
max_cache_size            = 1000000000      (1 GB)
use_lru_mem_cache         = False
use_simple_mem_cache      = False
max_concurrent_reader_users = 1
tile_extract              = /custom_files/valhalla_tiles.tar   ← did not exist
tile_dir                  = /custom_files/valhalla_tiles       ← 23 GB, in use
```

The tar was absent because `map-watcher.py`'s `extract_tar_artifacts()` was generic over every `.tar` in a bundle: it unpacked each one and deleted the tarball. Correct for `photon_data.tar` (Lucene needs a real directory tree), wrong for `valhalla_tiles.tar`. Valhalla logged `WARNING: Skipping tar building. Expect degraded performance while using Valhalla.` on every single startup.

**The failure mechanism.** Directly observed: directory mode, a 1 GB cache with no LRU eviction enabled, a 23 GB tile set, saturated disk, zero OOM records, and the fault disappearing once the extract was used. The best explanation consistent with all of that is Valhalla's non-LRU tile cache discarding its entire contents on overcommit rather than evicting incrementally — so a route whose tile working set exceeds the cap re-reads the tiles the active search still needs, indefinitely. That internal behaviour was inferred from the evidence and the config, not read out of Valhalla's source (it runs here as a prebuilt image).

**The changes.**

- `docker-compose.yml`: `build_tar=False` → `build_tar=True`. Idempotent and self-healing — the image's `run.sh` `do_build_tar` only builds when the tar is missing (`build_tar == True && ! -f $TILE_TAR`), so a bundle shipping the tar is used as-is and a bundle missing one gets it rebuilt once. Keep `force_rebuild=False`, which would otherwise pass `--overwrite`.
- `local_code/map-watcher.py`: added `KEEP_PACKED_TARS = {'valhalla_tiles.tar'}`. `extract_tar_artifacts()` leaves those neither extracted nor deleted, and `migrate_current_bundle_tars()` no longer treats them as leftovers needing migration.
- `local_code/map-watcher.py`: added `ensure_valhalla_tuning()`, which seeds `use_lru_mem_cache` and `lru_mem_cache_hard_control` into a staging bundle's `valhalla.json` before promotion. The container runs with `update_existing_config=True`, and that path only *adds* keys missing from its generated defaults — it never overwrites a value already present — so a partial config seeded here survives.

**`max_cache_size` is deliberately not raised.** Raising it raises Valhalla's heap ceiling, and this device has no swap and no enforceable container memory limits: the kernel command line carries `cgroup_disable=memory`, so `/sys/fs/cgroup/cgroup.controllers` has no `memory` entry and `docker stats` reports `0B / 0B` for every container. Docker `mem_limit` directives are **silently ignored** on this device. Better eviction is free; a bigger cache would trade an I/O failure for a memory one. Re-enabling the controller means changing `cmdline.txt`, which is an image rebuild, not an OTA.

**Why the seeded LRU settings don't reach an already-applied bundle.** The Photon container runs as root with `./data/maps/current:/photon/data` — the bundle root, not `photon_data/` — and chowns the whole tree to its internal `photon` user (uid 9011). `trailcurrent` then has no write access to the applied bundle, so `ensure_valhalla_tuning()` logs a warning and skips. Seeding happens in staging for exactly this reason. See "A related issue" above.

**Verification performed.** 20 unit tests over `extract_tar_artifacts()` and `ensure_valhalla_tuning()` (packed tar untouched, Photon still extracts, existing keys preserved, idempotent, graceful on unwritable and corrupt configs), then on-device: `Tile extract successfully loaded with tile count: 29987`, Denver→NYC 200 in 2.1 s, Denver→Anchorage 200 in 1.5 s, five concurrent Anchorage routes all 200 in 1.0–2.0 s, memory peak 1.6 GB of 4 GB, 6/6 containers up, zero OOM or hung-task records, Photon search unaffected.
