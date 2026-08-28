/* Disaster Imagery Viewer
 *
 * Answers three questions for an active humanitarian mapping response:
 *   1. What imagery exists over this area, and how old is it?
 *   2. What are Tasking Manager mappers actually looking at right now?
 *   3. How does the ground compare before and after the event?
 *
 * Imagery streams live from provider tile endpoints. The catalogue is baked by
 * scripts/build_catalog.py because the OpenAerialMap API restricts CORS to
 * map.openaerialmap.org and the Tasking Manager API sends no CORS header.
 * Tasking Manager state is refreshed live in the browser from the insta-tm
 * mirror, which does send CORS headers.
 */
'use strict';

const INSTA_TM = 'https://pub-9f93f222eb8648a08829b4d1cd8edcfb.r2.dev';
const OVERPASS = 'https://overpass-api.de/api/interpreter';
const DEFAULT_EVENT = 'nepal-floods-2026';

// Event pages are served from /<event-id>/, one level below the app assets, and
// declare window.APP_BASE so fetches still resolve.
const BASE = window.APP_BASE || '';

// Task states, in the order a task moves through them.
const TASK_COLORS = {
  READY:                 '#3b4655',
  LOCKED_FOR_MAPPING:    '#c8a3ff',
  MAPPED:                '#4d9de0',
  LOCKED_FOR_VALIDATION: '#c8a3ff',
  VALIDATED:             '#5ec26a',
  INVALIDATED:           '#f0883e',
  BADIMAGERY:            '#d73f3f',
  SPLIT:                 '#697687',
  ARCHIVED:              '#697687'
};
const TASK_LABELS = {
  READY: 'Available', MAPPED: 'Mapped', VALIDATED: 'Validated',
  BADIMAGERY: 'Bad imagery', INVALIDATED: 'Needs rework',
  LOCKED_FOR_MAPPING: 'Being mapped', LOCKED_FOR_VALIDATION: 'Being validated',
  SPLIT: 'Split', ARCHIVED: 'Archived'
};

// Distinct outline colour per Tasking Manager project.
const PROJECT_COLORS = ['#d73f3f', '#f0c94d', '#00b8a9', '#ff7ab8', '#8bd450'];

// OSM overlay styling. Buildings and roads must not look the same.
const OSM_NEW = '#ffd24d';      // edited since the event
const OSM_BUILDING = '#4d9de0';
const OSM_ROAD = '#5ec26a';

// Age bands for Esri basemap capture dates. The point is to make it obvious at
// a glance where a mapper is tracing something years out of date.
const SEAMLINE_BANDS = [
  { from: 2025, color: '#5ec26a', label: '2025 or newer' },
  { from: 2022, color: '#4d9de0', label: '2022-2024' },
  { from: 2019, color: '#f0c94d', label: '2019-2021' },
  { from: 2016, color: '#f0883e', label: '2016-2018' },
  { from: 0,    color: '#d73f3f', label: 'before 2016' }
];

