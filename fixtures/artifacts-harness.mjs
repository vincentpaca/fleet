// Fake harness for the artifact e2e test: writes two artifact files under
// .fleet/out/artifacts/, writes a minimal report, and exits clean.
// No decisions — artifact delivery is the only thing under test here.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const out = join(process.cwd(), '.fleet', 'out');
mkdirSync(out, { recursive: true });

const artifactsDir = join(out, 'artifacts');
mkdirSync(artifactsDir, { recursive: true });

// Two artifacts with known content for byte-identity verification.
writeFileSync(join(artifactsDir, 'report.md'), '# Assessment\n\nNo critical issues found.\n');
writeFileSync(join(artifactsDir, 'data.txt'), 'col1,col2\n1,2\n3,4\n');

const line = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Analysis complete.' }] } });

writeFileSync(join(out, 'report.json'), JSON.stringify({
  status: 'READY',
  next_action: 'review the attached artifacts',
  verification: ['two artifact files written'],
}));
line({ type: 'result', subtype: 'success' });
