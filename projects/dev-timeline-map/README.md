# Toronto Development Timeline Map

This project builds an interactive 3D timeline map of Toronto development activity from public datasets. It combines Toronto 3D massing data, development application records, historical massing, and selected OpenStreetMap building-part geometry.

The map shows existing buildings as a 3D base layer, development applications as timeline-controlled overlays, and completed developments as green as-built massing where the data supports it.

## What It Displays

- A citywide 3D massing base.
- Planned, approved, appealed, and refused applications as colored wireframes.
- Completed developments as solid green 3D buildings.
- Historical 2015 massing at development sites where a before-state is available.
- Selected landmark and complex roof geometry as glTF models.

The timeline slider changes which development states are visible by year.

## Main Data Sources

### Toronto 3D Massing

The City of Toronto's [3D Massing](https://open.toronto.ca/dataset/3d-massing/) dataset is used as the current citywide building model and as the source for completed as-built development geometry.

The 2015 massing data is used as a historical before-state at development sites where it is available.

### Toronto Development Applications

The City of Toronto's [Development Applications](https://open.toronto.ca/dataset/development-applications/) records provide:

- application number
- address
- submission date
- status
- description
- point location

These records determine when projects appear in the timeline and how they are categorized.

### Development Pipeline

The City of Toronto's [Development Pipeline](https://www.toronto.ca/city-government/data-research-maps/research-reports/planning-development/development-pipeline/) adds supplemental project attributes where available, including gross floor area and residential unit counts.

### OpenStreetMap

OpenStreetMap building-part data is used to add detail for some buildings with multipart or stepped geometry.

## Current Behavior

The current workflow uses 2025 massing as the default citywide base.

At development sites:

- the base can show a 2015 before-state before completion
- planned or active applications can appear as wireframes
- completed applications can appear as green 2025 as-built geometry

If a planned application does not have a completed counterpart in the available data, it remains an estimated-height wireframe.

## Known Data Limits

The project depends on public datasets that are not always complete or consistent. Known limitations include:

- application coordinates can be approximate
- one site can have multiple related application records
- status values do not always describe physical construction state
- proposed height is sometimes estimated from application text
- historical massing coverage and detail vary by location
- multipart sites can be difficult to match automatically
