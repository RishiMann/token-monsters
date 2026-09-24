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

### Orders and stock

Checkout places a real order (`POST /api/orders`). The server resolves the
lines against today's menu, prices the box again with the same offer rules the
browser used (an offer the box has not earned is ignored), records the order
with its line prices, and takes each item's `uses` ingredients out of the
customer's home corner plus one six-count box per six units. The day's item and
corner sales move with it.

The order then walks a short lifecycle that the franchise console advances:

| Pickup | Delivery |
| --- | --- |
| received → preparing → ready for pickup → picked up | received → preparing → on its way → delivered |

Every change is appended to `order_events`, so the customer sees a timeline.
The customer can cancel while the order is still *received*; the console can
also cancel while it is *preparing*. Cancelling puts the ingredients, boxes and
sales back.

**Following an order.** The storefront shows "Where your box is" at the top of
the page as soon as an order is placed, with the progress steps, the promised
time (the corner's lead time, or the chosen window) and what is in the box. It
re-reads the server every 10 seconds while anything is in progress. A guest's
browser keeps the order id and a tracking token in `localStorage`
(`fc-orders`); a signed-in customer's orders come back by session as well, and
the profile page lists them with their status. The concierge answers "where's
my order?" with the `get_order_status` tool, which sees the same orders.

**Moving an order.** Sign in as `hq@frostedcorner.com` and open *Live orders*
in the console: every order lands there as it is placed, with a button for its
next step and a cancel. The console re-reads every 10 seconds, so the stock
rows on the inventory tab show what each order took.

Endpoints: `POST /api/orders` (place; returns the order and its token),
`POST /api/orders/track` (`{refs: [{id, token}]}` plus the session's orders),
`GET /api/orders/mine`, `GET /api/orders/<id>?t=<token>`,
`POST /api/orders/<id>/cancel` (owner, token or console),
`POST /api/orders/<id>/advance` and `POST /api/orders/<id>/status` (console).

## Replenishment: franchise to HQ

The inventory agent turns sales into supply orders. For each corner and each
ingredient it takes the last 14 days of item sales (a corner's share of the
network's orders apportions network item units to it), multiplies by every
item's `uses` recipe plus one six-count box per six units, and gets a burn
rate per day. From on-hand stock that gives days of cover and a run-dry date;
against the supplier's lead time it decides:

| Status | Meaning |
| --- | --- |
| Order now | at or under the reorder point, or runs dry before an order placed today could land, with nothing on the way |
| Order this cycle | fine today, but would not stay covered through the lead time plus 14 days |
| Order inbound | short, but a supply order is already coming |
| Covered | nothing to do |

The suggested quantity brings the shelf to lead time plus 14 days of burn
(never below the reorder point). The agent keeps one draft supply order per
corner (`supply_orders.status = 'draft'`, with `supply_order_lines`),
rebuilt on every console read until it is approved. Approving sends it to HQ
and puts the quantities on order; HQ marks it shipped and then delivered,
which adds the quantities to the shelf. The console's Inventory tab shows the
drafts, a forecast table, and the orders in flight; the "Draft order" button on
a critical stock row asks the agent for that corner's draft. In the franchise
chat, `forecast_stock` answers "when do we run out of butter?" and
`approve_supply_order` sends a draft when asked.

Endpoints (console role): `POST /api/supply/draft` (`{location}` optional),
`POST /api/supply/<id>/approve|ship|deliver|dismiss`. The forecast and drafts
come back with `GET /api/operations` under `replenishment`.


## Deployment (Azure App Service)

`.github/workflows/main_tokenmonster.yml` deploys `main` to the `tokenmonster`
App Service. The workflow checks the backend compiles and the frontend is
present, then ships `backend/`, `frontend/` and `requirements.txt`. The
packages in `requirements.txt` (the model SDK, the database driver) are
installed by App Service itself during the deploy, which needs the app
setting `SCM_DO_BUILD_DURING_DEPLOYMENT=true`; without it the site serves
but `/api/health` reports the SDK missing and the chat runs on the rule-based
path. `/api/health` shows the Python version, the database driver and
whether the model endpoint, deployment, key and SDK are present.

App Service starts the app with `python backend/server.py`, set as the deploy
step's `startup-command`. The server reads `PORT` from the environment and
binds `0.0.0.0` whenever it is present, which is what App Service needs; with
no `PORT` set it stays on `127.0.0.1:8000` for local work. Set `HOST`
explicitly to override either behavior.

## Database (PostgreSQL)

Accounts, sessions, preferences, orders (with their status history), inventory
and sales live in PostgreSQL. The catalog stays in `backend/storefront.json`
because it is not mutable. One database holds everything on purpose: placing an
order writes the order, takes the ingredients out of the corner's stock and
records the sale together, and cancelling puts them back together.

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

### Point the app at it

The server reads `DATABASE_URL`. The easiest place to keep it is a `.env` file
in the repository root (it is gitignored; copy `.env.example`):

```
DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@localhost:5432/frostedcorner
```

That is the whole setup on a Windows laptop with the EDB installer: the
`postgres` user, the password you chose, port 5432, database `frostedcorner`.
On macOS with a passwordless Homebrew server the variable can be left out and
the server connects to `postgresql:///frostedcorner` on its own. Any other
PostgreSQL works the same way — Docker, for example:

```bash
docker run -d --name frostedcorner-pg -e POSTGRES_PASSWORD=frosted -e POSTGRES_DB=frostedcorner -p 5432:5432 postgres:16
```

with `DATABASE_URL=postgresql://postgres:frosted@localhost:5432/frostedcorner`.

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

On boot the server creates the schema, applies any column additions a
database from an earlier version is missing, and seeds it. All three steps are
idempotent — the schema uses `CREATE TABLE IF NOT EXISTS`, migrations fail
harmlessly where they already applied, and the seed only fills empty tables —
so restarting never duplicates or overwrites anything. If the
database is unreachable the storefront still serves; only accounts and the
operations console go dark, and the console prints what to fix.

`DATABASE_URL` overrides the default whenever it is set, which is how a hosted
deployment points at its own server. Azure Database for PostgreSQL requires
TLS, so a URL for it needs `?sslmode=require`. On App Service with no
PostgreSQL yet, `DATABASE_URL=sqlite:////home/frostedcorner.db` gives the site
a real, persistent database (`/home` survives restarts) so accounts, orders
and stock work in production.

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
