import { runCodingEvalSuite, formatEvalScorecard } from '../src/benchmarks/codingEval.js';

const asJson = process.argv.includes('--json');
const scorecard = await runCodingEvalSuite();

if (asJson) {
  console.log(JSON.stringify(scorecard, null, 2));
} else {
  console.log(formatEvalScorecard(scorecard));
}

if (scorecard.passedTasks !== scorecard.totalTasks) {
  process.exit(1);
}
