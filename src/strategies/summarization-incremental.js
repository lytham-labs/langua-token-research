/**
 * summarization-incremental.js
 * OPTIMAL Langua summarization strategy — incremental re-summarization.
 *
 * Key insight: The current system re-summarizes by passing the FULL growing block
 * of older messages every time. By turn 100+, a single re-summary call costs 10k+ tokens
 * just for the input.
 *
 * This strategy uses INCREMENTAL re-summarization:
 *   - First summary: summarize ALL older messages (same as current)
 *   - Re-summarization: pass ONLY the new messages since last summary + old summary
 *     The AI merges/updates the existing summary with new content
 *
 * This keeps re-summary call cost CONSTANT regardless of conversation length —
 * roughly: summarization_prompt + old_summary + new_messages_since_last_summary
 *
 * Additionally implements:
 *   - Early fallback window (fixes the no-summary bug)
 *   - Earlier first trigger (turn 40 vs 50)
 *   - Tighter summary output target (300 tokens vs 500)
 *   - Smaller recent message window (20 msgs vs 40) — sufficient with good summaries
 *
 * Constants (proposed optimal):
 *   MINIMUM_MESSAGES_FOR_FIRST_SUMMARY: 80 (turn 40)
 *   MESSAGES_INCREMENT_FOR_RESUMMARY:   40 (20 turns) — re-summarize every 20 turns
 *   MESSAGES_TO_KEEP_UNSUMMARIZED:      40 (20 turns) — what's kept verbatim
 *   KEEP_RECENT_MESSAGES (worker):      24 individual msgs (12 turns) — tighter window
 *   FALLBACK_WINDOW_MESSAGES:           20 msgs (10 turns) — pre-summary cap
 *   Summary output target:              ~300 tokens (200 words)
 *   Re-summary INPUT:                   old_summary + ONLY new messages (not full block)
 */

const { countTokens, precomputeMessageTokens } = require('../tokenizer');

const STRATEGY_NAME = 'summarization-incremental';

// ─── Optimal Constants ───────────────────────────────────────────────────────

const MINIMUM_MESSAGES_FOR_FIRST_SUMMARY = 80;
const FIRST_SUMMARY_TRIGGER_TURN = MINIMUM_MESSAGES_FOR_FIRST_SUMMARY / 2; // = 40

const MESSAGES_INCREMENT_FOR_RESUMMARY = 40;
const RESUMMARY_TURN_INCREMENT = MESSAGES_INCREMENT_FOR_RESUMMARY / 2; // = 20

const MESSAGES_TO_KEEP_UNSUMMARIZED = 40;
const TURNS_TO_KEEP_UNSUMMARIZED = MESSAGES_TO_KEEP_UNSUMMARIZED / 2; // = 20

// Tighter window after summary — 24 individual messages (12 turn pairs)
// Good summaries mean you don't need 40 messages of verbatim history
const KEEP_RECENT_MESSAGES = 24;

// Pre-summary fallback: cap at 20 messages (10 turns) — fixes the bug
const FALLBACK_WINDOW_MESSAGES = 20;

// Summarization system prompt overhead (~500 tokens for the roleplay-preserving prompt)
const SUMMARIZATION_SYSTEM_PROMPT_TOKENS = 500;

// Target summary output tokens (200 words ≈ 280 tokens; leave buffer)
const DEFAULT_SUMMARY_TOKENS = 300;

/**
 * Simulate the INCREMENTAL summarization strategy.
 *
 * Key difference from current/proposed:
 * - Re-summarization passes: old_summary + ONLY new messages since last summary
 * - NOT the entire growing older block
 */
