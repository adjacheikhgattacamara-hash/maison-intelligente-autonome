// ==================================================================
// MOTEUR IA LOCAL — analyse de tendances, détection d'anomalies et
// prédiction à court terme. 100% local : aucune clé API, aucun coût.
// ==================================================================

const THRESHOLDS = {
  temp: { low: 19, high: 28, critical: 32 },
  hum: { low: 35, high: 70, critical: 85 },
  light: { low: 150, high: 700 },
  gas: { warn: 300, danger: 700 },
};

const HISTORY_MAX = 40; // ~2-3 min glissantes (mesures toutes les ~4s)
const MIN_POINTS_FOR_STATS = 8;
const ANOMALY_Z_THRESHOLD = 2.5;
const PREDICTION_MINUTES = 10;

// Chaque entrée d'historique garde { value, ts } pour permettre la
// régression linéaire (prédiction) en plus du calcul de tendance simple.
const history = { temperature: [], humidity: [], light: [], gas: [] };

function pushHistory(metric, value) {
  if (!history[metric]) return;
  history[metric].push({ value, ts: Date.now() });
  if (history[metric].length > HISTORY_MAX) history[metric].shift();
}

// ---- Tendance simple : compare le début et la fin de la fenêtre récente ----
function computeTrend(entries) {
  if (!entries || entries.length < 4) return { direction: "stable", delta: 0 };
  const recent = entries.slice(-8);
  const delta = Math.round((recent[recent.length - 1].value - recent[0].value) * 10) / 10;
  let direction = "stable";
  if (Math.abs(delta) >= 0.5) direction = delta > 0 ? "hausse" : "baisse";
  return { direction, delta };
}

// ---- Détection d'anomalie : écart-type par rapport à la moyenne récente ----
function detectAnomaly(entries, currentValue) {
  if (!entries || entries.length < MIN_POINTS_FOR_STATS) return { isAnomaly: false };
  const values = entries.map((e) => e.value);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  const std = Math.sqrt(variance);
  if (std < 0.01) return { isAnomaly: false };
  const zScore = (currentValue - mean) / std;
  return {
    isAnomaly: Math.abs(zScore) > ANOMALY_Z_THRESHOLD,
    zScore: Math.round(zScore * 10) / 10,
    mean: Math.round(mean * 10) / 10,
  };
}

// ---- Régression linéaire simple (y = pente*x + ordonnée) ----
function linearRegression(points) {
  const n = points.length;
  if (n < 2) return null;
  const sumX = points.reduce((s, p) => s + p.x, 0);
  const sumY = points.reduce((s, p) => s + p.y, 0);
  const sumXY = points.reduce((s, p) => s + p.x * p.y, 0);
  const sumXX = points.reduce((s, p) => s + p.x * p.x, 0);
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return null;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}

// ---- Prédit la valeur d'une métrique dans N minutes ----
function predict(entries, minutesAhead = PREDICTION_MINUTES) {
  if (!entries || entries.length < 6) return null;
  const t0 = entries[0].ts;
  const points = entries.map((e) => ({ x: (e.ts - t0) / 60000, y: e.value })); // x en minutes
  const reg = linearRegression(points);
  if (!reg) return null;
  const lastX = points[points.length - 1].x;
  const predictedValue = reg.slope * (lastX + minutesAhead) + reg.intercept;
  return {
    value: Math.round(predictedValue * 10) / 10,
    minutesAhead,
    ratePerMin: Math.round(reg.slope * 100) / 100,
  };
}

