#!/usr/bin/env python3
"""Build data/<event>.catalog.json for each event config in events/.

Static hosting cannot query the source APIs from the browser: the
OpenAerialMap API restricts CORS to map.openaerialmap.org, and the Tasking
Manager API sends no Access-Control-Allow-Origin header. Tile endpoints are
fine. So the imagery catalogue is baked here, server-side, and refreshed
frequently by CI while the imagery itself streams live from the providers.

Tasking Manager geometry and progress are read live in the browser from the
insta-tm mirror, which does send CORS headers. TM data is also baked here as
a fallback for when the mirror lags.

Usage:
    python3 scripts/build_catalog.py                  # all events
    python3 scripts/build_catalog.py nepal-floods-2026
"""

import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EVENTS_DIR = os.path.join(ROOT, "events")
DATA_DIR = os.path.join(ROOT, "data")
SHELL = os.path.join(ROOT, "shell.html")

OAM_API = "https://api.openaerialmap.org/meta"
TM_API = "https://tasking-manager-production-api.hotosm.org/api/v2"
HDX_API = "https://data.humdata.org/api/3/action/package_show"

# Esri World Imagery seamlines: the footprint of every source image behind the
# default basemap, with its capture date. This is what tells a mapper how old
# the imagery under their cursor actually is.
#
# The /query endpoint is blocked by CORS in the browser, which is why other
# tools grid-sample the /identify endpoint instead. Here it is fetched
# server-side in CI, so the exact seamline polygons can be used rather than
# sampled points. maxAllowableOffset asks the server to generalise the
# geometry, which takes the payload from megabytes to tens of kilobytes.
ESRI_SEAMLINES = ("https://services.arcgisonline.com/ArcGIS/rest/services"
                  "/World_Imagery/MapServer/0/query")
ESRI_PAGE = 100  # the service caps a page at 100 regardless of what is asked

# Provider STAC collections (currently Vantor's Open Data Program). These carry
# per-scene cloud cover, which OpenAerialMap does not expose, so it is joined
# onto the catalogue by the provider catalogue ID embedded in the OAM title.
CATALOG_ID_RE = re.compile(r"\b([0-9A-F]{16})\b")

# Planet's crisis response buckets publish more than the RGB visual: Pelican
# ships a 6-band pan-sharpened COG (blue, green, red, NIR, red edge, red edge II)
# and PlanetScope a 4-band analytic. Those extra bands are worth surfacing, so
# each multi-band asset is emitted as its own catalogue entry per rendering,
# which reuses the existing row UI and lets renderings be swipe-compared.
#
# Band order and sensible display stretches differ per sensor, so they are
# tabulated rather than guessed. Stretches come from the 2nd-98th percentile of
# the actual scenes; a single shared value makes two of the three unreadable.
PLANET_SENSORS = {
    "Pelican":     {"gsd": 0.55, "rescale": "9000,46000"},
    "SkySat":      {"gsd": 0.80, "rescale": "50,470"},
    "PlanetScope": {"gsd": 3.70, "rescale": "2000,44000"},
}
# Renderings offered for a multi-band asset. bidx is 1-based, RGB order.
PLANET_RENDERS = [
    {"suffix": "NIR false colour", "bidx": [4, 3, 2],
     "note": "Vegetation red, water dark, wet ground and debris distinct from dry."},
    {"suffix": "NDWI", "expression": "(b2-b4)/(b2+b4)",
     "rescale": "-1,1", "colormap": "rdbu",
     "note": "Normalised difference water index from green and NIR. Blue is water."},
]

# Task grid geometry never changes for a project, only task status does. So the
# geometry is written once to its own file and the per-build status is a compact
# array in the catalogue. Keeps the 20-minute CI commits small.
TASK_STATUSES = ("READY", "MAPPED", "VALIDATED", "BADIMAGERY",
                 "LOCKED_FOR_MAPPING", "LOCKED_FOR_VALIDATION", "INVALIDATED",
                 "SPLIT", "ARCHIVED")

UA = "disaster-imagery-viewer/1.0 (+https://github.com/cgiovando/disaster-imagery-viewer)"

