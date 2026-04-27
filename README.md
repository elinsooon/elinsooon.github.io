# Portfolio

Static GitHub Pages portfolio for interactive civic-data projects.

## Local preview

From this directory:

```sh
python3 serve.py --port 8000
```

Then open:

```text
http://localhost:8000/
```

## GitHub Pages deployment

1. Create a GitHub repository for this folder.
2. Push the files.
3. In the repository settings, enable GitHub Pages from the main branch root.

## Large asset note

The development timeline PMTiles file has been rebuilt under GitHub's normal 100 MiB file limit and is included directly in the Pages repo.

The traffic heatmap now includes binary route pools and a Web Worker loader. The current route-pool directory is large, but the individual files are below GitHub's normal per-file limit.

Use `serve.py` for local preview. Python's default `http.server` does not reliably serve the byte-range responses that PMTiles needs.
