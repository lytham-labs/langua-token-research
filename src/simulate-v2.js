/**
 * simulate-v2.js
 * V2 simulation runner — incremental summarization + model cost analysis.
 *
 * New in v2:
 *   1. Incremental re-summarization strategy (constant per-call cost)
 *   2. Model cost comparison for summarization calls (gpt-4.1 vs gpt-4.1-mini vs haiku)
 *   3. User segment analysis (casual / engaged / power users)
 *   4. Token-based early trigger simulation
 *   5. Quality vs cost trade-off framework
 *
 * Usage: node src/simulate-v2.js
 */

const fs = require('fs');
const path = require('path');

const {
  generateRealisticLanguaConversation,
  generateSystemPrompt,
} = require('./conversation-simulator');
const { countTokens, precomputeMessageTokens } = require('./tokenizer');

const currentStrategy     = require('./strategies/summarization-current');
const proposedStrategy    = require('./strategies/summarization-proposed');
const incrementalStrategy = require('./strategies/summarization-incremental');
const noMgmtStrategy      = require('./strategies/no-management');
const windowStrategy      = require('./strategies/truncation-window');

// Try chalk; fall back to plain strings
let chalk;
try { chalk = require('chalk'); }
catch(e) {
  chalk = {
    blue: s => s, cyan: s => s, green: s => s, yellow: s => s,
    red: s => s, bold: s => s, magenta: s => s, white: s => s, gray: s => s,
  };
}

// ─── Configuration ──────────────────────────────────────────────────────────

const SCENARIO_TURNS = [20, 30, 60, 100, 120, 150];
const RUNS_PER_SCENARIO = 5;

// Model pricing (USD per 1M tokens, April 2026)
const MODEL_PRICING = {
  'gpt-4.1':             { input: 2.00,  output: 8.00,  name: 'GPT-4.1 (current)' },
  'gpt-4.1-mini':        { input: 0.40,  output: 1.60,  name: 'GPT-4.1-mini' },
  'claude-haiku':        { input: 0.80,  output: 4.00,  name: 'Claude Haiku 3.5' },
  'gpt-4o-mini':         { input: 0.15,  output: 0.60,  name: 'GPT-4o-mini' },
};

// Real summarization model — gpt-4.1 (as seen in Rails code)
const CURRENT_SUMMARIZATION_MODEL = 'gpt-4.1';
// Main chat model (what main turns cost)
const MAIN_CHAT_MODEL = 'gpt-4.1';

// User segment distribution (approximate Langua user base)
// Casual: 1-20 turns, Engaged: 21-60 turns, Power: 61+ turns
const USER_SEGMENTS = [
  { name: 'Casual',   turns: 15,  share: 0.55, description: '1-20 turn sessions (majority)' },
  { name: 'Engaged',  turns: 40,  share: 0.35, description: '21-60 turn sessions' },
  { name: 'Power',    turns: 100, share: 0.10, description: '60+ turn sessions (heavy users)' },
];

const DAILY_CONVERSATIONS = 1000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg)          { console.log(msg); }
function logSection(title) {
  console.log('\n' + chalk.bold(chalk.blue('═'.repeat(64))));
  console.log(chalk.bold(chalk.blue(`  ${title}`)));
  console.log(chalk.bold(chalk.blue('═'.repeat(64))));
}
function logProgress(msg)  { console.log(chalk.cyan('  →'), msg); }

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

function costUSD(tokens, pricePerMillion) {
  return (tokens / 1_000_000) * pricePerMillion;
}

// ─── Incremental vs Growing Block — Re-summary Cost Comparison ───────────────

