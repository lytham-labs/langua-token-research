# Langua Token Research — Context Management Strategy Analysis

Generated: 2026-04-20T21:08:41.446Z

---

## Executive Summary

This report analyzes token usage across five context management strategies for the Langua
language-learning chat application. The analysis covers conversations of 20, 50, and 100
turns across short, medium, and long message styles, plus a realistic mixed-style scenario.

### Key Findings at a Glance

```
Realistic Langua User (35 turns, 70% short / 20% medium / 10% long messages):

  Old strategy (1 msg):          15,299 total tokens   437 avg/turn
  Window-20:                     44,423 total tokens   1,269 avg/turn
  Current Langua (compact sum):  66,377 total tokens   1,832 avg/turn
  Hybrid w12 (compact sum):      38,289 total tokens   1,050 avg/turn
  No-summary BUG (all msgs):     74,919 total tokens   2,141 avg/turn
  No management (unbounded):     74,919 total tokens   2,141 avg/turn
```

---

## 1. Current Langua System Architecture

The current `langua-chat-worker` sends API calls structured as:

```
[system_prompt]          <-- persona, instructions, language config
[summary_system_msg]     <-- "Previous conversation summary:\n<text>" (2nd system msg)
[last 40 messages]       <-- KEEP_RECENT_MESSAGES = 40
[new user message]       <-- current turn
```

**Key parameters:**
- `KEEP_RECENT_MESSAGES = 40`
- `MAX_TOKENS = 30,000` (raised from 20,000 when summarization was added)
- Summary triggers: configurable, injected as second system message
- `truncateMessageData()` kicks in when over 30k tokens → keeps last 40 msgs anyway

**Critical issues identified:**

1. **No-summary bug**: When no summary has been generated, ALL historical messages
   are included with no cap. Token usage grows quadratically (O(n²)) with conversation length.

2. **Verbose summaries**: Without an explicit token budget, summaries can be ~45%
   of the total conversation size, adding significant overhead on every subsequent turn.

3. **40-message window is large**: At medium message length, 40 messages ≈ 5,000–8,000
   tokens of recent history, plus a verbose summary can push per-turn costs very high.

---

## 2. Strategy Definitions

| Strategy | Description | Window | Summary |
|----------|-------------|--------|---------|
| **truncation-old** | Pre-summarization: system + 1 user msg only | 1 msg | None |
| **truncation-window-N** | Sliding window of last N messages | N msgs | None |
| **no-management** | All messages every turn (unbounded) | All | None |
| **current-no-summary-bug** | Current system when no summary triggered | All | None |
| **summarization-current** | System + summary + last 40 msgs | 40 msgs | Once |
| **summarization-hybrid** | System + capped summary (≤500t) + last N | N msgs | Once |

---

## 3. Token Limit Breach Analysis

Without any context management, when does the per-turn token count breach limits?
(100-turn conversation, unbounded no-management strategy)

```
Token Limit Breach Points
═════════════════════════

┌───────────────┬────────────────────────┬────────────────────────┬──────────────────────┐
│ Message Style │ Hits 20k Limit At Turn │ Hits 30k Limit At Turn │ Turn-100 Token Count │
╞═══════════════╪════════════════════════╪════════════════════════╪══════════════════════╡
│ short         │ > Turn 100             │ > Turn 100             │ 3,985                │
├───────────────┼────────────────────────┼────────────────────────┼──────────────────────┤
│ medium        │ > Turn 100             │ > Turn 100             │ 17,926               │
├───────────────┼────────────────────────┼────────────────────────┼──────────────────────┤
│ long          │ Turn 34 (20,631 tok)   │ Turn 50 (30,390 tok)   │ 61,003               │
└───────────────┴────────────────────────┴────────────────────────┴──────────────────────┘
```

**Interpretation:**
- Short messages: very low per-message token count, limits hit late or not at all
- Medium messages: moderate growth, 30k limit typically hit around turn 30-50
- Long messages: aggressive growth — limits can be hit as early as turn 10-20
- Once 30k is hit, `truncateMessageData()` kicks in and keeps last 40 anyway
  (but ALL those tokens were still sent for the prior turns — wasted cost)

