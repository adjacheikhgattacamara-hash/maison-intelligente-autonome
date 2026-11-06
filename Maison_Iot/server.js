// ==================================================================
// MAISON INTELLIGENTE AUTONOME — Serveur du dashboard
// (Version avec sqlite3 asynchrone, compatible Node 24)
// ==================================================================

const path = require("path");
const net = require("net");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const Aedes = require("aedes");
const mqtt = require("mqtt");
const sqlite3 = require('sqlite3').verbose();
const { promisify } = require('util');
const session = require("express-session");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const aiEngine = require("./ai-engine");
const nlu = require("./nlu");

// ---------------- CONFIGURATION ----------------
const HTTP_PORT = process.env.PORT || 3000;
const MQTT_PORT = process.env.MQTT_PORT || 1883;
const DEMO_MODE = process.env.DEMO_MODE !== "false";

// ---------------- AUTHENTIFICATION ----------------
const DASHBOARD_USERNAME = process.env.DASHBOARD_USERNAME || "admin";
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD;
const PASSWORD_HASH = bcrypt.hashSync(DASHBOARD_PASSWORD, 10);

// Identifiants MQTT partagés par tous les clients légitimes (serveur + ESP32/Arduino).
// Sans ça, le broker Aedes accepte n'importe quelle connexion : n'importe qui sur le
// réseau local pourrait publier de fausses données capteurs ou de fausses commandes.
const MQTT_USERNAME = process.env.MQTT_USERNAME;
const MQTT_PASSWORD = process.env.MQTT_PASSWORD;

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 12 },
});

// ---------------- BASE DE DONNÉES (sqlite3 asynchrone) ----------------
const db = new sqlite3.Database(path.join(__dirname, "maison.db"));
const dbRun = promisify(db.run.bind(db));
const dbAll = promisify(db.all.bind(db));

async function initDb() {
  await dbRun(`CREATE TABLE IF NOT EXISTS telemetry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    metric TEXT NOT NULL,
    value REAL NOT NULL,
    ts INTEGER NOT NULL
  )`);
  await dbRun(`CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    ts INTEGER NOT NULL
  )`);
}

// Recharge le dernier état connu depuis SQLite au démarrage. Sans ça, un redémarrage
// du serveur remettait tout à "null" jusqu'à la prochaine donnée MQTT reçue.
async function rehydrateState() {
  try {
    const lastByMetric = await dbAll(
      `SELECT metric, value FROM telemetry t
       WHERE id IN (SELECT MAX(id) FROM telemetry GROUP BY metric)`
    );
    for (const row of lastByMetric) {
      if (row.metric === "temperature") state.temperature = row.value;
      if (row.metric === "humidity") state.humidity = row.value;
      if (row.metric === "light") state.light = row.value;
      if (row.metric === "gas") state.gas = row.value;
    }

    const lastRfid = await dbAll(
      `SELECT payload, ts FROM events WHERE type = 'rfid' ORDER BY id DESC LIMIT 1`
    );
    if (lastRfid.length) {
      const p = JSON.parse(lastRfid[0].payload);
      state.rfid = { uid: p.uid, granted: p.granted, time: lastRfid[0].ts };
    }

    const lastSecurity = await dbAll(
      `SELECT payload FROM events WHERE type = 'securite' ORDER BY id DESC LIMIT 1`
    );
    if (lastSecurity.length) {
      const p = JSON.parse(lastSecurity[0].payload);
      if (typeof p.doorLocked === "boolean") state.doorLocked = p.doorLocked;
      if (typeof p.alarmActive === "boolean") state.alarmActive = p.alarmActive;
    }

    console.log("État rechargé depuis maison.db :", {
      temperature: state.temperature, humidity: state.humidity,
      light: state.light, gas: state.gas, doorLocked: state.doorLocked,
    });
  } catch (e) {
    console.error("Impossible de recharger l'état depuis la base :", e.message);
  }
}

initDb().then(rehydrateState).catch(console.error);

// ---------------- ÉTAT COURANT PARTAGÉ ----------------
const state = {
  temperature: null,
  humidity: null,
  light: null,
  gas: null,
  gasAlert: false,
  relayState: false,
  doorLocked: true,
  alarmActive: false,
  presence: false,
  climatisation: false,
  ventilateur: false,
  rfid: { uid: "—", granted: null, time: null },
  camera: { streamUrl: null, online: false },
  voice: { listening: false, lastCommand: null },
};

// ---------------- BROKER MQTT EMBARQUÉ (aedes) ----------------
const aedes = new Aedes();

