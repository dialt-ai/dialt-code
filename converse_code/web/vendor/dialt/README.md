# Vendored `@dialt/sdk` browser SDK

This is the preferred-form JavaScript source for the `@dialt/sdk` version and pinned
upstream revision recorded in [UPSTREAM.json](UPSTREAM.json). The
voice page is a static application served by the Python CLI, so the SDK is
included in the wheel rather than fetched from a CDN at runtime.

Do not edit copied SDK files here. Regenerate them from the published npm package:

```bash
uv run scripts/vendor_dialt_sdk.py --npm <version>
```

or from a licensed source tree:

```bash
uv run scripts/vendor_dialt_sdk.py /path/to/sdk/browser --commit <full-git-sha>
```

The npm path runs `npm pack --ignore-scripts`, checks the tarball integrity against the
registry, and records the tarball, integrity and source commit. The update script refuses
non-Apache source and copies `LICENSE`, `NOTICE`, and the complete `THIRD_PARTY_LICENSES`
directory. Use `--check` with the same arguments to verify an update.

The SDK owns the direct Dialt connection, browser microphone capture and recovery, echo
cancellation, streaming playback, reconnection/resume, tool controls, and interruption handling.
Converse Code owns scoped-key issuance, the acknowledged localhost tool bridge, Pi controls, and
UI integration.
