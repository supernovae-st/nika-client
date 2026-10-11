# nika/session-host@1 recorded default answers

Engine commit: fbfb1dccc (an empty line at the `model` question takes the seat the person chose,
recorded as `reading: seat_default`).

`native-default-answer.json`: recorded through this SDK's native Session door with no provider key
in the launch environment. The seated rows opened on the built-in offline mock provider
(`intelligence: '2 mock/echo'`): an empty line binds the offered seat (`seat_default`) and the same
seat typed is `as_typed`, both reaching a proposal; with no seat an empty line is refused
(`empty_answer`) and the question still waits. No model was asked, no Run requested, no consent
given. Each `answered` record is the engine's, verbatim; rows are named by the act it recorded.
