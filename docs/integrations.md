# Integrating jev into PAVE

Five concrete patterns, cheapest first. All assume the skill is installed
(`pave install ~/pave-apps/openpave-jev`) and calibrated on representative
data (see [calibration.md](calibration.md)).

## 1. Pre-tool guardrail (cheapest win)

Before an agent runs a risky/irreversible bash command, ask a noul gate —
one local pass instead of an LLM round-trip:

```bash
RISK=$(jev noul --provider laya \
  --state "command: git push --force origin main
           repo: shared, protected branch" \
  -i "Is this command destructive or hard to reverse?" \
  --min-confidence 0.75 -q 2>/dev/null)
if [ "$?" = "3" ]; then echo "gate: unsure - escalate"; exit 3; fi
[ "$RISK" = "true" ] && { echo "gate: blocked (risky)"; exit 1; }
```

Calibrate on ~100 labeled (command, risky?) pairs from your own history
first — zero-shot trust is a bug, not a feature.

## 2. Connector router (WhatsApp/Discord inbound)

Route inbound connector messages to the right handler without an LLM:

```bash
TOPIC=$(jev decide --provider laya -s "$INBOUND_TEXT" \
  -c "support: technical problems, billing: payments refunds, sales: buying, social: chat and thanks" -q)
```

Escalate to the LLM only when `--min-confidence` exits 3. Same shape works
for spam/urgent triage with `jev noul`.

## 3. Compaction pre-check

Before paying for a compaction summary, score whether one is needed:

```bash
NEED=$(jev score --provider laya \
  --state "tokens_used: $USED  limit: $LIMIT  last_compact: $AGE_AGO  recent_tool_errors: $N" \
  -l "no,soon,now" -q)
```

A `no`/`soon` answer skips the compaction path entirely; only `now` pays
the summarization cost.

## 4. Board triage

The agent board (`board_list`) accumulates bugs/findings. Score each topic
on urgency to decide what a worker picks next:

```bash
URGENCY=$(jev score --provider laya \
  --state "title: $TITLE  body: $SNIPPET  age_days: $AGE" \
  -l "low,normal,high,urgent" -q)
```

Buckets by `urgency >= high` → claim now; else defer. Reuse the same
labeled set you'd have used to hand-prioritize.

## 5. Laya-vs-Jev A/B on your own labels

When a TypeSafe key arrives, compare providers on the same labeled dataset
before paying per token:

```bash
jev calibrate --provider laya     --file labeled.json
jev eval    --provider laya     --file labeled.json   > laya.txt
jev eval    --provider typesafe --file labeled.json   > jev.txt
diff laya.txt jev.txt   # accuracy / brier / ece, same data, same table
```

`JEV_BASE_URL` (self-hosted laya-serve) slots into the same comparison as a
third arm.

## Pattern rules

1. **Decide → gate → escalate.** The value is in *cheap* decisions with a
   confidence floor; everything below the floor goes to the LLM or a human.
2. **Calibrate before gating.** An uncalibrated threshold is a random gate
   (ECE 0.466 out of the box).
3. **Keep option sets small** (< 10) and reuse the same question wording
   everywhere — wording is part of the input distribution you calibrated on.
4. **Exit code 3 is a feature.** Treat "unsure" as a first-class outcome,
   not an error.
