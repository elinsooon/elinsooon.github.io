# Toronto Development Timeline

[Live app](https://elinsooon.github.io/apps/dev-timeline-map/) · [Source](../../apps/dev-timeline-map/)

An interactive 3D map of Toronto development activity. A year slider controls application overlays and completed building layers, combining public records with citywide massing and selected detailed geometry.

The frontend uses MapLibre GL for building extrusions, deck.gl for wireframes and glTF models, and PMTiles for tiled massing. Application records are joined to building geometry in the processed datasets. Proposals appear as colored wireframes; completed records use solid green as-built shapes where available.

## Run locally

Requires Python 3. From the repository root:

```sh
python3 serve.py --port 8000
```

Open [localhost:8000/apps/dev-timeline-map/](http://localhost:8000/apps/dev-timeline-map/). The server supports PMTiles byte-range requests. The frontend and processed assets are included; the Python preprocessing pipeline and raw inputs are not. Browser libraries and basemaps require an internet connection.

## Data

- Toronto [3D Massing](https://open.toronto.ca/dataset/3d-massing/): 2015 historical and 2025 current building geometry.
- Toronto [Development Applications](https://open.toronto.ca/dataset/development-applications/): application identifiers, dates, status, descriptions, and locations.
- Toronto [Development Pipeline](https://www.toronto.ca/city-government/data-research-maps/research-reports/planning-development/development-pipeline/): supplemental project attributes.
- [OpenStreetMap contributors](https://www.openstreetmap.org/copyright): selected building-part geometry.

Historical geometry is available only at some sites. Coordinates can be approximate, multiple applications can refer to one site, and proposed heights may be estimated. The timeline uses processed application dates and statuses; it is not a complete construction history, and application dates do not necessarily indicate physical completion.
