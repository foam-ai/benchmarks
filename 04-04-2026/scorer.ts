#!/usr/bin/env node
// Score all RCA eval outputs.
// Finds every output.md under <experiment>/N/, scores it against answers/N.md,
// and writes score.txt next to it.
//
// Usage: npx tsx scorer.ts [experiment] [--skip=1,2,3] [--model=gpt-4o] [--report-json=score-report.json] [--strict] [--dry-run]
// Examples:
//   npx tsx scorer.ts               — score all experiments
//   npx tsx scorer.ts cursor-sentry — score only cursor-sentry
//   npx tsx scorer.ts foam          — score only foam
//   npx tsx scorer.ts cursor-qo --skip=14 — score cursor-qo except eval 14
//   npx tsx scorer.ts foam --dry-run — list outputs and answer-key coverage without calling the model

import { promises as fs } from 'fs';
import path from 'path';
import { LLMClassifierFromTemplate } from 'autoevals';
import { glob } from 'glob';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const ANSWERS_DIR = path.join(ROOT, 'answers');

type Options = {
	experiment?: string;
	skipped: Set<string>;
	model: string;
	reportJson?: string;
	strict: boolean;
	dryRun: boolean;
};

type ScoreStatus = 'scored' | 'missing-answer' | 'empty-output' | 'error' | 'dry-run';

type ScoreRecord = {
	experiment: string;
	evalIndex: string;
	outputPath: string;
	answerPath: string;
	score: number | null;
	status: ScoreStatus;
	error?: string;
};

type ExperimentSummary = {
	experiment: string;
	scored: number;
	correct: number;
	incorrect: number;
	ready: number;
	skipped: number;
	errors: number;
	accuracy: number | null;
};

function createRcaClassifier(model: string) {
	return LLMClassifierFromTemplate({
		model,
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
}

function parseArgs(argv: string[]): Options {
	const options: Options = {
		skipped: new Set(),
		model: process.env.RCA_SCORER_MODEL ?? 'gpt-4o',
		strict: false,
		dryRun: false,
	};

	for (const arg of argv) {
		if (arg === '--help' || arg === '-h') {
			printHelp();
			process.exit(0);
		}
		if (arg.startsWith('--skip=')) {
			options.skipped = new Set(arg.slice('--skip='.length).split(',').filter(Boolean));
			continue;
		}
		if (arg.startsWith('--model=')) {
			options.model = arg.slice('--model='.length);
			continue;
		}
		if (arg.startsWith('--report-json=')) {
			options.reportJson = arg.slice('--report-json='.length);
			continue;
		}
		if (arg === '--strict') {
			options.strict = true;
			continue;
		}
		if (arg === '--dry-run') {
			options.dryRun = true;
			continue;
		}
		if (arg.startsWith('--')) {
			throw new Error(`Unknown option: ${arg}`);
		}
		if (options.experiment) {
			throw new Error(`Expected at most one experiment, got "${options.experiment}" and "${arg}"`);
		}
		options.experiment = arg;
	}

	if (!options.model.trim()) {
		throw new Error('Model cannot be empty. Pass --model=<model> or set RCA_SCORER_MODEL.');
	}

	if (options.reportJson !== undefined && !options.reportJson.trim()) {
		throw new Error('--report-json requires a file path.');
	}

	return options;
}

function printHelp() {
	console.log(`Usage: npx tsx scorer.ts [experiment] [options]

Options:
  --skip=1,2,3                  Skip specific eval indexes.
  --model=gpt-4o                Judge model. Defaults to RCA_SCORER_MODEL or gpt-4o.
  --report-json=score-report.json
                                 Write a machine-readable report with per-eval records and summaries.
  --strict                      Exit non-zero if any output cannot be scored.
  --dry-run                     Validate output discovery and answer-key coverage without model calls.
  --help                        Show this message.`);
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const pattern = options.experiment ? `${options.experiment}/*/output.md` : '*/*/output.md';
	const outputFiles = (await glob(pattern, { cwd: ROOT, absolute: true })).filter((outputPath) => {
		const experimentName = path.basename(path.dirname(path.dirname(outputPath)));
		const evalIndex = path.basename(path.dirname(outputPath));
		return experimentName !== 'answers' && experimentName !== 'node_modules' && !options.skipped.has(evalIndex);
	});
	console.log(
		`Found ${outputFiles.length} output(s) to ${options.dryRun ? 'check' : 'score'}${options.experiment ? ` (experiment: ${options.experiment})` : ''}${options.skipped.size ? `, skipping: ${Array.from(options.skipped).join(', ')}` : ''}${options.dryRun ? '' : `, model: ${options.model}`}\n`,
	);

	const rcaClassifier = options.dryRun ? undefined : createRcaClassifier(options.model);
	const records: ScoreRecord[] = [];

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
			records.push(createRecord(outputPath, answerPath, 'missing-answer'));
			continue;
		}

		const output = await fs.readFile(outputPath, 'utf-8');
		if (!output.trim()) {
			console.log(`${label}: skipped (empty output)`);
			records.push(createRecord(outputPath, answerPath, 'empty-output'));
			continue;
		}

		if (options.dryRun) {
			console.log(`${label}: ready`);
			records.push(createRecord(outputPath, answerPath, 'dry-run'));
			continue;
		}

		try {
			const result = await rcaClassifier!({ expected: answerKey, output });
			const score = result.score === 1 ? 100 : 0;
			await fs.writeFile(path.join(path.dirname(outputPath), 'score.txt'), String(score));
			console.log(`${label}: ${score}`);
			records.push(createRecord(outputPath, answerPath, 'scored', score));
		} catch (err) {
			const message = normalizeError(err);
			console.log(`${label}: error — ${message}`);
			records.push(createRecord(outputPath, answerPath, 'error', null, message));
		}
	}

	const summaries = summarize(records);
	printSummary(summaries);

	if (options.reportJson) {
		const report = {
			generatedAt: new Date().toISOString(),
			root: ROOT,
			experiment: options.experiment ?? null,
			model: options.dryRun ? null : options.model,
			dryRun: options.dryRun,
			summary: summaries,
			records: records.map((record) => ({
				...record,
				outputPath: path.relative(ROOT, record.outputPath),
				answerPath: path.relative(ROOT, record.answerPath),
			})),
		};
		const reportPath = path.resolve(ROOT, options.reportJson);
		await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
		console.log(`\nWrote report: ${formatPath(reportPath)}`);
	}

	if (options.strict && records.some((record) => record.status === 'error' || record.status === 'missing-answer' || record.status === 'empty-output')) {
		process.exitCode = 1;
	}
}

