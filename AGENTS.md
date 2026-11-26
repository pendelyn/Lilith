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
- Delegierte GPT/Codex-Worker übernehmen Recherche, Implementierung, Tests, Fixes und Review. Auf Linux (`aria`) verwenden sie die bestehende, über ChatGPT authentifizierte Codex CLI; Prompts kommen über stdin.
- Standard ist read-only: Recherche und Review mit `codex exec -C <worktree> -s read-only -`, schreibende Läufe mit `codex exec -C <worktree> -s workspace-write -`. Writer besitzen ihre Issue-Branches und Worktrees; pro Worktree schreibt nur ein Agent.
- Auf Windows werden bei nicht verfügbarer Codex CLI Pi Codex/GPT-Worker eingesetzt.
- Review erfolgt durch einen frischen, separaten GPT/Codex-Lauf. Der Orchestrator und Git-Subagenten übernehmen weder Implementierung noch fachliches Review.
- Vor Arbeitsbeginn Verfügbarkeit und bestehenden authentifizierten Zugang prüfen. Bei Ausfall oder Unsicherheit stoppen und Nutzer sowie Orchestrator benachrichtigen; kein stilles Selbstimplementieren, kein stiller Modellwechsel und kein Fallback auf kostenpflichtige Add-ons.
- Für UI v4, Issues #79–#86, ersetzt diese GPT/Codex-Richtlinie ausdrücklich die frühere Cursor-Claude-Opus-only-Ausnahme. Auch dort gelten Verfügbarkeits- und Zugangsprüfung, Read-only-Default, Issue-Branch und eigener Worktree, ein Writer, Tests, relevante Checks, Diff-Prüfung, frisches separates Review mit dokumentiertem Ergebnis im PR sowie Merge-Commit. Sicherheits-, Datenschutz-, Accessibility- und Datenverlustschutz bleiben verbindlich.

## Implementierung

- Erst bestehende Patterns prüfen, dann die kleinste korrekte Änderung bauen.
- Keine spekulativen Abstraktionen, Microservices oder Dependencies.
- Sicherheits-, Datenschutz-, Accessibility- und Datenverlustschutz nicht vereinfachen.
- Jede nicht triviale Logik erhält den kleinsten sinnvollen automatisierten Test.
