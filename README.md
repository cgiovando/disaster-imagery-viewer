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

Three things this surfaced for the Nepal response:

- Every published Tasking Manager project was configured to use **Esri World
  Imagery**, whose source images over this corridor have a **median capture year
  of 2018**, while Vantor archive scenes sat unused on OpenAerialMap. As of 31
  August one project (63399) has switched to an OpenAerialMap layer; three
  others are still on Esri.
- Two **drone orthophotos at 3.5 cm and 6 cm** covering Rasuwagadhi-Timure and
  Simle-to-Betrawati, flown in September 2025, were already published and were
  finer than any available satellite scene.
- Published damage assessments existed in three independent places, none of them
  side by side: HOT's fAIr scoring on HDX, SERTIT's Pleiades photo-interpretation
  under the International Charter, and Copernicus EMS grading. Where they
  disagree is information in itself.

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
hand with `gh workflow run refresh.yml` when something has just been released.

The hourly schedule is driven by a **Cloudflare Worker** (`worker/`) rather than
by GitHub's own `schedule` trigger, which proved unusable for this repository: it
delivered one event in roughly 24 hourly slots, and that one 25 minutes late.
The Worker fires a `repository_dispatch` at :07 each hour. The Actions cron is
left in place as a harmless backup. See `worker/README.md`.

A build only commits when something other than the run timestamp changed, so the
history reflects real catalogue changes rather than an hourly no-op. The deploy
runs regardless and builds from the working tree, so the live page always shows
its true last-checked time.

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
each build, which keeps the hourly CI commits small.

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

**Planet's crisis response bucket** is read directly from Source Cooperative,
because Planet mirror only PlanetScope to OpenAerialMap. SkySat and Pelican are
otherwise invisible, and for the Nepal event SkySat at 0.8 m and 50% cloud is
the least cloudy post-event optical imagery available anywhere.

Planet also publish more than RGB. Pelican ships a six-band pan-sharpened COG
(blue, green, red, NIR, red edge, red edge II) at 0.55 m, and PlanetScope a
four-band analytic. Each multi-band asset is emitted as one catalogue entry per
rendering (natural colour, NIR false colour, NDWI), which reuses the ordinary
scene rows and means renderings can be swipe-compared against each other.
Display stretches are tabulated per sensor from the 2nd to 98th percentile of
the real scenes; Pelican sits around 9,000-46,000 while SkySat is 60-460, so a
single shared stretch makes most of them unreadable.

**Esri basemap capture dates** come from the World Imagery footprint layer. Its
`/query` endpoint is CORS-blocked in the browser, which is why other tools
grid-sample the `/identify` endpoint instead; because this project has a build
step, the exact seamline polygons are fetched server-side and generalised by the
service, which takes the payload from megabytes to about 200 KB. Over the Nepal
corridor that is 334 source images spanning 2012 to 2026, median 2018.

Radar answers the persistent monsoon cloud that defeats optical here. Note that
in steep terrain radar shadow also reads as smooth, so the water mask is
indicative and not a validated flood product.

**Published impact layers are read live from their publishers**, so a revision
appears without a rebuild. UNOSAT's mudflow extent and detachment zone, SERTIT's
flood trace and built-up and road damage, and Copernicus EMS building and road
grading all come from the UNOSAT ArcGIS services for event `FL20260826NPL`,
queried as GeoJSON. HOT's fAIr building damage comes from the Raw Data API S3
bucket referenced by its HDX record. Every one of these endpoints sends
`Access-Control-Allow-Origin`, so no proxy is involved.

Two details there are worth knowing if you extend this. Copernicus publishes each
grading theme separately per area of interest, so a layer may list several `urls`
which are merged into one toggle; if some endpoints fail the layer draws what it
has and says so, rather than vanishing. And ArcGIS answers `200 OK` with an
`{"error": ...}` body rather than an HTTP error status, so each response is
checked for that and for being a real FeatureCollection before it is accepted.

