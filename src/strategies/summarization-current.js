/**
 * summarization-current.js
 * REAL Langua summarization strategy — modeled from actual codebase constants.
 *
 * REAL RAILS constants (Stream::ConversationSummarizationService):
 *   MINIMUM_MESSAGES_FOR_FIRST_SUMMARY = 100  (individual messages = 50 turn pairs)
 *   MESSAGES_INCREMENT_FOR_RESUMMARY   = 30   (individual messages = 15 turns)
 *   MESSAGES_TO_KEEP_UNSUMMARIZED      = 30   (individual messages = 15 turns kept verbatim)
 *   MAX_SUMMARY_WORDS = 500 (in prompt, not enforced)
 *   MAX_SUMMARY_CHARS = 3000 (hard post-hoc truncation)
 *   max_tokens: 800 (AI output limit for summarization call)
 *   System prompt for summarization: ~500 tokens
 *
 * REAL WORKER constants (langua-chat-worker):
 *   KEEP_RECENT_MESSAGES = 40 (after summary exists)
 *   MAX_TOKENS = 30000 (roughToken gate)
 *   No-summary path: sends ALL historical messages (unbounded bug)
 *
 * KEY INSIGHT:
 *   - 100 individual messages = 50 user+assistant turn pairs
 *   - Turns 1–49 have NO summary: all history sent unbounded
 *   - Most real conversations never reach turn 50
 *
 * RE-SUMMARIZATION:
 *   - After first summary at turn 50: re-summarize at turns 65, 80, 95, ...
 *   - Re-summarization passes ENTIRE older block (growing) + old summary
 */

const { countMessages, countTokens, precomputeMessageTokens } = require('../tokenizer');

const STRATEGY_NAME = 'summarization-current-real';

// ─── Real Constants ──────────────────────────────────────────────────────────

const MINIMUM_MESSAGES_FOR_FIRST_SUMMARY = 100;
const FIRST_SUMMARY_TRIGGER_TURN = MINIMUM_MESSAGES_FOR_FIRST_SUMMARY / 2; // = 50

const MESSAGES_INCREMENT_FOR_RESUMMARY = 30;
const RESUMMARY_TURN_INCREMENT = MESSAGES_INCREMENT_FOR_RESUMMARY / 2; // = 15

const MESSAGES_TO_KEEP_UNSUMMARIZED = 30;
const TURNS_TO_KEEP_UNSUMMARIZED = MESSAGES_TO_KEEP_UNSUMMARIZED / 2; // = 15

const KEEP_RECENT_MESSAGES = 40; // individual messages

const SUMMARIZATION_SYSTEM_PROMPT_TOKENS = 500;

/**
 * Simulate the REAL Langua strategy with accurate constants.
 * Uses precomputed per-message token counts for O(n) performance instead of O(n²).
 */
