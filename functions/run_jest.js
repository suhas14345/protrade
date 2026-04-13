#!/usr/bin/env node
const { execSync } = require('child_process');
const path = require('path');

try {
  const nodeExe = 'C:\\tools\\node-v20.11.1-win-x64\\node.exe';
  const jestPath = path.join(__dirname, 'node_modules', '.bin', 'jest');
  
  const cmd = `"${nodeExe}" "${jestPath}" --no-coverage --runInBand`;
  console.log(`Running: ${cmd}\n`);
  
  const output = execSync(cmd, {
    cwd: __dirname,
    stdio: 'inherit',
    shell: true
  });
} catch (error) {
  process.exit(1);
}
