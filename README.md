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
