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
mutable. Everything is driven by one environment variable:

```
DATABASE_URL=postgresql://user:password@host:5432/frostedcorner
```

`init_schema()` and `seed()` run on every boot. Both are idempotent: the schema
uses `CREATE TABLE IF NOT EXISTS` and the seed only fills empty tables, so
restarting never duplicates or overwrites data. With no `DATABASE_URL` the
storefront still serves; only accounts and the operations console go dark.

### Option A — share one database (recommended for a team)

Point every machine at the same Azure Database for PostgreSQL instance and skip
the local install entirely. Everyone then sees the same accounts and the same
inventory, which is what you want when two people are demoing the same build.
Azure requires TLS, so append `sslmode`:

```
DATABASE_URL=postgresql://user:password@your-server.postgres.database.azure.com:5432/frostedcorner?sslmode=require
```

### Option B — a local database per machine

Install **PostgreSQL 17** to match what this was built and tested against.

macOS:

```bash
brew install postgresql@17
brew services start postgresql@17
createdb frostedcorner
```

Windows: install PostgreSQL 17 from the EDB installer, keep the default port
5432, and note the password you set for the `postgres` user. Then:

```powershell
& "C:\Program Files\PostgreSQL\17\bin\createdb.exe" -U postgres frostedcorner
```

Install the Python packages and run the server with the variable set:

```bash
.venv/bin/python -m pip install -r requirements.txt
DATABASE_URL="postgresql://$(whoami)@localhost:5432/frostedcorner" .venv/bin/python backend/server.py
```

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
$env:DATABASE_URL = "postgresql://postgres:YOUR_PASSWORD@localhost:5432/frostedcorner"
.\.venv\Scripts\python.exe .\backend\server.py
```

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

From the command line:

```bash
psql "$DATABASE_URL" -c "\dt"
psql "$DATABASE_URL" -c "select email, role, home_corner from users order by id;"
psql "$DATABASE_URL" -c "select location_id, item_id, on_hand, reorder_point from inventory where on_hand <= reorder_point;"
```

For a GUI, **pgAdmin** ships with the Windows installer; **DBeaver** and
**TablePlus** both work on either platform. Connect with the same host, port,
database, user and password from `DATABASE_URL`.

To start over on a local database:

```bash
dropdb frostedcorner && createdb frostedcorner
```