# OpenAerialMap's tiles.openaerialmap.org endpoint 302-redirects to HOT's
# titiler. The redirect response carries no CORS headers, and the Fetch spec
# applies the CORS check to every hop, so MapLibre - which loads raster tiles
# by fetch rather than by <img> - fails on it even though the final response
# is Access-Control-Allow-Origin: *. Addressing titiler directly avoids the
# hop entirely, and is one fewer round trip per tile.
TITILER = "https://titiler.hotosm.org/cog/tiles/WebMercatorQuad/{z}/{x}/{y}@1x?url="

# Titles that are clearly platform test uploads rather than response data.
TEST_PATTERNS = re.compile(r"\b(test|testing|hjhkh|this is est|task of \d{4}-)\b", re.I)

# Explicit pre/post markers that uploaders put in OAM titles. These are more
# reliable than acquisition dates, which OAM sometimes records as the start of
# a tasking window rather than the capture instant.
PRE_MARK = re.compile(r"\[\s*pre\b", re.I)
POST_MARK = re.compile(r"\[\s*post\b", re.I)
# Planet-style filenames carry their own capture timestamp: 20260826_054502_86_251f
TITLE_TS = re.compile(r"(?<!\d)(20\d{6})_(\d{6})(?!\d)")

# No satellite delivers finer than ~25 cm. Anything sharper is drone or
# aerial, whatever the OAM platform field claims - several genuine drone
# orthos in this corridor are mis-tagged as "satellite".
DRONE_GSD_M = 0.25


RETRYABLE = {429, 500, 502, 503, 504}


def get_json(url, timeout=90):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def try_json(url, what, attempts=4):
    """Fetch with backoff. The OAM API returns intermittent 502s; a single
    failure must not be allowed to empty the catalogue."""
    delay = 2
    for i in range(1, attempts + 1):
        try:
            return get_json(url)
        except urllib.error.HTTPError as e:
            if e.code not in RETRYABLE or i == attempts:
                print(f"  ! {what} failed: HTTP {e.code}", file=sys.stderr)
                return None
            print(f"  . {what} HTTP {e.code}, retry {i}/{attempts - 1} in {delay}s",
                  file=sys.stderr)
        except (urllib.error.URLError, TimeoutError, ValueError, OSError) as e:
            if i == attempts:
                print(f"  ! {what} failed: {e}", file=sys.stderr)
                return None
            print(f"  . {what} error ({e}), retry {i}/{attempts - 1} in {delay}s",
                  file=sys.stderr)
        time.sleep(delay)
        delay *= 2
    return None


def classify_phase(item, acquired, cfg):
    """pre / post relative to the event, most trustworthy signal first."""
    title = item.get("title") or ""
    if POST_MARK.search(title):
        return "post"
    if PRE_MARK.search(title):
        return "pre"

    event_dt = cfg.get("eventDatetime") or (cfg["eventDate"] + "T00:00:00Z")
    m = TITLE_TS.search(title)
    if m:
        d, t = m.group(1), m.group(2)
        stamp = f"{d[0:4]}-{d[4:6]}-{d[6:8]}T{t[0:2]}:{t[2:4]}:{t[4:6]}Z"
        return "post" if stamp >= event_dt else "pre"

    if not acquired:
        return "unknown"
    return "post" if acquired[:10] > cfg["eventDate"] else (
        "post" if acquired >= event_dt else "pre")


def normalise_provider(item):
    title = (item.get("title") or "").lower()
    provider = (item.get("provider") or "").strip()
    platform = (item.get("platform") or "").lower()
    if "vantor" in title or "maxar" in title or "worldview" in title:
        return "Vantor"
    if "digital globe" in provider.lower():
        return "DigitalGlobe (archive)"
    if platform == "uav":
        return provider or "Drone"
    return provider or "Unknown"


def group_of(scene):
    """Bucket a scene for the sidebar catalogue."""
    if scene["phase"] == "post":
        return "post-drone" if scene["is_drone"] else "post-satellite"
    if scene["is_drone"]:
        return "pre-drone"
    acquired = scene.get("acquired") or ""
    # Anything more than ~5 years old is reference, not a working basemap.
    if acquired and acquired[:4] < str(int(datetime.now().year) - 5):
        return "archive"
    return "pre-satellite"


