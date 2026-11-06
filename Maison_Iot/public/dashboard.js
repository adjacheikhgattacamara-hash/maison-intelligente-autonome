// ==================================================================
// DASHBOARD — logique côté navigateur
// ==================================================================
const socket = io();

// ---------------- DÉCONNEXION ----------------
document.getElementById("logoutBtn").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  window.location.href = "/login.html";
});

// si la session a expiré, Socket.IO refusera la connexion : on renvoie vers /login.html
socket.on("connect_error", (err) => {
  if (err.message === "unauthorized") {
    window.location.href = "/login.html";
  }
});

// ---------------- HORLOGE + DATE PIED DE PAGE ----------------
function formatFooterDate(d) {
  const jours = ["dimanche","lundi","mardi","mercredi","jeudi","vendredi","samedi"];
  const mois = ["janvier","février","mars","avril","mai","juin","juillet","août","septembre","octobre","novembre","décembre"];
  return `${jours[d.getDay()]} ${d.getDate()} ${mois[d.getMonth()]} ${d.getFullYear()} — ${d.toLocaleTimeString("fr-FR")}`;
}
setInterval(() => {
  const now = new Date();
  document.getElementById("clock").textContent = now.toLocaleTimeString("fr-FR");
  document.getElementById("footerDate").textContent = formatFooterDate(now);
}, 1000);

// ---------------- STATUT DE CONNEXION ----------------
const connStatus = document.getElementById("connStatus");
socket.on("connect", () => { connStatus.textContent = "En ligne"; });
socket.on("disconnect", () => { connStatus.textContent = "Déconnecté"; });

// ---------------- NOTIFICATIONS NAVIGATEUR ----------------
// Utile quand le dashboard est en arrière-plan (autre onglet, mobile verrouillé).
if ("Notification" in window && Notification.permission === "default") {
  Notification.requestPermission();
}
function notify(title, body) {
  if ("Notification" in window && Notification.permission === "granted") {
    new Notification(title, { body, icon: "/logo.png" });
  }
}

// ==================================================================
// BARRE LATÉRALE — mode focus (affiche uniquement le(s) widget(s) ciblé(s)
// en plein écran, masque le reste). "Accueil" revient à la vue complète.
// ==================================================================
function applyFocus(focusValue) {
  const showAll = !focusValue || focusValue === "all";
  const ids = showAll ? null : focusValue.split(",");

  document.querySelectorAll(".card[id]").forEach((card) => {
    const visible = showAll || ids.includes(card.id);
    card.classList.toggle("card-hidden", !visible);
  });

  document.querySelectorAll(".dash-row").forEach((row) => {
    const hasVisibleCard = [...row.querySelectorAll(".card[id]")]
      .some((c) => !c.classList.contains("card-hidden"));
    row.classList.toggle("row-hidden", !hasVisibleCard);
  });
}

// Seuls les boutons avec un data-focus pilotent le mode focus (vue plein écran d'un
// ou plusieurs widgets). "Journal complet" et "Caméra" ouvrent chacun leur propre
// modale et gèrent leur propre écouteur plus bas, donc ils sont volontairement
// exclus de cette boucle.
document.querySelectorAll(".side-btn[data-focus]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".side-btn[data-focus]").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    applyFocus(btn.dataset.focus);
  });
});

// ==================================================================
// JAUGES (température / humidité / luminosité / gaz)
// ==================================================================
function makeGauge(canvasId, color, max) {
  const ctx = document.getElementById(canvasId).getContext("2d");
  return new Chart(ctx, {
    type: "doughnut",
    data: {
      datasets: [{
        data: [0, max],
        backgroundColor: [color, "#1C2745"],
        borderWidth: 0,
      }],
    },
    options: {
      circumference: 180,
      rotation: -90,
      cutout: "78%",
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      animation: { duration: 400 },
      responsive: true,
      maintainAspectRatio: false,
    },
  });
}

const gaugeTemp = makeGauge("gaugeTemp", "#22D3EE", 80); // -20..60 => span 80
const gaugeHum = makeGauge("gaugeHum", "#22D3EE", 100);
const gaugeLight = makeGauge("gaugeLight", "#F5A524", 1000);
const gaugeGas = makeGauge("gaugeGas", "#34D399", 1000);

