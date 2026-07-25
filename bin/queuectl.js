#!/usr/bin/env node
import { Command } from 'commander';

const program = new Command();

program
  .name('queuectl')
  .description('CLI-based background job queue with retries, backoff, and a DLQ')
  .version('0.1.0');

program
  .command('enqueue <job>')
  .description('Add a new job (JSON string, e.g. \'{"id":"job1","command":"sleep 2"}\')')
  .action((job) => {
    console.error('enqueue: not implemented yet');
  });

const worker = program.command('worker').description('Manage worker processes');

worker
  .command('start')
  .description('Start workers in the foreground (blocks until stopped)')
  .option('--count <n>', 'number of worker processes', '1')
  .action((opts) => {
    console.error('worker start: not implemented yet');
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
  .action((opts) => {
    console.error('list: not implemented yet');
  });

const dlq = program.command('dlq').description('View or retry dead-lettered jobs');

dlq
  .command('list')
  .description('List jobs in the DLQ')
  .action(() => {
    console.error('dlq list: not implemented yet');
  });

dlq
  .command('retry <id>')
  .description('Re-enqueue a dead job')
  .action((id) => {
    console.error('dlq retry: not implemented yet');
  });

const config = program.command('config').description('Manage configuration');

config
  .command('set <key> <value>')
  .description('Set a config value (e.g. max-retries, backoff-base)')
  .action((key, value) => {
    console.error('config set: not implemented yet');
  });

program.parse();