def bbox_intersects(a, b):
    if not a or not b or len(a) != 4 or len(b) != 4:
        return False
    return not (a[2] < b[0] or a[0] > b[2] or a[3] < b[1] or a[1] > b[3])


def fetch_oam(cfg):
    """Every OAM scene with a tile endpoint intersecting the event bbox."""
    bbox = ",".join(str(v) for v in cfg["bbox"])
    aoi = cfg.get("tmAoiBbox")
    scenes, page, limit = [], 1, 100

    while page <= 20:
        q = urllib.parse.urlencode(
            {"bbox": bbox, "limit": limit, "page": page,
             "order_by": "acquisition_end", "sort": "desc"}
        )
        data = try_json(f"{OAM_API}?{q}", f"OAM page {page}")
        if not data:
            break
        results = data.get("results", [])
        if not results:
            break

        for it in results:
            tms = (it.get("properties") or {}).get("tms")
            if not tms:
                continue
            # OAM holds some legacy http:// endpoints that browsers block as
            # mixed content on an https page.
            if tms.startswith("http://"):
                tms = "https://" + tms[len("http://"):]

            title = (it.get("title") or "").strip()
            if TEST_PATTERNS.search(title):
                continue
            # Derived products (land use classifications and the like) are not
            # imagery and only clutter the catalogue.
            if any(x.lower() in title.lower() for x in cfg.get("excludeTitles", [])):
                continue

            cog = it.get("uuid") or ""
            tile_url = tms
            if cog.startswith("https://") and cog.lower().endswith((".tif", ".tiff")):
                tile_url = TITILER + urllib.parse.quote(cog, safe="")

            acquired = it.get("acquisition_start") or it.get("acquisition_end")
            gsd = it.get("gsd")
            scene_bbox = it.get("bbox") or []
            platform = (it.get("platform") or "").lower()
            provider = normalise_provider(it)
            is_drone = platform == "uav" or (
                isinstance(gsd, (int, float)) and 0 < gsd < DRONE_GSD_M
            )

            scene = {
                "id": it.get("_id"),
                "title": title,
                "tms": tms,
                "cog": cog or None,
                "tile_url": tile_url,
                "acquired": acquired,
                "phase": classify_phase(it, acquired, cfg),
                "gsd_cm": round(gsd * 100, 1) if isinstance(gsd, (int, float)) else None,
                "provider": provider,
                "platform": it.get("platform"),
                "is_drone": is_drone,
                "license": it.get("license"),
                "bbox": scene_bbox,
                "in_aoi": bbox_intersects(scene_bbox, aoi) if aoi else True,
                "oam_url": f"https://map.openaerialmap.org/#/{it.get('_id')}",
            }
            scene["group"] = group_of(scene)
            scenes.append(scene)

        if len(results) < limit:
            break
        page += 1

    scenes.sort(key=lambda s: (s.get("acquired") or ""), reverse=True)
    return scenes


def fetch_tm(cfg):
    """TM projects for the campaign, with AOI geometry and progress.

    Read live from the insta-tm mirror by the browser; baked here as a
    fallback and so the catalogue is self-contained.
    """
    campaign = cfg.get("tmCampaign")
    if not campaign:
        return []
    q = urllib.parse.urlencode({"campaign": campaign, "omitMapResults": "true"})
    listing = try_json(f"{TM_API}/projects/?{q}", "TM listing")
    if not listing:
        return []

    out = []
    for r in listing.get("results", []):
        pid = r.get("projectId")
        entry = {
            "id": pid,
            "name": r.get("name"),
            "status": r.get("status"),
            "priority": r.get("priority"),
            "percent_mapped": r.get("percentMapped"),
            "percent_validated": r.get("percentValidated"),
            "url": f"https://tasks.hotosm.org/projects/{pid}",
            "aoi": None,
            "imagery": None,
        }
        detail = try_json(f"{TM_API}/projects/{pid}/", f"TM project {pid}")
        if detail:
            entry["aoi"] = detail.get("areaOfInterest")
            entry["imagery"] = detail.get("imagery")
            entry["created"] = detail.get("created")
            entry["last_updated"] = detail.get("lastUpdated")
            entry["total_tasks"] = detail.get("totalTasks")
        out.append(entry)

    out.sort(key=lambda p: p["id"], reverse=True)
    return out


