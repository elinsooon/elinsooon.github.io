/* global maplibregl, deck, pmtiles */

// ---------------------------------------------------------------------------
// Mode config
// ---------------------------------------------------------------------------
const MODES = [
  { key: "cars",    label: "Cars",        color: [ 80, 180, 255] },
  { key: "transit", label: "Transit",     color: [190, 120, 255] },
  { key: "peds",    label: "Pedestrians", color: [255, 105, 210] },
  { key: "bikes",   label: "Bikes",       color: [245, 245, 255] },
];
const MODE_MAP = Object.fromEntries(MODES.map(m => [m.key, m]));
const MODE_INDEX = Object.fromEntries(MODES.map((m, i) => [m.key, i]));

// ---------------------------------------------------------------------------
// Optional PMTiles protocol for static road geometry
// ---------------------------------------------------------------------------
if (typeof pmtiles !== "undefined") {
  const protocol = new pmtiles.Protocol();
  maplibregl.addProtocol("pmtiles", protocol.tile);
}

// ---------------------------------------------------------------------------
// Animation constants
// ---------------------------------------------------------------------------
const VOLUME_PER_PARTICLE = {
  cars: 45,
  transit: 5,
  peds: 12,
  bikes: 5,
};
const MAX_PER_SEGMENT     = 8;    // cap particles per segment per mode
const MAX_PARTICLES_TOTAL = 120000;
const TARGET_FPS          = 60;
const PROPAGATION_DEPTH   = 7;
const PROPAGATION_CUTOFF  = 0.04;
const PARTICLE_SIZE_PX    = 2.4;    // max size (at high zoom)
const SPAWN_INTERVAL      = 30;   // frames between trickle-spawn checks
const DENSITY_WIDTH_PX    = 4.2;

// Per-mode speed multipliers applied on top of OSM road speed_kph
const MODE_SPEED_KPH = { cars: null, transit: null, peds: 5, bikes: 15 };
const LANE_CAPACITY = 600;
const ROUTE_POOL_VERSION = 2;


// Per-segment, per-mode speed in t-units/frame
let segModeSpeeds = [];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let locations  = [];
let segments   = [];
let flowMap    = {};
let outEdges   = {};
let particles  = [];
let densityRoadData = [];
let densityMaxVolume = 1;
let globalDensityMaxByMode = {};
let routePools = {};
let routePoolPromises = {};
let routePoolWorker = null;
let routePoolWorkerCallbacks = {};
let routePoolSources = {};

// OSM-edge routing graph. Particles generate full routes at spawn time, then
// follow those routes deterministically instead of re-rolling every turn.
let nodeOutEdges = {};
let nodeInEdges = {};
let reverseSegIdx = {};
let segBearings = [];
let segLengthsM = [];
let corridorNeighbors = [];

let enabledModes = new Set(["cars", "peds", "bikes", "transit"]);
let currentSlot  = 48;
let selectedLoc  = null;
let propagationWeights = null;
let currentZoom  = 11.5;
let spawnCounter = 0;
let nextParticleId = 1;
let routePoolRequestId = 1;
let timeUpdateVersion = 0;
let warmQueueRunning = false;

let deckOverlay = null;
let animFrameId = null;

const tooltip = document.getElementById("tooltip");
const detailPanel = document.getElementById("detail-panel");
const statusDisplay = document.getElementById("count-display");
const appUrl = path => new URL(path, document.baseURI).href;

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------
const map = new maplibregl.Map({
  container: "map",
  style: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
  center: [-79.390, 43.690],
  zoom: 11.5,
  pitch: 0,
  bearing: 0,
  antialias: true,
});
map.addControl(new maplibregl.NavigationControl(), "bottom-right");
map.on("zoom", () => { currentZoom = map.getZoom(); });

