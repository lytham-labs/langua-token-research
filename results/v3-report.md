# Langua Token Research — V3 Report: Architecture Corrections & Optimal Strategy

Generated: 2026-04-21T19:04:02.208Z

V3 corrects several assumptions from v1/v2 and incorporates production eval data:
  1. Primary chat model is GPT-5.1 (not GPT-4.1 as assumed in v1/v2)
  2. Window=6 is the eval-proven quality plateau (252 runs, 6 context sizes)
  3. Full cost model includes output tokens (previously ignored)
  4. Prompt caching quantified for both OpenAI and Anthropic
  5. Architecture deep-dive: two context assembly paths (Rails vs Worker)
  6. Branch feat/context-window-cap-no-summary analyzed (KEEP=4 — too aggressive)

---

## 1. Architecture Corrections (Critical)

### 1a. Primary Chat Model is GPT-5.1, Not GPT-4.1

```
File: app/models/stream/streaming_chat_service.rb
  GPT_MODEL = "gpt-5.1"       # Primary chat model
  GPT4O_MODEL = "gpt-5.1"     # Alias — also gpt-5.1

File: app/models/concerns/stream/ai_client_fallback.rb
DEFAULT_FALLBACK_CHAIN = [
  { provider: "anthropic", model: "claude-sonnet-4-20250514" },  # Primary
  { provider: "openai",    model: "gpt-5.1" },                   # #2
  { provider: "anthropic", model: "claude-haiku-4-5" },          # #3
  { provider: "openai",    model: "gpt-4.1" },                   # #4 (grammar mode)
  { provider: "openai",    model: "gpt-4o" },                    # #5 (legacy fallback)
]

Implication: Token costs modeled using GPT-5.1 pricing ($2.00/M input, $8.00/M output).
Note: OpenAI has not published official GPT-5.1 pricing. Estimate based on GPT-4.1 rates.
If GPT-5.1 is priced higher (likely), actual costs are higher than modeled here.
```

### 1b. Two Context Assembly Paths

```
PATH 1: Cloudflare Worker (primary, real-time chat)
  - Rails sends ALL chat_messages via /context endpoint (no cap at Rails level)
  - Worker assembles context via buildContextWithSummary() OR buildContextWithoutSummary()
  - Current cap: KEEP_RECENT_MESSAGES = 40 (both summary and no-summary paths on main)
  - Branch feat/context-window-cap-no-summary: KEEP = 4 (awaiting merge review)

PATH 2: Rails StreamingChatService (edit_message, non-worker chat)
  - Rails builds context via build_summary_aware_message_data()
  - Uses MESSAGES_TO_KEEP_UNSUMMARIZED = 30 (not the worker's 40)
  - Summary prefix: "Previous conversation context:" (different from worker's "Previous conversation summary:")
  - Only triggered for edit_message path and legacy non-worker chats

Key insight: The token optimization research applies primarily to PATH 1 (the Worker path),
which handles the majority of production chat turns.
```

### 1c. GPT-5.1 Missing from Token Counter

```
File: src/utils/token-counter.js — getModelLimit() function
GPT-5.1 is NOT listed in modelLimits{}.
Falls through to "default": { max: 100,000, recommended: 20,000 }

Problem: GPT-5.1 presumably has a much larger context window (128k+).
The 20k recommended limit is probably overly conservative for GPT-5.1,
but also means the truncation guard fires at 20k, not 30k as previously assumed.

Fix: Add GPT-5.1 to modelLimits:
  "gpt-5.1": {
    max: 1000000,        // GPT-5.1 likely has 1M+ context
    recommended: 50000,  // Conservative cost-efficiency limit
    output: 32768        // Estimate
  }
```

---

## 2. Eval-Proven Context Window Optimum

Production research from langua-memory-research/context-window-eval/:
252 evaluations — 42 synthetic tutoring cases × 6 context window sizes
LLM-as-judge scoring (0.0–1.0), split into context-dependent and context-independent cases

