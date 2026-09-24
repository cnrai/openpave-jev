# jev — typed decisions for PAVE and Claude

Ask **non-autoregressive decision models** for typed answers with calibrated
probabilities: classify, route, score and gate **without an LLM round-trip**.

A decision model ("System One" architecture, Jev-style) doesn't generate text.
You hand it a state and typed questions, and it returns a distribution over a
fixed answer space — in ~35–500 ms, at ~1000x lower cost than an LLM call, with
probabilities you can gate on.

```
jev decide -s "refund not received after 30 days" -c "billing,support,sales" -q
# -> support
```

## The three question types

| Type | Meaning | Answer | Use |
| ---- | ------- | ------ | --- |
| `choice` | pick one of N options | `{ choice, probabilities }` | routing, classification, triage |
| `score`  | level on an ordered rubric | `{ score, probabilities, choice }` | severity, priority, quality |
| `noul`   | calibrated yes/no | `{ noul: P(true) }` | gating, filtering, approval |

All three carry `confidence` (probability of the returned answer) so you can
gate: `--min-confidence 0.7` exits with code 3 when the model is unsure.

## Install

```bash
git clone https://github.com/cnrai/openpave-jev ~/pave-apps/openpave-jev
pave install ~/pave-apps/openpave-jev
```

Verify:

```bash
jev providers
jev decide --provider mock -s "hello" -c "a,b,c" -q
```

## Providers

| Provider | What it is | Setup |
| -------- | ---------- | ----- |
| `laya` | Local open-weights engine ([@receptron/laya](https://www.npmjs.com/package/@receptron/laya), Apache-2.0, ModernBERT-large, ~1.7 GB weights) | `jev setup laya` (Node 20+; weights download on first use) |
| `http` | Any server exposing `POST /v1/systemone` (e.g. self-hosted `laya-serve`) | `export JEV_BASE_URL=http://127.0.0.1:8000` |
| `typesafe` | The [TypeSafe Jev API](https://www.typesafe.ai) (closed, paid) | `export JEV_API_KEY=...` (or `JEV_API_KEY:` in `~/.pave/tokens.yaml`) |
| `mock` | Deterministic fake (hash-seeded) | nothing — `--provider mock` |

Auto-selection order: `JEV_MOCK=1` → `JEV_BASE_URL` → `JEV_API_KEY` → installed
laya → error with guidance. Self-hosted beats the paid API on purpose.

## Commands

```text
jev decide  -s <state> -c "a,b,c"            choice + probability distribution
jev score   -s <state> -l "low,mid,high"     expected level on a rubric
jev noul    -s <state> -i "Is this spam?"    calibrated P(true)
jev ask     -f request.json                  full {state, questions} request
jev eval    -f labeled.json                  accuracy / soft acc / Brier / ECE
jev calibrate -f labeled.json                fit temperatures, save calibration
jev providers                               provider status
jev setup laya                              install the local Laya engine
```

State comes from `--state <text|@file|->`, `--state-json <json|@file>`, or
piped stdin. `--file` accepts a literal JSON string, `@path`, `-` (stdin), or a
bare path. `--no-calibrate` bypasses the saved calibration; `-q/--quiet`
prints just the answer value.

Exit codes: `0` ok · `1` error · `2` usage · `3` below `--min-confidence`.

## Configuration

| Variable | Meaning |
| -------- | ------- |
| `JEV_API_KEY` | TypeSafe Jev API key (env, or `JEV_API_KEY:` in `~/.pave/tokens.yaml`) |
| `JEV_BASE_URL` | base URL of a `/v1/systemone` server |
| `JEV_PROVIDER` | default provider (`mock|laya|http|typesafe`) |
| `JEV_MOCK` | `1` forces the mock driver |
| `JEV_HOME` | data dir (default `~/.pave/jev`; holds `calibration.json`) |
| `JEV_HTTP_TIMEOUT` | HTTP driver timeout ms (default 30000) |
| `JEV_LAYA_CHECKPOINT` | `english` (default) \| `multilingual` \| `typed-decisions` |
| `LAYA_CACHE` | override the Laya weight cache dir (default `~/.cache/receptron-laya`) |

## Calibration (do this before trusting probabilities)

These models ship **over-confident** — Laya's model card reports mean ECE
0.466 before calibration vs 0.081 after. Collect ~50+ labeled examples, then:

```bash
jev calibrate --provider laya --file labeled.json   # fits one temperature per
                                                    # (question type, option count)
jev eval    --provider laya --file labeled.json     # now reports (calibrated)
```

Calibration auto-applies on every ask (disable per-call with
`--no-calibrate`). Details, dataset format and known limits:
[docs/calibration.md](docs/calibration.md).

## What this is not

- Not an LLM. No generation, no reasoning chains; if you need prose, use a
  normal model and use `jev` for the decision points.
- Not trustworthy zero-shot. Base checkpoints are near chance on unseen tasks
  (Laya typed-decisions: 0.362 accuracy zero-shot) — **evaluate on your own
  labeled data first** (`jev eval`). See [docs/research.md](docs/research.md)
  for the measured numbers and per-checkpoint notes.
- >20 options per choice degrades quality; high-cardinality classification
  (Banking77-style) is weak. Keep option sets small.

## License

MIT. The optional Laya engine weights are Apache-2.0 (Convai Innovations);
`jev setup laya` downloads them on demand. `openjev/openjev` weights are
CC-BY-NC-4.0 — never shipped, local experiments only (see docs/research.md).

## Docs

- [docs/research.md](docs/research.md) — the Jev / Laya / OpenJev landscape, verified numbers, links
- [docs/calibration.md](docs/calibration.md) — temperature calibration, dataset format, known model bugs
- [docs/integrations.md](docs/integrations.md) — five concrete ways to wire `jev` into PAVE