function createRecord(outputPath: string, answerPath: string, status: ScoreStatus, score: number | null = null, error?: string): ScoreRecord {
	return {
		experiment: path.basename(path.dirname(path.dirname(outputPath))),
		evalIndex: path.basename(path.dirname(outputPath)),
		outputPath,
		answerPath,
		score,
		status,
		error,
	};
}

function summarize(records: ScoreRecord[]): ExperimentSummary[] {
	const byExperiment = new Map<string, ScoreRecord[]>();
	for (const record of records) {
		const existing = byExperiment.get(record.experiment) ?? [];
		existing.push(record);
		byExperiment.set(record.experiment, existing);
	}

	return Array.from(byExperiment.entries())
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([experiment, experimentRecords]) => {
			const scored = experimentRecords.filter((record) => record.status === 'scored').length;
			const correct = experimentRecords.filter((record) => record.score === 100).length;
			const incorrect = experimentRecords.filter((record) => record.score === 0).length;
			const ready = experimentRecords.filter((record) => record.status === 'dry-run').length;
			const skipped = experimentRecords.filter((record) => record.status === 'missing-answer' || record.status === 'empty-output').length;
			const errors = experimentRecords.filter((record) => record.status === 'error').length;
			return {
				experiment,
				scored,
				correct,
				incorrect,
				ready,
				skipped,
				errors,
				accuracy: scored > 0 ? correct / scored : null,
			};
		});
}

function printSummary(summaries: ExperimentSummary[]) {
	if (!summaries.length) {
		return;
	}

	console.log('\nSummary');
	for (const summary of summaries) {
		const accuracy = summary.accuracy === null ? 'n/a' : `${(summary.accuracy * 100).toFixed(1)}%`;
		const ready = summary.ready ? `, ${summary.ready} ready` : '';
		console.log(
			`${summary.experiment}: ${accuracy} (${summary.correct}/${summary.scored} scored${ready}, ${summary.skipped} skipped, ${summary.errors} errors)`,
		);
	}
}

function formatPath(filePath: string) {
	const relative = path.relative(ROOT, filePath);
	return relative.startsWith('..') ? filePath : relative;
}

function normalizeError(err: unknown) {
	return err instanceof Error ? err.message : String(err);
}

main().catch((err) => {
	console.error(normalizeError(err));
	process.exit(1);
});