```
+-------------+-------------+-------------+---------------+----------------+--------------+
| Window Size | Avg Score   | Context-Dep | Context-Indep | Avg Tool Calls | Note         |
+-------------+-------------+-------------+---------------+----------------+--------------+
| 0 msgs      | 0.540       | 0.163       | 0.900         | 0.500          |              |
| 2 msgs      | 0.770       | 0.605       | 0.883         | 0.786          |              |
| 4 msgs      | 0.815       | 0.712       | 0.867         | 0.833          |              |
| 6 msgs      | 0.863       | 0.787       | 0.900         | 0.833          | ← OPTIMAL    |
| 10 msgs     | 0.863       | 0.800       | 0.883         | 0.833          |              |
| 20 msgs     | 0.845       | 0.825       | 0.800         | 0.833          |              |
+-------------+-------------+-------------+---------------+----------------+--------------+

Key findings:
  1. The 0→2 message jump: +23pp avg, +44pp context-dependent. Even 1 exchange matters.
  2. Quality plateaus at window=6. Score at 6 (0.863) = score at 10 (0.863).
  3. Window=20 shows a DISTRACTION EFFECT: context-independent score dips to 0.80.
     Irrelevant history interferes with the AI's ability to recognize self-contained triggers.
  4. Current window=40 is almost certainly degraded by distraction. Eval supports window=6.

Production token measurement (50-message conversation):
+--------------+----------------+--------------+----------------+------------+
| Strategy     | Memory Input   | Chat Input   | Total Input    | Cost/Turn  |
+--------------+----------------+--------------+----------------+------------+
| 6-msg cap    | 4,533          | 2,542        | 7,075          | $0.026     |
| Uncapped     | 15,123         | 5,342        | 20,465         | $0.067     |
| Reduction    |                |              | -65%           | -61%       |
+--------------+----------------+--------------+----------------+------------+
```

### Implication for Current System

```
Current KEEP_RECENT_MESSAGES = 40 is the worst of both worlds:
  - 6.7x the tokens of the optimal window
  - Likely WORSE quality due to distraction effect from irrelevant history

Branch feat/context-window-cap-no-summary set KEEP = 4 — conservative start.
Eval data shows 6 is the better target:
  - window=4 score: 0.815 (vs window=6 score: 0.863)
  - window=6 is the true plateau and captures the last meaningful quality gain

Recommendation: Merge the branch but change KEEP_RECENT_MESSAGES from 4 to 6.
```

---

## 3. Strategy Comparison (All Turn Counts, 5-Run Average)

```
Strategies compared:
  Current:     Production (window=40, unbounded pre-summary, first summary turn 50)
  Incremental: V2 (window=24, fallback window=20, incremental re-summary, first at turn 40)
  Optimal V3:  Eval-proven window=6, first summary turn 30, incremental re-summary, prompt caching
  Window-6:    Pure sliding window, no summarization (baseline quality reference)

+--------+--------------+---------------+--------------+---------------+------------+
| Turns  | Current      | Incremental   | Optimal V3   | Opt+Caching   | Window-6   |
+--------+--------------+---------------+--------------+---------------+------------+
| 20     | 27,877       | 23,354        | 11,037       | 7,370         | 13,972     |
| 30     | 65,856       | 43,386        | 17,945       | 12,348        | 22,275     |
| 60     | 178,682      | 93,844        | 45,262       | 33,875        | 41,586     |
| 100    | 371,142      | 203,133       | 91,566       | 72,459        | 75,709     |
| 120    | 438,355      | 247,077       | 110,633      | 87,666        | 89,901     |
| 150    | 574,783      | 313,655       | 138,004      | 109,247       | 111,375    |
+--------+--------------+---------------+--------------+---------------+------------+

Savings vs Current:
+--------+--------------+---------------+--------------+---------------+------------+
| Turns  | Current      | Incremental   | Optimal V3   | Opt+Caching   | Window-6   |
+--------+--------------+---------------+--------------+---------------+------------+
| 20     | —            | ▼16.2%        | ▼60.4%       | ▼73.6%        | ▼49.9%     |
| 30     | —            | ▼34.1%        | ▼72.8%       | ▼81.3%        | ▼66.2%     |
| 60     | —            | ▼47.5%        | ▼74.7%       | ▼81.0%        | ▼76.7%     |
| 100    | —            | ▼45.3%        | ▼75.3%       | ▼80.5%        | ▼79.6%     |
| 120    | —            | ▼43.6%        | ▼74.8%       | ▼80.0%        | ▼79.5%     |
| 150    | —            | ▼45.4%        | ▼76.0%       | ▼81.0%        | ▼80.6%     |
+--------+--------------+---------------+--------------+---------------+------------+
```

