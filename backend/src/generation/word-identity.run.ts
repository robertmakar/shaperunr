/**
 * DEVELOPMENT ONLY.
 * npm run word-identity --prefix backend
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runWordIdentityAudit } from './word-identity';

const report = await runWordIdentityAudit();
const directory = dirname(fileURLToPath(import.meta.url));
const textPath = resolve(directory, 'word-identity.txt');
writeFileSync(textPath, `${report.textReport}\n`);
console.log(report.textReport);
console.log(`\ntext: ${textPath}`);