const BASEMAPS = [
  { id: 'esri', name: 'Esri World Imagery', note: 'Default in most OSM editors',
    tiles: ['https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
    attribution: 'Esri, Maxar, Earthstar Geographics', maxzoom: 19 },
  // Bing serves tiles by quadkey, which MapLibre cannot template. We point the
  // source at a sentinel URL and rewrite it to the real quadkey in
  // transformRequest below.
  { id: 'bing', name: 'Bing Aerial', note: 'Often older than Esri in mountain terrain',
    tiles: ['https://bing.tiles.invalid/{z}/{x}/{y}'],
    attribution: 'Microsoft Bing Maps', maxzoom: 19 },
  { id: 'osm', name: 'OSM Standard', note: 'Shows what has been mapped',
    tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
    attribution: 'OpenStreetMap contributors', maxzoom: 19 },
  { id: 'none', name: 'None (dark)', note: '', tiles: null }
];

const GROUPS = [
  { id: 'post-satellite', name: 'Post-event satellite', color: '#f0883e', open: true },
  { id: 'post-drone',     name: 'Post-event drone',     color: '#f0883e', open: true },
  { id: 'pre-drone',      name: 'Pre-event drone',      color: '#5ec26a', open: true },
  { id: 'pre-satellite',  name: 'Pre-event satellite',  color: '#4d9de0', open: true },
  { id: 'archive',        name: 'Older archive',        color: '#8b7cc8', open: false }
];

const state = {
  cfg: null, catalog: null,
  scenes: [], sceneById: new Map(),
  active: [],              // [{key, name, kind, source, opacity, side}]
  basemap: 'esri',
  compare: false, splitPct: 50,
  mapA: null, mapB: null, syncing: false,
  vectorsOn: new Set(),
  collapsed: new Set(['archive']),
  taskGrid: null,        // { projectId: [geometry, ...] }
  showTaskGrid: false,
  tmOn: new Set(),       // project ids currently drawn
  gridProject: null,     // task grid is shown for one project at a time
  osmAoi: null,          // AOI-wide OSM snapshot, loaded in the background
  osmStats: null,
  showAoiOsm: false,
  optical: [],
  sarMode: 'db',
  opticalMode: 'tci',
  sar: [],               // Sentinel-1 scenes from the Planetary Computer
  osmFresh: null
};

const $ = (s) => document.querySelector(s);
const el = (t, c, h) => { const n = document.createElement(t); if (c) n.className = c; if (h !== undefined) n.innerHTML = h; return n; };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (m) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

/* ------------------------------------------------------------------ utils */

/* Always render in UTC. Capture dates must read the same for someone in
 * Kathmandu and someone in California, and a bare YYYY-MM-DD parsed by Date()
 * is UTC midnight, which slips to the previous day west of Greenwich. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fmtDate(iso) {
  if (!iso) return 'date unknown';
  const d = new Date(iso);
  if (isNaN(d)) return String(iso).slice(0, 10);
  return `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function fmtGsd(cm) {
  if (cm == null) return null;
  return cm >= 100 ? `${(cm / 100).toFixed(cm >= 1000 ? 0 : 1)} m` : `${cm.toFixed(0)} cm`;
}

/* Relative timestamps are rendered once, so refresh them on a timer. A viewer
 * left open through a response would otherwise still claim the catalogue was
 * built "3 min ago" hours later. */
/* How old the catalogue may get before the viewer says so loudly. CI is meant
 * to refresh hourly; three hours means something is wrong, and during a response
 * a quietly stale page is more dangerous than an obviously broken one. */
const STALE_AFTER_MIN = 180;

function renderHealth() {
  const box = $('#health');
  if (!box) return;
  const cat = state.catalog || {};
  const notes = [];

  const mins = cat.generated
    ? Math.round((Date.now() - new Date(cat.generated).getTime()) / 60000) : null;
  if (mins != null && mins > STALE_AFTER_MIN) {
    const h = Math.floor(mins / 60);
    notes.push(`The imagery catalogue was last rebuilt <b>${h} hours ago</b> and should refresh hourly. Newly released imagery may be missing.`);
  }
  const stale = Object.entries(cat.sources || {})
    .filter(([, v]) => v.status === 'stale').map(([k]) => k);
  if (stale.length) {
    notes.push(`Showing previously saved data for: <b>${stale.map(esc).join(', ')}</b>.`);
  }
  if ((cat.failures || []).length) {
    notes.push(`${cat.failures.length} upstream source${cat.failures.length > 1 ? 's' : ''} failed on the last build: ${cat.failures.slice(0, 3).map(esc).join('; ')}.`);
  }

  box.hidden = notes.length === 0;
  box.innerHTML = notes.map((n) => `<p>${n}</p>`).join('');
}

function startAgoTicker() {
  const tick = () => {
    const cat = state.catalog && state.catalog.generated;
    if (cat) {
      const f = $('#freshness');
      if (f) f.textContent = `Event ${fmtDate(state.cfg.eventDate)} \u00b7 catalogue ${ago(cat)}`;
    }
    renderHealth();
    document.querySelectorAll('.js-ago').forEach((el2) => {
      const iso = el2.dataset.iso;
      if (iso) el2.textContent = ago(iso);
    });
    if (state.osmFresh) {
      const o = $('#osm-fresh');
      if (o) o.textContent = 'OSM snapshot ' + ago(state.osmFresh.replace(' ', 'T'));
    }
  };
  setInterval(tick, 30000);
}

function ago(iso) {
  if (!iso) return '';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (isNaN(mins)) return '';
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 36) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

function tileToQuadkey(x, y, z) {
  let qk = '';
  for (let i = z; i > 0; i--) {
    let digit = 0;
    const mask = 1 << (i - 1);
    if ((x & mask) !== 0) digit += 1;
    if ((y & mask) !== 0) digit += 2;
    qk += digit;
  }
  return qk;
}

/* ------------------------------------------------------------------- maps */

function baseStyle() {
  return {
    version: 8,
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#0a0d11' } }]
  };
}

let pmtilesRegistered = false;
function ensurePmtiles() {
  if (pmtilesRegistered || typeof pmtiles === 'undefined') return;
  maplibregl.addProtocol('pmtiles', new pmtiles.Protocol().tile);
  pmtilesRegistered = true;
}

function makeMap(container) {
  ensurePmtiles();
  const m = new maplibregl.Map({
    container,
    style: baseStyle(),
    center: state.cfg.center || [0, 0],
    zoom: state.cfg.zoom || 10,
    maxZoom: 22,
    attributionControl: false,
    transformRequest: (url) => {
      const bing = url.match(/^https:\/\/bing\.tiles\.invalid\/(\d+)\/(\d+)\/(\d+)/);
      if (bing) {
        const z = +bing[1], x = +bing[2], y = +bing[3];
        const qk = tileToQuadkey(x, y, z);
        const server = x % 4;
        return { url: `https://ecn.t${server}.tiles.virtualearth.net/tiles/a${qk}.jpeg?g=1` };
      }
      return { url };
    }
  });
  m.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-left');
  m.addControl(new maplibregl.ScaleControl({ maxWidth: 110, unit: 'metric' }), 'bottom-right');
  m.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
  return m;
}

function eachMap(fn) {
  if (state.mapA) fn(state.mapA, 'A');
  if (state.mapB && state.compare) fn(state.mapB, 'B');
}

/* Apply the current layer stack to one map instance. Rebuilt wholesale on
 * change: the stacks are small (a handful of raster layers) and this avoids a
 * class of ordering bugs that are painful to debug during a live response. */
function renderMap(map, which) {
  if (!map) return;
  // Adding a source briefly puts the style back into a loading state. If a
  // second layer is toggled during that window a plain early return would drop
  // it silently, so keep the latest requested render and retry until the style
  // settles. The "idle" event is not reliable here because tile loading can
  // keep the map busy indefinitely.
  if (!map.isStyleLoaded()) {
    map._pendingRender = which;
    if (!map._pendingTimer) {
      map._pendingTimer = setInterval(() => {
        if (!map.isStyleLoaded()) return;
        clearInterval(map._pendingTimer);
        map._pendingTimer = null;
        const w = map._pendingRender;
        map._pendingRender = null;
        if (w) renderMap(map, w);
      }, 120);
    }
    return;
  }
  if (map._pendingTimer) { clearInterval(map._pendingTimer); map._pendingTimer = null; }
  map._pendingRender = null;

  // Remove everything we added previously.
  const style = map.getStyle();
  for (const layer of style.layers.slice().reverse()) {
    if (layer.id !== 'bg') map.removeLayer(layer.id);
  }
  for (const id of Object.keys(style.sources || {})) map.removeSource(id);

  // Basemap.
  const bm = BASEMAPS.find((b) => b.id === state.basemap);
  if (bm && bm.tiles) {
    map.addSource('basemap', {
      type: 'raster', tiles: bm.tiles, tileSize: 256,
      maxzoom: bm.maxzoom || 19, attribution: bm.attribution
    });
    map.addLayer({ id: 'basemap', type: 'raster', source: 'basemap' });
  }

  // Imagery stack, bottom to top. In compare mode each map shows only its side.
  const stack = state.compare
    ? state.active.filter((a) => a.side === (which === 'A' ? 'left' : 'right'))
    : state.active;

  stack.slice().reverse().forEach((a, i) => {
    const sid = `img-${i}`;
    map.addSource(sid, {
      type: 'raster', tiles: [a.url], tileSize: 256,
      minzoom: a.minzoom || 0, maxzoom: a.maxzoom || 22,
      attribution: a.attribution || ''
    });
    map.addLayer({
      id: sid, type: 'raster', source: sid,
      paint: { 'raster-opacity': a.opacity, 'raster-fade-duration': 120 }
    });
  });

  // Vector overlays sit above imagery.
  addVectors(map);
}

function renderAll() { eachMap(renderMap); }

/* --------------------------------------------------------------- vectors */

function addVectors(map) {
  const cat = state.catalog;

  // Task grid. The projects share an identical AOI, so grids are drawn for one
  // project at a time; stacking them is unreadable.
  if (state.showTaskGrid && state.taskGrid && state.gridProject) {
    const p = cat.tm_projects.find((x) => x.id === state.gridProject);
    const geoms = p && state.taskGrid[String(p.id)];
    const statuses = p && p.task_status;
    if (geoms && statuses) {
      // Joined by task id, so a reordered grid cannot mislabel statuses.
      const feats = Object.entries(geoms).map(([tid, g]) => ({
        type: 'Feature', geometry: g,
        properties: { s: statuses[tid] || 'READY', tid }
      }));
      map.addSource('tasks', { type: 'geojson', data: { type: 'FeatureCollection', features: feats } });
      const colorExpr = ['match', ['get', 's']];
      for (const [k, v] of Object.entries(TASK_COLORS)) colorExpr.push(k, v);
      colorExpr.push('#3b4655');
      map.addLayer({
        id: 'tasks-fill', type: 'fill', source: 'tasks',
        paint: {
          'fill-color': colorExpr,
          'fill-opacity': ['match', ['get', 's'], 'READY', 0.14, 0.4]
        }
      });
      map.addLayer({
        id: 'tasks-line', type: 'line', source: 'tasks',
        paint: { 'line-color': colorExpr, 'line-width': 0.6, 'line-opacity': 0.5 }
      });
    }
  }

  // Tasking Manager project extents. Each project toggles independently and
  // gets its own colour, because their boundaries overlap almost exactly.
  const shown = cat.tm_projects.filter((p) => p.aoi && state.tmOn.has(p.id));
  if (shown.length) {
    // Offset the line width slightly per project so coincident boundaries
    // remain distinguishable rather than painting over one another.
    shown.forEach((p, idx) => {
      const i = cat.tm_projects.indexOf(p);
      const color = PROJECT_COLORS[i % PROJECT_COLORS.length];
      const sid = `tm-${p.id}`;
      map.addSource(sid, {
        type: 'geojson',
        data: { type: 'Feature', geometry: p.aoi, properties: { id: p.id } }
      });
      map.addLayer({
        id: sid + '-fill', type: 'fill', source: sid,
        paint: { 'fill-color': color, 'fill-opacity': state.showTaskGrid ? 0.02 : 0.05 }
      });
      map.addLayer({
        id: sid + '-line', type: 'line', source: sid,
        paint: {
          'line-color': color,
          'line-width': 2.5,
          'line-opacity': 0.95,
          'line-offset': idx * 3
        }
      });
    });
  }

  // Config-driven vector layers (UNOSAT extent, and similar).
  for (const layer of (state.cfg.extraLayers || [])) {
    if (!state.vectorsOn.has(layer.id)) continue;

    if (layer.type === 'geojson') {
      const data = state._geojson && state._geojson[layer.id];
      if (!data) continue;
      map.addSource(layer.id, { type: 'geojson', data, attribution: layer.attribution || '' });
      if (layer.fill !== false) {
        map.addLayer({ id: layer.id + '-fill', type: 'fill', source: layer.id,
          paint: { 'fill-color': layer.color || '#d73f3f', 'fill-opacity': 0.25 } });
      }
      map.addLayer({ id: layer.id + '-line', type: 'line', source: layer.id,
        paint: { 'line-color': layer.color || '#d73f3f', 'line-width': 1.6, 'line-opacity': 0.95 } });

    } else if (layer.type === 'pmtiles') {
      map.addSource(layer.id, {
        type: 'vector', url: 'pmtiles://' + layer.url,
        attribution: layer.attribution || ''
      });
      map.addLayer({
        id: layer.id + '-fill', type: 'fill', source: layer.id,
        'source-layer': layer.sourceLayer,
        minzoom: layer.minzoom || 0,
        paint: {
          'fill-color': layer.color || '#c8a3ff',
          'fill-opacity': layer.opacity != null ? layer.opacity : 0.5,
          'fill-outline-color': '#ffffff'
        }
      });
      map.addLayer({
        id: layer.id + '-line', type: 'line', source: layer.id,
        'source-layer': layer.sourceLayer,
        minzoom: layer.minzoom || 0,
        paint: { 'line-color': layer.color || '#c8a3ff', 'line-width': 1.1, 'line-opacity': 0.9 }
      });
    }
  }

  // Esri basemap capture dates, drawn under everything else.
  if (state.vectorsOn.has('esri-seamlines') && state._seamlines) {
    map.addSource('seamlines', { type: 'geojson', data: state._seamlines });
    const colorExpr = ['step', ['coalesce', ['get', 'year'], 0]];
    const asc = SEAMLINE_BANDS.slice().reverse();
    colorExpr.push(asc[0].color);
    for (const b of asc.slice(1)) colorExpr.push(b.from, b.color);
    map.addLayer({
      id: 'seamlines-fill', type: 'fill', source: 'seamlines',
      paint: { 'fill-color': colorExpr, 'fill-opacity': 0.22 }
    });
    map.addLayer({
      id: 'seamlines-line', type: 'line', source: 'seamlines',
      paint: { 'line-color': colorExpr, 'line-width': 1.2, 'line-opacity': 0.9 }
    });
  }

  // Live OpenStreetMap. Buildings and roads are styled distinctly, and anything
  // edited since the event is highlighted so mapping progress is visible.
  const osmData = state._osm || (state.showAoiOsm ? state.osmAoi : null);
  if (osmData) {
    map.addSource('osm-live', { type: 'geojson', data: osmData });
    map.addLayer({
      id: 'osm-bldg-fill', type: 'fill', source: 'osm-live',
      filter: ['all', ['==', ['geometry-type'], 'Polygon'], ['==', ['get', '_kind'], 'building']],
      paint: {
        'fill-color': ['case', ['==', ['get', '_new'], 1], OSM_NEW, OSM_BUILDING],
        'fill-opacity': 0.4
      }
    });
    map.addLayer({
      id: 'osm-bldg-line', type: 'line', source: 'osm-live',
      filter: ['all', ['==', ['geometry-type'], 'Polygon'], ['==', ['get', '_kind'], 'building']],
      paint: {
        'line-color': ['case', ['==', ['get', '_new'], 1], OSM_NEW, OSM_BUILDING],
        'line-width': 1
      }
    });
    // Roads: casing plus a coloured core, width scaled by class and zoom.
    // A zoom expression has to be the top-level interpolate, so the casing gets
    // its own set of stops rather than arithmetic wrapped around the core width.
    const roadFilter = ['==', ['get', '_kind'], 'road'];
    const widthStops = (bump) => [
      'interpolate', ['linear'], ['zoom'],
      12, ['match', ['get', '_class'], 'major', 2.2 + bump, 'minor', 1.2 + bump, 0.8 + bump],
      18, ['match', ['get', '_class'], 'major', 9 + bump, 'minor', 5 + bump, 3 + bump]
    ];
    map.addLayer({
      id: 'osm-road-case', type: 'line', source: 'osm-live', filter: roadFilter,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#0e1116', 'line-width': widthStops(2), 'line-opacity': 0.75 }
    });
    // line-dasharray cannot be data-driven, so tracks get their own layer.
    map.addLayer({
      id: 'osm-road', type: 'line', source: 'osm-live',
      filter: ['all', roadFilter, ['!=', ['get', '_class'], 'track']],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['case', ['==', ['get', '_new'], 1], OSM_NEW, OSM_ROAD],
        'line-width': widthStops(0)
      }
    });
    map.addLayer({
      id: 'osm-track', type: 'line', source: 'osm-live',
      filter: ['all', roadFilter, ['==', ['get', '_class'], 'track']],
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: {
        'line-color': ['case', ['==', ['get', '_new'], 1], OSM_NEW, OSM_ROAD],
        'line-width': widthStops(0),
        'line-dasharray': [2, 1.5]
      }
    });
  }

  if (state._hover) {
    map.addSource('hover', { type: 'geojson', data: state._hover });
    map.addLayer({
      id: 'hover-line', type: 'line', source: 'hover',
      paint: { 'line-color': '#ffffff', 'line-width': 2, 'line-dasharray': [2, 2] }
    });
  }
}

