# sdk-compile.tape · compile() turns a sentence into a checked candidate; it runs nothing.
# The hidden first line routes the shell's stderr through a pipe (see sdk-quickstart.tape).
Output out/sdk-compile.gif
Output out/sdk-compile.mp4
Output out/sdk-compile.txt
Source theme.tape
Require node

Hide
Type "cd app && setopt interactive_comments && PROMPT='%F{#62E3FF}$%f ' && PROMPT_EOL_MARK='' && exec 2> >(cat) && clear"
Enter
Sleep 400ms
Show

Type `node author.mts "Every morning, summarize ./inbox/*.md into ./digest.md"`
Enter
Wait
Sleep 4.5s
Screenshot out/sdk-compile.png
Sleep 300ms

Ctrl+L
Sleep 200ms
Type "sed -n '/^permits:/,/^tasks:/p' digest.nika      # the boundary the candidate asks for"
Enter
Wait
Sleep 3.8s

Ctrl+L
Sleep 200ms
Type "./node_modules/.bin/nika check digest.nika | head -n 11"
Enter
Wait
Sleep 4.8s
