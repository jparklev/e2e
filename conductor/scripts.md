# Conductor Scripts

Bundled shell scripts in `/Applications/Conductor.app/Contents/Resources/bin/`

## checkpointer.sh

Git checkpoint system using private refs. Non-disruptive snapshots of full working tree state.

### Usage

```bash
checkpointer save [--id <id>] [--force]   # Save checkpoint
checkpointer restore <id>                  # Restore to checkpoint
checkpointer diff <id1> <id2|current>      # Diff between checkpoints
```

### How it works

**Save:**
1. Captures HEAD OID (or zeros if unborn)
2. Writes current index tree via `git write-tree`
3. Creates temp index, adds all files (tracked + untracked, respects .gitignore)
4. Writes worktree tree from temp index
5. Creates checkpoint commit with metadata
6. Stores in `refs/conductor-checkpoints/<id>`

**Restore:**
1. Reads checkpoint commit metadata
2. `git reset --hard` to saved HEAD
3. `git read-tree --reset -u` to restore worktree
4. `git clean -fd` to remove extra files
5. `git read-tree --reset` to restore index

**Checkpoint commit format:**
```
checkpoint:<id>
head <HEAD_OID>
index-tree <INDEX_TREE_OID>
worktree-tree <WORKTREE_TREE_OID>
created <TIMESTAMP>
```

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Error (general failure) |
| 101 | Skipped: merge/rebase in progress |

### Full script

