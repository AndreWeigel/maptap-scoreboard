// Distance scoring for custom games (spec-pinned formula). Kept dependency-free
// so the whole game module stays liftable. Geometry lives in ./geo.
const { haversineKm, nearestOnGeometry } = require('./geo');

// Full points within the round's tolerance radius, smooth decay beyond it.
function points(km, radius = 25) {
  return km <= radius ? 100 : Math.round(100 * Math.exp(-(km - radius) / 500));
}

// Distance from a guess to a round's answer: its shape, or its point. km has one decimal.
function distanceToRound(lat, lng, round) {
  const n = round.geometry
    ? nearestOnGeometry(lat, lng, round.geometry)
    : { km: haversineKm(lat, lng, round.lat, round.lng), lat: round.lat, lng: round.lng };
  return { km: Math.round(n.km * 10) / 10, nearest: { lat: n.lat, lng: n.lng } };
}

module.exports = { haversineKm, points, distanceToRound };
