import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Doc, View } from '../types'
import { hrefToPath, linkify, parseLocation, sections, shellQuote, unifiedDiff } from './lib'

const PANE = 'md'
const files = atom({ plugin: 'md-pane', key: 'files' } as const, [], { shape: 'files-1' })
const doc = atom({ plugin: 'md-pane', key: 'doc' } as const, null, { shape: 'doc-2' })
const view = atom({ plugin: 'md-pane', key: 'view' } as const, 'doc', { shape: 'view-1' })

type AutoOpen = 'always' | 'project' | 'off'
const AUTO_MODES: AutoOpen[] = ['always', 'project', 'off']
const REMOTE_POLL_TICKS = 7 // remote files re-checked every ~10s, local every 1.5s

// Prints $HOME, then Write/Edit file_path fragments from recent transcripts, newest first.
const RECENT_SCRIPT = `echo "$HOME"
find "$HOME/.claude/projects" -name '*.jsonl' -mtime -30 -printf '%T@ %p\\n' 2>/dev/null |
  sort -rn | cut -d' ' -f2- |
  while IFS= read -r f; do
    grep -oE '"name":"(Write|Edit)","input":[{]("replace_all":(true|false),)?"file_path":"[^"]*"' "$f" | tac
  done | head -n 2000`

const isMarkdown = (path: unknown): path is string =>
  typeof path === 'string' && /\.(md|markdown)$/i.test(path)

const base = (spec: string) => spec.slice(spec.lastIndexOf('/') + 1)
const dir = (spec: string) => {
  const { host, path } = parseLocation(spec)
  const d = path.slice(0, path.lastIndexOf('/'))
  const short = home && d.startsWith(home) ? '~' + d.slice(home.length) : d
  return host ? `${host}:${short}` : short
}

// Learned at session start (the module has no env access of its own).
let home = ''
let cwd = ''

// Fetch a file's text and mtime, locally or over ssh for `host:/path`.
async function fetch($: EngineInterface, spec: string): Promise<{ text: string; mtimeMs: number }> {
  const { host, path } = parseLocation(spec)
  if (!host) {
    const stat = await $.fs.stat(path)
    return { text: await $.fs.read(path), mtimeMs: stat.mtimeMs }
  }
  const q = shellQuote(path)
  const ran = await $.process.run(
    ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', host, `stat -c %Y -- ${q} && cat -- ${q}`],
    { timeoutMs: 15_000 },
  )
  if (ran.exitCode !== 0) throw new Error(ran.stderr.trim() || `ssh exited ${ran.exitCode}`)
  const cut = ran.stdout.indexOf('\n')
  return { text: ran.stdout.slice(cut + 1), mtimeMs: Number(ran.stdout.slice(0, cut)) * 1000 }
}

// Read a file into the pane; keeps the old text if the read fails, and the
// previous text when it changed, for the diff view.
async function load($: EngineInterface, spec: string) {
  try {
    const got = await fetch($, spec)
    const now = await $.clock.now()
    await update($, doc, old => {
      if (old?.path !== spec) return { path: spec, ...got }
      if (old.text === got.text) return { ...old, mtimeMs: got.mtimeMs, error: undefined }
      return { path: spec, ...got, prev: old.text, changedAt: now }
    })
  } catch (err) {
    await update($, doc, old => ({
      ...(old?.path === spec ? old : { path: spec, text: '' }),
      mtimeMs: 0,
      error: String(err instanceof Error ? err.message : err),
    }))
  }
}

async function remember($: EngineInterface, spec: string) {
  await update($, files, list => [spec, ...list.filter(f => f !== spec)].slice(0, 50))
}

// `isNew` moves the file to the top of the recent list; browsing leaves the order alone.
async function show($: EngineInterface, spec: string, isNew = false) {
  if (isNew) await remember($, spec)
  await update($, view, () => 'doc' as View)
  await load($, spec)
  await $.ui.open({ id: PANE, title: 'Markdown' })
}

async function autoOpen($: EngineInterface): Promise<AutoOpen> {
  const v = await $.store.get('autoOpen')
  return AUTO_MODES.includes(v as AutoOpen) ? (v as AutoOpen) : 'always'
}

async function jumpTo($: EngineInterface, key: string) {
  await update($, view, () => 'doc' as View)
  await $.clock.sleep(50) // let the doc view draw before scrolling to its section
  await $.ui.scroll({ to: { key }, in: PANE, block: 'start' }).catch(() => undefined)
}