Layers coloured by a classification generate their key from the same stops as the
map paint, so the two cannot drift apart. Once a layer is switched on and its
data has arrived, the key narrows to the classes actually present, and names any
class the publisher has added that the config has no colour for. Before that it
lists every configured class, since there is nothing yet to narrow against.

The imagery catalogue can be **grouped** by phase and platform, provider,
acquisition date or resolution band; **sorted** by date, resolution, cloud or
provider; and **filtered** by provider chips, corridor AOI, free text, or to just
what is currently drawn. Every one of those is a plain property of the scene.
Drone captures are bucketed together regardless of publisher, since ground teams
fly under many names; the builder identifies them from platform and ground
sample distance together, because OpenAerialMap's `platform` field is unreliable
here (the 3.5 cm flight over this corridor is tagged `satellite`).

Whole publishers can be excluded per event with `excludeProviders`. The Nepal
config drops the 2015 DigitalGlobe open release: 75 scenes with hash filenames, a
decade older than the event, which buried everything anyone was looking for.

Generated pages, event pages and the root index alike, reference `app.js` and
`style.css` with a **content-hash cache key**. Without one a browser keeps
running the JavaScript it already has after a deploy, which is silent and looks
exactly like a page that is up to date.

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
| UNOSAT ArcGIS services (`FL20260826NPL`) | Mudflow extent, detachment zone, baseline data, queried live | As published by UNOSAT |
| [ICube-SERTIT](https://sertit.unistra.fr/) via International Charter Call 1209 | Pleiades flood trace, built-up and road damage | (c) ICube-SERTIT 2026, as published |
| [Copernicus EMS](https://emergency.copernicus.eu/) | Building and road damage grading, observed event extent | Copernicus, as published |
| HOT fAIr, via [HDX](https://data.humdata.org/dataset/hot_flood_npl_buildings_damage) | AI building damage scoring on OSM footprints | ODbL / CC-BY, as published |
| [HOT Raw Data API](https://api-prod.raw-data.hotosm.org/v1/docs) | Live OpenStreetMap features | ODbL |
| [Overpass API](https://overpass-api.de) | Fallback for live OSM | ODbL |
| [Microsoft Planetary Computer](https://planetarycomputer.microsoft.com/) | Sentinel-1 radar tiles | Copernicus open licence |
| Vantor Open Data STAC | Per-scene cloud cover | CC-BY-NC-4.0 |
| [Planet Crisis Response](https://source.coop/planet/disasterdata) | SkySat, Pelican, PlanetScope imagery and bands | CC-BY-NC-4.0 |
| Esri World Imagery seamlines | Basemap capture dates | Esri, attributed on the map |
| Esri, Bing, OpenStreetMap | Basemaps | Per provider, attributed on the map |

## Caveats

**This project produces no analysis of its own.** It classifies nothing and
ranks nothing. The damage layers it displays are other organisations' published
products, shown with their own classes and their own caveats, and the viewer
takes no position on which is correct.

Read those layers with their limits in mind:

- HOT's fAIr layer is **AI-generated and preliminary**. HOT's own caveat is that
  cross-sensor pre versus post comparison, plus cloud in the post imagery, can
  inflate destroyed calls. Its middle classes are weak: median confidence is
  0.11 for minor damage and 0.23 for major, against 1.00 for destroyed.
- SERTIT and Copernicus EMS grading is human photo-interpretation of nadir
  optical imagery. Damage invisible from directly overhead is not recorded, so
  "no visible damage" is not the same as undamaged.

**Cloud cover figures are scene-wide averages** from the provider. These scenes
are long river strips, so a low figure does not mean any particular place is
clear, and a high one does not mean it is obscured. The catalogue can sort by
cloud but never ranks scenes by suitability, because whether a scene is useful
depends on where the reader is looking, which the catalogue does not know.

Absence of a scene means no scene has been published to OpenAerialMap, not that
no imagery exists. OpenAerialMap does not carry cloud cover, so scenes without a
figure must be judged visually.

## AI-assisted development

AI-assisted development: substantial parts of this repository were written with
Claude Code.
