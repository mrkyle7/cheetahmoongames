#!/usr/bin/env bash
# Create a GitHub repo for a new cheetahmoongames.com game from the skeleton in
# scripts/game-template: a tiny Node server, Dockerfile, the deploy workflow
# pre-filled with the game's names, and a CLAUDE.md that points future Claude
# sessions at ADDING_A_GAME.md.
#
#   scripts/new-game.sh snap
#   scripts/new-game.sh snap --title "Snap!" --public
#   scripts/new-game.sh snap --no-github        # just write the skeleton to ./snap
#
# Needs git, and the GitHub CLI (gh) signed in, unless --no-github.
# It doesn't touch Google Cloud or this repo: adding the game's games.tf entry
# is a separate pull request here (the script prints it for you).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TEMPLATE_DIR="$SCRIPT_DIR/game-template"
GAMES_TF="$REPO_ROOT/terraform/games.tf"

usage() {
  cat <<'USAGE'
Usage: scripts/new-game.sh <name> [options]

  <name>              Service, registry and repo name: lower case letters, digits
                      and hyphens, starting with a letter, at most 23 characters.

Options:
  --title "Title"     Display name (default: from <name>, e.g. snap-attack → Snap Attack).
                      Letters, digits, spaces and ' ! ? . , & - only.
  --subdomain <sub>   Serve at <sub>.cheetahmoongames.com (default: <name>).
  --owner <owner>     GitHub owner for the new repo (default: mrkyle7).
  --public            Create a public repo (default: private).
  --dir <path>        Where to put the local checkout (default: ./<name>).
  --no-github         Only write the skeleton locally; don't create a GitHub repo.
  -h, --help          Show this help.
USAGE
}

die() { echo "error: $*" >&2; exit 1; }

NAME=""
TITLE=""
SUBDOMAIN=""
OWNER="mrkyle7"
VISIBILITY="--private"
DIR=""
GITHUB=1

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --title) [ $# -ge 2 ] || die "--title needs a value"; TITLE="$2"; shift 2 ;;
    --subdomain) [ $# -ge 2 ] || die "--subdomain needs a value"; SUBDOMAIN="$2"; shift 2 ;;
    --owner) [ $# -ge 2 ] || die "--owner needs a value"; OWNER="$2"; shift 2 ;;
    --dir) [ $# -ge 2 ] || die "--dir needs a value"; DIR="$2"; shift 2 ;;
    --public) VISIBILITY="--public"; shift ;;
    --no-github) GITHUB=0; shift ;;
    -*) usage >&2; die "unknown option $1" ;;
    *) [ -z "$NAME" ] || die "only one name, got '$NAME' and '$1'"; NAME="$1"; shift ;;
  esac
done

[ -n "$NAME" ] || { usage >&2; exit 1; }
SUBDOMAIN="${SUBDOMAIN:-$NAME}"
DIR="${DIR:-./$NAME}"
if [ -z "$TITLE" ]; then
  TITLE="$(echo "$NAME" | tr '-' ' ' | awk '{ for (i = 1; i <= NF; i++) $i = toupper(substr($i, 1, 1)) substr($i, 2); print }')"
fi

# --- Checks ----------------------------------------------------------------------

# Accounts are named <name>-run and <name>-deploy; Google caps account IDs at 30.
[[ "$NAME" =~ ^[a-z]([a-z0-9-]{0,21}[a-z0-9])?$ ]] \
  || die "name '$NAME' must be lower case letters, digits and hyphens, start with a letter, not end with a hyphen, and be at most 23 characters"
