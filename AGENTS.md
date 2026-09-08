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

- Orchestrator: GPT-6 Astra mit Thinking-Level `medium`.
- Delegierte Cursor-Worker: Cursor Grok 4.6 mit `xhigh` über `scripts/cursor-grok.ps1`.
- Grok läuft standardmäßig read-only (`ask` oder `plan`). Schreibende Läufe verwenden einen Issue-Branch; parallele schreibende Läufe zusätzlich einen eigenen Worktree.

## Implementierung

- Erst bestehende Patterns prüfen, dann die kleinste korrekte Änderung bauen.
- Keine spekulativen Abstraktionen, Microservices oder Dependencies.
- Sicherheits-, Datenschutz-, Accessibility- und Datenverlustschutz nicht vereinfachen.
- Jede nicht triviale Logik erhält den kleinsten sinnvollen automatisierten Test.
