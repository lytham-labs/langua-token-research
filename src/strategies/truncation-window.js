/**
 * truncation-window.js
 * Sliding window truncation strategy.
 * Uses incremental token counting for O(n) performance.
 */

const { countTokens, precomputeMessageTokens } = require('../tokenizer');

const STRATEGY_NAME = 'truncation-window';

function simulate(systemPrompt, allMessages, config = {}) {
  const windowSize = config.windowSize || 20;
  const numTurns = Math.floor(allMessages.length / 2);

  const msgTokens = precomputeMessageTokens(allMessages);
  const systemPromptTokens = countTokens(systemPrompt);

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

    // Last (windowSize - 1) history messages
    const windowStart = Math.max(0, historyMsgCount - (windowSize - 1));
    const windowTokens = (cumMsg[historyMsgCount] - cumMsg[windowStart]);

    const turnTokens = (4 + systemPromptTokens) +
      windowTokens +
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

function simulateAllWindows(systemPrompt, allMessages) {
  const windowSizes = [4, 8, 12, 20, 40];
  return windowSizes.map(size => simulate(systemPrompt, allMessages, { windowSize: size }));
}

module.exports = { simulate, simulateAllWindows, STRATEGY_NAME };
