# Toronto Traffic Heatmap

[Live app](https://elinsooon.github.io/apps/traffic-heatmap/) · [Source](../../apps/traffic-heatmap/)

An animated map of Toronto movement from 7 AM to 7 PM, built from intersection turning movement counts and an OpenStreetMap road graph. Particles show activity across modes; road colors show relative car volume.

The processed network contains 3,987 count locations and 43,763 directed segments. Time-slot flows and hourly route pools drive the animation. MapLibre GL and deck.gl handle rendering, while a Web Worker loads binary route pools with typed arrays and a JSON fallback.

## Run locally

Requires Python 3. From the repository root:

```sh
python3 serve.py --port 8000
```

Open [localhost:8000/apps/traffic-heatmap/](http://localhost:8000/apps/traffic-heatmap/). The frontend and processed assets are included; the Python preprocessing pipeline and raw exports are not. Browser libraries and basemaps require an internet connection.

## Data and interpretation

The source is Toronto's [Traffic Volumes – Multimodal Intersection Turning Movement Counts](https://ckan0.cf.opendata.inter.prod-toronto.ca/ne/dataset/traffic-volumes-at-intersections-for-all-modes), combined with geometry from [OpenStreetMap contributors](https://www.openstreetmap.org/copyright).

Counts are collected at particular locations and times, rather than as a synchronized citywide survey. Routes, particle speeds, and corridor smoothing are generated for the visualization. Inferred segment volumes are displayed with reduced intensity. The map does not reconstruct individual trips or measured congestion. The app's “Transit” category combines buses and trucks; it does not measure ridership. Overnight inference was excluded because the sparse observations did not support convincing patterns.