---

## 4. Detailed Analysis: 50-Turn Medium Conversation

System prompt: 387 tokens
Total conversation tokens: 8,896 tokens
Compact summary size: 60 tokens
Verbose summary size: 226 tokens

### Total Token Cost by Strategy (50-turn medium conversation)

```
Total Tokens for Entire Conversation (50 turns, medium messages)
────────────────────────────────────────────────────────────────
win-old                       │ ██████ 22.9k tokens
win-window-4                  │ ██████████ 37.1k tokens
sum-hybrid-w4-compact         │ ████████████ 44.7k tokens
sum-hybrid-w4-verbose         │ ██████████████ 51.5k tokens
win-window-8                  │ ██████████████ 53.9k tokens
sum-hybrid-w8-compact         │ ████████████████ 61.4k tokens
sum-hybrid-w8-verbose         │ ██████████████████ 68.2k tokens
win-window-12                 │ ██████████████████ 69.9k tokens
sum-hybrid-w12-compact        │ ████████████████████ 77.5k tokens
sum-hybrid-w12-verbose        │ ██████████████████████ 84.3k tokens
win-window-20                 │ ██████████████████████████ 99.9k tokens
sum-hybrid-w20-compact        │ ████████████████████████████ 107.4k tokens
sum-hybrid-w20-verbose        │ ██████████████████████████████ 114.2k tokens
win-window-40                 │ ███████████████████████████████████████████ 162.3k tokens
sum-current-trigger10-compact │ █████████████████████████████████████████████ 169.2k tokens
sum-current-trigger20-compact │ █████████████████████████████████████████████ 170.3k tokens
```

### Strategy Comparison Table

