/**
 * truncation-old.js
 * OLD pre-summarization Langua strategy.
 *
 * Behavior: Keep ONLY the system prompt + the last 1 user message.
 * This was the original "extremely aggressive" truncation approach
 * before the summarization feature was added.
 *
 * Context window per API call: [system_prompt] + [last_user_message]
 * This is 2-3 messages total, with no conversation history preserved.
 *
 * Token cost per turn: very low and flat (doesn't grow with conversation length).
 * Context quality: poor — the model has NO memory of prior conversation.
 */

const { countMessages } = require('../tokenizer');

const STRATEGY_NAME = 'truncation-old';

/**
 * Simulate the old truncation strategy across a full conversation.
 *
 * @param {string} systemPrompt
 * @param {Array<{role: string, content: string}>} allMessages - Full conversation history
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

  // Messages come in pairs: [user, assistant, user, assistant, ...]
  // A "turn" is one user message + one assistant response
  const numTurns = Math.floor(allMessages.length / 2);

  for (let turn = 0; turn < numTurns; turn++) {
    // The "new" user message at this turn is at index turn * 2
    const currentUserMessage = allMessages[turn * 2];

    // OLD strategy: only send system prompt + the current user message
    // (no conversation history at all — model sees only the immediate question)
    const contextMessages = [
      { role: 'system', content: systemPrompt },
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
    strategyName: STRATEGY_NAME,
    tokensPerTurn,
    totalTokens,
    cumulativeTokensByTurn,
    config: {
      keepMessages: 1,
      includeHistory: false,
      description: 'System prompt + last 1 user message only (pre-summarization era)',
    },
  };
}

module.exports = { simulate, STRATEGY_NAME };
