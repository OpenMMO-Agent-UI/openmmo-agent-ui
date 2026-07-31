#!/usr/bin/env node

const fs = require('node:fs')

const file = process.argv[2]
if (!file) {
  process.stderr.write('usage: file-mtime.js FILE\n')
  process.exitCode = 2
} else {
  const seconds = Math.floor(fs.statSync(file).mtimeMs / 1000)
  process.stdout.write(`${seconds}\n`)
}
