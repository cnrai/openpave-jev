# Calibration & evaluation guide

Decision models answer with probabilities, and the whole point of using one
is trusting those probabilities. **Out of the box you shouldn't**: Laya's
typed-decisions checkpoint reports mean ECE 0.466 before calibration vs
0.081 after (HF model card). This skill ships the fix as a first-class
workflow.

## The workflow

```
1. collect   labeled examples -> dataset.json
2. calibrate jev calibrate --provider <p> --file dataset.json
3. eval      jev eval       --provider <p> --file dataset.json   (now "(calibrated)")
4. gate      --min-confidence 0.7 in production calls
```

## Dataset format

```json
[
  {
    "state": { "document": "I want a refund, card was charged twice" },
    "questions": {
      "route": { "type": "choice", "criteria": { "billing": "payments and refunds", "support": "technical help", "sales": "buying" }, "instructions": "route this message" }
    },
    "expected": { "route": "billing" }
  },
  {
    "state": { "document": "login broken since yesterday" },
    "questions": { "urgent": { "type": "noul", "instructions": "is this urgent?" } },
    "expected": { "urgent": false }
  }
]
```

- `expected.<name>` is the ground-truth label: the option key (`choice`),
  the level **index** (`score`), or a boolean (`noul`).
- 50+ samples per (question type, option count) is a reasonable floor;
  more for high-stakes gates.

## What calibrate fits

One **temperature** per bucket `"<type>:<optionCount>"` (e.g. `choice:3`,
`noul:2` — the same scheme the Laya card used for its 0.466→0.081 result):

- distributions: `q_i(T) ∝ p_i^(1/T)` (softmax with temperature)
- binary (noul): logit scaling `logit'(p) = logit(p)/T`
- fitted by grid search (0.05–5) + ternary refine, minimizing the negative
  log-likelihood of the true label on **even-index** samples; the
  **odd-index** half is the held-out report you see printed.
- saved to `~/.pave/jev/calibration.json` (override with `JEV_HOME`,
  redirect the file with `--out <path>`), and **auto-applied on every ask**
  unless you pass `--no-calibrate`.

Reading the fit: **T > 1 means the model was over-confident** (flattened),
T < 1 under-confident (sharpened), T ≈ 1 already calibrated.

## What eval measures

Nothing in `jev eval` trusts the model's self-reported confidence — every
metric is computed against your labels:

| Metric | Definition | Read it as |
| ------ | ---------- | ---------- |
| accuracy | argmax == label (noul: p>0.5 side == label) | how often it's right |
| softAccuracy | mean probability assigned to the truth | rewards honest uncertainty |
| brier | mean `(p - y)^2` over the full distribution | 0 is perfect; 0.25 = coin flip on binary |
| ece | 15-bin expected calibration error on max-prob | gap between confidence and correctness |
| scoreMAE | score questions: mean abs level error | rubric drift |

The report breaks metrics down per question type and per question name, and
prints the first 10 errors with expected/got/confidence.

## Gate usage

```bash
jev decide -s "$MSG" -c "billing,support,sales" --min-confidence 0.7 -q
# exit 0 + answer  -> act on it
# exit 3           -> escalate to the LLM / human
```

The gate compares every answer's post-calibration `confidence` against the
threshold. Pick the threshold from the eval report: choose the confidence
bin where accuracy actually reaches your bar.

## Known model bugs to design around

- **`noul` polarity (laya #156):** instruction-dependent inversion. If your
  noul questions misbehave, switch to a two-option choice
  (`-c "yes,no"` style) and compare in eval.
- **`act_probability` (laya #185):** near-random AUROC ~0.77 — this skill
  ignores it entirely; gate on `confidence`.
- **Option count:** keep < 20 (ideally < 10); quality degrades beyond.
- Zero-shot is near chance (0.362) — **always calibrate + eval on your own
  data before gating anything real.** See [research.md](research.md).