```bash
#!/usr/bin/env bash
# Relevant spec: .claude/skills/checkpointer.md
set -euo pipefail

# checkpointer: save/restore/diff repo checkpoints using private refs
# - Non-disruptive capture (no HEAD move, no file changes)
# - Full reversion (HEAD + index + working tree, including untracked)
# - Full diffs between checkpoints or vs current

die() { echo "checkpointer: $*" >&2; exit 1; }
timestamp() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
zeros="0000000000000000000000000000000000000000"

ensure_repo() {
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "not inside a git working tree"
}

repo_root() {
  git rev-parse --show-toplevel
}

get_meta() {
  local commit_oid="$1" key="$2"
  git cat-file commit "$commit_oid" | sed -n "s/^$key //p" | head -n1
}

save() {
  ensure_repo
  local root; root="$(repo_root)"

  # Check for merge/rebase/cherry-pick in progress
  if git rev-parse --verify MERGE_HEAD >/dev/null 2>&1 || \
     git rev-parse --verify REBASE_HEAD >/dev/null 2>&1 || \
     git rev-parse --verify CHERRY_PICK_HEAD >/dev/null 2>&1; then
    exit 101
  fi

  local id="" force="false"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -i|--id) id="${2:-}"; shift 2 ;;
      -f|--force) force="true"; shift ;;
      *) die "unknown argument to save: $1" ;;
    esac
  done

  if [[ -z "${id}" ]]; then
    id="cp-$(date -u +%Y%m%dT%H%M%SZ)"
  fi
  local ref="refs/conductor-checkpoints/$id"

  if git rev-parse -q --verify "$ref" >/dev/null 2>&1; then
    if [[ "$force" != "true" ]]; then
      die "checkpoint '$id' already exists (use --force to overwrite)"
    fi
  fi

  # HEAD OID
  local head_oid
  if ! head_oid="$(git rev-parse -q --verify HEAD 2>/dev/null)"; then
    head_oid="$zeros"
  fi

  # Index tree
  local index_tree
  if ! index_tree="$(git -C "$root" write-tree 2>/dev/null)"; then
    die "cannot save: index has unresolved merges"
  fi

  # Full working tree snapshot
  local tmp_dir tmp_index
  tmp_dir="$(mktemp -d -t chkpt-index.XXXXXX)"
  trap 'rm -rf "$tmp_dir"' EXIT
  tmp_index="$tmp_dir/index"
  GIT_INDEX_FILE="$tmp_index" git -C "$root" read-tree "$index_tree"
  GIT_INDEX_FILE="$tmp_index" git -C "$root" add -A -- .
  local worktree_tree
  worktree_tree="$(GIT_INDEX_FILE="$tmp_index" git -C "$root" write-tree)"
  rm -rf "$tmp_dir"; trap - EXIT

  # Create checkpoint commit
  local now; now="$(timestamp)"
  local msg
  msg=$(cat <<EOF
checkpoint:$id
head $head_oid
index-tree $index_tree
worktree-tree $worktree_tree
created $now
EOF
)

  local checkpoint_commit
  checkpoint_commit="$(
    GIT_AUTHOR_NAME="Checkpointer" \
    GIT_AUTHOR_EMAIL="checkpointer@noreply" \
    GIT_AUTHOR_DATE="$now" \
    GIT_COMMITTER_NAME="Checkpointer" \
    GIT_COMMITTER_EMAIL="checkpointer@noreply" \
    GIT_COMMITTER_DATE="$now" \
    git -C "$root" commit-tree "$worktree_tree" <<<"$msg"
  )"

  git -C "$root" update-ref "$ref" "$checkpoint_commit"
  echo "$id"
}

restore() {
  ensure_repo
  local root; root="$(repo_root)"
  local id="${1:-}"
  [[ -z "$id" ]] && die "Usage: checkpointer restore <id>"
  local ref="refs/conductor-checkpoints/$id"

  local commit_oid
  commit_oid="$(git -C "$root" rev-parse -q --verify "$ref" 2>/dev/null || true)"
  [[ -z "$commit_oid" ]] && die "checkpoint not found: $id"

  local head_oid index_tree worktree_tree
  head_oid="$(get_meta "$commit_oid" "head")"
  index_tree="$(get_meta "$commit_oid" "index-tree")"
  worktree_tree="$(get_meta "$commit_oid" "worktree-tree")"

  [[ -z "$worktree_tree" || -z "$index_tree" || -z "$head_oid" ]] && \
    die "checkpoint is missing metadata (id: $id)"

  if [[ "$head_oid" == "$zeros" ]]; then
    die "cannot restore: checkpoint saved with unborn HEAD"
  fi

  git -C "$root" reset --hard "$head_oid"
  git -C "$root" read-tree --reset -u "$worktree_tree"
  git -C "$root" clean -fd
  git -C "$root" read-tree --reset "$index_tree"

  echo "restored checkpoint: $id"
}

diff_cmd() {
  ensure_repo
  local root; root="$(repo_root)"
  if [[ $# -lt 2 ]]; then
    echo "Usage: checkpointer diff <id1> <id2|current>" >&2
    exit 1
  fi

  local a="$1" b="$2"; shift 2
  local a_obj b_obj

  if git -C "$root" rev-parse -q --verify "refs/conductor-checkpoints/$a" >/dev/null 2>&1; then
    a_obj="refs/conductor-checkpoints/$a"
  else
    die "unknown checkpoint: $a"
  fi

  if [[ "$b" == "current" ]]; then
    local tmp_dir tmp_index
    tmp_dir="$(mktemp -d -t chkpt-cur.XXXXXX)"
    trap 'rm -rf "$tmp_dir"' EXIT
    tmp_index="$tmp_dir/index"
    local head_oid
    if head_oid="$(git -C "$root" rev-parse -q --verify HEAD 2>/dev/null)"; then
      GIT_INDEX_FILE="$tmp_index" git -C "$root" read-tree "$head_oid"
    fi
    GIT_INDEX_FILE="$tmp_index" git -C "$root" add -A -- .
    b_obj="$(GIT_INDEX_FILE="$tmp_index" git -C "$root" write-tree)"
    rm -rf "$tmp_dir"; trap - EXIT
  else
    if git -C "$root" rev-parse -q --verify "refs/conductor-checkpoints/$b" >/dev/null 2>&1; then
      b_obj="refs/conductor-checkpoints/$b"
    else
      die "unknown checkpoint or 'current' expected: $b"
    fi
  fi

  if [[ $# -gt 0 && "$1" == "--" ]]; then shift; fi
  git -C "$root" diff "$a_obj" "$b_obj" "$@"
}

main() {
  local cmd="${1:-}"; shift || true
  case "$cmd" in
    save) save "$@" ;;
    restore) restore "$@" ;;
    diff) diff_cmd "$@" ;;
    ""|-h|--help|help) usage ;;
    *) die "unknown command: $cmd" ;;
  esac
}

main "$@"
```

