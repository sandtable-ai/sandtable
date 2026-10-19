# Renders assets/demo.gif: `sandtable demo`, the offline demo, where a naive and a careful rule-based
# agent take the same 32 scripted carrier calls. No model calls. Run from the repo root:
#
#   npm run build && vhs assets/demo.tape
#
# Sized for a README column (about 830 px): recorded at 1600 px wide with 28 px Menlo, so it shows
# at about 14 px, crisp on high-DPI screens. The output is paged through `less -S`, which cuts long
# lines at the edge instead of wrapping them, and scrolls in three steps:
#   1. the naive agent's task table, then its pass^1 (line 39 of the output)
#   2. its top failure modes (from line 56)
#   3. the careful agent's table and its pass^1 100.0% (line 112)
# The Down counts below follow those line numbers. If the freight example's output changes, check
# them against `node dist/cli.js demo --no-open | cat -n`.
#
# Theme: the docs' dark palette with one accent. Red (failures) is the brand's #F0A374; green
# (passes) is the plain foreground, so only failures stand out.

Output assets/demo.gif

Set Shell "bash"
Set FontFamily "Menlo"
Set FontSize 28
Set LineHeight 1.1
Set Width 1600
Set Height 960
Set Padding 48
Set Framerate 30
Set TypingSpeed 55ms
Set CursorBlink false
Set Theme { "name": "sandtable", "background": "#171512", "foreground": "#E9E3D8", "cursor": "#171512", "selection": "#3A342D", "black": "#171512", "red": "#F0A374", "green": "#E9E3D8", "yellow": "#E9E3D8", "blue": "#E9E3D8", "magenta": "#E9E3D8", "cyan": "#E9E3D8", "white": "#E9E3D8", "brightBlack": "#9C9284", "brightRed": "#F0A374", "brightGreen": "#E9E3D8", "brightYellow": "#E9E3D8", "brightBlue": "#E9E3D8", "brightMagenta": "#E9E3D8", "brightCyan": "#E9E3D8", "brightWhite": "#FFFFFF" }

# `sandtable` runs the CLI built in dist/. `script` gives it a terminal, so it keeps its colors
# through the pager. Its stdin is /dev/null so the scroll keys reach `less`, and perl drops the
# "^D" that macOS `script` prints on that EOF. --no-open keeps the report from opening in a browser.
Hide
Type `export PS1='\[\e[2m\]$\[\e[0m\] ' && sandtable() { script -q /dev/null node dist/cli.js "$@" --no-open </dev/null | perl -pe 's/^\^D\x08\x08// if $. == 1' | less -RS~ --rscroll=- --use-color --color=Pkk '-Ps '; } && clear`
Enter
Sleep 300ms
Show

Sleep 400ms
Type "sandtable demo"
Sleep 300ms
Enter

# 1. The naive agent: most calls fail.
Sleep 2.5s
Hide
Down@1ms 8
Sleep 150ms
Show
Sleep 66ms
Hide
Down@1ms 9
Sleep 150ms
Show
Sleep 2s

# 2. Why: the rule each failing tool call broke.
Hide
Down@1ms 19
Sleep 150ms
Show
Sleep 66ms
Hide
Down@1ms 19
Sleep 150ms
Show
Sleep 4.5s

# 3. The careful agent on the same calls.
Hide
Down@1ms 17
Sleep 150ms
Show
Sleep 66ms
Hide
Down@1ms 18
Sleep 150ms
Show
Sleep 3.5s