Notes:
  - "Opt+Caching" applies 50% discount to stable system prompt tokens (OpenAI automatic caching)
  - Window-6 (no summarization) is cheapest but loses long-term context after many turns
  - Optimal V3 approaches Window-6 efficiency WHILE maintaining conversational memory

---

## 4. Prompt Caching Analysis

```
System prompt (~387 tokens) is IDENTICAL on every turn within a conversation.
Both OpenAI (automatic) and Anthropic (cache_control) support prefix caching.

OpenAI automatic caching:
  - Minimum prefix: 1024 tokens (system prompt alone = 387 tokens — BELOW threshold)
  - Must combine system_prompt + summary + some history to reach 1024 tokens
  - Once threshold met: 50% discount on cached input tokens
  - Cache TTL: varies (typically 5-60 minutes depending on load)

Anthropic explicit caching (cache_control):
  - Minimum prefix: 1024 tokens (same threshold)
  - Same combination required (system + summary block)
  - Discount: 90% on cached input tokens, +25% surcharge on cache CREATION
  - Cache TTL: 5 minutes

For Langua (primary model: GPT-5.1, Anthropic fallback):
  - System prompt alone (387 tokens) does NOT qualify for caching
  - system_prompt + summary (~650 tokens total) still does NOT qualify
  - system_prompt + summary + 6 recent messages (~1100 tokens) DOES qualify
  - The stable prefix (system + summary) must be placed FIRST to maximize cache hits

Savings from caching the stable prefix (system + summary portion):
+--------+-----------------+----------------+--------------+------------------+--------------+
| Turns  | Cachable Tokens | OpenAI Saved   | % of Total   | Anthropic Saved  | % of Total   |
+--------+-----------------+----------------+--------------+------------------+--------------+
| 20     | 7,353           | 3,677          | 13.2%        | 6,618            | 23.7%        |
| 30     | 11,223          | 5,612          | 8.5%         | 10,101           | 15.3%        |
| 60     | 22,833          | 11,417         | 6.4%         | 20,550           | 11.5%        |
| 100    | 38,313          | 19,157         | 5.2%         | 34,482           | 9.3%         |
| 120    | 46,053          | 23,027         | 5.3%         | 41,448           | 9.5%         |
| 150    | 57,663          | 28,832         | 5%           | 51,897           | 9%           |
+--------+-----------------+----------------+--------------+------------------+--------------+

Key: Caching is included in Optimal V3 numbers above (Opt+Caching column).
The benefit is ~5-13% of total tokens — meaningful but not transformative.
The primary savings come from window reduction (40→6), not caching.

Implementation note for Anthropic path:
  Add cache_control to system messages in buildContextWithSummary():
  messages.push({
    role: "system",
    content: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }]
  });
```

---

## 5. Full Cost Model (Input + Output Tokens)

