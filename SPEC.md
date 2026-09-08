# Lilith – Produktspezifikation

**Status:** Draft 0.1

**Ziel:** gemeinsame Arbeitsgrundlage; noch keine endgültige technische Festlegung

## 1. Produktidee

Lilith ist ein persönlicher, dauerhaft verfügbarer KI-Begleiter für das Smartphone. Die App fühlt sich so direkt wie ein Messenger an, kann Aufgaben aber an spezialisierte Unteragenten delegieren, deren Arbeit sichtbar machen und Ergebnisse in einem Hauptchat zusammenführen.

Der Hauptagent heißt standardmäßig **Lilith**, kann umbenannt werden und entwickelt durch kontrollierbare Erinnerungen ein Verständnis für die Vorlieben des Nutzers. Lilith wirkt als Wesen in der App, ohne dass die Bedienung zu einem Spiel wird.

## 2. Leitprinzipien

1. **Ein Hauptchat:** Der Nutzer muss keine Agenten verwalten, um Hilfe zu bekommen.
2. **Delegation statt Chat-Chaos:** Lilith entscheidet, wann ein Unteragent sinnvoll ist, zeigt dies aber transparent.
3. **Autonomie mit Grenze:** Lesen, Navigieren, Recherchieren und Analysieren sind frei. Aktionen mit Außenwirkung benötigen eine Bestätigung.
4. **Einfach zuerst:** Gute Voreinstellungen funktionieren sofort; Experten können später mehr anpassen.
5. **Provider statt Lock-in:** Modelle und Agent-Harnesses werden über klar begrenzte Adapter angebunden.
6. **Kontrollierbares Gedächtnis:** Erinnerungen sind sichtbar, korrigierbar und löschbar.
7. **Mobile Oberfläche, serverseitige Arbeit:** Das Smartphone bleibt leicht; langlebige Agenten und Browser laufen auf dem Server.

## 3. Zielgruppe und erster Betrieb

Die erste Alpha ist strikt **single-user** und läuft nur für den Ersteller. Eingeladene Tester folgen erst, nachdem Mandantentrennung, Secret-Isolation, Backups, Rate-Limits und Auditierung nachweisbar aktiv sind.

- iPhone zuerst
- Android aus derselben Codebasis
- Dark Mode als Standard
- Managed-Cloud-Modell
- Ein vorhandener Headless-Linux-Server darf als isolierte Alpha-Umgebung dienen

## 4. Begriffe

- **Lilith:** dauerhafter Hauptagent mit Name, Persönlichkeit, Berechtigungen und Erinnerungen
- **Unteragent:** temporärer Spezialagent für genau eine Aufgabe oder Rolle
- **Aufgabe:** langlebige Arbeitseinheit mit Status, Verlauf und Ergebnis
- **Provider:** angebundener Modell- oder Agentenanbieter
- **Tool:** klar begrenzte Fähigkeit wie Web-Recherche oder Browsersteuerung
- **Erinnerung:** gespeicherte Information über den Nutzer oder seine Präferenzen

## 5. Kernablauf

1. Der Nutzer schreibt im Hauptchat mit Lilith.
2. Lilith antwortet direkt oder erklärt knapp, welche Teilaufgaben sie delegiert.
3. Unteragenten laufen parallel oder nacheinander auf dem Server.
4. Der Chat zeigt kompakte Statuskarten statt interner Logs.
5. Rückfragen erscheinen mit antippbaren Antwortoptionen und einem Freitextweg.
6. Eine geplante Aktion mit Außenwirkung erscheint als Freigabekarte.
7. Lilith führt freigegebene Aktionen aus und fasst das Ergebnis im Hauptchat zusammen.
8. Der Nutzer kann Details, Quellen und den Verlauf einer Aufgabe bei Bedarf öffnen.

## 6. Erste Alpha und Roadmap

### P0 – Erste Alpha: Chat und Delegation

Nur P0 gehört zur ersten Alpha. Sie muss Folgendes können:

