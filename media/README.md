# Media

The recordings and the illustration that the README and the pages under
`docs/` show, how each one is made, and how to check it. Captions and alt
text for every file are in [`captions.json`](captions.json); sources,
versions, hashes and probes are in [`media-sources.json`](media-sources.json).
None of this ships in the npm package.

## Recordings

Five terminal recordings, rendered by [`scripts/media/render.mjs`](../scripts/media/render.mjs)
from [VHS](https://github.com/charmbracelet/vhs) tapes that type real commands.
Each one installs `@supernovae-st/nika@0.123.0` from the npm registry into a
fresh project; the engine is the one that package bundles,
`nika 0.123.0 (0bfde3765)`. Every model call is `mock/echo`, the engine's
offline rehearsal model: no model key and no model call over the network.

| Recording | What it shows | Tape and programs | Shown in |
|---|---|---|---|
| [`sdk-quickstart`](gifs/sdk-quickstart.gif) · [MP4](videos/sdk-quickstart.mp4?raw=true) · [transcript](transcripts/sdk-quickstart.txt) | The README quick start as written: the install, step 1's signing key, `hello.nika`, `demo.mts`, `receipt verified` | [tape](../scripts/media/sdk-quickstart.tape); the programs are the README's | README, top |
| [`sdk-admitted-executed-sealed`](gifs/sdk-admitted-executed-sealed.gif) · [MP4](videos/sdk-admitted-executed-sealed.mp4?raw=true) · [transcript](transcripts/sdk-admitted-executed-sealed.txt) | A refused file that never runs, an unsealed run, a sealed one, one changed byte | [tape](../scripts/media/sdk-admitted-executed-sealed.tape) · [programs](../scripts/media/scenes/sdk-admitted-executed-sealed) | README, `receipts.md`, `errors.md` |
| [`sdk-remote`](gifs/sdk-remote.gif) · [MP4](videos/sdk-remote.mp4?raw=true) · [transcript](transcripts/sdk-remote.txt) | The README's `nika serve` setup as written, one job, a retry, a wrong token | [tape](../scripts/media/sdk-remote.tape) · [client](../scripts/media/scenes/sdk-remote/remote.mts) | README, `server.md` |
| [`sdk-events`](gifs/sdk-events.gif) · [MP4](videos/sdk-events.mp4?raw=true) · [transcript](transcripts/sdk-events.txt) | `run.events()` for a four-task run, then `result()` | [tape](../scripts/media/sdk-events.tape) · [workflow and program](../scripts/media/scenes/sdk-events) | `runs.md` |
| [`sdk-compile`](gifs/sdk-compile.gif) · [MP4](videos/sdk-compile.mp4?raw=true) · [transcript](transcripts/sdk-compile.txt) | A sentence to a ready candidate in two rounds, with no model call; the candidate is never run | [tape](../scripts/media/sdk-compile.tape) · [program](../scripts/media/scenes/sdk-compile/author.mts) | `compile.md` |

Each recording comes as a GIF to embed (1600×900, lossless `gifsicle -O3`),
an H.264 MP4 to pause and scrub, a 1600×900 still that the pages show to a
reader who prefers reduced motion (`stills/<name>.png`), and a transcript: the
text of every screen, in order.

### What the renderer guarantees

- **Real output only.** Every frame is the terminal running the published
  package and its engine; nothing is typed into the output. The recorded
  programs are in this repository, and `hello.nika` and `demo.mts` are
  extracted byte for byte from the README.
- **The story holds before it is recorded.** Each tape first runs off camera
  in its own copy (a preflight), and the render stops if what it is about no
  longer holds: for example, if `npm install` does not add exactly two
  packages, `node demo.mts` does not print the README's two lines, `run()`
  starts a refused file, or `nika serve` does not answer as 0.123.0 with
  machine protocol 2. The quick start and server tapes must type the
  README's own commands; the quick start pins the version on camera
  (`@0.123.0`) where the README installs the latest.
- **Nothing of the machine.** A scratch `HOME` with no key and no
  configuration, `NIKA_KEYCHAIN=off`, an environment with no `*_API_KEY`,
  `*_TOKEN` or `*SECRET*` variable, and a `PATH` that cannot reach any other
  `nika`. A recording that shows a machine path, the server token, an npm
  warning or an error is refused, and so is a screen that scrolled.
- **One hidden line.** Each tape starts by routing the shell's stderr through
  a pipe. On a terminal, and only because the scratch `HOME` differs from the
  account home, the engine prints a home-isolation notice that names the
  scratch path. Every render checks, on a pseudo-terminal, that this notice is
  all the pipe hides for the engine commands the tapes type (`nika --version`,
  `nika key init`, `nika check`); `media-sources.json` records the result.

Values that change on every render: the npm install time, key fingerprints,
chain hashes, job ids, trace file names and the server's process id. The
recordings were made on macOS arm64, so the engine payload on screen is
`@supernovae-st/nika-darwin-arm64`; on Linux it is `nika-linux-x64` or
`nika-linux-arm64`.

## sdk-doors: an illustration

[`sdk-doors`](gifs/sdk-doors.gif) · [MP4](videos/sdk-doors.mp4?raw=true) · [last frame](stills/sdk-doors.png)
is an animated diagram of how the package runs a workflow through either door
(README, "What happens underneath").

- **Captured:** every line of code, event kind, verdict, hash, refusal code and
  version on screen. They come from one capture on 24 October 2026:
  `@supernovae-st/nika@0.123.0` installed from the registry, its bundled
  engine `nika 0.123.0 (0bfde3765)`, and `nika serve` 0.123.0 on a loopback
  port with a `0600` token file that was never printed, in a scratch `HOME`
  with `NIKA_KEYCHAIN=off`, running `mock/echo`. `demo.mts` and `hello.nika`
  on screen are the repository README's quick start, byte for byte, and the
  capture ran `node demo.mts`. Lines 3 and 6 are edited to the server door's
  options and back, as the capture's remote driver ran them:
  `allowInsecureHttp` for plain HTTP to loopback, and an `idempotencyKey` in
  place of `maxCostUsd`. Over HTTP the package refused the quick start's own
  options, and the capture recorded those refusals.
- **Drawn:** the cards, the package column, the lanes, the packets that travel
  them and the pacing. A run of `hello.nika` takes milliseconds; the clip
  takes 25 seconds and shows the two doors side by side, where the capture
  ran them one after the other.
- **Rendered by** the engine repository's motion pipeline
  ([`scripts/media/motion/intent-to-proof`](https://github.com/supernovae-st/nika/tree/c68e60a5456f7bce57561bd5b3aa66146ff5e575/scripts/media/motion/intent-to-proof),
  at `c68e60a54`, on the branch of
  [supernovae-st/nika#1824](https://github.com/supernovae-st/nika/pull/1824),
  which holds the clip, its capture and its exports), which refuses to render
  when a captured fact changes; the render passed the pipeline's strict
  readability audit. `media-sources.json` records the hashes of the clip, its
  capture script and the capture. This
  repository keeps the outputs only: the GIF is 960×540 at 12.5 frames per
  second (its code is texture at that size), the MP4 is 1600×900 at 30, with
  readable code, and the still is the settled last frame.

## Render and check

```sh
node scripts/media/render.mjs                  # all five tapes, or name some: sdk-remote sdk-events
node scripts/media/render.mjs --preflight-only # the stories alone, nothing recorded
node scripts/media/validate.mjs --typecheck
```

The renderer needs VHS 0.11 with ttyd and Chrome, ffmpeg, gifsicle and
pngquant on `PATH`, the Geist Mono font, Node.js 22.18 or newer and access to
registry.npmjs.org. Scratch projects go under `SDK_MEDIA_PROJECTS` (the system
temporary folder by default). It refuses to record `sdk-remote` while
`127.0.0.1:8787` is taken, and stops only a server it started.

`validate.mjs` checks that each tape was rendered from the sources it has
now, that every file is the one recorded, within budget (GIF 3 MB, MP4 4 MB,
still 1 MB) and probes as expected, that each transcript still states the
tape's facts, and with `--typecheck` that every program the recordings run
compiles under `tsc --strict` against the published types. `npm test` checks,
without these tools, that every media path a page uses is a committed file
recorded here byte for byte, that every committed file is used, and that every
image has alt text and every GIF a reduced-motion still.

Never edit a recording by hand: change its tape or scene under
`scripts/media/`, render and validate again, then update the captions.