function updateGauge(chart, value, max, min = 0) {
  const v = Math.max(min, Math.min(max, value)) - min;
  const span = max - min;
  chart.data.datasets[0].data = [v, span - v];
  chart.update();
}

function updateGaugeColor(chart, color) {
  chart.data.datasets[0].backgroundColor = [color, "#1C2745"];
}

// ==================================================================
// MINI SPARKLINES (sous les jauges température / humidité / luminosité)
// ==================================================================
function makeMiniChart(canvasId, color) {
  const ctx = document.getElementById(canvasId).getContext("2d");
  return new Chart(ctx, {
    type: "line",
    data: {
      labels: [],
      datasets: [{
        data: [],
        borderColor: color,
        backgroundColor: color + "22",
        fill: true,
        tension: 0.35,
        pointRadius: 0,
        borderWidth: 1.5,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: { x: { display: false }, y: { display: false } },
      animation: false,
    },
  });
}
const miniTemp = makeMiniChart("chartTempMini", "#22D3EE");
const miniHum = makeMiniChart("chartHumMini", "#22D3EE");
const miniLight = makeMiniChart("chartLightMini", "#F5A524");

function pushMini(chart, value, maxPoints = 24) {
  chart.data.labels.push("");
  chart.data.datasets[0].data.push(value);
  if (chart.data.labels.length > maxPoints) {
    chart.data.labels.shift();
    chart.data.datasets[0].data.shift();
  }
  chart.update();
}

// ==================================================================
// GRAPHIQUES HISTORIQUES (température / humidité, grands, rangée 3)
// ==================================================================
function makeLineChart(canvasId, color) {
  const ctx = document.getElementById(canvasId).getContext("2d");
  return new Chart(ctx, {
    type: "line",
    data: {
      labels: [],
      datasets: [{
        data: [],
        borderColor: color,
        backgroundColor: color + "22",
        fill: true,
        tension: 0.35,
        pointRadius: 0,
        borderWidth: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: "#92A0C0", maxTicksLimit: 5, font: { size: 9 } }, grid: { display: false } },
        y: { ticks: { color: "#92A0C0", font: { size: 9 } }, grid: { color: "rgba(255,255,255,0.05)" } },
      },
      animation: false,
    },
  });
}

const chartTemp = makeLineChart("chartTemp", "#22D3EE");
const chartHum = makeLineChart("chartHum", "#F5A524");

function pushPoint(chart, value, maxPoints = 30) {
  const label = new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  chart.data.labels.push(label);
  chart.data.datasets[0].data.push(value);
  if (chart.data.labels.length > maxPoints) {
    chart.data.labels.shift();
    chart.data.datasets[0].data.shift();
  }
  chart.update();
}

async function loadInitialHistory() {
  try {
    const [temps, hums] = await Promise.all([
      fetch("/api/history?metric=temperature&hours=1").then((r) => r.json()),
      fetch("/api/history?metric=humidity&hours=1").then((r) => r.json()),
    ]);
    temps.forEach((row) => pushPoint(chartTemp, row.value));
    hums.forEach((row) => pushPoint(chartHum, row.value));
  } catch (e) {
    console.warn("Historique indisponible pour le moment", e);
  }
}
loadInitialHistory();

// ==================================================================
// ANALYSE D'HABITUDES (répartition horaire des présences)
// ==================================================================
const chartHabits = new Chart(document.getElementById("chartHabits").getContext("2d"), {
  type: "bar",
  data: {
    labels: Array.from({ length: 24 }, (_, h) => h),
    datasets: [{ data: new Array(24).fill(0), backgroundColor: "#22D3EE" }],
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { ticks: { color: "#92A0C0", maxTicksLimit: 8, font: { size: 9 } }, grid: { display: false } },
      y: { ticks: { color: "#92A0C0", font: { size: 9 } }, grid: { color: "rgba(255,255,255,0.05)" } },
    },
  },
});

