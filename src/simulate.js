/**
 * simulate.js
 * Main simulation runner.
 *
 * Runs all strategies across all conversation configurations and outputs
 * raw results to results/raw-results.json.
 *
 * Usage: node src/simulate.js
 */

const fs = require('fs');
const path = require('path');

const { generateConversation, generateMixedConversation, generateSystemPrompt, generateSummary } = require('./conversation-simulator');
const { countMessages, countTokens } = require('./tokenizer');

const oldStrategy     = require('./strategies/truncation-old');
const windowStrategy  = require('./strategies/truncation-window');
const currentStrategy = require('./strategies/summarization-current');
const hybridStrategy  = require('./strategies/summarization-hybrid');
const noMgmtStrategy  = require('./strategies/no-management');

// Try to load chalk, fall back gracefully if unavailable
let chalk;
try {
  chalk = require('chalk');
} catch (e) {
  chalk = {
    blue:    s => s, cyan:   s => s, green:  s => s,
    yellow:  s => s, red:    s => s, bold:   s => s,
    magenta: s => s, white:  s => s, gray:   s => s,
  };
}

// ─── Configuration ──────────────────────────────────────────────────────────

const CONVERSATION_LENGTHS = [20, 50, 100];
const MESSAGE_STYLES = ['short', 'medium', 'long'];
const WINDOW_SIZES = [4, 8, 12, 20, 40];
const TRIGGER_TURNS = [10, 20, 30];
const SUMMARY_STYLES = ['compact', 'verbose'];
const HYBRID_WINDOWS = [4, 8, 12, 20];

// ─── Helpers ────────────────────────────────────────────────────────────────

function log(msg) {
  console.log(msg);
}

function logSection(title) {
  console.log('\n' + chalk.bold(chalk.blue('═'.repeat(60))));
  console.log(chalk.bold(chalk.blue(`  ${title}`)));
  console.log(chalk.bold(chalk.blue('═'.repeat(60))));
}

function logProgress(msg) {
  console.log(chalk.cyan('  →'), msg);
}

// ─── Main Simulation ────────────────────────────────────────────────────────

