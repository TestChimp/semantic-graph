import fs from 'fs';
import path from 'path';

export function globTests(root: string): string[] {
  const out: string[] = [];
  function walk(dir: string) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.(spec|test)\.(ts|js|mjs|cjs)$/.test(ent.name)) out.push(p);
    }
  }
  walk(root);
  return out;
}

export function truncateForTerminal(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  if (maxLen <= 3) return text.slice(0, maxLen);
  return `${text.slice(0, maxLen - 3)}...`;
}

export function createFileProgressReporter(totalFiles: number) {
  const isTty = Boolean(process.stdout.isTTY);
  const width = Math.max(40, (process.stdout.columns ?? 80) - 1);

  return {
    isTty,
    report(processedFiles: number, relPath: string, extra?: string) {
      if (totalFiles === 0) return;
      const label = truncateForTerminal(relPath, Math.min(40, width - 28));
      const suffix = extra ? ` — ${extra}` : '';
      const line = `Processing ${processedFiles}/${totalFiles} files — ${label}${suffix}`;
      if (isTty) {
        process.stdout.write(`\r${line.padEnd(width)}`);
        return;
      }
      if (processedFiles === 1 || processedFiles === totalFiles || processedFiles % 25 === 0) {
        console.log(line);
      }
    },
    finish() {
      if (isTty && totalFiles > 0) process.stdout.write('\n');
    },
    warnUnparseable(relPath: string, reason: string) {
      if (isTty) {
        process.stderr.write(`\nWarn: skip unparseable ${relPath}: ${reason}\n`);
      } else {
        console.warn(`Skip unparseable ${relPath}: ${reason}`);
      }
    },
  };
}
