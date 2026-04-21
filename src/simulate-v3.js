/**
 * simulate-v3.js
 * V3 simulation — incorporates all research findings:
 *   1. GPT-5.1 as primary model (not GPT-4.1)
 *   2. Eval-proven window=6 from production data (252 runs, 6 context sizes)
 *   3. Full output token modeling (previously ignored)
 *   4. Prompt caching analysis (system prompt stable = 50% discount)
 *   5. Architecture-accurate dual-path modeling
 *   6. Branch feat/context-window-cap-no-summary analysis (KEEP=4)
 *
 * Usage: node src/simulate-v3.js
 */

const fs = require('fs');
const path = require('path');

const {
  generateRealisticLanguaConversation,
  generateSystemPrompt,
} = require('./conversation-simulator');
const { countTokens, precomputeMessageTokens } = require('./tokenizer');

const currentStrategy     = require('./strategies/summarization-current');
const incrementalStrategy = require('./strategies/summarization-incremental');
const optimalStrategy     = require('./strategies/summarization-optimal');
const windowStrategy      = require('./strategies/truncation-window');

let chalk;
try { chalk = require('chalk'); }
catch(e) {
  chalk = { blue: s=>s, cyan: s=>s, green: s=>s, yellow: s=>s, red: s=>s,
    bold: s=>s, magenta: s=>s, white: s=>s, gray: s=>s };
}

// ─── Model Pricing (April 2026) ──────────────────────────────────────────────

const MODEL_PRICING = {
  // Primary chat model
  'gpt-5.1': {
    input: 2.00,   // Estimated — OpenAI hasn't published; using GPT-4.1 as proxy
    output: 8.00,  // Estimated
    cached: 1.00,  // Estimated 50% discount
    name: 'GPT-5.1 (primary chat model)',
    note: 'Pricing estimated; OpenAI has not published GPT-5.1 pricing as of Apr 2026',
  },
  // Summarization model (current)
  'gpt-4.1': {
    input: 2.00,
    output: 8.00,
    cached: 1.00,
    name: 'GPT-4.1 (current summarization)',
  },
  // Summarization model (recommended switch)
  'gpt-4.1-mini': {
    input: 0.40,
    output: 1.60,
    cached: 0.10,
    name: 'GPT-4.1-mini (recommended summarization)',
  },
  // Fallback for Anthropic users
  'claude-sonnet-4': {
    input: 3.00,   // claude-sonnet-4-20250514
    output: 15.00,
    cached: 0.30,  // Anthropic prompt caching: 90% discount
    name: 'Claude Sonnet 4 (Anthropic primary)',
  },
  'claude-haiku-4': {
    input: 0.80,
    output: 4.00,
    cached: 0.08,
    name: 'Claude Haiku 4 (Anthropic fallback / summarization)',
  },
};

const SCENARIO_TURNS = [20, 30, 60, 100, 120, 150];
const RUNS_PER_SCENARIO = 5;
const DAILY_CONVERSATIONS = 1000;

// Output:Input ratio for a language tutor (~150-250 word responses)
// Based on 750 max_completion_tokens set in worker, but avg response ~200 words ≈ 260 tokens
const OUTPUT_INPUT_RATIO = 0.18; // ~18% of input tokens appear as output tokens

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg) { console.log(msg); }
function logSection(title) {
  console.log('\n' + chalk.bold(chalk.blue('═'.repeat(64))));
  console.log(chalk.bold(chalk.blue(`  ${title}`)));
  console.log(chalk.bold(chalk.blue('═'.repeat(64))));
}
function logProgress(msg) { console.log(chalk.cyan('  →'), msg); }

