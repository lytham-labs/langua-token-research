/**
 * charts.js
 * ASCII bar chart generation for token usage visualization.
 * Used by analyze.js to embed charts in the markdown report.
 */

/**
 * Render a horizontal ASCII bar chart.
 *
 * @param {Array<{label: string, value: number}>} data
 * @param {{ width?: number, unit?: string, title?: string }} options
 * @returns {string}
 */
function barChart(data, options = {}) {
  const width = options.width || 50;
  const unit  = options.unit  || '';
  const title = options.title || '';

  if (!data || data.length === 0) return '';

  const maxValue = Math.max(...data.map(d => d.value));
  const maxLabel = Math.max(...data.map(d => d.label.length));

  const lines = [];

  if (title) {
    lines.push(title);
    lines.push('─'.repeat(title.length));
  }

  for (const { label, value } of data) {
    const barLen = maxValue > 0 ? Math.round((value / maxValue) * width) : 0;
    const bar = '█'.repeat(barLen);
    const paddedLabel = label.padEnd(maxLabel);
    const formattedValue = formatNumber(value, unit);
    lines.push(`${paddedLabel} │ ${bar} ${formattedValue}`);
  }

  return lines.join('\n');
}

/**
 * Render a line-style ASCII chart showing token growth over turns.
 *
 * @param {Array<{label: string, values: number[]}>} series
 * @param {{ height?: number, width?: number, title?: string, xLabel?: string }} options
 * @returns {string}
 */
function lineChart(series, options = {}) {
  const height = options.height || 15;
  const width  = options.width  || 60;
  const title  = options.title  || '';

  if (!series || series.length === 0) return '';

  // Find global max across all series
  const allValues = series.flatMap(s => s.values);
  const maxVal = Math.max(...allValues);
  const minVal = 0;

  // Sample each series to fit width
  const sampledSeries = series.map(s => {
    const step = Math.max(1, Math.floor(s.values.length / width));
    const sampled = [];
    for (let i = 0; i < s.values.length; i += step) {
      sampled.push(s.values[i]);
    }
    return { ...s, sampled };
  });

  const chartWidth = Math.min(width, Math.max(...sampledSeries.map(s => s.sampled.length)));

  // Build grid
  const grid = Array.from({ length: height }, () => Array(chartWidth).fill(' '));

  // Plot each series with different characters
  const chars = ['█', '▓', '░', '▒', '▪', '•', '+', '*'];

  for (let si = 0; si < sampledSeries.length; si++) {
    const { sampled } = sampledSeries[si];
    const char = chars[si % chars.length];

    for (let x = 0; x < Math.min(sampled.length, chartWidth); x++) {
      const normalizedY = maxVal > 0 ? (sampled[x] - minVal) / (maxVal - minVal) : 0;
      const y = height - 1 - Math.round(normalizedY * (height - 1));
      const clampedY = Math.max(0, Math.min(height - 1, y));
      grid[clampedY][x] = char;
    }
  }

  const lines = [];
  if (title) {
    lines.push(title);
    lines.push('─'.repeat(Math.max(title.length, chartWidth + 8)));
  }

  const yLabels = [
    formatCompact(maxVal),
    formatCompact(maxVal * 0.75),
    formatCompact(maxVal * 0.5),
    formatCompact(maxVal * 0.25),
    '0',
  ];

  for (let y = 0; y < height; y++) {
    // Y-axis label
    let yLabel = '';
    const labelPositions = [0, Math.floor(height * 0.25), Math.floor(height * 0.5), Math.floor(height * 0.75), height - 1];
    const labelIdx = labelPositions.indexOf(y);
    if (labelIdx >= 0) {
      yLabel = yLabels[labelIdx].padStart(6);
    } else {
      yLabel = ' '.repeat(6);
    }

    lines.push(`${yLabel} │${grid[y].join('')}`);
  }

  // X-axis
  lines.push(`       └${'─'.repeat(chartWidth)}`);

  // Legend
  lines.push('');
  for (let si = 0; si < sampledSeries.length; si++) {
    const char = chars[si % chars.length];
    lines.push(`  ${char} = ${sampledSeries[si].label}`);
  }

  return lines.join('\n');
}

/**
 * Render a comparison table.
 *
 * @param {string[]} headers
 * @param {Array<string[]>} rows
 * @param {{ title?: string }} options
 * @returns {string}
 */
function table(headers, rows, options = {}) {
  const title = options.title || '';
  const allRows = [headers, ...rows];

  // Compute column widths
  const colWidths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map(r => String(r[i] || '').length))
  );

  const separator = colWidths.map(w => '─'.repeat(w + 2)).join('┼');
  const headerSep = colWidths.map(w => '═'.repeat(w + 2)).join('╪');

  function formatRow(row) {
    return '│' + row.map((cell, i) => ` ${String(cell || '').padEnd(colWidths[i])} `).join('│') + '│';
  }

  function topBorder() {
    return '┌' + colWidths.map(w => '─'.repeat(w + 2)).join('┬') + '┐';
  }

  function bottomBorder() {
    return '└' + colWidths.map(w => '─'.repeat(w + 2)).join('┴') + '┘';
  }

  function midBorder() {
    return '├' + separator + '┤';
  }

  const lines = [];

  if (title) {
    lines.push(title);
    lines.push('═'.repeat(title.length));
    lines.push('');
  }

  lines.push(topBorder());
  lines.push(formatRow(headers));
  lines.push('╞' + headerSep + '╡');

  for (let i = 0; i < rows.length; i++) {
    lines.push(formatRow(rows[i]));
    if (i < rows.length - 1) {
      lines.push(midBorder());
    }
  }

  lines.push(bottomBorder());

  return lines.join('\n');
}

// ─── Utilities ──────────────────────────────────────────────────────────────

function formatNumber(n, unit = '') {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M${unit}`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k${unit}`;
  return `${n}${unit}`;
}

function formatCompact(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(0)}k`;
  return `${Math.round(n)}`;
}

module.exports = { barChart, lineChart, table, formatNumber, formatCompact };
