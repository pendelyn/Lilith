# AGENTS.md

## Arbeitsweise

- Keine Feature-, Fix- oder Dokumentations-Commits direkt auf `main`.
- Jedes GitHub-Issue erhält einen eigenen Branch und einen eigenen Pull Request.
- Mehrere Issues dürfen nur gemeinsam gelöst werden, wenn sie technisch untrennbar oder offensichtlich dieselbe kleine Änderung sind; die Begründung gehört in den PR.
- Branch-Namen beginnen mit `issue/<nummer>-`, PRs verlinken das Issue mit `Closes #<nummer>`.
- Vor jedem Merge: relevante Checks ausführen, Diff prüfen und ein Review-Ergebnis im PR dokumentieren.
- Nach bestandenem Review mit einem Merge-Commit nach `main` mergen; nicht squashen oder rebasen.
- Parallele Writer arbeiten ausschließlich in getrennten Git-Worktrees. Auf einem Worktree schreibt immer nur ein Agent.
- Die einzige Ausnahme für einen direkten `main`-Commit ist der technisch notwendige leere Root-Commit, mit dem das Repository initialisiert wurde.

## Agenten

- Rollenregel (dauerhaft, ausdrücklich vom Nutzer verlangt): Der Orchestrator koordiniert, weist Arbeit zu, synthetisiert Ergebnisse und verwaltet Abnahme sowie GitHub-Lebenszyklus. Er implementiert keinen Code und behebt keine Fehler selbst.
- Orchestrator: GPT-6 Sol mit Thinking-Level `high`.
- Subagenten für Git: GPT-6 Luna.
- Delegierte Cursor-Worker: Cursor Grok 4.7 mit `xhigh` über `scripts/cursor-grok.ps1` (Windows) oder `scripts/cursor-grok.sh` (Linux; Prompt über stdin, Standard `--mode ask`). Grok übernimmt Recherche, Implementierung, Tests, Review und Fixes. Aufruf nur über die Shell, ohne `timeout` und nicht über `ctx_execute` (dort endet der Lauf nach 120s). Stderr zeigt Fortschritt und alle 20s `cursor-grok: waiting`; Stdout ist erst am Ende eine JSON-Zeile. Ein Lauf dauert oft 30–45 Minuten. Stille auf Stdout ist kein Hänger. Verbindungsabbrüche zu `agent` wiederholt die CLI selbst.
- Review ist ein frischer, separater Grok-Lauf.
- Bei Grok-Ausfall kein stilles Selbstimplementieren und kein Modell-Fallback; den Blocker melden.
- Writer besitzen ihre Issue-Branches und Worktrees.
- Grok läuft standardmäßig read-only (`ask` oder `plan`). Schreibende Läufe verwenden einen Issue-Branch; parallele schreibende Läufe zusätzlich einen eigenen Worktree.
- Ausnahme ausschließlich für UI v4, Issues #79–#86 (ausdrücklich vom Nutzer genehmigt): Recherche, Implementierung, Tests, Fixes und frisches separates Review nur über Cursor Claude Opus 5.5 im monatlichen Cursor-Abo-Kontingent, nicht über GPT oder Grok; keine kostenpflichtigen Add-ons aktivieren. Diese Ausnahme hat Vorrang vor widersprüchenden Grok-Worker- und Review-Regeln; außerhalb von #79–#86 bleiben diese Regeln unverändert.
- Vor jedem UI-Arbeitsbeginn an #79–#86 prüfen, dass Cursor Claude Opus 5.5 unter seinem tatsächlichen Identifier (derzeit `claude-opus-5-5-xhigh`) verfügbar ist und über das monatliche Cursor-Abo-Kontingent läuft, ohne kostenpflichtige Add-ons. Bei Nichtverfügbarkeit oder Unsicherheit stoppen und Nutzer sowie Orchestrator benachrichtigen; kein stiller Fallback. Orchestrator und Git-Subagenten bleiben unverändert und implementieren oder reviewen die UI von #79–#86 nicht. Branch- und Worktree-Pflicht, Tests, separates Review, Merge-Commit und der Read-only-Default (`ask` oder `plan`) gelten auch für Opus.

## Implementierung

- Erst bestehende Patterns prüfen, dann die kleinste korrekte Änderung bauen.
- Keine spekulativen Abstraktionen, Microservices oder Dependencies.
- Sicherheits-, Datenschutz-, Accessibility- und Datenverlustschutz nicht vereinfachen.
- Jede nicht triviale Logik erhält den kleinsten sinnvollen automatisierten Test.