async function initRoadTileLayer() {
  if (typeof pmtiles === "undefined") return;

  const tileUrl = appUrl("data/processed/traffic_roads.pmtiles");
  try {
    const resp = await fetch(tileUrl, { method: "HEAD" });
    if (!resp.ok) return;
  } catch {
    return;
  }

  map.addSource("traffic-roads-src", {
    type: "vector",
    url: `pmtiles://${tileUrl}`,
  });
  map.addLayer({
    id: "traffic-roads-layer",
    type: "line",
    source: "traffic-roads-src",
    "source-layer": "traffic_roads",
    minzoom: 10,
    paint: {
      "line-color": "rgba(255,255,255,0.16)",
      "line-width": ["interpolate", ["linear"], ["zoom"], 10, 0.25, 13, 0.7, 16, 1.8],
    },
  });
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------
async function loadData() {
  const cb = `?v=${Date.now()}`;
  const [locResp, segResp, flowResp] = await Promise.all([
    fetch(`data/processed/tmc_locations.json${cb}`),
    fetch(`data/processed/tmc_segments.json${cb}`),
    fetch(`data/processed/tmc_flows.json${cb}`),
  ]);
  const locData  = await locResp.json();
  const segData  = await segResp.json();
  const flowData = await flowResp.json();

  locations = locData.locations;
  segments  = segData.segments;
  buildFlowMap(flowData);
  computeGlobalDensityScale();
  computeSegmentSpeeds();
  buildGraph();
  buildRoutingGraph();
  updateDensityRoadData();
}

function buildFlowMap(flowData) {
  const iSlot = 0, iCars = 1, iTransit = 2, iPeds = 3, iBikes = 4, iR = 5, iT = 6, iL = 7, iInferred = 8;
  for (const [segIdxStr, rows] of Object.entries(flowData.flows)) {
    const segIdx = parseInt(segIdxStr);
    const slotMap = {};
    for (const row of rows) {
      slotMap[row[iSlot]] = {
        cars:    row[iCars],
        transit: row[iTransit],
        peds:    row[iPeds],
        bikes:   row[iBikes],
        r: row[iR] / 1000,
        t: row[iT] / 1000,
        l: row[iL] / 1000,
        inferred: row[iInferred] === 1,
      };
    }
    flowMap[segIdx] = slotMap;
  }
}

function computeGlobalDensityScale() {
  globalDensityMaxByMode = {};
  for (const mode of MODES) {
    const values = [];
    for (const slotMap of Object.values(flowMap)) {
      for (const entry of Object.values(slotMap)) {
        const val = entry[mode.key] || 0;
        if (val > 0) values.push(val);
      }
    }
    values.sort((a, b) => a - b);
    globalDensityMaxByMode[mode.key] = values.length
      ? Math.max(values[Math.floor(values.length * 0.96)], 1)
      : 1;
  }
}

function computeSegmentSpeeds() {
  segModeSpeeds = new Array(segments.length);
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const coords = seg.coords;
    let len = 0;
    for (let j = 1; j < coords.length; j++) {
      const dx = (coords[j][0] - coords[j-1][0]) * 111320 * Math.cos(coords[j][1] * Math.PI / 180);
      const dy = (coords[j][1] - coords[j-1][1]) * 111320;
      len += Math.sqrt(dx*dx + dy*dy);
    }
    const effectiveLen = Math.max(len, 20);
    const roadSpeedKph = seg.speed_kph || 40;

    const slotData = flowMap[i];
    const entry = slotData ? (slotData[currentSlot] || slotData[Math.floor(currentSlot)] || findNearestSlot(slotData, Math.floor(currentSlot), 4)) : null;
    const carVol = entry ? entry.cars : 0;
    const vcRatio = Math.min(carVol / LANE_CAPACITY, 1.5);
    const congestionFactor = Math.max(1.0 - vcRatio * 0.5, 0.25);

    const speeds = {};
    for (const mode of MODES) {
      let spdKph;
      if (MODE_SPEED_KPH[mode.key] !== null) {
        spdKph = MODE_SPEED_KPH[mode.key];
      } else {
        spdKph = roadSpeedKph * congestionFactor;
      }
      const spdMps = spdKph / 3.6;
      speeds[mode.key] = spdMps / effectiveLen / TARGET_FPS;
    }
    segModeSpeeds[i] = speeds;
  }
}

function buildGraph() {
  outEdges = {};
  for (const seg of segments) {
    const { seg_idx, from_tmc_idx, to_tmc_idx } = seg;
    if (from_tmc_idx == null) continue;
    if (!outEdges[from_tmc_idx]) outEdges[from_tmc_idx] = [];
    outEdges[from_tmc_idx].push({ seg_idx, to_tmc_idx });
  }
}

// ---------------------------------------------------------------------------
// Route graph over actual OSM edges
// ---------------------------------------------------------------------------
function buildRoutingGraph() {
  nodeOutEdges = {};
  nodeInEdges = {};
  reverseSegIdx = {};
  segBearings = new Array(segments.length).fill(0);
  segLengthsM = new Array(segments.length).fill(1);

  for (const seg of segments) {
    if (!nodeOutEdges[seg.u_osm]) nodeOutEdges[seg.u_osm] = [];
    nodeOutEdges[seg.u_osm].push(seg.seg_idx);
    if (!nodeInEdges[seg.v_osm]) nodeInEdges[seg.v_osm] = [];
    nodeInEdges[seg.v_osm].push(seg.seg_idx);
    reverseSegIdx[`${seg.v_osm}:${seg.u_osm}`] = seg.seg_idx;
    segBearings[seg.seg_idx] = bearingForCoords(seg.coords);
    segLengthsM[seg.seg_idx] = segmentLengthM(seg.coords);
  }
  buildCorridorNeighbors();
}

function buildCorridorNeighbors() {
  corridorNeighbors = new Array(segments.length);
  for (const seg of segments) {
    const b = segBearings[seg.seg_idx] || 0;
    const candidates = [
      ...(nodeInEdges[seg.u_osm] || []),
      ...(nodeOutEdges[seg.u_osm] || []),
      ...(nodeInEdges[seg.v_osm] || []),
      ...(nodeOutEdges[seg.v_osm] || []),
    ];
    const seen = new Set([seg.seg_idx]);
    corridorNeighbors[seg.seg_idx] = candidates.filter(nextSegIdx => {
      if (seen.has(nextSegIdx)) return false;
      seen.add(nextSegIdx);
      return angleDiff(b, segBearings[nextSegIdx] || b) <= 35 ||
             angleDiff((b + 180) % 360, segBearings[nextSegIdx] || b) <= 35;
    });
  }
}


