import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeMetrics,
  describeOutcome,
  evaluate,
  formatConfusion,
  formatMetrics,
  loadPath,
  targetsMet,
} from './golden-lib';

// 사용법: pnpm --filter @winds/parser golden [파일|디렉터리 ...] [--strict] [--quiet]
const args = process.argv.slice(2);
const strict = args.includes('--strict');
const quiet = args.includes('--quiet');
const paths = args.filter((a) => !a.startsWith('--'));
const here = fileURLToPath(new URL('.', import.meta.url));
const targets = paths.length ? paths.map((p) => resolve(process.cwd(), p)) : [resolve(here, '../test/golden')];

const cases = targets.flatMap((p) => loadPath(p));
const outs = cases.map((c) => evaluate(c));

let unexpectedFail = 0;
let knownFail = 0;
let fixed = 0;
for (const o of outs) {
  const c = o.case;
  const tag = `${c.source}:${c.line}`;
  let status: string;
  if (o.pass && !c.knownFailure) status = 'PASS';
  else if (o.pass && c.knownFailure) {
    status = 'FIXED?';
    fixed++;
  } else if (c.knownFailure) {
    status = 'KNOWN';
    knownFail++;
  } else {
    status = 'FAIL';
    unexpectedFail++;
  }
  if (quiet && status === 'PASS') continue;
  console.log(`[${status.padEnd(6)}] ${tag.padEnd(26)} ${c.text}`);
  if (status !== 'PASS') {
    console.log(describeOutcome(o));
    if (c.knownFailure && c.reason) console.log(`    reason:   ${c.reason}`);
  }
}

console.log('');
console.log(`cases ${outs.length}: pass ${outs.length - unexpectedFail - knownFail - fixed}, fail ${unexpectedFail}, known-failure ${knownFail}, fixed-but-marked ${fixed}`);
console.log('');
const all = computeMetrics(outs);
console.log(formatMetrics(all, 'metrics (all cases)'));
if (knownFail + fixed > 0) {
  console.log('');
  console.log(formatMetrics(computeMetrics(outs.filter((o) => !o.case.knownFailure)), 'metrics (excluding knownFailure)'));
}
console.log('');
console.log(formatConfusion(all));

if (strict && !targetsMet(all)) {
  console.error('\n--strict: F03 quality targets not met');
  process.exit(1);
}
