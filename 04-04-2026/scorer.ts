#!/usr/bin/env node
// Score all RCA eval outputs.
// Finds every output.md under <experiment>/N/, scores it against answers/N.md,
// and writes score.txt next to it.
//
// Usage: npx tsx scorer.ts [experiment] [--skip=1,2,3]
// Examples:
//   npx tsx scorer.ts               — score all experiments
//   npx tsx scorer.ts cursor-sentry — score only cursor-sentry
//   npx tsx scorer.ts foam          — score only foam
//   npx tsx scorer.ts cursor-qo --skip=14 — score cursor-qo except eval 14

import { promises as fs } from 'fs';
import path from 'path';
import { LLMClassifierFromTemplate } from 'autoevals';
import { glob } from 'glob';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const ANSWERS_DIR = path.join(ROOT, 'answers');

const rcaClassifier = LLMClassifierFromTemplate({
	model: 'gpt-4o',
	name: 'rca-match',
	promptTemplate: `You are an expert software engineer evaluating whether an output RCA correctly identifies the same root cause as an answer-key RCA.
  
  ## Answer-Key RCA
  {{expected}}
  
  ## Output RCA (to evaluate)
  {{output}}
  
  ---
  
  Think step by step through the following questions:
  
  **1. Are these describing the same incident?**
  Do both RCAs reference the same observable failure such as same error or service?
  If they describe different incidents, answer "No" immediately.
  
  **2. Do they agree on the precise root cause?**
  The root cause is the specific technical condition that, if corrected, would fix the bug.
  E.g. two RCAs that mention the same symptom or the same general system area but disagree on the underlying technical cause are not a match.
  Two RCAs that share the same observations but attribute the failure to different underlying conditions (e.g., operational error vs. code defect) do NOT have the same root cause.
  This is the most important question. Overlapping fix recommendations do NOT make two RCAs a match if they diagnose different root causes.

  **3. Would an engineer reading the output RCA arrive at the same fix as one who read the answer-key RCA?**
  Based purely on the understanding of the root cause conveyed in each RCA, would two engineers independently reach the same conclusion about what needs to change?

  - If their mental model of the problem would lead them in fundamentally different directions (i.e. fixing one would not resolve the issue described in the other), the root causes are not the same.

  - The fix proposed does not need to be identical in wording or implementation. RCAs can still match if they identify the same underlying issue, even if one includes additional contributing factors or describes the cause at a different level of abstraction.

  - Focus on whether both RCAs point to the same underlying condition that, if corrected, would resolve the issue — not whether they suggest the exact same fix steps.
  ---
  
  Answer "Yes" only if all three are true:
  - Same incident or error
  - Same precise root cause (not just same symptom or general service)
  - An engineer reading the output would arrive at the same fix as one reading the answer-key
  
  Answer "No" if the output identifies the right symptom but the wrong underlying cause, or if the understanding conveyed would lead an engineer to a different fix than the answer-key.`,
	choiceScores: { No: 0, Yes: 1 },
	useCoT: true,
});

async function main() {
	const experiment = process.argv[2];
	const skipArg = process.argv.find((arg) => arg.startsWith('--skip='));
	const skipped = new Set((skipArg?.slice('--skip='.length).split(',') ?? []).filter(Boolean));
	const pattern = experiment ? `${experiment}/*/output.md` : '*/*/output.md';
	const outputFiles = (await glob(pattern, { cwd: ROOT, absolute: true })).filter((outputPath) => {
		const experimentName = path.basename(path.dirname(path.dirname(outputPath)));
		const evalIndex = path.basename(path.dirname(outputPath));
		return experimentName !== 'answers' && experimentName !== 'node_modules' && !skipped.has(evalIndex);
	});
	console.log(
		`Found ${outputFiles.length} output(s) to score${experiment ? ` (experiment: ${experiment})` : ''}${skipped.size ? `, skipping: ${Array.from(skipped).join(', ')}` : ''}\n`,
	);

	for (const outputPath of outputFiles.sort()) {
		const evalIndex = path.basename(path.dirname(outputPath));
		const experiment = path.basename(path.dirname(path.dirname(outputPath)));
		const label = `${experiment}/${evalIndex}`;

		const answerPath = path.join(ANSWERS_DIR, `${evalIndex}.md`);
		let answerKey: string;
		try {
			answerKey = await fs.readFile(answerPath, 'utf-8');
		} catch {
			console.log(`${label}: skipped (no answer key)`);
			continue;
		}

		const output = await fs.readFile(outputPath, 'utf-8');
		if (!output.trim()) {
			console.log(`${label}: skipped (empty output)`);
			continue;
		}

		try {
			const result = await rcaClassifier({ expected: answerKey, output });
			const score = result.score === 1 ? 100 : 0;
			await fs.writeFile(path.join(path.dirname(outputPath), 'score.txt'), String(score));
			console.log(`${label}: ${score}`);
		} catch (err) {
			console.log(`${label}: error — ${err instanceof Error ? err.message : err}`);
		}
	}
}

main();