// ---------------------------------------------------------------------------
// Feature 3: Zoom-responsive particle size
// ---------------------------------------------------------------------------
function getParticleRadius() {
  // Keep particles narrower than the visible road strokes at city scale.
  // deck.gl radii can be sub-pixel; antialiasing still leaves a readable trace.
  if (currentZoom <= 10) return 0.25;
  if (currentZoom >= 15) return PARTICLE_SIZE_PX;
  return 0.25 + (currentZoom - 10) * (PARTICLE_SIZE_PX - 0.25) / 5;
}

function getParticleRenderSettings() {
  const t = smoothstep(10.6, 13.8, currentZoom);
  return {
    alphaScale: t,
    sampleRate: t,
  };
}

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function particleSampleValue(particle) {
  const id = particle.id || 0;
  const x = Math.sin(id * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function volumeToDensityColor(volume) {
  const t = Math.max(0, Math.min(1, volume / densityMaxVolume));
  const alphaScale = arguments.length > 1 ? arguments[1] : 1;
  if (t < 0.35) {
    const k = t / 0.35;
    return [
      Math.round(42 + k * 83),
      Math.round(170 + k * 55),
      Math.round(160 - k * 80),
      Math.round((30 + k * 55) * alphaScale),
    ];
  }
  if (t < 0.7) {
    const k = (t - 0.35) / 0.35;
    return [
      Math.round(125 + k * 130),
      Math.round(225 - k * 55),
      Math.round(80 - k * 45),
      Math.round((85 + k * 35) * alphaScale),
    ];
  }
  const k = (t - 0.7) / 0.3;
  return [
    255,
    Math.round(170 - k * 105),
    Math.round(35 - k * 15),
    Math.round((120 + k * 45) * alphaScale),
  ];
}

function getDensityWidth() {
  if (currentZoom <= 10) return 1.2;
  if (currentZoom >= 15) return DENSITY_WIDTH_PX;
  return 1.2 + (currentZoom - 10) * (DENSITY_WIDTH_PX - 1.2) / 5;
}

function updateDensityRoadData() {
  const rows = [];
  densityMaxVolume = globalDensityMaxByMode.cars || 1;
  const carVolumes = new Array(segments.length).fill(0);
  const inferredFlags = new Array(segments.length).fill(false);

  for (const seg of segments) {
    const info = getSegmentVolumeInfo(seg.seg_idx, "cars");
    carVolumes[seg.seg_idx] = info.volume;
    inferredFlags[seg.seg_idx] = info.inferred;
  }

  for (const seg of segments) {
    const rawVolume = carVolumes[seg.seg_idx];
    if (rawVolume <= 0 || !seg.coords || seg.coords.length < 2) continue;

    let weightedVolume = rawVolume;
    let weight = 1;
    for (const nearIdx of corridorNeighbors[seg.seg_idx] || []) {
      const v = carVolumes[nearIdx] || 0;
      if (v <= 0) continue;
      weightedVolume += v * 0.55;
      weight += 0.55;
    }
    const smoothedVolume = weightedVolume / weight;

    rows.push({
      path: seg.coords,
      volume: rawVolume,
      displayVolume: inferredFlags[seg.seg_idx]
        ? Math.min(smoothedVolume, densityMaxVolume * 0.22)
        : smoothedVolume,
      inferredRatio: inferredFlags[seg.seg_idx] ? 1 : 0,
    });
  }

  densityRoadData = rows;
}

// ---------------------------------------------------------------------------
// Particle system
// ---------------------------------------------------------------------------
function getSegmentVolume(segIdx, mode) {
  return getSegmentVolumeInfo(segIdx, mode).volume;
}

function getParticleThreshold(mode) {
  return VOLUME_PER_PARTICLE[mode] || 45;
}

function getSegmentVolumeInfo(segIdx, mode) {
  const slotMap = flowMap[segIdx];
  if (!slotMap) return { volume: 0, inferred: false };
  const slotLow  = Math.floor(currentSlot);
  const slotHigh = (slotLow + 1) % 96;
  const frac     = currentSlot - slotLow;
  let lo = slotMap[slotLow];
  let hi = slotMap[slotHigh];
  if (!lo) lo = findNearestSlot(slotMap, slotLow, 4);
  if (!hi) hi = findNearestSlot(slotMap, slotHigh, 4);
  if (lo || hi) {
    const loVal = lo ? lo[mode] : 0;
    const hiVal = hi ? hi[mode] : 0;
    const volume = loVal * (1 - frac) + hiVal * frac;
    const inferred = Boolean((lo?.inferred && loVal > 0) || (hi?.inferred && hiVal > 0));
    return { volume, inferred };
  }

  return { volume: 0, inferred: false };
}

function findNearestSlot(slotMap, target, maxDist) {
  for (let d = 1; d <= maxDist; d++) {
    const below = slotMap[(target - d + 96) % 96];
    if (below) return below;
    const above = slotMap[(target + d) % 96];
    if (above) return above;
  }
  return null;
}

function bearingForCoords(coords) {
  if (!coords || coords.length < 2) return 0;
  const a = coords[0];
  const b = coords[coords.length - 1];
  const lat1 = a[1] * Math.PI / 180;
  const lat2 = b[1] * Math.PI / 180;
  const dLon = (b[0] - a[0]) * Math.PI / 180;
  const x = Math.sin(dLon) * Math.cos(lat2);
  const y = Math.cos(lat1) * Math.sin(lat2) -
            Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (Math.atan2(x, y) * 180 / Math.PI + 360) % 360;
}

function angleDiff(a, b) {
  return Math.abs(((a - b + 540) % 360) - 180);
}

function segmentLengthM(coords) {
  if (!coords || coords.length < 2) return 1;
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    const dx = (coords[i][0] - coords[i-1][0]) * 111320 * Math.cos(coords[i][1] * Math.PI / 180);
    const dy = (coords[i][1] - coords[i-1][1]) * 111320;
    total += Math.sqrt(dx*dx + dy*dy);
  }
  return Math.max(total, 1);
}

function getPooledRoute(startSegIdx, mode) {
  const pool = routePools[routePoolKey(mode)];
  if (pool?.binary) return getBinaryPooledRoute(pool, startSegIdx);
  const options = pool?.bySegment?.[startSegIdx];
  if (!options || !options.length) return null;
  if (typeof options[0] === "number") {
    const pairOffset = Math.floor(Math.random() * (options.length / 2)) * 2;
    const route = pool.routes[options[pairOffset]];
    return route ? route.slice(options[pairOffset + 1]) : null;
  }
  const option = options[Math.floor(Math.random() * options.length)];
  if (Array.isArray(option)) {
    const route = pool.routes[option[0]];
    return route ? route.slice(option[1]) : null;
  }
  return option.route.slice(option.offset);
}

function getBinaryPooledRoute(pool, startSegIdx) {
  const segIds = pool.indexSegIds;
  let lo = 0;
  let hi = segIds.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const val = segIds[mid];
    if (val === startSegIdx) {
      const begin = pool.indexOffsets[mid];
      const end = pool.indexOffsets[mid + 1];
      if (end <= begin) return null;
      const pairOffset = begin + Math.floor(Math.random() * ((end - begin) / 2)) * 2;
      const routeIdx = pool.indexValues[pairOffset];
      const routeOffset = pool.indexValues[pairOffset + 1];
      const routeBegin = pool.routeOffsets[routeIdx] + routeOffset;
      const routeEnd = pool.routeOffsets[routeIdx + 1];
      return pool.routeValues.slice(routeBegin, routeEnd);
    }
    if (val < startSegIdx) lo = mid + 1;
    else hi = mid - 1;
  }
  return null;
}

