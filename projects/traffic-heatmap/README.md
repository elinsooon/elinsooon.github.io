# Toronto Traffic Heatmap

Toronto publishes detailed turning movement count data: observations of how many people, bikes, cars, buses, and trucks move through counted intersections at particular times of day. The records are rich, but they are also tabular and intersection-specific. It is difficult to look at the raw data and immediately understand the shape of traffic across the city.

This project turns those counts into an animated map of daytime movement. Particles show multi-modal activity, while the road coloring gives a separate read on car traffic density. The emphasis is visual interpretation rather than microscopic traffic simulation: the map is meant to make broad hourly and corridor-level patterns easier to see.

## Sources

The primary source is the City of Toronto Open Data dataset [Traffic Volumes - Multimodal Intersection Turning Movement Counts](https://ckan0.cf.opendata.inter.prod-toronto.ca/ne/dataset/traffic-volumes-at-intersections-for-all-modes). In this project, the raw export is represented as:

```text
data/tmc_raw_data_2020_2029.csv
```

The processed data keeps the observed modes available in the source records:

- cars
- trucks and buses, shown together as transit/heavy vehicles
- pedestrians
- bikes

The road geometry comes from OpenStreetMap. The project uses the OSM road graph to place the intersection counts onto actual directed road segments, so the final map reads as movement along streets rather than isolated points.

## Scope

The map focuses on 7:00 AM through 7:00 PM. That choice reflects the available data: daytime records are substantially more useful for this visualization than the sparse overnight observations. A nighttime inference pass was explored during development, but it produced patterns that were not convincing enough to include in the main experience.

The road-density coloring is based on car volumes. Other modes remain visible through particles, but they are intentionally not folded into the road heat colors. That keeps the heat layer closer to the everyday meaning of traffic density while still allowing pedestrians, bikes, and transit/heavy vehicles to be seen separately.

## What To Look For

The map is useful for comparing how activity changes over the day: morning peak, midday, afternoon peak, and the taper toward evening. It is also useful for noticing differences between corridors. Some roads stand out because they carry high car density; others show more of their activity through non-car particles.

The result should be read as a data-informed visualization. It preserves the broad structure of the observed counts, but it does not claim to reconstruct exact individual trips, signal timing, lane behavior, or complete origin-destination demand.