def round_coords(geom, dp=5):
    """Trim coordinate precision. 5dp is ~1 m, far finer than a task boundary."""
    def walk(c):
        if isinstance(c, list):
            if len(c) == 2 and all(isinstance(v, (int, float)) for v in c):
                return [round(c[0], dp), round(c[1], dp)]
            return [walk(x) for x in c]
        return c
    return {"type": geom["type"], "coordinates": walk(geom["coordinates"])}


def fetch_tasks(pid):
    """Task grid for one project: geometry list plus aligned status list.

    The Tasking Manager tasks endpoint sends no CORS header, so this cannot be
    called from the browser and has to be baked here.
    """
    data = try_json(f"{TM_API}/projects/{pid}/tasks/", f"TM tasks {pid}")
    if not data or not data.get("features"):
        return None, None
    geoms, statuses = [], []
    for f in data["features"]:
        if not f.get("geometry"):
            continue
        geoms.append(round_coords(f["geometry"]))
        statuses.append((f.get("properties") or {}).get("taskStatus") or "READY")
    return geoms, statuses


def _planet_sensor(gsd):
    best, diff = None, 1e9
    for name, spec in PLANET_SENSORS.items():
        d = abs((gsd or 0) - spec["gsd"])
        if d < diff:
            best, diff = name, d
    # Beyond a reasonable tolerance we do not claim to know the sensor.
    return best if diff < max(0.3, (gsd or 0) * 0.35) else None


def _walk_stac(url, seen=None, depth=0):
    """Yield every item URL under a STAC catalog or collection."""
    seen = seen if seen is not None else set()
    if url in seen or depth > 6:
        return
    seen.add(url)
    node = try_json(url, f"STAC {url.rsplit('/', 2)[-2]}", attempts=2)
    if not node:
        return
    for link in node.get("links", []):
        rel, href = link.get("rel"), link.get("href")
        if not href or rel not in ("child", "item"):
            continue
        target = urllib.parse.urljoin(url, href)
        if rel == "item":
            yield target
        else:
            yield from _walk_stac(target, seen, depth + 1)