- Onboarding mit **Recommended** oder **Blank**
- Namen des Hauptagenten wählen; Standard ist Lilith
- nach einem Provider-Qualifikationsschritt genau einen Provider sicher verbinden
- Nachrichten streamen
- eine dafür vorgesehene Testaufgabe an mindestens einen Unteragenten delegieren
- Zustände `wartet`, `arbeitet`, `braucht Eingabe`, `pausiert`, `fertig`, `gestoppt`, `fehlgeschlagen` anzeigen
- Unteragent-Ergebnisse in den Hauptchat zurückführen
- Aufgabe stoppen; danach dürfen keine neuen Tool-Aufrufe starten und verspätete Ergebnisse nicht als Erfolg erscheinen
- Chat- und Aufgabenstatus nach einem App-Neustart wiederherstellen
- strukturierte Rückfragen mit antippbaren Antworten stellen
- Quellen und Tool-Aktivitäten kompakt anzeigen
- explizite Erinnerungen anzeigen, bearbeiten, löschen und pausieren
- eine serverseitige Freigabesperre mit einer simulierten External-Write-Aktion testen

**Recommended** aktiviert zunächst genau zwei eingebaute Tools: öffentliche Web-Recherche und Memory. **Blank** startet ohne optionale Tools. Dafür ist in P0 kein allgemeines Plugin-System nötig.

Die folgenden Prioritäten sind Roadmap nach der ersten Alpha.

### P1 – Browser-Recherche und Computer-Use

Computer-Use beginnt als isolierter Browser, nicht als vollständiger Desktop:

- Seiten öffnen, lesen, suchen und Informationen vergleichen
- Cookie-Dialoge und dynamische Seiten bedienen
- Schrittverlauf mit URL und Screenshots anzeigen
- jederzeit stoppen
- Formulare vorbereiten
- vor Absenden, Nachricht, Upload, Kauf oder vergleichbarer Außenwirkung bestätigen lassen
- Logins und Zugangsdaten nur über einen gesicherten, nutzerkontrollierten Weg verwenden

Desktopsteuerung außerhalb des Browsers folgt erst, wenn Browser-Use zuverlässig und sicher ist.

### P2 – Lilith als Wesen

Im ersten Schritt lebt Lilith durch wenige verständliche Zustände:

- idle
- denkt
- delegiert
- arbeitet
- wartet auf den Nutzer
- freut sich über ein Ergebnis
- Fehler/erschöpft

Name, Akzentfarbe und eine einfache Erscheinungsvariante sind anpassbar. Unteragenten erhalten zunächst nur Rolle, Farbe/Icon und Status – keine eigene komplexe Figur.

### P3 – Anpassbare Plattform

Nach einem stabilen Kern:

- weitere Provider-Adapter
- eigene Agentenrollen und Instruktionen
- eigene Tool-Auswahl
- Themes und weitergehende Maskottchen-Anpassung
- exportierbare Setups
- erst danach ein dokumentiertes Drittanbieter-Plugin-System

## 7. Provider-Anbindung

Vorgesehene Wege:

1. **Eigene API-Keys** für offiziell unterstützte APIs
2. **Offizielle OAuth-Anbindungen**, wo der Anbieter Dritt-Apps zulässt
3. **CLI-/Agent-Harness-Adapter** ähnlich T3 Code: Eine isolierte Serverumgebung startet die offiziell installierte und authentifizierte Provider-CLI und normalisiert deren Ereignisse

Vor dem ersten Adapter steht ein kurzer Qualifikationsschritt: Hosted-Runner-Bedingungen, Auth-Lebenszyklus, Streaming, Abbruch, Tool-Ereignisse, Rate-Limits und Kosten werden für den Kandidaten dokumentiert. Erst danach wird der P0-Provider festgelegt.

Jeder Provider-Adapter muss Sessionstart, Nachricht/Streaming, Abbruch und Sessionende abbilden. Rückfragen, Freigaben, Tool-Ereignisse, Modellwechsel und Wiederaufnahme sind deklarierte optionale Fähigkeiten.

