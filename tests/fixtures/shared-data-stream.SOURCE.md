# Where `shared-data-stream.json` comes from

A byte-identical copy of ClayJS's `tests/fixtures/shared-data-stream.json`, the
golden transcript of the v2 shared data stream a page expects: the messages one
port receives for its subscribe, and the subscribe it re-sends after a reconnect.

- Repository: `hyper/clayjs`
- Commit: `906a97a861f7f79b00d49d1bcd5781cc60b70146`
- SHA-256 of the file: `9aa2f48e53b9caf6228cd8ac3e16f0c5fa5865cc1744870a8641c73887889471`

Do not edit the copy: `tests/unit/shared-data-worker.test.js` compares Local's
worker against it, and a mismatch is a finding, not a fixture to adjust.
