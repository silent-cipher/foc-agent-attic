#!/usr/bin/env node
import { run } from './cli.ts'

process.exitCode = await run(
  process.argv.slice(2),
  (text) => process.stdout.write(text),
  (text) => process.stderr.write(text)
)