function createParticle(segIdx, mode, t = 0.0) {
  const route = getPooledRoute(segIdx, mode) || [segIdx];
  return {
    id: nextParticleId++,
    route,
    routePos: 0,
    seg_idx: segIdx,
    t,
    mode,
  };
}

function initParticles() {
  particles = [];
  for (const seg of segments) {
    const { seg_idx } = seg;
    const slotMap = flowMap[seg_idx];
    if (!slotMap) continue;

    for (const mode of MODES) {
      if (!enabledModes.has(mode.key)) continue;
      const entry = slotMap[48] || slotMap[Object.keys(slotMap)[0]];
      if (!entry) continue;
      const vol = entry[mode.key];
      const count = Math.min(Math.floor(vol / getParticleThreshold(mode.key)), MAX_PER_SEGMENT);
      for (let i = 0; i < count; i++) {
        if (particles.length >= MAX_PARTICLES_TOTAL) return;
        particles.push(createParticle(seg_idx, mode.key, Math.random()));
      }
    }
  }
}

function interpolateAlongCoords(coords, t) {
  if (coords.length === 1) return coords[0];
  if (t <= 0) return coords[0];
  if (t >= 1) return coords[coords.length - 1];

  let totalLen = 0;
  const lens = [];
  for (let i = 1; i < coords.length; i++) {
    const dx = coords[i][0] - coords[i-1][0];
    const dy = coords[i][1] - coords[i-1][1];
    const d = Math.sqrt(dx*dx + dy*dy);
    lens.push(d);
    totalLen += d;
  }

  let target = t * totalLen;
  for (let i = 0; i < lens.length; i++) {
    if (target <= lens[i]) {
      const frac = lens[i] > 0 ? target / lens[i] : 0;
      return [
        coords[i][0] + frac * (coords[i+1][0] - coords[i][0]),
        coords[i][1] + frac * (coords[i+1][1] - coords[i][1]),
      ];
    }
    target -= lens[i];
  }
  return coords[coords.length - 1];
}

