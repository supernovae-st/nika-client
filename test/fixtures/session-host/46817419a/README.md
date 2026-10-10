# nika/session-host@1 recorded fixture

Engine commit: 46817419a (host branch: the Session work snapshot gains `question`, the
compiler's own question document while `waiting` is a question with the same key; absent from
the wire otherwise, never `null`).

`question` is `{ key, label, type, why, mandatory }`, `type` one of `text`, `literal`,
`choice` (`other` for a shape the engine does not name), plus `options` (`[{ key, label }]`, in
the compiler's order) for a choice that has some. The answer still names `waiting.id`.

Files recorded as `../eb89e1893/README.md` describes, over the same scripts (native-answers.json,
native-log.json, http-answers.json, http-sse-log.json, http-decisions.json,
http-run-review.json), re-recorded at this head: SYNTHETIC, the real SessionRuntime over a
temporary project, its reasoner scripted and never asked, the intents reaching the deterministic
compiler. In http-decisions.json the `question` and `answer` steps carry `work.question` for key
`model` (type `text`, mandatory); the answer `mistral/mistral-small` is refused as unpriced and
the same question and id keep waiting. The real resident run of this head is
`../312c3d5a8/http-resident-run.json`, unchanged (its flow has no question).

Re-record: as `../eb89e1893/README.md` and `../312c3d5a8/README.md` say.
