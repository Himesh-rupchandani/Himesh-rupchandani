#!/usr/bin/env node
/**
 * Generates a self-hosted contribution activity graph (last 31 days) as a
 * standalone SVG, so the profile README never depends on a third-party
 * widget host again.
 *
 * Usage:
 *   GITHUB_TOKEN=<token> node scripts/activity-graph.mjs [output-path]
 *
 * Reads contribution data from the GitHub GraphQL API and writes an SVG with
 * no scripts, no <foreignObject> and no external references, so GitHub's camo
 * image proxy renders it without stripping anything.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const USERNAME = process.env.GITHUB_USER || 'Himesh-rupchandani';
const TOKEN = process.env.GITHUB_TOKEN;
const OUT_PATH = process.argv[2] || 'assets/activity-graph.svg';
const WINDOW_DAYS = 31;

/* ------------------------------------------------------------------ theme */
const THEME = {
  bg: '#0D1117',
  title: '#C9D1D9',
  text: '#8B949E',
  grid: '#30363D',
  line: '#8B5CF6',
  point: '#C4B5FD',
  areaTop: '#7C3AED',
};

const FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Ubuntu, 'Helvetica Neue', Arial, sans-serif";

/* --------------------------------------------------------------- fetching */
async function fetchContributions() {
  if (!TOKEN) {
    throw new Error('GITHUB_TOKEN is required to query the GitHub GraphQL API.');
  }

  const query = `
    query($login: String!) {
      user(login: $login) {
        contributionsCollection {
          contributionCalendar {
            totalContributions
            weeks {
              contributionDays {
                date
                contributionCount
                weekday
              }
            }
          }
        }
      }
    }`;

  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': `${USERNAME}-activity-graph`,
    },
    body: JSON.stringify({ query, variables: { login: USERNAME } }),
  });

  if (!res.ok) {
    throw new Error(`GitHub GraphQL request failed: ${res.status} ${await res.text()}`);
  }

  const payload = await res.json();
  if (payload.errors?.length) {
    throw new Error(`GitHub GraphQL error: ${JSON.stringify(payload.errors)}`);
  }

  const user = payload.data?.user;
  if (!user) throw new Error(`User "${USERNAME}" was not found.`);

  const calendar = user.contributionsCollection.contributionCalendar;
  const days = calendar.weeks
    .flatMap((week) => week.contributionDays)
    .sort((a, b) => a.date.localeCompare(b.date));

  if (!days.length) throw new Error('The contribution calendar came back empty.');

  return {
    yearTotal: calendar.totalContributions,
    days: days.slice(-WINDOW_DAYS),
  };
}

/* ------------------------------------------------------------- svg helpers */
const round = (n) => Math.round(n * 100) / 100;

/** Fritsch–Carlson monotone cubic interpolation: smooth, never overshoots. */
function monotonePath(pts) {
  const n = pts.length;
  if (n < 2) return '';

  const dx = [];
  const slope = [];
  for (let i = 0; i < n - 1; i += 1) {
    dx[i] = pts[i + 1].x - pts[i].x;
    slope[i] = dx[i] === 0 ? 0 : (pts[i + 1].y - pts[i].y) / dx[i];
  }

  const tangent = new Array(n);
  tangent[0] = slope[0];
  tangent[n - 1] = slope[n - 2];
  for (let i = 1; i < n - 1; i += 1) {
    if (slope[i - 1] * slope[i] <= 0) {
      tangent[i] = 0;
    } else {
      const t = (slope[i - 1] + slope[i]) / 2;
      const a = t / slope[i - 1];
      const b = t / slope[i];
      const s = a * a + b * b;
      tangent[i] = s > 9 ? ((3 * t) / Math.sqrt(s)) : t;
    }
  }

  let d = `M ${round(pts[0].x)} ${round(pts[0].y)}`;
  for (let i = 0; i < n - 1; i += 1) {
    const c1x = pts[i].x + dx[i] / 3;
    const c1y = pts[i].y + (tangent[i] * dx[i]) / 3;
    const c2x = pts[i + 1].x - dx[i] / 3;
    const c2y = pts[i + 1].y - (tangent[i + 1] * dx[i]) / 3;
    d += ` C ${round(c1x)} ${round(c1y)}, ${round(c2x)} ${round(c2y)}, ${round(pts[i + 1].x)} ${round(pts[i + 1].y)}`;
  }
  return d;
}

/** Rounds a maximum value up to a friendly axis maximum (1/2/5 × 10^n steps). */
function niceScale(maxValue, tickCount = 4) {
  const safeMax = Math.max(1, maxValue);
  const rough = safeMax / tickCount;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  let step;
  if (normalized <= 1) step = 1;
  else if (normalized <= 2) step = 2;
  else if (normalized <= 5) step = 5;
  else step = 10;
  step *= magnitude;
  return { step, max: step * tickCount };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function shortDate(iso) {
  const [, m, d] = iso.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}

const escapeXml = (s) =>
  String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);