function analyze(state) {
  const recos = [];
  const trends = {};
  const anomalies = {};
  const predictions = {};
  let confidencePoints = 0;
  let confidenceTotal = 0;
  let urgency = "normal"; // normal | warn | danger

  const bump = (level) => {
    if (level === "danger") urgency = "danger";
    else if (level === "warn" && urgency !== "danger") urgency = "warn";
  };

  if (state.temperature !== null && state.temperature !== undefined) {
    confidenceTotal++;
    const t = computeTrend(history.temperature);
    trends.temperature = t;

    const anomaly = detectAnomaly(history.temperature, state.temperature);
    if (anomaly.isAnomaly) {
      anomalies.temperature = anomaly;
      recos.push(`⚠ Anomalie détectée sur la température (${state.temperature}°C, très inhabituelle par rapport à la moyenne récente de ${anomaly.mean}°C)`);
      bump("warn");
    }

    const pred = predict(history.temperature);
    if (pred) {
      predictions.temperature = pred;
      if (pred.value > THRESHOLDS.temp.high && state.temperature <= THRESHOLDS.temp.high) {
        recos.push(`Prévision : la température devrait atteindre ${pred.value}°C dans ${pred.minutesAhead} min — anticiper la climatisation`);
      }
    }

    if (state.temperature > THRESHOLDS.temp.critical) {
      recos.push(`Température critique (${state.temperature}°C) : activer la climatisation immédiatement`);
      bump("danger");
    } else if (state.temperature > THRESHOLDS.temp.high) {
      recos.push(t.direction === "hausse"
        ? `Température élevée et en hausse (+${Math.abs(t.delta)}°C) : climatisation recommandée`
        : `Température élevée (${state.temperature}°C) : envisager la climatisation`);
      bump("warn");
    } else if (state.temperature < THRESHOLDS.temp.low) {
      recos.push(`Température basse (${state.temperature}°C) : vérifier le chauffage`);
      bump("warn");
    } else if (!anomaly.isAnomaly) {
      recos.push("Température idéale maintenue");
      confidencePoints++;
    }
  }

  if (state.humidity !== null && state.humidity !== undefined) {
    confidenceTotal++;
    const t = computeTrend(history.humidity);
    trends.humidity = t;
    if (state.humidity > THRESHOLDS.hum.critical) {
      recos.push(`Humidité très élevée (${state.humidity}%) : ventilation fortement recommandée`);
      bump("warn");
    } else if (state.humidity > THRESHOLDS.hum.high) {
      recos.push("Activer la ventilation pour réduire l'humidité");
    } else if (state.humidity < THRESHOLDS.hum.low) {
      recos.push("Air sec : humidité à surveiller");
    } else {
      confidencePoints++;
    }
  }

  if (state.light !== null && state.light !== undefined) {
    confidenceTotal++;
    if (state.light > THRESHOLDS.light.high) {
      recos.push("Forte luminosité détectée : penser à baisser les volets");
    } else if (state.light < THRESHOLDS.light.low && !state.relayState) {
      recos.push("Faible luminosité : allumer la lumière du salon");
    } else {
      confidencePoints++;
    }
  }

  if (state.gas !== null && state.gas !== undefined) {
    confidenceTotal++;
    const anomaly = detectAnomaly(history.gas, state.gas);
    if (anomaly.isAnomaly && !state.gasAlert) {
      anomalies.gas = anomaly;
      recos.push(`⚠ Anomalie détectée sur la qualité de l'air (valeur inhabituelle par rapport à la moyenne récente)`);
      bump("warn");
    }

    if (state.gasAlert || state.gas > THRESHOLDS.gas.danger) {
      recos.push("⚠ Fuite de gaz détectée : alarme activée automatiquement, aérez la pièce immédiatement");
      bump("danger");
    } else if (state.gas > THRESHOLDS.gas.warn) {
      recos.push("Qualité de l'air modérée : aérer la pièce");
      bump("warn");
    } else if (!anomaly.isAnomaly) {
      confidencePoints++;
    }
  }

  if (state.presence && state.doorLocked === false) {
    recos.push("Présence détectée porte déverrouillée : vérifier la sécurité");
    bump("warn");
  }
  if (!state.presence && state.relayState) {
    recos.push("Aucune présence détectée : éteindre la lumière pour économiser l'énergie");
  }

  const scenario = urgency === "danger" ? "Alerte sécurité"
    : urgency === "warn" ? "Régulation active"
    : "Confort optimal";

  // confiance : proportion de métriques "dans la norme", ramenée entre 40 et 98%
  const confidence = confidenceTotal > 0
    ? Math.min(98, Math.round((confidencePoints / confidenceTotal) * 58 + 40))
    : 50;

  return {
    recommendations: recos.slice(0, 4),
    scenario,
    urgency,
    confidence,
    trends,
    anomalies,
    predictions,
    computedAt: Date.now(),
  };
}

module.exports = { analyze, pushHistory };