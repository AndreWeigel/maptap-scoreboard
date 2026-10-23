// Geometry for shape rounds: nearest point on a GeoJSON shape, point-in-polygon,
// bbox centre, and GeoJSON normalisation. Dependency-free on purpose (the game
// module stays liftable). GeoJSON positions are [lng, lat]; our API uses (lat, lng).
const R = 6371, rad = Math.PI / 180, deg = 180 / Math.PI;
const MAX_VERTICES = 5000;
const MAX_BYTES = 1000000;
const ERR_BIG = 'shape too big — simplify it at mapshaper.org (max 5,000 points)';
const ERR_MIXED = 'paste one kind of shape (all lines, or all areas)';
const ERR_INVALID = 'invalid shape';

function haversineKm(lat1, lng1, lat2, lng2) {
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---- unit-sphere vectors for great-circle segments ----
const toVec = (lat, lng) => {
  const p = lat * rad, l = lng * rad;
  return [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
};
const fromVec = ([x, y, z]) => ({ lat: Math.atan2(z, Math.hypot(x, y)) * deg, lng: Math.atan2(y, x) * deg });
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const angle = (a, b) => Math.atan2(len(cross(a, b)), dot(a, b));

// Nearest point to P on the great-circle arc A→B (all as {lat,lng}).
function nearestOnSegment(p, a, b) {
  const P = toVec(p.lat, p.lng), A = toVec(a.lat, a.lng), B = toVec(b.lat, b.lng);
  const n = cross(A, B), nl = len(n);
  if (nl > 1e-12) {
    const N = scale(n, 1 / nl);
    const f = sub(P, scale(N, dot(P, N))), fl = len(f); // foot of P on the great circle
    if (fl > 1e-12) {
      const F = scale(f, 1 / fl);
      if (Math.abs(angle(A, F) + angle(F, B) - angle(A, B)) < 1e-9) return fromVec(F); // foot lies on the arc
    }
  }
  return angle(P, A) <= angle(P, B) ? a : b; // degenerate or outside the arc: nearer endpoint
}

// Even-odd ray casting on lng/lat. Known limitation: rings crossing the 180° meridian.
function inRing(lat, lng, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const inPolygon = (lat, lng, rings) => inRing(lat, lng, rings[0]) && !rings.slice(1).some((h) => inRing(lat, lng, h));

const r5 = (x) => +x.toFixed(5);

function nearestOnGeometry(lat, lng, g) {
  let best = null;
  const consider = (c) => { if (!best || c.km < best.km) best = c; };
  const pt = ([x, y]) => consider({ km: haversineKm(lat, lng, y, x), lat: y, lng: x });
  const line = (coords) => {
    for (let i = 1; i < coords.length; i++) {
      const n = nearestOnSegment({ lat, lng }, { lat: coords[i - 1][1], lng: coords[i - 1][0] }, { lat: coords[i][1], lng: coords[i][0] });
      consider({ km: haversineKm(lat, lng, n.lat, n.lng), lat: n.lat, lng: n.lng });
    }
  };
  const poly = (rings) => { if (inPolygon(lat, lng, rings)) consider({ km: 0, lat, lng }); else rings.forEach(line); };
  switch (g.type) {
    case 'Point': pt(g.coordinates); break;
    case 'MultiPoint': g.coordinates.forEach(pt); break;
    case 'LineString': line(g.coordinates); break;
    case 'MultiLineString': g.coordinates.forEach(line); break;
    case 'Polygon': poly(g.coordinates); break;
    case 'MultiPolygon': g.coordinates.forEach(poly); break;
    default: throw new Error(`unsupported geometry ${g.type}`);
  }
  return { km: best.km, lat: r5(best.lat), lng: r5(best.lng) };
}

function positionsOf(g) {
  const out = [];
  const walk = (c) => (typeof c[0] === 'number' ? out.push(c) : c.forEach(walk));
  walk(g.coordinates);
  return out;
}

function bboxCenter(g) {
  let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
  for (const [x, y] of positionsOf(g)) {
    if (y < minLat) minLat = y; if (y > maxLat) maxLat = y;
    if (x < minLng) minLng = x; if (x > maxLng) maxLng = x;
  }
  return { lat: r5((minLat + maxLat) / 2), lng: r5((minLng + maxLng) / 2) };
}

// ---- normalisation of pasted GeoJSON ----
const KIND = { Point: 'point', MultiPoint: 'point', LineString: 'line', MultiLineString: 'line', Polygon: 'area', MultiPolygon: 'area' };

// A clean [lng, lat] or null.
function cleanPos(p) {
  if (!Array.isArray(p) || p.length < 2) return null;
  const x = p[0], y = p[1];
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (Math.abs(x) > 180 || Math.abs(y) > 90) return null;
  return [x, y];
}
const cleanLine = (c) => {
  if (!Array.isArray(c) || c.length < 2) return null;
  const out = c.map(cleanPos);
  return out.includes(null) ? null : out;
};
const cleanRing = (c) => {
  const out = cleanLine(c);
  if (!out) return null;
  const [fx, fy] = out[0], [lx, ly] = out[out.length - 1];
  if (fx !== lx || fy !== ly) out.push([fx, fy]);
  return out.length < 4 ? null : out;
};
const cleanPoly = (rings) => {
  if (!Array.isArray(rings) || !rings.length) return null;
  const out = rings.map(cleanRing);
  return out.includes(null) ? null : out;
};

// Flatten one geometry into { kind, parts } where parts are positions / lines / polygons.
function flatten(g) {
  if (!g || typeof g !== 'object' || !KIND[g.type]) return null;
  const kind = KIND[g.type], c = g.coordinates;
  let parts;
  if (g.type === 'Point') parts = [cleanPos(c)];
  else if (g.type === 'MultiPoint') parts = Array.isArray(c) ? c.map(cleanPos) : [null];
  else if (g.type === 'LineString') parts = [cleanLine(c)];
  else if (g.type === 'MultiLineString') parts = Array.isArray(c) ? c.map(cleanLine) : [null];
  else if (g.type === 'Polygon') parts = [cleanPoly(c)];
  else parts = Array.isArray(c) ? c.map(cleanPoly) : [null];
  return !parts.length || parts.includes(null) ? null : { kind, parts };
}

function normalizeGeometry(input) {
  if (input == null) return null;
  if (typeof input === 'string') {
    if (input.length > MAX_BYTES) return { error: ERR_BIG };
    try { input = JSON.parse(input); } catch { return { error: ERR_INVALID }; }
  }
  if (!input || typeof input !== 'object') return { error: ERR_INVALID };
  if (JSON.stringify(input).length > MAX_BYTES) return { error: ERR_BIG };
  let geoms;
  if (input.type === 'Feature') geoms = [input.geometry];
  else if (input.type === 'FeatureCollection') geoms = Array.isArray(input.features) ? input.features.map((f) => f && f.geometry) : [];
  else geoms = [input];
  const flat = geoms.map(flatten);
  if (!flat.length || flat.includes(null)) return { error: ERR_INVALID };
  if (new Set(flat.map((f) => f.kind)).size > 1) return { error: ERR_MIXED };
  const kind = flat[0].kind, parts = flat.flatMap((f) => f.parts);
  const vertices = kind === 'point' ? parts.length : kind === 'line' ? parts.reduce((s, l) => s + l.length, 0)
    : parts.reduce((s, p) => s + p.reduce((t, r) => t + r.length, 0), 0);
  if (vertices > MAX_VERTICES) return { error: ERR_BIG };
  if (kind === 'point') return parts.length === 1 ? { type: 'Point', coordinates: parts[0] } : { type: 'MultiPoint', coordinates: parts };
  if (kind === 'line') return parts.length === 1 ? { type: 'LineString', coordinates: parts[0] } : { type: 'MultiLineString', coordinates: parts };
  return parts.length === 1 ? { type: 'Polygon', coordinates: parts[0] } : { type: 'MultiPolygon', coordinates: parts };
}

module.exports = { haversineKm, nearestOnGeometry, bboxCenter, normalizeGeometry, MAX_VERTICES, MAX_BYTES };
