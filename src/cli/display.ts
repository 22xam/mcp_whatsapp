// ─── ANSI color helpers ───────────────────────────────────────────────────────

export const c = {
  reset:     '\x1b[0m',
  bold:      '\x1b[1m',
  dim:       '\x1b[2m',
  italic:    '\x1b[3m',
  underline: '\x1b[4m',
  green:     '\x1b[32m',
  cyan:      '\x1b[36m',
  yellow:    '\x1b[33m',
  red:       '\x1b[31m',
  blue:      '\x1b[34m',
  magenta:   '\x1b[35m',
  white:     '\x1b[37m',
  gray:      '\x1b[90m',
  bgBlue:    '\x1b[44m',
  bgCyan:    '\x1b[46m',
};

// ─── Message helpers ──────────────────────────────────────────────────────────

export function ok(msg: string): string {
  return `${c.green}✓${c.reset} ${msg}`;
}

export function fail(msg: string): string {
  return `${c.red}✗${c.reset} ${msg}`;
}

export function info(msg: string): string {
  return `${c.cyan}ℹ${c.reset} ${msg}`;
}

export function warn(msg: string): string {
  return `${c.yellow}⚠${c.reset} ${msg}`;
}

export function botMsg(msg: string): string {
  return `${c.green}${c.bold}bot${c.reset}${c.green}>${c.reset} ${msg}`;
}

// ─── Section header ───────────────────────────────────────────────────────────

export function header(text: string): string {
  return `\n${c.bold}${c.cyan}${text}${c.reset}\n${c.dim}${'─'.repeat(Math.min(text.length + 2, 60))}${c.reset}`;
}

// ─── ASCII table ──────────────────────────────────────────────────────────────

export function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return `  ${c.dim}(vacío)${c.reset}`;

  // Strip ANSI for width calculations
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

  const widths = headers.map((h, i) =>
    Math.max(stripAnsi(h).length, ...rows.map((r) => stripAnsi(r[i] ?? '').length)),
  );

  const pad = (str: string, width: number) => {
    const visible = stripAnsi(str).length;
    return str + ' '.repeat(Math.max(0, width - visible));
  };

  const divider = '  ├' + widths.map((w) => '─'.repeat(w + 2)).join('┼') + '┤';
  const top     = '  ┌' + widths.map((w) => '─'.repeat(w + 2)).join('┬') + '┐';
  const bottom  = '  └' + widths.map((w) => '─'.repeat(w + 2)).join('┴') + '┘';

  const headerRow =
    '  │' +
    headers.map((h, i) => ` ${c.bold}${pad(h, widths[i])}${c.reset} `).join('│') +
    '│';

  const dataRows = rows.map(
    (row) =>
      '  │' +
      row.map((cell, i) => ` ${pad(cell ?? '', widths[i])} `).join('│') +
      '│',
  );

  return [top, headerRow, divider, ...dataRows, bottom].join('\n');
}

// ─── Banner ───────────────────────────────────────────────────────────────────

export function banner(): void {
  const G  = '\x1b[92m';  // bright green  — body
  const Y  = '\x1b[93m';  // bright yellow — antennae, title
  const B  = '\x1b[96m';  // bright cyan   — glasses
  const W  = '\x1b[97m';  // white         — pupils, mic
  const D  = '\x1b[90m';  // gray          — headphones
  const bd = '\x1b[1m';
  const R  = '\x1b[0m';

  //   positions (0-indexed, accounting for 2-space indent):
  //   first antenna  ◆ at col 11
  //   second antenna ◆ at col 23
  //   box outer width = 32  (indent 2 + border 1 + inner 28 + border 1)
  const art = [
    `           ${Y}◆${R}           ${Y}◆${R}`,
    `           ${G}│${R}           ${G}│${R}`,
    `  ${D}┌────────┴───────────┴───────┐${R}`,
    `  ${D}│${R}   ${B}╔══════╗${R}   ${B}╔══════╗${R}   ${D}│${R}`,
    `  ${D}│${R}   ${B}║${R}  ${W}◉${R}   ${B}║${R}   ${B}║${R}   ${W}◉${R}  ${B}║${R}   ${D}│${R}  ${W}◉${D}─${R}`,
    `  ${D}│${R}   ${B}╚══════╝${R}   ${B}╚══════╝${R}   ${D}│${R}`,
    `  ${D}│${R}       ${G}╰─────────────╯${R}       ${D}│${R}`,
    `  ${D}└──────────────────────────────┘${R}`,
  ];

  const title = [
    `  ${bd}${Y}╔══════════════════════════════════╗${R}`,
    `  ${bd}${Y}║${R}  ${bd}${W}BUG-MATE${R} ${G}CLI${R}  ${D}·${R}  ${D}Panel de Control${R}  ${bd}${Y}║${R}`,
    `  ${bd}${Y}╚══════════════════════════════════╝${R}`,
  ];

  process.stdout.write('\n' + art.join('\n') + '\n\n' + title.join('\n') + '\n\n');
}

// ─── Spinner ──────────────────────────────────────────────────────────────────

export function spinner(msg: string): () => void {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  process.stdout.write(`  ${frames[0]} ${msg}`);
  const id = setInterval(() => {
    process.stdout.write(`\r  ${c.cyan}${frames[i++ % frames.length]}${c.reset} ${msg}`);
  }, 80);
  return () => {
    clearInterval(id);
    process.stdout.write('\r' + ' '.repeat(msg.length + 6) + '\r');
  };
}

// ─── Misc ─────────────────────────────────────────────────────────────────────

export function formatMs(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
