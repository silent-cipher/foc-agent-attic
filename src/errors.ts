/**
 * What has to change before the same command can succeed: `usage` the command itself, `setup` the login,
 * `not_found` the index (refresh it) or the ID, `conflict` local files, which only a person should move or fix.
 */
export type FixFirst = 'usage' | 'setup' | 'not_found' | 'conflict'

/** A failure that running the same command again won't fix. Any other error may be transient. */
export class AtticError extends Error {
  readonly type: FixFirst

  constructor(type: FixFirst, message: string) {
    super(message)
    this.type = type
  }
}