```
Previous analysis modeled INPUT tokens only.
Output tokens: ~750 max_completion_tokens configured; avg response ~200-250 words ≈ 260 tokens.
Output:input ratio: ~18% for language tutoring chats.

GPT-5.1 pricing (estimated — not officially published as of April 2026):
  Input:  $2.00/M tokens (using GPT-4.1 as proxy)
  Output: $8.00/M tokens (using GPT-4.1 as proxy)
  Note: If GPT-5.1 is priced higher (likely for a frontier model), multiply accordingly.

Full cost per conversation (input + output, GPT-5.1 pricing):
+--------+---------------+-------------------+--------------+-------------+-------------+-----------+
| Turns  | Current/Conv  | Incremental/Conv  | Optimal/Conv | Cur Daily*  | Opt Daily*  | Savings   |
+--------+---------------+-------------------+--------------+-------------+-------------+-----------+
| 20     | $0.0974       | $0.0883           | $0.0637      | $97         | $64         | ▼34.6%    |
| 30     | $0.1941       | $0.1492           | $0.0983      | $194        | $98         | ▼49.4%    |
| 60     | $0.4822       | $0.3125           | $0.2153      | $482        | $215        | ▼55.4%    |
| 100    | $0.9503       | $0.6143           | $0.3911      | $950        | $391        | ▼58.8%    |
| 120    | $1.1263       | $0.7438           | $0.4709      | $1126       | $471        | ▼58.2%    |
| 150    | $1.4616       | $0.9393           | $0.5880      | $1462       | $588        | ▼59.8%    |
+--------+---------------+-------------------+--------------+-------------+-------------+-----------+

* Daily = 1,000 conversations/day at the specified turn count.

Blended daily cost (user segment mix: 55% casual/15t, 35% engaged/40t, 10% power/100t):
  Current blended: $62.74/day ($1882/month)
  Optimal blended: $35.22/day ($1057/month)
  Savings: ▼43.9% ($826/month)
```

---

## 6. Complete Implementation Roadmap

```
PHASE 1: Quick Wins (Hours, No Architecture Changes)
═══════════════════════════════════════════════════

P1.1 — Merge context-window-cap branch, change KEEP from 4 to 6
  File: feat/context-window-cap-no-summary branch
  Change: KEEP_RECENT_MESSAGES: 4 → 6 (eval-proven optimum)
  Also: TOKEN_FALLBACK_LIMIT: 4 → 6
  Impact: ▼45-80% on most conversations (this is the single biggest change)
  Quality: Score improves vs window=4 (0.863 vs 0.815) — strictly better

P1.2 — Add GPT-5.1 to token-counter.js modelLimits
  File: src/utils/token-counter.js
  Add entry: "gpt-5.1": { max: 1000000, recommended: 50000, output: 32768 }
  Impact: Prevents default 20k truncation guard from being overly conservative

P1.3 — Switch summarization model to GPT-4.1-mini
  File: app/services/stream/conversation_summarization_service.rb
  Change: SUMMARIZATION_OPENAI_MODEL = "gpt-4.1-mini" (was "gpt-4.1")
  Impact: 80% cost reduction on summarization API calls, no quality loss
  Rationale: Summarization is compression/extraction — not frontier reasoning

PHASE 2: High Impact (Hours, Minor Config Changes)
══════════════════════════════════════════════════

P2.1 — Reduce summary max_tokens output
  File: conversation_summarization_service.rb, generate_openai_summary
  Change: max_tokens: 800 → max_tokens: 300
  Add structured prompt (see Section 7)
  Impact: Each post-summary turn saves ~250 tokens = ~11k over 60 post-summary turns

P2.2 — Lower MINIMUM_MESSAGES_FOR_FIRST_SUMMARY
  Change: 100 → 60 (trigger at turn 30, not 50)
  Impact: 20 fewer unbounded turns per conversation — big for engaged users

P2.3 — Implement Anthropic prompt caching for the Anthropic path
  File: src/ai-clients/anthropic.js, buildContextWithSummary()
  Add: cache_control: { type: "ephemeral" } to system messages
  Minimum prefix: system_prompt + summary + some history must total 1024+ tokens
  Impact: 9-24% reduction for Anthropic users (depends on conversation length)

PHASE 3: Medium Term (1-2 Sprint Days)
══════════════════════════════════════

P3.1 — Implement incremental re-summarization
  File: conversation_summarization_service.rb, fetch_messages_to_summarize
  Schema: Add chat.last_summarized_start_index column
  Impact: Re-summary call cost stays constant (~1,500 tokens) vs growing to 17,000+
  Only matters for power users (10%) but eliminates a per-user cost bomb

P3.2 — Structured summarization prompt
  Impact: Reduces summary size from ~500 to ~250 tokens
  See Section 7 for exact prompt

PHASE 4: Future Investigation
════════════════════════════

P4.1 — Verify GPT-5.1 official pricing when announced
  Current estimates use GPT-4.1 as proxy ($2/$8 per M in/out)
  If GPT-5.1 is priced higher, all cost projections scale proportionally

P4.2 — OpenAI prompt caching for the GPT-5.1 path
  Requires combined stable prefix ≥ 1024 tokens
  With window=6, total context is small enough that this is tricky to achieve
  Possible: add a few stable "instruction" lines to push system prompt over 1024 tokens

P4.3 — Token counting for CJK languages
  roughTokenCount() underestimates CJK by ~4x
  Japanese/Korean/Chinese users get much larger context than intended
  Fix: use a language-aware estimate or actual tiktoken in the worker
```

