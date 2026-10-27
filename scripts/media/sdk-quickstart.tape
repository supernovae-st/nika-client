# sdk-quickstart.tape · the README quick start, run as written against the published package.
# render.mjs refuses to record unless the two commands typed first are README step 1
# (the install pinned to the package version) and `node demo.mts` prints exactly the
# README's promised output; hello.nika and demo.mts are extracted byte for byte from
# README steps 2 and 3, so this recording cannot drift from the page that embeds it.
# The hidden first line routes the shell's stderr through a pipe: the engine's
# TTY-only home-isolation notice (printed only because the render's scratch HOME
# differs from the account home) stays out, as the engine's own captures keep it out.
Output out/sdk-quickstart.gif
Output out/sdk-quickstart.mp4
Output out/sdk-quickstart.txt
Source theme.tape
Require node
Require npm

Hide
Type "cd app && setopt interactive_comments && PROMPT='%F{#62E3FF}$%f ' && PROMPT_EOL_MARK='' && exec 2> >(cat) && clear"
Enter
Sleep 400ms
Show

Type "npm install @supernovae-st/nika@0.124.0"
Sleep 300ms
Enter
Wait@120s
Sleep 900ms

Type "ls node_modules/@supernovae-st         # the client and its native engine"
Enter
Sleep 1.6s

Type "./node_modules/.bin/nika --version"
Enter
Wait@60s
Sleep 1.2s

Type "NIKA_KEYCHAIN=off ./node_modules/.bin/nika key init   # once per machine: a key that signs each run's record"
Enter
Wait
Sleep 2.2s

Ctrl+L
Sleep 200ms
Type "cat hello.nika"
Enter
Sleep 3.2s

Ctrl+L
Sleep 200ms
Type "cat demo.mts"
Enter
Sleep 5.5s

Type "node demo.mts"
Enter
Wait
Sleep 3.5s
Screenshot out/sdk-quickstart.png
Sleep 300ms
