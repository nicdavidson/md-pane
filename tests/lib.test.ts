import { expect, test } from 'claude-code/testing'

import { hrefToPath, linkify, normalize, parseLocation, sections, unifiedDiff } from '../hooks/lib'

test('locations', () => {
  expect(parseLocation('myserver:/srv/a.md')).toEqual({ host: 'myserver', path: '/srv/a.md' })
  expect(parseLocation('me@myserver:/a.md')).toEqual({ host: 'me@myserver', path: '/a.md' })
  expect(parseLocation('/home/u/a.md')).toEqual({ path: '/home/u/a.md' })
  expect(normalize('/a/b/../c/./d.md')).toBe('/a/c/d.md')
})

test('relative .md links become file:// links; web links stay', () => {
  const got = linkify('[x](../other.md) [y](https://e.com/z.md) [z](sub/my%20doc.md#top)', '/home/u/notes/a.md')
  expect(got.text).toBe('[x](file:///home/u/other.md) [y](https://e.com/z.md) [z](file:///home/u/notes/sub/my%20doc.md)')
  expect(got.hrefs.map(hrefToPath)).toEqual(['/home/u/other.md', '/home/u/notes/sub/my doc.md'])
})

test('sections split at headings, not inside code fences', () => {
  const parts = sections('intro\n# One\nbody\n```\n# not a heading\n```\n## Two\nmore')
  expect(parts.map(p => p.heading)).toEqual([undefined, 'One', 'Two'])
  expect(parts[1]?.text).toContain('# not a heading')
})

test('unified diff', () => {
  const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n'].join('\n')
  const after = before.replace('c', 'C').replace('m', 'M\nM2')
  expect(unifiedDiff(before, after, 'x.md')).toBe(
    [
      '--- a/x.md', '+++ b/x.md',
      '@@ -1,6 +1,6 @@', ' a', ' b', '-c', '+C', ' d', ' e', ' f',
      '@@ -10,5 +10,6 @@', ' j', ' k', ' l', '-m', '+M', '+M2', ' n',
    ].join('\n'),
  )
  expect(unifiedDiff('same', 'same', 'x.md')).toBe('')
})