function analyzeResummaryStrategies() {
  // Average tokens per individual message for realistic_langua profile
  // 70% short (~37 tok) + 20% medium (~82 tok) + 10% long (~200 tok) ≈ 62 tokens/msg
  const AVG_TOKENS_PER_MSG = 62;
  const SUMMARIZATION_SYSTEM_PROMPT = 500;
  const SUMMARY_OUTPUT = 300; // proposed tighter output

  const CURRENT_SUMMARY_OUTPUT = 500; // current: 800 max → ~500 avg

  // Growing block (current/proposed re-summary approach)
  function growingBlockCost(triggerTurn, keepUnsummarized, resummaryIncrement, firstTrigger, summaryOutput) {
    const events = [];
    let oldSummaryTokens = 0;

    for (let t = firstTrigger; t <= 150; t += resummaryIncrement) {
      const turnsBefore = t - keepUnsummarized;
      const msgsBefore = Math.max(0, turnsBefore * 2);
      const olderBlockTokens = Math.round(msgsBefore * AVG_TOKENS_PER_MSG);
      const inputTokens = SUMMARIZATION_SYSTEM_PROMPT + olderBlockTokens + (oldSummaryTokens > 0 ? (oldSummaryTokens + 10) : 0);
      events.push({
        triggerTurn: t,
        approach: 'growing-block',
        olderBlockTokens,
        oldSummaryTokens,
        inputTokens,
        outputTokens: summaryOutput,
        callCost: inputTokens + summaryOutput,
        isFirst: t === firstTrigger,
      });
      oldSummaryTokens = summaryOutput;
    }
    return events;
  }

  // Incremental approach: only new messages since last summary + old summary
  function incrementalCost(firstTrigger, keepUnsummarized, resummaryIncrement, summaryOutput) {
    const events = [];
    let lastSummarizedUpTo = 0;
    let oldSummaryTokens = 0;

    for (let t = firstTrigger; t <= 150; t += resummaryIncrement) {
      const turnsBefore = t - keepUnsummarized;
      const newSummarizedUpTo = Math.max(0, turnsBefore * 2);
      const newMsgsTokens = Math.round(Math.max(0, newSummarizedUpTo - lastSummarizedUpTo) * AVG_TOKENS_PER_MSG);
      const isFirst = t === firstTrigger;

      let inputTokens;
      if (isFirst) {
        // First summary: summarize everything from 0 to newSummarizedUpTo
        const olderBlockTokens = Math.round(newSummarizedUpTo * AVG_TOKENS_PER_MSG);
        inputTokens = SUMMARIZATION_SYSTEM_PROMPT + olderBlockTokens;
      } else {
        // Incremental: old summary + only new messages
        inputTokens = SUMMARIZATION_SYSTEM_PROMPT + (oldSummaryTokens + 10) + newMsgsTokens;
      }

      events.push({
        triggerTurn: t,
        approach: 'incremental',
        newMsgsTokens: isFirst ? Math.round(newSummarizedUpTo * AVG_TOKENS_PER_MSG) : newMsgsTokens,
        oldSummaryTokens,
        inputTokens,
        outputTokens: summaryOutput,
        callCost: inputTokens + summaryOutput,
        isFirst,
      });

      lastSummarizedUpTo = newSummarizedUpTo;
      oldSummaryTokens = summaryOutput;
    }
    return events;
  }

  const currentGrowing = growingBlockCost(50, 15, 15, 50, CURRENT_SUMMARY_OUTPUT);
  const proposedGrowing = growingBlockCost(40, 20, 20, 40, SUMMARY_OUTPUT);
  const proposedIncremental = incrementalCost(40, 20, 20, SUMMARY_OUTPUT);

  return {
    description: 'Re-summarization call cost comparison: growing-block vs incremental',
    avgTokensPerMsg: AVG_TOKENS_PER_MSG,
    currentGrowingBlock: currentGrowing,
    proposedGrowingBlock: proposedGrowing,
    proposedIncremental: proposedIncremental,
    // Total re-summary cost over 150 turns
    totals: {
      currentGrowing:       currentGrowing.reduce((sum, e) => sum + e.callCost, 0),
      proposedGrowing:      proposedGrowing.reduce((sum, e) => sum + e.callCost, 0),
      proposedIncremental:  proposedIncremental.reduce((sum, e) => sum + e.callCost, 0),
    },
  };
}

// ─── User Segment Analysis ───────────────────────────────────────────────────

