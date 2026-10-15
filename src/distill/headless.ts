import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.ts';

/**
 * Uma chamada `claude -p` headless com saída estruturada (JSON schema).
 *
 * Compartilhado entre distill e link:epics. Sem tools, sem MCP, sem sessão
 * persistida e com `MCP_TALKS_IN_DISTILL=1`, então a chamada não dispara os
 * hooks do próprio mcp-talks-cc (ingest/push) recursivamente.
 *
 * Lança em erro/timeout; o caller decide se marca e segue.
 */

export const HEADLESS_MODEL = process.env.DISTILL_MODEL ?? 'claude-haiku-4-5-20251001';
const HEADLESS_CWD = join(config.paths.cacheDir, 'distill-cwd');

export async function runHeadless(opts: {
  system: string;
  schema: object;
  input: string;
  timeoutMs: number;
  model?: string;
}): Promise<unknown> {
  mkdirSync(HEADLESS_CWD, { recursive: true });
  const args = [
    '-p',
    '--model', opts.model ?? HEADLESS_MODEL,
    '--output-format', 'json',
    '--tools', '',
    '--strict-mcp-config',
    '--setting-sources', 'project',
    '--no-session-persistence',
    '--system-prompt', opts.system,
    '--json-schema', JSON.stringify(opts.schema),
  ];
  const out = await new Promise<string>((resolve, reject) => {
    const p = spawn('claude', args, {
      cwd: HEADLESS_CWD,
      env: { ...process.env, MCP_TALKS_IN_DISTILL: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let so = '';
    let se = '';
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      reject(new Error('timeout'));
    }, opts.timeoutMs);
    p.stdout.on('data', (d: Buffer) => (so += d.toString('utf8')));
    p.stderr.on('data', (d: Buffer) => (se += d.toString('utf8')));
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`claude exit ${code}: ${se.slice(0, 300)}`));
      else resolve(so);
    });
    p.stdin.end(opts.input);
  });
  const parsed = JSON.parse(out) as { is_error?: boolean; structured_output?: unknown };
  if (parsed.is_error) throw new Error('claude is_error');
  return parsed.structured_output ?? null;
}
