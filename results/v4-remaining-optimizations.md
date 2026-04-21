# Langua Token Research — V4: Remaining Optimizations

Generated: 2026-04-21

This report covers optimization vectors not yet addressed in v1–v3.
It assumes the v3 Optimal strategy is already deployed (window=6, incremental re-summary,
GPT-4.1-mini for summarization). These are the remaining gains on top of that.

---

## Summary of Remaining Opportunities

```
Priority  | Change                                  | Tokens Saved/Turn | Effort
----------+-----------------------------------------+-------------------+--------
CRITICAL  | Memory tool schema compression          | 749 (80.9%)       | Hours
HIGH      | JSON response overhead elimination      | 78 input + 26 out | Product
HIGH      | GPT-5.1 added to token-counter limits   | Prevents mis-trunc| One-liner
MEDIUM    | Anthropic cache_control (1024+ prefix)  | 5-24% on Anth.    | Half-day
LOW       | Continuation note dedup                 | 30 (one-time)     | Trivial
LOW       | CJK token counting fix                  | Accuracy only     | Hours
```

---

## 1. Memory Tool Schema Compression (CRITICAL — 749 tokens/turn, 80.9% reduction)

### The Problem

Every memory-enabled turn sends 926 tokens of overhead **before any conversation content**:
- System prompt addition: 171 tokens (OpenAI path)
- Tool schema JSON: 755 tokens (including verbose descriptions and examples)

For a typical post-v3 turn (system=387 + window6=800 + user=60 = 1,247 tokens base),
memory overhead adds **74% on top** of the base context.

With window=6, the memory schema is now the LARGEST single cost component per turn.

### Root Cause

The tool schema contains verbose in-schema documentation with examples:
```
"description": `Store and retrieve user information across conversations. Use memory tools sparingly.

Structure: /memories/{category}/{filename}.txt
Categories: goals, family, travel, work, interests, future, other
...
🔍 RECALL (Reading Memories):
Only retrieve memories when:
- User explicitly asks about something you discussed before
...
Examples - Memory Storage:
❌ WRONG: User says "My daughter Sofia just turned 7" → Just respond...
✅ CORRECT: User says "My daughter Sofia just turned 7" → Save to...`
```

This description is 600+ tokens. It's essentially a tutorial in the tool schema — sent on every single turn to a model that already knows how to use tools.

### The Fix: Minimal Tool Schema

```javascript
// CURRENT: 755 tokens
const memoryToolSchemaOpenAI = {
  type: 'function',
  function: {
    name: 'memory',
    description: `Store and retrieve user information across conversations...
    [600+ tokens of documentation and examples]`,
    parameters: { ... }  // ~155 tokens
  }
};

// PROPOSED: 138 tokens (81% reduction)
const memoryToolSchemaMinimal = {
  type: 'function',
  function: {
    name: 'memory',
    description: 'Memory ops: semantic_search/view/create/str_replace/delete. ' +
                 '/memories/{cat}/{file}.txt, 100 chars/memory. Save proactively, recall sparingly.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['view','create','str_replace','insert','delete','rename','semantic_search'] },
        path: { type: 'string' },
        file_text: { type: 'string' },
        old_str: { type: 'string' },
        new_str: { type: 'string' },
        query: { type: 'string' },
        insert_line: { type: 'integer' },
        insert_text: { type: 'string' },
        old_path: { type: 'string' },
        new_path: { type: 'string' }
      },
      required: ['command']
    }
  }
};
```

### Minimal System Prompt Addition

```javascript
// CURRENT: 171 tokens (OpenAI)
const currentAddition = `Memory Tool Behavior: [171 tokens of rules]`;

// PROPOSED: 39 tokens
const minimalAddition = 'Memory tool: save durable personal facts proactively. ' +
  'Recall only when user references prior context. Max 3 ops/turn. ' +
  '/memories/{cat}/{file}.txt, 100 chars.';
```

### Impact

