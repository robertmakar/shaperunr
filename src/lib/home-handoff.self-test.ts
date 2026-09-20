import {
  HOME_HANDOFF_MS,
  homeHandoffDuration,
  shouldPlayHomeHandoff,
} from './home-handoff';

type Result = { name: string; passed: boolean; detail: string };

const results: Result[] = [
  {
    name: 'handoff stays inside the 400–700ms window',
    passed: HOME_HANDOFF_MS >= 400 && HOME_HANDOFF_MS <= 700,
    detail: `${HOME_HANDOFF_MS}ms`,
  },
  {
    name: 'empty input does not start a handoff',
    passed: shouldPlayHomeHandoff({ canSearch: false, reduceMotion: false, alreadyLocked: false }) === false,
    detail: 'blocked',
  },
  {
    name: 'reduced motion skips the animated handoff',
    passed:
      shouldPlayHomeHandoff({ canSearch: true, reduceMotion: true, alreadyLocked: false }) === false &&
      homeHandoffDuration(true) === 0,
    detail: 'skipped',
  },
  {
    name: 'locked find does not start a second handoff',
    passed: shouldPlayHomeHandoff({ canSearch: true, reduceMotion: false, alreadyLocked: true }) === false,
    detail: 'locked',
  },
  {
    name: 'normal tap can play the handoff',
    passed:
      shouldPlayHomeHandoff({ canSearch: true, reduceMotion: false, alreadyLocked: false }) === true &&
      homeHandoffDuration(false) === HOME_HANDOFF_MS,
    detail: 'play',
  },
];

for (const result of results) {
  console.log(`${result.passed ? 'PASS' : 'FAIL'}  ${result.name} — ${result.detail}`);
}
if (results.some((result) => !result.passed)) {
  process.exitCode = 1;
}
