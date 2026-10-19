# Renders assets/demo.gif: the offline demo, a naive and a careful rule-based agent on the same
# 32 scripted carrier calls. Run from the repo root after `npm run build`:  vhs assets/demo.tape
#
# The output is paged with `less` so the task table, the failure modes and the careful run each
# fit on one screen. `script` gives the CLI a terminal, so it keeps its colors through the pager.

Output assets/demo.gif

Set Shell "bash"
Set FontSize 15
Set Width 1200
Set Height 820
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 40ms

Hide
Type 'unset NO_COLOR && sandtable() { script -q /dev/null node dist/cli.js "$@" | less -R; } && clear'
Enter
Show

Sleep 500ms
Type "sandtable demo --no-open"
Sleep 400ms
Enter
Sleep 6s

Type "/Top failure modes"
Sleep 400ms
Enter
Sleep 8s

Type "/agent scripted:careful"
Sleep 400ms
Enter
Sleep 5s

Hide
Type "q"
Type "clear"
Enter