```
Strategy Comparison: 50 Turns, Medium Messages
══════════════════════════════════════════════

┌─────────────────────────────────────────┬──────────────┬──────────┬───────────────────────┐
│ Strategy                                │ Total Tokens │ Avg/Turn │ vs No-Management      │
╞═════════════════════════════════════════╪══════════════╪══════════╪═══════════════════════╡
│ truncation-old                          │ 22,867       │ 457      │ ▼ 90.6% cheaper       │
├─────────────────────────────────────────┼──────────────┼──────────┼───────────────────────┤
│ truncation-window-4                     │ 37,139       │ 743      │ ▼ 84.7% cheaper       │
├─────────────────────────────────────────┼──────────────┼──────────┼───────────────────────┤
│ summarization-hybrid-w4-compact         │ 44,651       │ 848      │ ▼ 81.6% cheaper       │
├─────────────────────────────────────────┼──────────────┼──────────┼───────────────────────┤
│ summarization-hybrid-w4-verbose         │ 51,457       │ 980      │ ▼ 78.8% cheaper       │
├─────────────────────────────────────────┼──────────────┼──────────┼───────────────────────┤
│ truncation-window-8                     │ 53,888       │ 1,078    │ ▼ 77.8% cheaper       │
├─────────────────────────────────────────┼──────────────┼──────────┼───────────────────────┤
│ summarization-hybrid-w8-compact         │ 61,403       │ 1,183    │ ▼ 74.7% cheaper       │
├─────────────────────────────────────────┼──────────────┼──────────┼───────────────────────┤
│ summarization-hybrid-w8-verbose         │ 68,209       │ 1,315    │ ▼ 71.9% cheaper       │
├─────────────────────────────────────────┼──────────────┼──────────┼───────────────────────┤
│ truncation-window-12                    │ 69,938       │ 1,399    │ ▼ 71.2% cheaper       │
├─────────────────────────────────────────┼──────────────┼──────────┼───────────────────────┤
│ summarization-hybrid-w12-compact        │ 77,458       │ 1,504    │ ▼ 68.1% cheaper       │
├─────────────────────────────────────────┼──────────────┼──────────┼───────────────────────┤
│ summarization-hybrid-w12-verbose        │ 84,264       │ 1,636    │ ▼ 65.3% cheaper       │
├─────────────────────────────────────────┼──────────────┼──────────┼───────────────────────┤
│ truncation-window-20                    │ 99,886       │ 1,998    │ ▼ 58.9% cheaper       │
├─────────────────────────────────────────┼──────────────┼──────────┼───────────────────────┤
│ summarization-hybrid-w20-compact        │ 107,435      │ 2,103    │ ▼ 55.8% cheaper       │
├─────────────────────────────────────────┼──────────────┼──────────┼───────────────────────┤
│ summarization-hybrid-w20-verbose        │ 114,241      │ 2,236    │ ▼ 53.0% cheaper       │
├─────────────────────────────────────────┼──────────────┼──────────┼───────────────────────┤
│ truncation-window-40                    │ 162,295      │ 3,246    │ ▼ 33.2% cheaper       │
├─────────────────────────────────────────┼──────────────┼──────────┼───────────────────────┤
│ summarization-current-trigger10-compact │ 169,225      │ 3,339    │ ▼ 30.3% cheaper       │
├─────────────────────────────────────────┼──────────────┼──────────┼───────────────────────┤
│ summarization-current-trigger20-compact │ 170,340      │ 3,325    │ ▼ 29.9% cheaper       │
├─────────────────────────────────────────┼──────────────┼──────────┼───────────────────────┤
│ summarization-current-trigger20-verbose │ 175,486      │ 3,425    │ ▼ 27.8% cheaper       │
├─────────────────────────────────────────┼──────────────┼──────────┼───────────────────────┤
│ summarization-current-trigger10-verbose │ 176,031      │ 3,472    │ ▼ 27.5% cheaper       │
├─────────────────────────────────────────┼──────────────┼──────────┼───────────────────────┤
│ summarization-current-trigger30-compact │ 179,675      │ 3,477    │ ▼ 26.0% cheaper       │
├─────────────────────────────────────────┼──────────────┼──────────┼───────────────────────┤
│ summarization-current-trigger30-verbose │ 183,161      │ 3,543    │ ▼ 24.6% cheaper       │
├─────────────────────────────────────────┼──────────────┼──────────┼───────────────────────┤
│ no-management                           │ 242,964      │ 4,859    │ ▲ 0.0% more expensive │
├─────────────────────────────────────────┼──────────────┼──────────┼───────────────────────┤
│ current-no-summary-bug                  │ 242,964      │ 4,859    │ ▲ 0.0% more expensive │
└─────────────────────────────────────────┴──────────────┴──────────┴───────────────────────┘
```

---

## 5. Token Growth Per Turn: 50-Turn Medium Conversation

These charts show tokens-per-turn across the conversation life for key strategies.

```
Tokens Per Turn: No-Management vs Current Strategies
──────────────────────────────────────────────────────────
    9k │                                                ▓▓
       │                                             ▓▓▓  
       │                                          ▓▓▓     
       │                                       ▓▓▓        
    7k │                                    ▓▓▓           
       │                                 ▓▓▓              
       │                             ▓▓▓▓                 
       │                          ▓▓▓                     
       │                       ▓▓▓                        
    5k │                    ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒
       │                 ▒▒▒                            ░░
       │              ▒▒▒                                 
       │           ▒▒▒                                    
    2k │        ▒▒▒                                       
       │     ▒▒▒                                          
       │  ▒▒▒                                             
       │▒▒                                                
     0 │                                                  
       └──────────────────────────────────────────────────

  █ = NoMgmt (unbounded)
  ▓ = No-Summary BUG
  ░ = Current (compact, t=20)
  ▒ = Current (verbose, t=20)
```