// Authentification : sans ce handler, Aedes accepte toute connexion anonyme.
aedes.authenticate = (client, username, password, callback) => {
  const pass = password ? password.toString() : "";
  const ok = username === MQTT_USERNAME && pass === MQTT_PASSWORD;
  if (!ok) console.warn(`Connexion MQTT refusée pour client "${client.id}" (identifiants invalides)`);
  callback(null, ok);
};

// Autorisation : on limite les clients au namespace "maison/#" pour éviter tout usage
// détourné du broker une fois authentifié.
aedes.authorizePublish = (client, packet, callback) => {
  callback(packet.topic.startsWith("maison/") ? null : new Error("Topic non autorisé"));
};
aedes.authorizeSubscribe = (client, sub, callback) => {
  callback(null, sub.topic.startsWith("maison/") ? sub : false);
};

const mqttServer = net.createServer(aedes.handle);
mqttServer.listen(MQTT_PORT, () => {
  console.log(`Broker MQTT embarqué (authentifié) en écoute sur le port ${MQTT_PORT}`);
});

aedes.on("client", (client) => console.log("Device connecté :", client.id));
aedes.on("clientDisconnect", (client) => console.log("Device déconnecté :", client.id));

// ---------------- CLIENT MQTT INTERNE ----------------
const appClient = mqtt.connect(`mqtt://localhost:${MQTT_PORT}`, {
  clientId: "dashboard-server",
  username: MQTT_USERNAME,
  password: MQTT_PASSWORD,
});

appClient.on("connect", () => {
  console.log("Serveur connecté au broker interne");
  appClient.subscribe("maison/#");
});

appClient.on("message", async (topic, payloadBuf) => {
  let payload;
  try {
    payload = JSON.parse(payloadBuf.toString());
  } catch {
    return;
  }
  const now = Date.now();

  switch (topic) {
    case "maison/environnement": {
      if (typeof payload.temperature === "number") {
        state.temperature = payload.temperature;
        await dbRun("INSERT INTO telemetry (metric, value, ts) VALUES (?, ?, ?)", 
                    ["temperature", payload.temperature, now]);
      }
      if (typeof payload.humidity === "number") {
        state.humidity = payload.humidity;
        await dbRun("INSERT INTO telemetry (metric, value, ts) VALUES (?, ?, ?)",
                    ["humidity", payload.humidity, now]);
      }
      if (typeof payload.light === "number") {
        state.light = payload.light;
        await dbRun("INSERT INTO telemetry (metric, value, ts) VALUES (?, ?, ?)",
                    ["light", payload.light, now]);
      }
      if (typeof payload.gas === "number") {
        state.gas = payload.gas;
        await dbRun("INSERT INTO telemetry (metric, value, ts) VALUES (?, ?, ?)",
                    ["gas", payload.gas, now]);
      }
      if (typeof payload.gasAlert === "boolean") state.gasAlert = payload.gasAlert;
      if (typeof payload.relayState === "boolean") state.relayState = payload.relayState;
      if (typeof payload.ventilateurState === "boolean") state.ventilateur = payload.ventilateurState;

      if (typeof payload.temperature === "number") aiEngine.pushHistory("temperature", payload.temperature);
      if (typeof payload.humidity === "number") aiEngine.pushHistory("humidity", payload.humidity);
      if (typeof payload.light === "number") aiEngine.pushHistory("light", payload.light);
      if (typeof payload.gas === "number") aiEngine.pushHistory("gas", payload.gas);

      io.emit("state", state);
      io.emit("aiInsights", aiEngine.analyze(state));
      break;
    }
    case "maison/securite": {
      const securityChanged =
        (typeof payload.doorLocked === "boolean" && payload.doorLocked !== state.doorLocked) ||
        (typeof payload.alarmActive === "boolean" && payload.alarmActive !== state.alarmActive);

      if (typeof payload.doorLocked === "boolean") state.doorLocked = payload.doorLocked;
      if (typeof payload.alarmActive === "boolean") state.alarmActive = payload.alarmActive;

      if (securityChanged) {
        await dbRun("INSERT INTO events (type, payload, ts) VALUES (?, ?, ?)",
                    ["securite", JSON.stringify({ doorLocked: state.doorLocked, alarmActive: state.alarmActive }), now]);
      }

      if (typeof payload.presence === "boolean") {
        if (payload.presence && !state.presence) {
          await dbRun("INSERT INTO events (type, payload, ts) VALUES (?, ?, ?)",
                      ["presence", JSON.stringify({ presence: true }), now]);
        }
        state.presence = payload.presence;
      }
      io.emit("state", state);
      break;
    }
    case "maison/evenement/rfid": {
      state.rfid = { uid: payload.uid, granted: payload.granted, time: now };
      await dbRun("INSERT INTO events (type, payload, ts) VALUES (?, ?, ?)",
                  ["rfid", JSON.stringify(payload), now]);
      io.emit("state", state);
      io.emit("event", { type: "rfid", ...payload, ts: now });
      break;
    }
    case "maison/evenement/gaz": {
      state.gasAlert = !!payload.alert;
      if (typeof payload.gasPercent === "number") state.gas = payload.gasPercent;
      await dbRun("INSERT INTO events (type, payload, ts) VALUES (?, ?, ?)",
                  ["gaz", JSON.stringify(payload), now]);
      io.emit("state", state);
      io.emit("event", { type: "gaz", ...payload, ts: now });
      break;
    }
    case "maison/evenement/presence": {
      state.presence = !!payload.presence;
      io.emit("state", state);
      break;
    }
    case "maison/camera": {
      state.camera = { streamUrl: payload.streamUrl, online: !!payload.cameraOnline };
      io.emit("state", state);
      break;
    }
    default:
      break;
  }
});

