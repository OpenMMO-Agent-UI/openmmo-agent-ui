#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')

const releaseDir = process.argv[2]
const platform = process.argv[3] || process.platform

if (!releaseDir) {
  process.stderr.write('usage: find-agent-binary.js RELEASE_DIR [PLATFORM]\n')
  process.exitCode = 2
} else {
  const names = platform === 'win32'
    ? ['agent-client.exe', 'agent-client']
    : ['agent-client', 'agent-client.exe']
  const binary = names
    .map((name) => path.join(releaseDir, name))
    .find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile())

  if (!binary) {
    process.stderr.write(`no agent-client binary at ${releaseDir}\n`)
    process.exitCode = 1
  } else {
    process.stdout.write(`${binary}\n`)
  }
}
