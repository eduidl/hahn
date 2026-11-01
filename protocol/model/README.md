# Stream termination model

`Stream.tla` models the current `/messages`, `/views`, and `/views/latest`
termination rules in the parent protocol documents. Run TLC with Java and
[tla2tools.jar](https://github.com/tlaplus/tlaplus/releases):

```sh
java -cp /path/to/tla2tools.jar tlc2.TLC -workers 1 protocol/model/Stream.tla
```

TLC reads `Stream.cfg` alongside the module. It explores up to three sent
stream events per request, including empty completion, terminal error,
disconnection before a terminal event, and a view conversion error followed by
another event. The model checks that success requires a received `complete`,
terminal errors fail, frame errors do not terminate the stream, and latest
views contain at most one frame (including conversion errors).

The queue preserves event order; disconnect closes the server side but does not
lose events already queued. A disconnect at any earlier point represents loss
before delivery. Terminal events close the server side. The client can receive
queued events independently of the server sending them. EOF is handled after
the queue drains. Event contents, HTTP errors, partial bytes, cancellation,
`unchanged`, and actual implementation behavior are outside this model. No
fairness or eventual-completion guarantee is assumed. Deadlock checking is
intentionally disabled: a finished client has no further transitions, and the
finite event bound can also stop an open server. The checked invariants are
safety properties, not liveness guarantees.

This model is a manually written abstraction, not a proof that the Rust server
or client conforms to it. Keep it aligned with the current protocol and use the
synthetic-data conformance tests to check implementations.