// ---------------- ENVOI DE COMMANDES ----------------
function sendCommand(method, params) {
  appClient.publish("maison/commande", JSON.stringify({ method, params }));
}

// ---------------- SERVEUR WEB + SOCKET.IO ----------------
const app = express();
app.use(sessionMiddleware);
app.use(express.json());

app.get("/login.html", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

// Limite les tentatives de connexion : sans ça, un mot de passe pouvait être
// bruteforcé sans aucune contrainte, surtout dangereux une fois exposé via ngrok.
const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Trop de tentatives, réessaie dans quelques minutes." },
});

app.post("/api/login", loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  const validUser = username === DASHBOARD_USERNAME;
  const validPass = typeof password === "string" && bcrypt.compareSync(password, PASSWORD_HASH);
  if (validUser && validPass) {
    req.session.authenticated = true;
    return res.json({ ok: true });
  }
  res.status(401).json({ ok: false, error: "Identifiant ou mot de passe incorrect" });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

const PUBLIC_PATHS = ["/login.html", "/logo.png"];

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  if (PUBLIC_PATHS.includes(req.path)) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Non authentifié" });
  return res.redirect("/login.html");
}
app.use(requireAuth);
app.use(express.static(path.join(__dirname, "public")));

// ---------------- PROXY DU FLUX CAMÉRA ----------------
// Le navigateur ne pointe plus directement vers l'IP locale de l'ESP32
// (http://192.168.x.x:81/stream) : cette adresse est privée et n'est
// injoignable ni via le tunnel ngrok (contenu mixte HTTPS→HTTP bloqué par
// le navigateur), ni depuis un appareil hors du réseau local. À la place,
// le serveur — qui, lui, est sur le réseau local — va chercher le flux à la
// place du client et le retransmet sur cette route, protégée comme le reste
// du dashboard par requireAuth (placée juste après ce middleware).
app.get("/api/camera-stream", (req, res) => {
  if (!state.camera.online || !state.camera.streamUrl) {
    return res.status(503).send("Caméra hors ligne");
  }

  const upstream = http.get(state.camera.streamUrl, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
    upstreamRes.pipe(res);
  });

  upstream.on("error", (err) => {
    console.error("Erreur proxy caméra :", err.message);
    if (!res.headersSent) res.status(502).send("Impossible de contacter la caméra");
  });

  // Si le client ferme la connexion (change de page, ferme l'onglet), on coupe
  // aussi la requête vers l'ESP32 pour ne pas la laisser ouverte inutilement.
  req.on("close", () => upstream.destroy());
});

