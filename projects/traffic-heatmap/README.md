# Toronto Traffic Heatmap

An interactive browser map for exploring Toronto turning movement count data as animated, multi-modal traffic flow. The app combines Toronto TMC observations with an OpenStreetMap road graph, then renders two complementary views:

- moving particles for cars, transit/heavy vehicles, pedestrians, and bikes
- a road-density heat layer, currently based on car volumes

The goal is not microscopic traffic simulation. It is a visual model that preserves the observed hourly flow structure while making the city-wide pattern legible: where traffic is heavy, how activity shifts through the day, and how different modes appear relative to one another.

## What It Shows

The map runs from 7:00 AM through 7:00 PM in hourly steps. This range was chosen because the underlying TMC dataset is much better populated during daytime than overnight. Earlier nighttime inference was explored, but the visual result was misleading in sparse areas, so the live app uses the observed daytime data only.

The controls let you:

- toggle cars, pedestrians, bikes, and transit/heavy vehicles
- jump between common times such as AM peak, midday, and PM peak
- scrub by hour from 7 AM to 7 PM
- click an intersection to inspect outgoing flow
- see load/cache status for the current hour in the control panel

Particle colors intentionally avoid the green/yellow/red road-density palette so that mode identity does not blend into the density layer.

## Project Layout

```text
traffic-heatmap/
  data/processed/
    tmc_locations.json       # TMC intersection locations
    tmc_counts.json          # compact per-intersection count aggregate
    tmc_segments.json        # directed OSM road segments used by the app
    tmc_flows.json           # per-segment, per-slot mode volumes
    traffic_roads.geojson    # optional static road export
    route_pools/             # precomputed hourly particle routes
  pipeline/
    process_tmc.py           # raw TMC CSV -> locations/counts
    build_segments.py        # OSM graph + TMC locations -> road graph/flows
    generate_route_pools.py  # hourly route pools for particles
    generate_road_tiles.py   # optional PMTiles road geometry export
    precompute_night_flows.py
    validate_outputs.py      # generated-data sanity checks
  web/
    index.html
    style.css
    map.js
    routePoolWorker.js       # background route-pool loading/parsing
```

## Running Locally

The app must be served over HTTP because it fetches JSON and binary route-pool files. Opening `index.html` directly with `file://` will not work reliably.

From the parent directory:

```bash
python3 -m http.server 8080 --directory .
```

Then open:

```text
http://localhost:8080/traffic-heatmap/web/
```

If you serve from inside `traffic-heatmap/`, use:

```text
http://localhost:8080/web/
```

## Data Pipeline

The pipeline expects the raw Toronto TMC CSV at:

```text
data/tmc_raw_data_2020_2029.csv
```

relative to the `Toronto Open Data` directory that contains `traffic-heatmap/`.

Python pipeline dependencies:

```bash
pip install pandas osmnx networkx
```

Optional PMTiles export dependencies:

```bash
pip install geopandas freestiler
```

Typical build order:

```bash
python3 traffic-heatmap/pipeline/process_tmc.py
python3 traffic-heatmap/pipeline/build_segments.py
python3 traffic-heatmap/pipeline/generate_route_pools.py \
  --routes-per-pool 1000 \
  --cover-spawnable \
  --hours 7-19 \
  --modes cars,transit,peds,bikes \
  --no-index
```

`--no-index` keeps the JSON fallback files smaller. The script still writes compact `.bin` route pools, which the browser prefers.

Validate the generated app data:

```bash
python3 traffic-heatmap/pipeline/validate_outputs.py
```

Optional static road export:

```bash
python3 traffic-heatmap/pipeline/generate_road_tiles.py
```

This always writes `traffic_roads.geojson`. It writes `traffic_roads.pmtiles` only if the optional `geopandas` and `freestiler` dependencies are installed.

PMTiles are optional in the current app. If `traffic_roads.pmtiles` is absent, the frontend silently skips that layer and continues to render the simulation with deck.gl from `tmc_segments.json`.

`precompute_night_flows.py` can regenerate the earlier experimental nighttime file, `tmc_flows_inferred.json`, but that file is not required by the current app and is not part of the active processed-data set.

## Notes

Route pools are generated per mode and per hour. On the frontend, route pools are loaded in a Web Worker and cached. Adjacent hours are warmed in the background after the selected hour loads, which reduces lag when stepping through nearby times.

The app currently still loads `tmc_segments.json` into memory because the particle animation, intersection hit-testing, and route lookup need access to segment geometry and graph metadata. PMTiles are treated as an optional static-road optimization, not as a replacement for the simulation data.
