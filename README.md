# Disaster Imagery Viewer

**Live: <https://cgiovando.github.io/disaster-imagery-viewer/>**
&middot; Nepal Floods 2026: <https://cgiovando.github.io/disaster-imagery-viewer/nepal-floods-2026/>

A map for humanitarian mapping activations that answers three questions:

1. **What imagery exists over this area, and how old is it?**
2. **What are Tasking Manager mappers actually looking at right now?**
3. **How does the ground compare before and after the event?**

Currently configured for the **Nepal Floods 2026** response in the Bhote Koshi
and Trishuli river corridors (Rasuwa and Nuwakot districts, Nepal), following
the glacier and rock collapse of 26 August 2026.

Imagery streams directly from the providers. Nothing is re-hosted here.

## Why

During an activation the imagery picture is scattered across the OSM wiki, the
Tasking Manager, provider STAC indexes, OpenAerialMap and HDX.
Nobody has one view of it, so the same questions get asked repeatedly and
useful imagery goes unused.

Two things this surfaced immediately for the Nepal response:

- Both published Tasking Manager projects were configured to use **Esri World
  Imagery**, which is from **2017** over this corridor, while three Vantor
  archive scenes from 2021, 2023 and 2024 sat unused on OpenAerialMap.
- Two **drone orthophotos at 3.5 cm and 6 cm** covering Rasuwagadhi-Timure and
  Simle-to-Betrawati, flown in September 2025, were already published and were
  far better pre-event reference than any available satellite scene.

## Usage

```
python3 -m http.server 8000
open http://localhost:8000/nepal-floods-2026/
```

The root page lists every configured event. Each event has its own URL:

- <https://cgiovando.github.io/disaster-imagery-viewer/> - event index
- <https://cgiovando.github.io/disaster-imagery-viewer/nepal-floods-2026/> - Nepal Floods 2026

There is no build step and no dependencies to install for the front end.

Map state lives in the URL fragment, so a view with particular layers, a
basemap and a position can be shared as a link.

## Adding an event

1. Copy `events/_template.json` to `events/<event-id>.json` and fill it in.
   Use the event name HOT is using on the OSM wiki and Tasking Manager
   campaign, so the viewer, the wiki and the campaign all agree.
2. Build the catalogue and pages:
   ```
   python3 scripts/build_catalog.py
   ```
   This writes `data/<event-id>.catalog.json`, generates `<event-id>/index.html`
   from `shell.html`, and rebuilds the root event index.
3. Open `/<event-id>/`.

CI rebuilds every configured event hourly, and on any push. Trigger a run by
hand from the Actions tab when something has just been released.

## How it works

```
OpenAerialMap API ─┐
Tasking Manager API ├─ scripts/build_catalog.py (CI, hourly) ──→ data/<event>.catalog.json
HDX API ───────────┘

browser ─→ insta-tm mirror            (Tasking Manager progress, when newer)
        ─→ titiler.hotosm.org         (imagery tiles, direct)
        ─→ HOT Raw Data API           (live OpenStreetMap, Overpass as fallback)
        ─→ Planetary Computer STAC    (Sentinel-1 radar, queried live)
```

The catalogue is pre-built because a static page cannot call the source APIs:
the OpenAerialMap API restricts CORS to `map.openaerialmap.org`, and the
Tasking Manager API sends no `Access-Control-Allow-Origin` header at all.

Imagery tiles address HOT's **titiler** directly rather than going through
`tiles.openaerialmap.org`. That endpoint 302-redirects to titiler, and the
redirect response carries no CORS headers; because the Fetch specification
applies the CORS check to every hop in a redirect chain, MapLibre - which
loads raster tiles by `fetch` rather than by `<img>` - fails on it even though
the final response is `Access-Control-Allow-Origin: *`. Addressing titiler
directly avoids the hop and saves a round trip per tile.

