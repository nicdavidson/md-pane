// Pure helpers for md-pane: no `$`, so they test without an engine.

// `host:/abs/path` names a file on another machine, read over ssh.
export type Location = { host?: string; path: string }

export function parseLocation(spec: string): Location {
  const m = /^([^/\s:]+):(\/.*)$/.exec(spec)
  return m ? { host: m[1], path: m[2] ?? '' } : { path: spec }
}

export const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

// Collapse `.` and `..` in an absolute path.
export function normalize(path: string): string {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return '/' + out.join('/')
}

// Relative and file: links to .md files become absolute file:// links, so the
// pane can draw them as links and open them itself. Returns the hrefs it made.
export function linkify(text: string, docPath: string): { text: string; hrefs: string[] } {
  const dir = docPath.slice(0, docPath.lastIndexOf('/') + 1)
  const hrefs = new Set<string>()
  const out = text.replace(/\]\(([^)\s]+?\.(?:md|markdown))(#[^)\s]*)?\)/gi, (whole, target: string) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith('file:')) return whole
    let path = target.startsWith('file://') ? target.slice(7) : target
    try {
      path = decodeURIComponent(path)
    } catch {}
    const abs = normalize(path.startsWith('/') ? path : dir + path)
    const href = 'file://' + encodeURI(abs)
    if (hrefs.size < 256) hrefs.add(href)
    return `](${href})`
  })
  return { text: out, hrefs: [...hrefs] }
}

export function hrefToPath(href: string): string {
  const raw = href.replace(/^file:\/\//, '')
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

// Split at headings (outside code fences), so each section can be a scroll target.
export type Section = { heading?: string; level: number; text: string }

export function sections(text: string): Section[] {
  const list: Section[] = [{ level: 0, text: '' }]
  let fence: string | undefined
  for (const line of text.split('\n')) {
    const f = /^\s*(```+|~~~+)/.exec(line)?.[1]
    if (f) fence = fence === undefined ? f : line.trim().startsWith(fence) ? undefined : fence
    const h = fence === undefined && !f ? /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line) : null
    if (h) list.push({ heading: h[2] ?? '', level: (h[1] ?? '#').length, text: line + '\n' })
    else list[list.length - 1]!.text += line + '\n'
  }
  return list.filter(s => s.heading !== undefined || s.text.trim() !== '')
}

// Unified diff of two texts by lines (LCS), three lines of context; undefined
// when the texts are too large to compare cheaply.
export function unifiedDiff(before: string, after: string, label: string): string | undefined {
  const a = before.split('\n')
  const b = after.split('\n')
  if (a.length * b.length > 4_000_000) return undefined
  const n = a.length
  const m = b.length
  const lcs = new Uint32Array((n + 1) * (m + 1))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i * (m + 1) + j] =
        a[i] === b[j]
          ? lcs[(i + 1) * (m + 1) + j + 1]! + 1
          : Math.max(lcs[(i + 1) * (m + 1) + j]!, lcs[i * (m + 1) + j + 1]!)

  type Op = { kind: ' ' | '-' | '+'; line: string }
  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push({ kind: ' ', line: a[i]! })
      i++
      j++
    } else if (i < n && (j >= m || lcs[(i + 1) * (m + 1) + j]! >= lcs[i * (m + 1) + j + 1]!)) {
      ops.push({ kind: '-', line: a[i++]! })
    } else {
      ops.push({ kind: '+', line: b[j++]! })
    }
  }

  const CONTEXT = 3
  const hunks: string[] = []
  let k = 0
  while (k < ops.length) {
    if (ops[k]!.kind === ' ') {
      k++
      continue
    }
    const start = Math.max(0, k - CONTEXT)
    // Absorb later changes separated by at most 2*CONTEXT unchanged lines.
    let last = k
    for (let p = k + 1; p < ops.length && p - last <= CONTEXT * 2 + 1; p++) {
      if (ops[p]!.kind !== ' ') last = p
    }
    const end = Math.min(ops.length, last + CONTEXT + 1)
    const chunk = ops.slice(start, end)
    const aLen = chunk.filter(o => o.kind !== '+').length
    const bLen = chunk.filter(o => o.kind !== '-').length
    const aStart = countBefore(ops, start, '+') + (aLen ? 1 : 0)
    const bStart = countBefore(ops, start, '-') + (bLen ? 1 : 0)
    hunks.push(`@@ -${aStart},${aLen} +${bStart},${bLen} @@`)
    for (const o of chunk) hunks.push(o.kind + o.line)
    k = end
  }
  if (hunks.length === 0) return ''
  return [`--- a/${label}`, `+++ b/${label}`, ...hunks].join('\n')
}

// Lines of the old (skip '+') or new (skip '-') file before ops[upto].
function countBefore(ops: { kind: string }[], upto: number, skip: string): number {
  let c = 0
  for (let i = 0; i < upto; i++) if (ops[i]!.kind !== skip) c++
  return c
}