function shortProjectName(name) {
  return String(name || '')
    .replace(/^Nepal Flood 2026 Response - /, '')
    .replace(/Upper Trishuli and Bhote Koshi Corridor\s*/, '')
    .replace(/[\[\]]/g, '')
    .trim() || 'project';
}

/* --------------------------------------------------------------- compare */

function syncMaps(from, to) {
  if (state.syncing) return;
  state.syncing = true;
  to.jumpTo({
    center: from.getCenter(), zoom: from.getZoom(),
    bearing: from.getBearing(), pitch: from.getPitch()
  });
  state.syncing = false;
}

function setSplit(pct) {
  state.splitPct = Math.max(2, Math.min(98, pct));
  const wrap = $('#mapwrap');
  const w = wrap.clientWidth;
  const x = (state.splitPct / 100) * w;
  $('#map-b').style.clipPath = `inset(0 0 0 ${state.splitPct}%)`;
  $('#swipe-handle').style.left = `${x}px`;
}

function enableCompare(on) {
  state.compare = on;
  $('#compare-controls').hidden = !on;
  $('#swipe-handle').hidden = !on;
  $('#map-b').hidden = !on;

  if (on) {
    if (!state.mapB) {
      state.mapB = makeMap('map-b');
      state.mapB.on('load', () => {
        // Adopt map A's current view, otherwise the second map opens at the
        // event's default position rather than wherever the user is looking.
        syncMaps(state.mapA, state.mapB);
        renderMap(state.mapB, 'B');
        setSplit(state.splitPct);
      });
      state.mapA.on('move', () => syncMaps(state.mapA, state.mapB));
      state.mapB.on('move', () => syncMaps(state.mapB, state.mapA));
    } else {
      state.mapB.resize();
      syncMaps(state.mapA, state.mapB);
    }
    // Every layer is created on the right, so a "does anything sit on the right"
    // test never fires and the left pane would open blank. Split the stack
    // instead: newest on the right, next one on the left.
    if (state.active.length && !state.active.some((a) => a.side === 'left')) {
      if (state.active.length === 1) {
        state.active[0].side = 'right';
      } else {
        state.active.forEach((a, i) => { a.side = i === 0 ? 'right' : 'left'; });
      }
    }
    setSplit(state.splitPct);
  }
  renderAll();
  renderActive();
}

function initSwipeDrag() {
  const handle = $('#swipe-handle');
  let dragging = false;
  const move = (e) => {
    if (!dragging) return;
    const rect = $('#mapwrap').getBoundingClientRect();
    const cx = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
    setSplit((cx / rect.width) * 100);
    e.preventDefault();
  };
  const stop = () => { dragging = false; document.body.style.cursor = ''; };
  handle.addEventListener('mousedown', (e) => { dragging = true; document.body.style.cursor = 'ew-resize'; e.preventDefault(); });
  handle.addEventListener('touchstart', (e) => { dragging = true; e.preventDefault(); }, { passive: false });
  window.addEventListener('mousemove', move);
  window.addEventListener('touchmove', move, { passive: false });
  window.addEventListener('mouseup', stop);
  window.addEventListener('touchend', stop);
}

/* ------------------------------------------------------------ layer stack */

function toggleScene(scene) {
  const key = 's:' + scene.id;
  const i = state.active.findIndex((a) => a.key === key);
  if (i >= 0) {
    state.active.splice(i, 1);
  } else {
    state.active.unshift({
      key, name: scene.title, kind: 'scene', scene,
      url: (scene.tile_url || scene.tms).replace(/\{-y\}/g, '{y}'),
      opacity: 1, side: 'right',
      attribution: scene.attribution || `${scene.provider} via OpenAerialMap`,
      maxzoom: 22
    });
  }
  renderActive(); renderCatalog(); renderAll(); writeHash();
}

function toggleExtraRaster(layer) {
  const key = 'x:' + layer.id;
  const i = state.active.findIndex((a) => a.key === key);
  if (i >= 0) state.active.splice(i, 1);
  else state.active.unshift({
    key, name: layer.name, kind: 'extra', layer,
    url: layer.url, opacity: 1, side: 'right',
    attribution: layer.attribution || '', maxzoom: layer.maxzoom || 18
  });
  renderActive(); renderMosaics(); renderAll(); writeHash();
}

function isActive(key) { return state.active.some((a) => a.key === key); }

/* ------------------------------------------------------------------- UI */

function renderActive() {
  const block = $('#active-block');
  const list = $('#active-list');
  block.hidden = state.active.length === 0;
  list.innerHTML = '';

  state.active.forEach((a, idx) => {
    const item = el('div', 'active-item');
    const row = el('div', 'row1');
    row.appendChild(el('span', 'nm', esc(a.name)));

    if (idx > 0) {
      const up = el('button', 'iconbtn', '&#9650;');
      up.title = 'Move up';
      up.onclick = () => { const t = state.active[idx - 1]; state.active[idx - 1] = state.active[idx]; state.active[idx] = t; renderActive(); renderAll(); };
      row.appendChild(up);
    }
    if (idx < state.active.length - 1) {
      const dn = el('button', 'iconbtn', '&#9660;');
      dn.title = 'Move down';
      dn.onclick = () => { const t = state.active[idx + 1]; state.active[idx + 1] = state.active[idx]; state.active[idx] = t; renderActive(); renderAll(); };
      row.appendChild(dn);
    }
    const rm = el('button', 'iconbtn rm', '&#10005;');
    rm.title = 'Remove';
    rm.onclick = () => { state.active.splice(idx, 1); renderActive(); renderCatalog(); renderMosaics(); renderAll(); writeHash(); };
    row.appendChild(rm);
    item.appendChild(row);

    const orow = el('div', 'opacity-row');
    const rng = el('input');
    rng.type = 'range'; rng.min = 0; rng.max = 100; rng.value = Math.round(a.opacity * 100);
    const pct = el('span', 'pct', `${Math.round(a.opacity * 100)}%`);
    rng.oninput = () => {
      a.opacity = rng.value / 100;
      pct.textContent = `${rng.value}%`;
      eachMap((m) => {
        const stack = state.compare ? state.active.filter((x) => x.side === a.side) : state.active;
        const pos = stack.indexOf(a);
        if (pos < 0) return;
        const lid = `img-${stack.length - 1 - pos}`;
        if (m.getLayer(lid)) m.setPaintProperty(lid, 'raster-opacity', a.opacity);
      });
    };
    orow.appendChild(rng); orow.appendChild(pct);
    item.appendChild(orow);
    list.appendChild(item);
  });

  // Compare side selectors.
  for (const side of ['left', 'right']) {
    const sel = $(`#cmp-${side}`);
    sel.innerHTML = '';
    state.active.forEach((a) => {
      const o = el('option'); o.value = a.key; o.textContent = a.name; sel.appendChild(o);
    });
    const cur = state.active.find((a) => a.side === side);
    if (cur) sel.value = cur.key;
    sel.onchange = () => {
      const chosen = state.active.find((a) => a.key === sel.value);
      if (!chosen) return;
      chosen.side = side;
      renderAll();
    };
  }
}

function renderCatalog() {
  const wrap = $('#scene-groups');
  const q = ($('#scene-search').value || '').trim().toLowerCase();
  const aoiOnly = $('#aoi-only').checked;
  wrap.innerHTML = '';

  let shown = 0;
  for (const g of GROUPS) {
    let scenes = state.scenes.filter((s) => s.group === g.id);
    if (aoiOnly) scenes = scenes.filter((s) => s.in_aoi);
    if (q) {
      scenes = scenes.filter((s) =>
        (s.title || '').toLowerCase().includes(q) ||
        (s.provider || '').toLowerCase().includes(q) ||
        (s.sensor || '').toLowerCase().includes(q) ||
        (s.acquired || '').toLowerCase().includes(q));
    }
    if (!scenes.length) continue;
    shown += scenes.length;

    const box = el('div', 'group' + (state.collapsed.has(g.id) ? ' collapsed' : ''));
    const head = el('button', 'group-head');
    head.innerHTML =
      `<span class="caret">${state.collapsed.has(g.id) ? '&#9654;' : '&#9660;'}</span>` +
      `<span class="dot" style="background:${g.color}"></span>` +
      `<span>${esc(g.name)}</span><span class="n">${scenes.length}</span>`;
    head.onclick = () => {
      if (state.collapsed.has(g.id)) state.collapsed.delete(g.id); else state.collapsed.add(g.id);
      renderCatalog();
    };
    box.appendChild(head);

    const body = el('div', 'group-body');
    for (const s of scenes) body.appendChild(sceneRow(s));
    box.appendChild(body);
    wrap.appendChild(box);
  }

  if (!shown) wrap.appendChild(el('p', 'empty', 'No scenes match this filter.'));
  const total = state.scenes.filter((s) => !aoiOnly || s.in_aoi).length;
  $('#scene-count').textContent = `${shown} of ${total}`;
}

function sceneRow(s) {
  const key = 's:' + s.id;
  const on = isActive(key);
  const row = el('div', 'scene' + (on ? ' on' : ''));

  const cb = el('input'); cb.type = 'checkbox'; cb.checked = on;
  cb.onclick = (e) => { e.stopPropagation(); toggleScene(s); };
  row.appendChild(cb);

  const body = el('div', 'body');
  const gsd = fmtGsd(s.gsd_cm);
  let badges = '';
  if (s.phase === 'post') badges += '<span class="badge post">post</span>';
  if (s.gsd_cm != null && s.gsd_cm <= 25) badges += '<span class="badge hires">hi-res</span>';
  if (s.gsd_cm != null && s.gsd_cm >= 300) badges += '<span class="badge coarse">coarse</span>';
  // Cloud cover comes from the provider's STAC, not OpenAerialMap. At 70-80%
  // cloud it is the difference between a useful scene and a wasted click.
  if (s.cloud_pct != null) {
    const cls = s.cloud_pct >= 70 ? 'cloudy' : s.cloud_pct >= 30 ? 'part' : 'clear';
    badges += `<span class="badge ${cls}">${Math.round(s.cloud_pct)}% cloud</span>`;
  }
  body.appendChild(el('div', 't', esc(s.title) + badges));
  // The sensor is already in the title (WV02, WV03, LG01, GE01), and the STAC
  // platform field only says "maxar", so it is not repeated here.
  const bits = [`<b>${fmtDate(s.acquired)}</b>`];
  if (gsd) bits.push(gsd);
  bits.push(esc(s.provider));
  body.appendChild(el('div', 'd', bits.join(' &middot; ')));
  if (s.note) body.appendChild(el('div', 'note', esc(s.note)));
  row.appendChild(body);

  const link = el('a', 'ext', '&#8599;');
  link.href = s.oam_url; link.target = '_blank'; link.rel = 'noopener';
  link.title = 'Open in OpenAerialMap';
  link.onclick = (e) => e.stopPropagation();
  row.appendChild(link);

  row.onclick = () => { toggleScene(s); if (s.bbox && s.bbox.length === 4) fitBbox(s.bbox); };
  row.onmouseenter = () => { showFootprint(s); };
  row.onmouseleave = () => { showFootprint(null); };
  return row;
}