async function askToEdit($: EngineInterface, spec: string) {
  await $.prompt.fill({ text: `Edit ${spec}: ` })
  $.ui.toast('Prompt filled: press Esc to return to it and describe the change')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    await $.command.register({
      name: 'md',
      description: 'Show a markdown file in a side pane (default: the latest Claude wrote)',
      argumentHint: '[path | host:/path | close | auto always|project|off]',
    })

    // Seed the recent list from the .md files Write/Edit touched in the last
    // 30 days of Claude transcripts, newest first.
    const ran = await $.process.run(['sh', '-c', RECENT_SCRIPT], { timeoutMs: 20_000 }).catch(() => undefined)
    if (ran) {
      const [h = '', ...lines] = ran.stdout.split('\n')
      home = h
      const seen = new Set<string>()
      for (const line of lines) {
        const path = /"file_path":"([^"]*)"$/.exec(line)?.[1]
        if (!isMarkdown(path) || seen.has(path)) continue
        seen.add(path)
        if (seen.size > 100) break
      }
      const found: string[] = []
      for (const path of seen) {
        if (found.length >= 50) break
        if (await $.fs.exists(path)) found.push(path)
      }
      await update($, files, list => [...list, ...found.filter(p => !list.includes(p))].slice(0, 50))
    }

    // Live reload: re-read the shown file when it changes (remote ones less often).
    let tick = 0
    let isBusy = false
    $.clock.every(1500, async () => {
      const shown = await read($, doc)
      if (!shown || isBusy) return
      tick++
      isBusy = true
      try {
        if (parseLocation(shown.path).host) {
          if (tick % REMOTE_POLL_TICKS === 0) await load($, shown.path)
        } else {
          const stat = await $.fs.stat(shown.path).catch(() => undefined)
          if (stat && stat.mtimeMs !== shown.mtimeMs) await load($, shown.path)
        }
      } finally {
        isBusy = false
      }
    })

    return next(e)
  })

  on('command.run', { command: 'md' }, async ($, e) => {
    const arg = e.args.trim().replace(/^~(?=\/)/, home)
    if (arg === 'close') {
      await $.ui.close({ id: PANE })
      return { text: 'Markdown pane closed.' }
    }
    if (arg === 'auto' || arg.startsWith('auto ')) {
      const mode = arg.slice(5).trim() as AutoOpen
      if (!AUTO_MODES.includes(mode)) {
        return { text: `Auto-open is ${await autoOpen($)}. Set with /md auto always|project|off.` }
      }
      await $.store.set('autoOpen', mode)
      return { text: `Auto-open set to ${mode}.` }
    }
    const spec = arg || (await read($, files))[0]
    if (!spec) return { text: 'No recent markdown files found.' }
    if (!parseLocation(spec).host && !(await $.fs.exists(spec))) return { text: `No such file: ${spec}` }
    await show($, spec, true)
    const shown = await read($, doc)
    if (shown?.error) return { text: `Couldn't read ${spec}: ${shown.error}` }

    return { text: `Showing ${spec} (ctrl+x tab to focus and scroll; c or /md close closes)` }
  })

  // Typeahead for `/md <fragment>`: subcommands and recent files containing it.
  on('prompt.autocomplete', async ($, e, next) => {
    const ran = await next(e)
    if (!/^\s*\/md\s/.test(e.text) || e.start <= e.text.indexOf('/md') + 3) return ran
    const want = e.token.toLowerCase()
    const isFirstArg = !e.text.slice(0, e.start).trim().includes(' ')
    const subs = isFirstArg
      ? [
          { text: 'close', description: 'close the pane' },
          { text: 'auto', description: 'auto-open: always | project | off' },
        ]
      : e.text.trim().startsWith('/md auto')
        ? AUTO_MODES.map(mode => ({ text: mode, description: 'auto-open mode' }))
        : []
    const rows = [
      ...subs.filter(s => s.text.startsWith(want)),
      ...(isFirstArg ? await read($, files) : [])
        .filter(spec => spec.toLowerCase().includes(want.replace(/^~/, home.toLowerCase())))
        .slice(0, 12)
        .map(spec => ({ text: spec, label: base(spec), description: dir(spec) })),
    ]

    return { suggestions: [...ran.suggestions, ...rows] }
  })

  // When Claude writes or edits a .md file, remember it, and show it per the auto-open mode.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const path = e.tool === 'Write' || e.tool === 'Edit' ? e.file_path : undefined
    if (!isMarkdown(path)) return ran
    // The pane is a side effect: a failure here must never fail Claude's own tool call.
    try {
      const mode = await autoOpen($)
      const isOpening = mode === 'always' || (mode === 'project' && path.startsWith(cwd + '/'))
      if (isOpening) await show($, path, true)
      else {
        await remember($, path)
        if ((await read($, doc))?.path === path) await load($, path)
      }
    } catch {}

    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown, Code } = $.ui.resolve(e)
    const list = await read($, files)
    const shown = await read($, doc)
    const mode = shown ? await read($, view) : 'list'
    const at = shown ? list.indexOf(shown.path) : -1
    const step = (by: number) => async () => {
      const spec = list[at + by]
      if (spec) await show($, spec)
    }
    const toggle = (to: View) => () => update($, view, v => (v === to ? 'doc' : to))
    const parts = shown ? sections(shown.text) : []
    const headings = parts.flatMap((s, i) => (s.heading === undefined ? [] : [{ ...s, key: `s${i}` }]))

    const bar = (
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        <Button key="older" hotkey="p" label="‹ older" onPress={step(1)} />
        <Button key="newer" hotkey="n" label="newer ›" onPress={step(-1)} />
        <Button key="list" hotkey="l" label={mode === 'list' ? 'back' : 'list'} onPress={toggle('list')} />
        {headings.length > 1 && (
          <Button key="toc" hotkey="t" label={mode === 'toc' ? 'back' : 'contents'} onPress={toggle('toc')} />
        )}
        {shown?.prev !== undefined && (
          <Button key="diff" hotkey="d" label={mode === 'diff' ? 'back' : 'diff'} onPress={toggle('diff')} />
        )}
        {shown && <Button key="edit" hotkey="e" label="edit" onPress={() => askToEdit($, shown.path)} />}
        <Button key="close" hotkey="c" label="close" onPress={() => $.ui.close({ id: PANE })} />
      </Box>
    )

    if (mode === 'list' || !shown) {
      return (
        <Box flexDirection="column">
          {bar}
          {list.length === 0 && <Text dimColor>No recent markdown files.</Text>}
          {list.map(spec => (
            <Button key={spec} plain onPress={() => show($, spec)}>
              {base(spec)} <Text dimColor>{dir(spec)}</Text>
            </Button>
          ))}
        </Box>
      )
    }

    const title = (
      <Text bold wrap="truncate-start">
        {base(shown.path)} <Text dimColor>{dir(shown.path)}</Text>
      </Text>
    )

    if (mode === 'toc') {
      return (
        <Box flexDirection="column">
          {bar}
          {title}
          {headings.map(head => (
            <Button key={head.key} plain onPress={() => jumpTo($, head.key)}>
              {'  '.repeat(Math.max(0, head.level - 1))}
              {head.heading}
            </Button>
          ))}
        </Box>
      )
    }

    if (mode === 'diff') {
      const diff = unifiedDiff(shown.prev ?? '', shown.text, base(shown.path))
      return (
        <Box flexDirection="column">
          {bar}
          {title}
          {diff === undefined && <Text dimColor>Too large to diff.</Text>}
          {diff === '' && <Text dimColor>No line changes.</Text>}
          {diff && <Code source={diff} format="diff" language="markdown" />}
        </Box>
      )
    }

    const { host } = parseLocation(shown.path)
    const openLink = (href: string) => {
      const path = hrefToPath(href)
      return show($, host ? `${host}:${path}` : path, true)
    }
    const ago = shown.changedAt ? Math.round(((await $.clock.now()) - shown.changedAt) / 1000) : undefined

    return (
      <Box flexDirection="column">
        {bar}
        {title}
        {ago !== undefined && ago < 120 && (
          <Text color="warning">Changed {ago < 5 ? 'just now' : `${ago}s ago`} · d shows what changed</Text>
        )}
        {shown.error && <Text color="error">Can't read: {shown.error}</Text>}
        {parts.length === 0 && <Text dimColor>(empty)</Text>}
        {parts.map((part, i) => {
          const linked = linkify(part.text, parseLocation(shown.path).path)
          return (
            <Box key={`s${i}`} flexDirection="column">
              <Markdown
                key={`m${i}`}
                text={linked.text}
                {...(linked.hrefs.length > 0 && {
                  onLinkPress: (link: { href: string }) => void openLink(link.href),
                  pressableLinks: linked.hrefs,
                })}
              />
            </Box>
          )
        })}
      </Box>
    )
  })
}