```
Tokens Per Turn: Summarization vs Window vs Old
──────────────────────────────────────────────────────────
    4k │                    ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
       │                    ██████████████████████████████
       │                  ▓▓                              
       │                 ▓                                
    3k │               ▓▓                                 
       │              ▓                                   
       │             ▓                                    
       │           ▓▓                                     
       │          ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒      ▒▒▒▒▒▒▒▒▒▒  
    2k │        ▒▒                      ▒▒▒▒▒▒          ▒▒
       │       ▒                                          
       │      ▒░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
       │    ▒▒                                            
    1k │   ▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪
       │ ▪▪                                               
       │••••••••••••••••••••••••••••••••••••••••••••••••••
       │                                                  
     0 │                                                  
       └──────────────────────────────────────────────────

  █ = Current (compact, t=20)
  ▓ = Current (verbose, t=20)
  ░ = Hybrid w12 (compact)
  ▒ = Window-20
  ▪ = Window-8
  • = Old (1 msg)
```

---

## 6. Break-Even Analysis

At what turn does a summarization strategy begin saving tokens vs no-management?
(Accounts for the one-time cost of the summarization API call)

```
50-turn medium conversation break-even points:

  NoMgmt vs Current (compact, trigger 20)
    Break-even at: Turn 28
    At that point: base=81,359, compare=80,848

  NoMgmt vs Hybrid-w12 (compact)
    Break-even at: Turn 12
    At that point: base=17,580, compare=16,990

  NoMgmt vs Window-20
    Break-even at: Turn 11
    At that point: base=15,128, compare=15,068

```

---

## 7. Summary Bloat Analysis

How much of each turn's token budget is consumed by the injected summary?
(Post-trigger turns only, 50-turn medium conversation)

```
Summary Token Overhead per Turn
═══════════════════════════════

┌───────────────────┬────────────────┬───────────────────────┬───────────────────┐
│ Strategy          │ Summary Tokens │ Avg/Turn Post-Trigger │ Summary % of Turn │
╞═══════════════════╪════════════════╪═══════════════════════╪═══════════════════╡
│ trigger10-compact │ 60             │ 3,852                 │ 1.6%              │
├───────────────────┼────────────────┼───────────────────────┼───────────────────┤
│ trigger10-verbose │ 226            │ 4,018                 │ 5.6%              │
├───────────────────┼────────────────┼───────────────────────┼───────────────────┤
│ trigger20-compact │ 60             │ 4,084                 │ 1.5%              │
├───────────────────┼────────────────┼───────────────────────┼───────────────────┤
│ trigger20-verbose │ 226            │ 4,250                 │ 5.3%              │
├───────────────────┼────────────────┼───────────────────────┼───────────────────┤
│ trigger30-compact │ 60             │ 4,065                 │ 1.5%              │
├───────────────────┼────────────────┼───────────────────────┼───────────────────┤
│ trigger30-verbose │ 226            │ 4,231                 │ 5.3%              │
└───────────────────┴────────────────┴───────────────────────┴───────────────────┘
```

---

## 8. Realistic Langua User Scenario

**Scenario:** 35 turns, 70% short / 20% medium / 10% long messages
Averaged across 5 independent conversation simulations for stability.

```
Avg Total Tokens: Realistic Langua User (35 turns, mixed style)
───────────────────────────────────────────────────────────────
win-old                       │ █████████ 15.3k tokens
win-window-4                  │ █████████████ 21.4k tokens
win-window-8                  │ █████████████████ 28.2k tokens
sum-hybrid-w8-compact         │ ███████████████████ 32.4k tokens
win-window-12                 │ █████████████████████ 34.2k tokens
sum-hybrid-w8-verbose         │ ██████████████████████ 36.7k tokens
sum-hybrid-w12-compact        │ ███████████████████████ 38.3k tokens
sum-hybrid-w12-verbose        │ ██████████████████████████ 42.6k tokens
win-window-20                 │ ███████████████████████████ 44.4k tokens
sum-hybrid-w20-compact        │ █████████████████████████████ 48.6k tokens
sum-hybrid-w20-verbose        │ ████████████████████████████████ 52.9k tokens
win-window-40                 │ ██████████████████████████████████████ 62.5k tokens
sum-current-trigger20-compact │ ████████████████████████████████████████ 66.4k tokens
sum-current-trigger20-verbose │ █████████████████████████████████████████ 69.0k tokens
no-management                 │ █████████████████████████████████████████████ 74.9k tokens
current-no-summary-bug        │ █████████████████████████████████████████████ 74.9k tokens
```

