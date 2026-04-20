/**
 * no-management.js
 * No context management strategy (baseline/worst-case).
 * Uses incremental token counting for O(n) performance.
 */

const { countTokens, precomputeMessageTokens } = require('../tokenizer');

const STRATEGY_NAME = 'no-management';

function simulate(systemPrompt, allMessages) {
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
    strategyName: STRATEGY_NAME,
    tokensPerTurn,
    totalTokens,
    cumulativeTokensByTurn,
    growthCharacteristics: {
      firstTurnTokens: tokensPerTurn[0] || 0,
      lastTurnTokens: tokensPerTurn[tokensPerTurn.length - 1] || 0,
      growthType: 'quadratic (O(n²))',
    },
    config: {
      description: 'No management: ALL messages included every turn — unbounded quadratic growth',
    },
  };
}

module.exports = { simulate, STRATEGY_NAME };
