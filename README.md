# Cheetah Moon Games

The home page at **https://cheetahmoongames.com** and the Google Cloud setup behind every game on the site.

| Address | What | Code |
| --- | --- | --- |
| `cheetahmoongames.com` | Home page linking to every game | `site/` in this repo |
| `bartenders.cheetahmoongames.com` | Bartenders of Corfu | [mrkyle7/bartenders-of-corfu](https://github.com/mrkyle7/bartenders-of-corfu) |
| `boxer.cheetahmoongames.com` | The Boxer | [mrkyle7/the-boxer](https://github.com/mrkyle7/the-boxer) |

Every game runs as its own Cloud Run service in the `bartenders-464918` project and deploys from its own repo. This repo owns what they share: the Terraform for every service, domain, DNS record and permission, plus the home page.

## Who can do what

GitHub Actions sign in to Google Cloud without keys, through Workload Identity Federation. Each repo can act as exactly one service account:

| Repo | Acts as | Can |
| --- | --- | --- |
| `mrkyle7/cheetahmoongames` (this repo) | `github-terraform` | Apply the Terraform: IAM, service accounts, sign-in, DNS, secrets, every service. Also deploys the home page. |
| `mrkyle7/bartenders-of-corfu` | `bartenders-deploy` | Push to the `docker-us` registry, deploy the `bartenders` service, read and update its two Supabase secrets |
| each game's repo, e.g. `mrkyle7/the-boxer` | `<name>-deploy` | Push to the game's own registry and deploy the game's own service |

Every deploy account also has read-only access to Cloud Run, so its rollback step can list revisions. It can see other services but can't change them. Each game has its own image registry, because Google only grants registry access per registry, not per image, so a shared one would let any game overwrite another's images.

Everything above is defined in `terraform/github.tf`, `terraform/bartenders.tf` and `terraform/modules/game`.

The Terraform plan on pull requests also runs as `github-terraform`. So anyone who can push a branch to this repo can run code with its access, not only merges to the default branch. That's fine while only trusted people can push here. If that changes, give pull requests a separate read-only account.

To put a new game on the site, see **[ADDING_A_GAME.md](ADDING_A_GAME.md)**.

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
.github/workflows/deploy.yml
```

## How changes ship

`.github/workflows/deploy.yml` runs on every pull request and on merges to the default branch (`main` or `master`).

- **Pull request:** tests the home page, checks Terraform formatting and validity, and posts the Terraform plan in the run's summary (Actions → the run → Summary). Read the plan before merging.
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

## One-time setup

The Terraform used to live in the Bartenders repo, with its state in a local file on whoever last ran it. These steps move it here. Run them once, from the machine that holds that state file.

1. **Create the state bucket** (versioned, so any earlier state can be recovered):

   ```sh
   gcloud storage buckets create gs://bartenders-464918-tfstate \
     --project=bartenders-464918 --location=us-east1 --uniform-bucket-level-access
   gcloud storage buckets update gs://bartenders-464918-tfstate --versioning
   ```

2. **Move the existing state into it.** Copy the state file from your Bartenders checkout, then let `init` upload it:

   ```sh
   cp ../bartenders-of-corfu/terraform/terraform.tfstate terraform/
   cd terraform
   terraform init -migrate-state      # answer "yes" to copy the state to the new backend
   rm terraform.tfstate terraform.tfstate.backup   # now in the bucket
   ```

3. **Review the plan.** `terraform plan` should show only:
   - **moves:** The Boxer's account, service, public access, domain mapping and DNS record move into `module.game["boxer"]`. Nothing is recreated. The service shows as "updated", but only with provider defaults, not setting changes.
   - **new:**
     - the home page service, its account and its image registry
     - `bartenders-deploy` and `the-boxer-deploy`, with their scoped permissions
     - The Boxer's own image registry (`the-boxer`)
     - `github-terraform`'s roles for applying Terraform
     - this repo's permission to act as `github-terraform`
   - **deleted:** the old shared-CI bindings:
     - the Bartenders and Boxer repos acting as `github-terraform`
     - its project-wide `run.developer` role
     - its write access to `docker-us`
     - its access to the Supabase and VAPID secrets
     - its right to act as the two runtime accounts
     - The Boxer's read access to `docker-us`
   - **updates:**
     - the GitHub sign-in rule, now listing this repo
     - `LANDING_HOST` and `BARTENDERS_URL` removed from the Bartenders service
     - the apex DNS records
   - **one replacement:** `google_cloud_run_domain_mapping.cheetahmoongames` (see below)

   Anything else being destroyed or replaced means the state doesn't match this code. Stop and look before applying.

4. **Apply it yourself,** at a quiet time: `terraform apply`. This first apply has to run as you, because it's what gives this repo access in the first place.

   From this point, the Bartenders and Boxer repos can no longer use `github-terraform`. Their deploys fail until the next step.

5. **Merge the three pull requests straight away.** Order doesn't matter:
   - **this repo:** CI finds nothing left to apply, then deploys the home page over the placeholder
   - **`bartenders-of-corfu`:** deploys as `bartenders-deploy`, and removes the old Terraform and home-page code
   - **`the-boxer`:** deploys as `the-boxer-deploy`, into its own registry

### Why `cheetahmoongames.com` is briefly down

The domain already exists, but its domain mapping points at the **Bartenders** service. Cloud Run domain mappings can't be changed to point at a different service; the API only creates and deletes them. So Terraform deletes the mapping and creates a new one pointing at the home page service, and Google issues a new HTTPS certificate for it.

Until that certificate is ready, usually 15–60 minutes, `cheetahmoongames.com` doesn't load: the home page, and the redirects from old Bartenders links. The game subdomains have their own mappings and aren't affected. The only ways around it are keeping the domain on the Bartenders service, or putting a load balancer in front of every service (about $18 a month). Neither seemed worth it for a one-off gap, so apply at a quiet time.

Check progress on the certificate with:

```sh
gcloud beta run domain-mappings describe --domain cheetahmoongames.com \
  --region us-east1 --project bartenders-464918 --format='yaml(status.conditions)'
```

It's done when `CertificateProvisioned` and `Ready` are both `True`.

After that first apply, `terraform/games.tf` has `moved` blocks that have done their job. They're harmless to keep and can be deleted in any later change.