```
Per memory-enabled turn:
  Current:  926 tokens overhead
  Minimal:  177 tokens overhead
  Savings:  749 tokens (80.9%)

For a 60-turn conversation (assume 80% turns are memory-eligible):
  Extra turns with memory: 48
  Tokens saved: 749 × 48 = 35,952 tokens
  Cost savings at GPT-5.1 ($2/M input): $0.072 per conversation
  At 1,000 conv/day × 30 days: ~$2,160/month

Quality concern: Does the model need all those examples and rules?
  - The model has been fine-tuned on tool usage and understands schemas
  - The behaviour rules (sparingly, proactively, max 3 ops) can live in a terse system addition
  - Examples in schema descriptions are redundant for a frontier model
  - Validation: run a brief A/B test (100 conversations) measuring memory op accuracy
```

### Files to Change

```
src/config/memory-tool-schema-openai.js — replace memoryToolSchemaOpenAI description
src/config/memory-tool-schema-optimized.js — already reduced for Anthropic (224 tokens),
  can be further compressed to ~177 tokens using same approach
```

---

## 2. JSON Response Format Overhead (HIGH — structural fix)

### The Problem

Most chat modes use a JSON output format requiring the AI to wrap every response:
```json
{
  "text": {
    "target_language": "Buenas tardes. ¿Cómo estás hoy?",
    "english": "Good afternoon. How are you today?"
  },
  "corrections": [],
  "target_language": "Spanish"
}
```

This JSON wrapper adds **~26 tokens per assistant message**.
Since assistant messages are stored in conversation history and re-sent each turn,
this overhead compounds:
- With window=6: 3 assistant messages in history → 78 extra INPUT tokens per turn
- 30 assistant responses per 60-turn conversation → 780 extra OUTPUT tokens
- 60-turn conversation: 78 × 60 = 4,680 extra input tokens + 780 output tokens

**At GPT-5.1 pricing ($2 input / $8 output per M):**
- Input: 4,680 / 1M × $2 = $0.0094
- Output: 780 / 1M × $8 = $0.0062
- Per-conversation overhead: ~$0.016 from JSON wrapper alone

### Why This Matters More Than It Looks

The JSON overhead also inflates EVERY re-summarization call — the messages-to-summarize
block contains JSON-wrapped assistant messages, making summaries ~8% larger than needed.
The summarization model then has to process and compress JSON formatting metadata.

### The Fix

**Option A (Recommended): Store plain text in history, parse JSON separately**
```
When building context for the AI:
  1. Store message.content as the raw JSON string (current behavior — preserve for corrections display)
  2. When building the window=6 history block, strip JSON wrapper:
     const displayContent = parseJsonMessage(msg.content)?.text?.target_language || msg.content;
  3. Inject as plain text in the context window

Impact: -26 tokens/assistant message × 3 history messages = -78 tokens/turn
Also: cleaner context for the AI to reason over
```

**Option B: Use structured outputs (OpenAI) instead of JSON-in-prompt**
```
Replace the JSON footer in the system prompt with structured_output response_format.
OpenAI structured outputs enforce the schema at the API level — no prompt tokens needed.
The system prompt drops the 44-token JSON footer + the model doesn't need to "think" JSON.
Downside: not available for Anthropic path; requires schema definition on each call.
```

### Files to Change

```
src/utils/helpers.js — strip JSON wrapper when building window context
  In buildContextWithSummary() and buildContextWithoutSummary():
    const content = extractPlainText(msg.content) || msg.content;
```

---

## 3. GPT-5.1 Missing from Token Counter (HIGH — correctness fix)

```javascript
// Current: GPT-5.1 falls through to default (20k recommended limit)
// This is likely too conservative — GPT-5.1 probably has 1M+ context

// Add to token-counter.js getModelLimit():
'gpt-5.1': {
  max: 1000000,        // Estimated; update when OpenAI publishes
  recommended: 50000,  // Conservative cost-efficiency limit (same as Claude Sonnet)
  output: 32768        // Estimate; likely higher
},
'gpt-5': {
  max: 1000000,
  recommended: 50000,
  output: 32768
}

// Impact: Prevents spurious truncation at 20k for power users.
// Also: log a warning if a GPT-5.x model is not in the map.
```

---

## 4. Anthropic Prompt Caching — 1024 Token Threshold (MEDIUM)

### Situation

