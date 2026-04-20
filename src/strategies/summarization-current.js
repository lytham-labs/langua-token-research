/**
 * summarization-current.js
 * Current Langua summarization strategy.
 *
 * Behavior:
 *   - System prompt (first system message)
 *   - Summary injected as second system message: "Previous conversation summary:\n<text>"
 *   - Last 40 messages from conversation history
 *   - New user message
 *
 * Key behaviors modeled:
 *   1. Summary is generated ONCE after a trigger turn (configurable: 10, 20, 30)
 *   2. Summary is FIXED SIZE — reused on every subsequent turn without regeneration
 *   3. The one-time summarization API call cost is added to total cost
 *   4. Before the trigger: ALL messages are included (unbounded — the current bug)
 *   5. After the trigger: summary + last 40 msgs (bounded)
 *
 * The "no summary path" bug:
 *   If the user never triggers summarization, ALL messages accumulate forever.
 *   This is modeled by the `withoutSummary` variant.
 */

const { countMessages, countTokens } = require('../tokenizer');

const STRATEGY_NAME = 'summarization-current';
const KEEP_RECENT_MESSAGES = 40;

/**
 * Simulate the current Langua strategy WITH summary triggered at a specific turn.
 *
 * @param {string} systemPrompt
 * @param {Array<{role: string, content: string}>} allMessages
 * @param {{
 *   triggerTurn: number,         // Turn number when summary is generated (default: 20)
 *   summaryTokens: number,       // Pre-computed summary token size
 *   summaryText: string,         // The actual summary text
 *   summaryStyle: string         // 'compact' or 'verbose'
 * }} config
 */
function simulate(systemPrompt, allMessages, config = {}) {
  const triggerTurn = config.triggerTurn || 20;
  const summaryTokens = config.summaryTokens || 800;
  const summaryText = config.summaryText || 'Previous conversation summary: ' + 'x'.repeat(100);
  const summaryStyle = config.summaryStyle || 'compact';

  const tokensPerTurn = [];
  let totalTokens = 0;
  let summaryCallCost = 0;

  const numTurns = Math.floor(allMessages.length / 2);
  let summaryGenerated = false;

  for (let turn = 0; turn < numTurns; turn++) {
    const historyMessages = allMessages.slice(0, turn * 2);
    const currentUserMessage = allMessages[turn * 2];

    // Generate summary at trigger turn
    if (turn === triggerTurn && !summaryGenerated) {
      summaryGenerated = true;
      // Cost of summarization API call:
      // Input: all messages up to this point (to be summarized)
      // Output: the summary itself
      const summaryInputTokens = countMessages([
        { role: 'system', content: systemPrompt },
        ...historyMessages,
      ]);
      summaryCallCost = summaryInputTokens + summaryTokens;
    }

    let contextMessages;

    if (!summaryGenerated) {
      // Pre-trigger: BUG — include ALL messages (unbounded)
      contextMessages = [
        { role: 'system', content: systemPrompt },
        ...historyMessages,
        currentUserMessage,
      ];
    } else {
      // Post-trigger: summary + last 40 messages
      const recentMessages = historyMessages.slice(-KEEP_RECENT_MESSAGES);
      const summarySystemMsg = `Previous conversation summary:\n${summaryText}`;

      contextMessages = [
        { role: 'system', content: systemPrompt },
        { role: 'system', content: summarySystemMsg },
        ...recentMessages,
        currentUserMessage,
      ];
    }

    const turnTokens = countMessages(contextMessages);
    tokensPerTurn.push(turnTokens);
    totalTokens += turnTokens;
  }

  // Add one-time summarization call cost to total
  totalTokens += summaryCallCost;

  const cumulativeTokensByTurn = [];
  let runningTotal = 0;
  for (const t of tokensPerTurn) {
    runningTotal += t;
    cumulativeTokensByTurn.push(runningTotal);
  }

  return {
    strategyName: `${STRATEGY_NAME}-trigger${triggerTurn}-${summaryStyle}`,
    tokensPerTurn,
    totalTokens,
    cumulativeTokensByTurn,
    summaryCallCost,
    summaryTokens,
    config: {
      triggerTurn,
      summaryTokens,
      summaryStyle,
      keepRecentMessages: KEEP_RECENT_MESSAGES,
      description: `Current Langua: system + summary (${summaryStyle}) + last 40 msgs, triggered at turn ${triggerTurn}`,
    },
  };
}

/**
 * Model the "no summary" path: ALL messages included forever (the bug).
 * This is what happens when no summarization has been triggered.
 */
function simulateNoSummaryPath(systemPrompt, allMessages) {
  const tokensPerTurn = [];
  let totalTokens = 0;

  const numTurns = Math.floor(allMessages.length / 2);

  for (let turn = 0; turn < numTurns; turn++) {
    const historyMessages = allMessages.slice(0, turn * 2);
    const currentUserMessage = allMessages[turn * 2];

    // No management at all — ALL messages sent every turn
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

  return {
    strategyName: 'current-no-summary-bug',
    tokensPerTurn,
    totalTokens,
    cumulativeTokensByTurn,
    summaryCallCost: 0,
    config: {
      description: 'Current Langua BUG: no summary triggered — ALL messages sent every turn (unbounded)',
    },
  };
}

module.exports = { simulate, simulateNoSummaryPath, STRATEGY_NAME };
