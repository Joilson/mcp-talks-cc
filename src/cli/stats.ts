import { withSession } from '../neo4j/driver.ts';
import { closeDriver } from '../neo4j/driver.ts';

const QUERY = `
CALL () {
  MATCH (n) UNWIND labels(n) AS label
  WITH label, count(*) AS c
  RETURN label, c ORDER BY label
}
RETURN collect({label: label, count: c}) AS counts
`;

try {
  await withSession(async (s) => {
    const r = await s.run(QUERY);
    const counts = r.records[0]?.get('counts') ?? [];
    console.log('Node counts:');
    for (const { label, count } of counts) {
      console.log(`  ${label.padEnd(20)} ${count}`);
    }
  });
} finally {
  await closeDriver();
}
