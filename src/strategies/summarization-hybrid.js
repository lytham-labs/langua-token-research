/**
 * summarization-hybrid.js
 * Hybrid strategy: capped summary + sliding window of recent messages.
 *
 * Behavior:
 *   - System prompt
 *   - Capped summary (max 500 tokens) — summary is truncated if it exceeds the cap
 *   - Last N recent messages (configurable: 4, 8, 12, 20)
 *   - New user message
 *
 * Advantages over current strategy:
 *   1. Summary is capped — prevents verbose summaries from eating token budget
 *   2. Smaller recent window option — can dramatically reduce per-turn cost
 *   3. Still preserves semantic context via summary
 *
 * This represents a more token-efficient design for frequent, shallow conversations.
 */

const { countMessages, countTokens } = require('../tokenizer');

const STRATEGY_NAME = 'summarization-hybrid';
const MAX_SUMMARY_TOKENS = 500;

/**
 * Simulate the hybrid strategy.
 *
 * @param {string} systemPrompt
 * @param {Array<{role: string, content: string}>} allMessages
 * @param {{
 *   windowSize: number,      // Number of recent messages to include (default: 12)
 *   triggerTurn: number,     // When to generate summary (default: 10)
 *   summaryTokens: number,   // Pre-computed summary token count (before cap)
 *   summaryText: string,     // The summary text (will be truncated if needed)
 *   summaryStyle: string,    // 'compact' or 'verbose'
 *   maxSummaryTokens: number // Cap on summary size (default: 500)
 * }} config
 */
function simulate(systemPrompt, allMessages, config = {}) {
  const windowSize = config.windowSize || 12;
  const triggerTurn = config.triggerTurn || 10;
  const summaryText = config.summaryText || 'Previous conversation summary: context here.';
  const summaryStyle = config.summaryStyle || 'compact';
  const maxSummaryTokens = config.maxSummaryTokens || MAX_SUMMARY_TOKENS;

  // Apply token cap to summary
  // In practice, we'd truncate the text, but for simulation we just model the token cost
  const rawSummaryTokens = config.summaryTokens || countTokens(summaryText);
  const effectiveSummaryTokens = Math.min(rawSummaryTokens, maxSummaryTokens);
  const summaryWasCapped = rawSummaryTokens > maxSummaryTokens;

  const tokensPerTurn = [];
  let totalTokens = 0;
  let summaryCallCost = 0;

  const numTurns = Math.floor(allMessages.length / 2);
  let summaryGenerated = false;

  for (let turn = 0; turn < numTurns; turn++) {
    const historyMessages = allMessages.slice(0, turn * 2);
    const currentUserMessage = allMessages[turn * 2];

    if (turn === triggerTurn && !summaryGenerated) {
      summaryGenerated = true;
      // One-time summarization cost
      const summaryInputTokens = countMessages([
        { role: 'system', content: systemPrompt },
        ...historyMessages,
      ]);
      summaryCallCost = summaryInputTokens + effectiveSummaryTokens;
    }

    let contextMessages;

    if (!summaryGenerated) {
      // Before trigger: use sliding window (already bounded)
      const windowedHistory = historyMessages.slice(-(windowSize - 1));
      contextMessages = [
        { role: 'system', content: systemPrompt },
        ...windowedHistory,
        currentUserMessage,
      ];
    } else {
      // After trigger: capped summary + sliding window
      const recentMessages = historyMessages.slice(-windowSize);

      // Model the effective summary as a system message of `effectiveSummaryTokens` size
      // We approximate by building a message and then adjusting the token count
      const summarySystemMsg = `Previous conversation summary:\n${summaryText}`;

      contextMessages = [
        { role: 'system', content: systemPrompt },
        { role: 'system', content: summarySystemMsg },
        ...recentMessages,
        currentUserMessage,
      ];

      // If summary was capped, adjust the token count down
      // (we count with full summary then subtract the difference)
    }

    let turnTokens = countMessages(contextMessages);

    // If summary was capped and is active, subtract excess summary tokens
    if (summaryGenerated && summaryWasCapped) {
      turnTokens = turnTokens - (rawSummaryTokens - effectiveSummaryTokens);
    }

    tokensPerTurn.push(Math.max(turnTokens, 50)); // floor at 50 tokens for sanity
    totalTokens += Math.max(turnTokens, 50);
  }

  totalTokens += summaryCallCost;

  const cumulativeTokensByTurn = [];
  let runningTotal = 0;
  for (const t of tokensPerTurn) {
    runningTotal += t;
    cumulativeTokensByTurn.push(runningTotal);
  }

  return {
    strategyName: `${STRATEGY_NAME}-w${windowSize}-${summaryStyle}`,
    tokensPerTurn,
    totalTokens,
    cumulativeTokensByTurn,
    summaryCallCost,
    effectiveSummaryTokens,
    summaryWasCapped,
    config: {
      windowSize,
      triggerTurn,
      effectiveSummaryTokens,
      maxSummaryTokens,
      summaryStyle,
      summaryWasCapped,
      description: `Hybrid: system + capped summary (≤${maxSummaryTokens}t, ${summaryStyle}) + last ${windowSize} msgs`,
    },
  };
}

/**
 * Run multiple hybrid configurations.
 */
function simulateAllHybrid(systemPrompt, allMessages, summaryConfig) {
  const windowSizes = [4, 8, 12, 20];
  const results = [];

  for (const windowSize of windowSizes) {
    for (const summaryStyle of ['compact', 'verbose']) {
      results.push(simulate(systemPrompt, allMessages, {
        windowSize,
        triggerTurn: 10,
        summaryTokens: summaryConfig[summaryStyle].tokens,
        summaryText: summaryConfig[summaryStyle].text,
        summaryStyle,
        maxSummaryTokens: MAX_SUMMARY_TOKENS,
      }));
    }
  }

  return results;
}

module.exports = { simulate, simulateAllHybrid, STRATEGY_NAME, MAX_SUMMARY_TOKENS };
