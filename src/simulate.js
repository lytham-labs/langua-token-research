/**
 * simulate.js
 * Main simulation runner — updated with REAL Langua constants.
 *
 * Runs real-system and proposed-system scenarios across realistic conversation lengths.
 * Outputs raw results to results/raw-results.json.
 *
 * Usage: node src/simulate.js
 */

const fs = require('fs');
const path = require('path');

const {
  generateRealisticLanguaConversation,
  generateSystemPrompt,
} = require('./conversation-simulator');
const { countMessages, countTokens, precomputeMessageTokens } = require('./tokenizer');

const currentStrategy  = require('./strategies/summarization-current');
const proposedStrategy = require('./strategies/summarization-proposed');
const noMgmtStrategy   = require('./strategies/no-management');
const windowStrategy   = require('./strategies/truncation-window');

// Try to load chalk, fall back gracefully if unavailable
let chalk;
try {
  chalk = require('chalk');
} catch (e) {
  chalk = {
    blue: s => s, cyan: s => s, green: s => s,
    yellow: s => s, red: s => s, bold: s => s,
    magenta: s => s, white: s => s, gray: s => s,
  };
}

// ─── Configuration ──────────────────────────────────────────────────────────

const SCENARIO_TURNS = [30, 60, 100, 120, 150];
const RUNS_PER_SCENARIO = 3;

// ─── Helpers ────────────────────────────────────────────────────────────────

