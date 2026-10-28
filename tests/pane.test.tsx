import type { PromptAutocompleteInput, PromptAutocompleteResult } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine, TestBody } from 'claude-code/testing'

const PANE = {
  plugin: 'md-pane',
  component: 'Pane',
  requestId: 'md',
  props: {
    title: 'Markdown',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

// What the transcript scan prints: $HOME, then Write/Edit fragments, newest first.
const scan = (...paths: string[]) =>
  ['/home/u', ...paths.map(p => `"name":"Write","input":{"file_path":"${p}"`)].join('\n') + '\n'
const RECENT = scan('/home/u/notes/b.md', '/home/u/notes/gone.md', '/home/u/notes/b.md')
const RAN = { stderr: '', isStdoutTruncated: false, isStderrTruncated: false }

type On = Parameters<TestBody>[1]

// `/md <args>` as the person typing it would run it.
const md = ($: Engine, args: string) =>
  $.command.run({ command: 'md', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })

// The engine raises prompt.autocomplete itself; the test kit's `$` has no typed call for it.
const autocomplete = ($: Engine, text: string, token: string) =>
  ($.prompt as unknown as { autocomplete: (e: PromptAutocompleteInput) => Promise<PromptAutocompleteResult> })
    .autocomplete({ text, cursor: text.length, token, start: text.length - token.length })

// Stands in for the engine: a file system of `files`, a store, a clock.
function engine(on: On, files: Record<string, string>, recent = RECENT) {
  const store: Record<string, unknown> = {}
  const calls = { fills: [] as string[], ssh: [] as string[][] }
  on('command.register', () => ({ value: { command: 'md' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.fill', (_, e) => (calls.fills.push(e.text), { isFilled: true }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', (_, e) => {
    if (e.argv[0] === 'ssh') {
      calls.ssh.push([...e.argv])
      return { value: { exitCode: 0, stdout: '1700000000\n# Remote\n', ...RAN } }
    }
    return { value: { exitCode: 0, stdout: recent, ...RAN } }
  })
  on('clock.every', () => ({ value: undefined }))
  on('clock.sleep', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 1000 }))
  on('store.get', (_, e) => ({ value: store[e.key] }))
  on('store.set', (_, e) => ((store[e.key] = e.value), { value: undefined }))
  on('fs.exists', (_, e) => ({ value: e.path in files }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 1, isLink: false } }))
  on('fs.read', (_, e) => ({ value: files[e.path] ?? '' }))
  on('tool.call', () => ({ result: {} }))
  return calls
}

const START = { cwd: '/home/u/proj', surface: 'terminal', isInteractive: true } as const

test('a .md Claude writes shows in the pane; older/list browse', async ($, on) => {
  engine(on, { '/home/u/notes/a.md': '# Alpha\n\nfirst', '/home/u/notes/b.md': '# Beta\n\nsecond' })
  await $.session.start(START)
  await $.tool.call({ tool: 'Write', file_path: '/home/u/notes/a.md', content: '# Alpha' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Markdown' }))?.text).toContain('Alpha')
    expect((await ui.find({ type: 'Text', text: /a\.md/ }))?.text).toContain('~/notes')

    await ui.press({ key: 'older' })
    expect((await ui.find({ type: 'Markdown' }))?.text).toContain('Beta')
    await ui.press({ key: 'newer' })
    expect((await ui.find({ type: 'Markdown' }))?.text).toContain('Alpha')

    await ui.press({ key: 'list' })
    expect(await ui.find({ type: 'Button', key: '/home/u/notes/b.md' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: '/home/u/notes/gone.md' })).toBeUndefined()
    await ui.press({ key: 'list' })
    await ui.unmount()
  }
})

test('contents jumps to a section; edit fills the prompt', async ($, on) => {
  const calls = engine(on, { '/home/u/a.md': '# Top\nintro\n## Setup\nsteps\n## Usage\nrun it' })
  await $.session.start(START)
  await md($, '/home/u/a.md')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'toc' })
  expect((await ui.find({ type: 'Button', key: 's1' }))?.text).toContain('Setup')
  await ui.press({ key: 's1' })
  // The scroll itself is checked live: the test kit settles $.ui.scroll beneath the test's hooks.
  expect((await ui.find({ type: 'Markdown', text: /Setup/ }))?.text).toContain('steps')

  await ui.press({ key: 'edit' })
  expect(calls.fills).toEqual(['Edit /home/u/a.md: '])
  await ui.unmount()
})

test('an edit to the shown file offers a diff', async ($, on) => {
  const files = { '/home/u/a.md': '# A\none\ntwo' }
  engine(on, files)
  await $.session.start(START)
  await md($, '/home/u/a.md')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: 'diff' })).toBeUndefined()

  files['/home/u/a.md'] = '# A\none\nTWO'
  await $.tool.call({ tool: 'Edit', file_path: '/home/u/a.md', old_string: 'two', new_string: 'TWO' })
  expect((await ui.find({ type: 'Text', text: /Changed/ }))?.text).toContain('d shows what changed')
  await ui.press({ key: 'diff' })
  const code = await ui.find({ type: 'Code' })
  expect(code?.text).toContain('-two')
  expect(code?.text).toContain('+TWO')
  await ui.unmount()
})

test('relative .md links open in the pane', async ($, on) => {
  engine(on, { '/home/u/a.md': 'see [the other](sub/b.md)', '/home/u/sub/b.md': '# Bee' })
  await $.session.start(START)
  await md($, '/home/u/a.md')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'm0', link: { href: 'file:///home/u/sub/b.md' } })
  expect((await ui.find({ type: 'Markdown' }))?.text).toContain('Bee')
  await ui.unmount()
})

test('host:/path reads over ssh', async ($, on) => {
  const calls = engine(on, {})
  await $.session.start(START)
  const out = await md($, 'myserver:/srv/notes.md')
  expect(out.text).toContain('Showing myserver:/srv/notes.md')
  expect(calls.ssh[0]?.slice(-2)).toEqual(['myserver', "stat -c %Y -- '/srv/notes.md' && cat -- '/srv/notes.md'"])

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Markdown' }))?.text).toContain('Remote')
  await ui.unmount()
})

test('auto-open off keeps the pane shut but remembers the file', async ($, on) => {
  engine(on, { '/home/u/a.md': '# A' })
  await $.session.start(START)
  expect((await md($, 'auto off')).text).toBe('Auto-open set to off.')
  await $.tool.call({ tool: 'Write', file_path: '/home/u/a.md', content: '# A' })

  // Nothing shown yet, so the pane draws the recent list.
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: '/home/u/a.md' })).toBeDefined()
  await ui.unmount()
})

test('/md <fragment> suggests matching recent files', async ($, on) => {
  engine(on, { '/home/u/notes/alpha.md': '', '/home/u/notes/beta.md': '' }, scan('/home/u/notes/alpha.md', '/home/u/notes/beta.md'))
  on('prompt.autocomplete', () => ({ suggestions: [] }))
  await $.session.start(START)

  const got = await autocomplete($, '/md alp', 'alp')
  expect(got.suggestions.map(row => row.text)).toEqual(['/home/u/notes/alpha.md'])

  const modes = await autocomplete($, '/md auto pr', 'pr')
  expect(modes.suggestions.map(row => row.text)).toEqual(['project'])

  const none = await autocomplete($, 'hello alp', 'alp')
  expect(none.suggestions).toEqual([])
})
