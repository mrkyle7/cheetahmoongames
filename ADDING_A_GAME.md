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

This creates the private repo `mrkyle7/snap`, pushes a skeleton to `main`, and leaves a checkout in `./snap`. It first checks your checkout of this repo is up to date with `origin/master`, so the game starts from the current skeleton; `git pull` if it says it's behind. Options:

| Option | Default | |
| --- | --- | --- |
| `--title "Snap!"` | from the name, e.g. `snap-attack` → `Snap Attack` | Display name. Letters, digits, spaces and `' ! ? . , & -`. |
| `--subdomain snappy` | the name | Serve at `snappy.cheetahmoongames.com` instead. |
| `--public` | private | Create a public repo. |
| `--owner someone` | `mrkyle7` | GitHub owner for the repo. |
| `--dir path` | `./<name>` | Where to put the local checkout. |
| `--no-github` | | Only write the skeleton locally, to look at it or build on it. |
| `--allow-stale` | | Skip the up-to-date check, e.g. when offline. |

**Naming rules,** which the script checks:
- The name must be at most 23 characters: Google caps account IDs at 30, and the game gets `<name>-run` and `<name>-deploy`.
- The name must be lower case letters, digits and hyphens, starting with a letter.
- The name and subdomain mustn't already be in `terraform/games.tf`.
- `www` and `bartenders` are reserved subdomains.

The skeleton, from `scripts/game-template/`:

| File | What it is |
| --- | --- |
| `server.js`, `public/index.html` | A dependency-free Node server showing a "coming soon" page, with a bar linking back to cheetahmoongames.com and showing who's signed in. It listens on `PORT` and serves `/`, `/healthz` and `/api/me` (who's signed in). |
| `public/icon.svg`, `public/icons/`, `public/manifest.webmanifest`, `public/sw.js`, `public/offline.html` | The favicon, app icons, and what makes the game installable. The placeholder icon is the game's initial under the Cheetah Moon. See [Icons and installing](#icons-and-installing). |
| `auth.js` | Tells the game who's playing, from the shared Cheetah Moon sign-in. See [Players and signing in](#players-and-signing-in). |
| `test/` | Its tests (`npm test`) |
| `Dockerfile` | The container Cloud Run runs |
| `.github/workflows/ci-cd.yml` | Tests and a container smoke test on every push. Deploys on `main` once turned on (step 3). Every name in it is already set for the game. |
| `CLAUDE.md` | For future Claude sessions in that repo: read this file first, then follow the checklist for getting the game live and the rules the game must keep |

Whatever the game becomes, its container must:
- **listen on the port in `PORT`.** Cloud Run sets it to 8080.
- **serve the game at `/`.** It gets the whole subdomain.
- **keep nothing important on local disk,** which is wiped whenever the instance restarts.

