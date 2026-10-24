# sdk-admitted-executed-sealed.tape · three different facts, shown in order:
# admitted (check() and run() refuse a red file: no run exists), executed
# (result() settles), sealed and verified (traceVerify() re-reads the trace),
# then one changed byte breaks the chain. The key is minted with README step 1's
# command: a key the engine an app starts can read.
# The hidden first line routes the shell's stderr through a pipe (see sdk-quickstart.tape).
Output out/sdk-admitted-executed-sealed.gif
Output out/sdk-admitted-executed-sealed.mp4
Output out/sdk-admitted-executed-sealed.txt
Source theme.tape
Require node

Hide
Type "cd app && setopt interactive_comments && PROMPT='%F{#62E3FF}$%f ' && PROMPT_EOL_MARK='' && exec 2> >(cat) && clear"
Enter
Sleep 400ms
Show

Type "cat list-files.nika                          # a teammate's file: runs ls, permits nothing"
Enter
Sleep 2.8s

Type "node gate.mts list-files.nika"
Enter
Wait
Sleep 3.2s
Screenshot out/sdk-check-refused.png
Sleep 300ms

Ctrl+L
Sleep 200ms
Type "diff -u list-files.nika fixed/list-files.nika"
Enter
Wait
Sleep 3s

Type "node gate.mts fixed/list-files.nika"
Enter
Wait
Sleep 2.9s

Ctrl+L
Sleep 200ms
Type "node prove.mts                     # this machine has no signing key yet"
Enter
Wait
Sleep 3.1s

Type "NIKA_KEYCHAIN=off ./node_modules/.bin/nika key init   # quick start, step 1"
Enter
Wait
Sleep 1.4s

Type "node prove.mts"
Enter
Wait
Sleep 2.9s

Type "node tamper.mts"
Enter
Wait
Sleep 1.6s

Type "node verify.mts                             # later, from the receipt you stored"
Enter
Wait
Sleep 4s
Screenshot out/sdk-admitted-executed-sealed.png
Sleep 300ms
