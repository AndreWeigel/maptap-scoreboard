// Distance scoring for custom games (spec-pinned formula). Kept dependency-free
// so the whole game module stays liftable.
const rad = Math.PI / 180;

function haversineKm(lat1, lng1, lat2, lng2) {
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Full points within the round's tolerance radius, smooth decay beyond it.
function points(km, radius = 25) {
  return km <= radius ? 100 : Math.round(100 * Math.exp(-(km - radius) / 500));
}

module.exports = { haversineKm, points };
