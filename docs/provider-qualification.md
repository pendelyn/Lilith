# P0-Provider-Qualifikation

**Stand:** 8. September 2026

**Entscheidung:** Codex CLI ist der einzige P0-Pfad. Cursor CLI bleibt bis P3 zurückgestellt.

## Entscheidung in Kürze

Für die private Single-User-Alpha läuft Codex CLI in einem kurzlebigen, vertrauenswürdigen Linux-Runner. Ausschlaggebend sind die offiziell dokumentierte ChatGPT-Authentifizierung auf Headless-/CI-Systemen, automatische Token-Erneuerung, maschinenlesbare JSONL-Ereignisse einschließlich Tokenverbrauch und die native Linux-Sandbox.

Cursor CLI ist technisch ebenfalls headless-fähig. Für langlebige nichtmenschliche Automatisierung verweist Cursor jedoch auf Enterprise-Service-Accounts. Die private Alpha soll weder eine persönliche Anmeldung dauerhaft in einen allgemeinen Dienst einbauen noch allein dafür Enterprise voraussetzen. Cursor wird deshalb nicht aktiviert, bis Issue #24 die Betriebs- und Kontengrenze erneut qualifiziert.

## Vergleich

| Kriterium | Codex CLI | Cursor CLI | P0-Folge |
|---|---|---|---|
| Linux-Installation | Offizieller Installer: `curl -fsSL https://chatgpt.com/codex/install.sh \| sh` | Offizieller Installer: `curl https://cursor.com/install -fsS \| bash` | beide geeignet |
| Persönliche Anmeldung | Browser- oder Device-Code-Login; lokaler Cache kann auf einen vertrauenswürdigen Headless-Runner übertragen werden | Browser-Login; mit `NO_OPEN_BROWSER=1` wird eine URL ausgegeben | beide grundsätzlich möglich |
| Automatisierung | API-Key ist Standard; ChatGPT-Account-Auth wird ausdrücklich als fortgeschrittener Weg für private, vertrauenswürdige CI-Runner beschrieben | User-API-Key funktioniert headless; nichtmenschliche Service-Accounts sind Enterprise | Vorteil Codex für die private Alpha |
| Erneuerung/Widerruf | ChatGPT-Tokens werden während aktiver Nutzung automatisch erneuert; `codex logout` löscht nur den lokalen Cache. Eine belastbare providerseitige Sperre des Refresh-Tokens ist in den geprüften Quellen nicht dokumentiert | `agent status`/`agent logout`; Rotation und zentraler Widerruf sind für Enterprise-Service-Accounts dokumentiert | beide bleiben bis zum Widerrufstest blockiert |
| Streaming | `codex exec --json` liefert JSONL: Thread-, Turn-, Item-, Fehler- und Abschlussereignisse | `--output-format stream-json`, optional `--stream-partial-output` | beide geeignet |
| Tool-Ereignisse | JSONL umfasst Commands, Dateiänderungen, MCP, Websuche und Planänderungen | Stream-JSON enthält Assistant- und Tool-Call-Ereignisse | beide geeignet |
| Ergebnisvertrag | `--output-schema` validiert die Abschlussantwort gegen JSON Schema | JSON/Stream-JSON, aber kein gleichwertiger dokumentierter Abschluss-Schema-Validator | Vorteil Codex |
| Abbruch | Runner beendet den Prozess; ein nicht erfolgreich beendeter Turn wird nicht als Ergebnis übernommen | Runner beendet den Prozess; ein nicht erfolgreich beendeter Lauf wird nicht als Ergebnis übernommen | gleicher eigener Runner-Vertrag nötig |
| Rückfragen/Freigaben | Non-interactive Runs dürfen nicht auf Terminaldialoge warten; Lilith modelliert Rückfragen und externe Freigaben selbst | Print-Modus darf Tools nutzen; `--force` würde Befehle automatisch erlauben und wird nicht verwendet | bei beiden eigener Lilith-Vertrag |
| Isolation | Linux nutzt Landlock und seccomp; ein Permission-Profil kann Lesezugriff auf exakte Pfade verweigern. Dangerous bypass bleibt verboten | Linux-Sandbox unterstützt Pfadregeln und standardmäßig deaktiviertes Netzwerk | beide zusätzlich in kurzlebigem Container/VM isolieren |
| Telemetrie | `turn.completed.usage` dokumentiert Input-, Cache-Input- und Output-Tokens | Stream-Ereignisse liefern Fortschritt; Teamverbrauch ist für Service-Accounts in Analytics/Billing dokumentiert | Codex liefert die bessere P0-Messbasis |
| Mehrfachkonten | Genau ein Alpha-Konto und ein eigener `CODEX_HOME`; keine Umschaltung während eines Tasks | Genau ein Alpha-Konto; belastbare Automationskonten erst über Enterprise-Service-Accounts | Mehrfachkonten sind nicht P0 |