---

## spotlighter.sh

Live file sync using watchexec. Watches a directory and syncs changes to `CONDUCTOR_ROOT_PATH`.

### Environment Variables

| Variable | Description |
|----------|-------------|
| `CONDUCTOR_INT_CHECKPOINTER_PATH` | Path to checkpointer.sh |
| `CONDUCTOR_INT_WATCHEXEC_PATH` | Path to watchexec binary |
| `CONDUCTOR_ROOT_PATH` | Target directory to sync to |

### How it works

1. Watches current directory with watchexec
2. On file change:
   - Saves checkpoint with `--force`
   - Restores checkpoint in `CONDUCTOR_ROOT_PATH`
3. Logs trigger info (which file changed)
4. Handles merge/rebase gracefully (skips with exit 101)

### Full script

```bash
#!/usr/bin/env bash
set -euo pipefail

SPOTLIGHT_LOG_FILE="/tmp/conductor-spotlight-$$.log"
echo "Spotlight logging to: $SPOTLIGHT_LOG_FILE"
exec > >(tee -a "$SPOTLIGHT_LOG_FILE") 2>&1

: "${CONDUCTOR_INT_CHECKPOINTER_PATH:?must be set}"
CHECKPOINTER="$CONDUCTOR_INT_CHECKPOINTER_PATH"

: "${CONDUCTOR_INT_WATCHEXEC_PATH:?must be set}"
WATCHEXEC="$CONDUCTOR_INT_WATCHEXEC_PATH"

: "${CONDUCTOR_ROOT_PATH:?must be set}"

checkpoint_suffix="${EPOCHSECONDS:-$(date +%s)}-$$"
CHECKPOINT_ID="cp-spotlight-${checkpoint_suffix}"

export CHECKPOINTER CONDUCTOR_ROOT_PATH CHECKPOINT_ID

runner_script=$(cat <<'EOS'
set -euo pipefail

echo -e "\nStarting sync..."

# Log trigger info
if [[ -n "${WATCHEXEC_WRITTEN_PATH:-}" ]]; then
  echo "Triggered by file write: $WATCHEXEC_WRITTEN_PATH"
fi

# Save checkpoint
"$CHECKPOINTER" save --id "$CHECKPOINT_ID" --force >/dev/null || {
  exit_code=$?
  if [[ $exit_code -eq 101 ]]; then
    echo "Skipping sync: merge/rebase in progress"
  else
    echo "Skipping sync: checkpoint save failed"
  fi
  exit 0
}
echo "Saved checkpoint: ${CHECKPOINT_ID}"

# Restore in target directory
if ! (cd "$CONDUCTOR_ROOT_PATH" && "$CHECKPOINTER" restore "$CHECKPOINT_ID" 2>&1); then
  echo "Warning: checkpoint restore failed in ${CONDUCTOR_ROOT_PATH}"
  exit 0
fi
echo "Restored checkpoint ${CHECKPOINT_ID} in ${CONDUCTOR_ROOT_PATH}"
EOS
)

exec "$WATCHEXEC" \
  --quiet \
  --color=never \
  --shell=none \
  --watch . \
  --project-origin . \
  --emit-events-to=environment \
  --ignore '*.tmp.*' \
  --ignore '.context/**' \
  -- bash -c "$runner_script"
```
