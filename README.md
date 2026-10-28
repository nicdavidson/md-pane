# md-pane

A Claude Code mod that shows markdown files in a side pane next to the chat, so you can read the `.md` files Claude writes without leaving the session.

When Claude writes or edits a `.md` file, the pane opens with the file rendered the way a Claude reply is. It re-reads the file as it changes on disk, keeps a list of recent files, and can show a table of contents, a diff of the last change, and files on other machines over ssh.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install md-pane --marketplace nicdavidson/md-pane
```

Answer `y` to add the marketplace, then pick a scope (user scope makes it available in every session).

From a shell:

```
claude plugin install md-pane --marketplace nicdavidson/md-pane
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `nicdavidson/md-pane`, then Add plugin.

## Use

| | |
|---|---|
| `/md` | Open the pane on the newest markdown file Claude wrote |
| `/md <path>` | Open a file; type part of a name after `/md ` for suggestions from recent files |
| `/md host:/path/file.md` | Open a file on another machine over ssh (your `~/.ssh/config` aliases work) |
| `/md close` | Close the pane |
| `/md auto always\|project\|off` | When to open the pane as Claude writes a `.md`: always, only for files under the session's folder, or never (remembered across sessions) |

Press **ctrl+x tab** to give the pane the keyboard (arrows scroll, **Esc** goes back to the prompt). Then:

| Key | |
|---|---|
| **p** / **n** | Older / newer file in the recent list |
| **l** | List recent files |
| **t** | Contents: jump to a heading |
| **d** | Diff of the last change (shown after the file changes) |
| **e** | Fill the prompt with `Edit <path>: ` so you can tell Claude what to change |
| **c** | Close |

Links to other `.md` files inside a document open in the pane.

## Notes

- The recent list is seeded from the last 30 days of Claude Code transcripts in `~/.claude/projects`, using `find -printf` and `tac`, so it needs GNU tools (Linux). On other systems the list starts empty and fills as Claude writes files.
- Remote files use `ssh -o BatchMode=yes`, so the host must accept your key without a prompt. They are re-checked every ~10 seconds; local files every 1.5 seconds.
- In fullscreen mode the pane docks beside the transcript; otherwise it sits above the prompt.
- The Claude Code mod API is early access and may change between releases.

## Development

```
claude plugin validate .
claude plugin test .
```

## License

MIT
