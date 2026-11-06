#include "secrets.h"  // copier secrets.h.example en secrets.h et le remplir
// ==================================================================
// ESP32-S3-CAM — Stream MJPEG + annonce MQTT vers le dashboard
// Maison Intelligente Autonome (ACGC)
//
// Ce sketch tourne sur la carte caméra ESP32-S3-CAM, INDÉPENDANTE du
// NodeMCU-32S qui gère déjà tous les capteurs/actionneurs. Son seul
// rôle : filmer, et prévenir le dashboard (via MQTT, topic
// "maison/camera") que le flux est disponible et à quelle adresse.
//
// Bibliothèques nécessaires (Gestionnaire de bibliothèques Arduino) :
//   - "PubSubClient" (Nick O'Leary)
//   - esp_camera.h est fourni nativement par le core ESP32 Arduino
// ==================================================================

#include "esp_camera.h"
#include <WiFi.h>
#include <PubSubClient.h>

// ---------------- WIFI ----------------

// ---------------- MQTT (mêmes identifiants que server.js) ----------------
// Doivent correspondre EXACTEMENT à MQTT_USERNAME / MQTT_PASSWORD définis
// côté serveur (variables d'environnement ou valeurs par défaut dans
// server.js), sinon aedes.authenticate() refusera la connexion.
const int   MQTT_PORT = 1883;
const char* MQTT_CLIENT_ID = "esp32-s3-cam";
const char* MQTT_TOPIC_CAMERA = "maison/camera";

// ---------------- PINS CAMÉRA (connecteur FPC intégré) ----------------
#define PWDN_GPIO_NUM  -1
#define RESET_GPIO_NUM -1
#define XCLK_GPIO_NUM  15
#define SIOD_GPIO_NUM  4
#define SIOC_GPIO_NUM  5
#define Y9_GPIO_NUM    16
#define Y8_GPIO_NUM    17
#define Y7_GPIO_NUM    18
#define Y6_GPIO_NUM    12
#define Y5_GPIO_NUM    10
#define Y4_GPIO_NUM    8
#define Y3_GPIO_NUM    9
#define Y2_GPIO_NUM    11
#define VSYNC_GPIO_NUM 6
#define HREF_GPIO_NUM  7
#define PCLK_GPIO_NUM  13

WiFiServer streamServer(81);
WiFiClient mqttNetClient;
PubSubClient mqttClient(mqttNetClient);

// ---------------- INITIALISATION CAMÉRA ----------------
bool initCamera() {
  camera_config_t config;
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer   = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk = XCLK_GPIO_NUM;
  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href = HREF_GPIO_NUM;
  config.pin_sscb_sda = SIOD_GPIO_NUM;
  config.pin_sscb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;

  if (psramFound()) {
    config.frame_size = FRAMESIZE_VGA;   // 640x480, bon compromis démo
    config.jpeg_quality = 12;            // plus bas = meilleure qualité
    config.fb_count = 2;
  } else {
    config.frame_size = FRAMESIZE_SVGA;
    config.jpeg_quality = 12;
    config.fb_count = 1;
  }

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("Échec init caméra : 0x%x\n", err);
    return false;
  }
  return true;
}

// ---------------- STREAM MJPEG (port 81, un seul client à la fois) ----------------
void handleStreamClient(WiFiClient& client) {
  String header = "HTTP/1.1 200 OK\r\n";
  header += "Content-Type: multipart/x-mixed-replace; boundary=frame\r\n\r\n";
  client.print(header);

  while (client.connected()) {
    camera_fb_t* fb = esp_camera_fb_get();
    if (!fb) {
      Serial.println("Capture image échouée");
      delay(50);
      continue;
    }
    client.print("--frame\r\n");
    client.print("Content-Type: image/jpeg\r\n");
    client.print("Content-Length: " + String(fb->len) + "\r\n\r\n");
    client.write(fb->buf, fb->len);
    client.print("\r\n");
    esp_camera_fb_return(fb);

    if (!client.connected()) break;
    delay(30); // limite le débit pour ne pas saturer le WiFi
  }
}

// ---------------- MQTT : annonce du flux au dashboard ----------------
void publishCameraStatus(bool online) {
  String streamUrl = "http://" + WiFi.localIP().toString() + ":81/stream";
  String payload = "{\"streamUrl\":\"" + streamUrl + "\",\"cameraOnline\":" + (online ? "true" : "false") + "}";
  mqttClient.publish(MQTT_TOPIC_CAMERA, payload.c_str());
  Serial.println("Statut caméra publié : " + payload);
}

void reconnectMqtt() {
  while (!mqttClient.connected()) {
    Serial.print("Connexion MQTT... ");
    if (mqttClient.connect(MQTT_CLIENT_ID, MQTT_USERNAME, MQTT_PASSWORD)) {
      Serial.println("OK");
      publishCameraStatus(true);
    } else {
      Serial.printf("échec (rc=%d), nouvelle tentative dans 3s\n", mqttClient.state());
      delay(3000);
    }
  }
}

// ---------------- SETUP ----------------
void setup() {
  Serial.begin(115200);

  if (!initCamera()) {
    Serial.println("Redémarrage suite à l'échec caméra...");
    delay(2000);
    ESP.restart();
  }

  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connexion WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(400);
    Serial.print(".");
  }
  Serial.println("\nWiFi connecté, IP : " + WiFi.localIP().toString());

  streamServer.begin();
  Serial.println("Serveur de stream MJPEG démarré sur le port 81");

  mqttClient.setServer(MQTT_BROKER_IP, MQTT_PORT);
  reconnectMqtt();
}

// ---------------- LOOP ----------------
void loop() {
  if (!mqttClient.connected()) reconnectMqtt();
  mqttClient.loop();

  WiFiClient client = streamServer.available();
  if (client) {
    handleStreamClient(client);
    client.stop();
  }
}
