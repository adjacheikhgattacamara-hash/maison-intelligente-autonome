// ==================================================================
// NLU LOCAL — compréhension de commandes vocales, 100% local
// (aucune clé API, aucun appel externe)
//
// Gère : commandes composées ("allume la lumière et verrouille la porte"),
// commandes groupées ("allume tout" / "éteins tout"), contrôle de l'alarme
// (verbes dédiés "arme"/"désarme" en plus de "active"/"désactive"),
// questions sur l'état de la maison, une commande d'aide ("aide", "que
// peux-tu faire"), de nombreux synonymes, et renvoie une réponse en
// langage naturel prête à être lue à voix haute (TTS).
//
// Le texte est désaccentué avant analyse (normalize()) : ça évite de
// dupliquer chaque motif en version accentuée/non accentuée et rend la
// reconnaissance plus tolérante (dictée vocale, fautes de frappe sur les
// accents, etc.).
// ==================================================================

function normalize(text) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, ""); // enlève les accents (é->e, ç->c, ...)
}

const ON_VERBS = /(allum|active|demarre|mets en marche|lance|branche)/;
const OFF_VERBS = /(eteins|coupe|arrete|desactive|debranche|stop)/;
const LOCK_VERBS = /(verrouill|ferme)/;
const UNLOCK_VERBS = /(deverrouill|debloque)/;
const OPEN_AMBIGUOUS = /\bouvre\b/; // "ouvre la porte" = déverrouille