function simulate(systemPrompt, allMessages, config = {}) {
  const summaryTokens = config.summaryTokens || 500;
  const summaryText = config.summaryText || generateFixedSummaryText(summaryTokens);

  const numTurns = Math.floor(allMessages.length / 2);

  // Precompute token costs for each individual message
  const msgTokens = precomputeMessageTokens(allMessages);
  const systemPromptTokens = countTokens(systemPrompt);
  const summaryMsgTokens = 4 + countTokens('system') + countTokens(`Previous conversation summary:\n${summaryText}`);

  // Compute cumulative message token sums for O(1) range queries
  // cumMsg[i] = sum of msgTokens[0..i-1]
  const cumMsg = new Array(msgTokens.length + 1).fill(0);
  for (let i = 0; i < msgTokens.length; i++) {
    cumMsg[i + 1] = cumMsg[i] + msgTokens[i];
  }

  // Helper: tokens for messages[startIdx..endIdx-1] (slice)
  function rangeTokens(startIdx, endIdx) {
    return cumMsg[endIdx] - cumMsg[startIdx];
  }

  const tokensPerTurn = [];
  let totalTokens = 0;
  let totalSummaryCallCost = 0;

  let currentSummaryText = null;
  let currentSummaryMsgTokens = 0;
  let lastSummaryAtTurn = -1;

  const BASE_OVERHEAD = 3; // priming tokens

  for (let turn = 0; turn < numTurns; turn++) {
    const historyMsgCount = turn * 2; // individual messages before this turn
    const currentMsgIdx = turn * 2;   // index of current user message

    // ── Check if we should generate/regenerate a summary ──────────────────

    const shouldFirstSummary = (turn === FIRST_SUMMARY_TRIGGER_TURN && currentSummaryText === null);
    const shouldResummary = (currentSummaryText !== null &&
      turn >= lastSummaryAtTurn + RESUMMARY_TURN_INCREMENT);

    if (shouldFirstSummary || shouldResummary) {
      const turnsBefore = turn - TURNS_TO_KEEP_UNSUMMARIZED;
      const msgsBefore = Math.max(0, turnsBefore * 2);

      // Summarization call cost (estimated):
      // Input = summarization system prompt overhead + messages in older block
      // We approximate the summarization system prompt as plain token addition
      const olderBlockTokens = rangeTokens(0, msgsBefore);

      let inputTokens = SUMMARIZATION_SYSTEM_PROMPT_TOKENS + olderBlockTokens + BASE_OVERHEAD;

      // Re-summarization also includes old summary
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
      // PRE-SUMMARY: all history + current message + system prompt
      // system prompt msg + all history msgs + current msg + priming
      turnTokens = (4 + systemPromptTokens) + rangeTokens(0, historyMsgCount) +
        msgTokens[currentMsgIdx] + BASE_OVERHEAD;
    } else {
      // POST-SUMMARY: system + summary + last KEEP_RECENT_MESSAGES messages + current
      const recentStart = Math.max(0, historyMsgCount - KEEP_RECENT_MESSAGES);
      turnTokens = (4 + systemPromptTokens) +  // system prompt msg
        currentSummaryMsgTokens +               // summary system msg
        rangeTokens(recentStart, historyMsgCount) + // last 40 msgs
        msgTokens[currentMsgIdx] +              // current user msg
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
      summaryTokens,
      description: `Real Langua: unbounded until turn ${FIRST_SUMMARY_TRIGGER_TURN}, then system+summary+last${KEEP_RECENT_MESSAGES}msgs, re-summarize every ${RESUMMARY_TURN_INCREMENT} turns`,
    },
  };
}

/**
 * Model the "no summary" path: ALL messages, unbounded, forever.
 * Uses incremental token counting for O(n) performance.
 */
function simulateNoSummaryPath(systemPrompt, allMessages) {
  const numTurns = Math.floor(allMessages.length / 2);

  const msgTokens = precomputeMessageTokens(allMessages);
  const systemPromptTokens = countTokens(systemPrompt);

  // Cumulative sums
  const cumMsg = new Array(msgTokens.length + 1).fill(0);
  for (let i = 0; i < msgTokens.length; i++) {
    cumMsg[i + 1] = cumMsg[i] + msgTokens[i];
  }

  const BASE_OVERHEAD = 3;
  const tokensPerTurn = [];
  let totalTokens = 0;

  for (let turn = 0; turn < numTurns; turn++) {
    const historyMsgCount = turn * 2;
    const currentMsgIdx = turn * 2;

    // All history + current + system prompt
    const turnTokens = (4 + systemPromptTokens) +
      cumMsg[historyMsgCount] +
      msgTokens[currentMsgIdx] +
      BASE_OVERHEAD;

    tokensPerTurn.push(turnTokens);
    totalTokens += turnTokens;
  }

  const cumulativeTokensByTurn = [];
  let runningTotal = 0;
  for (const t of tokensPerTurn) {
    runningTotal += t;
    cumulativeTokensByTurn.push(runningTotal);
  }

  return {
    strategyName: 'current-no-summary-bug',
    tokensPerTurn,
    totalTokens,
    cumulativeTokensByTurn,
    summaryCallCost: 0,
    config: {
      description: 'Real Langua BUG: no summary triggered (< turn 50) — ALL messages sent every turn (unbounded)',
    },
  };
}

/**
 * Generate summary text of approximately the target token count.
 */
function generateFixedSummaryText(targetTokens) {
  const base = 'The learner has been studying Spanish with focus on grammar and vocabulary. Topics covered include verb conjugations, subjunctive mood, reflexive verbs, and ser/estar distinction. The learner showed progress in understanding agreement rules and has been encouraged to practice with native content. Key vocabulary and patterns were reviewed.';
  let text = base;
  let iters = 0;
  while (countTokens(text) < targetTokens - 20 && iters < 50) {
    text += ' ' + base;
    iters++;
  }
  return text;
}

module.exports = { simulate, simulateNoSummaryPath, STRATEGY_NAME };
