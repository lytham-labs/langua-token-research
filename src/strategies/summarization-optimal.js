/**
 * summarization-optimal.js
 * OPTIMAL V3 strategy — incorporates eval data + incremental re-summary + prompt caching.
 *
 * Key insights from v3 research:
 *
 * 1. EVAL DATA (252 runs, 6 context sizes, LLM-as-judge):
 *    Window=6 messages is the quality plateau. Score at window=6 (0.863) matches window=10 (0.863).
 *    Window=20 actually dips slightly (0.845) — distraction effect from irrelevant history.
 *    This applies to memory-tool turns. For regular chat turns, window=6 is still a solid floor.
 *
 * 2. ARCHITECTURE REALITY:
 *    - Primary model: GPT-5.1 (not GPT-4.1!) — the fallback chain has claude-sonnet as #1
 *    - Summarization model: GPT-4.1 (should be GPT-4.1-mini)
 *    - Rails sends ALL chat_messages to worker (no cap at Rails level)
 *    - Worker re-caps via buildContextWithSummary (KEEP=40) or buildContextWithoutSummary (KEEP=40 on main)
 *    - Branch feat/context-window-cap-no-summary has KEEP=4 (not yet merged)
 *
 * 3. PROMPT CACHING (Anthropic beta / OpenAI automatic):
 *    - System prompt (~400 tokens) is STABLE per conversation session
 *    - Anthropic: cache_control on system message → 5-minute TTL, 90% discount on cache hits
 *    - OpenAI: automatic caching, minimum 1024 tokens, ~50% discount on cached prefix
 *    - For 60-turn conversation: system prompt is re-sent 60 times = massive cache opportunity
 *
 * 4. OPTIMAL STRATEGY:
 *    - Pre-summary: window=6 (eval-proven floor, down from 40)
 *    - Post-summary: window=6 (summary handles long-term context; 6 msgs for flow)
 *    - First summary: trigger at turn 30 (message 60) — earlier than current 50
 *    - Re-summary: incremental (only new msgs since last summary)
 *    - Re-summary interval: every 20 turns (less frequent)
 *    - Summary output cap: 250 tokens (structured prompt)
 *    - Summarization model: GPT-4.1-mini (80% cheaper, sufficient quality)
 *    - Prompt caching: system prompt cached → ~50% discount on those 400 tokens
 *
 * Constants:
 *   FIRST_SUMMARY_TRIGGER_TURN: 30 (60 messages)
 *   RESUMMARY_TURN_INCREMENT:   20 (40 messages)
 *   KEEP_RECENT_MESSAGES:        6 (12 individual messages — eval-proven)
 *   FALLBACK_WINDOW_MESSAGES:    6 (same — no-summary path)
 *   SUMMARY_OUTPUT_TOKENS:     250 (structured 200-word prompt)
 */

const { countTokens, precomputeMessageTokens } = require('../tokenizer');

const STRATEGY_NAME = 'summarization-optimal-v3';

// ─── Optimal V3 Constants ────────────────────────────────────────────────────

const FIRST_SUMMARY_TRIGGER_TURN = 30;   // 60 messages — earlier than current 50
const RESUMMARY_TURN_INCREMENT = 20;     // 40 messages — less frequent re-summary
const TURNS_TO_KEEP_UNSUMMARIZED = 10;  // 20 messages — what stays verbatim at summary time

// THE KEY: eval-proven 6-message floor (not 40!)
const KEEP_RECENT_MESSAGES = 6;          // 6 individual messages (~3 exchanges)
const FALLBACK_WINDOW_MESSAGES = 6;      // Same for pre-summary path

const SUMMARIZATION_SYSTEM_PROMPT_TOKENS = 250; // Tighter structured prompt (~250 tokens)
const DEFAULT_SUMMARY_TOKENS = 250;    // 200 words ≈ 250 tokens with structured format

// Prompt caching discount: ~50% for OpenAI (automatic caching of stable prefix)
// System prompt is always at position 0 and never changes within a conversation session
// This discount applies to the SYSTEM_PROMPT_TOKENS portion of every turn
const PROMPT_CACHE_DISCOUNT = 0.50;  // 50% discount on cached system prompt tokens

/**
 * Simulate the OPTIMAL V3 strategy.
 * Uses eval-proven window=6, incremental re-summary, and prompt caching discount.
 */