```
Realistic Scenario: All Strategies Ranked by Token Cost
═══════════════════════════════════════════════════════

┌─────────────────────────────────────────┬──────────────────┬─────────────────┬───────────────────────┐
│ Strategy                                │ Avg Total Tokens │ Avg Tokens/Turn │ vs No-Mgmt            │
╞═════════════════════════════════════════╪══════════════════╪═════════════════╪═══════════════════════╡
│ truncation-old                          │ 15,299           │ 437             │ ▼ 79.6% cheaper       │
├─────────────────────────────────────────┼──────────────────┼─────────────────┼───────────────────────┤
│ truncation-window-4                     │ 21,425           │ 612             │ ▼ 71.4% cheaper       │
├─────────────────────────────────────────┼──────────────────┼─────────────────┼───────────────────────┤
│ truncation-window-8                     │ 28,191           │ 805             │ ▼ 62.4% cheaper       │
├─────────────────────────────────────────┼──────────────────┼─────────────────┼───────────────────────┤
│ summarization-hybrid-w8-compact         │ 32,414           │ 882             │ ▼ 56.7% cheaper       │
├─────────────────────────────────────────┼──────────────────┼─────────────────┼───────────────────────┤
│ truncation-window-12                    │ 34,153           │ 976             │ ▼ 54.4% cheaper       │
├─────────────────────────────────────────┼──────────────────┼─────────────────┼───────────────────────┤
│ summarization-hybrid-w8-verbose         │ 36,730           │ 1,000           │ ▼ 51.0% cheaper       │
├─────────────────────────────────────────┼──────────────────┼─────────────────┼───────────────────────┤
│ summarization-hybrid-w12-compact        │ 38,289           │ 1,050           │ ▼ 48.9% cheaper       │
├─────────────────────────────────────────┼──────────────────┼─────────────────┼───────────────────────┤
│ summarization-hybrid-w12-verbose        │ 42,605           │ 1,168           │ ▼ 43.1% cheaper       │
├─────────────────────────────────────────┼──────────────────┼─────────────────┼───────────────────────┤
│ truncation-window-20                    │ 44,423           │ 1,269           │ ▼ 40.7% cheaper       │
├─────────────────────────────────────────┼──────────────────┼─────────────────┼───────────────────────┤
│ summarization-hybrid-w20-compact        │ 48,612           │ 1,345           │ ▼ 35.1% cheaper       │
├─────────────────────────────────────────┼──────────────────┼─────────────────┼───────────────────────┤
│ summarization-hybrid-w20-verbose        │ 52,928           │ 1,463           │ ▼ 29.4% cheaper       │
├─────────────────────────────────────────┼──────────────────┼─────────────────┼───────────────────────┤
│ truncation-window-40                    │ 62,546           │ 1,787           │ ▼ 16.5% cheaper       │
├─────────────────────────────────────────┼──────────────────┼─────────────────┼───────────────────────┤
│ summarization-current-trigger20-compact │ 66,377           │ 1,832           │ ▼ 11.4% cheaper       │
├─────────────────────────────────────────┼──────────────────┼─────────────────┼───────────────────────┤
│ summarization-current-trigger20-verbose │ 69,033           │ 1,904           │ ▼ 7.9% cheaper        │
├─────────────────────────────────────────┼──────────────────┼─────────────────┼───────────────────────┤
│ no-management                           │ 74,919           │ 2,141           │ ▲ 0.0% more expensive │
├─────────────────────────────────────────┼──────────────────┼─────────────────┼───────────────────────┤
│ current-no-summary-bug                  │ 74,919           │ 2,141           │ ▲ 0.0% more expensive │
└─────────────────────────────────────────┴──────────────────┴─────────────────┴───────────────────────┘
```

---

## 9. Cost Projections (At Scale)

Assuming 1,000 users each completing a 35-turn conversation per day,
at GPT-4o pricing of $2.50/1M input tokens:

```
Daily cost projection: 1,000 users × 35 turns, medium-ish conversation

  Old (1 msg)                                $  38.25/day   $  1147/mo
  Window-8                                   $  70.48/day   $  2114/mo
  Window-20                                  $ 111.06/day   $  3332/mo
  Hybrid w12 (compact summary)               $  95.72/day   $  2872/mo
  Hybrid w12 (verbose summary)               $ 106.51/day   $  3195/mo
  Current (compact summary, trigger 20)      $ 165.94/day   $  4978/mo
  Current (verbose summary, trigger 20)      $ 172.58/day   $  5177/mo
  Current BUG (no summary ever)              $ 187.30/day   $  5619/mo
  No Management (unbounded)                  $ 187.30/day   $  5619/mo
```

*Note: This is input-token cost only. Output tokens are additional (typically 20-40% of input).*
*Pricing as of mid-2025 for GPT-4o. Actual costs depend on model and pricing tier.*

---

## 10. Multi-Conversation-Length Comparison

How do strategies scale as conversations get longer?
(Medium message style across 20, 50, 100 turns)

```
Token Cost Scaling by Conversation Length (Medium Messages)
═══════════════════════════════════════════════════════════

┌───────────────────────────────┬──────────┬──────────┬───────────┬───────────────┐
│ Strategy                      │ 20 Turns │ 50 Turns │ 100 Turns │ Growth Factor │
╞═══════════════════════════════╪══════════╪══════════╪═══════════╪═══════════════╡
│ win-old                       │ 9,135    │ 22,867   │ 45,624    │ 5.0x          │
├───────────────────────────────┼──────────┼──────────┼───────────┼───────────────┤
│ win-window-8                  │ 20,097   │ 53,888   │ 107,898   │ 5.4x          │
├───────────────────────────────┼──────────┼──────────┼───────────┼───────────────┤
│ win-window-20                 │ 33,100   │ 99,886   │ 205,204   │ 6.2x          │
├───────────────────────────────┼──────────┼──────────┼───────────┼───────────────┤
│ win-window-40                 │ 41,130   │ 162,295  │ 353,684   │ 8.6x          │
├───────────────────────────────┼──────────┼──────────┼───────────┼───────────────┤
│ no-management                 │ 41,130   │ 242,964  │ 912,412   │ 22.2x         │
├───────────────────────────────┼──────────┼──────────┼───────────┼───────────────┤
│ current-no-summary-bug        │ 41,130   │ 242,964  │ 912,412   │ 22.2x         │
├───────────────────────────────┼──────────┼──────────┼───────────┼───────────────┤
│ sum-current-trigger20-compact │ 0        │ 170,340  │ 368,093   │ N/A           │
├───────────────────────────────┼──────────┼──────────┼───────────┼───────────────┤
│ sum-current-trigger20-verbose │ 0        │ 175,486  │ 381,539   │ N/A           │
├───────────────────────────────┼──────────┼──────────┼───────────┼───────────────┤
│ sum-hybrid-w12-compact        │ 28,376   │ 77,458   │ 154,940   │ 5.5x          │
└───────────────────────────────┴──────────┴──────────┴───────────┴───────────────┘
```

---

## 11. Recommendations

### Immediate Fixes (High Priority)

**1. Fix the no-summary unbounded growth bug**
   When no summary exists, fall back to a sliding window (e.g., last 20 messages),
   NOT all messages from history. This is the highest-impact change.

   ```javascript
   // Current (buggy): includes ALL messages when no summary
   const contextMessages = [systemPrompt, ...allHistoricalMessages, newMessage];

   // Fixed: cap at recent window even without summary
   const FALLBACK_WINDOW = 20;
   const recentHistory = allHistoricalMessages.slice(-FALLBACK_WINDOW);
   const contextMessages = [systemPrompt, ...recentHistory, newMessage];
   ```

**2. Cap summary token size**
   Add a `MAX_SUMMARY_TOKENS = 500` cap when storing summaries. Force the summarization
   prompt to produce ≤500 tokens. This prevents verbose summaries from consuming
   10-30% of the per-turn token budget permanently.

   ```javascript
   // Add to summarization prompt:
   "Produce a concise summary in 400 words or fewer (approximately 500 tokens)."
   ```