app.get("/api/history", async (req, res) => {
  const metric = req.query.metric || "temperature";
  const hours = Number(req.query.hours) || 1;
  const since = Date.now() - hours * 3600 * 1000;
  try {
    const rows = await dbAll(
      "SELECT value, ts FROM telemetry WHERE metric = ? AND ts > ? ORDER BY ts ASC",
      [metric, since]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/habits", async (req, res) => {
  try {
    const rows = await dbAll("SELECT payload, ts FROM events WHERE type = 'presence'");
    const hourlyCounts = new Array(24).fill(0);
    rows.forEach((r) => {
      const hour = new Date(r.ts).getHours();
      hourlyCounts[hour] += 1;
    });
    res.json(hourlyCounts);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------- JOURNAL COMPLET DES ÉVÉNEMENTS (historique persistant) ----------------
// Contrairement au widget "Journal des événements" du dashboard (léger, 8 dernières
// entrées, en mémoire côté navigateur, réinitialisé au rechargement), ces routes
// donnent accès à l'historique complet stocké en base, avec pagination et suppression
// (utile pour libérer de l'espace disque au fil du temps).
app.get("/api/events", async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  try {
    const rows = await dbAll(
      "SELECT id, type, payload, ts FROM events ORDER BY id DESC LIMIT ? OFFSET ?",
      [limit, offset]
    );
    const totalRow = await dbAll("SELECT COUNT(*) as count FROM events");
    res.json({ rows, total: totalRow[0].count, offset, limit });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/events/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Identifiant invalide" });
  try {
    await dbRun("DELETE FROM events WHERE id = ?", [id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Vide le journal complet (bouton "Vider tout" côté dashboard). On garde une route
// distincte plutôt qu'un paramètre optionnel sur DELETE /:id pour que l'action
// destructive globale soit explicite et jamais déclenchée par erreur.
app.delete("/api/events", async (req, res) => {
  try {
    await dbRun("DELETE FROM events");
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const httpServer = http.createServer(app);
const io = new Server(httpServer);

io.engine.use(sessionMiddleware);
io.use((socket, next) => {
  const s = socket.request.session;
  if (s && s.authenticated) return next();
  next(new Error("unauthorized"));
});

io.on("connection", (socket) => {
  socket.emit("state", state);

  socket.on("command", ({ method, params }) => {
    sendCommand(method, params);
    if (method === "setRelayState") state.relayState = params;
    if (method === "setDoorLock") state.doorLocked = params;
    if (method === "setAlarm") state.alarmActive = params;
    if (method === "setClimatisation") state.climatisation = params;
    if (method === "setVentilateur") state.ventilateur = params;
    io.emit("state", state);
  });

  socket.on("voiceCommand", (text) => {
    // Compréhension locale (NLU) : gère plusieurs commandes dans une même
    // phrase, les questions sur l'état de la maison, et produit une
    // réponse en langage naturel destinée à être lue à voix haute.
    const result = nlu.parse(text, state);

    result.actions.forEach(({ method, params }) => {
      sendCommand(method, params);
      if (method === "setRelayState") state.relayState = params;
      if (method === "setDoorLock") state.doorLocked = params;
      if (method === "setAlarm") state.alarmActive = params;
      if (method === "setClimatisation") state.climatisation = params;
      if (method === "setVentilateur") state.ventilateur = params;
    });

    state.voice = {
      listening: false,
      lastCommand: text,
      lastAction: result.responseText,
      understood: result.understood,
    };

    io.emit("state", state);
    io.emit("voiceResponse", { text: result.responseText, understood: result.understood, actionsCount: result.actions.length });
  });
});

httpServer.listen(HTTP_PORT, () => {
  console.log(`Dashboard disponible sur http://localhost:${HTTP_PORT}`);
});

// ---------------- MODE DÉMO ----------------
let realDataReceived = false;
appClient.on("message", () => { realDataReceived = true; });

if (DEMO_MODE) {
  console.log("Mode démo actif (DEMO_MODE=false pour le désactiver)");
  let demoTemp = 27, demoHum = 55, demoLight = 60, demoGas = 120;

  setInterval(() => {
    if (realDataReceived) return;

    demoTemp += (Math.random() - 0.5) * 0.6;
    demoHum += (Math.random() - 0.5) * 1.5;
    demoLight += (Math.random() - 0.5) * 8;
    demoGas += (Math.random() - 0.5) * 35;
    demoTemp = Math.max(18, Math.min(34, demoTemp));
    demoHum = Math.max(30, Math.min(85, demoHum));
    demoLight = Math.max(0, Math.min(100, demoLight));
    demoGas = Math.max(40, Math.min(950, demoGas));

    appClient.publish("maison/environnement", JSON.stringify({
      temperature: Math.round(demoTemp * 10) / 10,
      humidity: Math.round(demoHum * 10) / 10,
      light: Math.round(demoLight),
      gas: Math.round(demoGas),
      gasAlert: demoGas > 700,
      relayState: state.relayState,
    }));
  }, 4000);

  setInterval(() => {
    if (realDataReceived) return;
    const presence = Math.random() > 0.7;
    appClient.publish("maison/securite", JSON.stringify({
      doorLocked: state.doorLocked,
      alarmActive: state.alarmActive,
      presence,
    }));
  }, 9000);
}