// ---------------------------------------------------------------------------
// Propagation BFS
// ---------------------------------------------------------------------------
function propagateFrom(locIdx) {
  const weights = new Map();
  const queue = [{ locIdx, weight: 1.0, depth: 0 }];
  const visited = new Set([locIdx]);

  while (queue.length > 0) {
    const { locIdx: cur, weight, depth } = queue.shift();
    if (depth >= PROPAGATION_DEPTH) continue;

    const outbound = outEdges[cur] || [];
    for (const { seg_idx, to_tmc_idx } of outbound) {
      const slotMap = flowMap[seg_idx];
      const entry = slotMap?.[currentSlot] || slotMap?.[Math.floor(currentSlot)];
      const t_ratio = entry ? entry.t : 0.6;
      const nextWeight = weight * t_ratio;

      if (nextWeight < PROPAGATION_CUTOFF) continue;

      const existing = weights.get(seg_idx) || 0;
      weights.set(seg_idx, Math.max(existing, nextWeight));

      if (to_tmc_idx != null && !visited.has(to_tmc_idx)) {
        visited.add(to_tmc_idx);
        queue.push({ locIdx: to_tmc_idx, weight: nextWeight, depth: depth + 1 });
      }
    }

    if (depth === 0) {
      for (const seg of segments) {
        if (seg.to_tmc_idx === cur) {
          weights.set(seg.seg_idx, Math.max(weights.get(seg.seg_idx) || 0, 1.0));
        }
      }
    }
  }

  return weights;
}

// ---------------------------------------------------------------------------
// Find nearest TMC location
// ---------------------------------------------------------------------------
function nearestTMC(lon, lat) {
  let best = null, bestDist = Infinity;
  for (const loc of locations) {
    const dx = lon - loc.lon, dy = lat - loc.lat;
    const d2 = dx*dx + dy*dy;
    if (d2 < bestDist) { bestDist = d2; best = loc; }
  }
  return bestDist < 0.0004 ? best : null;
}

// ---------------------------------------------------------------------------
// Animation loop
// ---------------------------------------------------------------------------
let lastTs = null;
function animateFrame(ts) {
  if (lastTs !== null) {
    const dt = Math.min((ts - lastTs) / 16.67, 3);

    // --- Particle movement along precomputed OSM-edge routes ---
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      const speeds = segModeSpeeds[p.seg_idx];
      const spd = speeds ? (speeds[p.mode] || 0.003) : 0.003;
      p.t += spd * dt;

      if (p.t >= 1.0) {
        const overflow = p.t - 1.0;
        p.routePos++;

        if (p.routePos >= p.route.length) {
          // Route finished: despawn. The spawn pass keeps high-volume streets fed.
          particles[i] = particles[particles.length - 1];
          particles.pop();
          continue;
        }

        const nextSegIdx = p.route[p.routePos];
        const newSpd = segModeSpeeds[nextSegIdx]?.[p.mode] || spd;
        p.seg_idx = nextSegIdx;
        p.t = Math.min(overflow * (spd / newSpd), 0.99);
      }
    }

    // --- Trickle-spawn to fill deficits ---
    if (++spawnCounter >= SPAWN_INTERVAL) {
      spawnCounter = 0;
      const counts = {};
      for (const p of particles) {
        const key = (p.seg_idx << 3) | MODE_INDEX[p.mode];
        counts[key] = (counts[key] || 0) + 1;
      }
      for (const seg of segments) {
        if (!flowMap[seg.seg_idx]) continue;
        for (let mi = 0; mi < MODES.length; mi++) {
          if (!enabledModes.has(MODES[mi].key)) continue;
          const vol = getSegmentVolume(seg.seg_idx, MODES[mi].key);
          const target = Math.min(Math.floor(vol / getParticleThreshold(MODES[mi].key)), MAX_PER_SEGMENT);
          const key = (seg.seg_idx << 3) | mi;
          const current = counts[key] || 0;
          const deficit = target - current;
          if (deficit > 0 && particles.length < MAX_PARTICLES_TOTAL) {
            const toSpawn = Math.min(deficit, 2);
            for (let j = 0; j < toSpawn; j++) {
              if (particles.length >= MAX_PARTICLES_TOTAL) break;
              particles.push(createParticle(seg.seg_idx, MODES[mi].key, 0.0));
            }
          }
        }
      }
    }
  }
  lastTs = ts;

  // --- Build render data ---
  const pointData = [];
  const renderSettings = getParticleRenderSettings();
  for (const p of particles) {
    if (!p.id) p.id = nextParticleId++;
    if (!enabledModes.has(p.mode)) continue;
    const seg = segments[p.seg_idx];
    if (!seg) continue;

    const vol = getSegmentVolume(p.seg_idx, p.mode);
    if (vol <= 0) continue;

    // Selection mode opacity
    let alpha = 230;
    if (propagationWeights) {
      const w = propagationWeights.get(p.seg_idx);
      if (w === undefined) {
        alpha = 15;
      } else {
        alpha = Math.round(60 + w * 160);
      }
    }

    if (renderSettings.sampleRate <= 0) continue;
    if (renderSettings.sampleRate < 1 && particleSampleValue(p) > renderSettings.sampleRate) {
      continue;
    }
    alpha = Math.round(alpha * renderSettings.alphaScale);
    if (alpha <= 0) continue;

    const color = MODE_MAP[p.mode].color;
    const pos = interpolateAlongCoords(seg.coords, p.t);
    pointData.push({
      position: pos,
      color: [color[0], color[1], color[2], alpha],
    });
  }

  const radius = getParticleRadius();

  if (deckOverlay) {
    deckOverlay.setProps({
      layers: [
        new deck.PathLayer({
          id: "road-density",
          data: densityRoadData,
          getPath: d => d.path,
          getColor: d => volumeToDensityColor(d.displayVolume, 1 - d.inferredRatio * 0.7),
          getWidth: getDensityWidth(),
          widthUnits: "pixels",
          rounded: true,
          pickable: false,
          updateTriggers: {
            getColor: densityMaxVolume,
          },
        }),
        new deck.ScatterplotLayer({
          id: "hit-targets",
          data: locations,
          getPosition: d => [d.lon, d.lat],
          getRadius: 20,
          radiusUnits: "pixels",
          getFillColor: [0, 0, 0, 0],
          pickable: true,
          onHover: handleHover,
          onClick: handleClick,
        }),
        new deck.ScatterplotLayer({
          id: "particles",
          data: pointData,
          getPosition: d => d.position,
          getFillColor: d => d.color,
          getRadius: radius,
          radiusUnits: "pixels",
          pickable: false,
        }),
        ...(selectedLoc != null ? [new deck.ScatterplotLayer({
          id: "selected",
          data: [locations[selectedLoc]],
          getPosition: d => [d.lon, d.lat],
          getRadius: 10,
          radiusUnits: "pixels",
          getFillColor: [255, 255, 255, 220],
          getLineColor: [255, 255, 255, 255],
          stroked: true,
          lineWidthMinPixels: 2,
          pickable: false,
        })] : []),
      ],
    });
  }

  animFrameId = requestAnimationFrame(animateFrame);
}