def fetch_planet_crisis(cfg):
    """Scenes from a Planet crisis response STAC catalog.

    Planet mirror only PlanetScope to OpenAerialMap, so SkySat and Pelican are
    invisible unless the bucket is read directly. For this event SkySat is the
    least cloudy post-event optical available anywhere.
    """
    root = cfg.get("planetCrisis")
    if not root:
        return []
    event_dt = cfg.get("eventDatetime") or (cfg["eventDate"] + "T00:00:00Z")
    aoi = cfg.get("tmAoiBbox")
    scenes = []

    for item_url in _walk_stac(root):
        item = try_json(item_url, f"Planet item {item_url.rsplit('/', 1)[-1]}", attempts=2)
        if not item:
            continue
        props = item.get("properties") or {}
        gsd = props.get("gsd")
        sensor = _planet_sensor(gsd)
        if not sensor:
            continue
        dt = props.get("datetime") or ""
        bbox = item.get("bbox") or []
        cloud = props.get("eo:cloud_cover")
        phase = "post" if dt >= event_dt else "pre"
        base = {
            "provider": "Planet",
            "sensor": sensor,
            "acquired": dt,
            "phase": phase,
            "gsd_cm": round(gsd * 100, 1) if gsd else None,
            "cloud_pct": round(float(cloud), 1) if cloud is not None else None,
            "bbox": bbox,
            "in_aoi": bbox_intersects(bbox, aoi) if aoi else True,
            "is_drone": False,
            "license": "CC-BY-NC-4.0",
            "attribution": "Planet Crisis Response via Source Cooperative",
            "oam_url": item_url,
        }
        assets = item.get("assets") or {}
        stretch = PLANET_SENSORS[sensor]["rescale"]
        # Several scenes share a day, and consecutive Pelican captures are one
        # second apart, so seconds are needed to tell them apart in the list.
        stamp = f"{dt[:10]} {dt[11:19]}Z" if len(dt) >= 19 else dt[:10]

        # OpenAerialMap already mirrors Planet's PlanetScope visual scenes, so
        # only the renderings that add something (NIR, NDWI) are emitted for it.
        want_visual = sensor != "PlanetScope"

        # The 8-bit visual asset is the default, natural-colour entry.
        if want_visual and "visual" in assets:
            url = urllib.parse.urljoin(item_url, assets["visual"]["href"])
            sc = dict(base)
            sc["id"] = f"planet-{item['id']}-visual"
            sc["title"] = f"{sensor} {stamp} natural colour"
            sc["tile_url"] = TITILER + urllib.parse.quote(url, safe="")
            sc["group"] = group_of(sc)
            scenes.append(sc)

        # Multi-band assets get one entry per rendering.
        multi = next((a for a in ("pansharpened", "analytic", "analytic_sr") if a in assets), None)
        if multi:
            url = urllib.parse.urljoin(item_url, assets[multi]["href"])
            enc = urllib.parse.quote(url, safe="")
            for r in PLANET_RENDERS:
                parts = [f"url={enc}"]
                if r.get("expression"):
                    parts.append("expression=" + urllib.parse.quote(r["expression"], safe=""))
                    parts.append(f"rescale={r['rescale']}")
                    if r.get("colormap"):
                        parts.append(f"colormap_name={r['colormap']}")
                else:
                    parts += [f"bidx={b}" for b in r["bidx"]]
                    parts += [f"rescale={stretch}"] * len(r["bidx"])
                sc = dict(base)
                sc["id"] = f"planet-{item['id']}-{r['suffix'].lower().replace(' ', '-')}"
                sc["title"] = f"{sensor} {stamp} {r['suffix']}"
                sc["tile_url"] = TITILER.replace("{z}/{x}/{y}@1x?url=", "{z}/{x}/{y}@1x?") + "&".join(parts)
                sc["note"] = r["note"]
                sc["group"] = group_of(sc)
                scenes.append(sc)

    # Two SkySat captures can share a timestamp to the second, so disambiguate
    # any remaining collisions with a fragment of the source item id.
    counts = {}
    for sc in scenes:
        counts[sc["title"]] = counts.get(sc["title"], 0) + 1
    for sc in scenes:
        if counts.get(sc["title"], 0) > 1:
            frag = sc["id"].split("-")[1].rsplit("_", 1)[-1][:6]
            sc["title"] = f"{sc['title']} ({frag})"

    scenes.sort(key=lambda s: (s.get("acquired") or ""), reverse=True)
    return scenes


def fetch_provider_metadata(cfg):
    """Per-scene metadata from provider STAC collections, keyed by catalogue ID.

    Vantor's Open Data Program publishes eo:cloud_cover and the platform on each
    STAC item. OpenAerialMap carries neither, and at 70-80% cloud knowing which
    scenes are worth opening matters, so the two are joined here.
    """
    meta = {}
    for url in cfg.get("odpCollections", []):
        coll = try_json(url, "ODP collection")
        if not coll:
            continue
        hrefs = [l["href"] for l in coll.get("links", []) if l.get("rel") == "item"]
        for href in hrefs:
            item = try_json(href, f"ODP item {href.rsplit('/', 1)[-1]}", attempts=2)
            if not item:
                continue
            p = item.get("properties") or {}
            meta[str(item.get("id", "")).upper()] = {
                "cloud": p.get("eo:cloud_cover"),
                "platform": p.get("platform") or p.get("constellation"),
                "bands": [b.get("common_name") or b.get("name")
                          for b in (p.get("eo:bands") or [])],
                "assets": sorted(item.get("assets", {}).keys()),
            }
    return meta


