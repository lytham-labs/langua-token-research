# Langua Token Research

A simulation suite for analyzing and comparing context management strategies in the Langua language-learning chat application, focused on API token usage efficiency.

## Overview

This project models five different context management strategies for chat applications and compares their token usage characteristics across various conversation lengths and message styles. The goal is to identify optimal strategies for the Langua `langua-chat-worker` and quantify the token cost of the current implementation.

## Project Structure

```
langua-token-research/
├── src/
│   ├── tokenizer.js               # Token counting (tiktoken cl100k_base)
│   ├── conversation-simulator.js  # Realistic conversation generation
│   ├── simulate.js                # Main simulation runner
│   ├── analyze.js                 # Analysis & report generation
│   ├── charts.js                  # ASCII chart generation
│   └── strategies/
│       ├── truncation-old.js      # OLD: system + 1 user message
│       ├── truncation-window.js   # Sliding window (N messages)
│       ├── summarization-current.js # Current Langua strategy
│       ├── summarization-hybrid.js  # Hybrid: capped summary + window
│       └── no-management.js       # No strategy (unbounded baseline)
├── results/
│   ├── raw-results.json           # Raw simulation output
│   ├── analysis.json              # Computed analysis
│   └── summary-report.md          # Human-readable findings
└── README.md
```

## Strategies Modeled

### 1. `truncation-old` — Pre-Summarization (Historical Baseline)
The original Langua approach before summarization was introduced.
- **Context sent**: System prompt + current user message only
- **History preserved**: None
- **Token cost**: Flat, very low (~400-600 tokens/turn)
- **Quality**: Poor — model has no memory of conversation

### 2. `truncation-window-N` — Sliding Window
Keep the last N messages at all times. No summarization.
- **Context sent**: System prompt + last N messages
- **Configurations**: N = 4, 8, 12, 20, 40
- **Token cost**: Grows until N messages accumulated, then plateaus
- **Quality**: Good for recent context, loses older history

### 3. `summarization-current` — Current Langua Strategy
The production implementation as of 2025.
- **Context sent**: System prompt + summary (2nd system msg) + last 40 messages
- **Summary**: Generated once at trigger turn (10, 20, or 30), fixed size, reused each turn
- **Pre-trigger bug**: Without summary, ALL messages are included (unbounded)
- **Token cost**: High fixed overhead from summary + large recent window

### 4. `summarization-hybrid` — Hybrid Strategy (Proposed Optimization)
Capped summary + smaller sliding window.
- **Context sent**: System prompt + capped summary (≤500 tokens) + last N messages
- **Configurations**: N = 4, 8, 12, 20
- **Token cost**: Lower than current strategy due to smaller window and capped summary
- **Quality**: Good balance of recent context + semantic history

### 5. `no-management` — No Strategy (Worst Case Baseline)
Include all messages every turn. Shows quadratic growth.
- **Context sent**: System prompt + ALL historical messages
- **Token cost**: O(n²) — grows quadratically with conversation length
- **Use**: Baseline comparison only, never for production

## Current System Issues

1. **No-summary unbounded growth**: When no summary has been generated, the system sends ALL historical messages with no cap. This is O(n²) token growth.

2. **Verbose summaries**: Without explicit token constraints, LLM summaries can be 40-50% of the original conversation size, adding significant overhead on every subsequent turn.

3. **Large recent window**: KEEP_RECENT_MESSAGES = 40 means up to 40 messages of recent history on every call after summarization triggers.

## How to Run

```bash
# Install dependencies
npm install

# Run the simulation (generates results/raw-results.json)
node src/simulate.js

# Run analysis (generates results/analysis.json and results/summary-report.md)
node src/analyze.js

# Or run both at once
npm run run-all
```

## Reading the Results

- `results/raw-results.json`: Full turn-by-turn token counts for every strategy and scenario
- `results/analysis.json`: Aggregated stats, break-even analysis, bloat analysis
- `results/summary-report.md`: Human-readable report with ASCII charts and recommendations

## Simulation Details

- **Token counting**: Uses tiktoken with `cl100k_base` encoding (same as GPT-4/GPT-4o)
- **Conversation styles**:
  - `short`: 15-30 words per user message, concise assistant replies
  - `medium`: 40-80 words per user message, paragraph-length assistant replies
  - `long`: 100-200 words per user message, detailed multi-paragraph replies
- **Realistic scenario**: 35 turns, 70% short / 20% medium / 10% long messages, averaged across 5 runs
- **Summary modeling**:
  - `compact` (~15% of conversation tokens): well-prompted, concise summarization
  - `verbose` (~45% of conversation tokens): unprompted/naive summarization
- **Summarization cost**: One-time API call cost (input at trigger point + output = summary size) is added to total
- **System prompt**: ~400 tokens based on realistic Langua persona template

## Key Metrics

For each strategy and scenario, the simulation records:
- `tokensPerTurn[]`: Token count for each API call
- `totalTokens`: Sum of all API call tokens for the entire conversation
- `cumulativeTokensByTurn[]`: Running total at each turn point
- `summaryCallCost`: One-time cost of generating the summary (for summarization strategies)
