/* global maplibregl, deck, pmtiles */

const STATUS_COLORS = {
  planned:   [245, 158,  11, 220],
  approved:  [ 59, 130, 246, 220],
  appealed:  [168,  85, 247, 220],
  completed: [ 34, 197,  94, 220],
  refused:   [239,  68,  68, 220],
};

const STATUS_COLORS_HEX = {
  planned:   "#f59e0b",
  approved:  "#3b82f6",
  appealed:  "#a855f7",
  completed: "#22c55e",
  refused:   "#ef4444",
};

// ---------------------------------------------------------------------------
// PMTiles protocol
// ---------------------------------------------------------------------------
const protocol = new pmtiles.Protocol();
maplibregl.addProtocol("pmtiles", protocol.tile);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let devData      = null;
let devDetailed  = null;
let landmarks    = null;
const USE_COMPLETED_ASBUILT = true;
let currentYear  = 2015;
let enabledStatuses = new Set(["planned", "approved", "appealed", "completed", "refused"]);
let deckOverlay  = null;
let mapReady     = false;
const tooltip = document.getElementById("tooltip");
const appUrl = path => new URL(path, document.baseURI).href;
const massingBasePmtilesUrl = window.PORTFOLIO_ASSETS?.massingBasePmtiles
  || appUrl("data/processed/massing_base.pmtiles");

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------
const map = new maplibregl.Map({
  container: "map",
  style: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
  center: [-79.390, 43.653],
  zoom: 13,
  pitch: 50,
  bearing: -15,
  antialias: true,
  pitchWithRotate: true,
  maxPitch: 85,
});

map.addControl(new maplibregl.NavigationControl(), "bottom-right");

// ---------------------------------------------------------------------------
// MapLibre fill-extrusion for base massing (PMTiles vector source)
// ---------------------------------------------------------------------------
function initMassingSources() {
  map.addSource("massing-base-src", {
    type: "vector",
    url: `pmtiles://${massingBasePmtilesUrl}`,
  });
  map.addLayer({
    id: "massing-base-layer",
    type: "fill-extrusion",
    source: "massing-base-src",
    "source-layer": "massing_base",
    minzoom: 10,
    paint: {
      "fill-extrusion-color": "rgba(150, 160, 180, 0.45)",
      "fill-extrusion-height": ["coalesce", ["to-number", ["get", "height"]], 5],
      "fill-extrusion-base":   ["coalesce", ["to-number", ["get", "min_height"]], 0],
      "fill-extrusion-opacity": 1.0,
    },
  });
}

function initCompletedDevLayers() {
  if (USE_COMPLETED_ASBUILT) {
    map.addSource("completed-asbuilt-src", {
      type: "vector",
      url: `pmtiles://${appUrl("data/processed/completed_asbuilt.pmtiles")}`,
    });
    map.addLayer({
      id: "completed-asbuilt-layer",
      type: "fill-extrusion",
      source: "completed-asbuilt-src",
      "source-layer": "completed_asbuilt",
      paint: {
        "fill-extrusion-color": STATUS_COLORS_HEX.completed,
        "fill-extrusion-height": ["coalesce", ["to-number", ["get", "height"]], 10],
        "fill-extrusion-base": ["coalesce", ["to-number", ["get", "min_height"]], 0],
        "fill-extrusion-opacity": 1.0,
      },
    });
    return;
  }

  map.addSource("dev-completed-src", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });
  map.addLayer({
    id: "dev-completed-layer",
    type: "fill-extrusion",
    source: "dev-completed-src",
    paint: {
      "fill-extrusion-color": STATUS_COLORS_HEX.completed,
      "fill-extrusion-height": ["coalesce", ["get", "height_m"], 10],
      "fill-extrusion-base": 0,
      "fill-extrusion-opacity": 1.0,
    },
  });

  if (devDetailed && devDetailed.features.length) {
    map.addSource("dev-detailed-src", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    map.addLayer({
      id: "dev-detailed-layer",
      type: "fill-extrusion",
      source: "dev-detailed-src",
      paint: {
        "fill-extrusion-color": STATUS_COLORS_HEX.completed,
        "fill-extrusion-height": ["coalesce", ["get", "height_m"], 10],
        "fill-extrusion-base": ["coalesce", ["get", "min_height"], 0],
        "fill-extrusion-opacity": 1.0,
      },
    });
  }
}

