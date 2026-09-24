---
name: jev
description: Use jev for typed decisions with calibrated probabilities — classify, route, score, or gate items in bulk where per-item LLM calls would be slow or costly. jev is a CLI over non-autoregressive decision models (local Laya engine, any Jev-compatible server, or mock); every question returns a probability distribution over a fixed answer space plus a confidence you can gate on with thresholds. Evaluate and calibrate the decision model on labeled datasets before trusting the numbers. Reach for jev when the user mentions jev, Laya, decision models, bulk classification/routing/scoring, or confidence-threshold gating.
---

# jev — typed decisions from non-autoregressive decision models

Not an LLM and no text generation: you hand it a state plus typed questions
and it returns a distribution over a fixed answer space, in ~35–500 ms at
~1000x lower cost than an LLM round-trip.

## Invocation

```
node ~/.claude/skills/jev/index.js <command>
```

Substitute your actual install path if different.

## Commands

State comes from `-s/--state <text>`, `--state-json <json>`, or piped stdin;
both state flags also accept `@file` and `-` (stdin).

- **decide** — ask a choice question: state in, best option + probability
  distribution out.
  Options: `-s, --state <text>`, `--state-json <json>`, `-c, --choices <"a,b,c">`,
  `--criteria <json>`, `-i, --instructions <text>`, `-n, --name <questionName>`,
  `-p, --provider <mock|laya|http|typesafe>`,
  `--checkpoint <english|multilingual|typed-decisions>`, `--base-url <url>`,
  `--min-confidence <p>`, `--no-calibrate`, `-q, --quiet`
- **score** — ask a score question: expected level on an ordered rubric with
  distribution.
  Options: `-s, --state <text>`, `--state-json <json>`, `-l, --levels <"lo,mid,hi">`,
  `-i, --instructions <text>`, `-n, --name <questionName>`,
  `-p, --provider <mock|laya|http|typesafe>`,
  `--checkpoint <english|multilingual|typed-decisions>`, `--base-url <url>`,
  `--min-confidence <p>`, `--no-calibrate`, `-q, --quiet`
- **noul** — ask a yes/no question: calibrated P(true).
  Options: `-s, --state <text>`, `--state-json <json>`, `-i, --instructions <text>`,
  `-n, --name <questionName>`, `-p, --provider <mock|laya|http|typesafe>`,
  `--checkpoint <english|multilingual|typed-decisions>`, `--base-url <url>`,
  `--min-confidence <p>`, `--no-calibrate`, `-q, --quiet`
- **ask** — send a full request file `{state, questions}` — all question types
  in one forward pass.
  Options: `-f, --file <json>`, `-p, --provider <mock|laya|http|typesafe>`,
  `--checkpoint <english|multilingual|typed-decisions>`, `--base-url <url>`,
  `--no-calibrate`
- **eval** — evaluate a labeled dataset: accuracy, soft accuracy, Brier, ECE
  per primitive and per question.
  Options: `-f, --file <labeled.json>`, `-p, --provider <mock|laya|http|typesafe>`,
  `--checkpoint <english|multilingual|typed-decisions>`, `--base-url <url>`,
  `--no-calibrate`, `--json`
- **calibrate** — fit per-bucket temperatures on a labeled dataset and save to
  `JEV_HOME/calibration.json` (applied automatically afterwards).
  Options: `-f, --file <labeled.json>`, `-p, --provider <mock|laya|http|typesafe>`,
  `--checkpoint <english|multilingual|typed-decisions>`, `--base-url <url>`,
  `-o, --out <path>`
- **providers** — show driver status: which providers are available and why.
  No options.
- **setup** — install optional engines (currently: laya = @receptron/laya ONNX
  runtime).
  Options: `-e, --engine <laya>`, `--skip-check`

## Output shapes

JSON envelope on stdout: `{ provider, answer, usage, latency_ms }`. The
`answer` object per command:

- `decide` → `{ choice, probabilities, confidence }`
- `score` → `{ score, choice, probabilities, confidence }`
- `noul` → `{ noul, confidence }`

`-q/--quiet` prints just the answer value (the choice, the score, or P(true)).

## Exit codes

- `0` ok
- `1` error
- `2` usage
- `3` below `--min-confidence`

## Engine on-ramps (mandatory)

A fresh clone errors on every command until ONE of these is in place:

1. `node <install-path>/index.js setup laya` — one-time local engine
   (`@receptron/laya` via npm; ~1.7 GB weights download from Hugging Face on
   first inference; cached in `~/.cache/receptron-laya` or `LAYA_CACHE`).
2. `export JEV_BASE_URL=...` — hosted Laya / Jev-compatible server, zero
   local install.
3. `-p mock` — deterministic fake for smoke tests.

## Guidance

- Keep option sets small (≤ ~20 options per choice question); larger sets
  degrade quality.
- Don't trust probabilities before `calibrate` — these models ship
  over-confident.
- Bulk work = loop in a script; each call is a single forward pass.

## Pointers

- `docs/calibration.md` — dataset format, temperature fitting, known limits
- `docs/integrations.md` — provider and server integrations
- `docs/research.md` — the Jev / Laya / OpenJev landscape, measured numbers
