#!/usr/bin/env node
/**
 * Simple test runner script
 */
const { spawn } = require('child_process');
const path = require('path');

const nodeExe = process.execPath;
const jestPath = path.join(__dirname, 'node_modules', '.bin', 'jest');

const proc = spawn(nodeExe, [
  jestPath,
  '--no-coverage',
  '--runInBand',
  '--verbose'
], {
  cwd: __dirname,
  stdio: 'inherit',
  shell: true
});

proc.on('exit', (code) => {
  process.exit(code);
});

proc.on('error', (error) => {
  console.error('Error running tests:', error);
  process.exit(1);
});