def fetch_esri_seamlines(cfg):
    """Esri World Imagery source footprints intersecting the event bbox."""
    bbox = ",".join(str(v) for v in cfg["bbox"])
    feats, offset = [], 0
    while offset < 2000:
        params = {
            "f": "geojson",
            "geometry": bbox,
            "geometryType": "esriGeometryEnvelope",
            "inSR": "4326",
            "outSR": "4326",
            "spatialRel": "esriSpatialRelIntersects",
            "outFields": "OBJECTID,SRC_DATE,SRC_RES,NICE_NAME",
            "returnGeometry": "true",
            "maxAllowableOffset": "0.0004",
            "geometryPrecision": "5",
            "resultOffset": str(offset),
            "resultRecordCount": str(ESRI_PAGE),
        }
        url = f"{ESRI_SEAMLINES}?{urllib.parse.urlencode(params)}"
        data = try_json(url, f"Esri seamlines offset {offset}")
        if not data or "features" not in data:
            break
        page = data["features"]
        feats.extend(page)
        if len(page) < ESRI_PAGE or not data.get("exceededTransferLimit"):
            break
        offset += ESRI_PAGE

    # Keep only what the viewer uses, and drop anything without a date.
    out = []
    for f in feats:
        p = f.get("properties") or {}
        d = p.get("SRC_DATE")
        if not d:
            continue
        ds = str(d)
        iso = f"{ds[0:4]}-{ds[4:6]}-{ds[6:8]}" if len(ds) == 8 else ds
        out.append({
            "type": "Feature",
            "geometry": f.get("geometry"),
            "properties": {
                "date": iso,
                "year": int(ds[0:4]) if len(ds) >= 4 and ds[0:4].isdigit() else None,
                "res": p.get("SRC_RES"),
                "name": p.get("NICE_NAME"),
            },
        })
    return {"type": "FeatureCollection", "features": out}


def fetch_hdx(cfg):
    out = []
    for slug in cfg.get("hdxDatasets", []):
        res = try_json(f"{HDX_API}?id={urllib.parse.quote(slug)}", f"HDX {slug}")
        if not res:
            continue
        d = res.get("result", {})
        out.append({
            "slug": slug,
            "title": d.get("title"),
            "url": f"https://data.humdata.org/dataset/{slug}",
            "last_modified": d.get("last_modified") or d.get("metadata_modified"),
            "num_resources": len(d.get("resources", [])),
        })
    return out


