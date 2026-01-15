# Conductor CLI (Rust)

Minimal workspace manager built around `git worktree` and a local SQLite DB.

## Usage

```bash
cargo run -p conductor-cli -- --help
cargo run -p conductor-cli -- repo add /path/to/repo --name myrepo
cargo run -p conductor-cli -- workspace create myrepo            # auto city name
cargo run -p conductor-cli -- workspace create myrepo victoria   # explicit name
cargo run -p conductor-cli -- workspace list
```

Use `--json` for machine-readable output.
