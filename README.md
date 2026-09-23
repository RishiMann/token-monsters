# Frosted Corner

## Python development setup

This prototype uses Python's standard library to serve the frontend locally. VS Code is configured to use the project virtual environment in `.venv`. The first command block in each pair below is macOS/Linux, the second is Windows PowerShell.

```text
frontend/   Browser UI: HTML, CSS, and JavaScript
backend/    Python server and future API routes
.vscode/    VS Code launch, task, and interpreter settings
```

```bash
python3 -m venv .venv
.venv/bin/python backend/server.py
```

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe .\backend\server.py
```

Open http://127.0.0.1:8000 in a browser. You can also press **F5** in VS Code and select **Frosted Corner (Python server)**.

The current server has no third-party dependencies. Add future backend packages to `requirements.txt` and install them into `.venv` with:

```bash
.venv/bin/python -m pip install -r requirements.txt
```

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

### Editor settings

`.vscode/` is not tracked, because the interpreter path differs per machine and
committing it means macOS and Windows overwrite each other's settings on every
pull. Copy the template once after cloning:

```bash
cp .vscode.example/*.json .vscode/
```

```powershell
Copy-Item .vscode.example\*.json .vscode\
```

The templates resolve the interpreter through VS Code rather than hardcoding a
path, so the same files work on either platform once VS Code has selected the
`.venv` interpreter.

## How the storefront reasons

The catalog in `backend/storefront.json` carries everything the agents need,
so a new item is recommendable the moment it is added:

- **`profile`** on every item: flavor family, richness and brightness (0-4),
  texture, the occasions it suits, and explicit pairings with a reason.
  `frontend/js/recommendation-engine.js` ranks candidates against the box
  from these — pairings, complementary families, rich/bright balance, texture
  contrast, occasion fit, plant-based consistency, live seasons and the
  customer's favorites — and explains each pick. `backend/agent_tools.py`
  exposes the same ranking to the model as `suggest_pairings`.
- **`rule`** on every offer. `frontend/js/offers.js` and `backend/offers.py`
  evaluate the same rules: the six-count bundle (10%, or 15% with three or
  more flavors), the party box (free flavor flight at 12+), $1.50 off each
  live seasonal treat, the reorder rate (signed in, four or more of a
  favorite), and free delivery over $45. An offer is either earned by the box,
  with the amount it takes off, or locked with the reason. One discount
  applies at a time; free delivery is automatic. The applied offer is shown in
  the box drawer, priced on the checkout receipt, and drops off by itself if
  the box stops qualifying.
- **`releaseDate`** on every seasonal item, inside its menu's `opens`/`closes`
  window. `frontend/js/seasons.js` and `backend/seasons.py` compute what is
  on the counter today; the calendar on the homepage pins each item to its
  release day and re-renders at midnight.

The Corner Concierge is the one chat surface, and the one agent. The
specialists the product used to describe — recommendation, planner, offers,
support, orders, seasonal, franchise — are its tools: `suggest_pairings` is
the recommendation engine, `plan_party` the planner, `find_offers` and
`price_box` the offers agent, `get_event_menus` the seasonal agent, and
`check_inventory` / `get_sales_insights` appear only for signed-in admins.
`backend/agent_runtime.py` runs the model over the Responses API with a tool
loop; the browser sends the conversation so far on every turn, so the server
holds no chat state, and every reply carries the tool calls it made as a
plain-English trace.

`frontend/js/agents.js` sends every turn to `/api/agent` first. Without a
model configured the server answers 503 and `frontend/js/concierge.js`
answers from the same engine and offer rules, so the chat never contradicts
the page. The "picked for you" panel and the offers rail stay on that
deterministic engine — they re-run on every click — and the model reaches the
same engine through its tools.

### Growing the catalog

```bash
.venv/bin/python tools/expand_catalog.py   # profiles, new items, release dates, offer rules (idempotent)
.venv/bin/python tools/fetch_photos.py     # photos from tools/photos.json -> frontend/assets/desserts/
node --test tests/storefront.test.mjs      # engine, offers and seasons against the real catalog
```

Photos come from Pexels under the Pexels License; every source is listed in
`frontend/assets/desserts/ATTRIBUTION.md`. To add an item, give it a
`profile` (see `PROFILES` in `tools/expand_catalog.py`), map a photo in
`tools/photos.json`, and run both tools.

### Configuring the model

Locally, copy `.env.example` to `.env` (gitignored) and fill it in; the
server loads it on start. On App Service, add the same names under
Settings → Environment variables:

```
AZURE_OPENAI_ENDPOINT    https://<resource>.services.ai.azure.com/openai/v1/
AZURE_OPENAI_DEPLOYMENT  gpt-5-mini
AZURE_OPENAI_API_KEY     the key (or omit it and grant the app's managed identity access)
AZURE_OPENAI_REASONING   optional: minimal | low | medium (default low)
```

A pasted endpoint ending in `/responses` is accepted. Until these are set the
storefront runs entirely on the rule-based path. gpt-5 models reject
`temperature`, so the runtime never sends it.

The model can act on the box through `add_to_box`, `remove_from_box` and
`apply_offer`; the server holds no cart, so each action is applied to the
cart for the rest of that turn (so `price_box` sees it) and echoed back as
`actions` for the browser to mirror. A turn the model drops (a 502) asks the
customer to repeat rather than switching to the rule-based brain
mid-conversation.

Azure's default content filter on the Foundry resource rejects some innocent
phrasings before the model sees them — "take the fudge out" is blocked as
profanity-adjacent while "remove the fudge" passes. The chat says so and asks
for other words. To loosen it, give the deployment a custom content filter
in Foundry (Safety + security → Content filters) with a higher prompt
threshold for the hate category.

```bash
.venv/bin/python -m unittest tests/test_agent_runtime.py   # the tool loop, with a stub model
```

## Deployment (Azure App Service)

`.github/workflows/main_tokenmonster.yml` deploys `main` to the `tokenmonster`
App Service. It is a Python pipeline: the app has no build step and no
third-party packages, so the workflow installs `requirements.txt`, checks the
backend compiles and the frontend is present, then ships `backend/`,
`frontend/` and `requirements.txt`.

App Service starts the app with `python backend/server.py`, set as the deploy
step's `startup-command`. The server reads `PORT` from the environment and
binds `0.0.0.0` whenever it is present, which is what App Service needs; with
no `PORT` set it stays on `127.0.0.1:8000` for local work. Set `HOST`
explicitly to override either behavior.

## Database (PostgreSQL)

Accounts, sessions, preferences, orders, inventory and sales live in
PostgreSQL. The catalog stays in `backend/storefront.json` because it is not
mutable.

Each machine runs its own local database, so the data on your laptop is yours
alone. Nothing is shared and nothing leaves the machine.

### Install PostgreSQL 17

Use **17** on every machine — it is what this was built and tested against.

macOS:

```bash
brew install postgresql@17
brew services start postgresql@17
createdb frostedcorner
```

Windows: install PostgreSQL 17 from the EDB installer, keep the default port
5432, and note the password you set for the `postgres` user. Then create the
database:

```powershell
& "C:\Program Files\PostgreSQL\17\bin\createdb.exe" -U postgres frostedcorner
```

### Run it

Install the Python packages once:

```bash
.venv/bin/python -m pip install -r requirements.txt
```

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

On macOS and Linux that is the whole setup — the server connects to a local
`frostedcorner` database by default, so **F5** in VS Code works with no
environment variable:

```bash
.venv/bin/python backend/server.py
```

On Windows the local `postgres` user needs a password, so set the variable in
the same shell before starting:

```powershell
$env:DATABASE_URL = "postgresql://postgres:YOUR_PASSWORD@localhost:5432/frostedcorner"
.\.venv\Scripts\python.exe .\backend\server.py
```

On boot the server creates the schema and seeds it. Both steps are idempotent
— the schema uses `CREATE TABLE IF NOT EXISTS` and the seed only fills empty
tables — so restarting never duplicates or overwrites anything. If the
database is unreachable the storefront still serves; only accounts and the
operations console go dark, and the console prints what to fix.

`DATABASE_URL` overrides the default whenever it is set, which is how a hosted
deployment points at its own server. Azure Database for PostgreSQL requires
TLS, so a URL for it needs `?sslmode=require`.

### SQLite (optional)

SQLite can stand in for PostgreSQL by asking for it explicitly:

```
DATABASE_URL=sqlite:///tmp/frostedcorner.db
```

The schema, queries and seed are shared; only the type names differ. It is
opt-in rather than automatic, so a deployment with no database configured
fails cleanly to the demo path below instead of half-starting.

### Demo sign-in fallback

If the server has no database at all it answers `503`, and the frontend then
signs in against the seeded accounts held in `frontend/js/demo-data.js`,
keeping a session in `sessionStorage`. The profile and console render
generated figures that match what the database would hold.

This exists so a deployment with no database is still demoable. It is not
real authentication: the accounts and their passwords are in the page source,
which the login page already lists, and on this path the console's figures are
generated in the browser rather than read from a server. Configure
`DATABASE_URL` and none of it runs — the server verifies hashed passwords and
enforces the admin role itself.

### Seeded accounts

The seed is deterministic, so every machine gets identical numbers.

| Email | Password | Role |
| --- | --- | --- |
| `alex@frostedcorner.com` | `treat` | customer, 6 orders |
| `sam@frostedcorner.com` | `treat` | customer, avoids tree nut |
| `jordan@frostedcorner.com` | `treat` | customer |
| `hq@frostedcorner.com` | `admin` | operations console |

### Looking at the data

In the app: sign in as `hq@frostedcorner.com` and open the operations console,
which reads live inventory and supply orders.

From the command line (`psql frostedcorner` on macOS; on Windows use pgAdmin or
add `-U postgres`):

```bash
psql frostedcorner -c "\dt"
psql frostedcorner -c "select email, role, home_corner from users order by id;"
psql frostedcorner -c "select location_id, item_id, on_hand, reorder_point from inventory where on_hand <= reorder_point;"
```

For a GUI, **pgAdmin** ships with the Windows installer; **DBeaver** and
**TablePlus** both work on either platform. Connect to host `localhost`, port
5432, database `frostedcorner`.

Because the seed only fills empty tables, editing `seed.py` will not change a
database that already has rows. To pick up new mock data, start over:

```bash
dropdb frostedcorner && createdb frostedcorner
```
