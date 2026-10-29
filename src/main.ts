import { run } from './cli.ts'

const result = await run(process.argv.slice(2), (text) => process.stdout.write(text))
process.stderr.write(result.stderr)
process.exitCode = result.code
