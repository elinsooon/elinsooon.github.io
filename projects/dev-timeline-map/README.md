# Toronto Development Timeline Map

This project is an interactive 3D timeline of Toronto's built form and development pipeline. It combines citywide 2025 3D massing data, historical 2015 massing, current planning application records, and selected OpenStreetMap building-part geometry into a browser-based map that can be scrubbed through time.

The goal is to show not just where development applications exist, but how they change the perceived city model over time. Existing buildings are rendered as a muted base massing layer. Planned, approved, appealed, and refused applications appear as colored wireframes. Completed developments appear as solid green buildings using 2025 as-built massing geometry. Where possible, the map preserves detailed stepped or multipart building forms rather than reducing everything to a single extruded block.

## Core Idea

The map treats Toronto's 2025 3D massing dataset as the default city model. That means the base map starts from the most complete current representation available for the whole city.

For parcels that have development activity between 2015 and 2026, the pipeline changes the base behavior:

- Before completion, the site can show a 2015 "before" condition where 2015 massing is available.
- During planning, the project appears as a colored wireframe.
- Once complete, the base is hidden and the completed project appears as green 2025 as-built geometry.

This creates a simple visual model:

```text
2025 massing everywhere
2015 replacement only at development sites
wireframe for planned/future development
green 2025 as-built geometry for completed development
```

## Data Sources

The project uses local Toronto Open Data exports and derived files:

- `data/raw/3d-massing/`  
  2025 citywide 3D massing shapefile. This is the universal base and the source for completed as-built geometry.

- `data/raw/toronto_dev_apps.csv`  
  Development application records with application numbers, statuses, descriptions, dates, and coordinates.

- `data/raw/Development Pipeline.csv`  
  Supplemental gross floor area and residential unit data.

- `data/processed/massing_2015_osm.geojson`  
  Historical 2015 massing enriched with OSM building parts. This is used only as the "before" state at development sites.

- `pipeline/osm_full_*_cache.json`  
  OpenStreetMap building-part, relation, roof, height, and stadium cache files used for detail enrichment.

AIC/SKP model downloads are archived under `archive/aic/` and are not part of the active workflow.

## Processing Pipeline

The main pipeline is `pipeline/process.py`.

At a high level it:

1. Loads 2025 citywide massing.
2. Loads 2015 historical massing.
3. Loads and classifies development applications.
4. Joins additional pipeline data such as GFA and residential units.
5. Snaps application points to nearby 2025 footprints.
6. Groups multiple applications into site timelines.
7. Builds completed as-built geometry from 2025 massing.
8. Builds a unified base layer that hides under completed development.
9. Exports GeoJSON files for the frontend.

The tile generation step is handled by `pipeline/generate_tiles.py`, which converts large GeoJSON massing outputs into PMTiles vector tiles.

## Output Layers

The active processed outputs are:

- `data/processed/massing_base.geojson`
- `data/processed/massing_base.pmtiles`
- `data/processed/completed_asbuilt.geojson`
- `data/processed/completed_asbuilt.pmtiles`
- `data/processed/developments.geojson`
- `data/processed/developments_detailed.geojson`
- `data/processed/despawn_audit.json`

The browser renders these as:

- Grey base massing from `massing_base.pmtiles`
- Green completed buildings from `completed_asbuilt.pmtiles`
- Colored wireframes from `developments.geojson`
- Landmark glTF models from `web/models/landmarks.json`

## Timeline Behavior

The year slider controls which development phase is visible.

For completed sites:

- Before the completion year, the pre-development base remains visible.
- At and after the completion year, the base despawns and the green 2025 as-built geometry appears.

For planned, approved, or appealed sites without a completed entry:

- The project appears as an estimated-height wireframe from its submission year onward.
- Height is estimated from the maximum storey count parsed from the application description.

For sites that have both planning and completed records:

- The project appears as a wireframe during the planning period.
- The wireframe uses the 2025 footprint and height so its shape matches the eventual completed building more closely.
- At the completed year, the wireframe disappears and the green as-built geometry appears.

For refused sites:

- The project only appears in its submission year.

## Why 2025 As-Built Geometry Matters

Many completed developments are not well represented by a single application point or a simplified estimated extrusion. The 2025 massing dataset often contains multiple polygons for a single building, including podiums, towers, roof structures, and stepped forms.

Using 2025 massing for completed development gives the map:

- better building footprints
- more accurate heights
- multipart geometry
- correct bases for stepped buildings
- fewer generic block extrusions

The pipeline includes guardrails to avoid accidentally assigning unrelated landmarks to development applications. For example, a low-rise application near the CN Tower should not be allowed to claim the CN Tower just because it is spatially nearby. Height-plausibility checks are used during footprint snapping, OSM enrichment, 2015 replacement tagging, and 2025 as-built selection.

## Frontend

The frontend lives in `web/`.

It uses:

- MapLibre GL JS for the base map and solid fill-extrusion buildings
- deck.gl for development wireframes and glTF landmarks
- PMTiles for efficient vector tile delivery
- Carto Dark Matter as the basemap

The main renderer is `web/map.js`.

Completed buildings are rendered as MapLibre fill-extrusions so depth ordering works correctly. Wireframes are rendered with deck.gl because MapLibre fill-extrusions do not support the same wireframe styling.

## Quality Checks

The project includes a despawn audit:

```bash
scripts/audit_despawn.py
```

It checks every completed green as-built polygon against the base layer at that completion year. If visible base massing remains underneath a completed building, the audit reports it in:

```text
data/processed/despawn_audit.json
```

The expected complete-state audit result is:

```text
issue_count: 0
invalid_pre_completion_wireframes: 0
```

## Rebuilding

Run the full processing and QA workflow from the project root:

```bash
scripts/rebuild.sh
```

This runs:

1. `pipeline/process.py`
2. `pipeline/generate_tiles.py`
3. `scripts/audit_despawn.py`

The local server is provided by the top-level `serve.py` in the parent workspace and serves the app with HTTP range support for PMTiles.

## Project Status

The current architecture is centered on a stable 2025-first workflow:

- 2025 massing is the citywide base.
- 2015 massing is used surgically as the before-state at development sites.
- Completed developments use 2025 as-built massing.
- Planned-only developments remain estimated-height wireframes.
- AIC/SKP model data is archived and excluded from active processing.

The result is a map that favors citywide consistency, temporal clarity, and detailed real geometry where the source data supports it.
