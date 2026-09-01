# Public first-contact Persona gauntlet

## Verdict

Fifteen isolated synthetic users started from public surfaces only on
2026-09-01. Each created a fresh Node project, installed the npm package, used
only `mock/echo`, capped spend at USD 0.01, and attempted a real workflow plus
SDK integration. All fifteen eventually completed at least one checked run;
all successful runs cost USD 0 and emitted a sealed trace.

This is reproducible usability evidence from clean-room agent personas, not a
claim about observed human behavior. A real-human study remains a separate
gate.

## Public state under test

- npm latest: `@supernovae-st/nika-client@0.115.0`
- released engine: `nika 0.116.2`
- reviewed One SDK source: `@supernovae-st/nika-client@0.116.2`
- personas installed only the npm latest package; several independently
  downloaded the public engine release and verified its checksum

The version gap is the dominant onboarding defect. Public `0.115.0` exposes
the retired `LocalNika` plus HTTP surfaces, while the reviewed `0.116.2`
documentation teaches the root `Nika` facade. Users must not be told those APIs
are interchangeable.

## Persona matrix

| Persona | Starting posture | Outcome | First-contact finding |
|---|---|---|---|
| CLI skeptic | weak | recovered | guessed `name`/`prompt`; `nika new` unlocked the path |
| Rival-tool user | medium | succeeded | strong DAG and trace proof; release versions conflict |
| Oracle-first agent | medium | succeeded | schema/template tools worked; npm did not bring the engine |
| Production operator | strong | succeeded | TypeScript integration worked; version and trace custody need clearer setup |
| Nontechnical founder | weak | recovered | first YAML failed; mock success can be mistaken for business value |
| Script migrator | medium | partial parity | syntax migrated; semantic artifact equivalence was not proven |
| Security reviewer | strong | succeeded with finding | boundaries held; `0.115.0` pre-abort handling could escape the caller |
| Syntax learner | weak | partial | inferred envelope failed; one-task scaffold worked |
| Rule author | medium | succeeded | schema/retry worked; business decision and escalation example missing |
| Batch developer | medium | succeeded | five-item fan-out worked; per-item failure path not demonstrated |
| Human-gate integrator | strong | headless succeeded | pause/recovery worked; TTY and `0.115.0` SDK answer path were ambiguous |
| Multi-model builder | medium | succeeded with finding | unknown provider failed late and weakly |
| CI engineer | medium | succeeded | hermetic HOME and exit codes held; engine pin is outside npm 0.115 |
| Beginner debugger | weak | recovered | parse guidance helped; invalid reference needed a concrete repair |
| Team integrator | medium | recovered | confused project `nika.yaml` with executable `*.nika.yaml` |

## Convergent debt

| Priority | Convergence | Evidence | Required closure |
|---|---|---:|---|
| P0 | npm and documentation expose incompatible release trains | 8 personas | publish all four native payloads and root client at 0.116.2, then prove a registry-only install |
| P1 | beginners guess an invalid workflow before finding `nika new` | 5 personas | keep one copy-paste scaffold command above hand-authored YAML |
| P1 | project `nika.yaml` versus executable `*.nika.yaml` is easy to conflate | 3 personas | name both files and the method boundary in quickstarts |
| P1 | npm 0.115 requires a separately discovered engine | 5 personas | One SDK 0.116 native payloads must install in the same npm transaction |
| P1 | multi-step dataflow and dependency examples are too hard to discover | 4 personas | ship a two-task example with a real interpolation and asserted output |
| P1 | mock green can be over-read as business correctness | 4 personas | label rehearsal output and distinguish runtime proof from answer quality |
| P2 | failure examples stop before per-item, provider, or reference repair | 4 personas | add focused negative fixtures with expected codes and recovery steps |
| P2 | trace retention, key location, and cleanup are not one visible runbook | 3 personas | document CI HOME, key custody, retention, and cleanup together |

The Persona abort finding belongs to registry package 0.115.0. It remains a
public defect until the replacement reaches npm, even when a later source
branch carries a regression test. The release gate must therefore judge a
fresh registry-only install rather than source state.
