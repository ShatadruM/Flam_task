#!/usr/bin/env node
import fs from 'fs';
import { Command } from 'commander';
import { withDatabase } from '../src/cli/context.js';
import { parseJobInput, enqueueJob } from '../src/jobs/enqueue.js';
import { listJobs } from '../src/jobs/list.js';
import { generateWorkerId } from '../src/worker/id.js';
import { runWorkerLoop } from '../src/worker/run.js';
import { listDlqJobs, retryDlqJob } from '../src/dlq/dlq.js';
import { setConfig } from '../src/config/config.js';


const program = new Command();

program
  .name('queuectl')
  .description('CLI-based background job queue with retries, backoff, and a DLQ')
  .version('0.1.0');

program
  .command('enqueue [job]')
  .description('Add a new job — inline JSON, or --file path/to/job.json')
  .option('--file <path>', 'read job JSON from a file instead of an inline argument')
  .action(async (jobArg, opts) => {
    try {
      if (!jobArg && !opts.file) {
        throw new Error('Provide job JSON inline or via --file <path>');
      }
      if (jobArg && opts.file) {
        throw new Error('Provide either inline JSON or --file, not both');
      }

      const jobJson = opts.file
        ? fs.readFileSync(opts.file, 'utf8').replace(/^\uFEFF/, '')
        : jobArg;

      const jobInput = parseJobInput(jobJson);
      await withDatabase(async (db) => {
        const job = await enqueueJob(db, jobInput);
        console.log(`Enqueued job "${job.id}"`);
      });
    } catch (err) {
      console.error(err.message);
      process.exitCode = 1;
    }
  });

const worker = program.command('worker').description('Manage worker processes');

worker
  .command('start')
  .description('Start workers in the foreground (blocks until stopped)')
  .option('--count <n>', 'number of worker processes', '1')
  .action(async () => {
    const workerId = generateWorkerId();
    console.log(`Worker ${workerId} started. Press Ctrl+C to stop.`);
    await withDatabase(async (db) => {
      await runWorkerLoop(db, { workerId });
    });
  });

worker
  .command('stop')
  .description('Gracefully stop all running workers from another terminal')
  .action(() => {
    console.error('worker stop: not implemented yet');
  });

program
  .command('status')
  .description('Summary of all job states & active workers')
  .action(() => {
    console.error('status: not implemented yet');
  });

program
  .command('list')
  .description('List jobs by state')
  .option('--state <state>', 'filter by job state')
  .option('--json', 'output as a JSON array')
  .action(async (opts) => {
    try {
      await withDatabase(async (db) => {
        const jobs = await listJobs(db, { state: opts.state });

        if (opts.json) {
          console.log(JSON.stringify(jobs));
          return;
        }

        if (jobs.length === 0) {
          console.log('No jobs found.');
          return;
        }
        for (const job of jobs) {
          console.log(`${job.id}\t${job.state}\t${job.command}`);
        }
      });
    } catch (err) {
      console.error(err.message);
      process.exitCode = 1;
    }
  });


const dlq = program.command('dlq').description('View or retry dead-lettered jobs');

dlq
  .command('list')
  .option('--json', 'output as a JSON array')
  .description('List jobs in the DLQ')
  .action(async (opts) => {
    try {
      await withDatabase(async (db) => {
        const jobs = await listDlqJobs(db);
        if (opts.json) {
          console.log(JSON.stringify(jobs));
          return;
        }
        if (jobs.length === 0) {
          console.log('DLQ is empty.');
          return;
        }
        for (const job of jobs) {
          console.log(`${job.id}\t${job.attempts}/${job.max_retries} attempts\t${job.command}`);
        }
      });
    } catch (err) {
      console.error(err.message);
      process.exitCode = 1;
    }
  });

dlq
  .command('retry <id>')
  .description('Re-enqueue a dead job')
  .action(async (id) => {
    try {
      await withDatabase(async (db) => {
        const job = await retryDlqJob(db, id);
        console.log(`Job "${job.id}" re-enqueued (attempts reset to 0)`);
      });
    } catch (err) {
      console.error(err.message);
      process.exitCode = 1;
    }
  });

const config = program.command('config').description('Manage configuration');

config
  .command('set <key> <value>')
  .description('Set a config value (max-retries, backoff-base)')
  .action(async (key, value) => {
    try {
      await withDatabase(async (db) => {
        await setConfig(db, key, value);
        console.log(`Set ${key} = ${value}`);
      });
    } catch (err) {
      console.error(err.message);
      process.exitCode = 1;
    }
  });

program.parse();