And every game on the site has these, which the skeleton starts you with. Keep them as the game grows:
- **The shared sign-in.** Players use their Cheetah Moon account, through `auth.js`, and the game shows who's signed in or links to sign in. Never build a sign-in, sign-up or password reset of your own: `cheetahmoongames.com/login` does all three. See [Players and signing in](#players-and-signing-in).
- **A link back to cheetahmoongames.com** on the game's main page, like "← Cheetah Moon Games" in the skeleton's top bar, The Boxer's lobby and Bezique's header.
- **Its own icons:** a favicon and app icons in the game's own style, replacing the placeholder, plus card art on the home page. See [Icons and installing](#icons-and-installing).
- **Installable as an app** on phones and desktops: a web app manifest and a service worker. See [Icons and installing](#icons-and-installing).

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
| `secrets` | none | Settings that are secret, e.g. `["SUPABASE_URL", "SUPABASE_KEY"]`. See [Games that need secrets or a database](#games-that-need-secrets-or-a-database). |
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

Open a Claude session in the game's repo. Its `CLAUDE.md` tells Claude to read all of this file before any work, and has:
- the checklist for getting the game live, so a session can see which of the steps above are done
- the rules the game must keep: `PORT`, serving at `/`, no local state, leaving the workflow's names alone, keeping `PAGE_MARKER` current, and knowing players only through `auth.js`

## Icons and installing

Players can install every game from the browser (Add to Home Screen on phones, the install button in desktop Chrome and Edge), and it opens full screen like an app. The skeleton has everything this needs:

| File | What it's for |
| --- | --- |
| `public/icon.svg` | The favicon and the master icon. Starts as the game's initial under the Cheetah Moon; replace it with the game's own art. Keep it simple and bold: it's shown as small as 16 px. |
| `public/icons/icon-192.png`, `icon-512.png` | App icons. Chrome needs a 192 px and a 512 px PNG before it offers to install. |
| `public/icons/icon-maskable-512.png` | The Android home screen icon. Android crops it to a circle or squircle, so the art sits in the middle 70% on a full background. |
| `public/icons/apple-touch-icon.png` | The iPhone and iPad home screen icon (180 px). iOS doesn't use the manifest's icons. |
| `public/manifest.webmanifest` | The app's name, icons and colours; `display: standalone` opens it without the browser's address bar. Keep `theme_color` and `background_color` in step with the game's look, and the `<meta name="theme-color">` in the page too. |
| `public/sw.js`, `public/offline.html` | A service worker, which browsers need before offering to install. It only shows `offline.html` when there's no connection; everything else goes to the server, so deploys show up straight away. |

The PNGs start as a plain Cheetah Moon. Once `icon.svg` is the game's own, render the PNGs from it with the script in this repo (it uses Playwright's Chromium):

```sh
npx -y -p playwright node scripts/render-icons.js ../snap/public/icon.svg ../snap/public/icons
```

Every page of the game should link the favicon, the Apple icon and the manifest, and register the service worker, as `public/index.html` does. Check it in Chrome: DevTools → Application → Manifest shows any problems with installing.

Use the same art for the game's card on the home page (`site/public/index.html`), so players recognise it.

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
- **Forgotten passwords** are handled on the home page too: `/login` has "Forgot your password?", which emails a reset link (see the README).
- **Changing email or password** happens on the home page's `/profile`. Link players there (`https://cheetahmoongames.com/profile`) rather than building an account page in a game.
- **Signing out** happens on the home page (or in Bartenders) and clears the cookie everywhere. A token that was copied before signing out stays valid in games until it expires; Bartenders also checks its own list of sign-outs.
- **Rules:** don't log the cookie, store it or send it anywhere but `auth.js`, and don't build your own sign-in. The browser page can't read the cookie (it's `HttpOnly`); ask your own server, e.g. the skeleton's `/api/me`.
- **Running locally:** cookies on `localhost` are shared between ports. Run Bartenders and the home page locally (`BARTENDERS_URL=http://localhost:8000 npm start` in `site/`), sign in at `http://localhost:8080/login`, and start the game with `ACCOUNTS_URL=http://localhost:8080`. Tests don't need any of that: sign tokens with a throwaway key and pass `fetchKey` to `createAuth` (see the skeleton's `test/auth.test.js`).

## Things to know