**3. Reduce KEEP_RECENT_MESSAGES from 40 to 20**
   For most Langua conversations (language tutoring with short messages),
   20 recent messages provides adequate context while halving the recent-history cost.

### Optimization Opportunities (Medium Priority)

**4. Earlier summarization trigger**
   Triggering summarization at turn 10 instead of 20 reduces the pre-summary
   unbounded window to just 10 turns, significantly limiting worst-case exposure.

**5. Consider the Hybrid strategy for power users**
   Hybrid (capped summary ≤500t + last 12 messages) is often the most cost-efficient
   approach with strong context quality. It outperforms both window-only and
   current summarization for conversations longer than ~25 turns.

**6. Differentiate by conversation type**
   - Short daily check-ins (< 15 turns): use window-8 or window-12 only
   - Sustained lessons (15-40 turns): use hybrid with trigger at turn 10
   - Long grammar deep-dives (> 40 turns): use current strategy with compact summary

### What NOT to Do

**7. Do NOT revert to old strategy (1 message)**
   While token-cheap, the old strategy destroys conversation continuity.
   A language tutor that forgets everything said 2 messages ago provides a poor UX.

**8. Do NOT raise MAX_TOKENS above 30k without fixing the no-summary bug**
   Raising the cap without fixing the unbounded growth just delays the explosion
   and increases cost for all intermediate turns.

---

## 12. Strategy Summary Card

```
┌──────────────────────────────────────────────────────────────────────────┐
│                   LANGUA CONTEXT STRATEGY TRADE-OFFS                    │
├───────────────────┬──────────┬──────────┬──────────┬────────────────────┤
│ Strategy          │ Cost/Turn│ Context  │ Memory   │ Recommended Use    │
│                   │          │ Quality  │ Quality  │                    │
├───────────────────┼──────────┼──────────┼──────────┼────────────────────┤
│ Old (1 msg)       │ ★★★★★   │ ★        │ ★        │ Deprecated         │
│ Window-8          │ ★★★★    │ ★★★     │ ★★      │ Short sessions     │
│ Window-20         │ ★★★     │ ★★★★   │ ★★★     │ Medium sessions    │
│ Hybrid w12+500t   │ ★★★★   │ ★★★★   │ ★★★★   │ RECOMMENDED        │
│ Current (compact) │ ★★★     │ ★★★★   │ ★★★★   │ OK as-is w/ fix    │
│ Current (verbose) │ ★★      │ ★★★★   │ ★★★★★  │ Too expensive      │
│ Current BUG       │ ★       │ ★★★★★  │ ★★★★★  │ BROKEN — fix now   │
│ No Management     │ ★       │ ★★★★★  │ ★★★★★  │ Never use          │
└───────────────────┴──────────┴──────────┴──────────┴────────────────────┘
```

*Cost/Turn is inverted (★★★★★ = cheapest, ★ = most expensive)*

---

## Appendix: Simulation Methodology

- **Token counting**: tiktoken cl100k_base (same encoder as GPT-4/GPT-4o)
- **Per-message overhead**: 4 tokens per message (OpenAI chat format spec)
- **System prompt**: ~380-420 tokens (Langua persona template)
- **Message styles**: short (15-30 words), medium (40-80 words), long (100-200 words)
- **Summary compact**: ~15% of conversation tokens (well-prompted summarization)
- **Summary verbose**: ~45% of conversation tokens (unprompted/naive summarization)
- **Summarization call cost**: counted as (input tokens at trigger) + (output = summary size)
- **Realistic scenario**: 5 independent runs averaged for stability
- **Strategies run**: 5 strategies × multiple configurations = ~25 variants per scenario
- **Total scenarios**: 9 standard (3 lengths × 3 styles) + 5 realistic runs

---

*Report generated by `langua-token-research` simulation suite.*
*Source: `/tmp/langua-token-research/src/`*