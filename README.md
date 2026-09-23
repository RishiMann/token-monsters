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

### The SQLite fallback

PostgreSQL is what this targets, but if it is not configured or not reachable
the app falls back to a SQLite file and keeps working: accounts, the profile
and the operations console all run against the same seed data. This is what
makes the hosted demo signable-in without provisioning a database server.

The schema, the queries and the seed are shared; only the type names differ,
which `_sqlite_schema()` in `backend/db.py` translates. The file lives at
`SQLITE_PATH` if set, `/home/frostedcorner.db` on App Service (which persists
across restarts), or next to the backend locally.

Set `DATABASE_URL` and PostgreSQL is used instead, always in preference to the
fallback. The boot log says which one is in play.

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
