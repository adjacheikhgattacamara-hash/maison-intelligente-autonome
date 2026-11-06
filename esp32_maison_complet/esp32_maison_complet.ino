#include "secrets.h"  // copier secrets.h.example en secrets.h et le remplir
// ==================================================================
// MAISON INTELLIGENTE AUTONOME — ESP32 UNIQUE (tout intégré)
// Fusion de esp32_gateway_mqtt.ino + arduino_securite_rfid.ino
// L'Arduino Uno et la liaison Série ne sont plus nécessaires :
// tout tourne sur le même ESP32.
//
// Rôle :
//   - WiFi + MQTT (broker Aedes embarqué dans server.js)
//   - DHT11 (température/humidité), LDR (luminosité), MQ2 (gaz)
//   - Relais lumière
//   - RFID (MFRC522) + servo serrure + buzzer alarme + PIR
//
// Bibliothèques requises (Gestionnaire de bibliothèques Arduino IDE) :
//   - PubSubClient (Nick O'Leary)
//   - ArduinoJson (Benoit Blanchon)
//   - DHT sensor library (Adafruit) + Adafruit Unified Sensor
//   - MFRC522 (miguelbalboa)
//   - ESP32Servo (madhephaestus)  <-- IMPORTANT : PAS la lib "Servo" standard,
//     elle ne fonctionne pas sur ESP32. Installez "ESP32Servo".
//
// ---------------- PLAN DE BROCHAGE (aucun conflit) ----------------
//   DHT11        -> GPIO 4
//   LDR (analog) -> GPIO 34   (ADC1, entrée seule)
//   MQ2  (analog)-> GPIO 35   (ADC1, entrée seule)
//   Relais       -> GPIO 26
//   Ventilateur (relais) -> GPIO 32
//   RFID MFRC522 (bus SPI VSPI) :
//       SDA/SS   -> GPIO 5
//       RST      -> GPIO 22
//       SCK      -> GPIO 18  (fixe, matériel VSPI)
//       MOSI     -> GPIO 23  (fixe, matériel VSPI)
//       MISO     -> GPIO 19  (fixe, matériel VSPI)
//       3.3V / GND
//   Servo serrure -> GPIO 13
//   Buzzer alarme -> GPIO 27
//   PIR           -> GPIO 25
//
// Broches ESP32 volontairement évitées :
//   0, 2, 12, 15 (strapping/boot), 6-11 (flash SPI interne, INUTILISABLES),
//   1, 3 (UART0 = Serial de debug)
// ==================================================================

#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <DHT.h>
#include <SPI.h>
#include <MFRC522.h>
#include <ESP32Servo.h>

// ---------------- BROCHES ----------------
#define DHTPIN       4
#define DHTTYPE      DHT11
#define LDR_PIN      34
#define GAS_PIN      35
#define RELAY_PIN    26
#define FAN_PIN      32

#define RFID_SS_PIN  5
#define RFID_RST_PIN 22
#define SERVO_PIN    13
#define BUZZER_PIN   27
#define PIR_PIN      21

// ---------------- RÉSEAU ----------------
const uint16_t MQTT_PORT  = 1883;

DHT dht(DHTPIN, DHTTYPE);
WiFiClient espClient;
PubSubClient mqtt(espClient);
MFRC522 rfid(RFID_SS_PIN, RFID_RST_PIN);
Servo lockServo;

bool relayState  = false;
bool fanState    = false;
bool doorLocked  = true;
bool alarmActive = false;
bool lastPirState = false;

unsigned long lastEnvSend = 0;
const unsigned long ENV_INTERVAL_MS = 4000;

// UID des badges autorisés (à adapter — scannez vos badges pour lire leur UID réel)
const String AUTHORIZED_UIDS[] = { "A1B2C3D4", "11223344" };
const int NUM_AUTHORIZED = 2;

// ---------------- WIFI ----------------
void connectWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connexion WiFi");
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED) {
    delay(400);
    Serial.print(".");
    // évite un blocage infini si le SSID/mdp est faux : on retente proprement
    if (millis() - start > 15000) {
      Serial.println(" échec, nouvelle tentative...");
      WiFi.disconnect(true);
      delay(500);
      WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
      start = millis();
    }
  }
  Serial.println(" OK, IP = " + WiFi.localIP().toString());
}

// ---------------- SERRURE / ALARME ----------------
// Publie l'état réel porte/alarme après chaque changement, qu'il vienne d'une
// commande MQTT (dashboard) ou d'un déclenchement autonome de l'ESP32 (badge
// refusé, PIR). Sans ça, le dashboard pouvait rester désynchronisé de l'état
// physique quand l'alarme se déclenchait toute seule côté ESP32.
void publishSecurityState() {
  StaticJsonDocument<96> doc;
  doc["doorLocked"] = doorLocked;
  doc["alarmActive"] = alarmActive;
  char buf[96];
  size_t n = serializeJson(doc, buf);
  mqtt.publish("maison/securite", buf, n);
}

void setLock(bool locked) {
  doorLocked = locked;
  lockServo.write(locked ? 0 : 90); // angles à ajuster selon montage mécanique
  publishSecurityState();
}

void setAlarm(bool active) {
  alarmActive = active;
  digitalWrite(BUZZER_PIN, active ? HIGH : LOW);
  publishSecurityState();
}

