# Miette & Co.

## Python development setup

This prototype uses Python's standard library to serve the frontend locally. VS Code is configured to use the project virtual environment in `.venv`.

```text
frontend/   Browser UI: HTML, CSS, and JavaScript
backend/    Python server and future API routes
.vscode/    VS Code launch, task, and interpreter settings
```

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe .\backend\server.py
```

Open http://127.0.0.1:8000 in a browser. You can also press **F5** in VS Code and select **Miette & Co. (Python server)**.

The current server has no third-party dependencies. Add future backend packages to `requirements.txt` and install them into `.venv` with:

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```