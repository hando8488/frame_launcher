# Frame Launcher

Schneller Startbildschirm für Samsung The Frame als [TizenBrew](https://github.com/reisxd/TizenBrew)-Modul.

- Kacheln: Prime Video, YouTube, PS5 (HDMI 1), Spotify, Das Erste & ZDF live, TizenPortal
- Uhrzeit, Wetter Leipzig (heute + 2 Tage, Open-Meteo)
- Art Mode per Knopf
- Komplett ohne Framework, eine Datei (`app/index.html`)

## Bedienung

| Taste      | Funktion                                   |
|------------|--------------------------------------------|
| Pfeile/OK  | Navigieren / Starten                       |
| Rot        | Bearbeiten an/aus                          |
| ◀ ▶        | (im Bearbeiten) Kachel verschieben         |
| Grün       | (im Bearbeiten) installierte App hinzufügen |
| Gelb       | (im Bearbeiten) Kachel entfernen           |
| Blau       | (im Bearbeiten) auf Standard zurücksetzen  |
| Zurück     | Overlay / Player schließen                 |
| ▲▼ / P+ P- | (im Live-Player) Sender wechseln           |

Feste Einstellungen (Kacheln, Lesezeichen, Wetter-Ort) stehen oben in `app/index.html` im `CONFIG`-Block.
Änderungen am TV (Reihenfolge, hinzugefügte Apps) werden lokal auf dem TV gespeichert.

## Installation auf dem TV

1. Repo auf GitHub veröffentlichen (öffentlich, damit jsDelivr es ausliefern kann).
2. In TizenBrew → Module → hinzufügen: `gh/hando8488/frame_launcher`
3. TizenBrew → Einstellungen → Autostart-Modul: Frame Launcher
4. Entwicklermodus am TV: Host-PC-IP auf `127.0.0.1` stellen (nötig für TizenBrews Autostart).
5. TV: Einstellungen → Allgemein → Smart-Funktionen → „Letzte App automatisch starten“ an.

TizenPortal muss in TizenBrew als GitHub-Modul `axelnanol/tizenportal` hinzugefügt sein.

Beim ersten HDMI-/Art-Mode-Befehl fragt der TV, ob „Frame Launcher“ zugreifen darf → Zulassen.

Nach Änderungen: `git push`, dann Cache leeren über
`https://purge.jsdelivr.net/gh/hando8488/frame_launcher@latest/app/index.html`

## Lokale Vorschau

```bash
python3 -m http.server 8777
```
→ http://127.0.0.1:8777/app/index.html?preview (F1–F4 = Farbtasten, Esc = Zurück)