function showFootprint(s) {
  if (!s || !s.bbox || s.bbox.length !== 4) { state._hover = null; }
  else {
    const [w, sN, e, n] = s.bbox;
    state._hover = {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: {},
        geometry: { type: 'Polygon', coordinates: [[[w, sN], [e, sN], [e, n], [w, n], [w, sN]]] } }]
    };
  }
  eachMap((m) => {
    if (m.getLayer('hover-line')) m.removeLayer('hover-line');
    if (m.getSource('hover')) m.removeSource('hover');
    if (state._hover && m.isStyleLoaded()) {
      m.addSource('hover', { type: 'geojson', data: state._hover });
      m.addLayer({ id: 'hover-line', type: 'line', source: 'hover',
        paint: { 'line-color': '#ffffff', 'line-width': 2, 'line-dasharray': [2, 2] } });
    }
  });
}

function fitBbox(b) {
  eachMap((m) => m.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 60, duration: 700 }));
}

/* One row renderer for every config-driven layer. Rasters join the imagery
 * stack (so they get an opacity slider and can be swiped); GeoJSON and PMTiles
 * are vector overlays toggled on top. */
function layerRow(layer) {
  const isRaster = layer.type === 'raster';
  const key = 'x:' + layer.id;
  const on = isRaster ? isActive(key) : state.vectorsOn.has(layer.id);

  const ref = el('div', 'ref');
  const top = el('div', 'top');
  const cb = el('input'); cb.type = 'checkbox'; cb.checked = on;
  cb.onchange = async () => {
    if (isRaster) { toggleExtraRaster(layer); return; }
    if (cb.checked) {
      state.vectorsOn.add(layer.id);
      if (layer.type === 'geojson') await loadGeojson(layer);
    } else {
      state.vectorsOn.delete(layer.id);
    }
    renderAll(); writeHash();
  };
  top.appendChild(cb);
  if (layer.color) {
    const sw = el('span', 'sw'); sw.style.background = layer.color; top.appendChild(sw);
  }
  top.appendChild(el('span', 'nm', esc(layer.name)));
  ref.appendChild(top);

  if (layer.info) {
    ref.appendChild(el('div', 'd', esc(layer.info) +
      (layer.link ? ` <a href="${esc(layer.link)}" target="_blank" rel="noopener">source &#8599;</a>` : '')));
  }
  return ref;
}

function renderLayerGroup(selector, groups, emptyText) {
  const wrap = $(selector);
  wrap.innerHTML = '';
  const layers = (state.cfg.extraLayers || []).filter((l) => groups.includes(l.group || 'impact'));
  if (!layers.length) { wrap.appendChild(el('p', 'empty', emptyText)); return; }
  for (const l of layers) wrap.appendChild(layerRow(l));
}

function renderMosaics() {
  renderLayerGroup('#mosaic-list', ['mosaic'], 'None configured for this event.');
}

function renderImpact() {
  renderLayerGroup('#impact-list', ['impact', 'reference'], 'None configured.');
}

function renderBasemaps() {
  const wrap = $('#basemap-list');
  wrap.innerHTML = '';
  for (const b of BASEMAPS) {
    const lab = el('label', 'chk');
    const r = el('input'); r.type = 'radio'; r.name = 'basemap'; r.checked = state.basemap === b.id;
    r.onchange = () => { state.basemap = b.id; renderAll(); writeHash(); };
    lab.appendChild(r);
    lab.appendChild(el('span', null, esc(b.name) + (b.note ? ` <span class="meta">- ${esc(b.note)}</span>` : '')));
    wrap.appendChild(lab);
  }
}

function renderTM() {
  const wrap = $('#tm-list');
  const toggles = $('#tm-toggles');
  wrap.innerHTML = ''; toggles.innerHTML = '';
  const projects = state.catalog.tm_projects || [];

  if (!projects.length) {
    wrap.appendChild(el('p', 'empty', 'No projects found for this campaign.'));
    return;
  }

  projects.forEach((p, i) => {
    const color = PROJECT_COLORS[i % PROJECT_COLORS.length];
    const ref = el('div', 'ref');

    const top = el('div', 'top');
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = state.tmOn.has(p.id);
    cb.onchange = () => {
      cb.checked ? state.tmOn.add(p.id) : state.tmOn.delete(p.id);
      renderAll(); writeHash();
    };
    top.appendChild(cb);
    const sw = el('span', 'sw'); sw.style.background = color; top.appendChild(sw);
    top.appendChild(el('span', 'nm',
      `<a href="${esc(p.url)}" target="_blank" rel="noopener">#${p.id}</a> ${esc(shortProjectName(p.name))}`));
    const pr = (p.priority || '').toLowerCase();
    if (p.priority) {
      top.appendChild(el('span',
        `pill ${pr === 'urgent' ? 'urgent' : pr === 'high' ? 'high' : 'other'}`, esc(p.priority)));
    }
    ref.appendChild(top);

    const m = p.percent_mapped || 0, v = p.percent_validated || 0;
    const bar = el('div', 'bar');
    bar.innerHTML = `<i class="m" style="width:${m}%"></i>` +
                    `<i class="v" style="width:${Math.min(v, Math.max(0, 100 - m))}%"></i>`;
    ref.appendChild(bar);

    let detail = `${m}% mapped &middot; ${v}% validated`;
    if (p.task_counts) {
      detail += ` &middot; ${Object.values(p.task_counts).reduce((a, b) => a + b, 0)} tasks`;
    }
    if (p.imagery) detail += ` &middot; imagery: ${esc(p.imagery)}`;
    ref.appendChild(el('div', 'd', detail));

    if (p.task_counts) {
      const order = ['VALIDATED', 'MAPPED', 'LOCKED_FOR_MAPPING', 'LOCKED_FOR_VALIDATION',
                     'READY', 'BADIMAGERY', 'INVALIDATED'];
      const parts = order.filter((k) => p.task_counts[k]).map((k) =>
        `<span class="lg"><i style="background:${TASK_COLORS[k]}"></i>${p.task_counts[k]} ${esc(TASK_LABELS[k] || k)}</span>`);
      if (parts.length) ref.appendChild(el('div', 'legend inline', parts.join('')));
    }

    const actions = el('div', 'row-actions');
    const gridOn = state.showTaskGrid && state.gridProject === p.id;
    const gridBtn = el('button', 'linkbtn');
    gridBtn.textContent = gridOn ? 'hide task grid' : 'show task grid';
    gridBtn.onclick = async () => {
      if (gridOn) { state.showTaskGrid = false; state.gridProject = null; }
      else { state.showTaskGrid = true; state.gridProject = p.id; await loadTaskGrid(); }
      renderTM(); renderTaskLegend(); renderAll(); writeHash();
    };
    actions.appendChild(gridBtn);

    const zoom = el('button', 'linkbtn');
    zoom.textContent = 'zoom to extent';
    zoom.onclick = () => { if (p.aoi) fitGeometry(p.aoi); };
    actions.appendChild(zoom);
    ref.appendChild(actions);

    wrap.appendChild(ref);
  });

  renderTaskLegend();
}

function renderTaskLegend() {
  const box = $('#tm-legend');
  box.hidden = !state.showTaskGrid;
  if (!state.showTaskGrid) return;
  const order = ['READY', 'MAPPED', 'VALIDATED', 'LOCKED_FOR_MAPPING', 'BADIMAGERY'];
  box.innerHTML = order
    .map((k) => `<span class="lg"><i style="background:${TASK_COLORS[k]}"></i>${esc(TASK_LABELS[k])}</span>`)
    .join('');
}

async function loadTaskGrid() {
  if (state.taskGrid) return;
  try {
    const r = await fetch(`${BASE}data/${state.cfg.id}.taskgrid.json`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    state.taskGrid = await r.json();
  } catch (e) {
    console.warn('Task grid unavailable:', e);
    state.showTaskGrid = false;
  }
}

function fitGeometry(geom) {
  let minX = 180, minY = 90, maxX = -180, maxY = -90;
  const walk = (c) => {
    if (Array.isArray(c) && c.length === 2 && typeof c[0] === 'number' && typeof c[1] === 'number') {
      minX = Math.min(minX, c[0]); maxX = Math.max(maxX, c[0]);
      minY = Math.min(minY, c[1]); maxY = Math.max(maxY, c[1]);
    } else if (Array.isArray(c)) c.forEach(walk);
  };
  walk(geom.coordinates);
  eachMap((m) => m.fitBounds([[minX, minY], [maxX, maxY]], { padding: 50, duration: 700 }));
}

async function loadSeamlines() {
  if (state._seamlines) return true;
  const file = state.catalog.esri_seamlines;
  if (!file) return false;
  try {
    const r = await fetch(`${BASE}data/${file}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    state._seamlines = await r.json();
    return true;
  } catch (e) {
    console.warn('Esri seamlines unavailable:', e);
    return false;
  }
}

function seamlineSummary() {
  const f = state._seamlines && state._seamlines.features;
  if (!f || !f.length) return '';
  const years = f.map((x) => x.properties.year).filter(Boolean).sort((a, b) => a - b);
  const median = years[Math.floor(years.length / 2)];
  return `${f.length} source images, ${years[0]} to ${years[years.length - 1]}, median ${median}`;
}

async function loadGeojson(layer) {
  state._geojson = state._geojson || {};
  if (state._geojson[layer.id]) return;
  try {
    const r = await fetch(layer.url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    state._geojson[layer.id] = await r.json();
  } catch (e) {
    console.warn(`Could not load ${layer.id}:`, e);
    state.vectorsOn.delete(layer.id);
  }
}

function renderLists() {
  const hdx = $('#hdx-list'); hdx.innerHTML = '';
  for (const d of (state.catalog.hdx || [])) {
    const ref = el('div', 'ref');
    ref.appendChild(el('div', 'top',
      `<span class="nm"><a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.title || d.slug)}</a></span>`));
    ref.appendChild(el('div', 'd',
      `${d.num_resources || 0} resources &middot; updated ${fmtDate(d.last_modified)}`));
    hdx.appendChild(ref);
  }
  if (!hdx.children.length) hdx.appendChild(el('p', 'empty', 'None configured.'));

  const links = $('#link-list'); links.innerHTML = '';
  for (const l of (state.cfg.links || [])) {
    const ref = el('div', 'ref');
    ref.appendChild(el('div', 'top',
      `<span class="nm"><a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.name)} &#8599;</a></span>`));
    links.appendChild(ref);
  }
}