// ---------------------------------------------------------------------------
// Rebuild particles when slot or mode changes
// ---------------------------------------------------------------------------
function rebuildParticles() {
  const targets = {};
  const keptCounts = {};

  for (const seg of segments) {
    const { seg_idx } = seg;
    if (!flowMap[seg_idx]) continue;

    for (const mode of MODES) {
      if (!enabledModes.has(mode.key)) continue;

      const vol = getSegmentVolume(seg_idx, mode.key);
      const target = Math.min(Math.floor(vol / getParticleThreshold(mode.key)), MAX_PER_SEGMENT);
      if (target > 0) targets[`${seg_idx}:${mode.key}`] = target;
    }
  }

  const nextParticles = [];
  for (const p of particles) {
    const key = `${p.seg_idx}:${p.mode}`;
    const target = targets[key] || 0;
    const kept = keptCounts[key] || 0;
    if (kept < target) {
      nextParticles.push(p);
      keptCounts[key] = kept + 1;
    }
  }

  for (const [key, target] of Object.entries(targets)) {
    const current = keptCounts[key] || 0;
    if (current >= target) continue;
    const sep = key.lastIndexOf(":");
    const segIdx = parseInt(key.slice(0, sep));
    const mode = key.slice(sep + 1);
    for (let i = current; i < target; i++) {
      if (nextParticles.length >= MAX_PARTICLES_TOTAL) break;
      nextParticles.push(createParticle(segIdx, mode, 0.0));
    }
  }

  particles = nextParticles;
}

// ---------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------
function handleHover(info) {
  if (!info.object) {
    tooltip.style.display = "none";
    return;
  }
  const loc = info.object;
  tooltip.innerHTML = `<strong>${loc.name}</strong><div style="font-size:10px;color:#888;margin-top:2px">Click to explore flow</div>`;
  tooltip.style.display = "block";
  tooltip.style.left = `${info.x + 14}px`;
  tooltip.style.top  = `${info.y - 14}px`;
}

// ---------------------------------------------------------------------------
// Click handler
// ---------------------------------------------------------------------------
function handleClick(info) {
  if (!info.object) {
    deselect();
    return;
  }
  selectLocation(info.object.loc_idx);
}

function selectLocation(locIdx) {
  selectedLoc = locIdx;
  propagationWeights = propagateFrom(locIdx);
  showDetailPanel(locIdx);
}

function deselect() {
  selectedLoc = null;
  propagationWeights = null;
  detailPanel.style.display = "none";
}

