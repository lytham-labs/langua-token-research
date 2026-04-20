/**
 * analyze.js
 * Analysis module for token strategy simulation results.
 *
 * Reads results/raw-results.json and produces:
 *   - results/analysis.json   (structured numerical analysis)
 *   - results/summary-report.md  (human-readable markdown report)
 *
 * Usage: node src/analyze.js
 */

const fs   = require('fs');
const path = require('path');
const { barChart, lineChart, table, formatNumber, formatCompact } = require('./charts');

// ─── Load Data ───────────────────────────────────────────────────────────────

const resultsDir  = path.join(__dirname, '..', 'results');
const rawPath     = path.join(resultsDir, 'raw-results.json');
const analysisPath = path.join(resultsDir, 'analysis.json');
const reportPath  = path.join(resultsDir, 'summary-report.md');

const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function avg(arr) {
  if (!arr || arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function sum(arr) {
  if (!arr || arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0);
}

function fmt(n) {
  return formatNumber(n, ' tok');
}

function fmtN(n) {
  if (typeof n !== 'number') return 'N/A';
  return n.toLocaleString();
}

function pct(a, b) {
  if (!b) return '0%';
  return `${((a / b) * 100).toFixed(1)}%`;
}

function savings(base, alt) {
  if (!base) return '0%';
  const s = ((base - alt) / base) * 100;
  if (s > 0) return `▼ ${s.toFixed(1)}% cheaper`;
  return `▲ ${Math.abs(s).toFixed(1)}% more expensive`;
}

// ─── Collect Strategy Stats Across All Standard Runs ─────────────────────────

function collectStrategyStats(runs) {
  const byStrategy = {};

  for (const run of runs) {
    for (const strategy of run.strategies) {
      const name = strategy.strategyName;
      if (!byStrategy[name]) {
        byStrategy[name] = {
          strategyName: name,
          config: strategy.config,
          runs: [],
          totalTokensAll: [],
          avgTokensPerTurnAll: [],
        };
      }

      const avgTpt = avg(strategy.tokensPerTurn);
      byStrategy[name].runs.push({
        runId: run.runId,
        numTurns: run.numTurns,
        messageStyle: run.messageStyle,
        totalTokens: strategy.totalTokens,
        avgTokensPerTurn: avgTpt,
        firstTurnTokens: strategy.tokensPerTurn[0],
        lastTurnTokens: strategy.tokensPerTurn[strategy.tokensPerTurn.length - 1],
      });

      byStrategy[name].totalTokensAll.push(strategy.totalTokens);
      byStrategy[name].avgTokensPerTurnAll.push(avgTpt);
    }
  }

  // Compute aggregates
  for (const name of Object.keys(byStrategy)) {
    const s = byStrategy[name];
    s.overallAvgTotalTokens = avg(s.totalTokensAll);
    s.overallAvgTokensPerTurn = avg(s.avgTokensPerTurnAll);
    s.minTotalTokens = Math.min(...s.totalTokensAll);
    s.maxTotalTokens = Math.max(...s.totalTokensAll);
  }

  return byStrategy;
}

// ─── Break-even Analysis ──────────────────────────────────────────────────────

function findBreakEven(baseStrategy, compareStrategy) {
  if (!baseStrategy || !compareStrategy) return null;

  const baseCumulative = baseStrategy.cumulativeTokensByTurn;
  const cmpCumulative  = compareStrategy.cumulativeTokensByTurn;

  // Also add summarization call cost offset for comparison strategies
  const summaryCallCost = compareStrategy.summaryCallCost || 0;

  for (let i = 0; i < Math.min(baseCumulative.length, cmpCumulative.length); i++) {
    const baseCost = baseCumulative[i];
    const cmpCost  = cmpCumulative[i] + summaryCallCost;
    if (cmpCost < baseCost) {
      return { turn: i + 1, baseTokens: baseCost, compareTokens: cmpCost };
    }
  }
  return null; // never breaks even within conversation length
}

// ─── Summary Bloat Analysis ───────────────────────────────────────────────────

function summaryBloatAnalysis(run) {
  const results = [];

  for (const strategy of run.strategies) {
    if (!strategy.strategyName.includes('summarization-current') ||
        strategy.strategyName.includes('no-summary')) continue;

    const summaryTokens = strategy.summaryTokens || 0;
    const avgPerTurn = avg(strategy.tokensPerTurn);

    // Only post-trigger turns have the summary injected
    const triggerTurn = strategy.config?.triggerTurn || 20;
    const postTriggerTurns = strategy.tokensPerTurn.slice(triggerTurn);
    const avgPostTrigger = avg(postTriggerTurns);

    results.push({
      strategyName: strategy.strategyName,
      summaryTokens,
      avgPerTurn: Math.round(avgPerTurn),
      avgPostTriggerPerTurn: Math.round(avgPostTrigger),
      summaryPctOfTurn: pct(summaryTokens, avgPostTrigger),
    });
  }

  return results;
}

// ─── Realistic Scenario Aggregation ──────────────────────────────────────────

function aggregateRealisticScenarios(scenarios) {
  const byStrategy = {};

  for (const scenario of scenarios) {
    for (const strategy of scenario.strategies) {
      const name = strategy.strategyName;
      if (!byStrategy[name]) {
        byStrategy[name] = {
          strategyName: name,
          config: strategy.config,
          totalTokensSamples: [],
          avgTptSamples: [],
        };
      }
      byStrategy[name].totalTokensSamples.push(strategy.totalTokens);
      byStrategy[name].avgTptSamples.push(avg(strategy.tokensPerTurn));
    }
  }

  const aggregated = [];
  for (const name of Object.keys(byStrategy)) {
    const s = byStrategy[name];
    aggregated.push({
      strategyName: name,
      config: s.config,
      avgTotalTokens: Math.round(avg(s.totalTokensSamples)),
      avgTokensPerTurn: Math.round(avg(s.avgTptSamples)),
      minTotalTokens: Math.min(...s.totalTokensSamples),
      maxTotalTokens: Math.max(...s.totalTokensSamples),
    });
  }

  // Sort by avgTotalTokens
  aggregated.sort((a, b) => a.avgTotalTokens - b.avgTotalTokens);
  return aggregated;
}

// ─── Main Analysis ────────────────────────────────────────────────────────────

function analyze() {
  console.log('Analyzing simulation results...');

  const strategyStats    = collectStrategyStats(raw.runs);
  const realisticAgg     = aggregateRealisticScenarios(raw.realisticScenarios || []);
  const thresholdAnalysis = raw.thresholdAnalysis || [];

  // ── Per-scenario breakdown for key comparisons ────────────────────────

  // Find 50-turn medium scenario for detailed analysis
  const scenario50Medium = raw.runs.find(r => r.numTurns === 50 && r.messageStyle === 'medium');
  const scenario100Long  = raw.runs.find(r => r.numTurns === 100 && r.messageStyle === 'long');

  let breakEvenData = [];
  if (scenario50Medium) {
    const noMgmt    = scenario50Medium.strategies.find(s => s.strategyName === 'no-management');
    const current20 = scenario50Medium.strategies.find(s => s.strategyName.includes('summarization-current-trigger20-compact'));
    const hybrid12  = scenario50Medium.strategies.find(s => s.strategyName.includes('summarization-hybrid-w12-compact'));
    const window20  = scenario50Medium.strategies.find(s => s.strategyName === 'truncation-window-20');

    if (noMgmt && current20) {
      const be = findBreakEven(noMgmt, current20);
      if (be) breakEvenData.push({ comparison: 'NoMgmt vs Current (compact, trigger 20)', ...be });
    }
    if (noMgmt && hybrid12) {
      const be = findBreakEven(noMgmt, hybrid12);
      if (be) breakEvenData.push({ comparison: 'NoMgmt vs Hybrid-w12 (compact)', ...be });
    }
    if (noMgmt && window20) {
      const be = findBreakEven(noMgmt, window20);
      if (be) breakEvenData.push({ comparison: 'NoMgmt vs Window-20', ...be });
    }
  }

  let bloatData = [];
  if (scenario50Medium) {
    bloatData = summaryBloatAnalysis(scenario50Medium);
  }

  // ── Compile analysis JSON ─────────────────────────────────────────────

  const analysis = {
    generatedAt: new Date().toISOString(),
    strategyStats,
    realisticScenario: realisticAgg,
    thresholdAnalysis,
    breakEvenData,
    bloatData,
    scenario50Medium: scenario50Medium ? {
      numTurns: scenario50Medium.numTurns,
      messageStyle: scenario50Medium.messageStyle,
      metadata: scenario50Medium.metadata,
      strategies: scenario50Medium.strategies.map(s => ({
        strategyName: s.strategyName,
        totalTokens: s.totalTokens,
        avgTokensPerTurn: Math.round(avg(s.tokensPerTurn)),
        firstTurnTokens: s.tokensPerTurn[0],
        lastTurnTokens: s.tokensPerTurn[s.tokensPerTurn.length - 1],
      })),
    } : null,
  };

  fs.writeFileSync(analysisPath, JSON.stringify(analysis, null, 2));
  console.log(`Analysis written to ${analysisPath}`);

  // ── Generate Report ───────────────────────────────────────────────────

  const report = generateReport(analysis, raw);
  fs.writeFileSync(reportPath, report);
  console.log(`Report written to ${reportPath}`);

  return analysis;
}

// ─── Report Generation ────────────────────────────────────────────────────────

function generateReport(analysis, raw) {
  const lines = [];

  const { strategyStats, realisticScenario, thresholdAnalysis,
          breakEvenData, bloatData, scenario50Medium } = analysis;

  // ════════════════════════════════════════════════════════════════════════════
  lines.push('# Langua Token Research — Context Management Strategy Analysis');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // ── Executive Summary ──────────────────────────────────────────────────────
  lines.push('## Executive Summary');
  lines.push('');
  lines.push('This report analyzes token usage across five context management strategies for the Langua');
  lines.push('language-learning chat application. The analysis covers conversations of 20, 50, and 100');
  lines.push('turns across short, medium, and long message styles, plus a realistic mixed-style scenario.');
  lines.push('');
  lines.push('### Key Findings at a Glance');
  lines.push('');

  // Pull out key numbers from the realistic scenario
  const realisticNoMgmt    = realisticScenario.find(s => s.strategyName === 'no-management');
  const realisticCurrent   = realisticScenario.find(s => s.strategyName?.includes('summarization-current-trigger20-compact'));
  const realisticOld       = realisticScenario.find(s => s.strategyName === 'truncation-old');
  const realisticBestHybrid = realisticScenario.find(s => s.strategyName?.includes('summarization-hybrid-w12-compact'));
  const realisticWindow20  = realisticScenario.find(s => s.strategyName === 'truncation-window-20');
  const realisticNoBug     = realisticScenario.find(s => s.strategyName === 'current-no-summary-bug');

  lines.push('```');
  lines.push('Realistic Langua User (35 turns, 70% short / 20% medium / 10% long messages):');
  lines.push('');
  if (realisticOld)       lines.push(`  Old strategy (1 msg):          ${fmtN(realisticOld.avgTotalTokens)} total tokens   ${fmtN(realisticOld.avgTokensPerTurn)} avg/turn`);
  if (realisticWindow20)  lines.push(`  Window-20:                     ${fmtN(realisticWindow20.avgTotalTokens)} total tokens   ${fmtN(realisticWindow20.avgTokensPerTurn)} avg/turn`);
  if (realisticCurrent)   lines.push(`  Current Langua (compact sum):  ${fmtN(realisticCurrent.avgTotalTokens)} total tokens   ${fmtN(realisticCurrent.avgTokensPerTurn)} avg/turn`);
  if (realisticBestHybrid)lines.push(`  Hybrid w12 (compact sum):      ${fmtN(realisticBestHybrid.avgTotalTokens)} total tokens   ${fmtN(realisticBestHybrid.avgTokensPerTurn)} avg/turn`);
  if (realisticNoBug)     lines.push(`  No-summary BUG (all msgs):     ${fmtN(realisticNoBug.avgTotalTokens)} total tokens   ${fmtN(realisticNoBug.avgTokensPerTurn)} avg/turn`);
  if (realisticNoMgmt)    lines.push(`  No management (unbounded):     ${fmtN(realisticNoMgmt.avgTotalTokens)} total tokens   ${fmtN(realisticNoMgmt.avgTokensPerTurn)} avg/turn`);
  lines.push('```');
  lines.push('');

  // ── Context of the Current System ─────────────────────────────────────────
  lines.push('---');
  lines.push('');
  lines.push('## 1. Current Langua System Architecture');
  lines.push('');
  lines.push('The current `langua-chat-worker` sends API calls structured as:');
  lines.push('');
  lines.push('```');
  lines.push('[system_prompt]          <-- persona, instructions, language config');
  lines.push('[summary_system_msg]     <-- "Previous conversation summary:\\n<text>" (2nd system msg)');
  lines.push('[last 40 messages]       <-- KEEP_RECENT_MESSAGES = 40');
  lines.push('[new user message]       <-- current turn');
  lines.push('```');
  lines.push('');
  lines.push('**Key parameters:**');
  lines.push('- `KEEP_RECENT_MESSAGES = 40`');
  lines.push('- `MAX_TOKENS = 30,000` (raised from 20,000 when summarization was added)');
  lines.push('- Summary triggers: configurable, injected as second system message');
  lines.push('- `truncateMessageData()` kicks in when over 30k tokens → keeps last 40 msgs anyway');
  lines.push('');
  lines.push('**Critical issues identified:**');
  lines.push('');
  lines.push('1. **No-summary bug**: When no summary has been generated, ALL historical messages');
  lines.push('   are included with no cap. Token usage grows quadratically (O(n²)) with conversation length.');
  lines.push('');
  lines.push('2. **Verbose summaries**: Without an explicit token budget, summaries can be ~45%');
  lines.push('   of the total conversation size, adding significant overhead on every subsequent turn.');
  lines.push('');
  lines.push('3. **40-message window is large**: At medium message length, 40 messages ≈ 5,000–8,000');
  lines.push('   tokens of recent history, plus a verbose summary can push per-turn costs very high.');
  lines.push('');

  // ── Strategy Definitions ───────────────────────────────────────────────────
  lines.push('---');
  lines.push('');
  lines.push('## 2. Strategy Definitions');
  lines.push('');
  lines.push('| Strategy | Description | Window | Summary |');
  lines.push('|----------|-------------|--------|---------|');
  lines.push('| **truncation-old** | Pre-summarization: system + 1 user msg only | 1 msg | None |');
  lines.push('| **truncation-window-N** | Sliding window of last N messages | N msgs | None |');
  lines.push('| **no-management** | All messages every turn (unbounded) | All | None |');
  lines.push('| **current-no-summary-bug** | Current system when no summary triggered | All | None |');
  lines.push('| **summarization-current** | System + summary + last 40 msgs | 40 msgs | Once |');
  lines.push('| **summarization-hybrid** | System + capped summary (≤500t) + last N | N msgs | Once |');
  lines.push('');

  // ── Threshold Analysis ─────────────────────────────────────────────────────
  lines.push('---');
  lines.push('');
  lines.push('## 3. Token Limit Breach Analysis');
  lines.push('');
  lines.push('Without any context management, when does the per-turn token count breach limits?');
  lines.push('(100-turn conversation, unbounded no-management strategy)');
  lines.push('');

  const thresholdHeaders = ['Message Style', 'Hits 20k Limit At Turn', 'Hits 30k Limit At Turn', 'Turn-100 Token Count'];
  const thresholdRows = thresholdAnalysis.map(t => [
    t.messageStyle,
    t.hit20kAt ? `Turn ${t.hit20kAt.turn} (${fmtN(t.hit20kAt.tokens)} tok)` : '> Turn 100',
    t.hit30kAt ? `Turn ${t.hit30kAt.turn} (${fmtN(t.hit30kAt.tokens)} tok)` : '> Turn 100',
    fmtN(t.finalTurnTokens),
  ]);

  lines.push('```');
  lines.push(table(thresholdHeaders, thresholdRows, { title: 'Token Limit Breach Points' }));
  lines.push('```');
  lines.push('');
  lines.push('**Interpretation:**');
  lines.push('- Short messages: very low per-message token count, limits hit late or not at all');
  lines.push('- Medium messages: moderate growth, 30k limit typically hit around turn 30-50');
  lines.push('- Long messages: aggressive growth — limits can be hit as early as turn 10-20');
  lines.push('- Once 30k is hit, `truncateMessageData()` kicks in and keeps last 40 anyway');
  lines.push('  (but ALL those tokens were still sent for the prior turns — wasted cost)');
  lines.push('');

  // ── 50-Turn Medium Scenario Detail ────────────────────────────────────────
  if (scenario50Medium) {
    lines.push('---');
    lines.push('');
    lines.push('## 4. Detailed Analysis: 50-Turn Medium Conversation');
    lines.push('');
    lines.push(`System prompt: ${fmtN(scenario50Medium.metadata.systemPromptTokens)} tokens`);
    lines.push(`Total conversation tokens: ${fmtN(scenario50Medium.metadata.totalConversationTokens)} tokens`);
    lines.push(`Compact summary size: ${fmtN(scenario50Medium.metadata.compactSummaryTokens)} tokens`);
    lines.push(`Verbose summary size: ${fmtN(scenario50Medium.metadata.verboseSummaryTokens)} tokens`);
    lines.push('');

    // Sort strategies by total tokens
    const sorted = [...scenario50Medium.strategies].sort((a, b) => a.totalTokens - b.totalTokens);

    // Show bar chart
    const chartData = sorted.slice(0, 16).map(s => ({
      label: s.strategyName.replace('summarization-', 'sum-').replace('truncation-', 'win-').substring(0, 35),
      value: s.totalTokens,
    }));

    lines.push('### Total Token Cost by Strategy (50-turn medium conversation)');
    lines.push('');
    lines.push('```');
    lines.push(barChart(chartData, {
      width: 45,
      unit: ' tokens',
      title: 'Total Tokens for Entire Conversation (50 turns, medium messages)',
    }));
    lines.push('```');
    lines.push('');

    // Comparison table
    const refStrategy = scenario50Medium.strategies.find(s => s.strategyName === 'no-management');
    const refTotal = refStrategy ? refStrategy.totalTokens : 1;

    const tableHeaders = ['Strategy', 'Total Tokens', 'Avg/Turn', 'vs No-Management'];
    const tableRows = sorted.map(s => [
      s.strategyName.substring(0, 40),
      fmtN(s.totalTokens),
      fmtN(s.avgTokensPerTurn),
      savings(refTotal, s.totalTokens),
    ]);

    lines.push('### Strategy Comparison Table');
    lines.push('');
    lines.push('```');
    lines.push(table(tableHeaders, tableRows, { title: 'Strategy Comparison: 50 Turns, Medium Messages' }));
    lines.push('```');
    lines.push('');
  }

  // ── Turn-by-Turn Token Growth Charts ──────────────────────────────────────

  // Find 50-turn medium for chart data
  const s50m = raw.runs.find(r => r.numTurns === 50 && r.messageStyle === 'medium');
  if (s50m) {
    lines.push('---');
    lines.push('');
    lines.push('## 5. Token Growth Per Turn: 50-Turn Medium Conversation');
    lines.push('');
    lines.push('These charts show tokens-per-turn across the conversation life for key strategies.');
    lines.push('');

    // Select a representative set of strategies to chart
    const toChart = [
      { name: 'no-management',                       label: 'NoMgmt (unbounded)' },
      { name: 'current-no-summary-bug',              label: 'No-Summary BUG' },
      { name: 'summarization-current-trigger20-compact', label: 'Current (compact, t=20)' },
      { name: 'summarization-current-trigger20-verbose', label: 'Current (verbose, t=20)' },
      { name: 'summarization-hybrid-w12-compact',    label: 'Hybrid w12 (compact)' },
      { name: 'truncation-window-20',                label: 'Window-20' },
      { name: 'truncation-window-8',                 label: 'Window-8' },
      { name: 'truncation-old',                      label: 'Old (1 msg)' },
    ];

    const series = [];
    for (const { name, label } of toChart) {
      const found = s50m.strategies.find(s => s.strategyName === name);
      if (found) {
        series.push({ label, values: found.tokensPerTurn });
      }
    }

    if (series.length > 0) {
      lines.push('```');
      lines.push(lineChart(series.slice(0, 4), {
        title: 'Tokens Per Turn: No-Management vs Current Strategies',
        height: 18,
        width: 55,
      }));
      lines.push('```');
      lines.push('');
      lines.push('```');
      lines.push(lineChart(series.slice(2), {
        title: 'Tokens Per Turn: Summarization vs Window vs Old',
        height: 18,
        width: 55,
      }));
      lines.push('```');
      lines.push('');
    }
  }

  // ── Break-even Analysis ───────────────────────────────────────────────────
  lines.push('---');
  lines.push('');
  lines.push('## 6. Break-Even Analysis');
  lines.push('');
  lines.push('At what turn does a summarization strategy begin saving tokens vs no-management?');
  lines.push('(Accounts for the one-time cost of the summarization API call)');
  lines.push('');

  if (breakEvenData.length > 0) {
    lines.push('```');
    lines.push('50-turn medium conversation break-even points:');
    lines.push('');
    for (const be of breakEvenData) {
      lines.push(`  ${be.comparison}`);
      lines.push(`    Break-even at: Turn ${be.turn}`);
      lines.push(`    At that point: base=${fmtN(be.baseTokens)}, compare=${fmtN(be.compareTokens)}`);
      lines.push('');
    }
    lines.push('```');
  } else {
    lines.push('No break-even data computed (strategies may always cost more or data unavailable).');
  }

  lines.push('');

  // ── Summary Bloat Analysis ────────────────────────────────────────────────
  lines.push('---');
  lines.push('');
  lines.push('## 7. Summary Bloat Analysis');
  lines.push('');
  lines.push('How much of each turn\'s token budget is consumed by the injected summary?');
  lines.push('(Post-trigger turns only, 50-turn medium conversation)');
  lines.push('');

  if (bloatData.length > 0) {
    lines.push('```');
    const bloatHeaders = ['Strategy', 'Summary Tokens', 'Avg/Turn Post-Trigger', 'Summary % of Turn'];
    const bloatRows = bloatData.map(b => [
      b.strategyName.replace('summarization-current-', '').substring(0, 30),
      fmtN(b.summaryTokens),
      fmtN(b.avgPostTriggerPerTurn),
      b.summaryPctOfTurn,
    ]);
    lines.push(table(bloatHeaders, bloatRows, { title: 'Summary Token Overhead per Turn' }));
    lines.push('```');
  } else {
    lines.push('No summary bloat data available.');
  }
  lines.push('');

  // ── Realistic Langua User Scenario ────────────────────────────────────────
  lines.push('---');
  lines.push('');
  lines.push('## 8. Realistic Langua User Scenario');
  lines.push('');
  lines.push('**Scenario:** 35 turns, 70% short / 20% medium / 10% long messages');
  lines.push('Averaged across 5 independent conversation simulations for stability.');
  lines.push('');

  if (realisticScenario.length > 0) {
    // Bar chart
    const realChartData = realisticScenario.slice(0, 18).map(s => ({
      label: s.strategyName.replace('summarization-', 'sum-').replace('truncation-', 'win-').substring(0, 35),
      value: s.avgTotalTokens,
    }));

    lines.push('```');
    lines.push(barChart(realChartData, {
      width: 45,
      unit: ' tokens',
      title: 'Avg Total Tokens: Realistic Langua User (35 turns, mixed style)',
    }));
    lines.push('```');
    lines.push('');

    // Table
    const realHeaders = ['Strategy', 'Avg Total Tokens', 'Avg Tokens/Turn', 'vs No-Mgmt'];
    const noMgmtTotal = realisticScenario.find(s => s.strategyName === 'no-management')?.avgTotalTokens || 1;
    const realRows = realisticScenario.map(s => [
      s.strategyName.substring(0, 40),
      fmtN(s.avgTotalTokens),
      fmtN(s.avgTokensPerTurn),
      savings(noMgmtTotal, s.avgTotalTokens),
    ]);

    lines.push('```');
    lines.push(table(realHeaders, realRows, { title: 'Realistic Scenario: All Strategies Ranked by Token Cost' }));
    lines.push('```');
    lines.push('');
  }

  // ── Cost Projection ───────────────────────────────────────────────────────
  lines.push('---');
  lines.push('');
  lines.push('## 9. Cost Projections (At Scale)');
  lines.push('');
  lines.push('Assuming 1,000 users each completing a 35-turn conversation per day,');
  lines.push('at GPT-4o pricing of $2.50/1M input tokens:');
  lines.push('');

  lines.push('```');
  lines.push('Daily cost projection: 1,000 users × 35 turns, medium-ish conversation');
  lines.push('');

  const pricePer1M = 2.50;
  const usersPerDay = 1000;
  const keyStrategies = [
    { name: 'truncation-old', label: 'Old (1 msg)' },
    { name: 'truncation-window-8', label: 'Window-8' },
    { name: 'truncation-window-20', label: 'Window-20' },
    { name: 'summarization-hybrid-w12-compact', label: 'Hybrid w12 (compact summary)' },
    { name: 'summarization-hybrid-w12-verbose', label: 'Hybrid w12 (verbose summary)' },
    { name: 'summarization-current-trigger20-compact', label: 'Current (compact summary, trigger 20)' },
    { name: 'summarization-current-trigger20-verbose', label: 'Current (verbose summary, trigger 20)' },
    { name: 'current-no-summary-bug', label: 'Current BUG (no summary ever)' },
    { name: 'no-management', label: 'No Management (unbounded)' },
  ];

  for (const ks of keyStrategies) {
    const found = realisticScenario.find(s => s.strategyName === ks.name);
    if (!found) continue;
    const totalTokens = found.avgTotalTokens * usersPerDay;
    const dailyCost = (totalTokens / 1_000_000) * pricePer1M;
    const monthlyCost = dailyCost * 30;
    lines.push(`  ${ks.label.padEnd(42)} $${dailyCost.toFixed(2).padStart(7)}/day   $${monthlyCost.toFixed(0).padStart(6)}/mo`);
  }

  lines.push('```');
  lines.push('');
  lines.push('*Note: This is input-token cost only. Output tokens are additional (typically 20-40% of input).*');
  lines.push('*Pricing as of mid-2025 for GPT-4o. Actual costs depend on model and pricing tier.*');
  lines.push('');

  // ── Multi-Length Comparison ───────────────────────────────────────────────
  lines.push('---');
  lines.push('');
  lines.push('## 10. Multi-Conversation-Length Comparison');
  lines.push('');
  lines.push('How do strategies scale as conversations get longer?');
  lines.push('(Medium message style across 20, 50, 100 turns)');
  lines.push('');

  const keyStrategyNames = [
    'truncation-old',
    'truncation-window-8',
    'truncation-window-20',
    'truncation-window-40',
    'no-management',
    'current-no-summary-bug',
    'summarization-current-trigger20-compact',
    'summarization-current-trigger20-verbose',
    'summarization-hybrid-w12-compact',
  ];

  const multiLengthHeaders = ['Strategy', '20 Turns', '50 Turns', '100 Turns', 'Growth Factor'];
  const multiLengthRows = [];

  for (const sName of keyStrategyNames) {
    const t20 = raw.runs.find(r => r.numTurns === 20  && r.messageStyle === 'medium')
      ?.strategies.find(s => s.strategyName === sName);
    const t50 = raw.runs.find(r => r.numTurns === 50  && r.messageStyle === 'medium')
      ?.strategies.find(s => s.strategyName === sName);
    const t100 = raw.runs.find(r => r.numTurns === 100 && r.messageStyle === 'medium')
      ?.strategies.find(s => s.strategyName === sName);

    if (!t20 && !t50 && !t100) continue;

    const v20  = t20  ? t20.totalTokens  : 0;
    const v50  = t50  ? t50.totalTokens  : 0;
    const v100 = t100 ? t100.totalTokens : 0;
    const growth = v20 > 0 ? (v100 / v20).toFixed(1) + 'x' : 'N/A';

    multiLengthRows.push([
      sName.replace('summarization-', 'sum-').replace('truncation-', 'win-').substring(0, 38),
      fmtN(v20),
      fmtN(v50),
      fmtN(v100),
      growth,
    ]);
  }

  lines.push('```');
  lines.push(table(multiLengthHeaders, multiLengthRows, { title: 'Token Cost Scaling by Conversation Length (Medium Messages)' }));
  lines.push('```');
  lines.push('');

  // ── Recommendations ───────────────────────────────────────────────────────
  lines.push('---');
  lines.push('');
  lines.push('## 11. Recommendations');
  lines.push('');
  lines.push('### Immediate Fixes (High Priority)');
  lines.push('');
  lines.push('**1. Fix the no-summary unbounded growth bug**');
  lines.push('   When no summary exists, fall back to a sliding window (e.g., last 20 messages),');
  lines.push('   NOT all messages from history. This is the highest-impact change.');
  lines.push('');
  lines.push('   ```javascript');
  lines.push('   // Current (buggy): includes ALL messages when no summary');
  lines.push('   const contextMessages = [systemPrompt, ...allHistoricalMessages, newMessage];');
  lines.push('');
  lines.push('   // Fixed: cap at recent window even without summary');
  lines.push('   const FALLBACK_WINDOW = 20;');
  lines.push('   const recentHistory = allHistoricalMessages.slice(-FALLBACK_WINDOW);');
  lines.push('   const contextMessages = [systemPrompt, ...recentHistory, newMessage];');
  lines.push('   ```');
  lines.push('');
  lines.push('**2. Cap summary token size**');
  lines.push('   Add a `MAX_SUMMARY_TOKENS = 500` cap when storing summaries. Force the summarization');
  lines.push('   prompt to produce ≤500 tokens. This prevents verbose summaries from consuming');
  lines.push('   10-30% of the per-turn token budget permanently.');
  lines.push('');
  lines.push('   ```javascript');
  lines.push('   // Add to summarization prompt:');
  lines.push('   "Produce a concise summary in 400 words or fewer (approximately 500 tokens)."');
  lines.push('   ```');
  lines.push('');
  lines.push('**3. Reduce KEEP_RECENT_MESSAGES from 40 to 20**');
  lines.push('   For most Langua conversations (language tutoring with short messages),');
  lines.push('   20 recent messages provides adequate context while halving the recent-history cost.');
  lines.push('');

  lines.push('### Optimization Opportunities (Medium Priority)');
  lines.push('');
  lines.push('**4. Earlier summarization trigger**');
  lines.push('   Triggering summarization at turn 10 instead of 20 reduces the pre-summary');
  lines.push('   unbounded window to just 10 turns, significantly limiting worst-case exposure.');
  lines.push('');
  lines.push('**5. Consider the Hybrid strategy for power users**');
  lines.push('   Hybrid (capped summary ≤500t + last 12 messages) is often the most cost-efficient');
  lines.push('   approach with strong context quality. It outperforms both window-only and');
  lines.push('   current summarization for conversations longer than ~25 turns.');
  lines.push('');
  lines.push('**6. Differentiate by conversation type**');
  lines.push('   - Short daily check-ins (< 15 turns): use window-8 or window-12 only');
  lines.push('   - Sustained lessons (15-40 turns): use hybrid with trigger at turn 10');
  lines.push('   - Long grammar deep-dives (> 40 turns): use current strategy with compact summary');
  lines.push('');

  lines.push('### What NOT to Do');
  lines.push('');
  lines.push('**7. Do NOT revert to old strategy (1 message)**');
  lines.push('   While token-cheap, the old strategy destroys conversation continuity.');
  lines.push('   A language tutor that forgets everything said 2 messages ago provides a poor UX.');
  lines.push('');
  lines.push('**8. Do NOT raise MAX_TOKENS above 30k without fixing the no-summary bug**');
  lines.push('   Raising the cap without fixing the unbounded growth just delays the explosion');
  lines.push('   and increases cost for all intermediate turns.');
  lines.push('');

  // ── Strategy Summary Card ──────────────────────────────────────────────────
  lines.push('---');
  lines.push('');
  lines.push('## 12. Strategy Summary Card');
  lines.push('');
  lines.push('```');
  lines.push('┌──────────────────────────────────────────────────────────────────────────┐');
  lines.push('│                   LANGUA CONTEXT STRATEGY TRADE-OFFS                    │');
  lines.push('├───────────────────┬──────────┬──────────┬──────────┬────────────────────┤');
  lines.push('│ Strategy          │ Cost/Turn│ Context  │ Memory   │ Recommended Use    │');
  lines.push('│                   │          │ Quality  │ Quality  │                    │');
  lines.push('├───────────────────┼──────────┼──────────┼──────────┼────────────────────┤');
  lines.push('│ Old (1 msg)       │ ★★★★★   │ ★        │ ★        │ Deprecated         │');
  lines.push('│ Window-8          │ ★★★★    │ ★★★     │ ★★      │ Short sessions     │');
  lines.push('│ Window-20         │ ★★★     │ ★★★★   │ ★★★     │ Medium sessions    │');
  lines.push('│ Hybrid w12+500t   │ ★★★★   │ ★★★★   │ ★★★★   │ RECOMMENDED        │');
  lines.push('│ Current (compact) │ ★★★     │ ★★★★   │ ★★★★   │ OK as-is w/ fix    │');
  lines.push('│ Current (verbose) │ ★★      │ ★★★★   │ ★★★★★  │ Too expensive      │');
  lines.push('│ Current BUG       │ ★       │ ★★★★★  │ ★★★★★  │ BROKEN — fix now   │');
  lines.push('│ No Management     │ ★       │ ★★★★★  │ ★★★★★  │ Never use          │');
  lines.push('└───────────────────┴──────────┴──────────┴──────────┴────────────────────┘');
  lines.push('```');
  lines.push('');
  lines.push('*Cost/Turn is inverted (★★★★★ = cheapest, ★ = most expensive)*');
  lines.push('');

  // ── Appendix ───────────────────────────────────────────────────────────────
  lines.push('---');
  lines.push('');
  lines.push('## Appendix: Simulation Methodology');
  lines.push('');
  lines.push('- **Token counting**: tiktoken cl100k_base (same encoder as GPT-4/GPT-4o)');
  lines.push('- **Per-message overhead**: 4 tokens per message (OpenAI chat format spec)');
  lines.push('- **System prompt**: ~380-420 tokens (Langua persona template)');
  lines.push('- **Message styles**: short (15-30 words), medium (40-80 words), long (100-200 words)');
  lines.push('- **Summary compact**: ~15% of conversation tokens (well-prompted summarization)');
  lines.push('- **Summary verbose**: ~45% of conversation tokens (unprompted/naive summarization)');
  lines.push('- **Summarization call cost**: counted as (input tokens at trigger) + (output = summary size)');
  lines.push('- **Realistic scenario**: 5 independent runs averaged for stability');
  lines.push('- **Strategies run**: 5 strategies × multiple configurations = ~25 variants per scenario');
  lines.push('- **Total scenarios**: 9 standard (3 lengths × 3 styles) + 5 realistic runs');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('*Report generated by `langua-token-research` simulation suite.*');
  lines.push('*Source: `/tmp/langua-token-research/src/`*');

  return lines.join('\n');
}

// ─── Run ─────────────────────────────────────────────────────────────────────

analyze();
