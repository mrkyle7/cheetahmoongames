# __TITLE__

A game on **cheetahmoongames.com**, served at **https://__SUBDOMAIN__.cheetahmoongames.com** from the `__NAME__` Cloud Run service. This repo was started from the skeleton in [mrkyle7/cheetahmoongames](https://github.com/mrkyle7/cheetahmoongames) by `scripts/new-game.sh`. So far it only serves a placeholder page.

## Read this first

Before any work on hosting, deploys, the workflow, domains or Google Cloud, read **[ADDING_A_GAME.md](https://github.com/mrkyle7/cheetahmoongames/blob/master/ADDING_A_GAME.md)** in mrkyle7/cheetahmoongames. It explains how this game gets onto the site and what each step does.

The infrastructure is not in this repo. The Cloud Run service, image registry, subdomain, DNS record and this repo's deploy permissions all live in `terraform/` in mrkyle7/cheetahmoongames, and change through pull requests there. That repo's workflow applies them. To change them, clone mrkyle7/cheetahmoongames and open a pull request there. Never create or change Google Cloud resources by hand or from this repo.

## Getting it live

Check what's done before starting. Ask the user if unsure, and update these boxes as steps complete.

- [x] Repo created from the skeleton (`scripts/new-game.sh`)
- [ ] `__NAME__` entry added to `terraform/games.tf` in mrkyle7/cheetahmoongames, merged, and its workflow applied successfully
- [ ] Card for the game added to `site/public/index.html` in mrkyle7/cheetahmoongames (can be the same pull request)
- [ ] Repo variable `DEPLOY_ENABLED` set to `true` in this repo: `gh variable set DEPLOY_ENABLED --body true -R __OWNER__/__NAME__`
- [ ] A push to `main` deployed successfully (Actions → CI/CD)
- [ ] `https://__SUBDOMAIN__.cheetahmoongames.com` loads over HTTPS (the certificate can take 15–60 minutes after the DNS record appears)

## Rules the game must keep

- **Listen on `PORT`.** Cloud Run sets it to 8080; `server.js` reads it.
- **Serve the game at `/`.** It owns the whole subdomain.
- **Keep nothing important on local disk.** It's wiped whenever the instance restarts. Anything that must survive needs a database or other storage. That's new infrastructure, so it goes in mrkyle7/cheetahmoongames; see "Games that need secrets or a database" in ADDING_A_GAME.md.
- **Keep the workflow's `env` block as generated.** `REPOSITORY`, `IMAGE_NAME`, `SERVICE_NAME` and `SERVICE_ACCOUNT` must match the `__NAME__` entry in games.tf. The deploy account can only push to its own registry and deploy its own service.
- **Keep `PAGE_MARKER` current.** It's the text the container and deploy smoke tests look for on `/`. If the page stops showing "__TITLE__", update it in `.github/workflows/ci-cd.yml`.
- **No keys or secrets for Google Cloud in this repo.** GitHub Actions sign in without them. Only jobs on `main` of this repo can deploy; Google Cloud enforces that, not the workflow file.
- **Players are Cheetah Moon accounts.** They sign in once at `https://cheetahmoongames.com/login`, and `auth.js` tells the server who they are (`await auth.player(req)` gives `{ id, name }` or null). Don't build a sign-in, or ask for names or passwords, in the game. Key games and records by `id`; `name` is for display and can contain spaces. See "Players and signing in" in ADDING_A_GAME.md.
- **Don't log, store or forward the `userjwt` cookie.** Only `auth.js` reads it. Keep `auth.js` as it is in the skeleton; fixes to it go in mrkyle7/cheetahmoongames first.
- **Instances:** by default up to 3 can run, and players may land on different ones. If players must meet on the same server, for example rooms kept in memory, set `max_instances = 1` (and, for WebSockets, `timeout`, `concurrency` and `session_affinity`) in the games.tf entry. The Boxer does this.

## Commands

```sh
npm test            # unit tests
npm start           # http://localhost:8080
docker build -t __NAME__ . && docker run -p 8080:8080 __NAME__   # the container Cloud Run runs
```

## How it deploys

`.github/workflows/ci-cd.yml` runs tests and a container smoke test on every push and pull request. On `main`, once `DEPLOY_ENABLED` is `true`, it:
1. builds the image and pushes it to `us-east1-docker.pkg.dev/bartenders-464918/__NAME__/__NAME__`
2. deploys it to the `__NAME__` service
3. checks the service serves the page
4. rolls back if the deploy fails
