# Cheetah Moon Games

The home page at **https://cheetahmoongames.com** and the Google Cloud setup behind every game on the site.

| Address | What | Code |
| --- | --- | --- |
| `cheetahmoongames.com` | Home page linking to every game | `site/` in this repo |
| `bartenders.cheetahmoongames.com` | Bartenders of Corfu | [mrkyle7/bartenders-of-corfu](https://github.com/mrkyle7/bartenders-of-corfu) |
| `boxer.cheetahmoongames.com` | The Boxer | [mrkyle7/the-boxer](https://github.com/mrkyle7/the-boxer) |
| `bezique.cheetahmoongames.com` | Bezique | [mrkyle7/bezique](https://github.com/mrkyle7/bezique) |

Every game runs as its own Cloud Run service in the `bartenders-464918` project and deploys from its own repo. This repo owns what they share: the Terraform for every service, domain, DNS record and permission, plus the home page.

## Who can do what

GitHub Actions sign in to Google Cloud without keys, through Workload Identity Federation. Each repo, and for this repo each kind of run, can act as exactly one service account:

| Repo | Acts as | Can |
| --- | --- | --- |
| `mrkyle7/cheetahmoongames`, **default branch only** | `github-terraform` | Apply the Terraform: IAM, service accounts, sign-in, DNS, secrets, every service. Also deploys the home page. |
| `mrkyle7/cheetahmoongames`, pull requests and other branches | `github-terraform-plan` | Read only: the project's configuration and IAM (not secret values) and the Terraform state, enough to show a plan |
| `mrkyle7/bartenders-of-corfu`, `main` only | `bartenders-deploy` | Push to the `docker-us` registry, deploy the `bartenders` service, read and update its two Supabase secrets |
| each game's repo, `main` only, e.g. `mrkyle7/the-boxer` | `<name>-deploy` | Push to the game's own registry and deploy the game's own service |

Every deploy account also has read-only access to Cloud Run, so its rollback step can list revisions. It can see other services but can't change them. Each game has its own image registry, because Google only grants registry access per registry, not per image, so a shared one would let any game overwrite another's images.

Everything above is defined in `terraform/github.tf`, `terraform/bartenders.tf` and `terraform/modules/game`.

### Why a pull request can't apply or deploy anything

The branch rule is enforced by Google Cloud, not by the workflow file, so a pull request that rewrites `.github/workflows/deploy.yml` doesn't get around it.
- GitHub signs a token for every job that says which repo, branch (`ref`) and event it's running for.
- Google only lets a job act as `github-terraform` when that token says `mrkyle7/cheetahmoongames` on `refs/heads/master` (or `main`).
- Pull requests run as `refs/pull/<n>/merge` and other branches as their own ref, so they only get the read-only plan account.
- The deploy accounts work the same way: `bartenders-deploy` and each `<name>-deploy` only accept jobs on `main` of their own repo. A pull request to a game repo that edits its workflow can't deploy anything.
- `pull_request_target` runs with the default branch's ref, so it's refused for every repo.

That leaves each repo's default branch as the way in. Anyone who can push or merge to this repo's default branch can apply anything, and to a game repo's `main` can deploy that game. Protect those branches in GitHub (Settings → Branches → add a rule for `master` here, and `main` in each game repo):
- require a pull request with an approving review before merging
- block force pushes and deletions
- tick "Do not allow bypassing the above settings" if others have admin access

## Adding a game

```sh
scripts/new-game.sh snap --title "Snap"
```

creates `mrkyle7/snap` with a skeleton game, ready to deploy, and prints the `games.tf` entry to add here. **[ADDING_A_GAME.md](ADDING_A_GAME.md)** walks through the whole process.

## Layout

```
site/                  the home page: a small Node server with no dependencies
  public/index.html    the page itself, one card per game
  server.js            serves the page; redirects Bartenders' old URLs on this domain
terraform/
  games.tf             the list of games (edit this to add one)
  modules/game/        everything one game needs: service, subdomain, DNS, deploy access
  site.tf              the home page service and the apex domain
  bartenders.tf        Bartenders (it has secrets and a database, so it gets its own file)
  github.tf            GitHub Actions sign-in and the CI service account's roles
  shared.tf            APIs, the data bucket, and docker-us (Bartenders' image registry)
scripts/
  new-game.sh          creates a new game's repo from game-template/
  game-template/       the skeleton: Node server, Dockerfile, deploy workflow, CLAUDE.md
.github/workflows/deploy.yml
```

## How changes ship

`.github/workflows/deploy.yml` runs on every pull request and on merges to the default branch (`main` or `master`).

- **Pull request:**
  - tests the home page
  - generates a game with `scripts/new-game.sh` and runs its tests, so the skeleton can't quietly break
  - checks Terraform formatting and validity
  - posts the Terraform plan in the run's summary (Actions → the run → Summary). Read it before merging.
- **Merge:** applies the Terraform, then builds `site/`, deploys it to the `cheetahmoongames` Cloud Run service and checks it's live. A failed deploy rolls back to the last healthy revision.

The workflow won't apply a plan that **deletes or replaces** anything; removing a game or re-creating a domain mapping, for example. In that case the run fails and says what it would delete. To go ahead, run the workflow by hand (Actions → Deploy → Run workflow) with **allow_destroy** ticked.

## The home page

```sh
cd site
npm test
BARTENDERS_URL=https://bartenders.cheetahmoongames.com npm start   # http://localhost:8080
```

Besides the page, the server handles traffic for Bartenders, which used to live on this domain:

- Every path other than `/`, `/assets/*`, `/sw.js` and `/healthz` redirects (307) to the same path on `BARTENDERS_URL`, so old game links, bookmarks and push notifications keep working.
- `/sw.js` serves a service worker that unregisters itself, which clears out the one Bartenders installed on this domain.
- A Bartenders login cookie from before the move only belongs to this domain. The server moves it onto `COOKIE_DOMAIN` (the whole of `cheetahmoongames.com`), so players stay logged in when they follow a link to the game.

## Working with the Terraform locally

State lives in the `gs://bartenders-464918-tfstate` bucket, so local runs and CI share it. You need to be signed in to Google Cloud as someone with access to the project:

```sh
gcloud auth application-default login
cd terraform
terraform init
terraform plan
```

Prefer letting CI apply changes. If you do apply by hand, commit the same change here straight after, or the next CI run will undo it.

## Set up by hand

Almost everything is in Terraform. These few things aren't, because Terraform needs them before it can run. If the project is ever rebuilt, recreate them first:

- **`github-terraform` service account.** Terraform manages its roles and who can use it (`terraform/github.tf`), but not the account itself.
- **State bucket** `gs://bartenders-464918-tfstate`, versioned:

  ```sh
  gcloud storage buckets create gs://bartenders-464918-tfstate \
    --project=bartenders-464918 --location=us-east1 --uniform-bucket-level-access
  gcloud storage buckets update gs://bartenders-464918-tfstate --versioning
  ```

- **Two APIs** Terraform needs before it can read anything. Service accounts bill API calls to this project, so CI fails without them even if your own `gcloud` login works. `terraform/shared.tf` keeps them, and the other APIs the setup uses, switched on after that.

  ```sh
  gcloud services enable cloudresourcemanager.googleapis.com serviceusage.googleapis.com \
    --project bartenders-464918
  ```

- **Cloud DNS zone** `cheetahmoongames-com`. Terraform adds records to it but doesn't own it.
- **Domain ownership.** `cheetahmoongames.com` is verified in [Google Search Console](https://search.google.com/search-console). Cloud Run only lets a verified owner of the domain create domain mappings, so `github-terraform` must be an **owner** of that property. Without it, adding a game fails at apply with "Caller is not authorized to administer the domain". To add it, signed in as the account that verified the domain:
  1. Open the domain's owner page: <https://www.google.com/webmasters/verification/details?domain=cheetahmoongames.com>. From Search Console, it's Settings → Users and permissions → ⋮ next to your name → Manage property owners.
  2. Choose **Add an owner** and enter `github-terraform@bartenders-464918.iam.gserviceaccount.com`.
