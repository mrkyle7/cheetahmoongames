# Adding a game to cheetahmoongames.com

Each game lives in its own GitHub repo and runs as its own Cloud Run service at `<name>.cheetahmoongames.com`, like [The Boxer](https://github.com/mrkyle7/the-boxer). Adding one takes two pull requests:

1. **This repo** creates the game's place on the site: its Cloud Run service, subdomain, DNS record, permission for its repo to deploy, and a card on the home page.
2. **The game's repo** gets a workflow that builds and deploys the game there.

The example below adds a game called **Snap** at `snap.cheetahmoongames.com` from the repo `mrkyle7/snap`.

## 1. Get the game ready to run on Cloud Run

The game's repo needs a `Dockerfile` whose container:

- **listens on the port in the `PORT` environment variable.** Cloud Run sets it to `8080`.
- **serves the game at `/`.** It gets the whole subdomain.
- **keeps nothing important on local disk,** which is wiped whenever the instance restarts.

The Boxer's [`Dockerfile`](https://github.com/mrkyle7/the-boxer/blob/main/Dockerfile) is a good starting point for a Node game.

Check it locally before going further:

```sh
docker build -t snap .
docker run -p 8080:8080 snap      # then open http://localhost:8080
```

## 2. Add the game in this repo

On a branch in this repo:

### Add it to `terraform/games.tf`

Add an entry to `local.games`:

```hcl
locals {
  games = {
    boxer = { ... }

    snap = {
      name        = "snap"              # Cloud Run service name and image name
      subdomain   = "snap"              # → snap.cheetahmoongames.com
      github_repo = "mrkyle7/snap"      # the repo allowed to deploy it
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

**Naming rules:**
- `name` must be 26 characters or fewer: the service account is called `<name>-run`, and Google caps those at 30.
- `name` must be lower case with hyphens and no other punctuation.
- `subdomain` must not already be in use.

### Add a card to `site/public/index.html`

Copy one of the `<a class="game ...">` blocks in the `games` section and change:
- the link
- the `aria-label`
- the title and description
- the artwork

Put any image in `site/public/assets/` and reference it as `/assets/<file>`. Keep images small, around 100 KB. The page's tests check that every `/assets/` file it references exists.

For the button colour, add a rule next to `.bartenders .play` and `.boxer .play`. Make sure white text on it reaches 4.5:1 contrast.

### Open the pull request

The workflow posts the Terraform plan in the run's summary. For a new game, it should only **add** resources:
- `module.game["snap"]`: its service account, Cloud Run service, public access, domain mapping, DNS record and deploy permission
- an update to `google_iam_workload_identity_pool_provider.github` to allow the new repo

Merge it. CI applies the plan and redeploys the home page with the new card. The new service starts out showing Google's "hello" placeholder until the game's repo deploys its real image.

## 3. Add a deploy workflow to the game's repo

Copy The Boxer's [`.github/workflows/ci-cd.yml`](https://github.com/mrkyle7/the-boxer/blob/main/.github/workflows/ci-cd.yml) into the game's repo and change two lines:

```yaml
env:
  IMAGE_NAME: snap      # the `name` from games.tf
  SERVICE_NAME: snap    # the `name` from games.tf
```

Leave `PROJECT_ID`, `REGION`, `REPOSITORY`, `WIF_PROVIDER` and `CI_SERVICE_ACCOUNT` as they are. Every game deploys through the same account; the entry in `games.tf` is what lets this repo use it. No secrets or keys are needed in the game's repo.

Then change the `test` job to run the game's own tests. It must also check that the container starts: the Boxer version runs the image and looks for its page title.

On merge, the workflow:
1. builds the image and pushes it to `us-east1-docker.pkg.dev/bartenders-464918/docker-us/snap`
2. deploys it
3. checks the live service serves the page
4. rolls back if the deploy fails

## 4. Wait for HTTPS

Google issues the new subdomain's certificate once the DNS record exists, usually within 15–60 minutes. Check with:

```sh
gcloud beta run domain-mappings describe --domain snap.cheetahmoongames.com \
  --region us-east1 --project bartenders-464918 --format='yaml(status.conditions)'
```

It's live when `Ready` is `True`. Until then the address won't load over HTTPS. The domain tells browsers to use HTTPS on every subdomain, so plain HTTP won't work either.

## Things to know

- **Login cookie.** Bartenders' login cookie is shared across `cheetahmoongames.com`, so browsers send it to every game's subdomain. Don't log it, store it or pass it on. If a game ever needs to know who a player is, ask Bartenders' API for it instead of reading the token.
- **Games that need secrets or a database.** The `game` module only covers plain settings. For Secret Manager secrets, a database or other extra infrastructure, add them in a file of their own, as `terraform/bartenders.tf` does for Bartenders, and grant the game's service account access there. The account is `<name>-run@bartenders-464918.iam.gserviceaccount.com`.
- **Removing a game.** Delete its entry in `games.tf` and its card. The plan will delete its service, subdomain and DNS record, so the merge run refuses to apply it. Run the workflow by hand (Actions → Deploy → Run workflow) with **allow_destroy** ticked. The game's images stay in the registry until its cleanup rules remove them.
- **Renaming a game** (`name` or `subdomain`) replaces its service or domain mapping, which also needs **allow_destroy**. A new subdomain gets a new certificate, so expect a gap while it's issued.

## If something goes wrong

- **"Permission denied" or "unable to acquire impersonated credentials" in the game's deploy:**
  - This repo's pull request isn't merged and applied yet.
  - Or `github_repo` in `games.tf` doesn't match the repo exactly (`owner/name`).
- **The deploy succeeds but the subdomain still shows the placeholder:**
  - `SERVICE_NAME` in the game's workflow probably doesn't match `name` in `games.tf`. `gcloud run deploy` then creates a separate service with no subdomain instead of failing.
  - Fix the name, then delete the stray service in the Cloud Run console.
- **The merge run fails at "Refuse deletions unless allowed":**
  - The plan deletes or replaces something. Read the list it prints. If that's intended, re-run by hand with **allow_destroy**; if not, fix the change.
- **The certificate stays pending for hours:**
  - The `describe` command above says why.
  - Check `dig +short snap.cheetahmoongames.com CNAME` returns `ghs.googlehosted.com.`
