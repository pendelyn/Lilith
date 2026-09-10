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
- Orchestrator: GPT-6 Astra mit Thinking-Level `medium`.
- Einfache Git- und Hilfsagenten laufen immer als Luna mit `xhigh`. Recherche, Implementierung, Tests und frisches Review bleiben Grok mit `xhigh`.
- Delegierte Cursor-Worker: Cursor Grok 4.6 mit `xhigh` über `scripts/cursor-grok.ps1`. Grok übernimmt Recherche, Implementierung, Tests, Review und Fixes.
- Review ist ein frischer, separater Grok-Lauf.
- Bei Grok-Ausfall kein stilles Selbstimplementieren und kein Modell-Fallback; den Blocker melden.
- Writer besitzen ihre Issue-Branches und Worktrees.
- Grok läuft standardmäßig read-only (`ask` oder `plan`). Schreibende Läufe verwenden einen Issue-Branch; parallele schreibende Läufe zusätzlich einen eigenen Worktree.

## Implementierung

- Erst bestehende Patterns prüfen, dann die kleinste korrekte Änderung bauen.
- Keine spekulativen Abstraktionen, Microservices oder Dependencies.
- Sicherheits-, Datenschutz-, Accessibility- und Datenverlustschutz nicht vereinfachen.
- Jede nicht triviale Logik erhält den kleinsten sinnvollen automatisierten Test.
