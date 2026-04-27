function buildIndex(routes) {
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

function parseBinaryRoutePool(buffer) {
  const view = new DataView(buffer);
  const magic =
    String.fromCharCode(view.getUint8(0)) +
    String.fromCharCode(view.getUint8(1)) +
    String.fromCharCode(view.getUint8(2)) +
    String.fromCharCode(view.getUint8(3));
  if (magic !== "RPL2") throw new Error("Unsupported route pool binary format");

  const version = view.getUint32(4, true);
  if (version !== 1) throw new Error(`Unsupported route pool version: ${version}`);

  const routeCount = view.getUint32(8, true);
  const routeValueCount = view.getUint32(12, true);
  const indexSegmentCount = view.getUint32(16, true);
  const indexValueCount = view.getUint32(20, true);
  let offset = 24;

  const routeOffsets = new Uint32Array(buffer, offset, routeCount + 1);
  offset += (routeCount + 1) * 4;
  const routeValues = new Uint32Array(buffer, offset, routeValueCount);
  offset += routeValueCount * 4;
  const indexSegIds = new Uint32Array(buffer, offset, indexSegmentCount);
  offset += indexSegmentCount * 4;
  const indexOffsets = new Uint32Array(buffer, offset, indexSegmentCount + 1);
  offset += (indexSegmentCount + 1) * 4;
  const indexValues = new Uint32Array(buffer, offset, indexValueCount);

  return {
    binary: true,
    routeOffsets,
    routeValues,
    indexSegIds,
    indexOffsets,
    indexValues,
  };
}

async function fetchBinaryPool(binUrl) {
  const resp = await fetch(binUrl);
  if (!resp.ok) throw new Error(`Route pool binary missing: ${binUrl}`);
  return parseBinaryRoutePool(await resp.arrayBuffer());
}

async function fetchJsonPool(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Route pool missing: ${url}`);
  const data = await resp.json();
  const routes = data.routes || [];
  const bySegment = data.bySegment || data.index || buildIndex(routes);
  return { routes, bySegment };
}

self.onmessage = async event => {
  const { requestId, key, url, binUrl } = event.data;
  try {
    try {
      const pool = await fetchBinaryPool(binUrl);
      self.postMessage({ requestId, key, source: "bin", ...pool }, [pool.routeValues.buffer]);
    } catch {
      const pool = await fetchJsonPool(url);
      self.postMessage({ requestId, key, source: "json", ...pool });
    }
  } catch (error) {
    self.postMessage({
      requestId,
      key,
      source: "missing",
      routes: [],
      bySegment: {},
      error: error && error.message ? error.message : String(error),
    });
  }
};
