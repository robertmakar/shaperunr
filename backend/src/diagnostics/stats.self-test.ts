/**
 * DEVELOPMENT ONLY. summarizeNumbers tests.
 */
import { summarizeNumbers } from './stats';

type SelfTest = { name: string; passed: boolean; detail: string };

const empty = summarizeNumbers([]);
const single = summarizeNumbers([7]);
const multi = summarizeNumbers([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
const withNonFinite = summarizeNumbers([1, Number.NaN, 3, Number.POSITIVE_INFINITY, 5]);

const tests: SelfTest[] = [
  {
    name: 'empty input is safe and reports count 0',
    passed:
      empty.count === 0 &&
      empty.min === null &&
      empty.max === null &&
      empty.mean === null &&
      empty.median === null &&
      empty.p25 === null &&
      empty.p75 === null,
    detail: JSON.stringify(empty),
  },
  {
    name: 'single value: min/max/mean/median/p25/p75 all equal that value',
    passed:
      single.count === 1 &&
      single.min === 7 &&
      single.max === 7 &&
      single.mean === 7 &&
      single.median === 7 &&
      single.p25 === 7 &&
      single.p75 === 7,
    detail: JSON.stringify(single),
  },
  {
    name: 'multiple values: min/max/mean correct',
    passed: multi.count === 10 && multi.min === 1 && multi.max === 10 && multi.mean === 5.5,
    detail: JSON.stringify(multi),
  },
  {
    name: 'multiple values: median/p25/p75 use linear-interpolation percentiles',
    // 1..10 sorted, index = p * (n-1): median index 4.5 -> 5.5, p25 index 2.25 -> 3.25, p75 index 6.75 -> 7.75
    passed: multi.median === 5.5 && multi.p25 === 3.25 && multi.p75 === 7.75,
    detail: `median=${multi.median} p25=${multi.p25} p75=${multi.p75}`,
  },
  {
    name: 'non-finite values (NaN/Infinity) are ignored rather than poisoning the distribution',
    passed: withNonFinite.count === 3 && withNonFinite.min === 1 && withNonFinite.max === 5 && withNonFinite.mean === 3,
    detail: JSON.stringify(withNonFinite),
  },
];

for (const test of tests) {
  console.log(`${test.passed ? 'PASS' : 'FAIL'}  ${test.name} — ${test.detail}`);
}
if (tests.some((test) => !test.passed)) {
  process.exitCode = 1;
}