function renderPlaces() {
  const wrap = $('#places'); wrap.innerHTML = '';
  for (const p of (state.cfg.places || [])) {
    const b = el('button', null, esc(p.name));
    b.onclick = () => eachMap((m) => m.flyTo({ center: p.center, zoom: p.zoom || 14, duration: 900 }));
    wrap.appendChild(b);
  }
}

function renderAbout() {
  const c = state.catalog, cfg = state.cfg;
  const post = state.scenes.filter((s) => s.phase === 'post' && s.in_aoi).length;
  $('#about-body').innerHTML = `
    <h3>This viewer</h3>
    <p><a href="https://cgiovando.github.io/disaster-imagery-viewer/${esc(cfg.id)}/" target="_blank" rel="noopener">cgiovando.github.io/disaster-imagery-viewer/${esc(cfg.id)}/</a><br>
    <a href="https://github.com/cgiovando/disaster-imagery-viewer" target="_blank" rel="noopener">Source on GitHub &#8599;</a></p>

    <h3>The event</h3>
    <p>${esc(cfg.summary || '')}</p>
    <p><a href="${esc(cfg.wiki)}" target="_blank" rel="noopener">Activation wiki page &#8599;</a></p>

    <h3>What this shows</h3>
    <p>Every image over the corridor that has a live tile endpoint on
    OpenAerialMap, grouped by whether it predates or postdates the event, with
    its capture date and ground resolution. Imagery streams directly from the
    providers; nothing is re-hosted here.</p>

    <h3>Freshness</h3>
    <p>Imagery catalogue and task grids built
    <b class="js-ago" data-iso="${esc(c.generated)}" title="${esc(c.generated)}">${ago(c.generated)}</b>,
    refreshed hourly by CI. Tasking Manager progress is re-read live in your
    browser from the insta-tm mirror on each load, and Sentinel-1 and Sentinel-2
    are queried live from the Planetary Computer.</p>
    <p>The source APIs cannot be called from a static page: the OpenAerialMap API
    restricts CORS to its own site and the Tasking Manager API sends no CORS header
    at all. That is why the catalogue is pre-built.</p>

    <h3>Mapping since the event</h3>
    <p>The Live OpenStreetMap panel loads the activation area in the background on
    each visit and reports how many buildings and how many kilometres of road have
    been added or edited since the event. Those figures come from feature
    timestamps, so they measure real editing rather than task completion.</p>

    <h3>Counts</h3>
    <ul>
      <li>${state.scenes.filter((s) => s.in_aoi).length} scenes over the corridor AOI</li>
      <li>${post} post-event</li>
      <li>${(c.tm_projects || []).length} Tasking Manager projects</li>
    </ul>

    <h3>Sources and licences</h3>
    <ul>
      <li><a href="https://openaerialmap.org" target="_blank" rel="noopener">OpenAerialMap</a>
          - catalogue and tiles. Individual scenes carry their own licence; Vantor Open Data
          scenes are CC-BY-NC-4.0, most drone imagery is CC-BY-4.0.</li>
      <li>Tasking Manager state via an open mirror of the HOT TM API.</li>
      <li>UNOSAT flood extent and the regional mosaics are republished by the
          <a href="https://www.microsoft.com/en-us/research/group/ai-for-good-research-lab/" target="_blank" rel="noopener">Microsoft AI for Good Lab</a>.</li>
      <li>Sentinel-2 optical (true colour, SWIR, NDWI) via the Planetary Computer.</li>
      <li>Live OpenStreetMap features via HOT's
          <a href="https://api-prod.raw-data.hotosm.org/v1/docs" target="_blank" rel="noopener">Raw Data API</a>,
          with Overpass as a fallback.</li>
      <li>Sentinel-1 radar via the
          <a href="https://planetarycomputer.microsoft.com/" target="_blank" rel="noopener">Microsoft Planetary Computer</a>
          (Copernicus Sentinel data). Queried live, so a new pass appears without a rebuild.</li>
      <li>Esri World Imagery seamlines (basemap capture dates) from the Esri
          World_Imagery MapServer footprint layer.</li>
      <li>Basemaps as attributed on the map.</li>
    </ul>

    <h3>Caveats</h3>
    <p>This viewer shows imagery and published extents. It does not classify damage
    and no figure here should be read as a damage assessment. Absence of a scene means
    no scene has been published to OpenAerialMap, not that no imagery exists.
    Cloud cover shown on a scene comes from the provider's own STAC metadata where
    it is published; OpenAerialMap does not carry it, so scenes without a figure
    have to be judged visually.</p>
  `;
}

/* ---------------------------------------------------------- live OSM data */

/* HOT's Raw Data API is preferred over Overpass: it is HOT's own cloud-native
 * service, it reports how fresh its OSM snapshot is, it returns a per-feature
 * timestamp so we can highlight what has been mapped since the event, and it
 * is not subject to Overpass's rate limiting. Overpass stays as a fallback
 * because during an activation one working path matters more than elegance. */

/* The synchronous endpoint caps the request at 6 sq km. Above that the API
 * offers an async job which returns a zipped GeoJSON on S3 (CORS open), and
 * turns around ~76 sq km in about a second. Both paths are used so that the
 * Raw Data API stays primary at any zoom. */
const RD_SYNC_LIMIT_KM2 = 5.5;

function boundsPolygon(b) {
  const w = b.getWest(), s = b.getSouth(), e = b.getEast(), n = b.getNorth();
  return { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] };
}

function boundsAreaKm2(b) {
  const dLat = b.getNorth() - b.getSouth();
  const dLon = b.getEast() - b.getWest();
  const midLat = (b.getNorth() + b.getSouth()) / 2;
  return Math.abs(dLat * 110.57) * Math.abs(dLon * 111.32 * Math.cos(midLat * Math.PI / 180));
}

function rdFilters(want) {
  const join_or = {};
  if (want.includes('building')) join_or.building = [];
  if (want.includes('highway')) join_or.highway = [];
  return { tags: { all_geometry: { join_or } } };
}

async function fetchRawDataApi(bounds, want, onProgress, geometry) {
  const base = state.cfg.rawDataApi;
  if (!base) throw new Error('no Raw Data API configured');
  const body = {
    geometry: geometry || boundsPolygon(bounds),
    filters: rdFilters(want),
    geometryType: ['polygon', 'line']
  };

  if (!geometry && boundsAreaKm2(bounds) <= RD_SYNC_LIMIT_KM2) {
    const r = await fetch(`${base}/snapshot/plain/`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error(`Raw Data API HTTP ${r.status}`);
    const gj = await r.json();
    return { features: gj.features || [], source: 'HOT Raw Data API' };
  }

  // Larger area: async job.
  if (typeof fflate === 'undefined') throw new Error('unzip library unavailable');
  onProgress('Area is large, running a Raw Data API export job...');
  const sub = await fetch(`${base}/snapshot/`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, outputType: 'geojson' })
  });
  if (!sub.ok) throw new Error(`Raw Data API HTTP ${sub.status}`);
  const { task_id } = await sub.json();
  if (!task_id) throw new Error('no task id returned');

  // The export queue is usually a second or two but can back up under load, so
  // allow several minutes before giving up rather than reporting a false
  // failure on a job that would have succeeded.
  let result = null;
  for (let i = 0; i < 260; i++) {
    await new Promise((r) => setTimeout(r, i < 10 ? 400 : 1000));
    const st = await fetch(`${base}/tasks/status/${task_id}/`);
    if (!st.ok) continue;
    const d = await st.json();
    if (d.status === 'SUCCESS') { result = d.result; break; }
    if (d.status === 'FAILURE' || d.status === 'REVOKED') {
      throw new Error(`export ${d.status.toLowerCase()}`);
    }
    onProgress('Building the OpenStreetMap export...');
  }
  if (!result || !result.download_url) throw new Error('export did not finish in time');

  onProgress('Downloading export...');
  const zr = await fetch(result.download_url);
  if (!zr.ok) throw new Error(`download HTTP ${zr.status}`);
  const buf = new Uint8Array(await zr.arrayBuffer());
  const files = fflate.unzipSync(buf);
  const name = Object.keys(files).find((k) => /RawExport.*\.geojson$/i.test(k))
            || Object.keys(files).find((k) => k.endsWith('.geojson') && !/clipping/i.test(k));
  if (!name) throw new Error('no GeoJSON in export');
  const gj = JSON.parse(fflate.strFromU8(files[name]));
  return { features: gj.features || [], source: 'HOT Raw Data API (export)' };
}

async function fetchOverpass(bounds, want) {
  const bbox = [bounds.getSouth(), bounds.getWest(), bounds.getNorth(), bounds.getEast()]
    .map((v) => v.toFixed(5)).join(',');
  const parts = want.map((k) => `way["${k}"](${bbox});`).join('');
  const r = await fetch(OVERPASS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    // "meta" is required for the timestamp, without which nothing can be
    // flagged as edited since the event.
    body: 'data=' + encodeURIComponent(`[out:json][timeout:40];(${parts});out meta geom;`)
  });
  if (!r.ok) throw new Error(`Overpass HTTP ${r.status}`);
  const data = await r.json();
  const features = (data.elements || [])
    .filter((el) => el.type === 'way' && el.geometry && el.geometry.length > 1)
    .map((el) => {
      const coords = el.geometry.map((g) => [g.lon, g.lat]);
      const closed = coords.length > 3 &&
        coords[0][0] === coords[coords.length - 1][0] &&
        coords[0][1] === coords[coords.length - 1][1];
      return {
        type: 'Feature',
        properties: { tags: el.tags || {}, timestamp: el.timestamp },
        geometry: closed ? { type: 'Polygon', coordinates: [coords] }
                         : { type: 'LineString', coordinates: coords }
      };
    });
  return { features, source: 'Overpass (fallback)' };
}

const MAJOR_ROADS = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary',
  'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link']);

/* Tag the features so the map style can distinguish buildings from roads, and
 * work done since the event from what was already there. */