async function loadHabits() {
  try {
    const counts = await fetch("/api/habits").then((r) => r.json());
    chartHabits.data.datasets[0].data = counts;
    chartHabits.update();

    // détermine la plage d'heures la plus active (fenêtre de 4h)
    let bestStart = 0, bestSum = -1;
    for (let h = 0; h < 24; h++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += counts[(h + k) % 24];
      if (sum > bestSum) { bestSum = sum; bestStart = h; }
    }
    const bestEnd = (bestStart + 4) % 24;
    const label = bestSum > 0
      ? `${String(bestStart).padStart(2, "0")}h - ${String(bestEnd).padStart(2, "0")}h`
      : "--h - --h";
    document.getElementById("habitsRange").textContent = label;
  } catch (e) {
    console.warn("Analyse d'habitudes indisponible", e);
  }
}
loadHabits();
setInterval(loadHabits, 60000);

// ==================================================================
// JOURNAL DES ÉVÉNEMENTS
// ==================================================================
const journalList = document.getElementById("journalList");
const journalEntries = [];

function addJournalEntry(icon, text, severity = "normal") {
  const time = new Date().toLocaleTimeString("fr-FR");
  journalEntries.unshift({ icon, text, severity, time });
  if (journalEntries.length > 8) journalEntries.pop();
  renderJournal();
}

function renderJournal() {
  if (journalEntries.length === 0) {
    journalList.innerHTML = `<li class="journal-empty">Aucun événement pour le moment</li>`;
    return;
  }
  journalList.innerHTML = journalEntries.map((e) => `
    <li>
      <span class="j-icon">${e.icon}</span>
      <span class="j-time">${e.time}</span>
      <span class="j-text ${e.severity !== "normal" ? e.severity : ""}">${e.text}</span>
    </li>
  `).join("");
}

// ==================================================================
// JOURNAL COMPLET (modale) — historique persistant lu depuis SQLite,
// à la différence du widget ci-dessus qui ne garde que les 8 dernières
// entrées en mémoire et se réinitialise au rechargement de la page.
// ==================================================================
const journalModalOverlay = document.getElementById("journalModalOverlay");
const eventsTableBody = document.getElementById("eventsTableBody");
const eventsCountEl = document.getElementById("eventsCount");
const loadMoreEventsBtn = document.getElementById("loadMoreEventsBtn");
const clearAllEventsBtn = document.getElementById("clearAllEventsBtn");

const EVENTS_PAGE_SIZE = 50;
let eventsOffset = 0;
let eventsTotal = 0;
let eventsLoadedRows = [];

// Traduit chaque type d'événement stocké en base en icône + libellé lisible,
// en reprenant la même logique que le widget journal léger côté client.
const EVENT_META = {
  rfid: (p) => ({
    icon: p.granted ? "🔓" : "⛔",
    label: `Accès ${p.granted ? "autorisé" : "refusé"} (RFID${p.uid ? " · " + p.uid : ""})`,
    severity: p.granted ? "normal" : "warn",
  }),
  gaz: (p) => ({
    icon: p.alert ? "⚠️" : "💨",
    label: p.alert ? "Fuite de gaz détectée (MQ2)" : `Qualité de l'air mesurée (${p.gasPercent ?? "--"} PPM)`,
    severity: p.alert ? "danger" : "normal",
  }),
  presence: () => ({ icon: "🏃", label: "Mouvement détecté (IR)", severity: "normal" }),
  securite: (p) => ({
    icon: p.doorLocked ? "🔒" : "🔓",
    label: `Porte ${p.doorLocked ? "verrouillée" : "déverrouillée"}${p.alarmActive ? " · alarme active" : ""}`,
    severity: p.alarmActive ? "danger" : "normal",
  }),
};

function formatEventRow(row) {
  let payload = {};
  try { payload = JSON.parse(row.payload); } catch { /* payload illisible, on garde les valeurs par défaut */ }
  const meta = EVENT_META[row.type] ? EVENT_META[row.type](payload) : { icon: "•", label: row.type, severity: "normal" };
  return { id: row.id, ts: row.ts, ...meta };
}