- **Games that need secrets or a database.** See [below](#games-that-need-secrets-or-a-database).
- **Notifications** ("it's your turn", even with the game closed). See [Notifications](#notifications): the server makes its own keys, so they need no secrets.
- **Removing a game.** Delete its entry in `games.tf` and its card. The plan will delete its service, subdomain and DNS record, so the merge run refuses to apply it. Run the workflow by hand (Actions → Deploy → Run workflow) with **allow_destroy** ticked. This also deletes the game's image registry and every image in it. Archive or delete its repo separately.
- **Renaming a game** (`name` or `subdomain`) replaces its service or domain mapping, which also needs **allow_destroy**. A new subdomain gets a new certificate, so expect a gap while it's issued.
- **Changing the skeleton.** Edit `scripts/game-template/`. Every pull request here generates a test game from it and runs that game's tests and container, so a broken template shows up before merging. Existing games don't change; update them by hand if they need the fix.

## Games that need secrets or a database

A game that keeps anything beyond one server's life, like saved games or scores, needs a database, and the game's server needs a secret to reach it. [Bezique](https://github.com/mrkyle7/bezique) is the example: its games are saved in a Supabase project of their own.

1. **The database.** Make a Supabase project for the game (one per game, in the same organisation as Bartenders' and Bezique's). Keep its tables in the game's repo as migrations (`supabase/migrations`, made with `supabase init` and `supabase migration new`), so they're reviewed and applied like code.
2. **The secrets,** in this repo's `terraform/games.tf`:

   ```hcl
   snap = {
     ...
     secrets = ["SUPABASE_URL", "SUPABASE_KEY"]
   }
   ```

   For each one the `game` module creates a Secret Manager secret, `snap-supabase-url` and `snap-supabase-key`, and sets it as that environment variable in the game's container. It gives `snap-run` read access, and `snap-deploy` read and add-version access, to those secrets only. Each starts as `not-set`, which the game should treat as "not configured" (Cloud Run can't start a revision whose secret has no value at all).
3. **Filling them in.** Store the real values as GitHub Actions secrets in the game's repo. The game's deploy job copies them into Secret Manager before deploying, and applies the migrations: copy the "Update the database" and "Sync the database secrets to Secret Manager" steps from Bezique's `.github/workflows/ci-cd.yml`. Its `CLAUDE.md` ("Saved games") lists which Supabase values to use.
4. **Testing.** Bezique's CI runs `supabase start` so its tests use a real local database built from the migrations.

Anything that isn't a secret or a Supabase project (a storage bucket, say) is new infrastructure: add it in a file of its own in `terraform/`, as `bartenders.tf` does for Bartenders, and grant `<name>-run` access to just that.

Only one server should write to a game's database at a time. If the game keeps state in memory, like Bezique, keep `max_instances = 1`, and have a starting server take over from the old one cleanly during a deploy. Bezique's `supabase/migrations` and `src/bezique/persistence.js` show one way.

## Notifications

Turn-based games should tell players when it's their move, even with the game closed, with [Web Push](https://developer.mozilla.org/en-US/docs/Web/API/Push_API). Bartenders of Corfu, Bezique and King's Keep all do. Build it this way by default:

- **The keys are made by the server, not set as secrets.** Web Push signs each notification with a key pair (VAPID keys). The first server that needs a pair makes one and saves it in the game's own storage. Every later server reads that pair, so devices keep working across deploys. If two servers start at once, only the first pair saved is kept, and both use it: save with "insert unless one exists", then read back.
  - With a database: a one-row `vapid_keys` table, with row-level security on so only the server's secret key can read it. Bezique (`src/bezique/push.js`, `pushFromStore()`) and Bartenders (`app/push.py`, `get_keys()`) do this.
  - With a bucket and no database: a file such as `config/vapid.json`, written with `ifGenerationMatch=0`. King's Keep does this (`src/push.js`, `vapidKeys()`). Keep any clean-up rule on the bucket away from it.
  - Load the pair when the server starts, not at the first notification, so a problem shows up straight away.
- **Don't put them in Secret Manager.** There's nothing to set up, nothing for a deploy to copy, and no cost: Secret Manager is only free up to six secret versions across the whole project. If a game has keys in Secret Manager from before, have its server save those to its storage when it finds none there. Deploy that, check the pair is saved, then remove the secrets in Terraform (a deletion, so it needs the **allow_destroy** run).
- **Devices** (each browser's subscription: a push service URL and its keys) go in the same storage, keyed by that URL, so a device belongs to whoever turned notifications on there last. Only accept `https` URLs on named hosts, since the server sends to them. Forget a device when its push service answers 404 or 410.
- **The page** subscribes with the server's public key, and subscribes again when that key changes; a subscription made with an old key gets nothing. Bezique's `notifications` in `public/common.js` is the one to copy. Offer it as a "Turn on notifications" button, never on page load. On an iPhone, notifications only work once the game is on the Home Screen.
- **Who's told:** only players who aren't looking. With notifications on, a page closes its live connection while it's hidden, so an open connection means the player is there. Never notify bots. A server that loads saved games treats their state as already told, so a deploy doesn't repeat anything.
- **The service worker** shows each notification, one per game at a time (`tag`), and opens the game when it's tapped. A game page's service worker must still never cache the game itself.

The libraries are `web-push` for Node and `pywebpush` for Python. The packages are the only dependency; nothing in this repo changes for a game to send notifications.

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
