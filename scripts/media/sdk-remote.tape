# sdk-remote.tape · the same facade over HTTP: the README's server setup, then one job.
# The three setup lines and the serve command are README "Two doors" lines, typed as
# written; the key line is README step 1's command, because this scene's scratch HOME
# has no key yet. The server goes to the background of the same terminal
# (`> serve.log 2>&1 &`) so one screen shows both. The token is minted into a 0600
# file and never printed. render.mjs refuses to record while 127.0.0.1:8787 is taken
# and stops any scene server left behind.
# The hidden first line routes the shell's stderr through a pipe (see sdk-quickstart.tape).
Output out/sdk-remote.gif
Output out/sdk-remote.mp4
Output out/sdk-remote.txt
Source theme.tape
Require node
Require openssl
Require curl
Require jq

Hide
Type "cd app && setopt interactive_comments && PROMPT='%F{#62E3FF}$%f ' && PROMPT_EOL_MARK='' && exec 2> >(cat) && clear"
Enter
Sleep 400ms
Show

Type "test -f nika.yaml || printf 'nika: my-project\n' > nika.yaml"
Enter
Sleep 900ms

Type "mkdir -p .nika && (umask 077 && openssl rand -hex 24 > .nika/serve.token)"
Enter
Sleep 900ms

Type "printf '.nika/\n' >> .gitignore        # traces, job state and the token stay out of git"
Enter
Sleep 1.1s

Type "NIKA_KEYCHAIN=off ./node_modules/.bin/nika key init   # the server signs each job's record"
Enter
Wait
Sleep 1.2s

Type "./node_modules/.bin/nika serve --bind 127.0.0.1:8787 --workflows . --token-file .nika/serve.token > serve.log 2>&1 &"
Enter
Sleep 1.8s

Type "curl -s 127.0.0.1:8787/health | jq -c '{engineVersion, machineProtocolVersion}'"
Enter
Wait
Sleep 2s

Ctrl+L
Sleep 200ms
Type "node remote.mts"
Enter
Wait
Sleep 4.5s
Screenshot out/sdk-remote.png
Sleep 300ms

Type "kill %1"
Enter
Sleep 1.6s