function analyzeUserSegments(scenarioResults) {
  const segmentAnalysis = [];

  for (const segment of USER_SEGMENTS) {
    // Find the closest scenario to this segment's turn count
    const closest = scenarioResults.reduce((prev, curr) =>
      Math.abs(curr.numTurns - segment.turns) < Math.abs(prev.numTurns - segment.turns) ? curr : prev
    );

    const strategies = {
      current:     closest.strategies.current.avgTotalTokens,
      proposed:    closest.strategies.proposed.avgTotalTokens,
      incremental: closest.strategies.incremental ? closest.strategies.incremental.avgTotalTokens : null,
      noSummaryBug: closest.strategies.noSummaryBug.avgTotalTokens,
    };

    segmentAnalysis.push({
      segment: segment.name,
      turns: segment.turns,
      share: segment.share,
      dailyConvCount: Math.round(DAILY_CONVERSATIONS * segment.share),
      strategies,
      dailyCost: {
        current:     costUSD(strategies.current * Math.round(DAILY_CONVERSATIONS * segment.share), MODEL_PRICING[MAIN_CHAT_MODEL].input),
        proposed:    costUSD(strategies.proposed * Math.round(DAILY_CONVERSATIONS * segment.share), MODEL_PRICING[MAIN_CHAT_MODEL].input),
        incremental: strategies.incremental ? costUSD(strategies.incremental * Math.round(DAILY_CONVERSATIONS * segment.share), MODEL_PRICING[MAIN_CHAT_MODEL].input) : null,
      },
    });
  }

  return segmentAnalysis;
}

// ─── Model Cost Comparison for Summarization ─────────────────────────────────

function analyzeModelCosts(resummaryAnalysis) {
  // How much does the summarization model choice matter?
  // Total re-summary call cost over 150 turns per approach
  const results = [];

  for (const [modelKey, pricing] of Object.entries(MODEL_PRICING)) {
    const currentGrowingCost = costUSD(resummaryAnalysis.totals.currentGrowing, pricing.input) +
      costUSD(resummaryAnalysis.currentGrowingBlock.length * 500, pricing.output); // avg 500 tok output
    const incrementalCost = costUSD(resummaryAnalysis.totals.proposedIncremental, pricing.input) +
      costUSD(resummaryAnalysis.proposedIncremental.length * 300, pricing.output); // avg 300 tok output

    results.push({
      model: modelKey,
      name: pricing.name,
      inputPricePerM: pricing.input,
      outputPricePerM: pricing.output,
      // Cost for 1 full 150-turn conversation's summarization calls
      currentGrowingPerConv: +(currentGrowingCost.toFixed(4)),
      incrementalPerConv: +(incrementalCost.toFixed(4)),
      // Daily cost at 1000 conversations (only ~10% are power users doing 150 turns,
      // but use this to show the model cost sensitivity for heavy users)
      currentGrowingDaily: +(currentGrowingCost * 1000).toFixed(2),
      incrementalDaily: +(incrementalCost * 1000).toFixed(2),
    });
  }

  return results;
}

// ─── Main Simulation ─────────────────────────────────────────────────────────