System prompt alone (387 tokens) does not qualify for Anthropic's 1024-token minimum.
With the optimized memory addition (177 tokens): 387 + 177 = 564 tokens — still not enough.
With a summary (~250 tokens): 387 + 177 + 250 = 814 tokens — still not enough.
With the summary + 1 exchange (~120 tokens): 387 + 177 + 250 + 120 = 934 — close but not quite.

### Fix: Cache the summary + minimum history prefix

```javascript
// In buildContextWithSummary(), mark messages for caching:
// Anthropic requires cache_control on the LAST message that should be cached

function buildContextWithSummaryAnthropicCached(context, messageData) {
  const messages = [];

  // System message 1: system prompt (stable)
  messages.push({
    role: 'system',
    content: [{
      type: 'text',
      text: context.systemPrompt,
      cache_control: { type: 'ephemeral' }  // ← cache everything up to here
    }]
  });

  // System message 2: summary (changes every ~20 turns)
  if (context.conversationSummary) {
    messages.push({
      role: 'system',
      content: [{
        type: 'text',
        text: `Previous conversation summary:\n${context.conversationSummary}`,
        cache_control: { type: 'ephemeral' }  // ← second cache point
      }]
    });
  }

  // Recent messages — not cached (changes every turn)
  const recent = messageData.filter(m => m.role !== 'system').slice(-6);
  messages.push(...recent.map(m => ({ role: m.role, content: m.content })));

  return messages;
}

// Pricing impact (Anthropic Claude Sonnet 4 at $3/M input, $0.30/M cached):
// System prompt (387 tokens) cached: saves $2.70/M = 90% on those tokens
// Summary (250 tokens) cached: saves $2.70/M per turn after first creation
// Combined savings per turn: (387 + 250) / 1M × $2.70 = $0.00172/turn
// 60-turn conversation: ~$0.10 savings (meaningful for Anthropic path users)
```

### Requirement

Total tokens up to and including the last cache_control marker must be ≥ 1024.
Measure: system prompt (387) + optimized memory addition (177) = 564 — below threshold.
Add summary (250): 564 + 250 = 814 — still below.
Need ~210 more tokens. Options:
  a) Add first 1-2 recent messages to the cached prefix
  b) Accept caching only kicks in for post-summary turns (when summary pushes over 1024)
  c) Add a stable "persona extension" block to the system prompt (add content, not waste)

Recommendation: accept (b). Post-summary turns (the expensive ones) get the cache benefit.

---

## 5. Message History Sent from Rails — No-Cap Path Still Applies

### Architecture Note

Rails' `/context` endpoint sends ALL chat_messages with no limit:
```ruby
# chats_controller.rb
decorated_messages = @chat_decorator.messages
messages = decorated_messages.map { |msg| { id: ..., content: ..., role: ..., created_at: ... } }
```

The worker then caps this via `buildContextWithSummary` (window=6 after v3 changes).
But the Rails-to-Worker network payload still contains ALL messages.

### Fix: Add a Rails-side cap on the /context endpoint

```ruby
# chats_controller.rb — add a limit to reduce payload size
MAX_MESSAGES_FOR_CONTEXT = 100  # Enough for any window size + some buffer

decorated_messages = @chat_decorator.messages.last(MAX_MESSAGES_FOR_CONTEXT)
```

### Impact

For a 500-message conversation (hypothetical power user):
- Current: Rails sends 500 messages over network
- Proposed: Rails sends 100 messages over network
- Network bytes saved: ~400 messages × ~200 bytes = ~80 KB per request
- Not a token cost issue but affects latency and Rails DB query cost
- The worker's window=6 cap already handles token efficiency; this fixes network overhead

---

## 6. CJK Language Token Counting (LOW — accuracy fix)

### Problem

```javascript
// token-counter.js roughTokenCount:
static roughTokenCount(text) {
  return Math.ceil(str.length / 4);  // assumes 4 chars/token
}
```

Japanese, Chinese, Korean characters are single characters but multiple tokens:
- Japanese hiragana: ~1 token/character
- Japanese kanji: ~1-2 tokens/character
- Chinese characters: ~1 token/character

The `/4` formula underestimates CJK token counts by ~3-4x.