/* The Raw Data API returns timestamps with no timezone ("2026-08-27T04:46:45").
 * new Date() would read those as the viewer's local time, so the same feature
 * would count as edited-since-event in Kathmandu but not in California. Force
 * UTC before comparing. */
function parseUtc(ts) {
  if (!ts) return NaN;
  const s = String(ts);
  const hasZone = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(s);
  return new Date(hasZone ? s : s + 'Z').getTime();
}

function decorateOsm(features, eventIso) {
  const cutoff = parseUtc(eventIso);
  let fresh = 0;
  for (const f of features) {
    const tags = f.properties.tags || f.properties || {};
    const isBuilding = !!tags.building;
    const hw = tags.highway;
    f.properties._kind = isBuilding ? 'building' : (hw ? 'road' : 'other');
    f.properties._class = !hw ? '' : (MAJOR_ROADS.has(hw) ? 'major'
      : (hw === 'track' || hw === 'path' || hw === 'footway') ? 'track' : 'minor');
    const ts = f.properties.timestamp;
    const t = parseUtc(ts);
    const isNew = isNaN(t) ? false : t >= cutoff;
    f.properties._new = isNew ? 1 : 0;
    if (isNew) fresh++;
  }
  return fresh;
}

/* Great-circle length of a LineString, in kilometres. */
function lineLengthKm(coords) {
  const R = 6371;
  let km = 0;
  for (let i = 1; i < coords.length; i++) {
    const [lon1, lat1] = coords[i - 1], [lon2, lat2] = coords[i];
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    km += 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }
  return km;
}

function computeOsmStats(features) {
  const st = { buildings: 0, newBuildings: 0, roadKm: 0, newRoadKm: 0, total: features.length };
  for (const f of features) {
    const isNew = f.properties._new === 1;
    if (f.properties._kind === 'building') {
      st.buildings++;
      if (isNew) st.newBuildings++;
    } else if (f.properties._kind === 'road' && f.geometry.type === 'LineString') {
      const km = lineLengthKm(f.geometry.coordinates);
      st.roadKm += km;
      if (isNew) st.newRoadKm += km;
    }
  }
  return st;
}

/* Pull the whole activation AOI once, in the background, so the panel can show
 * how much has actually been mapped since the event without the user having to
 * ask for it. The AOI is buffered slightly because mapping routinely spills
 * over a project boundary. */
async function loadAoiOsm() {
  // Use the Tasking Manager AOI polygon itself, not its bounding box. The
  // bounding box here is roughly twelve times the area and reaches into the
  // northern fringe of Kathmandu, which would badly overstate the numbers.
  const project = (state.catalog.tm_projects || []).find((p) => p.aoi);
  if (!project) return;
  const status = $('#osm-aoi-status');
  const head = $('#osm-headline');
  head.hidden = false;
  head.className = 'osm-headline loading';
  const report = (m) => { status.textContent = m; head.textContent = m; };
  report('Loading OpenStreetMap for the activation area...');
  try {
    const res = await fetchRawDataApi(null, ['building', 'highway'], report, project.aoi);
    decorateOsm(res.features, state.cfg.eventDatetime || state.cfg.eventDate);
    state.osmAoi = { type: 'FeatureCollection', features: res.features };
    state.osmStats = computeOsmStats(res.features);
    state.osmStats.source = res.source;
    $('#osm-headline').className = 'osm-headline';
    renderOsmStats();
  } catch (e) {
    const msg = `Could not load activation-area statistics: ${e.message}.`;
    status.textContent = msg;
    const h = $('#osm-headline');
    h.className = 'osm-headline error';
    h.textContent = msg + ' ';
    const again = el('button', 'linkbtn');
    again.textContent = 'retry';
    again.onclick = () => loadAoiOsm();
    h.appendChild(again);
  }
}

function renderOsmStats() {
  const st = state.osmStats;
  const box = $('#osm-stats');
  const head = $('#osm-headline');
  if (!st) { box.innerHTML = ''; return; }

  // Repeat the headline in the header. The detail lives on the Reference tab,
  // which most people are not looking at when the load finishes.
  head.hidden = false;
  head.innerHTML =
    `<b>${st.newBuildings.toLocaleString()}</b> buildings and ` +
    `<b>${st.newRoadKm.toFixed(0)} km</b> of road mapped since the event`;
  head.title = `Of ${st.buildings.toLocaleString()} buildings and ` +
    `${st.roadKm.toFixed(0)} km of road in the activation area. Source: ${st.source}.`;
  const pct = st.buildings ? Math.round((st.newBuildings / st.buildings) * 100) : 0;
  box.innerHTML = `
    <div class="stat"><b>${st.newBuildings.toLocaleString()}</b>
      <span>buildings added or edited since the event</span>
      <em>of ${st.buildings.toLocaleString()} in the area (${pct}%)</em></div>
    <div class="stat"><b>${st.newRoadKm.toFixed(1)} km</b>
      <span>of road added or edited since the event</span>
      <em>of ${st.roadKm.toFixed(0)} km mapped in the area</em></div>`;
  $('#osm-aoi-status').textContent =
    `Activation area (${st.areaKm2 ? st.areaKm2 + ' km2, ' : ''}${st.total.toLocaleString()} features) ` +
    `via ${st.source}. Toggle the overlay to draw it.`;
  $('#osm-aoi-toggle-wrap').hidden = false;
}

async function loadOsm() {
  const btn = $('#osm-load'), status = $('#osm-status');
  const want = [];
  if ($('#osm-buildings').checked) want.push('building');
  if ($('#osm-highways').checked) want.push('highway');
  if (!want.length) { status.textContent = 'Select at least one feature type.'; return; }

  if (state.mapA.getZoom() < 12) { status.textContent = 'Zoom in to at least z12 before loading.'; return; }
  const bounds = state.mapA.getBounds();

  btn.disabled = true; status.textContent = 'Fetching from HOT Raw Data API...';
  const progress = (m) => { status.textContent = m; };
  let result = null, note = '';
  try {
    result = await fetchRawDataApi(bounds, want, progress);
  } catch (e) {
    note = `Raw Data API unavailable (${e.message}); fell back to Overpass. `;
    status.textContent = 'Raw Data API failed, trying Overpass...';
    try { result = await fetchOverpass(bounds, want); }
    catch (e2) {
      status.textContent = `Both sources failed. ${e.message} / ${e2.message}`;
      btn.disabled = false; return;
    }
  }

  const fresh = decorateOsm(result.features, state.cfg.eventDatetime || state.cfg.eventDate);
  state._osm = { type: 'FeatureCollection', features: result.features };
  const b = result.features.filter((f) => f.properties._kind === 'building').length;
  const r = result.features.filter((f) => f.properties._kind === 'road').length;
  status.textContent = `${note}${b.toLocaleString()} buildings, ${r.toLocaleString()} roads. ` +
    `${fresh.toLocaleString()} edited since the event. Source: ${result.source}.`;
  $('#osm-clear').hidden = false;
  renderOsmLegend(true);
  btn.disabled = false;
  renderAll();
}

function renderOsmLegend(show) {
  const box = $('#osm-legend');
  box.hidden = !show;
  if (!show) return;
  box.innerHTML = [
    [OSM_BUILDING, 'Building'],
    [OSM_ROAD, 'Road / track'],
    [OSM_NEW, 'Edited since the event']
  ].map(([c, l]) => `<span class="lg"><i style="background:${c}"></i>${esc(l)}</span>`).join('');
}

/* Report how current the Raw Data API snapshot is. */
async function refreshOsmFreshness() {
  const base = state.cfg.rawDataApi;
  if (!base) return;
  try {
    const r = await fetch(`${base}/status/`);
    if (!r.ok) return;
    const d = await r.json();
    if (d.lastUpdated) {
      state.osmFresh = d.lastUpdated;
      $('#osm-fresh').textContent = 'OSM snapshot ' + ago(d.lastUpdated.replace(' ', 'T'));
    }
  } catch (e) { /* non-critical */ }
}

/* --------------------------------------------------------- Sentinel-1 SAR */

/* Radar is the answer to persistent cloud, and the corridor is in monsoon
 * season. Queried live from the Microsoft Planetary Computer STAC API, which
 * is CORS-enabled, so a new pass shows up here as soon as it is published
 * without waiting for a catalogue rebuild. RTC is preferred over GRD because
 * it is terrain-corrected, which matters a great deal in this topography. */
async function loadSar() {
  const cfg = state.cfg.sar;
  const listEl = $('#sar-list');
  if (!cfg || !cfg.enabled) { listEl.innerHTML = '<p class="empty">Not configured.</p>'; return; }

  const ev = new Date(state.cfg.eventDatetime || state.cfg.eventDate);
  const from = new Date(ev.getTime() - (cfg.daysBefore || 30) * 864e5).toISOString();
  const to = new Date(ev.getTime() + (cfg.daysAfter || 30) * 864e5).toISOString();

  try {
    const r = await fetch(cfg.stac, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        collections: cfg.collections,
        bbox: state.cfg.bbox,
        datetime: `${from}/${to}`,
        limit: 50,
        sortby: [{ field: 'properties.datetime', direction: 'desc' }]
      })
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();

    // Prefer the terrain-corrected product when both exist for a pass.
    const byTime = new Map();
    for (const f of (d.features || [])) {
      const key = f.properties.datetime.slice(0, 16);
      const prev = byTime.get(key);
      const isRtc = f.collection === 'sentinel-1-rtc';
      if (!prev || (isRtc && prev.collection !== 'sentinel-1-rtc')) byTime.set(key, f);
    }
    state.sar = [...byTime.values()].sort((a, b) =>
      a.properties.datetime < b.properties.datetime ? 1 : -1);
    renderSar();
  } catch (e) {
    listEl.innerHTML = `<p class="empty">Radar search failed: ${esc(e.message)}</p>`;
  }
}

/* Shared render-mode dropdown for the Sentinel panels, with the explanation of
 * the selected mode underneath. Choosing how to render radar is most of the
 * difference between a useless grey image and a readable one. */
function renderModeSelect(selector, modes, current, onChange) {
  const box = $(selector);
  if (!box || !modes.length) return;
  box.innerHTML = '';
  const sel = el('select');
  for (const m of modes) {
    const o = el('option'); o.value = m.id; o.textContent = m.name;
    if (current && m.id === current.id) o.selected = true;
    sel.appendChild(o);
  }
  sel.onchange = () => onChange(modes.find((m) => m.id === sel.value));
  box.appendChild(sel);
  if (current && current.info) box.appendChild(el('p', 'hint', esc(current.info)));
}