function renderEventsTable() {
  if (eventsLoadedRows.length === 0) {
    eventsTableBody.innerHTML = `<tr><td colspan="4" class="events-empty">Aucun événement enregistré</td></tr>`;
    eventsCountEl.textContent = "";
    loadMoreEventsBtn.disabled = true;
    return;
  }
  eventsTableBody.innerHTML = eventsLoadedRows.map((e) => `
    <tr data-id="${e.id}">
      <td class="ev-time">${new Date(e.ts).toLocaleString("fr-FR")}</td>
      <td class="ev-icon">${e.icon}</td>
      <td class="ev-detail ${e.severity !== "normal" ? e.severity : ""}">${e.label}</td>
      <td><button class="ev-delete-btn" data-id="${e.id}" title="Supprimer cet événement">🗑</button></td>
    </tr>
  `).join("");
  eventsCountEl.textContent = `${eventsLoadedRows.length} / ${eventsTotal} événement(s)`;
  loadMoreEventsBtn.disabled = eventsLoadedRows.length >= eventsTotal;
}

async function loadEventsPage(reset) {
  if (reset) { eventsOffset = 0; eventsLoadedRows = []; }
  try {
    const res = await fetch(`/api/events?limit=${EVENTS_PAGE_SIZE}&offset=${eventsOffset}`);
    const data = await res.json();
    eventsTotal = data.total;
    eventsLoadedRows.push(...data.rows.map(formatEventRow));
    eventsOffset += data.rows.length;
    renderEventsTable();
  } catch (e) {
    eventsTableBody.innerHTML = `<tr><td colspan="4" class="events-empty">Erreur de chargement du journal</td></tr>`;
  }
}

function openJournalModal() {
  journalModalOverlay.classList.add("open");
  loadEventsPage(true);
}
function closeJournalModal() {
  journalModalOverlay.classList.remove("open");
}

document.getElementById("journalNavBtn").addEventListener("click", openJournalModal);
document.getElementById("closeJournalModal").addEventListener("click", closeJournalModal);
journalModalOverlay.addEventListener("click", (e) => {
  if (e.target === journalModalOverlay) closeJournalModal();
});
loadMoreEventsBtn.addEventListener("click", () => loadEventsPage(false));

// Suppression unitaire : optimiste côté UI (retire la ligne immédiatement),
// pas de rechargement complet de la page nécessaire.
eventsTableBody.addEventListener("click", async (e) => {
  const btn = e.target.closest(".ev-delete-btn");
  if (!btn) return;
  const id = btn.dataset.id;
  btn.disabled = true;
  try {
    const res = await fetch(`/api/events/${id}`, { method: "DELETE" });
    if (!res.ok) throw new Error("delete failed");
    eventsLoadedRows = eventsLoadedRows.filter((r) => String(r.id) !== String(id));
    eventsTotal = Math.max(0, eventsTotal - 1);
    eventsOffset = Math.max(0, eventsOffset - 1);
    renderEventsTable();
  } catch {
    btn.disabled = false;
  }
});

// Vidage complet du journal (libère l'espace occupé par l'historique en base).
clearAllEventsBtn.addEventListener("click", async () => {
  if (!confirm("Supprimer définitivement tous les événements du journal ? Cette action est irréversible.")) return;
  clearAllEventsBtn.disabled = true;
  try {
    const res = await fetch("/api/events", { method: "DELETE" });
    if (!res.ok) throw new Error("clear failed");
    eventsLoadedRows = [];
    eventsTotal = 0;
    eventsOffset = 0;
    renderEventsTable();
  } finally {
    clearAllEventsBtn.disabled = false;
  }
});

// ==================================================================
// CAMÉRA — vue gros plan (modale), pour compléter la vignette réduite
// affichée dans la grille principale.
// ==================================================================
const cameraModalOverlay = document.getElementById("cameraModalOverlay");
const cameraModalBody = document.getElementById("cameraModalBody");
let lastKnownState = null;