## Nutzungs- und Rechtsgrenze

OpenAI dokumentiert ChatGPT-Account-Auth ausdrücklich für private, vertrauenswürdige CI-Runner. Das belegt technische Unterstützung, beantwortet aber nicht eindeutig, ob eine persönliche Subscription dauerhaft als Backend einer mobil gesteuerten Anwendung eingesetzt werden darf. Lilith teilt oder verkauft das Konto nicht und bleibt in P0 eine private Single-User-Alpha; trotzdem wird diese Lücke nicht als Erlaubnis ausgelegt.

Cursor dokumentiert User-API-Keys für Headless-Läufe, verweist für nichtmenschliche Automatisierung in CI/CD aber auf Enterprise-Service-Accounts. Deshalb qualifiziert die persönliche Cursor-Subscription nicht als P0-Backend.

**Rechtliches Aktivierungsgate:** Vor Issue #8 müssen die dann geltenden OpenAI-Vertragsbedingungen für den konkreten Tarif und diese owner-operated Backend-Nutzung dokumentiert und eindeutig positiv sein oder OpenAI muss die Nutzung schriftlich bestätigen. Bis dahin bleibt auch der gewählte Codex-Pfad deaktiviert. Ein negatives oder unklares Ergebnis verwirft Codex für P0; Cursor oder API-Abrechnung werden nicht stillschweigend aktiviert.

Diese Produktentscheidung ist keine Rechtsberatung.

## Verbindlicher P0-Betrieb

1. Der Runner ist privat, single-user und kurzlebig; öffentliche Repositories oder fremder Code teilen nie dieselbe Credential-Umgebung.
2. Der Credential-Broker stellt den jeweils aktuellen `auth.json`-Stand mit Dateimodus `0600` außerhalb des Workspaces bereit und schreibt die von Codex erneuerte Fassung atomar in den Secret-Store zurück. `auth.json` darf weder Image, Repository, Log noch Ergebnisartefakt erreichen.
3. Ein job-spezifisches Codex-Permission-Profil erlaubt minimale System-Lesezugriffe und Workspace-Schreibzugriff, verweigert sandboxed Commands aber explizit jeden Zugriff auf `CODEX_HOME`, Secret-Volumes und `**/*.env`. `approval_policy=never` verhindert ein Aufweiten zur Laufzeit.
4. Bis parallele Token-Erneuerung nachweislich sicher ist, vergibt der Broker pro Providerkonto nur einen Auth-Lease. Das kann Providerläufe serialisieren, auch wenn Lilith andere Unteragenten parallel verwaltet.
5. Der Runner startet `codex exec --json --ephemeral` mit diesem unveränderlichen Permission-Profil im einzelnen Task-Workspace.
6. Netzwerk ist für sandboxed Commands gesperrt. Weitere Ziele laufen nur über Liliths Tool-Gateway; ausschließlich der Credential-haltende Codex-Prozess erreicht den Provider.
7. JSONL wird in Lilith-Ereignisse normalisiert. Nur ein erfolgreiches `turn.completed` darf den Task erfolgreich abschließen.
8. Stoppen sendet zuerst ein normales Prozesssignal und beendet danach den gesamten Job. Späte Ereignisse werden verworfen.
9. Tokenverbrauch wird erfasst; USD-Kosten werden nur angezeigt, wenn der Provider dafür eine belastbare Zahl liefert. ChatGPT-Limits sind keine garantierte Geldmessung.
10. Rückfragen, externe Aktionen und Freigaben laufen über Lilith. Codex erhält keine Möglichkeit, diese Schranke per Sandbox-Bypass zu umgehen.
11. Pro Alpha-Installation existiert genau ein Providerkonto. Mehrfachkonten bleiben außerhalb P0.
12. Lokales Stoppen, Löschen von `CODEX_HOME` und `codex logout` gelten nicht als providerseitiger Widerruf. Fehlt ein nachweislich wirksamer Remote-Widerruf, bleibt der Provider deaktiviert.