async function runSimulations() {
  const results = {
    metadata: {
      version: 'v2',
      generatedAt: new Date().toISOString(),
      scenarioTurns: SCENARIO_TURNS,
      runsPerScenario: RUNS_PER_SCENARIO,
      messageProfile: '70% short / 20% medium / 10% long (realistic_langua)',
      modelPricing: MODEL_PRICING,
      currentSummarizationModel: CURRENT_SUMMARIZATION_MODEL,
      realConstants: {
        MINIMUM_MESSAGES_FOR_FIRST_SUMMARY: 100,
        FIRST_SUMMARY_TRIGGER_TURN: 50,
        MESSAGES_INCREMENT_FOR_RESUMMARY: 30,
        RESUMMARY_TURN_INCREMENT: 15,
        MESSAGES_TO_KEEP_UNSUMMARIZED: 30,
        KEEP_RECENT_MESSAGES_WORKER: 40,
        SUMMARIZATION_SYSTEM_PROMPT_TOKENS: 500,
        REAL_SUMMARY_OUTPUT_TOKENS: 500,
        noSummaryBug: 'ALL historical messages sent when no summary exists',
      },
      proposedConstants: {
        label: 'Proposed (same as v1)',
        MINIMUM_MESSAGES_FOR_FIRST_SUMMARY: 80,
        FIRST_SUMMARY_TRIGGER_TURN: 40,
        MESSAGES_INCREMENT_FOR_RESUMMARY: 40,
        RESUMMARY_TURN_INCREMENT: 20,
        MESSAGES_TO_KEEP_UNSUMMARIZED: 40,
        KEEP_RECENT_MESSAGES_WORKER: 40,
        FALLBACK_WINDOW_MESSAGES: 40,
        PROPOSED_SUMMARY_OUTPUT_TOKENS: 300,
        reSummarizationApproach: 'growing-block (same as current, just fewer calls)',
      },
      incrementalConstants: {
        label: 'Incremental (new v2)',
        MINIMUM_MESSAGES_FOR_FIRST_SUMMARY: 80,
        FIRST_SUMMARY_TRIGGER_TURN: 40,
        MESSAGES_INCREMENT_FOR_RESUMMARY: 40,
        RESUMMARY_TURN_INCREMENT: 20,
        MESSAGES_TO_KEEP_UNSUMMARIZED: 40,
        KEEP_RECENT_MESSAGES_WORKER: 24,
        FALLBACK_WINDOW_MESSAGES: 20,
        SUMMARY_OUTPUT_TOKENS: 300,
        reSummarizationApproach: 'INCREMENTAL — only new messages since last summary + old summary',
      },
    },
    scenarioResults: [],
    resummaryAnalysis: null,
    modelCostComparison: null,
    userSegmentAnalysis: null,
    systemPromptTokens: countTokens(generateSystemPrompt()),
  };

  logSection('LANGUA TOKEN RESEARCH V2 — INCREMENTAL SUMMARIZATION');
  log(chalk.yellow(`  System prompt: ${results.systemPromptTokens} tokens`));
  log(chalk.yellow(`  Strategies: current | proposed | incremental | window-8 | no-mgmt`));
  log(chalk.yellow(`  New: incremental re-summary (constant call cost)`));

  // ── Phase 1: Main Scenarios ────────────────────────────────────────────────

  logSection('Phase 1: Strategy Comparison Across Turn Counts');

  for (const numTurns of SCENARIO_TURNS) {
    logProgress(`Running ${numTurns}-turn scenario (${RUNS_PER_SCENARIO} runs)...`);

    const scenarioRuns = [];

    for (let r = 0; r < RUNS_PER_SCENARIO; r++) {
      const { messages, systemPrompt, conversationTokens } =
        generateRealisticLanguaConversation(numTurns);

      const currentResult     = currentStrategy.simulate(systemPrompt, messages);
      const proposedResult    = proposedStrategy.simulate(systemPrompt, messages);
      const incrementalResult = incrementalStrategy.simulate(systemPrompt, messages);
      const noSummaryBugResult= currentStrategy.simulateNoSummaryPath(systemPrompt, messages);
      const window8Result     = windowStrategy.simulate(systemPrompt, messages, { windowSize: 8 });
      const noMgmtResult      = noMgmtStrategy.simulate(systemPrompt, messages);

      scenarioRuns.push({
        runIndex: r,
        numTurns,
        conversationTokens,
        strategies: {
          current:      currentResult,
          proposed:     proposedResult,
          incremental:  incrementalResult,
          noSummaryBug: noSummaryBugResult,
          window8:      window8Result,
          noMgmt:       noMgmtResult,
        },
      });
    }

    const aggregate = {
      numTurns,
      numRuns: RUNS_PER_SCENARIO,
      avgConversationTokens: Math.round(avg(scenarioRuns.map(r => r.conversationTokens))),
      systemPromptTokens: results.systemPromptTokens,
      strategies: {},
    };

    const strategyKeys = ['current', 'proposed', 'incremental', 'noSummaryBug', 'window8', 'noMgmt'];
    for (const key of strategyKeys) {
      const allRuns = scenarioRuns.map(r => r.strategies[key]);
      aggregate.strategies[key] = {
        strategyName: allRuns[0].strategyName,
        config: allRuns[0].config,
        avgTotalTokens: Math.round(avg(allRuns.map(r => r.totalTokens))),
        avgSummaryCallCost: Math.round(avg(allRuns.map(r => r.summaryCallCost || 0))),
        avgTokensPerTurn: averageTokensPerTurn(allRuns.map(r => r.tokensPerTurn)),
      };
    }

    results.scenarioResults.push(aggregate);

    log(chalk.green(`     ✓ ${numTurns} turns`));
    log(chalk.gray(`       Current:     ${aggregate.strategies.current.avgTotalTokens.toLocaleString()}`));
    log(chalk.gray(`       Proposed:    ${aggregate.strategies.proposed.avgTotalTokens.toLocaleString()}`));
    log(chalk.gray(`       Incremental: ${aggregate.strategies.incremental.avgTotalTokens.toLocaleString()}`));
    log(chalk.gray(`       Bug path:    ${aggregate.strategies.noSummaryBug.avgTotalTokens.toLocaleString()}`));
    log(chalk.gray(`       Window-8:    ${aggregate.strategies.window8.avgTotalTokens.toLocaleString()}`));
  }

  // ── Phase 2: Re-summarization Strategy Deep Dive ──────────────────────────

  logSection('Phase 2: Growing-Block vs Incremental Re-summarization');
  results.resummaryAnalysis = analyzeResummaryStrategies();
  log(chalk.green(`  ✓ Re-summary cost analysis complete`));
  log(chalk.gray(`    Current (growing, 150 turns):  ${results.resummaryAnalysis.totals.currentGrowing.toLocaleString()} tokens in summarization calls`));
  log(chalk.gray(`    Proposed (growing, 150 turns): ${results.resummaryAnalysis.totals.proposedGrowing.toLocaleString()} tokens in summarization calls`));
  log(chalk.gray(`    Incremental (150 turns):       ${results.resummaryAnalysis.totals.proposedIncremental.toLocaleString()} tokens in summarization calls`));

  // ── Phase 3: Model Cost Comparison ────────────────────────────────────────

  logSection('Phase 3: Summarization Model Cost Comparison');
  results.modelCostComparison = analyzeModelCosts(results.resummaryAnalysis);
  for (const m of results.modelCostComparison) {
    log(chalk.gray(`  ${m.name}: $${m.currentGrowingPerConv}/conv (current) → $${m.incrementalPerConv}/conv (incremental)`));
  }

  // ── Phase 4: User Segment Analysis ────────────────────────────────────────

  logSection('Phase 4: User Segment Analysis');
  results.userSegmentAnalysis = analyzeUserSegments(results.scenarioResults);
  for (const seg of results.userSegmentAnalysis) {
    log(chalk.gray(`  ${seg.segment} (${seg.turns} turns, ${Math.round(seg.share*100)}%): current=$${seg.dailyCost.current.toFixed(2)}/day | incremental=$${seg.dailyCost.incremental ? seg.dailyCost.incremental.toFixed(2) : 'N/A'}/day`));
  }

  // ── Save Raw Results ───────────────────────────────────────────────────────

  const resultsDir = path.join(__dirname, '..', 'results');
  fs.mkdirSync(resultsDir, { recursive: true });

  const rawPath = path.join(resultsDir, 'raw-results-v2.json');
  fs.writeFileSync(rawPath, JSON.stringify(results, null, 2));

  logSection('SIMULATION COMPLETE');
  log(chalk.green(`✓ Results written to ${rawPath}`));
  log('');

  return results;
}

runSimulations().catch(err => {
  console.error('Simulation failed:', err);
  process.exit(1);
});