function renderCameraModal() {
  // Comme pour la vignette réduite, on passe par le proxy /api/camera-stream
  // plutôt que par l'URL brute de l'ESP32 : ça fonctionne aussi bien en local
  // qu'à travers le tunnel ngrok (pas de contenu mixte HTTPS→HTTP).
  if (lastKnownState && lastKnownState.camera && lastKnownState.camera.online) {
    cameraModalBody.replaceChildren();
    const img = document.createElement("img");
    img.src = "/api/camera-stream";
    img.alt = "Flux caméra entrée (plein écran)";
    cameraModalBody.appendChild(img);
    return;
  }
  cameraModalBody.innerHTML = `<p class="camera-modal-placeholder">Caméra hors ligne</p>`;
}

function openCameraModal() {
  cameraModalOverlay.classList.add("open");
  renderCameraModal();
}
function closeCameraModal() {
  cameraModalOverlay.classList.remove("open");
}

document.getElementById("expandCameraBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  openCameraModal();
});
document.getElementById("cameraBody").addEventListener("click", openCameraModal);
document.getElementById("cameraNavBtn").addEventListener("click", openCameraModal);
document.getElementById("closeCameraModal").addEventListener("click", closeCameraModal);
cameraModalOverlay.addEventListener("click", (e) => {
  if (e.target === cameraModalOverlay) closeCameraModal();
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  closeJournalModal();
  closeCameraModal();
});

// ==================================================================
// RECOMMANDATIONS IA — calculées par le moteur IA local côté serveur
// (analyse de tendances sur l'historique + niveau de confiance réel,
// aucune clé API, 100% local)
// ==================================================================
const aiRecoList = document.getElementById("aiRecoList");
const aiScenario = document.getElementById("aiScenario");
const aiStateLabel = document.querySelector(".ai-state");
const aiConfidenceEl = document.getElementById("aiConfidence");
const aiTrendEl = document.getElementById("aiTrend");

const TREND_ICONS = { hausse: "↗", baisse: "↘", stable: "→" };
let lastUrgency = "normal";

function renderAiInsights(insights) {
  const { recommendations, scenario, urgency, confidence, trends } = insights;

  aiRecoList.innerHTML = recommendations.length
    ? recommendations.map((r) => `<li>${r}</li>`).join("")
    : "<li>Aucune action recommandée</li>";

  aiScenario.textContent = scenario;

  if (aiStateLabel) {
    aiStateLabel.textContent = urgency === "danger" ? "Alerte active"
      : urgency === "warn" ? "Surveillance renforcée"
      : "Système opérationnel";
  }

  if (aiConfidenceEl) aiConfidenceEl.textContent = `${confidence}%`;

  if (aiTrendEl) {
    const parts = Object.entries(trends || {}).map(([metric, t]) => {
      const label = metric === "temperature" ? "Température" : metric === "humidity" ? "Humidité" : metric;
      return `${label} ${TREND_ICONS[t.direction] || "→"}`;
    });
    aiTrendEl.textContent = parts.length ? parts.join(" · ") : "Stable";
  }

  if (urgency === "danger" && lastUrgency !== "danger") {
    notify("Maison Intelligente — Alerte", recommendations[0] || "Une situation nécessite ton attention.");
  }
  lastUrgency = urgency;
}

socket.on("aiInsights", renderAiInsights);

document.getElementById("aiDetailsBtn").addEventListener("click", () => {
  document.getElementById("aiDetails").classList.toggle("open");
});

// ==================================================================
// AUTOMATISATIONS — cliquables (Actif / Inactif), gérées côté client
// ==================================================================
document.querySelectorAll("#automationsList li").forEach((li) => {
  li.addEventListener("click", () => {
    const tag = li.querySelector("span:last-child");
    const isActive = tag.textContent.trim() === "Actif";
    tag.textContent = isActive ? "Inactif" : "Actif";
    tag.className = isActive ? "tag-off" : "tag-on";
  });
});
document.getElementById("manageBtn").addEventListener("click", () => {
  const tags = document.querySelectorAll("#automationsList li span:last-child");
  const allActive = [...tags].every((tag) => tag.textContent.trim() === "Actif");
  tags.forEach((tag) => {
    tag.textContent = allActive ? "Inactif" : "Actif";
    tag.className = allActive ? "tag-off" : "tag-on";
  });
  document.getElementById("manageBtn").textContent = allActive
    ? "Tout réactiver"
    : "Tout désactiver";
});