Eine einheitliche Oberfläche bedeutet nicht, dass alle Provider dieselben Fähigkeiten besitzen. Abweichungen werden am Adapter normalisiert und in der UI ehrlich angezeigt.

**Nicht vorgesehen:** private Web-Endpunkte nachbauen, Consumer-Web-UIs scrapen oder Anbieterregeln umgehen. Ein normales Abo ist nur nutzbar, wenn der Anbieter dafür einen offiziellen Login-, CLI- oder API-Weg bereitstellt und der Betrieb in unserer Umgebung erlaubt ist.

Referenz für das Harness-Prinzip: [T3 Code – Provider-Architektur](https://github.com/pingdotgg/t3code/blob/d6dbe8dd67facf4a43030993bebb58cc7e7ac141/docs/internals/providers.md) und [Provider-Setup](https://github.com/pingdotgg/t3code/blob/d6dbe8dd67facf4a43030993bebb58cc7e7ac141/docs/user/install.md#providers).

## 8. Berechtigungen und Grenzen

Webseiten, Tool-Ausgaben und Dokumente sind **nicht vertrauenswürdige Eingaben**. Deren Anweisungen dürfen weder Systemregeln noch Berechtigungen ändern. Private, lokale, Link-Local- und Cloud-Metadaten-Netze sind für Browser-Tools gesperrt. Auch ein Leseaufruf benötigt eine Freigabe, sobald dabei Nutzerdaten in URL, Header oder Body offengelegt würden.

### Ohne Einzelbestätigung erlaubt

- öffentliche Seiten ohne Nutzerdaten lesen
- suchen und sicher navigieren
- Inhalte zusammenfassen und vergleichen
- interne Pläne, Entwürfe und Dateien im isolierten Arbeitsbereich erzeugen
- Unteragenten innerhalb der festen Alpha-Limits starten

### Immer vor Ausführung bestätigen

- Nachrichten oder Beiträge senden
- Formulare absenden
- Dateien oder Nutzerdaten nach außen übertragen
- Käufe, Buchungen oder Verträge
- Daten löschen oder bestehende externe Daten verändern
- Zugangsdaten an eine neue Domain weitergeben
- unklare Aktionen mit möglicher realer Außenwirkung

Jede Einmalfreigabe ist an eine unveränderliche Aktions-ID mit Origin, Operation, Payload-/Datei-Digest und maximalen Kosten gebunden, läuft kurzfristig ab und ist bei jeder Änderung erneut einzuholen. Stoppen verwirft offene Freigaben und verhindert neue Tool-Aufrufe; bereits extern ausgeführte Aktionen können nicht automatisch rückgängig gemacht werden. Wo möglich werden Idempotency Keys verwendet.

Alpha-Limits: höchstens drei parallele Unteragenten, genau eine Delegationsebene, 15 Minuten Laufzeit pro Aufgabe und 1 USD Providerkosten pro Aufgabe, soweit messbar. Ein Unteragent darf keine weiteren Unteragenten starten. Diese Grenzen können in P0 nicht erhöht werden.

## 9. Erinnerungen

P0-Regeln:

- Nur explizites „Merk dir …“ wird gespeichert.
- Passwörter, Tokens und Zahlungs-Authentifizierungsdaten werden nie als Erinnerung gespeichert.
- Andere sensible Daten benötigen eine ausdrückliche Bestätigung.
- Jede Erinnerung zeigt Inhalt, Ursprung und Zeitpunkt.
- Der Nutzer kann Erinnerungen anzeigen, bearbeiten, löschen und Memory global pausieren.
- Gelöschte Erinnerungen dürfen nicht weiter in neue Prompts gelangen.
- Provider erhalten nur Erinnerungen, die für die konkrete Aufgabe nötig sind.

Automatische Präferenzvorschläge, Suche und Export folgen erst nach der ersten Alpha.

### Datenlebenszyklus der Alpha

- Chats, Aufgaben und Erinnerungen bleiben bis zur Löschung durch den Nutzer erhalten.
- Browser-Screenshots werden ab P1 nach 7 Tagen gelöscht.
- temporäre Aufgabendateien werden nach 30 Tagen gelöscht.
- Sicherheits-Auditdaten werden 90 Tage aufbewahrt.
- Backups laufen spätestens nach 30 Tagen aus.
- Eine Kontolöschung entfernt aktive Daten sofort und Backups innerhalb ihrer Ablaufzeit.
- Für Kopien bei externen Providern gelten deren Regeln; die App zeigt diese Grenze vor der Verbindung an.

## 10. Oberfläche

Hauptnavigation mit möglichst wenigen Bereichen:

1. **Chat** – Hauptinteraktion, Rückfragen, Freigaben und Ergebnisse
2. **Aktivität** – laufende und vergangene Aufgaben samt Unteragenten
3. **Lilith** – Erscheinung, Verhalten und Erinnerungen
4. **Einstellungen** – Provider, Tools, Datenschutz und Konto

Grundregeln:

- Dark Mode zuerst, WCAG-kontraste und Dynamic Type berücksichtigen
- technische Logs standardmäßig verborgen
- Status verständlich statt verspielt formulieren
- Push-Mitteilungen nur für Ergebnis, Rückfrage, Freigabe oder Fehler
- jede laufende Aufgabe ist stoppbar

## 11. Technischer Vorschlag

Noch nicht beschlossen, aber passend zum gewünschten Umfang:

- **Mobile:** Expo/React Native für iOS und Android
- **Backend:** ein modularer Monolith statt Microservices
- **Kommunikation:** HTTPS plus Streaming-Verbindung
- **Persistenz:** relationale Datenbank für Nutzer, Chats, Aufgaben, Freigaben und Erinnerungen
- **Runner:** isolierte Linux-Prozesse/Container für Provider-CLIs und Browser
- **Browser:** Playwright-basierter, kurzlebiger Browser-Worker
- **Dateien:** objektbasierter Speicher mit Ablauf- und Löschregeln

Backend und Worker dürfen auf demselben privaten Alpha-Server laufen, aber jeder Browser-/CLI-Job läuft ab P0 in einem kurzlebigen, nicht privilegierten Container: kein Host-Dateisystem, kein Container-/Host-Socket, keine Backend-Secrets, feste CPU-/RAM-/Zeitlimits, eingeschränkter Netzwerkzugriff und Vernichtung nach Abschluss.

Provider-Secrets werden ab P0 serverseitig verschlüsselt, in Logs redigiert und nur über einen Credential-Broker für den konkreten Job bereitgestellt. OAuth verwendet minimale Scopes, State und PKCE, sofern unterstützt, sowie Widerruf. Rohsecrets gelangen weder in Modellprompts noch in allgemeine Browserprozesse.

Vor eingeladenen Testern kommen zusätzlich nachgewiesene Mandantentrennung, pro Nutzer getrennte Secrets, Backups, Rate-Limits und Auditierung hinzu.

## 12. Minimales Datenmodell

- `User`
- `AgentProfile`
- `Conversation`
- `Message`
- `Task` mit optionaler `parentTaskId`
- `TaskEvent`
- `ApprovalRequest`
- `Memory`
- `ProviderConnection`

Weitere Tabellen oder Services entstehen erst durch einen nachgewiesenen Bedarf.

## 13. Akzeptanzkriterien für die erste Alpha

Der definierte Alpha-Smoke-Test belegt:

1. Nach Recommended sind Web-Recherche und Memory aktiv; nach Blank sind beide aus.
2. Der Name Lilith kann geändert werden und bleibt nach Neustart erhalten.
3. Der qualifizierte P0-Provider kann verbunden, geprüft und widerrufen werden, ohne Secrets an Client oder Logs auszugeben.
4. Die Testaufgabe „Vergleiche Testquelle A, B und C und lasse einen Recherche-Unteragenten die gemeinsame Farbe sammeln“ nutzt kontrollierte Fixtures: A enthält Rot/Blau, B Blau/Grün und C Blau/Gelb. Sie erzeugt genau einen sichtbaren Unteragenten und führt `Blau` in den Hauptchat zurück.
5. Die Rückfrage „Soll das Ergebnis kurz oder ausführlich sein?“ zeigt die Optionen `Kurz` und `Ausführlich`. `Kurz` setzt nachweisbar `detailLevel=short` am wartenden Task und setzt denselben Lauf fort.
6. Stoppen setzt die Aufgabe auf `gestoppt`, startet keine weiteren Tools, verwirft offene Freigaben und zeigt kein verspätetes Ergebnis als Erfolg.
7. Die Quellenvergleichs-Aufgabe liefert genau die drei Fixture-Quellen A, B und C im Ergebnis.
8. Nach „Merk dir: Antwortsprache Deutsch“ liefert das Memory-Retrieval für die Testanfrage die gespeicherte Memory-ID. Nach Bearbeitung liefert es den neuen Wert, nach Löschung keine ID; bei pausiertem Memory erzeugt derselbe Speicherbefehl keinen Datensatz.
9. Eine simulierte External-Write-Aktion erzeugt vor Ausführung eine gebundene Freigabe. Ablehnung führt zu null Aufrufen, Freigabe zu genau einem. Änderung von Origin, Operation, Payload-/Datei-Digest oder Kostenlimit sowie Ablauf der Freigabe blockiert die Ausführung und verlangt eine neue Freigabe.
10. Nach App-Neustart zeigt eine zuvor laufende Aufgabe ihren serverseitig persistierten Zustand statt neu zu starten oder zu verschwinden.

Automatisierte Sicherheits- und Lebenszykluschecks belegen zusätzlich:

11. Loopback-, private, Link-Local- und Cloud-Metadaten-Ziele werden vor einem Netzwerkaufruf blockiert; eine Anfrage mit markierten Nutzerdaten in URL, Header oder Body wartet auf Freigabe.
12. Ein vierter paralleler Unteragent und jede rekursive Delegation werden abgewiesen; Laufzeit- und messbares Kostenlimit setzen die Aufgabe auf `pausiert` und verhindern weitere Arbeit.
13. Ein Runner läuft nicht als root, sieht weder Host-Dateisystem noch Host-/Container-Socket oder Backend-Umgebung und wird nach Abschluss samt temporären Job-Secrets zerstört.
14. Ablaufjobs löschen eine temporäre Aufgabendatei nach 30 Tagen und Auditdaten nach 90 Tagen, ohne aktive Chat- oder Memory-Daten zu löschen. Die Screenshot-Frist wird mit P1 getestet.

## 14. Nicht-Ziele der ersten Alpha

- offene Plugin-Plattform oder Marketplace
- frei begehbare 2D-/3D-Spielwelt
- individuelle animierte Figuren für jeden Unteragenten
- vollständige Desktopfernsteuerung
- alle Modellanbieter
- Teams, Organisationen und gemeinsame Agenten
- selbstlernendes Modelltraining auf Nutzerdaten
- komplexe dauerhafte Berechtigungsregeln
- Cloud und Self-hosting gleichzeitig als voll unterstützte Produkte
- Sprachaufnahme oder Sprachchat

## 15. Offene Produktentscheidungen

1. Welcher Provider gewinnt den P0-Qualifikationsschritt?
2. Welche zusätzlichen Tools gehören nach P0 in Recommended?
3. In welcher Roadmap-Phase soll Spracheingabe geprüft werden?
4. Welche Aufbewahrungszeiten sollen vor einer öffentlichen Beta geändert werden?

## 16. Reihenfolge der Umsetzung

1. Provider-Kandidaten qualifizieren und P0-Provider festlegen
2. Vertikaler Chat-Slice mit diesem Provider
3. Aufgaben- und Unteragenten-Lifecycle
4. Rückfragen, gebundene Freigaben und Stoppen
5. explizite Erinnerungen und kuratierte Web-Recherche
6. P0-Smoke-Test abschließen
7. isolierten Browser-Worker als P1 bauen
8. Lilith-Zustände und einfache Anpassung als P2 ergänzen
9. zweiten Provider als Beweis der Adaptergrenze anbinden
10. weitere Customization erst nach Alpha-Feedback