function simulate(systemPrompt, allMessages, config = {}) {
  const summaryTokens = config.summaryTokens || DEFAULT_SUMMARY_TOKENS;
  const summaryText = config.summaryText || generateFixedSummaryText(summaryTokens);
  const enableCaching = config.enableCaching !== false; // default: true

  const numTurns = Math.floor(allMessages.length / 2);

  const msgTokens = precomputeMessageTokens(allMessages);
  const systemPromptTokens = countTokens(systemPrompt);

  const cumMsg = new Array(msgTokens.length + 1).fill(0);
  for (let i = 0; i < msgTokens.length; i++) {
    cumMsg[i + 1] = cumMsg[i] + msgTokens[i];
  }

  function rangeTokens(startIdx, endIdx) {
    if (endIdx <= startIdx) return 0;
    return cumMsg[endIdx] - cumMsg[startIdx];
  }

  const tokensPerTurn = [];
  let totalTokens = 0;
  let totalSummaryCallCost = 0;
  let totalCacheDiscount = 0;

  let hasSummary = false;
  let currentSummaryTokensInContext = 0;
  let lastSummaryAtTurn = -1;
  let lastSummarizedUpToMsgIdx = 0;

  const BASE_OVERHEAD = 3;
  const summaryPrefixTokens = countTokens('system') + countTokens('Previous conversation summary:\n');

  // System prompt is sent every turn — with caching, after first turn it's discounted
  // Model: first turn is full price, subsequent turns are 50% for system prompt portion
  const cachedSysPromptTokens = enableCaching
    ? Math.round(systemPromptTokens * (1 - PROMPT_CACHE_DISCOUNT))
    : systemPromptTokens;

  for (let turn = 0; turn < numTurns; turn++) {
    const historyMsgCount = turn * 2;
    const currentMsgIdx = turn * 2;

    // Use cached system prompt cost after first turn
    const effectiveSysPromptTokens = turn === 0 ? systemPromptTokens : cachedSysPromptTokens;
    const cacheDiscountThisTurn = turn === 0 ? 0 : (systemPromptTokens - cachedSysPromptTokens);
    totalCacheDiscount += cacheDiscountThisTurn;

    // ── Summarization check ──────────────────────────────────────────────

    const shouldFirstSummary = (turn === FIRST_SUMMARY_TRIGGER_TURN && !hasSummary);
    const shouldResummary = (hasSummary && turn >= lastSummaryAtTurn + RESUMMARY_TURN_INCREMENT);

    if (shouldFirstSummary || shouldResummary) {
      const turnsBefore = turn - TURNS_TO_KEEP_UNSUMMARIZED;
      const newSummarizedUpToMsgIdx = Math.max(0, turnsBefore * 2);

      if (shouldFirstSummary) {
        // First summary: full older block
        const olderBlockTokens = rangeTokens(0, newSummarizedUpToMsgIdx);
        const inputTokens = SUMMARIZATION_SYSTEM_PROMPT_TOKENS + olderBlockTokens + BASE_OVERHEAD;
        totalSummaryCallCost += inputTokens + summaryTokens;
      } else {
        // Incremental: only new messages since last summary + old summary
        const newMessagesTokens = rangeTokens(lastSummarizedUpToMsgIdx, newSummarizedUpToMsgIdx);
        const oldSummaryTokens = summaryPrefixTokens + summaryTokens;
        const inputTokens = SUMMARIZATION_SYSTEM_PROMPT_TOKENS + oldSummaryTokens + newMessagesTokens + BASE_OVERHEAD;
        totalSummaryCallCost += inputTokens + summaryTokens;
      }

      hasSummary = true;
      currentSummaryTokensInContext = summaryPrefixTokens + summaryTokens;
      lastSummaryAtTurn = turn;
      lastSummarizedUpToMsgIdx = Math.max(0, (turn - TURNS_TO_KEEP_UNSUMMARIZED) * 2);
    }

    // ── Build turn token cost ────────────────────────────────────────────

    let turnTokens;

    if (!hasSummary) {
      // Pre-summary: eval-proven 6-message window
      const fallbackStart = Math.max(0, historyMsgCount - FALLBACK_WINDOW_MESSAGES);
      turnTokens = (4 + effectiveSysPromptTokens) +
        rangeTokens(fallbackStart, historyMsgCount) +
        msgTokens[currentMsgIdx] +
        BASE_OVERHEAD;
    } else {
      // Post-summary: system + summary + last 6 messages + current
      const recentStart = Math.max(0, historyMsgCount - KEEP_RECENT_MESSAGES);
      turnTokens = (4 + effectiveSysPromptTokens) +
        currentSummaryTokensInContext +
        rangeTokens(recentStart, historyMsgCount) +
        msgTokens[currentMsgIdx] +
        BASE_OVERHEAD;
    }

    tokensPerTurn.push(turnTokens);
    totalTokens += turnTokens;
  }

  totalTokens += totalSummaryCallCost;

  const cumulativeTokensByTurn = [];
  let runningTotal = 0;
  for (const t of tokensPerTurn) {
    runningTotal += t;
    cumulativeTokensByTurn.push(runningTotal);
  }

  return {
    strategyName: STRATEGY_NAME,
    tokensPerTurn,
    totalTokens,
    cumulativeTokensByTurn,
    summaryCallCost: totalSummaryCallCost,
    cacheDiscount: totalCacheDiscount,
    effectiveTotalTokens: totalTokens - totalCacheDiscount,
    summaryTokens,
    config: {
      firstSummaryTriggerTurn: FIRST_SUMMARY_TRIGGER_TURN,
      resummaryTurnIncrement: RESUMMARY_TURN_INCREMENT,
      turnsToKeepUnsummarized: TURNS_TO_KEEP_UNSUMMARIZED,
      keepRecentMessages: KEEP_RECENT_MESSAGES,
      fallbackWindowMessages: FALLBACK_WINDOW_MESSAGES,
      summaryTokens,
      promptCachingEnabled: enableCaching,
      promptCacheDiscount: PROMPT_CACHE_DISCOUNT,
      description: `Optimal V3: window=${KEEP_RECENT_MESSAGES} msgs (eval-proven), first summary turn ${FIRST_SUMMARY_TRIGGER_TURN}, incremental re-summary every ${RESUMMARY_TURN_INCREMENT} turns, ${summaryTokens}-tok structured summaries, 50% prompt cache discount`,
    },
  };
}

function generateFixedSummaryText(targetTokens) {
  const base = '**Context:** Spanish tutor, B2 learner, conversation practice. **Progress:** Subjunctive mood, ser/estar distinction reviewed. **Preferences:** Immersive roleplay, minimal correction interruptions. **Next:** Practice past subjunctive in narrative context.';
  let text = base;
  let iters = 0;
  while (countTokens(text) < targetTokens - 20 && iters < 50) {
    text += ' ' + base;
    iters++;
  }
  return text;
}

module.exports = {
  simulate,
  STRATEGY_NAME,
  FIRST_SUMMARY_TRIGGER_TURN,
  KEEP_RECENT_MESSAGES,
  FALLBACK_WINDOW_MESSAGES,
};