[[ "$SUBDOMAIN" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] \
  || die "subdomain '$SUBDOMAIN' must be lower case letters, digits and hyphens"
# The title lands in HTML, JSON, YAML and sed; keep it to characters safe in all.
[[ "$TITLE" =~ ^[A-Za-z0-9][A-Za-z0-9\ \'\!\?\.\,\&-]*$ ]] \
  || die "title '$TITLE' may only use letters, digits, spaces and ' ! ? . , & -"

case "$SUBDOMAIN" in
  www|bartenders|cheetahmoongames) die "subdomain '$SUBDOMAIN' is reserved" ;;
esac
if [ -f "$GAMES_TF" ]; then
  if grep -Eq "^[[:space:]]*name[[:space:]]*=[[:space:]]*\"$NAME\"" "$GAMES_TF"; then
    die "a game named '$NAME' is already in terraform/games.tf"
  fi
  if grep -Eq "^[[:space:]]*subdomain[[:space:]]*=[[:space:]]*\"$SUBDOMAIN\"" "$GAMES_TF"; then
    die "subdomain '$SUBDOMAIN' is already used in terraform/games.tf"
  fi
fi

[ -d "$TEMPLATE_DIR" ] || die "template not found at $TEMPLATE_DIR"
[ ! -e "$DIR" ] || die "$DIR already exists"
command -v git >/dev/null || die "git is not installed"

if [ "$GITHUB" -eq 1 ]; then
  command -v gh >/dev/null || die "the GitHub CLI (gh) is not installed: https://cli.github.com (or use --no-github)"
  gh auth status >/dev/null 2>&1 || die "gh is not signed in: run 'gh auth login'"
  if gh repo view "$OWNER/$NAME" >/dev/null 2>&1; then
    die "github.com/$OWNER/$NAME already exists"
  fi
fi

# --- Write the skeleton ----------------------------------------------------------

sed_escape() { printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'; }

mkdir -p "$DIR"
cp -R "$TEMPLATE_DIR/." "$DIR/"
# Stored without the dot so it doesn't apply inside this repo.
mv "$DIR/gitignore" "$DIR/.gitignore"

T_NAME="$(sed_escape "$NAME")"
T_TITLE="$(sed_escape "$TITLE")"
T_SUB="$(sed_escape "$SUBDOMAIN")"
T_OWNER="$(sed_escape "$OWNER")"
find "$DIR" -type f -print0 | while IFS= read -r -d '' f; do
  sed -i.bak \
    -e "s|__NAME__|$T_NAME|g" \
    -e "s|__TITLE__|$T_TITLE|g" \
    -e "s|__SUBDOMAIN__|$T_SUB|g" \
    -e "s|__OWNER__|$T_OWNER|g" \
    "$f"
  rm -f "$f.bak"
done

if grep -rEq "__[A-Z]+__" "$DIR"; then
  grep -rEn "__[A-Z]+__" "$DIR" >&2
  die "unfilled placeholders left in the skeleton (above)"
fi

echo "Wrote the skeleton for $TITLE to $DIR"

# --- Create the repo -------------------------------------------------------------

if [ "$GITHUB" -eq 1 ]; then
  (
    cd "$DIR"
    git init -q -b main
    git add -A
    git commit -q -m "Start $TITLE from the cheetahmoongames skeleton"
    gh repo create "$OWNER/$NAME" "$VISIBILITY" \
      --description "$TITLE, a game on cheetahmoongames.com" \
      --source . --remote origin --push
  )
  echo "Created https://github.com/$OWNER/$NAME"
fi

# --- Next steps ------------------------------------------------------------------

cat <<NEXT

Next steps (details in ADDING_A_GAME.md):

1. In this repo (cheetahmoongames), on a branch, add the game to local.games in
   terraform/games.tf:

    $NAME = {
      name        = "$NAME"
      subdomain   = "$SUBDOMAIN"
      github_repo = "$OWNER/$NAME"
    }

   and a card to site/public/index.html. Open a pull request, check its plan
   only adds resources, and merge it.

2. Once that merge's Deploy run has applied, turn on deploys for the game:

    gh variable set DEPLOY_ENABLED --body true -R $OWNER/$NAME

   then push to main (or re-run its CI/CD workflow) to deploy.

3. https://$SUBDOMAIN.cheetahmoongames.com works once its certificate is issued,
   usually 15-60 minutes after the DNS record appears.

To build the game with Claude, open a session in $DIR: its CLAUDE.md points
there to ADDING_A_GAME.md and has the checklist for getting it live.
NEXT