function log(msg) { console.log(msg); }
function logSection(title) {
  console.log('\n' + chalk.bold(chalk.blue('═'.repeat(60))));
  console.log(chalk.bold(chalk.blue(`  ${title}`)));
  console.log(chalk.bold(chalk.blue('═'.repeat(60))));
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

// ─── Fast incremental threshold simulation ───────────────────────────────────

function simulateWithCustomTrigger(systemPrompt, allMessages, triggerTurn) {
  const SUMMARY_TOKENS = 500;
  const SUMMARIZATION_SYSTEM_PROMPT_TOKENS = 500;
  const TURNS_TO_KEEP_UNSUMMARIZED = 15;
  const KEEP_RECENT_MESSAGES = 40;
  const RESUMMARY_TURN_INCREMENT = 15;

  const numTurns = Math.floor(allMessages.length / 2);

  const msgTokens = precomputeMessageTokens(allMessages);
  const systemPromptTokens = countTokens(systemPrompt);
  // Approximate summary msg tokens
  const summaryMsgTokens = 4 + 6 + SUMMARY_TOKENS; // approx

  const cumMsg = new Array(msgTokens.length + 1).fill(0);
  for (let i = 0; i < msgTokens.length; i++) {
    cumMsg[i + 1] = cumMsg[i] + msgTokens[i];
  }

  const BASE_OVERHEAD = 3;
  const tokensPerTurn = [];
  let totalTokens = 0;
  let summaryCallCost = 0;
  let hasSummary = false;
  let currentSummaryMsgTokens = 0;
  let lastSummaryAtTurn = -1;

  for (let turn = 0; turn < numTurns; turn++) {
    const historyMsgCount = turn * 2;
    const currentMsgIdx = turn * 2;

    const shouldFirst = (turn === triggerTurn && !hasSummary);
    const shouldResummary = (hasSummary && turn >= lastSummaryAtTurn + RESUMMARY_TURN_INCREMENT);

    if (shouldFirst || shouldResummary) {
      const turnsBefore = turn - TURNS_TO_KEEP_UNSUMMARIZED;
      const msgsBefore = Math.max(0, turnsBefore * 2);

      const olderBlockTokens = cumMsg[msgsBefore];
      let inputTokens = SUMMARIZATION_SYSTEM_PROMPT_TOKENS + olderBlockTokens + BASE_OVERHEAD;
      if (shouldResummary) inputTokens += currentSummaryMsgTokens;

      summaryCallCost += inputTokens + SUMMARY_TOKENS;
      hasSummary = true;
      currentSummaryMsgTokens = summaryMsgTokens;
      lastSummaryAtTurn = turn;
    }

    let turnTokens;
    if (!hasSummary) {
      // Unbounded pre-summary
      turnTokens = (4 + systemPromptTokens) +
        cumMsg[historyMsgCount] +
        msgTokens[currentMsgIdx] +
        BASE_OVERHEAD;
    } else {
      const recentStart = Math.max(0, historyMsgCount - KEEP_RECENT_MESSAGES);
      turnTokens = (4 + systemPromptTokens) +
        currentSummaryMsgTokens +
        (cumMsg[historyMsgCount] - cumMsg[recentStart]) +
        msgTokens[currentMsgIdx] +
        BASE_OVERHEAD;
    }

    tokensPerTurn.push(turnTokens);
    totalTokens += turnTokens;
  }

  totalTokens += summaryCallCost;

  return {
    triggerTurn,
    totalTokens,
    summaryCallCost,
    tokensPerTurn,
    cumulativeTokensByTurn: (() => {
      const cum = []; let run = 0;
      for (const t of tokensPerTurn) { run += t; cum.push(run); }
      return cum;
    })(),
  };
}

// ─── Re-summarization growing block analysis ─────────────────────────────────

function analyzeResummaryGrowth() {
  const FIRST_TRIGGER = 50;
  const RESUMMARY_INCREMENT = 15;
  const TURNS_TO_KEEP_UNSUMMARIZED = 15;
  const SUMMARIZATION_SYSTEM_PROMPT_TOKENS = 500;
  const SUMMARY_TOKENS_OUTPUT = 500;

  // Avg tokens per individual message for realistic_langua profile
  // 70% short (~37 tok/msg) + 20% medium (~82 tok/msg) + 10% long (~200 tok/msg)
  // avg ≈ 0.7*37 + 0.2*82 + 0.1*200 = 25.9 + 16.4 + 20 = 62.3 tokens/msg
  const AVG_TOKENS_PER_MSG = 62;
  const AVG_TOKENS_PER_TURN = AVG_TOKENS_PER_MSG * 2; // user + assistant

  const resummaryEvents = [];
  let oldSummaryTokens = 0;

  let triggerTurn = FIRST_TRIGGER;
  while (triggerTurn <= 150) {
    const turnsBefore = triggerTurn - TURNS_TO_KEEP_UNSUMMARIZED;
    const msgsBefore = Math.max(0, turnsBefore * 2);
    const olderBlockTokens = Math.round(msgsBefore * AVG_TOKENS_PER_MSG);

    const inputTokens = SUMMARIZATION_SYSTEM_PROMPT_TOKENS +
      (oldSummaryTokens > 0 ? oldSummaryTokens : 0) +
      olderBlockTokens;

    resummaryEvents.push({
      triggerTurn,
      numMsgsInBlock: msgsBefore,
      olderBlockTokens,
      oldSummaryTokens,
      totalInputTokens: inputTokens,
      outputTokens: SUMMARY_TOKENS_OUTPUT,
      totalCallCost: inputTokens + SUMMARY_TOKENS_OUTPUT,
      isFirstSummary: triggerTurn === FIRST_TRIGGER,
    });

    oldSummaryTokens = SUMMARY_TOKENS_OUTPUT;
    triggerTurn += RESUMMARY_INCREMENT;
  }

  return {
    description: 'Re-summarization call costs at each trigger point (real constants)',
    avgTokensPerMsg: AVG_TOKENS_PER_MSG,
    avgTokensPerTurn: AVG_TOKENS_PER_TURN,
    firstSummaryTriggerTurn: FIRST_TRIGGER,
    resummaryTurnIncrement: RESUMMARY_INCREMENT,
    events: resummaryEvents,
  };
}

// ─── Main Simulation ────────────────────────────────────────────────────────

async function runSimulations() {
  const results = {
    metadata: {
      generatedAt: new Date().toISOString(),
      scenarioTurns: SCENARIO_TURNS,
      runsPerScenario: RUNS_PER_SCENARIO,
      messageProfile: '70% short / 20% medium / 10% long (realistic_langua)',
      realConstants: {
        MINIMUM_MESSAGES_FOR_FIRST_SUMMARY: 100,
        FIRST_SUMMARY_TRIGGER_TURN: 50,
        MESSAGES_INCREMENT_FOR_RESUMMARY: 30,
        RESUMMARY_TURN_INCREMENT: 15,
        MESSAGES_TO_KEEP_UNSUMMARIZED: 30,
        KEEP_RECENT_MESSAGES_WORKER: 40,
        MAX_TOKENS: 30000,
        SUMMARIZATION_SYSTEM_PROMPT_TOKENS: 500,
        REAL_SUMMARY_TOKENS: 500,
      },
      proposedConstants: {
        MINIMUM_MESSAGES_FOR_FIRST_SUMMARY: 80,
        FIRST_SUMMARY_TRIGGER_TURN: 40,
        MESSAGES_INCREMENT_FOR_RESUMMARY: 40,
        RESUMMARY_TURN_INCREMENT: 20,
        MESSAGES_TO_KEEP_UNSUMMARIZED: 40,
        KEEP_RECENT_MESSAGES_WORKER: 40,
        FALLBACK_WINDOW_MESSAGES: 40,
        PROPOSED_SUMMARY_TOKENS: 300,
      },
    },
    scenarioResults: [],
    thresholdComparison: [],
    resummaryGrowthAnalysis: null,
    systemPromptTokens: countTokens(generateSystemPrompt()),
  };

  logSection('LANGUA TOKEN RESEARCH — REAL SYSTEM ANALYSIS');
  log(chalk.yellow(`  System prompt: ${results.systemPromptTokens} tokens`));
  log(chalk.yellow(`  Real first-summary trigger: turn 50 (message 100)`));
  log(chalk.yellow(`  Proposed first-summary trigger: turn 40 (message 80)`));

  // ── Phase 1: Main Scenarios ────────────────────────────────────────────────

  logSection('Phase 1: Main Scenarios');

  for (const numTurns of SCENARIO_TURNS) {
    logProgress(`Running ${numTurns}-turn scenario (${RUNS_PER_SCENARIO} runs)...`);

    const scenarioRuns = [];

    for (let r = 0; r < RUNS_PER_SCENARIO; r++) {
      const { messages, systemPrompt, conversationTokens } =
        generateRealisticLanguaConversation(numTurns);

      log(chalk.gray(`     Run ${r+1}: conv=${conversationTokens} tok`));

      const currentResult     = currentStrategy.simulate(systemPrompt, messages);
      const proposedResult    = proposedStrategy.simulate(systemPrompt, messages);
      const noSummaryBugResult= currentStrategy.simulateNoSummaryPath(systemPrompt, messages);
      const window20Result    = windowStrategy.simulate(systemPrompt, messages, { windowSize: 20 });
      const noMgmtResult      = noMgmtStrategy.simulate(systemPrompt, messages);

      scenarioRuns.push({
        runIndex: r,
        numTurns,
        conversationTokens,
        systemPromptTokens: results.systemPromptTokens,
        strategies: {
          current:      currentResult,
          proposed:     proposedResult,
          noSummaryBug: noSummaryBugResult,
          window20:     window20Result,
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

    const strategyKeys = ['current', 'proposed', 'noSummaryBug', 'window20', 'noMgmt'];
    for (const key of strategyKeys) {
      const allRuns = scenarioRuns.map(r => r.strategies[key]);
      aggregate.strategies[key] = {
        strategyName: allRuns[0].strategyName,
        config: allRuns[0].config,
        avgTotalTokens: Math.round(avg(allRuns.map(r => r.totalTokens))),
        avgSummaryCallCost: Math.round(avg(allRuns.map(r => r.summaryCallCost || 0))),
        avgTokensPerTurn: averageTokensPerTurn(allRuns.map(r => r.tokensPerTurn)),
        firstTurnTokens: allRuns[0].tokensPerTurn[0],
        lastTurnTokens: allRuns[0].tokensPerTurn[allRuns[0].tokensPerTurn.length - 1],
        rawRuns: allRuns.map(r => ({
          totalTokens: r.totalTokens,
          summaryCallCost: r.summaryCallCost || 0,
          tokensPerTurn: r.tokensPerTurn,
        })),
      };
    }

    results.scenarioResults.push(aggregate);

    log(chalk.green(`     ✓ ${numTurns}-turn complete`));
    log(chalk.gray(`       Current:  ${aggregate.strategies.current.avgTotalTokens.toLocaleString()}`));
    log(chalk.gray(`       Proposed: ${aggregate.strategies.proposed.avgTotalTokens.toLocaleString()}`));
    log(chalk.gray(`       Bug path: ${aggregate.strategies.noSummaryBug.avgTotalTokens.toLocaleString()}`));
  }

  // ── Phase 2: Threshold Comparison ─────────────────────────────────────────

  logSection('Phase 2: First-Summary Threshold Comparison');
  logProgress('Testing first-summary trigger at turn 20 / 30 / 50 on 120-turn conversations...');

  const THRESHOLD_TURNS = [20, 30, 50];
  const thresholdRuns = [];

  for (let r = 0; r < RUNS_PER_SCENARIO; r++) {
    const { messages, systemPrompt } = generateRealisticLanguaConversation(120);
    const thresholdRunResults = { runIndex: r, byThreshold: {} };
    for (const triggerTurn of THRESHOLD_TURNS) {
      thresholdRunResults.byThreshold[triggerTurn] =
        simulateWithCustomTrigger(systemPrompt, messages, triggerTurn);
    }
    thresholdRuns.push(thresholdRunResults);
  }

  for (const triggerTurn of THRESHOLD_TURNS) {
    const allResults = thresholdRuns.map(r => r.byThreshold[triggerTurn]);
    const avgTotal = Math.round(avg(allResults.map(r => r.totalTokens)));
    results.thresholdComparison.push({
      triggerTurn,
      numMessages: triggerTurn * 2,
      avgTotalTokens: avgTotal,
      avgSummaryCallCost: Math.round(avg(allResults.map(r => r.summaryCallCost || 0))),
      avgTokensPerTurn: averageTokensPerTurn(allResults.map(r => r.tokensPerTurn)),
      rawRuns: allResults.map(r => ({ totalTokens: r.totalTokens, tokensPerTurn: r.tokensPerTurn })),
    });
    log(chalk.gray(`     Trigger at turn ${triggerTurn} (${triggerTurn*2} msgs): ${avgTotal.toLocaleString()} total tokens`));
  }

  // ── Phase 3: Re-summarization Growing Block ────────────────────────────────

  logSection('Phase 3: Re-summarization Growing Block Analysis');
  results.resummaryGrowthAnalysis = analyzeResummaryGrowth();
  log(chalk.green(`  ✓ Re-summary growth computed for turns 50–150`));

  // ── Save Results ───────────────────────────────────────────────────────────

  const resultsDir = path.join(__dirname, '..', 'results');
  fs.mkdirSync(resultsDir, { recursive: true });

  const outputPath = path.join(resultsDir, 'raw-results.json');
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));

  logSection('SIMULATION COMPLETE');
  log(chalk.green(`✓ Results written to ${outputPath}`));
  log('');

  return results;
}

runSimulations().catch(err => {
  console.error('Simulation failed:', err);
  process.exit(1);
});
