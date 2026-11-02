import assert from 'node:assert/strict'
import { test } from 'node:test'
import { run } from '../../src/cli.ts'

async function attic(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const output = { stdout: '', stderr: '' }
  const code = await run(
    args,
    (text) => {
      output.stdout += text
    },
    (text) => {
      output.stderr += text
    }
  )
  return { code, ...output }
}

test('--help lists every command and the exit codes, and exits 0', async () => {
  for (const flag of ['--help', '-h']) {
    const { code, stdout, stderr } = await attic([flag])
    assert.equal(code, 0)
    assert.equal(stderr, '')
    assert.match(stdout, /^Usage: attic <command> \[options\]/)
    for (const name of ['setup', 'backup', 'restore', 'sessions', 'refresh']) {
      assert.match(stdout, new RegExp(`\\n  ${name} +\\S`), name)
    }
    assert.match(stdout, /\n {2}64 {2}Usage error/)
  }
})

test("each command's --help shows its arguments, --json, an example and the exit codes, and exits 0", async () => {
  for (const [name, args] of [
    ['setup', /--grant <fgr1_…> {2}Optional/],
    ['backup', /<session id> {2}Optional/],
    ['restore', /<session id> {2}Required/],
    ['sessions', /<word>… {2}Optional/],
    ['refresh', /--json/],
  ] as const) {
    // --help wins over arguments that would fail, so an agent can always ask.
    const { code, stdout, stderr } = await attic([name, 'not/an-id', '--help'])
    assert.equal(code, 0, name)
    assert.equal(stderr, '', name)
    assert.match(stdout, new RegExp(`^Usage: attic ${name} `), name)
    assert.match(stdout, args, name)
    assert.match(stdout, /\n {2}--json {2}/, name)
    assert.match(stdout, new RegExp(`\\nExample:\\n {2}attic ${name}`), name)
    assert.match(stdout, /\nExit codes:\n {2}0 {3}Done\./, name)
  }
})

test('a missing or unknown command is a usage error', async () => {
  for (const args of [[], ['nope'], ['--version', 'extra'], ['--help', 'extra']]) {
    const { code, stdout, stderr } = await attic(args)
    assert.equal(code, 64, args.join(' '))
    assert.equal(stdout, '')
    assert.match(stderr, /^Error: Give a command: setup, backup, restore, sessions, refresh\.\nRun attic --help/)
  }
})

test('backup and restore reject extra or unsafe session IDs that cannot leave the projects folder', async () => {
  for (const command of ['backup', 'restore']) {
    for (const [args, reason] of [
      [['a', 'b'], /Give one session ID/],
      [['../a'], /\.\.\/a is not a session ID/],
      [['a/b'], /a\/b is not a session ID/],
    ] as const) {
      const result = await attic([command, ...args])
      assert.equal(result.code, 64)
      assert.match(result.stderr, reason)
      assert.match(result.stderr, new RegExp(`\\nRun attic ${command} --help for its arguments\\.\\n$`))
    }
  }
})

test('refresh takes no arguments and sessions rejects unknown options', async () => {
  const refresh = await attic(['refresh', 'extra'])
  assert.equal(refresh.code, 64)
  assert.match(refresh.stderr, /Unexpected argument 'extra'/)
  const sessions = await attic(['sessions', '--extra'])
  assert.equal(sessions.code, 64)
  assert.match(sessions.stderr, /Unknown option '--extra'/)
})

test('restore still requires an ID', async () => {
  const result = await attic(['restore'])
  assert.equal(result.code, 64)
  assert.match(result.stderr, /Give one session ID/)
})

test('with --json, a usage error is one JSON object on stdout that says not to retry', async () => {
  for (const args of [
    ['restore', '--json'],
    ['nope', '--json'],
    ['backup', '--json', '--bogus'],
  ]) {
    const { code, stdout, stderr } = await attic(args)
    assert.equal(code, 64, args.join(' '))
    const { error, message, retryable } = JSON.parse(stdout)
    assert.deepEqual([error, retryable], ['usage', false], args.join(' '))
    assert.ok(stderr.startsWith(`Error: ${message}\n`), stderr)
  }
})
