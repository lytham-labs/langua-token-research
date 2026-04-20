/**
 * no-management.js
 * No context management strategy (baseline/worst-case).
 *
 * Behavior: Include ALL messages in every API call.
 * No truncation, no summarization, no limit.
 *
 * This shows the quadratic growth in token usage as conversations grow longer.
 * Token cost for turn N = system_prompt + all N*2 previous messages + current message.
 * Total cost grows as O(n²) with conversation length.
 *
 * This also models the current Langua "bug" where if no summary is ever triggered,
 * the system includes all messages from the entire conversation history.
 */

const { countMessages } = require('../tokenizer');

const STRATEGY_NAME = 'no-management';

/**
 * Simulate no-management strategy.
 *
 * @param {string} systemPrompt
 * @param {Array<{role: string, content: string}>} allMessages
 * @returns {{
 *   strategyName: string,
 *   tokensPerTurn: number[],
 *   totalTokens: number,
 *   cumulativeTokensByTurn: number[],
 *   config: object
 * }}
 */
function simulate(systemPrompt, allMessages) {
  const tokensPerTurn = [];
  let totalTokens = 0;

  const numTurns = Math.floor(allMessages.length / 2);

  for (let turn = 0; turn < numTurns; turn++) {
    // All messages up to (but not including) the current user message
    const historyMessages = allMessages.slice(0, turn * 2);
    const currentUserMessage = allMessages[turn * 2];

    // Include everything — no limit
    const contextMessages = [
      { role: 'system', content: systemPrompt },
      ...historyMessages,
      currentUserMessage,
    ];

    const turnTokens = countMessages(contextMessages);
    tokensPerTurn.push(turnTokens);
    totalTokens += turnTokens;
  }

  const cumulativeTokensByTurn = [];
  let runningTotal = 0;
  for (const t of tokensPerTurn) {
    runningTotal += t;
    cumulativeTokensByTurn.push(runningTotal);
  }

  // Compute growth characteristics
  const firstTurnTokens  = tokensPerTurn[0] || 0;
  const lastTurnTokens   = tokensPerTurn[tokensPerTurn.length - 1] || 0;
  const growthMultiplier = firstTurnTokens > 0 ? lastTurnTokens / firstTurnTokens : 0;

  return {
    strategyName: STRATEGY_NAME,
    tokensPerTurn,
    totalTokens,
    cumulativeTokensByTurn,
    growthCharacteristics: {
      firstTurnTokens,
      lastTurnTokens,
      growthMultiplier: parseFloat(growthMultiplier.toFixed(2)),
      growthType: 'quadratic (O(n²))',
    },
    config: {
      description: 'No management: ALL messages included every turn — unbounded quadratic growth',
    },
  };
}

module.exports = { simulate, STRATEGY_NAME };