def build(cfg_path):
    with open(cfg_path) as f:
        cfg = json.load(f)
    eid = cfg["id"]
    print(f"\n=== {eid} ({cfg['name']}) ===")

    print("  OpenAerialMap ...")
    scenes = fetch_oam(cfg)
    print(f"    {len(scenes)} scenes, {sum(1 for s in scenes if s['in_aoi'])} in AOI, "
          f"{sum(1 for s in scenes if s['phase'] == 'post')} post-event")

    print("  Tasking Manager ...")
    tm = fetch_tm(cfg)
    print(f"    {len(tm)} projects")

    print("  Planet crisis response ...")
    planet = fetch_planet_crisis(cfg)
    if planet:
        by_sensor = {}
        for sc in planet:
            by_sensor.setdefault(sc["sensor"], 0)
            by_sensor[sc["sensor"]] += 1
        print("    " + ", ".join(f"{k} {v}" for k, v in sorted(by_sensor.items())) +
              f" ({len(planet)} renderings)")
        # OAM already carries mirrored PlanetScope scenes; keep both but the
        # Planet-native ones carry cloud cover and the extra bands.
        scenes.extend(planet)
        scenes.sort(key=lambda s: (s.get("acquired") or ""), reverse=True)
    else:
        print("    none")

    print("  Provider STAC metadata ...")
    provider_meta = fetch_provider_metadata(cfg)
    matched = 0
    for sc in scenes:
        m = CATALOG_ID_RE.search((sc.get("title") or "").upper())
        if not m:
            continue
        info = provider_meta.get(m.group(1))
        if not info:
            continue
        sc["catalog_id"] = m.group(1)
        if info.get("cloud") is not None:
            sc["cloud_pct"] = round(float(info["cloud"]), 1)
        if info.get("platform"):
            sc["sensor"] = info["platform"]
        if info.get("bands"):
            sc["bands"] = info["bands"]
        matched += 1
    print(f"    {len(provider_meta)} provider items, cloud cover joined to {matched} scenes")

    print("  Task grids ...")
    grid_path = os.path.join(DATA_DIR, f"{eid}.taskgrid.json")
    try:
        with open(grid_path) as f:
            grids = json.load(f)
    except (OSError, ValueError):
        grids = {}
    grids_changed = False
    for p in tm:
        geoms, statuses = fetch_tasks(p["id"])
        if geoms is None:
            print(f"    project {p['id']}: unavailable, keeping any existing grid")
            continue
        key = str(p["id"])
        if len(grids.get(key, [])) != len(geoms):
            grids[key] = geoms
            grids_changed = True
        p["task_status"] = statuses
        p["task_counts"] = {s: statuses.count(s) for s in set(statuses)}
        print(f"    project {p['id']}: {len(geoms)} tasks, "
              + ", ".join(f"{k} {v}" for k, v in sorted(p["task_counts"].items())))
    if grids_changed:
        os.makedirs(DATA_DIR, exist_ok=True)
        with open(grid_path, "w") as f:
            json.dump(grids, f, separators=(",", ":"))
        print(f"    wrote data/{eid}.taskgrid.json ({os.path.getsize(grid_path):,} bytes)")
    else:
        print("    task geometry unchanged")

    print("  Esri seamlines ...")
    seam = fetch_esri_seamlines(cfg)
    if seam["features"]:
        seam_path = os.path.join(DATA_DIR, f"{eid}.esri-seamlines.geojson")
        os.makedirs(DATA_DIR, exist_ok=True)
        with open(seam_path, "w") as f:
            json.dump(seam, f, separators=(",", ":"))
        years = sorted({x["properties"]["year"] for x in seam["features"] if x["properties"]["year"]})
        print(f"    {len(seam['features'])} footprints, {years[0]}-{years[-1]}, "
              f"{os.path.getsize(seam_path):,} bytes")
        seam_file = f"{eid}.esri-seamlines.geojson"
    else:
        seam_file = None
        print("    none returned, keeping any existing file")

    print("  HDX ...")
    hdx = fetch_hdx(cfg)
    print(f"    {len(hdx)} datasets")

    catalog = {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "event": {k: cfg.get(k) for k in
                  ("id", "name", "eventDate", "bbox", "tmAoiBbox", "tmCampaign",
                   "center", "zoom", "wiki", "summary")},
        "esri_seamlines": seam_file,
        "scenes": scenes,
        "tm_projects": tm,
        "hdx": hdx,
    }

    os.makedirs(DATA_DIR, exist_ok=True)
    out_path = os.path.join(DATA_DIR, f"{eid}.catalog.json")

    # Never let a transient upstream outage replace a good catalogue with an
    # empty one. During a live activation this file is what people rely on.
    if not scenes and os.path.exists(out_path):
        try:
            with open(out_path) as f:
                previous = json.load(f)
        except (ValueError, OSError):
            previous = {}
        if previous.get("scenes"):
            print(f"  ! upstream returned no scenes; keeping existing catalogue "
                  f"({len(previous['scenes'])} scenes, generated {previous.get('generated')})",
                  file=sys.stderr)
            return None

    with open(out_path, "w") as f:
        json.dump(catalog, f, indent=1)
    print(f"  wrote data/{eid}.catalog.json ({os.path.getsize(out_path):,} bytes)")

    post = [s for s in scenes if s["phase"] == "post"]
    if post:
        print(f"\n  Post-event scenes:")
        for s in post[:12]:
            print(f"    {s['acquired'][:10]}  {str(s['gsd_cm']):>6}cm  "
                  f"{s['provider']:<22} {s['title'][:46]}")
    return catalog


def write_event_page(cfg):
    """Emit /<event-id>/index.html so each event has a real URL rather than a
    query string. GitHub Pages serves static directories, so this is a page per
    event built from the shared shell rather than any client-side routing."""
    eid = cfg["id"]
    with open(SHELL) as f:
        html = f.read()

    # Assets live one level up from the event directory.
    html = html.replace('href="style.css"', 'href="../style.css"')
    html = html.replace('src="app.js"', 'src="../app.js"')
    html = html.replace(
        "<title>Disaster Imagery Viewer</title>",
        f"<title>{cfg['name']} - Imagery Viewer</title>",
    )
    subtitle = cfg.get("subtitle", "")
    html = html.replace(
        '<meta name="description" content=',
        f'<meta property="og:title" content="{cfg["name"]} - Imagery Viewer">\n'
        f'<meta property="og:description" content="{subtitle}">\n'
        '<meta name="description" content=',
    )
    html = html.replace(
        '<script src="https://unpkg.com/maplibre-gl',
        f'<script>window.APP_BASE = "../"; window.EVENT_ID = "{eid}";</script>\n'
        '<script src="https://unpkg.com/maplibre-gl',
        1,
    )

    out_dir = os.path.join(ROOT, eid)
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "index.html"), "w") as f:
        f.write(html)
    print(f"  wrote {eid}/index.html")


