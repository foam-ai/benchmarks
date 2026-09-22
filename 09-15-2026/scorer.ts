#!/usr/bin/env node
// Score all RCA eval outputs with two independent judges (Fable 5.1 and Codex).
// Finds every output.md under <experiment>/N/, scores it against the shared
// answer key in ../04-04-2026/answers/N.md, and writes three files next to it:
//   score-fable.txt  — Fable 5.1 verdict (100 / 0)
//   score-codex.txt  — Codex verdict     (100 / 0)
//   score.txt        — consensus: 100 only when BOTH judges answer Yes
//
// Usage: npx tsx scorer.ts [experiment] [--skip=1,2,3]
// Env:   ANTHROPIC_API_KEY, OPENAI_API_KEY

import { promises as fs } from 'fs';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { glob } from 'glob';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const ANSWERS_DIR = path.join(ROOT, '..', '04-04-2026', 'answers');

const FABLE_MODEL = 'claude-fable-5-1';
const CODEX_MODEL = 'gpt-5-codex';

const PROMPT = (expected: string, output: string) => `You are an expert software engineer evaluating whether an output RCA correctly identifies the same root cause as an answer-key RCA.

## Answer-Key RCA
${expected}

## Output RCA (to evaluate)
${output}

---

Think step by step through the following questions:

**1. Are these describing the same incident?**
Do both RCAs reference the same observable failure such as same error or service?
If they describe different incidents, answer "No" immediately.

**2. Do they agree on the precise root cause?**
The root cause is the specific technical condition that, if corrected, would fix the bug.
Two RCAs that mention the same symptom or the same general system area but disagree on the underlying technical cause are not a match.
Two RCAs that share the same observations but attribute the failure to different underlying conditions (e.g., operational error vs. code defect) do NOT have the same root cause.
Overlapping fix recommendations do NOT make two RCAs a match if they diagnose different root causes.

**3. Would an engineer reading the output RCA arrive at the same fix as one who read the answer-key RCA?**
The fix does not need to be identical in wording. RCAs still match if they identify the same underlying condition, even if one includes extra contributing factors or a different level of abstraction.

Answer "Yes" only if all three are true. Answer "No" if the output identifies the right symptom but the wrong underlying cause.

Reason step by step, then finish with a final line containing exactly one word: Yes or No.`;

function parseVerdict(text: string): 100 | 0 {
	const last = text.trim().split('\n').filter(Boolean).pop() ?? '';
	return /\byes\b/i.test(last) ? 100 : 0;
}

async function judgeFable(expected: string, output: string): Promise<100 | 0> {
	const client = new Anthropic();
	const res = await client.messages.create({
		model: FABLE_MODEL,
		max_tokens: 2048,
		messages: [{ role: 'user', content: PROMPT(expected, output) }],
	});
	const text = res.content.map((b) => ('text' in b ? b.text : '')).join('');
	return parseVerdict(text);
}

async function judgeCodex(expected: string, output: string): Promise<100 | 0> {
	const client = new OpenAI();
	const res = await client.responses.create({ model: CODEX_MODEL, input: PROMPT(expected, output) });
	return parseVerdict(res.output_text);
}

async function main() {
	const experiment = process.argv[2]?.startsWith('--') ? undefined : process.argv[2];
	const skipArg = process.argv.find((arg) => arg.startsWith('--skip='));
	const skipped = new Set((skipArg?.slice('--skip='.length).split(',') ?? []).filter(Boolean));
	const pattern = experiment ? `${experiment}/*/output.md` : '*/*/output.md';
	const outputFiles = (await glob(pattern, { cwd: ROOT, absolute: true })).filter((p) => {
		const experimentName = path.basename(path.dirname(path.dirname(p)));
		return experimentName !== 'node_modules' && !skipped.has(path.basename(path.dirname(p)));
	});
	console.log(`Found ${outputFiles.length} output(s) to score\n`);

	let agree = 0;
	let total = 0;
	for (const outputPath of outputFiles.sort()) {
		const evalIndex = path.basename(path.dirname(outputPath));
		const exp = path.basename(path.dirname(path.dirname(outputPath)));
		const label = `${exp}/${evalIndex}`;

		let answerKey: string;
		try {
			answerKey = await fs.readFile(path.join(ANSWERS_DIR, `${evalIndex}.md`), 'utf-8');
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
			const [fable, codex] = await Promise.all([judgeFable(answerKey, output), judgeCodex(answerKey, output)]);
			const final = fable === 100 && codex === 100 ? 100 : 0;
			const dir = path.dirname(outputPath);
			await Promise.all([
				fs.writeFile(path.join(dir, 'score-fable.txt'), String(fable)),
				fs.writeFile(path.join(dir, 'score-codex.txt'), String(codex)),
				fs.writeFile(path.join(dir, 'score.txt'), String(final)),
			]);
			total++;
			if (fable === codex) agree++;
			console.log(`${label}: ${final}  (fable=${fable}, codex=${codex}${fable !== codex ? ' — SPLIT' : ''})`);
		} catch (err) {
			console.log(`${label}: error — ${err instanceof Error ? err.message : err}`);
		}
	}
	if (total) console.log(`\nJudge agreement: ${agree}/${total} (${((agree / total) * 100).toFixed(1)}%)`);
}

main();