/* ------------------------------------------------------------ svg renderer */
function renderSvg({ days, yearTotal }) {
  const W = 1000;
  const H = 300;
  const padL = 62;
  const padR = 30;
  const padT = 86;
  const padB = 52;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const baseY = padT + plotH;

  const counts = days.map((d) => d.contributionCount);
  const windowTotal = counts.reduce((a, b) => a + b, 0);
  const activeDays = counts.filter((c) => c > 0).length;
  const { step, max: maxY } = niceScale(Math.max(...counts));

  const xAt = (i) => padL + (plotW * i) / Math.max(1, days.length - 1);
  const yAt = (v) => baseY - (v / maxY) * plotH;

  const points = days.map((d, i) => ({ x: xAt(i), y: yAt(d.contributionCount) }));

  /* gridlines + y labels */
  const tickCount = Math.round(maxY / step);
  const grid = [];
  for (let i = 0; i <= tickCount; i += 1) {
    const value = i * step;
    const y = round(yAt(value));
    grid.push(
      `    <line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="${THEME.grid}" stroke-width="1" stroke-dasharray="3 6" />`,
    );
    grid.push(
      `    <text x="${padL - 12}" y="${y + 4}" fill="${THEME.text}" font-size="11" text-anchor="end">${value}</text>`,
    );
  }

  /* x labels every 5 days, always including the last day */
  const labelIdx = [];
  for (let i = 0; i < days.length; i += 5) labelIdx.push(i);
  if (labelIdx[labelIdx.length - 1] !== days.length - 1) {
    labelIdx.pop();
    labelIdx.push(days.length - 1);
  }
  const xLabels = labelIdx.map(
    (i) =>
      `    <text x="${round(xAt(i))}" y="${baseY + 26}" fill="${THEME.text}" font-size="11" text-anchor="middle">${shortDate(days[i].date)}</text>`,
  );

  /* dots */
  const dots = days.map((d, i) => {
    const p = points[i];
    if (d.contributionCount === 0) {
      return `    <circle cx="${round(p.x)}" cy="${round(p.y)}" r="2.2" fill="${THEME.point}" fill-opacity="0.28" />`;
    }
    return `    <circle cx="${round(p.x)}" cy="${round(p.y)}" r="3.1" fill="${THEME.point}" />`;
  });

  const linePath = monotonePath(points);
  const areaPath = `${linePath} L ${round(points[points.length - 1].x)} ${baseY} L ${round(points[0].x)} ${baseY} Z`;

  const title = `${USERNAME}'s Coding Journey`;
  const subtitle = `${windowTotal.toLocaleString('en-US')} contributions in the last ${days.length} days  ·  ${activeDays} active days  ·  ${yearTotal.toLocaleString('en-US')} in the past year`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="title desc">
  <title id="title">${escapeXml(title)}</title>
  <desc id="desc">Line chart of daily GitHub contributions for ${escapeXml(USERNAME)} over the last ${days.length} days. ${escapeXml(subtitle)}</desc>
  <defs>
    <linearGradient id="area" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${THEME.areaTop}" stop-opacity="0.55" />
      <stop offset="100%" stop-color="${THEME.areaTop}" stop-opacity="0.02" />
    </linearGradient>
  </defs>

  <rect width="${W}" height="${H}" rx="10" fill="${THEME.bg}" />

  <text x="${padL}" y="44" fill="${THEME.title}" font-family="${FONT}" font-size="18" font-weight="600">${escapeXml(title)}</text>
  <text x="${padL}" y="66" fill="${THEME.text}" font-family="${FONT}" font-size="12">${escapeXml(subtitle)}</text>

  <g font-family="${FONT}">
${grid.join('\n')}
  </g>

  <path d="${areaPath}" fill="url(#area)" />
  <path d="${linePath}" fill="none" stroke="${THEME.line}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />

  <g>
${dots.join('\n')}
  </g>

  <g font-family="${FONT}">
${xLabels.join('\n')}
  </g>
</svg>
`;
}

/* -------------------------------------------------------------------- main */
try {
  const data = await fetchContributions();
  const svg = renderSvg(data);

  await mkdir(dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, svg, 'utf8');

  const total = data.days.reduce((sum, d) => sum + d.contributionCount, 0);
  console.log(
    `Wrote ${OUT_PATH} — ${data.days.length} days, ${total} contributions in window, ${data.yearTotal} in the past year.`,
  );
} catch (error) {
  // Fail loudly but leave any previously committed SVG untouched, so a bad
  // API response never replaces a working graph with a blank one.
  console.error(`activity-graph: ${error.message}`);
  process.exit(1);
}
