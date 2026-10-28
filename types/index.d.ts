export type Doc = {
  path: string
  text: string
  mtimeMs: number
  error?: string
  // The text before the last change seen, and when it changed (for the diff view).
  prev?: string
  changedAt?: number
}

export type View = 'doc' | 'list' | 'toc' | 'diff'

declare module 'claude-code' {
  interface PluginState {
    'md-pane': {
      files: Shaped<string[]>
      doc: Shaped<Doc | null>
      view: Shaped<View>
    }
  }
}