// ==================================================================
// MISE À JOUR DE L'INTERFACE À CHAQUE ÉTAT REÇU
// ==================================================================
let lastTempPush = 0;
let previousState = null;

socket.on("state", (state) => {
  lastKnownState = state;
  if (cameraModalOverlay.classList.contains("open")) renderCameraModal();

  // ---- jauges ----
  if (state.temperature !== null) {
    document.getElementById("valTemp").innerHTML = `${state.temperature}<small>°C</small>`;
    updateGauge(gaugeTemp, state.temperature, 60, -20);
  }
  if (state.humidity !== null) {
    document.getElementById("valHum").innerHTML = `${state.humidity}<small>%</small>`;
    updateGauge(gaugeHum, state.humidity, 100);
  }
  if (state.light !== null) {
    document.getElementById("valLight").innerHTML = `${state.light}<small>lux</small>`;
    updateGauge(gaugeLight, state.light * 10, 1000); // capteur en % converti en lux approx.
  }
  if (state.gas !== null) {
    document.getElementById("valGas").innerHTML = `${state.gas}<small>PPM</small>`;
    updateGauge(gaugeGas, state.gas, 1000);
    const gasTag = document.getElementById("gasTag");
    if (state.gas > 700 || state.gasAlert) {
      updateGaugeColor(gaugeGas, "#F87171");
      gasTag.textContent = "Air pollué"; gasTag.className = "gas-tag danger";
    } else if (state.gas > 300) {
      updateGaugeColor(gaugeGas, "#F5A524");
      gasTag.textContent = "Air modéré"; gasTag.className = "gas-tag warn";
    } else {
      updateGaugeColor(gaugeGas, "#34D399");
      gasTag.textContent = "Air normal"; gasTag.className = "gas-tag ok";
    }
    gaugeGas.update();
  }

  // ---- mini sparklines + historiques (max une fois toutes les 4s) ----
  const now = Date.now();
  if (now - lastTempPush > 4000) {
    lastTempPush = now;
    if (state.temperature !== null) { pushPoint(chartTemp, state.temperature); pushMini(miniTemp, state.temperature); }
    if (state.humidity !== null) { pushPoint(chartHum, state.humidity); pushMini(miniHum, state.humidity); }
    if (state.light !== null) pushMini(miniLight, state.light);
  }

  // ---- mouvement ----
  const motionBody = document.querySelector(".motion-card .motion-body");
  const motionLabel = document.getElementById("motionLabel");
  const motionTime = document.getElementById("motionTime");
  if (state.presence) {
    motionBody.classList.add("active");
    motionLabel.textContent = "Mouvement détecté";
    motionTime.textContent = `Dernière détection : ${new Date().toLocaleTimeString("fr-FR")}`;
  } else {
    motionBody.classList.remove("active");
    motionLabel.textContent = "Aucun mouvement";
  }
  if (previousState && !previousState.presence && state.presence) {
    addJournalEntry("🏃", "Mouvement détecté (IR)");
  }

  // ---- RFID ----
  const rfidBody = document.getElementById("rfidBody");
  const rfidUidEl = document.getElementById("rfidUid");
  const rfidTimeEl = document.getElementById("rfidTime");
  const rfidStatusEl = rfidBody.querySelector(".rfid-status");
  if (state.rfid && state.rfid.uid && state.rfid.uid !== "—") {
    rfidBody.classList.remove("granted", "denied");
    rfidBody.classList.add(state.rfid.granted ? "granted" : "denied");
    rfidStatusEl.textContent = state.rfid.granted ? "Accès autorisé" : "Accès refusé";
    rfidUidEl.textContent = `Badge ${state.rfid.uid}`;
    if (state.rfid.time) rfidTimeEl.textContent = `Heure : ${new Date(state.rfid.time).toLocaleTimeString("fr-FR")}`;
  }
  if (previousState && previousState.rfid && state.rfid && previousState.rfid.time !== state.rfid.time && state.rfid.uid !== "—") {
    addJournalEntry(state.rfid.granted ? "🔓" : "⛔", `Accès ${state.rfid.granted ? "autorisé" : "refusé"} (RFID)`, state.rfid.granted ? "normal" : "warn");
  }

  // ---- caméra ----
  // Le flux passe par un proxy sur notre propre serveur (/api/camera-stream)
  // au lieu de pointer directement sur l'IP locale de l'ESP32 : ça marche
  // aussi bien en local qu'à travers le tunnel ngrok (même origine, pas de
  // contenu mixte, le client final n'a jamais besoin de connaître l'IP
  // locale de la caméra).
  const cameraBody = document.getElementById("cameraBody");
  if (state.camera && state.camera.online) {
    let img = cameraBody.querySelector("img");
    if (!img) {
      cameraBody.replaceChildren();
      img = document.createElement("img");
      img.alt = "Flux caméra entrée";
      cameraBody.appendChild(img);
    }
    if (!img.src.endsWith("/api/camera-stream")) {
      img.src = "/api/camera-stream";
    }
  } else if (!cameraBody.querySelector("p")) {
    cameraBody.innerHTML = `
      <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2" y="7" width="15" height="10" rx="2"/><path d="M17 10l5-3v10l-5-3"/></svg>
      <p>Caméra hors ligne</p>`;
  }

  // ---- assistant vocal ----
  if (state.voice && state.voice.lastAction) {
    document.getElementById("voiceStatus").textContent = state.voice.lastAction;
  }

  // ---- statut sécurité gaz + alerte flottante ----
  const alertBox = document.getElementById("alertBox");
  const alertTitle = document.getElementById("alertTitle");
  const alertDetail = document.getElementById("alertDetail");
  const footerMsg = document.getElementById("footerMsg");
  if (state.gasAlert) {
    alertBox.classList.add("active");
    alertTitle.textContent = "Fuite de gaz détectée";
    alertDetail.textContent = "Alarme activée automatiquement — aérez la pièce immédiatement.";
    footerMsg.textContent = "Alerte gaz en cours — vérifiez la cuisine";
    footerMsg.className = "danger";
  } else if (state.alarmActive) {
    alertBox.classList.add("active");
    alertTitle.textContent = "Alerte en cours";
    alertDetail.textContent = "Mouvement détecté alors que la porte est verrouillée.";
    footerMsg.textContent = "Alarme active";
    footerMsg.className = "warn";
  } else {
    alertBox.classList.remove("active");
    alertTitle.textContent = "Aucune alerte";
    alertDetail.textContent = "Tout est calme à la maison.";
    footerMsg.textContent = "Tous les systèmes fonctionnent normalement";
    footerMsg.className = "";
  }
  if (previousState && !previousState.gasAlert && state.gasAlert) {
    addJournalEntry("⚠️", "Fuite de gaz détectée (MQ2)", "danger");
  }

  // ---- interrupteurs (mise à jour silencieuse) + journal des changements ----
  document.getElementById("swLight").checked = !!state.relayState;
  document.getElementById("swClim").checked = !!state.climatisation;
  document.getElementById("swFan").checked = !!state.ventilateur;
  document.getElementById("swDoor").checked = !!state.doorLocked;
  document.getElementById("swAlarm").checked = !!state.alarmActive;

  if (previousState) {
    if (previousState.relayState !== state.relayState) addJournalEntry("💡", `Lumière ${state.relayState ? "allumée" : "éteinte"}`);
    if (previousState.climatisation !== state.climatisation) addJournalEntry("❄️", `Climatisation ${state.climatisation ? "activée" : "coupée"}`);
    if (previousState.ventilateur !== state.ventilateur) addJournalEntry("🌀", `Ventilation ${state.ventilateur ? "activée" : "désactivée"}`);
    if (previousState.doorLocked !== state.doorLocked) addJournalEntry("🔒", `Porte ${state.doorLocked ? "verrouillée" : "déverrouillée"}`);
    if (previousState.alarmActive !== state.alarmActive) addJournalEntry("🚨", `Alarme ${state.alarmActive ? "activée" : "désactivée"}`, state.alarmActive ? "danger" : "normal");
  }

  previousState = JSON.parse(JSON.stringify(state));
});

