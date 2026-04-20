/**
 * tokenizer.js
 * Token counting utility using tiktoken cl100k_base encoding.
 * Used by all strategy modules to ensure accurate, consistent token counts.
 */

const { get_encoding } = require('tiktoken');

let enc = null;

function getEncoder() {
  if (!enc) {
    enc = get_encoding('cl100k_base');
  }
  return enc;
}

/**
 * Count tokens in a raw string.
 * @param {string} text
 * @returns {number}
 */
function countTokens(text) {
  if (!text || typeof text !== 'string') return 0;
  const encoder = getEncoder();
  return encoder.encode(text).length;
}

/**
 * Count tokens for an array of chat messages.
 * Each message: { role: string, content: string }
 * Overhead per message: ~4 tokens (for role delimiter, content delimiter, etc.)
 * This matches the OpenAI token counting spec for chat completions.
 *
 * @param {Array<{role: string, content: string}>} messages
 * @returns {number}
 */
function countMessages(messages) {
  if (!Array.isArray(messages)) return 0;
  const encoder = getEncoder();
  let total = 0;
  for (const msg of messages) {
    // 4 tokens overhead per message (openai format: <|im_start|>role\ncontent<|im_end|>)
    total += 4;
    if (msg.role) total += encoder.encode(msg.role).length;
    if (msg.content) total += encoder.encode(msg.content).length;
  }
  // 3 tokens for priming the assistant reply
  total += 3;
  return total;
}

/**
 * Count tokens for a single message (without the trailing priming tokens).
 * Useful for precomputing per-message costs.
 * @param {{ role: string, content: string }} msg
 * @returns {number}
 */
function countSingleMessage(msg) {
  const encoder = getEncoder();
  let total = 4; // overhead
  if (msg.role) total += encoder.encode(msg.role).length;
  if (msg.content) total += encoder.encode(msg.content).length;
  return total;
}

/**
 * Precompute token counts for each message in an array.
 * Returns an array of per-message token counts (including 4-token overhead each).
 * The 3-token priming overhead is NOT included (add it separately when needed).
 *
 * This is the performance-optimized path for strategy simulations.
 * Precompute once, then use incremental sums instead of re-encoding full arrays.
 *
 * @param {Array<{role: string, content: string}>} messages
 * @returns {number[]}
 */
function precomputeMessageTokens(messages) {
  return messages.map(msg => countSingleMessage(msg));
}

module.exports = { countTokens, countMessages, countSingleMessage, precomputeMessageTokens };