async function runSimulations() {
  const results = {
    metadata: {
      generatedAt: new Date().toISOString(),
      conversationLengths: CONVERSATION_LENGTHS,
      messageStyles: MESSAGE_STYLES,
      strategies: [],
    },
    runs: [],
  };

  logSection('LANGUA TOKEN RESEARCH — SIMULATION START');

  // ── 1. Standard Scenarios ──────────────────────────────────────────────

  logSection('Phase 1: Standard Conversation Scenarios');

  for (const numTurns of CONVERSATION_LENGTHS) {
    for (const messageStyle of MESSAGE_STYLES) {
      logProgress(`Generating ${numTurns}-turn ${messageStyle} conversation...`);

      const { messages, systemPrompt } = generateConversation(numTurns, messageStyle);

      // Generate summaries at the midpoint of the conversation
      const halfwayMessages = messages.slice(0, Math.floor(messages.length / 2));
      const compactSummary = generateSummary(halfwayMessages, 'compact');
      const verboseSummary = generateSummary(halfwayMessages, 'verbose');

      const runId = `${numTurns}turns-${messageStyle}`;
      log(chalk.gray(`     System prompt: ${countTokens(systemPrompt)} tokens`));
      log(chalk.gray(`     Conversation: ${countMessages(messages)} tokens`));
      log(chalk.gray(`     Compact summary: ${compactSummary.tokens} tokens (${(compactSummary.ratio * 100).toFixed(1)}%)`));
      log(chalk.gray(`     Verbose summary: ${verboseSummary.tokens} tokens (${(verboseSummary.ratio * 100).toFixed(1)}%)`));

      const scenarioResults = {
        runId,
        numTurns,
        messageStyle,
        metadata: {
          systemPromptTokens: countTokens(systemPrompt),
          totalConversationTokens: countMessages(messages),
          compactSummaryTokens: compactSummary.tokens,
          verboseSummaryTokens: verboseSummary.tokens,
        },
        strategies: [],
      };

      // ── Strategy: Old Truncation ─────────────────────────────
      logProgress(`  [${runId}] Running old truncation strategy...`);
      const oldResult = oldStrategy.simulate(systemPrompt, messages);
      scenarioResults.strategies.push(oldResult);

      // ── Strategy: Window Truncation (all sizes) ──────────────
      logProgress(`  [${runId}] Running window truncation strategies...`);
      for (const windowSize of WINDOW_SIZES) {
        const windowResult = windowStrategy.simulate(systemPrompt, messages, { windowSize });
        scenarioResults.strategies.push(windowResult);
      }

      // ── Strategy: No Management ──────────────────────────────
      logProgress(`  [${runId}] Running no-management strategy...`);
      const noMgmtResult = noMgmtStrategy.simulate(systemPrompt, messages);
      scenarioResults.strategies.push(noMgmtResult);

      // ── Strategy: Current Langua (with summary, various triggers) ────
      logProgress(`  [${runId}] Running current Langua strategy...`);
      for (const triggerTurn of TRIGGER_TURNS.filter(t => t < numTurns)) {
        for (const summaryStyle of SUMMARY_STYLES) {
          const summary = summaryStyle === 'compact' ? compactSummary : verboseSummary;
          const currentResult = currentStrategy.simulate(systemPrompt, messages, {
            triggerTurn,
            summaryTokens: summary.tokens,
            summaryText: summary.text,
            summaryStyle,
          });
          scenarioResults.strategies.push(currentResult);
        }
      }

      // ── Strategy: Current Langua WITHOUT summary (the bug) ───
      logProgress(`  [${runId}] Running no-summary bug scenario...`);
      const noSummaryBugResult = currentStrategy.simulateNoSummaryPath(systemPrompt, messages);
      scenarioResults.strategies.push(noSummaryBugResult);

      // ── Strategy: Hybrid (all window sizes × summary styles) ─
      logProgress(`  [${runId}] Running hybrid strategies...`);
      for (const windowSize of HYBRID_WINDOWS) {
        for (const summaryStyle of SUMMARY_STYLES) {
          const summary = summaryStyle === 'compact' ? compactSummary : verboseSummary;
          const maxTrigger = Math.min(10, Math.floor(numTurns / 3));
          const hybridResult = hybridStrategy.simulate(systemPrompt, messages, {
            windowSize,
            triggerTurn: maxTrigger,
            summaryTokens: summary.tokens,
            summaryText: summary.text,
            summaryStyle,
          });
          scenarioResults.strategies.push(hybridResult);
        }
      }

      results.runs.push(scenarioResults);
    }
  }

  // ── 2. Realistic Langua User Scenario ─────────────────────────────────

  logSection('Phase 2: Realistic Langua User Scenario');
  logProgress('70% short / 20% medium / 10% long messages, 35 turns, 400-token system prompt');

  // Run this scenario multiple times to get stable averages
  const REALISTIC_RUNS = 5;
  const realisticScenarios = [];

  for (let r = 0; r < REALISTIC_RUNS; r++) {
    logProgress(`  Realistic run ${r + 1}/${REALISTIC_RUNS}...`);

    const { messages, systemPrompt } = generateMixedConversation(35, {
      short: 0.7, medium: 0.2, long: 0.1
    });

    const halfwayMessages = messages.slice(0, Math.floor(messages.length / 2));
    const compactSummary = generateSummary(halfwayMessages, 'compact');
    const verboseSummary = generateSummary(halfwayMessages, 'verbose');

    const runScenario = {
      runId: `realistic-run${r + 1}`,
      numTurns: 35,
      messageStyle: 'mixed-realistic',
      metadata: {
        systemPromptTokens: countTokens(systemPrompt),
        totalConversationTokens: countMessages(messages),
        compactSummaryTokens: compactSummary.tokens,
        verboseSummaryTokens: verboseSummary.tokens,
      },
      strategies: [],
    };

    // Old strategy
    runScenario.strategies.push(oldStrategy.simulate(systemPrompt, messages));

    // Window strategies
    for (const windowSize of WINDOW_SIZES) {
      runScenario.strategies.push(windowStrategy.simulate(systemPrompt, messages, { windowSize }));
    }

    // No management
    runScenario.strategies.push(noMgmtStrategy.simulate(systemPrompt, messages));

    // Current strategy (trigger at turn 20)
    for (const summaryStyle of SUMMARY_STYLES) {
      const summary = summaryStyle === 'compact' ? compactSummary : verboseSummary;
      runScenario.strategies.push(currentStrategy.simulate(systemPrompt, messages, {
        triggerTurn: 20,
        summaryTokens: summary.tokens,
        summaryText: summary.text,
        summaryStyle,
      }));
    }

    // No-summary bug
    runScenario.strategies.push(currentStrategy.simulateNoSummaryPath(systemPrompt, messages));

    // Hybrid strategies
    for (const windowSize of [8, 12, 20]) {
      for (const summaryStyle of SUMMARY_STYLES) {
        const summary = summaryStyle === 'compact' ? compactSummary : verboseSummary;
        runScenario.strategies.push(hybridStrategy.simulate(systemPrompt, messages, {
          windowSize,
          triggerTurn: 10,
          summaryTokens: summary.tokens,
          summaryText: summary.text,
          summaryStyle,
        }));
      }
    }

    realisticScenarios.push(runScenario);
  }

  results.realisticScenarios = realisticScenarios;

  // ── 3. Token Budget Analysis ───────────────────────────────────────────

  logSection('Phase 3: Token Budget Threshold Analysis');
  logProgress('Modeling when conversations hit 20k and 30k token limits...');

  const thresholdAnalysis = [];
  const MAX_TOKENS_OLD = 20000;
  const MAX_TOKENS_NEW = 30000;

  for (const messageStyle of MESSAGE_STYLES) {
    // Use a long conversation to find the threshold turn
    const { messages, systemPrompt } = generateConversation(100, messageStyle);
    const noMgmt = noMgmtStrategy.simulate(systemPrompt, messages);

    let hit20k = null;
    let hit30k = null;

    for (let i = 0; i < noMgmt.tokensPerTurn.length; i++) {
      const tokens = noMgmt.tokensPerTurn[i];
      if (hit20k === null && tokens >= MAX_TOKENS_OLD) {
        hit20k = { turn: i + 1, tokens };
      }
      if (hit30k === null && tokens >= MAX_TOKENS_NEW) {
        hit30k = { turn: i + 1, tokens };
      }
    }

    thresholdAnalysis.push({
      messageStyle,
      hit20kAt: hit20k,
      hit30kAt: hit30k,
      finalTurnTokens: noMgmt.tokensPerTurn[noMgmt.tokensPerTurn.length - 1],
    });

    log(chalk.gray(`     ${messageStyle}: hits 20k at turn ${hit20k ? hit20k.turn : '>100'}, 30k at turn ${hit30k ? hit30k.turn : '>100'}`));
  }

  results.thresholdAnalysis = thresholdAnalysis;

  // ── Save Results ───────────────────────────────────────────────────────

  const resultsDir = path.join(__dirname, '..', 'results');
  fs.mkdirSync(resultsDir, { recursive: true });

  const outputPath = path.join(resultsDir, 'raw-results.json');
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));

  logSection('SIMULATION COMPLETE');
  log(chalk.green(`✓ Results written to ${outputPath}`));
  log(chalk.green(`  Total runs: ${results.runs.length} standard + ${results.realisticScenarios.length} realistic`));
  log(chalk.green(`  Strategies per run: varies`));
  log('');

  return results;
}

// Run
runSimulations().catch(err => {
  console.error('Simulation failed:', err);
  process.exit(1);
});