Tasking Manager progress can be refreshed in the browser from
[insta-tm](https://github.com/cgiovando), a CORS-enabled mirror of the HOT
Tasking Manager API. The mirror syncs on its own schedule and can lag the baked
catalogue, so a mirror value is only applied when its `lastUpdated` is actually
newer than the baked one. Otherwise a "live" refresh would replace fresh data
with stale data.

Task grids come from the Tasking Manager tasks endpoint, which also sends no
CORS header. Task geometry never changes for a project, so it is written once
to `data/<event>.taskgrid.json` and only the per-task status is rewritten on
each build, which keeps the 20-minute CI commits small.

On load, the activation-area AOI polygon is fetched in the background and the
panel reports **how many buildings and how many kilometres of road have been
added or edited since the event**, derived from per-feature timestamps. The AOI
polygon is used rather than its bounding box, which here is about twelve times
the area and reaches into the northern fringe of Kathmandu.

Live OpenStreetMap comes from HOT's **Raw Data API** rather than Overpass: it is
HOT's own cloud-native service, it reports how fresh its snapshot is, and it
returns a per-feature timestamp so features edited since the event can be
highlighted. Its synchronous endpoint caps requests at 6 km², so larger views
go through its async export job, which returns a zipped GeoJSON on S3 and
handles ~76 km² in about a second. Overpass remains a fallback.

**Sentinel-1 radar** and **Sentinel-2 optical** are queried live from the
Microsoft Planetary Computer STAC API, which is CORS-enabled, so a new pass
appears without waiting for a catalogue rebuild. For radar the terrain-corrected
RTC product is preferred over GRD, which matters a great deal in this
topography.

Both are rendered on the fly through the Planetary Computer tiler, with a choice
of render modes rather than a single fixed view:

- Sentinel-1: backscatter in **dB** (the default; raw linear gamma0 renders
  almost black, which is why unprocessed SAR looks useless), a
  **smooth-surface / water mask** thresholding low backscatter, and a
  dual-polarisation **false-colour** composite.
- Sentinel-2: **true colour**, **SWIR false colour** which cuts through haze,
  and **NDWI** for water.

**Esri basemap capture dates** come from the World Imagery footprint layer. Its
`/query` endpoint is CORS-blocked in the browser, which is why other tools
grid-sample the `/identify` endpoint instead; because this project has a build
step, the exact seamline polygons are fetched server-side and generalised by the
service, which takes the payload from megabytes to about 200 KB. Over the Nepal
corridor that is 334 source images spanning 2012 to 2026, median 2018.

Radar answers the persistent monsoon cloud that defeats optical here. Note that
in steep terrain radar shadow also reads as smooth, so the water mask is
indicative and not a validated flood product.

## Stack

MapLibre GL JS 5.6.1, PMTiles 4.5.0, fflate 0.8.2, vanilla JavaScript, no build
step. Python 3 standard library only for the catalogue builder. Hosted on GitHub
Pages.

## Data sources and licences

| Source | Use | Licence |
|---|---|---|
| [OpenAerialMap](https://openaerialmap.org) | Imagery catalogue and tiles | Per scene; Vantor Open Data scenes are CC-BY-NC-4.0, most drone imagery CC-BY-4.0 |
| HOT Tasking Manager | Project extents, progress, imagery settings | ODbL / CC-BY-SA |
| [UNOSAT](https://unosat.org) | SAR-derived flood and mudflow extent | As published by UNOSAT |
| Microsoft AI for Good Lab | Regional mosaics, republished UNOSAT extent | As published |
| [HOT Raw Data API](https://api-prod.raw-data.hotosm.org/v1/docs) | Live OpenStreetMap features | ODbL |
| [Overpass API](https://overpass-api.de) | Fallback for live OSM | ODbL |
| [Microsoft Planetary Computer](https://planetarycomputer.microsoft.com/) | Sentinel-1 radar tiles | Copernicus open licence |
| Esri World Imagery seamlines | Basemap capture dates | Esri, attributed on the map |
| Esri, Bing, OpenStreetMap | Basemaps | Per provider, attributed on the map |

## Caveats

This viewer shows imagery and published extents. **It does not classify damage**,
and nothing shown here is a damage assessment. Absence of a scene means no scene
has been published to OpenAerialMap, not that no imagery exists. Cloud cover is
not recorded per scene in OpenAerialMap metadata, so judge it visually.

## AI-assisted development

AI-assisted development: substantial parts of this repository were written with
Claude Code.
