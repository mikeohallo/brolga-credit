// Shared pieces for the investigator scripts: finding the key, loading the
// TypeScript sources without a build, and rendering a briefing as Markdown.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installSourceLoader } from '../tests/review/runtime.mjs';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function sourceLoader() {
  installSourceLoader(root);
  return (name) => import(pathToFileURL(path.join(root, name)).href);
}

/**
 * The key comes from the environment or from .env.local (which git ignores).
 * BROLGA_ENV_FILE may point at an .env.local elsewhere, so a fresh checkout can
 * read the key from where Mike put it without the file being copied. The value
 * is returned to the caller and nowhere else: never printed, never written.
 */
export function readKey(variable) {
  if (process.env[variable]?.trim()) return process.env[variable].trim();
  const file = process.env.BROLGA_ENV_FILE?.trim() || path.join(root, '.env.local');
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && m[1] === variable) return m[2].replace(/^["']|["']$/g, '');
    }
  }
  return null;
}

/** Where reports go: BROLGA_REPORTS_DIR when set (a folder outside the repo, say), else reports/ in the repo (git-ignored). */
export function reportsDir() {
  const dir = process.env.BROLGA_REPORTS_DIR?.trim() || path.join(root, 'reports');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

export function usd(n) {
  return n === null || n === undefined ? 'n/a' : `$${n.toFixed(4)}`;
}

export function secs(ms) {
  return `${(ms / 1000).toFixed(1)} s`;
}

export function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

const ids = (list) => (list.length ? `[${list.join(', ')}]` : '[]');

export function briefingMarkdown(run, expected) {
  const out = [];
  const b = run.briefing;
  out.push(`**${run.check.accepted ? 'ACCEPTED' : 'REJECTED'}** by the citation check` + (run.check.accepted ? '' : `: ${run.check.reasons.join('; ')}`));
  if (run.error) out.push(`Model call failed: ${run.error}`);
  if (b) {
    out.push('');
    out.push(`**Diagnosis:** \`${b.diagnosis}\` · **Next step:** \`${b.next_step.action}\` · **Confidence:** ${b.confidence.level} (${b.confidence.reason})`);
    if (expected) out.push(`**Expected:** \`${expected.diagnosis}\` / \`${expected.nextStep}\`, must cite ${ids(expected.mustCite)}`);
    out.push('');
    out.push('**Timeline**');
    for (const c of b.timeline) out.push(`- ${c.text} ${ids(c.ids)}`);
    out.push('');
    out.push('**Known for certain**');
    for (const c of b.known_for_certain) out.push(`- ${c.text} ${ids(c.ids)}`);
    out.push('');
    out.push('**Explanations, ranked**');
    for (const e of b.explanations) out.push(`${e.rank}. \`${e.diagnosis}\`: ${e.summary} For: ${ids(e.supporting_ids)}. Against: ${ids(e.against_ids)}.`);
    out.push('');
    out.push(`**Next step:** ${b.next_step.detail} ${ids(b.next_step.ids)}` + (b.next_step.would_settle_it ? `\n**Would settle it:** ${b.next_step.would_settle_it}` : ''));
  } else if (run.raw) {
    out.push('');
    out.push('The model\'s text could not be read as a briefing:');
    out.push('```');
    out.push(run.raw.slice(0, 2000));
    out.push('```');
  }
  out.push('');
  out.push(`Tokens: ${run.inputTokens} in, ${run.outputTokens} out · cost ${usd(run.costUsd)} · ${secs(run.ms)} · case file hash ${run.caseHash} · ${run.evidenceCount} evidence record${run.evidenceCount === 1 ? '' : 's'}`);
  return out.join('\n');
}