function avg(arr) {
  if (!arr || arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function averageTokensPerTurn(allTurnsArrays) {
  if (!allTurnsArrays || allTurnsArrays.length === 0) return [];
  const maxLen = Math.max(...allTurnsArrays.map(a => a.length));
  const result = [];
  for (let i = 0; i < maxLen; i++) {
    const vals = allTurnsArrays.map(a => a[i]).filter(v => v !== undefined);
    result.push(Math.round(avg(vals)));
  }
  return result;
}

function costUSD(inputTokens, outputTokens, pricing) {
  return (inputTokens / 1_000_000) * pricing.input +
         (outputTokens / 1_000_000) * pricing.output;
}

function costWithCaching(inputTokens, cachedTokens, outputTokens, pricing) {
  const uncachedInputTokens = inputTokens - cachedTokens;
  return (uncachedInputTokens / 1_000_000) * pricing.input +
         (cachedTokens / 1_000_000) * (pricing.cached || pricing.input) +
         (outputTokens / 1_000_000) * pricing.output;
}

// ─── Eval Data Analysis ───────────────────────────────────────────────────────

function evalDataSummary() {
  // From production research (252 runs, 42 cases × 6 sizes)
  const evalResults = [
    { windowSize: 0,  avgScore: 0.540, contextDepScore: 0.163, contextIndepScore: 0.900, avgToolCalls: 0.500 },
    { windowSize: 2,  avgScore: 0.770, contextDepScore: 0.605, contextIndepScore: 0.883, avgToolCalls: 0.786 },
    { windowSize: 4,  avgScore: 0.815, contextDepScore: 0.712, contextIndepScore: 0.867, avgToolCalls: 0.833 },
    { windowSize: 6,  avgScore: 0.863, contextDepScore: 0.787, contextIndepScore: 0.900, avgToolCalls: 0.833 },
    { windowSize: 10, avgScore: 0.863, contextDepScore: 0.800, contextIndepScore: 0.883, avgToolCalls: 0.833 },
    { windowSize: 20, avgScore: 0.845, contextDepScore: 0.825, contextIndepScore: 0.800, avgToolCalls: 0.833 },
  ];

  // Production token measurement (50-message conversation)
  const productionMeasurement = {
    conversation: '50-message conversation (~5,600 chars)',
    cappedAt6: { memoryInputTokens: 4533, chatInputTokens: 2542, totalInputTokens: 7075, costPerTurn: 0.026 },
    uncapped:  { memoryInputTokens: 15123, chatInputTokens: 5342, totalInputTokens: 20465, costPerTurn: 0.067 },
    reduction: { pct: 65, costPerTurn: 0.041 },
  };

  return { evalResults, productionMeasurement };
}

// ─── Prompt Caching Analysis ──────────────────────────────────────────────────

function promptCachingAnalysis(scenarioResults, systemPromptTokens) {
  const results = [];

  for (const scenario of scenarioResults) {
    const numTurns = scenario.numTurns;
    // System prompt is re-sent every turn
    const totalSystemPromptTokens = systemPromptTokens * numTurns;
    // After first turn, cache hits on system prompt (50% discount OpenAI, 90% Anthropic)
    const cachableTokens = systemPromptTokens * (numTurns - 1); // turns 2 to N
    const openaiCacheSavings = cachableTokens * 0.50; // 50% discount
    const anthropicCacheSavings = cachableTokens * 0.90; // 90% discount

    const currentTokens = scenario.strategies.current.avgTotalTokens;
    const openaiSavingsPct = (openaiCacheSavings / currentTokens) * 100;
    const anthropicSavingsPct = (anthropicCacheSavings / currentTokens) * 100;

    results.push({
      numTurns,
      totalSystemPromptTokens,
      cachableTokens,
      openaiCacheSavings: Math.round(openaiCacheSavings),
      anthropicCacheSavings: Math.round(anthropicCacheSavings),
      openaiSavingsPct: +openaiSavingsPct.toFixed(1),
      anthropicSavingsPct: +anthropicSavingsPct.toFixed(1),
    });
  }

  return results;
}

// ─── Full Cost Model (Input + Output) ────────────────────────────────────────

function fullCostModel(scenarioResults) {
  const results = [];

  for (const scenario of scenarioResults) {
    const numTurns = scenario.numTurns;
    const strategies = {};

    for (const [key, strat] of Object.entries(scenario.strategies)) {
      const inputTokens = strat.avgTotalTokens;
      // Output tokens: tutor responds with ~200-250 words per turn ≈ 260 tokens
      // But in summarization-heavy strategies, some "turns" include summary calls
      // Use OUTPUT_INPUT_RATIO as a reasonable estimate for chat turns
      const outputTokens = Math.round(numTurns * 260); // ~260 tokens/response × turns

      strategies[key] = {
        avgTotalInputTokens: inputTokens,
        estimatedOutputTokens: outputTokens,
        // Cost with GPT-5.1
        costGPT51: +costUSD(inputTokens, outputTokens, MODEL_PRICING['gpt-5.1']).toFixed(4),
        // Cost with Claude Sonnet (Anthropic path)
        costClaude: +costUSD(inputTokens, outputTokens, MODEL_PRICING['claude-sonnet-4']).toFixed(4),
        // Daily cost at 1k sessions
        dailyCostGPT51: +(costUSD(inputTokens, outputTokens, MODEL_PRICING['gpt-5.1']) * DAILY_CONVERSATIONS).toFixed(2),
      };
    }

    results.push({ numTurns, strategies });
  }

  return results;
}

// ─── Main Simulation ──────────────────────────────────────────────────────────

async function runSimulations() {
  const systemPrompt = generateSystemPrompt();
  const systemPromptTokens = countTokens(systemPrompt);

  const results = {
    metadata: {
      version: 'v3',
      generatedAt: new Date().toISOString(),
      scenarioTurns: SCENARIO_TURNS,
      runsPerScenario: RUNS_PER_SCENARIO,
      messageProfile: '70% short / 20% medium / 10% long (realistic_langua)',
      primaryChatModel: 'gpt-5.1',
      summarizationModel: 'gpt-4.1',
      modelPricing: MODEL_PRICING,
      evalData: evalDataSummary(),
      architectureFindings: {
        primaryChatModel: 'GPT-5.1 (not GPT-4.1 as previously assumed)',
        summarizationModel: 'GPT-4.1 (should be GPT-4.1-mini)',
        contextAssembly: 'Rails sends ALL chat_messages to worker; worker caps via buildContextWithSummary',
        currentMainBranchCap: 40,
        contextWindowCapBranch: 'feat/context-window-cap-no-summary (KEEP=4, not yet merged)',
        evalProvenOptimum: 'window=6 messages (quality plateaus at 6; window=20 shows distraction effect)',
        gpt51InTokenCounter: false,
        gpt51ContextLimit: 'defaults to 20k recommended (model not in token-counter.js modelLimits)',
      },
    },
    scenarioResults: [],
    promptCachingAnalysis: null,
    fullCostModel: null,
    systemPromptTokens,
  };

  logSection('LANGUA TOKEN RESEARCH V3 — PRODUCTION ARCHITECTURE ANALYSIS');
  log(chalk.yellow(`  System prompt: ${systemPromptTokens} tokens`));
  log(chalk.yellow(`  Primary chat model: GPT-5.1 (REVISED from GPT-4.1)`));
  log(chalk.yellow(`  Eval-proven window: 6 messages (252 runs, 6 sizes)`));
  log(chalk.yellow(`  Strategies: current | incremental (v2) | optimal-v3 | window-6 | no-mgmt`));

  // ── Phase 1: Strategy Comparison ────────────────────────────────────────────

  logSection('Phase 1: Strategy Comparison');

  for (const numTurns of SCENARIO_TURNS) {
    logProgress(`Running ${numTurns}-turn scenario (${RUNS_PER_SCENARIO} runs)...`);

    const scenarioRuns = [];

    for (let r = 0; r < RUNS_PER_SCENARIO; r++) {
      const { messages, systemPrompt: sp, conversationTokens } =
        generateRealisticLanguaConversation(numTurns);

      const currentResult     = currentStrategy.simulate(sp, messages);
      const incrementalResult = incrementalStrategy.simulate(sp, messages);
      const optimalResult     = optimalStrategy.simulate(sp, messages);
      const window6Result     = windowStrategy.simulate(sp, messages, { windowSize: 6 });
      const noSummaryBugResult = currentStrategy.simulateNoSummaryPath(sp, messages);

      scenarioRuns.push({
        runIndex: r,
        numTurns,
        conversationTokens,
        strategies: {
          current:      currentResult,
          incremental:  incrementalResult,
          optimal:      optimalResult,
          window6:      window6Result,
          noSummaryBug: noSummaryBugResult,
        },
      });
    }

    const aggregate = {
      numTurns,
      numRuns: RUNS_PER_SCENARIO,
      avgConversationTokens: Math.round(avg(scenarioRuns.map(r => r.conversationTokens))),
      systemPromptTokens,
      strategies: {},
    };

    const strategyKeys = ['current', 'incremental', 'optimal', 'window6', 'noSummaryBug'];
    for (const key of strategyKeys) {
      const allRuns = scenarioRuns.map(r => r.strategies[key]);
      aggregate.strategies[key] = {
        strategyName: allRuns[0].strategyName,
        config: allRuns[0].config,
        avgTotalTokens: Math.round(avg(allRuns.map(r => r.totalTokens))),
        avgSummaryCallCost: Math.round(avg(allRuns.map(r => r.summaryCallCost || 0))),
        avgCacheDiscount: Math.round(avg(allRuns.map(r => r.cacheDiscount || 0))),
        avgEffectiveTotalTokens: Math.round(avg(allRuns.map(r => r.effectiveTotalTokens || r.totalTokens))),
        avgTokensPerTurn: averageTokensPerTurn(allRuns.map(r => r.tokensPerTurn)),
      };
    }

    results.scenarioResults.push(aggregate);

    log(chalk.green(`     ✓ ${numTurns} turns`));
    log(chalk.gray(`       Current:     ${aggregate.strategies.current.avgTotalTokens.toLocaleString()}`));
    log(chalk.gray(`       Incremental: ${aggregate.strategies.incremental.avgTotalTokens.toLocaleString()}`));
    log(chalk.gray(`       Optimal V3:  ${aggregate.strategies.optimal.avgTotalTokens.toLocaleString()} (${aggregate.strategies.optimal.avgEffectiveTotalTokens.toLocaleString()} after caching)`));
    log(chalk.gray(`       Window-6:    ${aggregate.strategies.window6.avgTotalTokens.toLocaleString()}`));
  }

  // ── Phase 2: Prompt Caching ──────────────────────────────────────────────────

  logSection('Phase 2: Prompt Caching Analysis');
  results.promptCachingAnalysis = promptCachingAnalysis(results.scenarioResults, systemPromptTokens);
  for (const r of results.promptCachingAnalysis) {
    log(chalk.gray(`  ${r.numTurns} turns: OpenAI saves ${r.openaiSavingsPct}% | Anthropic saves ${r.anthropicSavingsPct}%`));
  }

  // ── Phase 3: Full Cost Model (Input + Output) ────────────────────────────────

  logSection('Phase 3: Full Cost Model (Input + Output Tokens)');
  results.fullCostModel = fullCostModel(results.scenarioResults);
  const s60Full = results.fullCostModel.find(r => r.numTurns === 60);
  if (s60Full) {
    log(chalk.gray(`  60-turn conversation (GPT-5.1):`));
    log(chalk.gray(`    Current: $${s60Full.strategies.current.costGPT51} → Optimal: $${s60Full.strategies.optimal.costGPT51}`));
    log(chalk.gray(`    Daily 1k sessions: $${s60Full.strategies.current.dailyCostGPT51} → $${s60Full.strategies.optimal.dailyCostGPT51}`));
  }

  // ── Save Results ─────────────────────────────────────────────────────────────

  const resultsDir = path.join(__dirname, '..', 'results');
  fs.mkdirSync(resultsDir, { recursive: true });

  const rawPath = path.join(resultsDir, 'raw-results-v3.json');
  fs.writeFileSync(rawPath, JSON.stringify(results, null, 2));

  logSection('SIMULATION COMPLETE');
  log(chalk.green(`✓ Results written to ${rawPath}`));

  return results;
}

runSimulations().catch(err => {
  console.error('Simulation failed:', err);
  process.exit(1);
});
