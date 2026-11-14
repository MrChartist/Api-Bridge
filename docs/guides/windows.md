# Windows notes

> Commands here start with `mc-bridge`. In a git checkout, run them as `npm run bridge -- <command>` instead ([why](README.md#running-mc-bridge)).

Most examples in these guides are written for a Mac or Linux shell (bash or zsh). On Windows use **PowerShell** (the blue
window; type *PowerShell* in the Start menu), not Command Prompt. The Bridge itself, the dashboard, the Excel workbook and
AmiBroker need nothing special. This page covers the places where the shell matters.

*How far to trust this page:* the PowerShell lines follow Microsoft's documented behaviour. The project's automated checks run
on Linux, so they have not been run on every Windows version. If one fails for you, [open an issue](https://github.com/MrChartist/api-bridge-v2/issues) with the line and what PowerShell said.

## Bash and PowerShell side by side

| In the guides (bash) | In PowerShell |
|---|---|
| `export MCB_API_KEY=mcb_...` | `$env:MCB_API_KEY = "mcb_..."` (lasts for this window only) |
| `echo $MCB_API_KEY` | `echo $env:MCB_API_KEY` |
| `MCB_PORT=4301 npm run dev` | `$env:MCB_PORT = "4301"; npm run dev` |
| `MCB_HOME=$(mktemp -d) npm run dev` | `$env:MCB_HOME = (New-Item -ItemType Directory (Join-Path $env:TEMP ([guid]::NewGuid()))).FullName; npm run dev` |
| `curl -s http://127.0.0.1:4300/v1/health` | `Invoke-RestMethod http://127.0.0.1:4300/v1/health` (or `curl.exe -s ...`) |
| `-H "Authorization: Bearer $MCB_API_KEY"` | `-Headers @{ Authorization = "Bearer $env:MCB_API_KEY" }` |
| a `\` at the end of a line | a backtick `` ` `` at the end of a line |
| `-d '{"a":"b"}'` | `-Body '{"a":"b"}' -ContentType "application/json"` (or build the body from a hashtable with `ConvertTo-Json`) |
| `... \| jq '.data'` | `... \| Select-Object -ExpandProperty data` (Invoke-RestMethod already turns JSON into objects) |

**`curl` is not curl in Windows PowerShell 5.1.** There it is an alias of `Invoke-WebRequest`, so `curl -s` and `curl -H` fail
with a confusing error. Either use `Invoke-RestMethod`, or type `curl.exe`, which is the real program that ships with Windows 10
and 11. With `curl.exe`, JSON bodies in single quotes lose their inner double quotes in Windows PowerShell 5.1: prefer
`Invoke-RestMethod` with a hashtable body, as the [quickstart](quickstart.md) does. PowerShell 7 does not alias `curl`.

To keep a variable for good (every new window), set it once for your user and open a new window:

```powershell
[Environment]::SetEnvironmentVariable("MCB_BRIDGE_URL", "http://127.0.0.1:4301", "User")
```

Keep API keys out of this: a key stored that way is readable by every program you run. Set a key only for the window that needs it.

## Where things are

| What | Where |
|---|---|
| Settings and data (one-step installer, Setup.exe) | `%APPDATA%\MrChartist\Bridge` (open it with `explorer $env:APPDATA\MrChartist\Bridge`) |
| The program (one-step installer) | `%LOCALAPPDATA%\MrChartist\Bridge` |
| Ready-to-run ZIP | the unzipped folder: `bridge.config.json` and the data sit next to `start-windows.bat`, so deleting the folder deletes them too |
| A git checkout | the data folder printed at start (`Data folder: ...`) |
| AmiBroker key file | `%APPDATA%\MrChartist\Bridge\amibroker.key` (the older `%USERPROFILE%\.mc-bridge\amibroker.key` is still read) |

`MCB_HOME` moves the settings and data folder; `MCB_MASTER_KEY_FILE` moves the master key file out of the data folder.

## Protecting the master key file

The Bridge cannot check Windows file permissions, so restrict the file yourself (see [safety.md](safety.md#secrets)). In PowerShell:

```powershell
icacls "$env:APPDATA\MrChartist\keys\master.key" /inheritance:r /grant:r "${env:USERNAME}:F"
```

In Command Prompt the same line is `icacls "%APPDATA%\MrChartist\keys\master.key" /inheritance:r /grant:r %USERNAME%:F`.

## Firewall and ports

The Bridge listens on `127.0.0.1` (this computer only), and Windows does not normally ask about that. If a Windows Firewall
prompt appears, you or a setting made the Bridge listen on all addresses (`server.host`); choose **Cancel** unless you meant
to share it ([safety.md](safety.md) explains what that opens). "Port 4300 is already in use" means another program has the port:
close it, or pick another with `$env:MCB_PORT = "4301"` and tell every tool the new address (`$env:MCB_BRIDGE_URL`).

## Running at login

The Bridge has no built-in start at login, and a broker login is needed each morning anyway. To start the Bridge window when you
sign in to Windows, press Win+R, type `shell:startup`, and put a shortcut to a small `.bat` file that runs `npm run dev` (or `npm start`) in the repository folder in the folder that opens.


## Files for Excel and AmiBroker

Downloads (`mc-bridge download`) write CSV with Windows line endings (CRLF); recordings write LF. Excel reads both. A script that joins
or compares files from both should read them in text mode or strip `\r`.
