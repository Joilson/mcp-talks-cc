import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Session } from 'neo4j-driver';
import { config } from '../config.ts';
import { decisionsOfFamily, familyOf } from './family.ts';

/**
 * Primer por epic, pré-calculado.
 *
 * No SessionStart a sessão nova ainda não está no grafo e o MCP dela não subiu,
 * então o session-primer.sh (bash puro) não tem como perguntar nada. Aqui o
 * link:epics grava, por task com epic de feature, um arquivo de 1 linha com as
 * regras das IRMÃS e do epic. O primer lê a branch do cwd, tira a key e anexa
 * o arquivo daquela task: quem abre sessão na task do front já começa sabendo
 * a regra que o back definiu.
 *
 * Texto pré-sanitizado: entra num sed sobre JSON (sem " \ | & nem quebra).
 */

export const EPIC_PRIMER_DIR = join(config.paths.cacheDir, 'epic-primer');
const MAX_RULES = 3;

function clean(t: string, max: number): string {
  const s = t.replace(/[\\"|&\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export async function writeEpicPrimers(s: Session): Promise<number> {
  const r = await s.run(
    `MATCH (t:Task)-[r:PART_OF]->(p:Task)
     WHERE coalesce(r.confidence, 'low') <> 'low' AND coalesce(p.bucket, false) = false
     RETURN t.key AS key`,
  );
  mkdirSync(EPIC_PRIMER_DIR, { recursive: true });
  // regera do zero: vínculo removido ou epic que virou balde não pode sobrar
  for (const f of readdirSync(EPIC_PRIMER_DIR)) rmSync(join(EPIC_PRIMER_DIR, f), { force: true });

  let n = 0;
  for (const rec of r.records) {
    const key = rec.get('key') as string;
    const fam = await familyOf(s, key);
    if (!fam.epic) continue;
    const rules = (await decisionsOfFamily(s, key, 20))
      .filter((d) => d.relation !== 'task')
      .slice(0, MAX_RULES);
    if (rules.length === 0) continue;
    const title = fam.epic.title ? ` (${clean(fam.epic.title, 70)})` : '';
    const lines = rules.map((d) => {
      const repo = d.project?.split('/').filter(Boolean).pop() ?? '-';
      return `- [${d.kind}] ${clean(d.text, 220)} (${repo}, ${d.via})`;
    });
    const text = `regras do epic ${fam.epic.key}${title} vindas das tasks irmãs, valem aqui também: ${lines.join(' ')} find_decisions({ taskId: '${key}' }) traz o resto.`;
    writeFileSync(join(EPIC_PRIMER_DIR, `${key}.txt`), clean(text, 1200).replace(/\\n/g, ' '));
    n++;
  }
  return n;
}