// ==================================================================
// INTERRUPTEURS — envoient une commande au serveur au changement
// ==================================================================
document.getElementById("swLight").addEventListener("change", (e) => {
  socket.emit("command", { method: "setRelayState", params: e.target.checked });
});
document.getElementById("swClim").addEventListener("change", (e) => {
  socket.emit("command", { method: "setClimatisation", params: e.target.checked });
});
document.getElementById("swFan").addEventListener("change", (e) => {
  socket.emit("command", { method: "setVentilateur", params: e.target.checked });
});
document.getElementById("swDoor").addEventListener("change", (e) => {
  socket.emit("command", { method: "setDoorLock", params: e.target.checked });
});
document.getElementById("swAlarm").addEventListener("change", (e) => {
  socket.emit("command", { method: "setAlarm", params: e.target.checked });
});

// ==================================================================
// ASSISTANT VOCAL — reconnaissance (Web Speech API) + compréhension
// locale (NLU côté serveur) + réponse parlée (synthèse vocale locale,
// aucune clé API, tout tourne dans le navigateur/serveur)
// ==================================================================
const voiceBtn = document.getElementById("voiceBtn");
const voiceStatus = document.getElementById("voiceStatus");
const waveform = document.getElementById("waveform");

// ---- Synthèse vocale (TTS) ----
const synth = window.speechSynthesis;
let frenchVoice = null;

