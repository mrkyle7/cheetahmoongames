# cheetahmoongames

The Cheetah Moon Games home page (`site/`), the shared sign-in, and the Terraform for every game's infrastructure (`terraform/`). Read **ADDING_A_GAME.md** and README.md before changing how games get onto the site.

```sh
cd site && npm test    # unit tests (also run in CI)
```

## "Your games" holds secrets: keep it that way

The home page's "Your games" section (`site/games.js`, `/api/my-games`, `terraform/site.tf`) gives this **public** service the **secret keys** of Bezique's and Bartenders' Supabase projects (full read and write on their data, Bartenders' being the accounts database), and read access to the King's Keep and Secret Mermaids buckets. Each key is already held by its own game; this makes the home page a third place that holds it, so a bug here is a leak of every player's data. When touching `site/games.js`, `site/server.js`, `site/account.js` or the `site.tf` access:

- **Never put a key, token or settings value in a response, header, log line, error message, thrown `Error` or test snapshot.** Errors name the table and the status, never the key or the URL's query. Don't log request headers or `init` objects.
- **Only ever read the signed-in player's own games.** The player is the verified login cookie's `id` (`accounts.verifyCookie`), never a query string, header or body. Every games query must filter by that id. Never add a route that lists games, players or tables for anyone else, and never read a table other than `games` (and Bartenders' `users`, only for opponents' display names).
- **Only a plain account id goes into a query** (`safeId`). Don't build queries from anything else a player sends, and don't loosen `safeId`.
- **Send each key only to its own database,** and the bucket token only to `storage.googleapis.com`.
- **Read-only.** No inserts, updates, deletes, RPC calls or writes to a bucket. Keep the IAM in `site.tf` to `objectViewer` and `secretAccessor` on exactly these buckets and secrets.
- **Return only what the page shows** (`game, title, id, url, with, yourTurn, updated`). Don't pass saved game state, hands or other players' ids to the browser.
- `site/test/games-secrets.test.js` checks all of this. If it fails, fix the code: never loosen or delete a test to get green. Add a test for any new way a key or another player's data could leave the server.

## "Your games" mirrors each game's own rules: check here when you change them

"Your games" reads each game's saved data and works out whose turn it is itself, so it has copies of rules that live in the game repos:

- **Secret Mermaids:** `mermaidsAwaiting()` in `site/games.js` is `Game#awaiting()` (`src/Game.js`), applied to a saved game file. Its saved files carry no "whose turn" data.
- **Bezique:** your turn is `cardsSelectableForTrick || cardsSelectableForMeld` on the player in the saved state (`src/bezique/snapshot.js`); in progress is `started && !gameOver`.
- **Bartenders:** `latest_state.player_turn`, `latest_state.winner` and `status = STARTED` in the `games` table.
- **King's Keep:** the object metadata its store writes (`players`, `names`, `status`, `turn`, `updated`: `summary()` in `src/rooms.js`).

**When you change core game logic, the shape of what a game saves, the bucket file or metadata, or a Supabase table or column in one of these games, update `site/games.js` (and its tests) in this repo in the same piece of work, and open a pull request here too.** Otherwise the home page shows the wrong turn, or nothing, with no error in the game itself. Each game's own CLAUDE.md says the same.

## Reading buckets and databases directly isn't the best way

Reading each game's storage from the home page is a shortcut, not the ideal design. The tidy way is for each game to answer "this player's games and whose turn it is" itself (an endpoint on the game, which owns its own rules and storage, and no copy of them here). It's done this way only because calling the games would **wake their Cloud Run services** (and Bartenders and Bezique can take a long time to start), so the home page would be slow or time out. If the games ever stay warm, or the list is kept somewhere shared (say, a small table the games update as turns change), move to that and delete the copied rules and the extra access in `site.tf`.

Supabase projects can also take a minute to wake, so a source is never waited on for long: `/api/my-games` answers with what's ready and marks the rest "pending", the slow source keeps retrying in the background, and the page keeps asking until every game has answered. Keep that: don't make a request wait for a sleeping database.