function showDetailPanel(locIdx) {
  const loc = locations[locIdx];
  const dirVolumes = { cars: 0, transit: 0, peds: 0, bikes: 0 };
  let segCount = 0;
  for (const { seg_idx } of (outEdges[locIdx] || [])) {
    const slotMap = flowMap[seg_idx];
    const entry = slotMap?.[currentSlot] || slotMap?.[Math.floor(currentSlot)];
    if (!entry) continue;
    dirVolumes.cars    += entry.cars;
    dirVolumes.transit += entry.transit;
    dirVolumes.peds    += entry.peds;
    dirVolumes.bikes   += entry.bikes;
    segCount++;
  }

  const bars = MODES.map(m => {
    const val = dirVolumes[m.key];
    const maxVal = Math.max(...Object.values(dirVolumes), 1);
    const pct = Math.round((val / maxVal) * 100);
    const hex = `rgb(${m.color[0]},${m.color[1]},${m.color[2]})`;
    return `
      <div class="detail-row">
        <span class="detail-label">${m.label}</span>
        <div class="detail-bar-wrap">
          <div class="detail-bar" style="width:${pct}%;background:${hex}"></div>
        </div>
        <span class="detail-val">${val.toLocaleString()}/hr</span>
      </div>`;
  }).join("");

  detailPanel.innerHTML = `
    <div class="detail-header">
      <span class="detail-name">${loc.name}</span>
      <button id="detail-close" title="Close">✕</button>
    </div>
    <div class="detail-subtitle">${formatSlot(currentSlot)} · ${segCount} outbound road${segCount !== 1 ? "s" : ""}</div>
    ${bars}
  `;
  detailPanel.style.display = "block";
  document.getElementById("detail-close").addEventListener("click", deselect);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function formatSlot(slot) {
  const h = Math.floor(slot / 4);
  const m = (slot % 4) * 15;
  const mm = String(m).padStart(2, "0");
  if (h === 0)  return `12:${mm} AM`;
  if (h < 12)  return `${h}:${mm} AM`;
  if (h === 12) return `12:${mm} PM`;
  return `${h - 12}:${mm} PM`;
}

function currentHour() {
  return Math.floor(currentSlot / 4);
}

function routePoolKey(mode, hour = currentHour()) {
  return `${mode}:${hour}`;
}

function ensureRoutePoolWorker() {
  if (routePoolWorker) return routePoolWorker;
  if (typeof Worker === "undefined") return null;
  routePoolWorker = new Worker("routePoolWorker.js");
  routePoolWorker.onmessage = event => {
    const {
      requestId,
      key,
      source,
      routes,
      bySegment,
      binary,
      routeOffsets,
      routeValues,
      indexSegIds,
      indexOffsets,
      indexValues,
    } = event.data;
    const callbacks = routePoolWorkerCallbacks[requestId];
    if (!callbacks) return;
    delete routePoolWorkerCallbacks[requestId];
    routePools[key] = binary
      ? { binary, routeOffsets, routeValues, indexSegIds, indexOffsets, indexValues }
      : { routes: routes || [], bySegment: bySegment || {} };
    routePoolSources[key] = source || (binary ? "bin" : "json");
    callbacks.resolve(routePools[key]);
  };
  routePoolWorker.onerror = error => {
    console.warn("Route pool worker error", error);
    routePoolWorker.terminate();
    routePoolWorker = null;
    const pending = routePoolWorkerCallbacks;
    routePoolWorkerCallbacks = {};
    for (const callbacks of Object.values(pending)) {
      fetch(callbacks.url)
        .then(resp => {
          if (!resp.ok) throw new Error(`Route pool missing: ${callbacks.url}`);
          return resp.json();
        })
        .then(data => {
          const routes = data.routes || [];
          routePools[callbacks.key] = {
            routes,
            bySegment: data.bySegment || data.index || buildRoutePoolIndex(routes),
          };
          routePoolSources[callbacks.key] = "json";
          callbacks.resolve(routePools[callbacks.key]);
        })
        .catch(() => {
          routePools[callbacks.key] = { routes: [], bySegment: {} };
          routePoolSources[callbacks.key] = "missing";
          callbacks.resolve(routePools[callbacks.key]);
        });
    }
  };
  return routePoolWorker;
}

function buildRoutePoolIndex(routes) {
  const bySegment = {};
  for (let routeIdx = 0; routeIdx < routes.length; routeIdx++) {
    const route = routes[routeIdx];
    if (!route || route.length < 2) continue;
    for (let offset = 0; offset < route.length - 1; offset++) {
      const segIdx = route[offset];
      if (!bySegment[segIdx]) bySegment[segIdx] = [];
      bySegment[segIdx].push(routeIdx, offset);
    }
  }
  return bySegment;
}

async function loadRoutePool(mode, hour = currentHour()) {
  const key = routePoolKey(mode, hour);
  if (routePools[key]) return routePools[key];
  if (routePoolPromises[key]) return routePoolPromises[key];

  const hourLabel = String(hour).padStart(2, "0");
  const url = `data/processed/route_pools/routes_${mode}_${hourLabel}.json?v=${ROUTE_POOL_VERSION}`;
  const binUrl = `data/processed/route_pools/routes_${mode}_${hourLabel}.bin?v=${ROUTE_POOL_VERSION}`;
  const worker = ensureRoutePoolWorker();
  if (worker) {
    const requestId = routePoolRequestId++;
    routePoolPromises[key] = new Promise(resolve => {
      routePoolWorkerCallbacks[requestId] = { resolve, key, url };
      worker.postMessage({ requestId, key, url, binUrl });
    });
  } else {
    routePoolPromises[key] = fetch(url)
      .then(resp => {
        if (!resp.ok) throw new Error(`Route pool missing: ${url}`);
        return resp.json();
      })
      .then(data => {
        const routes = data.routes || [];
        routePools[key] = {
          routes,
          bySegment: data.bySegment || data.index || buildRoutePoolIndex(routes),
        };
        routePoolSources[key] = "json";
        return routePools[key];
      })
      .catch(() => {
        routePools[key] = { routes: [], bySegment: {} };
        routePoolSources[key] = "missing";
        return routePools[key];
      });
  }

  return routePoolPromises[key];
}

function preloadRoutePools(hour = currentHour()) {
  return Promise.all([...enabledModes].map(mode => loadRoutePool(mode, hour)));
}

function warmRoutePoolsAround(hour) {
  if (warmQueueRunning) return;
  const hours = [hour + 1, hour - 1, hour + 2, hour - 2].filter(h => h >= 7 && h <= 19);
  const jobs = [];
  for (const h of hours) {
    for (const mode of enabledModes) {
      const key = routePoolKey(mode, h);
      if (!routePools[key] && !routePoolPromises[key]) jobs.push({ mode, hour: h });
    }
  }
  if (!jobs.length) return;
  warmQueueRunning = true;
  const runNext = () => {
    const job = jobs.shift();
    if (!job) {
      warmQueueRunning = false;
      return;
    }
    loadRoutePool(job.mode, job.hour).finally(() => {
      setTimeout(runNext, 40);
    });
  };
  setTimeout(runNext, 150);
}

function setStatus(message, tone = "idle") {
  if (!statusDisplay) return;
  statusDisplay.dataset.tone = tone;
  statusDisplay.textContent = message;
}

function routePoolSummary(hour = currentHour()) {
  const keys = [...enabledModes].map(mode => routePoolKey(mode, hour));
  const loaded = keys.filter(key => routePools[key]).length;
  const binary = keys.filter(key => routePoolSources[key] === "bin").length;
  const missing = keys.filter(key => routePoolSources[key] === "missing").length;
  const sourceText = binary === loaded && loaded > 0 ? "binary route pools" : "route pools";
  const missingText = missing ? `, ${missing} missing` : "";
  return `${particles.length.toLocaleString()} particles · ${loaded}/${keys.length} ${sourceText}${missingText}`;
}

function updateReadyStatus() {
  setStatus(`${formatSlot(currentSlot)} ready · ${routePoolSummary()}`, "ready");
}

function updateSelectedDetail() {
  if (selectedLoc !== null) {
    propagationWeights = propagateFrom(selectedLoc);
    showDetailPanel(selectedLoc);
  }
}

async function applyCurrentHourChange() {
  const version = ++timeUpdateVersion;
  const hour = currentHour();
  setStatus(`Loading ${formatSlot(currentSlot)} route pools...`, "loading");
  computeSegmentSpeeds();
  updateDensityRoadData();
  await preloadRoutePools(hour);
  if (version !== timeUpdateVersion || hour !== currentHour()) return;
  rebuildParticles();
  updateSelectedDetail();
  updateReadyStatus();
  warmRoutePoolsAround(hour);
}

function setTimeUi(slot, commit = true) {
  if (commit) currentSlot = slot;
  document.getElementById("hour-label").textContent = formatSlot(slot);
  const active = document.querySelector(`.preset-btn[data-hour="${slot}"]`);
  document.querySelectorAll(".preset-btn").forEach(b => b.classList.toggle("active", b === active));
}

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------
document.querySelectorAll("#mode-group input[type='checkbox']").forEach(el =>
  el.addEventListener("change", async () => {
    enabledModes.clear();
    document.querySelectorAll("#mode-group input:checked").forEach(cb =>
      enabledModes.add(cb.value)
    );
    setStatus(`Loading ${formatSlot(currentSlot)} route pools...`, "loading");
    updateDensityRoadData();
    await preloadRoutePools(currentHour());
    rebuildParticles();
    updateReadyStatus();
    warmRoutePoolsAround(currentHour());
  })
);

const hourSlider = document.getElementById("hour-slider");
hourSlider.addEventListener("input", e => {
  setTimeUi(parseInt(e.target.value), false);
});
hourSlider.addEventListener("change", e => {
  setTimeUi(parseInt(e.target.value));
  applyCurrentHourChange();
});

document.querySelectorAll(".preset-btn").forEach(btn =>
  btn.addEventListener("click", async () => {
    const slot = parseInt(btn.dataset.hour);
    setTimeUi(slot);
    hourSlider.value = slot;
    await applyCurrentHourChange();
  })
);

document.addEventListener("keydown", e => {
  if (e.key === "Escape") deselect();
});

map.on("click", e => {
  if (selectedLoc !== null) deselect();
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
map.on("load", async () => {
  setStatus("Loading traffic data...", "loading");
  await initRoadTileLayer();
  await loadData();
  deckOverlay = new deck.MapboxOverlay({ layers: [], useDevicePixels: true });
  map.addControl(deckOverlay);
  document.getElementById("hour-label").textContent = formatSlot(currentSlot);
  setStatus(`Loading ${formatSlot(currentSlot)} route pools...`, "loading");
  await preloadRoutePools(currentHour());
  initParticles();
  updateReadyStatus();
  warmRoutePoolsAround(currentHour());
  animFrameId = requestAnimationFrame(animateFrame);
});
