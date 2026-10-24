# sdk-events.tape · run.events() streams one lifecycle vocabulary while a run executes.
# The hidden first line routes the shell's stderr through a pipe (see sdk-quickstart.tape).
Output out/sdk-events.gif
Output out/sdk-events.mp4
Output out/sdk-events.txt
Source theme.tape
Require node

Hide
Type "cd app && setopt interactive_comments && PROMPT='%F{#62E3FF}$%f ' && PROMPT_EOL_MARK='' && exec 2> >(cat) && clear"
Enter
Sleep 400ms
Show

Type "./node_modules/.bin/nika check brief.nika | head -n 5"
Enter
Wait
Sleep 2.4s

Ctrl+L
Sleep 200ms
Type "cat watch.mts"
Enter
Sleep 5.5s

Ctrl+L
Sleep 200ms
Type "node watch.mts"
Enter
Wait
Sleep 4s
Screenshot out/sdk-events.png
Sleep 300ms