function pickFrenchVoice() {
  if (!synth) return;
  const voices = synth.getVoices();
  frenchVoice = voices.find((v) => v.lang === "fr-FR") || voices.find((v) => v.lang && v.lang.startsWith("fr")) || null;
}
if (synth) {
  pickFrenchVoice();
  synth.addEventListener("voiceschanged", pickFrenchVoice);
}

function speak(text) {
  if (!synth || !text) return;
  synth.cancel(); // interrompt toute lecture en cours
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = "fr-FR";
  if (frenchVoice) utter.voice = frenchVoice;
  utter.rate = 1;
  utter.onstart = () => {
    voiceBtn.classList.add("speaking");
    waveform.classList.add("active");
  };
  utter.onend = () => {
    voiceBtn.classList.remove("speaking");
    waveform.classList.remove("active");
  };
  synth.speak(utter);
}

// ---- Reconnaissance vocale ----
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;

if (SpeechRecognition) {
  recognition = new SpeechRecognition();
  recognition.lang = "fr-FR";
  recognition.continuous = false;
  recognition.interimResults = false;

  recognition.onstart = () => {
    voiceBtn.classList.add("listening");
    waveform.classList.add("active");
    voiceStatus.textContent = "En écoute…";
  };
  recognition.onend = () => {
    voiceBtn.classList.remove("listening");
    if (!voiceBtn.classList.contains("speaking")) waveform.classList.remove("active");
  };
  recognition.onerror = () => {
    voiceStatus.textContent = "Erreur de reconnaissance, réessaie";
  };
  recognition.onresult = (event) => {
    const transcript = event.results[0][0].transcript;
    voiceStatus.textContent = `« ${transcript} »`;
    socket.emit("voiceCommand", transcript);
  };

  voiceBtn.addEventListener("click", () => {
    if (synth) synth.cancel();
    recognition.start();
  });
} else {
  voiceStatus.textContent = "Non supporté sur ce navigateur (utilise Chrome)";
  voiceBtn.disabled = true;
}

// ---- Réponse de l'assistant (comprise localement par le serveur) ----
socket.on("voiceResponse", ({ text, understood, actionsCount }) => {
  voiceStatus.textContent = text;
  speak(text);
  if (understood && actionsCount > 0) {
    addJournalEntry("🗣️", `Commande vocale exécutée : « ${text} »`);
  } else if (!understood) {
    addJournalEntry("🗣️", "Commande vocale non comprise", "warn");
  }
});