function renderSar() {
  const listEl = $('#sar-list');
  listEl.innerHTML = '';
  const modes = (state.cfg.sar && state.cfg.sar.modes) || [];
  const mode = modes.find((m) => m.id === state.sarMode) || modes[0];
  renderModeSelect('#sar-mode', modes, mode, (m) => {
    state.sarMode = m.id;
    // Re-point any active SAR layer at the newly chosen rendering.
    state.active = state.active.filter((a) => a.kind !== 'sar');
    renderSar(); renderActive(); renderAll();
  });
  if (!state.sar.length) {
    listEl.innerHTML = '<p class="empty">No Sentinel-1 scenes in this window.</p>';
    return;
  }
  const eventTime = new Date(state.cfg.eventDatetime || state.cfg.eventDate).getTime();
  let post = 0;

  for (const f of state.sar) {
    const dt = f.properties.datetime;
    const isPost = new Date(dt).getTime() >= eventTime;
    if (isPost) post++;
    const rtc = f.collection === 'sentinel-1-rtc';

    for (const pol of ['vv', 'vh']) {
      if (!f.assets[pol]) continue;
      if (mode && mode.expression && mode.expression.indexOf('{pol}') === -1 && pol === 'vh') continue;
      const key = `sar:${f.id}:${pol}:${mode.id}`;
      const on = isActive(key);
      const row = el('div', 'scene' + (on ? ' on' : ''));
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = on;
      cb.onclick = (e) => { e.stopPropagation(); toggleSar(f, pol, mode); };
      row.appendChild(cb);
      const body = el('div', 'body');
      body.appendChild(el('div', 't',
        `${fmtDate(dt)} ${mode && mode.expression && mode.expression.indexOf('{pol}') === -1 ? '' : pol.toUpperCase()}` +
        (isPost ? '<span class="badge post">post</span>' : '') +
        (rtc ? '<span class="badge hires">RTC</span>' : '')));
      body.appendChild(el('div', 'd',
        `${esc(f.properties['sat:orbit_state'] || '')} &middot; orbit ${esc(String(f.properties['sat:relative_orbit'] ?? '?'))}` +
        ` &middot; ${rtc ? 'terrain-corrected' : 'GRD'}`));
      row.appendChild(body);
      row.onclick = () => toggleSar(f, pol, mode);
      listEl.appendChild(row);
    }
  }

  $('#sar-count').textContent = `${state.sar.length} passes`;
  const latestPre = state.sar.find((f) => new Date(f.properties.datetime).getTime() < eventTime);
  $('#sar-note').textContent = post
    ? `${post} post-event pass${post > 1 ? 'es' : ''} available.`
    : (latestPre
        ? `No post-event pass published yet. Latest pre-event: ${fmtDate(latestPre.properties.datetime)}. Sentinel-1 revisits this area every few days, so check back.`
        : '');
}

/* Build a Planetary Computer tile URL for a chosen render mode. Radar in
 * particular is unreadable as raw linear gamma0, so the mode matters. */
function pcTileUrl(tiler, collection, itemId, mode, pol) {
  const parts = [
    `collection=${encodeURIComponent(collection)}`,
    `item=${encodeURIComponent(itemId)}`,
    'asset_as_band=true'
  ];
  if (mode.expression) {
    const expr = mode.expression.replace(/\{pol\}/g, pol || 'vv');
    parts.push(`expression=${encodeURIComponent(expr)}`);
  } else if (mode.assets) {
    for (const a of mode.assets.split(',')) parts.push(`assets=${encodeURIComponent(a.trim())}`);
  }
  // A mode may carry several rescale ranges for an RGB composite, already
  // joined with "&rescale=" in the config.
  if (mode.rescale) parts.push(`rescale=${mode.rescale}`);
  if (mode.colormap) parts.push(`colormap_name=${encodeURIComponent(mode.colormap)}`);
  return `${tiler}?${parts.join('&')}`;
}

function toggleSar(feature, pol, mode) {
  const cfg = state.cfg.sar;
  const key = `sar:${feature.id}:${pol}:${mode.id}`;
  const i = state.active.findIndex((a) => a.key === key);
  if (i >= 0) { state.active.splice(i, 1); }
  else {
    state.active.unshift({
      key, kind: 'sar', opacity: 1, side: 'right', maxzoom: 16,
      url: pcTileUrl(cfg.tiler, feature.collection, feature.id, mode, pol),
      name: `S1 ${fmtDate(feature.properties.datetime)} ${pol.toUpperCase()} ${mode.name}`,
      attribution: 'Copernicus Sentinel-1 via Microsoft Planetary Computer'
    });
  }
  renderActive(); renderSar(); renderAll(); writeHash();
}

/* Fraction of the activation AOI covered by a scene's bounding box. Sentinel-2
 * granules are ~110 km squares and this corridor straddles two of them, so a
 * scene can be beautifully cloud-free and still miss the affected valley
 * entirely. Coverage has to rank above cloud cover when choosing what to show. */
function aoiCoverage(bbox) {
  const aoi = state.catalog.event.tmAoiBbox || state.cfg.tmAoiBbox;
  if (!aoi || !bbox || bbox.length < 4) return 1;
  const w = Math.max(0, Math.min(aoi[2], bbox[2]) - Math.max(aoi[0], bbox[0]));
  const h = Math.max(0, Math.min(aoi[3], bbox[3]) - Math.max(aoi[1], bbox[1]));
  const area = (aoi[2] - aoi[0]) * (aoi[3] - aoi[1]);
  return area > 0 ? (w * h) / area : 0;
}

/* --------------------------------------------------- Sentinel-2 (optical) */

async function loadOptical() {
  const cfg = state.cfg.optical;
  const listEl = $('#s2-list');
  if (!cfg || !cfg.enabled) { listEl.innerHTML = '<p class="empty">Not configured.</p>'; return; }

  const ev = new Date(state.cfg.eventDatetime || state.cfg.eventDate);
  const from = new Date(ev.getTime() - (cfg.daysBefore || 20) * 864e5).toISOString();
  const to = new Date(ev.getTime() + (cfg.daysAfter || 30) * 864e5).toISOString();
  try {
    const r = await fetch(cfg.stac, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        collections: [cfg.collection], bbox: state.cfg.bbox,
        datetime: `${from}/${to}`, limit: 60,
        sortby: [{ field: 'properties.datetime', direction: 'desc' }]
      })
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    // One entry per acquisition. Pick the granule that actually covers the
    // activation area; only use cloud cover to break a tie.
    const byPass = new Map();
    for (const f of (d.features || [])) {
      const cloud = f.properties['eo:cloud_cover'];
      if (cloud != null && cloud > (cfg.maxCloud ?? 100)) continue;
      f._cov = aoiCoverage(f.bbox);
      if (f._cov <= 0) continue;
      const key = f.properties.datetime.slice(0, 16);
      const prev = byPass.get(key);
      const better = !prev ||
        f._cov > prev._cov + 0.02 ||
        (Math.abs(f._cov - prev._cov) <= 0.02 &&
         (cloud ?? 100) < (prev.properties['eo:cloud_cover'] ?? 100));
      if (better) byPass.set(key, f);
    }
    state.optical = [...byPass.values()]
      .sort((a, b) => (a.properties.datetime < b.properties.datetime ? 1 : -1));
    renderOptical();
  } catch (e) {
    listEl.innerHTML = `<p class="empty">Sentinel-2 search failed: ${esc(e.message)}</p>`;
  }
}

function renderOptical() {
  const listEl = $('#s2-list');
  listEl.innerHTML = '';
  const allModes = (state.cfg.optical && state.cfg.optical.modes) || [];
  const cur = allModes.find((m) => m.id === state.opticalMode) || allModes[0];
  renderModeSelect('#s2-mode', allModes, cur, (m) => {
    state.opticalMode = m.id;
    state.active = state.active.filter((a) => a.kind !== 's2');
    renderOptical(); renderActive(); renderAll();
  });
  const scenes = state.optical || [];
  if (!scenes.length) { listEl.innerHTML = '<p class="empty">No Sentinel-2 scenes in this window.</p>'; return; }
  const eventTime = new Date(state.cfg.eventDatetime || state.cfg.eventDate).getTime();
  const mode = cur;

  for (const f of scenes) {
    const dt = f.properties.datetime;
    const isPost = new Date(dt).getTime() >= eventTime;
    const cloud = f.properties['eo:cloud_cover'];
    const key = `s2:${f.id}:${mode.id}`;
    const on = isActive(key);
    const row = el('div', 'scene' + (on ? ' on' : ''));
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = on;
    cb.onclick = (e) => { e.stopPropagation(); toggleOptical(f, mode); };
    row.appendChild(cb);
    const body = el('div', 'body');
    body.appendChild(el('div', 't',
      `${fmtDate(dt)}` + (isPost ? '<span class="badge post">post</span>' : '') +
      (cloud != null && cloud > 70 ? '<span class="badge coarse">v. cloudy</span>' : '') +
      ((f._cov ?? 1) < 0.5 ? '<span class="badge coarse">partial</span>' : '')));
    const cov = Math.round((f._cov ?? 1) * 100);
    body.appendChild(el('div', 'd',
      `${cloud != null ? cloud.toFixed(0) + '% cloud' : 'cloud unknown'} &middot; ` +
      `covers ${cov}% of AOI &middot; 10 m`));
    row.appendChild(body);
    row.onclick = () => toggleOptical(f, mode);
    listEl.appendChild(row);
  }
  $('#s2-count').textContent = `${scenes.length} passes`;
}

function toggleOptical(feature, mode) {
  const cfg = state.cfg.optical;
  const key = `s2:${feature.id}:${mode.id}`;
  const i = state.active.findIndex((a) => a.key === key);
  if (i >= 0) state.active.splice(i, 1);
  else state.active.unshift({
    key, kind: 's2', opacity: 1, side: 'right', maxzoom: 15,
    url: pcTileUrl(cfg.tiler, cfg.collection, feature.id, mode, null),
    name: `S2 ${fmtDate(feature.properties.datetime)} ${mode.name}`,
    attribution: 'Copernicus Sentinel-2 via Microsoft Planetary Computer'
  });
  renderActive(); renderOptical(); renderAll(); writeHash();
}

/* --------------------------------------------------------- live TM refresh */

/* The insta-tm mirror is CORS-enabled, so it can be read directly from the
 * browser, but it syncs on its own schedule and can lag the baked catalogue by
 * hours. Take a value from the mirror only when the mirror's record is actually
 * newer than the baked one, otherwise a "live" refresh would replace fresh data
 * with stale data. */