String uidToString(MFRC522::Uid uid) {
  String s = "";
  for (byte i = 0; i < uid.size; i++) {
    if (uid.uidByte[i] < 0x10) s += "0";
    s += String(uid.uidByte[i], HEX);
  }
  s.toUpperCase();
  return s;
}

bool isAuthorized(const String& uid) {
  for (int i = 0; i < NUM_AUTHORIZED; i++) {
    if (AUTHORIZED_UIDS[i] == uid) return true;
  }
  return false;
}

// ---------------- COMMANDES REÇUES VIA MQTT (topic maison/commande) ----------------
void onMqttMessage(char* topic, byte* payload, unsigned int length) {
  StaticJsonDocument<200> doc;
  DeserializationError err = deserializeJson(doc, payload, length);
  if (err) return;

  String method = doc["method"] | "";
  bool value = doc["params"] | false;

  if (method == "setRelayState") {
    relayState = value;
    digitalWrite(RELAY_PIN, relayState ? HIGH : LOW);
  } else if (method == "setDoorLock") {
    setLock(value);
  } else if (method == "setAlarm") {
    setAlarm(value);
  } else if (method == "setVentilateur") {
    fanState = value;
    digitalWrite(FAN_PIN, fanState ? HIGH : LOW);
  }
  // setClimatisation : pas de relais dédié pour l'instant, reste virtuel côté dashboard
}

void reconnectMqtt() {
  while (!mqtt.connected()) {
    Serial.print("Connexion MQTT...");
    if (mqtt.connect("esp32-gateway", MQTT_USERNAME, MQTT_PASSWORD)) {
      Serial.println(" OK");
      mqtt.subscribe("maison/commande");
    } else {
      Serial.print(" échec (code ");
      Serial.print(mqtt.state());
      Serial.println("), nouvelle tentative dans 2s");
      delay(2000);
    }
  }
}

// ---------------- ENVOI DES DONNÉES ENVIRONNEMENT ----------------
void publishEnvironment() {
  float t = dht.readTemperature();
  float h = dht.readHumidity();
  if (isnan(t) || isnan(h)) return;

  int lightRaw = analogRead(LDR_PIN);
  int light = map(lightRaw, 0, 4095, 0, 100);
  int gas = analogRead(GAS_PIN);
  bool gasAlert = gas > 700;

  StaticJsonDocument<256> doc;
  doc["temperature"] = t;
  doc["humidity"] = h;
  doc["light"] = light;
  doc["gas"] = gas;
  doc["gasAlert"] = gasAlert;
  doc["relayState"] = relayState;
  doc["ventilateurState"] = fanState;

  char buffer[256];
  size_t n = serializeJson(doc, buffer);
  mqtt.publish("maison/environnement", buffer, n);

  if (gasAlert) {
    StaticJsonDocument<128> evt;
    evt["alert"] = true;
    evt["gasPercent"] = gas;
    char evtBuf[128];
    size_t m = serializeJson(evt, evtBuf);
    mqtt.publish("maison/evenement/gaz", evtBuf, m);
  }
}

// ---------------- RFID ----------------
void handleRfid() {
  if (!rfid.PICC_IsNewCardPresent() || !rfid.PICC_ReadCardSerial()) return;

  String uid = uidToString(rfid.uid);
  bool granted = isAuthorized(uid);

  if (granted) {
    setLock(false);
    delay(3000);
    setLock(true);
  } else {
    setAlarm(true);
    delay(1500);
    setAlarm(false);
  }

  StaticJsonDocument<128> doc;
  doc["uid"] = uid;
  doc["granted"] = granted;
  char buf[128];
  size_t n = serializeJson(doc, buf);
  mqtt.publish("maison/evenement/rfid", buf, n);

  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();
}

// ---------------- PIR ----------------
void handlePir() {
  bool pirState = digitalRead(PIR_PIN) == HIGH;
  if (pirState != lastPirState) {
    lastPirState = pirState;

    StaticJsonDocument<64> doc;
    doc["presence"] = pirState;
    char buf[64];
    size_t n = serializeJson(doc, buf);
    mqtt.publish("maison/evenement/presence", buf, n);

    if (pirState && doorLocked) {
      setAlarm(true);
    }
  }
}

// ---------------- SETUP / LOOP ----------------
void setup() {
  Serial.begin(115200);

  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, LOW);
  pinMode(FAN_PIN, OUTPUT);
  digitalWrite(FAN_PIN, LOW);
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(PIR_PIN, INPUT);

  dht.begin();

  SPI.begin(18, 19, 23, RFID_SS_PIN); // SCK, MISO, MOSI, SS (VSPI)
  rfid.PCD_Init();

  lockServo.setPeriodHertz(50);
  lockServo.attach(SERVO_PIN, 500, 2400);
  setLock(true);
  setAlarm(false);

  connectWifi();
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(onMqttMessage);
  mqtt.setBufferSize(512, 512); // marge de sécurité pour les payloads JSON
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) connectWifi();
  if (!mqtt.connected()) reconnectMqtt();
  mqtt.loop();

  if (millis() - lastEnvSend > ENV_INTERVAL_MS) {
    lastEnvSend = millis();
    publishEnvironment();
  }

  handleRfid();
  handlePir();
}
