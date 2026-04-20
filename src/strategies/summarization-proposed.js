/**
 * summarization-proposed.js
 * PROPOSED improved Langua summarization strategy.
 *
 * Proposed constants vs current real:
 *   MINIMUM_MESSAGES_FOR_FIRST_SUMMARY: 80 individual msgs (40 turns) vs 100 (50 turns)
 *   MESSAGES_INCREMENT_FOR_RESUMMARY:   40 individual msgs (20 turns) vs 30 (15 turns)
 *   MESSAGES_TO_KEEP_UNSUMMARIZED:      40 individual msgs (20 turns) vs 30 (15 turns)
 *   KEEP_RECENT_MESSAGES (worker):      40 individual msgs (20 turns) — same as current
 *   Worker fallback (no summary):       last 40 messages — FIXES THE BUG
 *   MAX_SUMMARY_WORDS:                  200 (tighter) vs 500
 *   Summary output size:                ~300 tokens vs ~500 tokens
 *
 * Uses incremental token counting for O(n) performance.
 */

const { countMessages, countTokens, precomputeMessageTokens } = require('../tokenizer');

const STRATEGY_NAME = 'summarization-proposed';

// ─── Proposed Constants ──────────────────────────────────────────────────────

const MINIMUM_MESSAGES_FOR_FIRST_SUMMARY = 80;
const FIRST_SUMMARY_TRIGGER_TURN = MINIMUM_MESSAGES_FOR_FIRST_SUMMARY / 2; // = 40

const MESSAGES_INCREMENT_FOR_RESUMMARY = 40;
const RESUMMARY_TURN_INCREMENT = MESSAGES_INCREMENT_FOR_RESUMMARY / 2; // = 20

const MESSAGES_TO_KEEP_UNSUMMARIZED = 40;
const TURNS_TO_KEEP_UNSUMMARIZED = MESSAGES_TO_KEEP_UNSUMMARIZED / 2; // = 20

const KEEP_RECENT_MESSAGES = 40; // same as current

const FALLBACK_WINDOW_MESSAGES = 40; // FIXES THE BUG

const SUMMARIZATION_SYSTEM_PROMPT_TOKENS = 500;
const DEFAULT_SUMMARY_TOKENS = 300; // tighter: ~200 words

/**
 * Simulate the PROPOSED improved Langua strategy.
 * Uses precomputed per-message token counts for O(n) performance.
 */
function simulate(systemPrompt, allMessages, config = {}) {
  const summaryTokens = config.summaryTokens || DEFAULT_SUMMARY_TOKENS;
  const summaryText = config.summaryText || generateFixedSummaryText(summaryTokens);

  const numTurns = Math.floor(allMessages.length / 2);

  // Precompute
  const msgTokens = precomputeMessageTokens(allMessages);
  const systemPromptTokens = countTokens(systemPrompt);
  const summaryMsgTokens = 4 + countTokens('system') + countTokens(`Previous conversation summary:\n${summaryText}`);

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

  let currentSummaryText = null;
  let currentSummaryMsgTokens = 0;
  let lastSummaryAtTurn = -1;

  const BASE_OVERHEAD = 3;

  for (let turn = 0; turn < numTurns; turn++) {
    const historyMsgCount = turn * 2;
    const currentMsgIdx = turn * 2;

    // ── Check if we should generate/regenerate a summary ──────────────────

    const shouldFirstSummary = (turn === FIRST_SUMMARY_TRIGGER_TURN && currentSummaryText === null);
    const shouldResummary = (currentSummaryText !== null &&
      turn >= lastSummaryAtTurn + RESUMMARY_TURN_INCREMENT);

    if (shouldFirstSummary || shouldResummary) {
      const turnsBefore = turn - TURNS_TO_KEEP_UNSUMMARIZED;
      const msgsBefore = Math.max(0, turnsBefore * 2);

      const olderBlockTokens = rangeTokens(0, msgsBefore);
      let inputTokens = SUMMARIZATION_SYSTEM_PROMPT_TOKENS + olderBlockTokens + BASE_OVERHEAD;

      if (shouldResummary && currentSummaryText !== null) {
        inputTokens += currentSummaryMsgTokens;
      }

      const summaryCallCost = inputTokens + summaryTokens;
      totalSummaryCallCost += summaryCallCost;

      currentSummaryText = summaryText;
      currentSummaryMsgTokens = summaryMsgTokens;
      lastSummaryAtTurn = turn;
    }

    // ── Build context token count for this turn ───────────────────────────

    let turnTokens;

    if (currentSummaryText === null) {
      // PROPOSED: use fallback window instead of all history (BUG FIX)
      const fallbackStart = Math.max(0, historyMsgCount - FALLBACK_WINDOW_MESSAGES);
      turnTokens = (4 + systemPromptTokens) +
        rangeTokens(fallbackStart, historyMsgCount) +
        msgTokens[currentMsgIdx] +
        BASE_OVERHEAD;
    } else {
      // POST-SUMMARY: system + summary + last KEEP_RECENT_MESSAGES messages + current
      const recentStart = Math.max(0, historyMsgCount - KEEP_RECENT_MESSAGES);
      turnTokens = (4 + systemPromptTokens) +
        currentSummaryMsgTokens +
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
    summaryTokens,
    config: {
      firstSummaryTriggerTurn: FIRST_SUMMARY_TRIGGER_TURN,
      resummaryTurnIncrement: RESUMMARY_TURN_INCREMENT,
      turnsToKeepUnsummarized: TURNS_TO_KEEP_UNSUMMARIZED,
      keepRecentMessages: KEEP_RECENT_MESSAGES,
      fallbackWindowMessages: FALLBACK_WINDOW_MESSAGES,
      summaryTokens,
      description: `Proposed: fallback window ${FALLBACK_WINDOW_MESSAGES}msgs (BUG FIXED), first summary at turn ${FIRST_SUMMARY_TRIGGER_TURN}, re-summarize every ${RESUMMARY_TURN_INCREMENT} turns, ${summaryTokens}-tok summaries`,
    },
  };
}

/**
 * Generate summary text of approximately the target token count.
 */
function generateFixedSummaryText(targetTokens) {
  const base = 'The learner has been studying Spanish grammar including verb conjugations, subjunctive mood, and reflexive verbs. Key vocabulary and patterns were reviewed. Progress noted. Next steps: immersion practice.';
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
};
