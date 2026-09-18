import { runShapeMatchSelfTests } from '@/lib/shape-match.self-test';

const tests = runShapeMatchSelfTests();
let failed = 0;
for (const test of tests) {
  console.log(`${test.passed ? 'PASS' : 'FAIL'}  ${test.name} — ${test.detail}`);
  if (!test.passed) {
    failed += 1;
  }
}

if (failed > 0) {
  process.exitCode = 1;
}
