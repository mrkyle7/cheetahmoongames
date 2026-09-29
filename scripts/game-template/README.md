# __TITLE__

A game on [Cheetah Moon Games](https://cheetahmoongames.com), played at **https://__SUBDOMAIN__.cheetahmoongames.com**.

```sh
npm test
npm start      # http://localhost:8080
```

Pushes to `main` deploy to Cloud Run (see `.github/workflows/ci-cd.yml`). The hosting for every game is set up in [mrkyle7/cheetahmoongames](https://github.com/mrkyle7/cheetahmoongames); [ADDING_A_GAME.md](https://github.com/mrkyle7/cheetahmoongames/blob/master/ADDING_A_GAME.md) explains how it fits together. `CLAUDE.md` has the checklist for getting the game live and the rules it has to keep.
