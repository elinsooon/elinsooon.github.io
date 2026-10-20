# Portfolio

[Live site](https://elinsooon.github.io/)

Personal portfolio of data engineering, modeling, and geospatial projects. The site is static HTML, CSS, and JavaScript, hosted on GitHub Pages.

## Projects

- [NHL Prediction Model](https://github.com/elinsooon/nhlmodel): Python data pipeline and chronological model evaluation against betting-market probabilities.
- [Toronto Development Timeline](projects/dev-timeline-map/README.md): interactive 3D development map.
- [Toronto Traffic Heatmap](projects/traffic-heatmap/README.md): animated multimodal movement visualization.
- [Spatial SIR Model](projects/sir-model/README.md): stochastic epidemic modeling with individual mobility.

## Local preview

Requires Python 3. From the repository root:

```sh
python3 serve.py --port 8000
```

Open [localhost:8000](http://localhost:8000/). Use this server for map previews: it supports the byte-range requests required by PMTiles.

## Repository contents

`apps/` contains the map frontends and processed datasets. `projects/` contains notes pages and project documentation; `assets/` contains the resume and SIR report and slides. The map preprocessing pipelines and raw source data are not included.

The larger map assets are committed directly, including PMTiles building layers and hourly route pools. All individual files are below GitHub's normal per-file size limit, but the full checkout is substantial. No JavaScript build step is required; the maps load their browser libraries and basemaps from external services.