Result: Japanese/Korean/Chinese users hit context limits much later than intended,
effectively sending 3-4x more tokens per turn than the truncation guard expects.

### Fix

```javascript
static roughTokenCount(text) {
  if (!text) return 0;
  const str = typeof text === 'string' ? text : JSON.stringify(text);

  // Detect CJK content (Unicode blocks for Chinese, Japanese, Korean)
  const cjkChars = (str.match(/[\u3000-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/g) || []).length;
  const nonCjkChars = str.length - cjkChars;

  // CJK: ~1 token/char; non-CJK: ~1 token/4 chars
  return Math.ceil(cjkChars + nonCjkChars / 4);
}
```

### Impact

```
For a Japanese conversation with 1000 characters of kanji/hiragana:
  Current estimate:   250 tokens
  Actual tokens:      ~800-1000 tokens
  Underestimation:    550-750 tokens per message

For a 40-message history in Japanese:
  Current estimate: ~10,000 tokens → below 30k gate
  Actual tokens:    ~32,000-40,000 tokens → ABOVE 30k gate (should be truncating!)

This is a correctness bug for CJK users that causes them to use 3-4x more tokens
than the system thinks they're using.
```

---

## 7. Consolidated Impact Model (On Top of V3 Optimal)

```
Starting point: V3 Optimal deployed (window=6, incremental re-summary, GPT-4.1-mini)

Additional savings at 1,000 sessions/day, blended user mix, GPT-5.1 pricing:

Change                               | Per-Turn Savings | Monthly @ 1k/day
-------------------------------------|-----------------|------------------
Memory schema compression (80% elig.)| 749 × 0.8 = 599 | ~$2,160
JSON overhead strip in history       | 78 input + 26 out| ~$580
Anthropic caching (Anthropic users)  | ~600 (Anth path) | proportional
GPT-5.1 in token counter             | correctness fix  | prevents regressions
Rails context payload cap            | network/latency  | not token savings
CJK token counting fix               | accuracy fix     | prevents CJK overruns

Total additional monthly savings: ~$2,740 (on top of V3 savings)
Combined V3 + V4 savings vs baseline: ~$4,500+/month at current session volumes
```

---

## 8. Highest-ROI Single Change: Memory Tool Schema Compression

If only one thing gets done from this list:

```
CHANGE ONE LINE:
File: src/config/memory-tool-schema-openai.js
Replace: description: `[600+ token verbose description with examples]`
With:    description: 'Memory ops: semantic_search/view/create/str_replace/delete. /memories/{cat}/{file}.txt, 100 chars/memory. Save proactively, recall sparingly.'

ALSO change: memorySystemPromptAddition
Replace: [171 token rules block]
With:    'Memory tool: save durable personal facts proactively. Recall only when user references prior context. Max 3 ops/turn.'

Expected savings: 749 tokens × ~800 memory-enabled turns/day = 599,200 tokens/day
= 17.9M tokens/month = $35.8/month at $2/M (if 80% of sessions use memory tools)

This is likely conservative — the Anthropic path (currently 959 tokens overhead)
also benefits, and output tokens from tool calls decrease proportionally.
```

---

## 9. The One Thing NOT Yet Measured: Output Token Streaming

### Unmodeled Factor: Response Length Control

GPT-5.1 output is capped at `max_completion_tokens: 750` but average response is ~260 tokens.
The system prompt includes: *"Each reply must be concise - two or three sentences."*

At beginner levels: `text: { verbosity: 'low' }` is set — this may reduce output length.
For intermediate/advanced users, responses may be longer than the 260-token average assumed.

### Potential Optimization

Add level-specific output caps:
```javascript
// In openai.js streamResponse:
const outputCap = {
  'beginner': 200,
  'basic': 250,
  'intermediate': 400,
  'advanced': 600,
};
requestBody.max_completion_tokens = outputCap[userLevel] || 400;
```

This reduces wasted capacity and average output costs by 10-30% for beginner users.

---

*All token counts measured with tiktoken cl100k_base. Pricing estimates based on GPT-5.1 ≈ GPT-4.1 rates.*
*Production eval data from langua-memory-research/context-window-eval/ (252 runs).*
