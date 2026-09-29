# Adding a game to cheetahmoongames.com

Each game lives in its own GitHub repo and runs as its own Cloud Run service at `<subdomain>.cheetahmoongames.com`, like [The Boxer](https://github.com/mrkyle7/the-boxer). Adding one takes four steps:

1. **Create the game's repo** with `scripts/new-game.sh`. You get a working skeleton with the deploy workflow already filled in.
2. **Add the game in this repo:** an entry in `terraform/games.tf` and a card on the home page, in one pull request. Merging it creates the game's Cloud Run service, image registry, subdomain, DNS record, and its IAM permissions.
3. **Turn on deploys** in the game's repo, once step 2 is applied.
4. **Wait for HTTPS** on the new subdomain.

The example adds a game called **Snap** at `snap.cheetahmoongames.com` from the repo `mrkyle7/snap`.

> **Before the first game added this way:** `github-terraform` must be a verified owner of `cheetahmoongames.com`, or step 2's apply fails with "Caller is not authorized to administer the domain". It's a one-time step; see "Domain ownership" under [Set up by hand](README.md#set-up-by-hand) in the README.

## 1. Create the game's repo

From this repo, with the [GitHub CLI](https://cli.github.com) signed in (`gh auth login`):

```sh
scripts/new-game.sh snap --title "Snap"
```

This creates the private repo `mrkyle7/snap`, pushes a skeleton to `main`, and leaves a checkout in `./snap`. Options:

| Option | Default | |
| --- | --- | --- |
| `--title "Snap!"` | from the name, e.g. `snap-attack` → `Snap Attack` | Display name. Letters, digits, spaces and `' ! ? . , & -`. |
| `--subdomain snappy` | the name | Serve at `snappy.cheetahmoongames.com` instead. |
| `--public` | private | Create a public repo. |
| `--owner someone` | `mrkyle7` | GitHub owner for the repo. |
| `--dir path` | `./<name>` | Where to put the local checkout. |
| `--no-github` | | Only write the skeleton locally, to look at it or build on it. |

**Naming rules,** which the script checks:
- The name must be at most 23 characters: Google caps account IDs at 30, and the game gets `<name>-run` and `<name>-deploy`.
- The name must be lower case letters, digits and hyphens, starting with a letter.
- The name and subdomain mustn't already be in `terraform/games.tf`.
- `www` and `bartenders` are reserved subdomains.

The skeleton, from `scripts/game-template/`:

| File | What it is |
| --- | --- |
| `server.js`, `public/index.html` | A dependency-free Node server showing a "coming soon" page. It listens on `PORT` and serves `/`, `/healthz` and `/api/me` (who's signed in). |
| `auth.js` | Tells the game who's playing, from the shared Cheetah Moon sign-in. See [Players and signing in](#players-and-signing-in). |
| `test/` | Its tests (`npm test`) |
| `Dockerfile` | The container Cloud Run runs |
| `.github/workflows/ci-cd.yml` | Tests and a container smoke test on every push. Deploys on `main` once turned on (step 3). Every name in it is already set for the game. |
| `CLAUDE.md` | For future Claude sessions in that repo: read this file first, then follow the checklist for getting the game live and the rules the game must keep |

Whatever the game becomes, its container must:
- **listen on the port in `PORT`.** Cloud Run sets it to 8080.
- **serve the game at `/`.** It gets the whole subdomain.
- **keep nothing important on local disk,** which is wiped whenever the instance restarts.

## 2. Add the game in this repo

On a branch in this repo:

### Add it to `terraform/games.tf`

The script prints this for you. Add it to `local.games`:

```hcl
locals {
  games = {
    boxer = { ... }

    snap = {
      name        = "snap"              # service, registry, image and account names
      subdomain   = "snap"              # → snap.cheetahmoongames.com
      github_repo = "mrkyle7/snap"      # the only repo allowed to deploy it
    }
  }
}
```

Those three fields are all a simple game needs. The optional ones:

| Field | Default | When to change it |
| --- | --- | --- |
| `max_instances` | `3` | Set to `1` if players must meet on the same server, e.g. rooms kept in memory like The Boxer's. |
| `min_instances` | `0` | Set to `1` to avoid a few seconds' cold start on the first visit, at the cost of paying for an always-on instance. |
| `timeout` | Cloud Run's 300s | Raise to `"3600s"` for WebSocket games so a whole game fits in one connection. |
| `session_affinity` | `false` | `true` sends a returning player to the same instance when there's more than one. |
| `concurrency` | Cloud Run's 80 | How many requests or open WebSockets one instance takes at once. Raise it (The Boxer uses `1000`) for WebSocket games. |
| `cpu` / `memory` | `"1"` / `"512Mi"` | For heavier games. |
| `env` | none | Plain settings for the container, e.g. `env = { MAX_PLAYERS = "6" }`. Don't put secrets here; see below. |
| `deploy_branches` | `["main"]` | Branches whose workflows may deploy. Change it only if the game's repo deploys from another branch, e.g. `["master"]`. |

### Add a card to `site/public/index.html`

Copy one of the `<a class="game ...">` blocks in the `games` section and change:
- the link
- the `aria-label`
- the title and description
- the artwork

Put any image in `site/public/assets/` and reference it as `/assets/<file>`. Keep images small, around 100 KB. The page's tests check that every `/assets/` file it references exists.

For the button colour, add a rule next to `.bartenders .play` and `.boxer .play`. Make sure white text on it reaches 4.5:1 contrast.

### What IAM the new game gets

Every game needs its own permissions: nothing is shared with other games, and the game's repo can only ever touch its own service. The `games.tf` entry creates all of them, so there's nothing to grant by hand.

- **`snap-run`**, the account the game runs as:
  - read access to its own image registry
- **`snap-deploy`**, the account the game's workflow deploys as:
  - usable only by jobs on `main` of `mrkyle7/snap`. Google Cloud checks this against GitHub's signed token, so a pull request that edits the workflow can't use it.
  - `roles/run.developer` on the `snap` service only: deploy new revisions of it and nothing else
  - permission to run revisions as `snap-run`
  - write access to its own image registry, `snap`, so it can't overwrite another game's images
  - `roles/run.viewer` on the project: read-only, so its rollback step can list revisions
- **The GitHub sign-in rule** is updated to accept tokens from `mrkyle7/snap`. That's the one shared resource that changes.

If the game needs anything more, such as secrets, a database or storage, add it in its own Terraform file here and grant `snap-run` (or `snap-deploy`) access there; see "Things to know" below.

### Open the pull request

The workflow posts the Terraform plan in the run's summary. For a new game it should only **add** 13 resources under `module.game["snap"]`:
- the two accounts
- the image registry
- the service and its public access
- the domain mapping and DNS record
- the IAM bindings listed above

It should also **update** `google_iam_workload_identity_pool_provider.github` to allow the new repo. Nothing else should change.

Merge it. CI applies the plan and redeploys the home page with the new card. The new service shows Google's "hello" placeholder until step 3.

## 3. Turn on deploys

The skeleton's deploy job is skipped until the repo variable `DEPLOY_ENABLED` is `true`. Before step 2 is applied, the deploy account doesn't exist, so deploying would only fail. Once the merge's Deploy run here has succeeded:

```sh
gh variable set DEPLOY_ENABLED --body true -R mrkyle7/snap
```

Then push to `main`, or re-run the game's latest CI/CD run. On `main` the workflow:
1. builds the image and pushes it to `us-east1-docker.pkg.dev/bartenders-464918/snap/snap`
2. deploys it
3. checks the service serves the page (it looks for `PAGE_MARKER`, the title by default)
4. rolls back if the deploy fails

## 4. Wait for HTTPS

Google issues the new subdomain's certificate once the DNS record exists, usually within 15–60 minutes. Check with:

```sh
gcloud beta run domain-mappings describe --domain snap.cheetahmoongames.com \
  --region us-east1 --project bartenders-464918 --format='yaml(status.conditions)'
```

It's live when `Ready` is `True`. Until then the address won't load over HTTPS. The domain tells browsers to use HTTPS on every subdomain, so plain HTTP won't work either.

## Building the game with Claude

Open a Claude session in the game's repo. Its `CLAUDE.md` tells Claude to read this file first, and has:
- the checklist for getting the game live, so a session can see which of the steps above are done
- the rules the game must keep: `PORT`, serving at `/`, no local state, leaving the workflow's names alone, keeping `PAGE_MARKER` current, and knowing players only through `auth.js`

## Players and signing in

Players have one Cheetah Moon account for every game. They sign in or create it at **https://cheetahmoongames.com/login**, and games never ask for names or passwords themselves.

- **Where accounts live.** The accounts are Bartenders of Corfu's (its users table in Supabase). The home page's `/login` page and `/api/account/*` routes (`site/account.js`) pass sign-in, sign-up and sign-out on to Bartenders, server to server. Bartenders' own `/login` redirects to the home page (its `LOGIN_URL`, set in `terraform/bartenders.tf`).
- **The cookie.** Signing in sets `userjwt` for the whole of `cheetahmoongames.com`, so the browser sends it to every game. It's a JWT signed with RS256 by Bartenders; its claims carry the account's id (`id`), name (`sub`) and expiry (`exp`, 7 days).
- **In a game,** `auth.js` checks the cookie's signature with the public key from `https://cheetahmoongames.com/api/account/keys/<kid>` and gives you the player:

  ```js
  const { createAuth } = require('./auth');
  const auth = createAuth();                 // reads ACCOUNTS_URL, which Terraform sets
  const player = await auth.player(req);     // { id, name } or null; works on WebSocket upgrades too
  if (!player) redirect(auth.loginUrl('https://snap.cheetahmoongames.com/'));  // back here after
  ```

  Key players' games and records by `player.id`, not their name: names are for showing. Names can have spaces, so escape them when you put them in HTML.
- **Signing out** happens on the home page (or in Bartenders) and clears the cookie everywhere. A token that was copied before signing out stays valid in games until it expires; Bartenders also checks its own list of sign-outs.
- **Rules:** don't log the cookie, store it or send it anywhere but `auth.js`, and don't build your own sign-in. The browser page can't read the cookie (it's `HttpOnly`); ask your own server, e.g. the skeleton's `/api/me`.
- **Running locally:** cookies on `localhost` are shared between ports. Run Bartenders and the home page locally (`BARTENDERS_URL=http://localhost:8000 npm start` in `site/`), sign in at `http://localhost:8080/login`, and start the game with `ACCOUNTS_URL=http://localhost:8080`. Tests don't need any of that: sign tokens with a throwaway key and pass `fetchKey` to `createAuth` (see the skeleton's `test/auth.test.js`).

## Things to know

- **Games that need secrets or a database.** The `game` module only covers plain settings. For Secret Manager secrets, a database or other extra infrastructure, add them in a file of their own, as `terraform/bartenders.tf` does for Bartenders. The game reads them as `<name>-run@bartenders-464918.iam.gserviceaccount.com`; grant that account access. If the game's workflow also needs to change them, grant `<name>-deploy` access to just those secrets.
- **Removing a game.** Delete its entry in `games.tf` and its card. The plan will delete its service, subdomain and DNS record, so the merge run refuses to apply it. Run the workflow by hand (Actions → Deploy → Run workflow) with **allow_destroy** ticked. This also deletes the game's image registry and every image in it. Archive or delete its repo separately.
- **Renaming a game** (`name` or `subdomain`) replaces its service or domain mapping, which also needs **allow_destroy**. A new subdomain gets a new certificate, so expect a gap while it's issued.
- **Changing the skeleton.** Edit `scripts/game-template/`. Every pull request here generates a test game from it and runs that game's tests and container, so a broken template shows up before merging. Existing games don't change; update them by hand if they need the fix.

## If something goes wrong

- **The merge run here fails with "Caller is not authorized to administer the domain":**
  - `github-terraform` isn't a verified owner of `cheetahmoongames.com`. Add it (README → Set up by hand → Domain ownership), then re-run the failed jobs.
- **The game's deploy job is skipped:**
  - `DEPLOY_ENABLED` isn't set to `true` in the game's repo (step 3).
  - Or the run isn't a push to `main`. Pull requests never deploy.
- **"Permission denied" or "unable to acquire impersonated credentials" at sign-in:**
  - This repo's pull request isn't merged and applied yet.
  - Or `github_repo` in `games.tf` doesn't match the repo exactly (`owner/name`).
  - Or `SERVICE_ACCOUNT` names another game's account.
  - Or the job isn't running on a branch in `deploy_branches` (default `main`). That's by design for pull requests; for a real deploy branch, add it to the game's entry.
- **"Permission denied" on push or deploy:**
  - `REPOSITORY`, `SERVICE_NAME` or `SERVICE_ACCOUNT` in the game's workflow probably doesn't match `name` in `games.tf`. The deploy account can only push to its own registry and deploy its own service.
- **The smoke test fails but the page looks fine:**
  - The page no longer shows `PAGE_MARKER`. Update it in the game's `.github/workflows/ci-cd.yml`.
- **The merge run here fails at "Refuse deletions unless allowed":**
  - The plan deletes or replaces something. Read the list it prints. If that's intended, re-run by hand with **allow_destroy**; if not, fix the change.
- **The certificate stays pending for hours:**
  - The `describe` command above says why.
  - Check `dig +short snap.cheetahmoongames.com CNAME` returns `ghs.googlehosted.com.`
