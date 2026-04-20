/**
 * truncation-window.js
 * Sliding window truncation strategy.
 *
 * Behavior: Keep system prompt + the last N messages (configurable).
 * No summarization — older messages are simply discarded.
 *
 * Configurations tested: N = 4, 8, 12, 20, 40
 *
 * Token cost per turn: grows until N messages are in history, then plateaus.
 * Context quality: moderate — recent history preserved but older context lost.
 */

const { countMessages } = require('../tokenizer');

const STRATEGY_NAME = 'truncation-window';

/**
 * Simulate the sliding window strategy.
 *
 * @param {string} systemPrompt
 * @param {Array<{role: string, content: string}>} allMessages
 * @param {{ windowSize: number }} config
 * @returns {{
 *   strategyName: string,
 *   tokensPerTurn: number[],
 *   totalTokens: number,
 *   cumulativeTokensByTurn: number[],
 *   config: object
 * }}
 */
function simulate(systemPrompt, allMessages, config = {}) {
  const windowSize = config.windowSize || 20;
  const tokensPerTurn = [];
  let totalTokens = 0;

  const numTurns = Math.floor(allMessages.length / 2);

  for (let turn = 0; turn < numTurns; turn++) {
    // History includes all messages up to (but not including) current user msg
    // Current user msg is at allMessages[turn * 2]
    const historyMessages = allMessages.slice(0, turn * 2);
    const currentUserMessage = allMessages[turn * 2];

    // Sliding window: take the last `windowSize - 1` history messages
    // (leave room for the new user message)
    const windowedHistory = historyMessages.slice(-(windowSize - 1));

    const contextMessages = [
      { role: 'system', content: systemPrompt },
      ...windowedHistory,
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

  return {
    strategyName: `${STRATEGY_NAME}-${windowSize}`,
    tokensPerTurn,
    totalTokens,
    cumulativeTokensByTurn,
    config: {
      windowSize,
      description: `System prompt + last ${windowSize} messages (sliding window)`,
    },
  };
}

/**
 * Run simulation with multiple window sizes.
 */
function simulateAllWindows(systemPrompt, allMessages) {
  const windowSizes = [4, 8, 12, 20, 40];
  return windowSizes.map(size => simulate(systemPrompt, allMessages, { windowSize: size }));
}

module.exports = { simulate, simulateAllWindows, STRATEGY_NAME };