## Aktivierungsgates für Issue #8

Codex darf erst aktiviert werden, wenn ein Linux-Runner-Test nachweist:

- Device-Code- oder über Secret-Storage eingespielte ChatGPT-Anmeldung funktioniert ohne interaktiven Browser im Job.
- Token-Erneuerung samt atomarem Secret-Store-Rückschreiben funktioniert; ein über den dokumentierten providerseitigen Weg widerrufenes Credential führt geschlossen zu einem Auth-Fehler. Vorher gilt der Widerruf als ungeklärt.
- Drei gleichzeitige Startversuche werden durch den Auth-Lease sicher serialisiert oder ein Test beweist konfliktfreie parallele Token-Erneuerung.
- JSONL-Parser verarbeitet mindestens `thread.started`, `turn.started`, `item.*`, `turn.completed`, `turn.failed` und `error`.
- Prozessabbruch beendet den Job und erzeugt keinen erfolgreichen Taskabschluss.
- Workspace-Schreibzugriff bleibt im Workspace; Host-Dateisystem, Container-Socket und Backend-Umgebung sind unsichtbar.
- Ein Negativtest lässt Codex `CODEX_HOME/auth.json`, ein Secret-Volume und eine Workspace-`.env` lesen; alle drei Versuche müssen am Permission-Profil scheitern. Falls nicht, ist Codex für P0 blockiert.

Ein fehlgeschlagenes Gate blockiert die Aktivierung; es gibt keinen stillen Fallback zu Cursor oder zu API-Abrechnung.

## Bewusst nicht behauptet

- Eine ChatGPT-Subscription garantiert weder feste Kapazität noch USD-genaue Kosten.
- Persönliche Cursor-Credentials werden nicht als dauerhaftes Servicekonto behandelt.
- CLI-Sandboxing ersetzt nicht die äußere Container-/VM-Isolation.
- P0 unterstützt keine Kontenwahl und keinen Providerwechsel während eines Tasks.

## Offizielle Quellen

### OpenAI

- [Codex CLI – Installation](https://developers.openai.com/codex/cli)
- [Codex authentication](https://developers.openai.com/codex/auth)
- [Maintain Codex account auth in CI/CD](https://developers.openai.com/codex/auth/ci-cd-auth)
- [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive)
- [Codex CLI reference](https://developers.openai.com/codex/cli/reference)
- [Codex security](https://developers.openai.com/codex/security)
- [Codex permission profiles](https://developers.openai.com/codex/permissions)

### Cursor

- [Cursor CLI authentication](https://cursor.com/docs/cli/reference/authentication)
- [Using Headless CLI](https://cursor.com/docs/cli/headless)
- [CLI parameters](https://cursor.com/docs/cli/reference/parameters)
- [Using Agent in CLI](https://cursor.com/docs/cli/using)
- [Enterprise service accounts](https://cursor.com/docs/account/enterprise/service-accounts)
- [Cursor Terms of Service](https://cursor.com/terms-of-service)
- [Cursor pricing](https://cursor.com/pricing)
