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
| Erneuerung/Widerruf | ChatGPT-Tokens werden während aktiver Nutzung automatisch erneuert; `codex logout` löscht den Cache | `agent status`/`agent logout`; Rotation und zentraler Widerruf sind für Enterprise-Service-Accounts dokumentiert | Codex vollständiger dokumentiert |
| Streaming | `codex exec --json` liefert JSONL: Thread-, Turn-, Item-, Fehler- und Abschlussereignisse | `--output-format stream-json`, optional `--stream-partial-output` | beide geeignet |
| Tool-Ereignisse | JSONL umfasst Commands, Dateiänderungen, MCP, Websuche und Planänderungen | Stream-JSON enthält Assistant- und Tool-Call-Ereignisse | beide geeignet |
| Ergebnisvertrag | `--output-schema` validiert die Abschlussantwort gegen JSON Schema | JSON/Stream-JSON, aber kein gleichwertiger dokumentierter Abschluss-Schema-Validator | Vorteil Codex |
| Abbruch | Runner beendet den Prozess; ein nicht erfolgreich beendeter Turn wird nicht als Ergebnis übernommen | Runner beendet den Prozess; ein nicht erfolgreich beendeter Lauf wird nicht als Ergebnis übernommen | gleicher eigener Runner-Vertrag nötig |
| Rückfragen/Freigaben | Non-interactive Runs dürfen nicht auf Terminaldialoge warten; Lilith modelliert Rückfragen und externe Freigaben selbst | Print-Modus darf Tools nutzen; `--force` würde Befehle automatisch erlauben und wird nicht verwendet | bei beiden eigener Lilith-Vertrag |
| Isolation | `workspace-write`; Linux nutzt Landlock und seccomp. Dangerous bypass nur innerhalb einer zusätzlichen isolierten VM | Linux-Sandbox unterstützt Pfadregeln und standardmäßig deaktiviertes Netzwerk | beide zusätzlich in kurzlebigem Container/VM isolieren |
| Telemetrie | `turn.completed.usage` enthält Input-, Cache-, Output- und Reasoning-Tokens | Stream-Ereignisse liefern Fortschritt; Teamverbrauch ist für Service-Accounts in Analytics/Billing dokumentiert | Codex liefert die bessere P0-Messbasis |
| Mehrfachkonten | Genau ein Alpha-Konto und ein eigener `CODEX_HOME`; keine Umschaltung während eines Tasks | Genau ein Alpha-Konto; belastbare Automationskonten erst über Enterprise-Service-Accounts | Mehrfachkonten sind nicht P0 |

## Verbindlicher P0-Betrieb

1. Der Runner ist privat, single-user und kurzlebig; öffentliche Repositories oder fremder Code teilen nie dieselbe Credential-Umgebung.
2. Der Credential-Broker stellt den jeweils aktuellen `auth.json`-Stand mit Dateimodus `0600` in einem pro Job erzeugten Secret-Volume bereit und schreibt die von Codex erneuerte Fassung atomar in den Secret-Store zurück. `auth.json` darf weder Image, Repository, Log noch Ergebnisartefakt erreichen.
3. Bis parallele Token-Erneuerung nachweislich sicher ist, vergibt der Broker pro Providerkonto nur einen Auth-Lease. Das kann Providerläufe serialisieren, auch wenn Lilith andere Unteragenten parallel verwaltet.
4. Der Runner startet `codex exec --json --sandbox workspace-write --ephemeral` im einzelnen Task-Workspace.
5. Netzwerk ist außerhalb des Provider-Endpunkts standardmäßig gesperrt. Weitere Ziele werden nur über Liliths Tool-Gateway freigegeben.
6. JSONL wird in Lilith-Ereignisse normalisiert. Nur ein erfolgreiches `turn.completed` darf den Task erfolgreich abschließen.
7. Stoppen sendet zuerst ein normales Prozesssignal und beendet danach den gesamten Job. Späte Ereignisse werden verworfen.
8. Tokenverbrauch wird erfasst; USD-Kosten werden nur angezeigt, wenn der Provider dafür eine belastbare Zahl liefert. ChatGPT-Limits sind keine garantierte Geldmessung.
9. Rückfragen, externe Aktionen und Freigaben laufen über Lilith. Codex erhält keine Möglichkeit, diese Schranke per Sandbox-Bypass zu umgehen.
10. Pro Alpha-Installation existiert genau ein Providerkonto. Mehrfachkonten bleiben außerhalb P0.
11. Widerruf bedeutet: Job stoppen, Secret-Version sperren, `CODEX_HOME` vernichten und bei Bedarf `codex logout` beziehungsweise den ChatGPT-Sicherheitsdialog verwenden.

## Aktivierungsgates für Issue #8

Codex darf erst aktiviert werden, wenn ein Linux-Runner-Test nachweist:

- Device-Code- oder über Secret-Storage eingespielte ChatGPT-Anmeldung funktioniert ohne interaktiven Browser im Job.
- Token-Erneuerung samt atomarem Secret-Store-Rückschreiben funktioniert; ein widerrufenes Credential führt geschlossen zu einem Auth-Fehler.
- Drei gleichzeitige Startversuche werden durch den Auth-Lease sicher serialisiert oder ein Test beweist konfliktfreie parallele Token-Erneuerung.
- JSONL-Parser verarbeitet mindestens `thread.started`, `turn.started`, `item.*`, `turn.completed`, `turn.failed` und `error`.
- Prozessabbruch beendet den Job und erzeugt keinen erfolgreichen Taskabschluss.
- Workspace-Schreibzugriff bleibt im Workspace; Host-Dateisystem, Container-Socket und Backend-Umgebung sind unsichtbar.
- Weder Prompts noch von Codex gestartete Commands können `auth.json` oder andere Job-Secrets lesen. Falls die Sandbox das nicht erzwingt, ist Codex für P0 blockiert.

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

### Cursor

- [Cursor CLI authentication](https://cursor.com/docs/cli/reference/authentication)
- [Using Headless CLI](https://cursor.com/docs/cli/headless)
- [CLI parameters](https://cursor.com/docs/cli/reference/parameters)
- [Using Agent in CLI](https://cursor.com/docs/cli/using)
- [Enterprise service accounts](https://cursor.com/docs/account/enterprise/service-accounts)
- [Cursor Terms of Service](https://cursor.com/terms-of-service)
- [Cursor pricing](https://cursor.com/pricing)
