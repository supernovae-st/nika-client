# local-driver.tape — the typed driver in ~12 seconds: eight lines of
# TypeScript check the workflow, gate on the honest report, run to the
# end budget-capped. Every line of output is the SDK's own over the
# released binary; scripts/media/render.sh stages the demo dir. House
# theme = the engine's nika-hero palette + the v2 window chrome.
Output local-driver.gif

Set Shell zsh
Set FontFamily "JetBrains Mono"
Set FontSize 21
Set Width 1420
Set Height 780
Set Padding 24
Set Margin 22
Set MarginFill "#4f86ff"
Set BorderRadius 14
Set WindowBar Colorful
Set WindowBarSize 42
Set Theme { "name": "nika", "background": "#08090b", "foreground": "#dbe3ee", "cursor": "#4f86ff", "black": "#10131a", "red": "#ff6b6b", "green": "#34d399", "yellow": "#f0b45b", "blue": "#4f86ff", "magenta": "#b07bff", "cyan": "#22d3ee", "white": "#dbe3ee", "brightBlack": "#5b6472", "brightRed": "#ff8f8f", "brightGreen": "#5ee6b0", "brightYellow": "#ffd08a", "brightBlue": "#8db4ff", "brightMagenta": "#c9a2ff", "brightCyan": "#67e3f5", "brightWhite": "#ffffff" }
Set TypingSpeed 30ms
Set PlaybackSpeed 1.0

Hide
Type "cd /tmp/sdk-demo && export TMPDIR=/tmp && unset -m '*API_KEY*' '*_TOKEN*' '*SECRET*' 2>/dev/null; setopt interactive_comments && clear"
Enter
Show

Type "# the typed driver over the shipped binary · zero runtime deps"
Enter
Sleep 700ms
Type "cat demo.mjs"
Enter
Sleep 3200ms

Type "# check first · then run to the end, budget-capped"
Enter
Sleep 700ms
Type "node demo.mjs"
Enter
Sleep 3800ms
Sleep 1400ms