async function refreshTMLive() {
  const projects = state.catalog.tm_projects || [];
  if (!projects.length) return;
  let applied = 0, checked = 0;

  await Promise.all(projects.map(async (p) => {
    try {
      const r = await fetch(`${INSTA_TM}/api/v2/projects/${p.id}`);
      if (!r.ok) return;
      const d = await r.json();
      checked++;

      const mirrorTime = Date.parse(d.lastUpdated || '') || 0;
      const bakedTime = Date.parse(p.last_updated || '') || 0;
      if (!(mirrorTime > bakedTime)) return;   // baked data is fresher, keep it

      if (typeof d.percentMapped === 'number') p.percent_mapped = d.percentMapped;
      if (typeof d.percentValidated === 'number') p.percent_validated = d.percentValidated;
      if (d.imagery) p.imagery = d.imagery;
      if (d.projectPriority) p.priority = d.projectPriority;
      if (!p.aoi && d.areaOfInterest) p.aoi = d.areaOfInterest;
      p.last_updated = d.lastUpdated;
      applied++;
    } catch (e) { /* mirror unavailable; baked values stand */ }
  }));

  const label = applied ? `${applied} updated from mirror`
    : (checked ? 'catalogue is current' : 'mirror unavailable');
  $('#tm-src').textContent = label;
  if (applied) { renderTM(); renderAll(); }
}

/* --------------------------------------------------------------- permalink */

function writeHash() {
  if (!state.mapA) return;
  const c = state.mapA.getCenter();
  const parts = [
    `e=${state.cfg.id}`,
    `@${c.lat.toFixed(5)},${c.lng.toFixed(5)},${state.mapA.getZoom().toFixed(2)}z`,
    `b=${state.basemap}`
  ];
  if (state.active.length) parts.push('l=' + state.active.map((a) => a.key).join(','));
  const vs = [...state.vectorsOn, ...[...state.tmOn].map((id) => 'tm' + id)];
  if (vs.length) parts.push('v=' + vs.join(','));
  history.replaceState(null, '', '#' + parts.join('&'));
}

function readHash() {
  const h = location.hash.replace(/^#/, '');
  const out = { center: null, zoom: null, basemap: null, layers: [], vectors: [] };
  if (!h) return out;
  for (const part of h.split('&')) {
    if (part.startsWith('@')) {
      const m = part.match(/^@(-?[\d.]+),(-?[\d.]+),([\d.]+)z$/);
      if (m) { out.center = [parseFloat(m[2]), parseFloat(m[1])]; out.zoom = parseFloat(m[3]); }
    } else if (part.startsWith('b=')) out.basemap = part.slice(2);
    else if (part.startsWith('l=')) out.layers = part.slice(2).split(',').filter(Boolean);
    else if (part.startsWith('v=')) out.vectors = part.slice(2).split(',').filter(Boolean);
  }
  return out;
}

/* -------------------------------------------------------------------- boot */

function eventIdFromUrl() {
  if (window.EVENT_ID) return window.EVENT_ID;
  const q = new URLSearchParams(location.search).get('event');
  if (q) return q;
  const m = location.hash.match(/e=([\w-]+)/);
  if (m) return m[1];
  // /disaster-imagery-viewer/<event-id>/ style paths
  const seg = location.pathname.replace(/\/+$/, '').split('/').pop();
  if (seg && seg !== 'index.html' && /^[\w-]+$/.test(seg)) return seg;
  return DEFAULT_EVENT;
}

async function boot() {
  const id = eventIdFromUrl();
  try {
    const [cfgR, catR] = await Promise.all([
      fetch(`${BASE}events/${id}.json`),
      fetch(`${BASE}data/${id}.catalog.json`)
    ]);
    if (!cfgR.ok) throw new Error(`No event config for "${id}"`);
    if (!catR.ok) throw new Error(`No catalogue for "${id}" - run scripts/build_catalog.py`);
    state.cfg = await cfgR.json();
    state.catalog = await catR.json();
  } catch (e) {
    $('#event-name').textContent = 'Failed to load';
    $('#freshness').textContent = e.message;
    console.error(e);
    return;
  }

  state.scenes = state.catalog.scenes || [];
  state.sceneById = new Map(state.scenes.map((s) => [s.id, s]));

  $('#event-name').textContent = state.cfg.name;
  $('#event-sub').textContent = state.cfg.subtitle || '';
  $('#freshness').textContent =
    `Event ${fmtDate(state.cfg.eventDate)} · catalogue ${ago(state.catalog.generated)}`;
  document.title = `${state.cfg.name} - Imagery Viewer`;

  const hash = readHash();
  if (hash.center) { state.cfg.center = hash.center; state.cfg.zoom = hash.zoom; }
  if (hash.basemap) state.basemap = hash.basemap;
  for (const v of hash.vectors) {
    const m = v.match(/^tm(\d+)$/);
    if (m) state.tmOn.add(+m[1]); else state.vectorsOn.add(v);
  }

  // Vector overlays restored from the permalink do not depend on the map, so
  // load them up front rather than inside the map's load handler.
  await Promise.all((state.cfg.extraLayers || [])
    .filter((l) => l.type === 'geojson' && state.vectorsOn.has(l.id))
    .map(loadGeojson));
  if (state.showTaskGrid) await loadTaskGrid();
  if (state.vectorsOn.has('esri-seamlines')) {
    await loadSeamlines();
    const cb = $('#seamlines-toggle');
    if (cb) {
      cb.checked = true;
      $('#seamlines-legend').hidden = false;
      $('#seamlines-legend').innerHTML = SEAMLINE_BANDS
        .map((b) => `<span class="lg"><i style="background:${b.color}"></i>${esc(b.label)}</span>`).join('');
      $('#seamlines-summary').textContent = seamlineSummary();
    }
  }

  state.mapA = makeMap('map');
  state.mapA.on('load', async () => {
    // Restore layers from the permalink.
    for (const key of hash.layers) {
      if (key.startsWith('s:')) {
        const s = state.sceneById.get(key.slice(2));
        if (s) toggleScene(s);
      } else if (key.startsWith('x:')) {
        const l = (state.cfg.extraLayers || []).find((x) => x.id === key.slice(2));
        if (l && l.type === 'raster') toggleExtraRaster(l);
      }
    }
    renderMap(state.mapA, 'A');
  });
  state.mapA.on('click', 'seamlines-fill', (e) => {
    const p = e.features && e.features[0] && e.features[0].properties;
    if (!p) return;
    new maplibregl.Popup({ closeButton: true })
      .setLngLat(e.lngLat)
      .setHTML(
        `<h4>Esri basemap source</h4>` +
        `<div>Captured <b>${esc(fmtDate(p.date))}</b></div>` +
        `<div>${p.res ? esc(p.res) + ' m resolution' : ''}${p.name ? ' &middot; ' + esc(p.name) : ''}</div>`)
      .addTo(state.mapA);
  });
  state.mapA.on('mouseenter', 'seamlines-fill', () => { state.mapA.getCanvas().style.cursor = 'pointer'; });
  state.mapA.on('mouseleave', 'seamlines-fill', () => { state.mapA.getCanvas().style.cursor = ''; });

  state.mapA.on('moveend', writeHash);
  state.mapA.on('mousemove', (e) => {
    $('#coords').textContent = `${e.lngLat.lat.toFixed(5)}, ${e.lngLat.lng.toFixed(5)}  z${state.mapA.getZoom().toFixed(1)}`;
  });

  state.showAoiOsm = false;
  renderCatalog(); renderMosaics(); renderBasemaps();
  if (!state.tmOn.size && (state.catalog.tm_projects || []).length) {
    state.tmOn.add(state.catalog.tm_projects[0].id);
  }
  renderTM(); renderImpact(); renderLists(); renderPlaces(); renderAbout(); renderActive();
  renderHealth();
  refreshTMLive();
  refreshOsmFreshness();
  loadSar();
  loadOptical();
  loadAoiOsm();

  // UI wiring.
  document.querySelectorAll('.tab').forEach((t) => {
    t.onclick = () => {
      document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
      document.querySelectorAll('.panel').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      $('#tab-' + t.dataset.tab).classList.add('active');
    };
  });
  $('#scene-search').oninput = renderCatalog;
  $('#aoi-only').onchange = renderCatalog;
  $('#clear-active').onclick = () => {
    state.active = []; renderActive(); renderCatalog(); renderMosaics(); renderAll(); writeHash();
  };
  $('#compare-toggle').onchange = (e) => enableCompare(e.target.checked);
  $('#seamlines-toggle').onchange = async (e) => {
    if (e.target.checked) {
      const ok = await loadSeamlines();
      if (!ok) { e.target.checked = false; $('#seamlines-summary').textContent = 'Seamlines unavailable for this event.'; return; }
      state.vectorsOn.add('esri-seamlines');
      $('#seamlines-legend').hidden = false;
      $('#seamlines-legend').innerHTML = SEAMLINE_BANDS
        .map((b) => `<span class="lg"><i style="background:${b.color}"></i>${esc(b.label)}</span>`).join('');
      $('#seamlines-summary').textContent = seamlineSummary();
    } else {
      state.vectorsOn.delete('esri-seamlines');
      $('#seamlines-legend').hidden = true;
      $('#seamlines-summary').textContent = '';
    }
    renderAll(); writeHash();
  };

  $('#osm-load').onclick = loadOsm;
  $('#osm-aoi-toggle').onchange = (e) => {
    state.showAoiOsm = e.target.checked;
    renderOsmLegend(state.showAoiOsm || !!state._osm);
    renderAll();
  };
  $('#osm-clear').onclick = () => {
    state._osm = null; $('#osm-status').textContent = '';
    $('#osm-clear').hidden = true; renderOsmLegend(false); renderAll();
  };
  $('#collapse').onclick = () => {
    $('#sidebar').classList.add('hidden'); $('#expand').hidden = false;
    setTimeout(() => eachMap((m) => m.resize()), 200);
  };
  $('#expand').onclick = () => {
    $('#sidebar').classList.remove('hidden'); $('#expand').hidden = true;
    setTimeout(() => eachMap((m) => m.resize()), 200);
  };
  window.addEventListener('resize', () => { if (state.compare) setSplit(state.splitPct); });
  initSwipeDrag();
  startAgoTicker();

  // Debug handle. Useful when something looks wrong mid-response and someone
  // needs to inspect layer state from the console.
  window.viewer = state;
}

boot();
