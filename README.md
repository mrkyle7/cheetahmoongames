# Cheetah Moon Games

The home page at **https://cheetahmoongames.com** and the Google Cloud setup behind every game on the site.

| Address | What | Code |
| --- | --- | --- |
| `cheetahmoongames.com` | Home page linking to every game | `site/` in this repo |
| `bartenders.cheetahmoongames.com` | Bartenders of Corfu | [mrkyle7/bartenders-of-corfu](https://github.com/mrkyle7/bartenders-of-corfu) |
| `boxer.cheetahmoongames.com` | The Boxer | [mrkyle7/the-boxer](https://github.com/mrkyle7/the-boxer) |

Every game runs as its own Cloud Run service in the `bartenders-464918` project and deploys from its own repo. This repo owns what they share: the Terraform for every service, domain, DNS record and permission, plus the home page.

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
  shared.tf            APIs, the Docker image registry, the data bucket
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
   - **moves** (The Boxer into `module.game["boxer"]`, the Bartenders deploy binding renamed): nothing is recreated
   - **new:**
     - the `cheetahmoongames` home page service, its account and its public access
     - this repo's permission to deploy
     - the CI account's roles for applying Terraform
   - **updates:**
     - the GitHub sign-in rule, now listing this repo
     - `LANDING_HOST` and `BARTENDERS_URL` removed from the Bartenders service
     - the apex DNS records
   - **one replacement:** `google_cloud_run_domain_mapping.cheetahmoongames`, which moves the apex from the Bartenders service to the home page service

   Anything else being destroyed or replaced means the state doesn't match this code. Stop and look before applying.

4. **Apply it yourself:** `terraform apply`. This first apply has to run as you, because it's what gives this repo and the CI account the access CI needs to apply later.

   Replacing the apex domain mapping means Google issues `cheetahmoongames.com` a new HTTPS certificate. Expect the home page, and the redirects from old Bartenders links, to be unreachable for roughly 15–60 minutes. The game subdomains aren't affected.

5. **Merge this repo's pull request straight away.** CI finds nothing left to apply and deploys the real home page over the placeholder, well before the new certificate is ready.

6. **Merge the matching Bartenders pull request.** It removes the old Terraform and home-page code from that repo.

Check progress on the certificate with:

```sh
gcloud beta run domain-mappings describe --domain cheetahmoongames.com \
  --region us-east1 --project bartenders-464918 --format='yaml(status.conditions)'
```

It's done when `CertificateProvisioned` and `Ready` are both `True`.

After that first apply, `terraform/games.tf` has `moved` blocks that have done their job. They're harmless to keep and can be deleted in any later change.
