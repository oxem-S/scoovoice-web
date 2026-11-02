# ScooVoice Web

Sprach- und Knopfsteuerung für den Ninebot-Scooter **im Browser** – Web-Version der
Android-App ScooVoice.

**Live:** nach dem Deploy unter `https://oxem-S.github.io/scoovoice-web/`.

## Was kann die Web-Version?

| Bereich | Umfang |
|---|---|
| **Steuerung (BLE)** | Verbinden über Web Bluetooth, `session.json`-Import (Fast-Re-Pair), Max-Tempo 10–35 km/h, Zero-Start, Reset, PANIK-Knopf, aktuelles Tempo-Anzeige |
| **Wheelie + Kalibrierung** | Nickwinkel-Anzeige, geführte 4-Schritt-Kalibrierung (Nullpunkt / rechts / links / Wheelie-Höhe), Wheelie-Assist- und Anti-Wheelie-Regelung über Handy-Sensor, Failsafe |
| **Sprache** | Web Speech API (deutsch): Zahlen 10–35, „Zero Start", „Reset", „start", „sicher", „song 1"–„song 6", „Nullpunkt", „Winkel zwanzig", „Assistent an/aus" – optional mit Wake-Wort |

Die Protokolllogik ist **byte-exakt** 1:1 aus der Android-App portiert (`Frame.kt`,
`NbCrypto.kt` → `js/protocol.js`; `CommandController/SongBook/Wheelie*/TelemetryFilter/Calibration`
→ `js/logic.js`; `TiltSensor` → `js/sensors.js`; `ScooterLink.kt` → `js/link.js`;
`VoiceService.kt` → `js/app.js`). Ein eingebauter **Krypto-Selbsttest** (Fuß der Seite)
prüft den AES-128-Kanonvektor (FIPS-197) und alle NbCrypto-Referenzvektoren aus
`NbCryptoTest.kt` gegen die Python-Referenz – beim ersten Laden bitte einmal ausführen.

## Browser-Support

- **Web Bluetooth (Verbindung zum Roller):** Chrome/Edge am Desktop und Android-Chrome.
  **Nicht** in Safari/iOS und nicht in Firefox.
- **Sensoren (Neigung für Wheelie/Kalibrierung):** HTTPS nötig (GitHub Pages erfüllt das);
  iOS braucht bei DeviceMotion eine Extra-Berechtigungsabfrage, die beim Klick auf
  „Kalibrieren"/„Starten" abgefragt wird.
- **Spracherkennung:** Web Speech API (Chrome). Sie läuft **nicht offline** – die
  Erkennung kombiniert lokal mit Google-Servern (anders als Vosk in der Android-App).
- Ohne HTTPS (z. B. `file://`) gehen Web Bluetooth, Web Speech und WebCrypto-SHA-1 nicht:
  im Zweifel lokal mit `python -m http.server` testen.

## Sicherheit

- Die PANIK-Taste (1. Druck = werksähnlicher Zustand `22 km/h` + Anfahrschwelle 3 km/h,
  2. Druck = vorherige Werte zurück) verhält sich genau wie die Android-App.
- Der Assistent merkt sich vor dem Start das aktuelle Limit (Failsafe) und stellt es
  bei Stop/Verbindungsabbruch wieder her. **Nur auf Privatgelände, mit Helm und Protektoren.**
- Die Web-Version ist kein vollständiger Ersatz für die Android-App: Sensortakt (~60 Hz),
  Web-Bluetooth-Timing und die Spracherkennung sind träger bzw. nur online.

## Entwicklung / Lokal testen

```bash
python -m http.server 8765
# dann http://localhost:8765 in Chrome/Edge öffnen
```

Struktur:

```
index.html      – UI (eine Seite, Dark Theme wie die Android-App)
styles.css      – Theme
js/protocol.js  – AES-128-ECB + SHA-1 + NbCrypto + Frames + RX-Stream + SpeedMap
js/link.js      – Web-Bluetooth-Sitzung (Identify/Fast-Re-Pair/Propose/Accept, Register-IO)
js/logic.js     – Befehle, Song, Wheelie-/Anti-Wheelie-Regler, Tracker, Telemetrie-Filter, Kalibrierung
js/sensors.js   – DeviceMotion/devierorientation-"TiltSensor" (gleiche Tau-Filter wie Android)
js/store.js     – localStorage: Pairing-Keys, Kalibrierung, Einstellungen
js/app.js       – UI-Glue: Befehlskette, PANIK, Assistent-Regel-/Telemetrieschleifen, Selbsttest
```

## Deploy (GitHub Pages)

```bash
git init && git add . && git commit -m "ScooVoice Web"
gh repo create scoovoice-web --public --source=. --push
gh api repos/oxem-S/scoovoice-web/pages -X POST -f "source[branch]=main" -f "source[path]=/"
```

Deploy-Ziel: statische Seite, keine Build-Tools nötig (reine ES-Module).