function updateCompletedDevLayers() {
  if (map.getLayer("completed-asbuilt-layer")) {
    map.setFilter("completed-asbuilt-layer", [
      "<=",
      ["to-number", ["get", "year"]],
      currentYear,
    ]);
  }
  if (map.getSource("dev-completed-src")) {
    const completedPost = devData.features.filter(f => {
      const { year, status, phase } = f.properties;
      return phase === "post" && status === "completed" && year <= currentYear;
    });
    map.getSource("dev-completed-src").setData({
      type: "FeatureCollection",
      features: completedPost,
    });
  }

  if (devDetailed && map.getSource("dev-detailed-src")) {
    const detailedPost = devDetailed.features.filter(f => {
      const { year, phase } = f.properties;
      return phase === "post" && year <= currentYear;
    });
    map.getSource("dev-detailed-src").setData({
      type: "FeatureCollection",
      features: detailedPost,
    });
  }
}

function updateMassingFilter() {
  if (!mapReady) return;
  const massingFilter = [
    "any",
    ["!", ["has", "dev_year"]],
    ["all",
      ["==", ["get", "dev_status"], "completed"],
      [">", ["to-number", ["get", "dev_year"]], currentYear],
    ],
    ["!=", ["get", "dev_status"], "completed"],
  ];
  map.setFilter("massing-base-layer", massingFilter);
}

// ---------------------------------------------------------------------------
// deck.gl layers (dev applications + glTF landmarks)
// ---------------------------------------------------------------------------
function buildLayers() {
  const layers = [];

  if (devData) {
    // Only non-completed devs in deck.gl (wireframe rendering)
    // Completed devs are in MapLibre fill-extrusion layers for proper z-ordering
    const wireframeFeatures = devData.features.filter(f => {
      const { year, status, phase, complete_year } = f.properties;
      // Skip completed and pre-phase — handled by MapLibre layers
      if (status === "completed" || phase === "pre" || phase === "post") return false;
      if (year > currentYear) return false;
      if (complete_year && currentYear >= complete_year) return false;
      if (status === "refused") return year === currentYear;
      return enabledStatuses.has(status);
    });

    if (wireframeFeatures.length) {
      layers.push(new deck.GeoJsonLayer({
        id: "developments-wireframe",
        data: { type: "FeatureCollection", features: wireframeFeatures },
        extruded: true,
        wireframe: true,
        getElevation: f => Math.max(f.properties.height_m ?? 14, 10),
        getFillColor: f => [...(STATUS_COLORS[f.properties.status] ?? [180, 180, 180]).slice(0, 3), 30],
        getLineColor: f => STATUS_COLORS[f.properties.status] ?? [180, 180, 180, 200],
        lineWidthMinPixels: 1,
        pickable: true,
        autoHighlight: true,
        highlightColor: [255, 255, 255, 60],
        onHover: info => handleHover(info),
        updateTriggers: { getLineColor: [[...enabledStatuses].join()] },
      }));
    }

    updateCountDisplay(wireframeFeatures.length, wireframeFeatures.length);
  }

  if (landmarks && landmarks.length) {
    layers.push(new deck.ScenegraphLayer({
      id: "landmarks-gltf",
      data: landmarks,
      scenegraph: d => d.model,
      getPosition: d => [d.lon, d.lat, 0],
      getOrientation: [0, 0, 90],
      sizeScale: 1,
      _lighting: "pbr",
      pickable: false,
    }));
  }

  return layers;
}

