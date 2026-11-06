# Maison Intelligente Autonome

Système domotique et de sécurité basé sur **ESP32**, supervisé par un **dashboard web temps réel** et piloté via **MQTT**.

Projet réalisé par **Adja Cheikh Gatta Camara**, étudiante en Licence Robotique et Sciences émergentes (UNCHK, Sénégal), au sein de **ACGC Innov'Bot**.

## Fonctionnalités

- Mesures de capteurs (température, humidité) remontées en temps réel
- Contrôle d'accès par **badge RFID**
- Commandes à distance depuis le dashboard via MQTT
- **Flux vidéo MJPEG** d'une ESP32-S3-CAM, annoncé au dashboard par MQTT
- Dashboard web protégé par mot de passe
- Moteur de commandes en langage naturel (`nlu.js`, `ai-engine.js`)

## Architecture

## Matériel

- ESP32 (carte principale : capteurs, RFID)
- ESP32-S3-CAM
- Capteur DHT, lecteur RFID, actionneurs (à compléter)

## Technologies

C/C++ (Arduino) · MQTT · Node.js · Aedes · Socket.IO · SQLite · HTML/CSS/JavaScript

## Installation

### 1. Serveur et dashboard

```bash
cd Maison_Iot
npm install
cp .env.example .env     # puis remplir les valeurs
node --env-file=.env server.js
```

### 2. Cartes ESP32

Dans `esp32_maison_complet/` et `esp32_s3_cam_stream/` :

```bash
cp secrets.h.example secrets.h   # puis renseigner Wi-Fi et identifiants MQTT
```

Ouvrir ensuite le fichier `.ino` dans l'IDE Arduino et téléverser.

## Démo

Vidéo : à ajouter (lien YouTube)

## Sécurité

Les identifiants (Wi-Fi, MQTT, mot de passe du dashboard) ne sont pas dans ce dépôt : ils sont définis dans `secrets.h` et `.env`, ignorés par Git.

## Licence

MIT, voir [LICENSE](LICENSE).