def write_landing(events):
    """Root page listing every configured event."""
    cards = []
    for cfg, cat in events:
        scenes = len(cat.get("scenes", []))
        post = sum(1 for s in cat.get("scenes", []) if s.get("phase") == "post")
        cards.append(
            f'    <a class="card" href="{cfg["id"]}/">\n'
            f'      <h2>{cfg["name"]}</h2>\n'
            f'      <p class="sub">{cfg.get("subtitle", "")}</p>\n'
            f'      <p class="meta">Event {cfg.get("eventDate", "")} &middot; '
            f'{scenes} scenes catalogued &middot; {post} post-event</p>\n'
            f'    </a>'
        )
    generated = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    html = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Disaster Imagery Viewer</title>
<meta name="description" content="Imagery and response viewer for humanitarian mapping activations.">
<link rel="stylesheet" href="style.css">
<style>
  body{{display:block;padding:0}}
  .wrap{{max-width:760px;margin:0 auto;padding:56px 24px 72px}}
  h1{{font-size:26px;margin:0 0 6px;letter-spacing:-.01em}}
  h1::before{{content:"";display:inline-block;width:4px;height:20px;background:var(--hot);
    margin-right:11px;vertical-align:-2px;border-radius:1px}}
  .lede{{color:var(--fg2);font-size:14px;margin:0 0 34px;line-height:1.6;max-width:60ch}}
  .card{{display:block;background:var(--bg2);border:1px solid var(--line);border-radius:9px;
    padding:18px 20px;margin-bottom:12px;text-decoration:none;transition:border-color .15s}}
  .card:hover{{border-color:#43505f}}
  .card h2{{margin:0;font-size:17px;color:var(--fg);font-weight:650}}
  .card .sub{{margin:4px 0 0;font-size:13px;color:var(--fg2)}}
  .card .meta{{margin:8px 0 0;font-size:11.5px;color:var(--fg3);font-variant-numeric:tabular-nums}}
  footer{{margin-top:34px;font-size:12px;color:var(--fg3);line-height:1.6}}
  footer a{{color:var(--pre);text-decoration:none}}
  footer a:hover{{text-decoration:underline}}
</style>
</head>
<body>
  <div class="wrap">
    <h1>Disaster Imagery Viewer</h1>
    <p class="lede">What imagery exists over a disaster area and how old it is, what
    Tasking Manager mappers are looking at, and how the ground compares before and
    after the event.</p>
{chr(10).join(cards)}
    <footer>
      Catalogues refreshed {generated}.
      <a href="https://github.com/cgiovando/disaster-imagery-viewer">Source on GitHub</a>
    </footer>
  </div>
</body>
</html>
"""
    with open(os.path.join(ROOT, "index.html"), "w") as f:
        f.write(html)
    print(f"  wrote index.html ({len(events)} event(s))")


def main():
    wanted = sys.argv[1:]
    configs = sorted(
        os.path.join(EVENTS_DIR, f)
        for f in os.listdir(EVENTS_DIR)
        if f.endswith(".json") and not f.startswith("_")
    )
    if wanted:
        configs = [c for c in configs
                   if os.path.basename(c)[:-5] in wanted or os.path.basename(c) in wanted]
        if not configs:
            print(f"No matching event config for {wanted}", file=sys.stderr)
            return 1
    failed = []
    built = []
    for c in configs:
        cat = build(c)
        if cat is None:
            failed.append(os.path.basename(c)[:-5])
            # Keep the previous catalogue for the landing page counts.
            eid = os.path.basename(c)[:-5]
            try:
                with open(os.path.join(DATA_DIR, f"{eid}.catalog.json")) as f:
                    cat = json.load(f)
            except (OSError, ValueError):
                cat = {}
        with open(c) as f:
            cfg = json.load(f)
        write_event_page(cfg)
        built.append((cfg, cat))

    print("\nPages:")
    write_landing(built)
    if failed:
        print(f"\nStale (kept previous catalogue): {', '.join(failed)}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
