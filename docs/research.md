# Research notes: Jev, Laya, OpenJev — verified landscape

> Compiled 2026-09-23 from primary sources (TypeSafe AI site, Laya HF model
> cards, npm, GitHub). Every number below was read from the cited page at
> fetch time; anything unverified is marked as such.

## The idea: non-autoregressive decision models

LLMs generate tokens autoregressively; a **decision model** runs a single
non-autoregressive pass that directly outputs a distribution over a typed
answer space. TypeSafe AI's Jev calls this architecture **System One** (after
Kahneman's fast/slow thinking). Properties, per TypeSafe's own docs:

- Typed answers only: **Choice** (pick from options), **Score** (level on a
  rubric), **Noul** (calibrated yes/no). No free-form generation.
- 70–500 ms latency, ~$0.042 per million input tokens (orders of magnitude
  below LLM pricing).
- Trained with RLCD (reinforcement learning from calibration data), so the
  probabilities are meant to be taken literally.
- Closed API, waitlist. As of writing: no public key, no published weights.

The wire contract this skill speaks (`POST /v1/systemone`, body
`{state, questions}` → `{answers, usage}`) is the one the open ecosystem
(`laya-serve`) documented as Jev-compatible.

## Laya — the open-weights implementation (primary provider here)

- **Who:** Convai Innovations. **License:** Apache-2.0 weights, code on
  GitHub, npm package `@receptron/laya` (Node 20+).
- **Checkpoints** (ModernBERT-large encoder, ~35ms/question on CPU-class
  hardware per their benchmarks):
  - `convaiinnovations/laya` — English, 421M params
  - `.../laya` multilingual subfolder — 322M params
  - `.../laya` `typed-decisions` subfolder — the Choice/Score/Noul-tuned one
- **Install:** `Laya.load({ subfolder, cacheDir, modelDir })` →
  `systemOne(state, questions)` → `{ answers, usage }`. Weights (~1.7 GB)
  cache under `~/.cache/receptron-laya` (override `LAYA_CACHE`).

### Measured limits (from the HF model cards — the honest part)

- **Zero-shot is near chance.** The typed-decisions card reports **0.362**
  accuracy zero-shot on unseen tasks. Fine-tuning on task data is the
  intended path; zero-shot routing is a demo, not a product.
- **Ships over-confident.** Mean **ECE 0.466** out of the box; per-(question
  type, option count) temperature refit brings it to **0.081**. This is why
  this skill ships a calibrate/eval harness and auto-applies calibration.
- **`noul` label-following bug** (GitHub issue #156): instruction-dependent
  polarity — the model can answer the *opposite* of the asked polarity.
  Workaround used there: force a two-option `choice` question instead of
  `noul` when polarity matters. Revisit when the fix lands upstream.
- **`act_probability` is useless** (issue #185): near-random discrimination
  (AUROC ~0.77); the card says gate on `confidence` instead. This skill
  never reads `act_probability`.
- **>20 options degrade** quality; high-cardinality classification
  (Banking77-style intent sets) is weak. Keep choice sets small (<20,
  ideally <10).
- Multilingual checkpoint: verify per-language before trusting it; the cards
  only benchmark a handful of languages.

## OpenJev family — open reproductions of the Jev recipe

| Model | Base | License | Notes |
| ----- | ---- | ------- | ----- |
| `ZefanCai/Open-Jev-27B-v1.1` | Qwen3-8B→27B MoE (LoRA) | Apache-2.0 | the most serious open attempt; big (27B), GPU territory |
| `openjev/openjev` | — | **CC-BY-NC-4.0** | **non-commercial — local experiments only, never ship** |
| `AlexWortega/openjev` | — | MIT | small community attempt |
| `APUS-OpenJev-v1` | — | Apache-2.0 | APUS's variant |

None of these expose `systemOne` over HTTP out of the box; to use one, wrap
it in a server that answers `/v1/systemone` and point `JEV_BASE_URL` at it.
License rule of thumb: **default to Apache-2.0 artifacts** (Laya,
ZefanCai, APUS); treat CC-BY-NC as local-only.

## TypeSafe Jev API (secondary provider)

- Closed, waitlisted, paid. `https://api.typesafe.ai` is the documented base;
  **unverified** — no key in hand while writing this skill. The `typesafe`
  driver is best-effort until a key arrives, then verify the base URL and
  auth scheme against their docs and fix `DEFAULT_TYPESAFE_BASE` if needed.

## Why this exists as a PAVE skill

PAVE agents burn LLM tokens on decisions that are really classification:
route this message, triage this board post, gate this tool call. A local,
calibrated decision model at those points is ~1000x cheaper and returns a
probability you can gate on. See [integrations.md](integrations.md) for the
concrete wiring patterns.

## Links

- TypeSafe AI — https://www.typesafe.ai (Jev, System One, RLCD writeups)
- Laya project — https://github.com/Receptron (org), `@receptron/laya` on npm
- Laya HF cards — `convaiinnovations/laya` (+ multilingual, typed-decisions subfolders)
- laya-serve — defines the `/v1/systemone` Jev-compatible wire format
- Issues cited: laya #156 (noul polarity), #185 (act_probability)