function render() {
  updateMassingFilter();
  updateCompletedDevLayers();
  if (deckOverlay) deckOverlay.setProps({ layers: buildLayers() });
}

// ---------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------
function handleHover(info) {
  if (!info.object) {
    tooltip.style.display = "none";
    return;
  }
  const p     = info.object.properties;
  const color = STATUS_COLORS_HEX[p.status] ?? "#888";
  const storeys = p.storeys ? `${p.storeys} storeys` : "storeys unknown";
  const gfa   = p.gfa_m2 ? ` · ${Math.round(p.gfa_m2).toLocaleString()} m² GFA` : "";
  const desc  = p.description
    ? p.description.slice(0, 200) + (p.description.length > 200 ? "…" : "")
    : "";

  tooltip.innerHTML = `
    <strong>${p.address || "Unknown address"}</strong>
    <span class="status-badge" style="background:${color}22;color:${color}">${p.status}</span>
    <div>${p.date_submitted ?? ""} · ${storeys}${gfa}</div>
    ${desc ? `<div style="margin-top:5px;color:#aaa;font-size:11px">${desc}</div>` : ""}
  `;
  tooltip.style.display = "block";
  tooltip.style.left = `${info.x + 12}px`;
  tooltip.style.top  = `${info.y - 10}px`;
}

function showCompletedTooltip(e) {
  const feature = e.features && e.features[0];
  if (!feature) return;

  const p = feature.properties || {};
  tooltip.innerHTML = `
    <strong>${p.address || "Completed development"}</strong>
    <span class="status-badge" style="background:${STATUS_COLORS_HEX.completed}22;color:${STATUS_COLORS_HEX.completed}">completed</span>
    <div>${p.app_number ?? ""} · ${p.year ?? ""}</div>
    <div style="margin-top:5px;color:#aaa;font-size:11px">2025 as-built massing</div>
  `;
  tooltip.style.display = "block";
  tooltip.style.left = `${e.point.x + 12}px`;
  tooltip.style.top = `${e.point.y - 10}px`;
}

function hideMapTooltip() {
  tooltip.style.display = "none";
}

// ---------------------------------------------------------------------------
// Count display
// ---------------------------------------------------------------------------
function updateCountDisplay(colored, total) {
  document.getElementById("count-display").textContent =
    `${colored.toLocaleString()} active · ${total.toLocaleString()} total on map`;
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------
async function loadData() {
  const [devResp, detailedResp, landmarksResp] = await Promise.all([
    fetch(appUrl("data/processed/developments.geojson")),
    fetch(appUrl("data/processed/developments_detailed.geojson")).catch(() => null),
    fetch(appUrl("models/landmarks.json")),
  ]);
  devData     = await devResp.json();
  devDetailed = detailedResp && detailedResp.ok ? await detailedResp.json() : null;
  landmarks   = await landmarksResp.json();
  landmarks = landmarks.map(d => ({ ...d, model: appUrl(`models/${d.model.split("/").pop()}`) }));
}

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------
document.getElementById("year-slider").addEventListener("input", e => {
  currentYear = parseInt(e.target.value);
  document.getElementById("year-label").textContent = currentYear;
  render();
});

document.querySelectorAll(".legend-item input[type='checkbox']").forEach(el =>
  el.addEventListener("change", () => {
    enabledStatuses.clear();
    document.querySelectorAll(".legend-item input:checked").forEach(cb =>
      enabledStatuses.add(cb.closest(".legend-item").dataset.status)
    );
    render();
  })
);

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
map.on("load", async () => {
  mapReady = true;
  initMassingSources();
  await loadData();
  initCompletedDevLayers();
  if (map.getLayer("completed-asbuilt-layer")) {
    map.on("mousemove", "completed-asbuilt-layer", showCompletedTooltip);
    map.on("mouseleave", "completed-asbuilt-layer", hideMapTooltip);
  }
  deckOverlay = new deck.MapboxOverlay({ layers: [] });
  map.addControl(deckOverlay);
  render();
});