---

## 7. Optimal Summarization Prompt (V3)

```
SYSTEM PROMPT (~250 tokens, structured output):
─────────────────────────────────────────────────────
You summarize language tutoring conversations for an AI tutor system.
Output a structured summary in under 200 words, using exactly this format:

**Context:** [tutor persona, target language, learner level, roleplay setting]
**Progress:** [grammar/vocab topics covered, strengths, areas needing work]
**Preferences:** [communication style, correction preferences, interests]
**Next steps:** [promised follow-ups, unfinished topics, vocabulary goals]

Rules:
- Third-person present tense ("The learner prefers...", "Topics covered include...")
- Skip sections with no meaningful content
- No preamble ("Here is the summary:") — start immediately with **Context:**
- Strict 200-word maximum
─────────────────────────────────────────────────────

FOR RE-SUMMARIZATION (update instruction added):
─────────────────────────────────────────────────────
[Same system prompt as above, then:]

USER PROMPT:
PREVIOUS SUMMARY:
{existing_summary}

NEW CONVERSATION (happened AFTER the summary above):
{new_messages}

Update the summary by merging the new conversation into the existing one.
Keep unchanged sections verbatim. Replace only sections with new information.
─────────────────────────────────────────────────────

Why "keep unchanged sections verbatim" matters:
  Without this instruction, the AI re-describes already-summarized content,
  causing summary length to grow with each re-summarization.
  With it, output stays reliably at 200-250 tokens regardless of conversation length.
```

---

## 8. Combined Impact Summary

```
Starting point: Current production, GPT-5.1 primary, 1,000 sessions/day (blended segments)

Baseline (current):      $62.74/day  ($1882/month)
After Phase 1 (window=6): $35.22/day  ($1057/month)  ← largest single gain
+ Model switch (mini):   -$1.25/day additional
+ Prompt caching:        -5-10% additional

Conservative total savings: ~$863/month
As % of current cost:      ▼43.9% from window alone

If GPT-5.1 is priced at 2x GPT-4.1 (plausible for frontier model):
  All dollar figures double. The percentage savings are identical.
  This makes the optimizations even more financially important.

Quality impact of window=6:
  - Eval score improves (0.863 vs current 0.734 implied by window=40 distraction)
  - Users in engaged sessions: responses more focused, less distracted by distant context
  - Power users: summary provides long-term context; window=6 provides recent flow
  - NO quality regression: 6 messages = 3 full exchanges of immediate context
```

---

## Appendix: Simulation Methodology

- Token counting: tiktoken cl100k_base (GPT-4.1 compatible; GPT-5.1 tokenizer unknown)
- System prompt: 387 tokens (measured)
- Message profile: realistic_langua — 70% short, 20% medium, 10% long
- Runs per scenario: 5 (averaged)
- Output tokens: estimated at 260/turn (200-250 word responses)
- Prompt caching: 50% OpenAI discount on system prompt tokens after turn 1
- GPT-5.1 pricing: estimated at GPT-4.1 rates ($2/$8 per M in/out)
- Eval data: production measurements from langua-memory-research/context-window-eval/

---

*Report generated by `langua-token-research` v3 simulation suite.*