function simulate(systemPrompt, allMessages, config = {}) {
  const summaryTokens = config.summaryTokens || DEFAULT_SUMMARY_TOKENS;
  const summaryText = config.summaryText || generateFixedSummaryText(summaryTokens);

  const numTurns = Math.floor(allMessages.length / 2);

  // Precompute per-message token costs
  const msgTokens = precomputeMessageTokens(allMessages);
  const systemPromptTokens = countTokens(systemPrompt);

  // Build cumulative sum array for O(1) range queries
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

  // Track summary state
  let hasSummary = false;
  let currentSummaryTokensInContext = 0;
  let lastSummaryAtTurn = -1;
  // Track where the last summary covered up to (message index)
  let lastSummarizedUpToMsgIdx = 0;

  const BASE_OVERHEAD = 3; // OpenAI chat format priming

  // Precompute summary message overhead (role + SUMMARY_PREFIX)
  const summaryPrefixTokens = countTokens('system') + countTokens('Previous conversation summary:\n');

  for (let turn = 0; turn < numTurns; turn++) {
    const historyMsgCount = turn * 2;
    const currentMsgIdx = turn * 2;

    // ── Check if we should generate/regenerate a summary ──────────────────

    const shouldFirstSummary = (turn === FIRST_SUMMARY_TRIGGER_TURN && !hasSummary);
    const shouldResummary = (hasSummary && turn >= lastSummaryAtTurn + RESUMMARY_TURN_INCREMENT);

    if (shouldFirstSummary || shouldResummary) {
      // What we keep unsummarized (verbatim recent)
      const turnsBefore = turn - TURNS_TO_KEEP_UNSUMMARIZED;
      const newSummarizedUpToMsgIdx = Math.max(0, turnsBefore * 2);

      if (shouldFirstSummary) {
        // FIRST SUMMARY: summarize all messages from 0 to newSummarizedUpToMsgIdx
        const olderBlockTokens = rangeTokens(0, newSummarizedUpToMsgIdx);
        const inputTokens = SUMMARIZATION_SYSTEM_PROMPT_TOKENS + olderBlockTokens + BASE_OVERHEAD;
        const callCost = inputTokens + summaryTokens;
        totalSummaryCallCost += callCost;
      } else {
        // INCREMENTAL RE-SUMMARY: only pass new messages since last summary + old summary
        // NEW messages = from lastSummarizedUpToMsgIdx to newSummarizedUpToMsgIdx
        const newMessagesTokens = rangeTokens(lastSummarizedUpToMsgIdx, newSummarizedUpToMsgIdx);
        // Input = system prompt + old summary + only the new messages
        const oldSummaryInInputTokens = summaryPrefixTokens + summaryTokens;
        const inputTokens = SUMMARIZATION_SYSTEM_PROMPT_TOKENS + oldSummaryInInputTokens + newMessagesTokens + BASE_OVERHEAD;
        const callCost = inputTokens + summaryTokens;
        totalSummaryCallCost += callCost;
      }

      hasSummary = true;
      currentSummaryTokensInContext = summaryPrefixTokens + summaryTokens;
      lastSummaryAtTurn = turn;
      lastSummarizedUpToMsgIdx = newSummarizedUpToMsgIdx;
    }

    // ── Build context token count for this turn ───────────────────────────

    let turnTokens;

    if (!hasSummary) {
      // PRE-SUMMARY: use fallback window (BUG FIX)
      const fallbackStart = Math.max(0, historyMsgCount - FALLBACK_WINDOW_MESSAGES);
      turnTokens = (4 + systemPromptTokens) +
        rangeTokens(fallbackStart, historyMsgCount) +
        msgTokens[currentMsgIdx] +
        BASE_OVERHEAD;
    } else {
      // POST-SUMMARY: system + summary + last KEEP_RECENT_MESSAGES messages + current
      const recentStart = Math.max(0, historyMsgCount - KEEP_RECENT_MESSAGES);
      turnTokens = (4 + systemPromptTokens) +    // system prompt msg
        currentSummaryTokensInContext +            // summary injected as system msg
        rangeTokens(recentStart, historyMsgCount) + // recent verbatim history
        msgTokens[currentMsgIdx] +                 // current user msg
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
    summaryTokens,
    config: {
      firstSummaryTriggerTurn: FIRST_SUMMARY_TRIGGER_TURN,
      resummaryTurnIncrement: RESUMMARY_TURN_INCREMENT,
      turnsToKeepUnsummarized: TURNS_TO_KEEP_UNSUMMARIZED,
      keepRecentMessages: KEEP_RECENT_MESSAGES,
      fallbackWindowMessages: FALLBACK_WINDOW_MESSAGES,
      summaryTokens,
      description: `Incremental: fallback ${FALLBACK_WINDOW_MESSAGES}msgs pre-summary, first at turn ${FIRST_SUMMARY_TRIGGER_TURN}, incremental re-summary every ${RESUMMARY_TURN_INCREMENT} turns (only new msgs), ${KEEP_RECENT_MESSAGES}-msg window, ${summaryTokens}-tok summaries`,
    },
  };
}

/**
 * Generate summary text of approximately the target token count.
 */
function generateFixedSummaryText(targetTokens) {
  const base = 'The learner studies Spanish focusing on grammar and conversation. Recent topics: subjunctive mood, reflexive verbs, ser/estar. Progress noted in agreement rules. User prefers immersive roleplay scenarios.';
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
  FALLBACK_WINDOW_MESSAGES,
  KEEP_RECENT_MESSAGES,
};
