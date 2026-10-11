# nika/session-host@1 recorded answer records

Engine commit: f1dad1ef5 (the Session work snapshot carries `answered`, what the last line typed
for an authoring question did to it).

`native-answered.json`: recorded through this SDK's native Session door (`nika session --json` in a
temporary project) with no model seated and no provider key in the launch environment: the
deterministic compiler asked its own `model` question, and one fresh Session answered it once per
row. Each `answered` record is the engine's, verbatim; each row is named by the act the engine
recorded, never by what the line meant: the row `bound_as_typed_sentence` sent a sentence, which a
text question with no reading model binds whole (`reading: as_typed`), and the next compile then
asked a new `model` question. Rereading the snapshot returned the identical record in every row.