const QUERY_PATTERNS = [
  { key: "temperature", regex: /temperature|degres?|fait[- ]il (chaud|froid)/ },
  { key: "humidity", regex: /humidite|trop humide|trop sec/ },
  { key: "gas", regex: /(qualite de l'?air|niveau de gaz|pollution|odeur de gaz|sent le gaz)/ },
  { key: "presence", regex: /(quelqu'?un|presence|maison vide|y a[- ]t[- ]il)/ },
  { key: "door", regex: /porte.*(verrouill|fermee?|ouverte?|deverrouill)/ },
  { key: "status", regex: /(statut|etat de la maison|resume|comment va la maison)/ },
];

const GREETING_REGEX = /^(bonjour|salut|coucou|bonsoir|hey|hello)\b/;
const HELP_REGEX = /^(aide|aide[- ]moi|que peux[- ]tu faire|liste des commandes|commandes disponibles)\b/;
const THANKS_REGEX = /^(merci|au revoir|a plus tard|bonne nuit)\b/;

const HELP_TEXT =
  "Je peux allumer ou éteindre la lumière, la climatisation ou le ventilateur, " +
  "verrouiller ou déverrouiller la porte, armer ou désarmer l'alarme, tout allumer " +
  "ou tout éteindre d'un coup, ou répondre à des questions sur la température, " +
  "l'humidité, la qualité de l'air, la présence ou le statut général de la maison.";

function splitClauses(text) {
  return text
    .split(/,| et | puis |\bensuite\b/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildDeviceAction(key, on) {
  const map = {
    light: { method: "setRelayState", on: "Lumière allumée.", off: "Lumière éteinte." },
    clim: { method: "setClimatisation", on: "Climatisation activée.", off: "Climatisation coupée." },
    fan: { method: "setVentilateur", on: "Ventilateur activé.", off: "Ventilateur arrêté." },
  };
  const cfg = map[key];
  return {
    intent: `${key}_${on ? "on" : "off"}`,
    action: { method: cfg.method, params: on },
    response: on ? cfg.on : cfg.off,
  };
}

// Commande groupée : "allume tout" / "éteins tout" agit sur lumière,
// climatisation et ventilateur en une seule fois (la porte et l'alarme
// restent volontairement exclues d'un "tout", trop sensibles pour un
// geste aussi large).
function buildAllAction(on) {
  return {
    intent: on ? "all_on" : "all_off",
    action: [
      { method: "setRelayState", params: on },
      { method: "setVentilateur", params: on },
      { method: "setClimatisation", params: on },
    ],
    response: on
      ? "Lumière, ventilateur et climatisation allumés."
      : "Lumière, ventilateur et climatisation éteints.",
  };
}

function buildQueryResponse(key, state) {
  switch (key) {
    case "temperature":
      return { intent: "query_temperature", response: state.temperature != null ? `Il fait actuellement ${state.temperature} degrés.` : "Je n'ai pas encore de mesure de température." };
    case "humidity":
      return { intent: "query_humidity", response: state.humidity != null ? `L'humidité est de ${state.humidity} pourcent.` : "Je n'ai pas encore de mesure d'humidité." };
    case "gas":
      return { intent: "query_gas", response: state.gasAlert ? "Attention, une fuite de gaz est détectée !" : `La qualité de l'air est normale, à ${state.gas ?? "--"} PPM.` };
    case "presence":
      return { intent: "query_presence", response: state.presence ? "Oui, une présence est détectée dans la maison." : "Non, aucune présence détectée actuellement." };
    case "door":
      return { intent: "query_door", response: state.doorLocked ? "La porte est verrouillée." : "La porte est déverrouillée." };
    case "status":
      return { intent: "query_status", response: `Température ${state.temperature ?? "--"} degrés, humidité ${state.humidity ?? "--"} pourcent, porte ${state.doorLocked ? "verrouillée" : "déverrouillée"}, alarme ${state.alarmActive ? "active" : "au repos"}, ${state.presence ? "présence détectée" : "aucune présence"}.` };
    default:
      return { intent: "unknown", response: "" };
  }
}

function parseClause(clauseRaw, state) {
  const t = normalize(clauseRaw).trim();
  if (!t) return { intent: "empty", response: "" };

  if (GREETING_REGEX.test(t) && t.length < 20) {
    return { intent: "greeting", response: "Bonjour ! Je t'écoute." };
  }

  if (HELP_REGEX.test(t)) {
    return { intent: "help", response: HELP_TEXT };
  }

  if (THANKS_REGEX.test(t) && t.length < 25) {
    return { intent: "thanks", response: "Avec plaisir !" };
  }

  for (const q of QUERY_PATTERNS) {
    if (q.regex.test(t)) return buildQueryResponse(q.key, state);
  }

  // IMPORTANT : on teste d'abord les formes négatives/inverses, car elles
  // contiennent la forme positive comme sous-chaîne ("désactive" contient
  // "active", "déverrouille" contient "verrouille", "désarme" contient
  // "arme") — sinon le mauvais intent gagnerait systématiquement.

  // Porte : traitée en premier car "ouvre" est ambigu avec les autres appareils
  if (/porte/.test(t)) {
    if (UNLOCK_VERBS.test(t) || OPEN_AMBIGUOUS.test(t)) return { intent: "door_unlock", action: { method: "setDoorLock", params: false }, response: "Porte déverrouillée." };
    if (LOCK_VERBS.test(t)) return { intent: "door_lock", action: { method: "setDoorLock", params: true }, response: "Porte verrouillée." };
  }

  if (/alarme/.test(t)) {
    if (OFF_VERBS.test(t) || /desarme|silence/.test(t)) return { intent: "alarm_off", action: { method: "setAlarm", params: false }, response: "Alarme désactivée." };
    if (ON_VERBS.test(t) || /\barme\b/.test(t)) return { intent: "alarm_on", action: { method: "setAlarm", params: true }, response: "Alarme activée." };
  }

  // Commande groupée ("tout"), volontairement exclue si la phrase parle de
  // la porte ou de l'alarme (déjà traitées ci-dessus, trop sensibles pour
  // un "tout" générique).
  if (/\btout\b/.test(t) && !/porte|alarme/.test(t)) {
    if (OFF_VERBS.test(t)) return buildAllAction(false);
    if (ON_VERBS.test(t)) return buildAllAction(true);
  }

  if (/(lumiere|lampe|salon)/.test(t)) {
    if (OFF_VERBS.test(t)) return buildDeviceAction("light", false);
    if (ON_VERBS.test(t)) return buildDeviceAction("light", true);
  }

  if (/(climat|\bclim\b)/.test(t)) {
    if (OFF_VERBS.test(t)) return buildDeviceAction("clim", false);
    if (ON_VERBS.test(t)) return buildDeviceAction("clim", true);
  }

  if (/(ventilateur|ventilation)/.test(t)) {
    if (OFF_VERBS.test(t)) return buildDeviceAction("fan", false);
    if (ON_VERBS.test(t)) return buildDeviceAction("fan", true);
  }

  return { intent: "unknown", response: "" };
}

// Analyse le texte transcrit ; peut contenir plusieurs commandes.
function parse(text, state) {
  const clauses = splitClauses(text);
  const results = clauses.map((c) => parseClause(c, state));

  // flatMap gère aussi bien une action unique (objet) qu'un groupe d'actions
  // (tableau, cas de la commande "tout").
  const actions = results.flatMap((r) => {
    if (!r.action) return [];
    return Array.isArray(r.action) ? r.action : [r.action];
  });

  const understoodResults = results.filter((r) => r.intent !== "unknown" && r.intent !== "empty");
  const hasUnknownClause = results.some((r) => r.intent === "unknown");

  let responseText;
  if (understoodResults.length > 0) {
    responseText = understoodResults.map((r) => r.response).filter(Boolean).join(" ");
    if (hasUnknownClause && clauses.length > 1) {
      responseText += " Une partie de la phrase n'a pas été comprise.";
    }
  } else {
    responseText = "Désolé, je n'ai pas compris. Tu peux reformuler ou demander de l'aide ?";
  }

  return {
    actions,
    responseText,
    understood: understoodResults.length > 0,
    intents: results.map((r) => r.intent),
  };
}

module.exports = { parse };