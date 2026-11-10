# Installing the Bridge

You do not need to know anything about programming. Pick **one** way below. Each takes a few minutes and needs no
admin password. You never have to install Node.js yourself, and you never have to copy a key: the dashboard opens in
your browser already signed in.

Everything stays on your computer. Orders are **paper** (practice, with virtual money) until you switch real trading on
yourself in the settings file.

> **No release has been published yet.** Everything on this page except the last line downloads from a GitHub
> release, and the first release has not been made. Until it is, the links and one-line commands below answer "not
> found" (or fail with "Could not download"). To run the Bridge today, use a git checkout: install Node.js 22.12 or
> newer and git, then follow [Five minutes to a first answer](../../README.md#five-minutes-to-a-first-answer). This
> notice is removed when the first release goes out ([release process](../release-process.md)).

| Your computer | Easiest way |
|---|---|
| Windows 10 or 11 | [Setup.exe](#windows-setupexe) (double-click) or [one line in PowerShell](#windows-one-line) |
| Mac | [One line in Terminal](#mac-and-linux-one-line) (no security prompts) or [the ready-to-run download](#ready-to-run-download) |
| Linux | [One line in a terminal](#mac-and-linux-one-line) or [the ready-to-run download](#ready-to-run-download) |
| Android phone or tablet | [Termux and one line](#android-termux) |

---

## Windows: Setup.exe

1. Open the [latest release](https://github.com/MrChartist/api-bridge-v2/releases/latest) and download
   **`Mr-Chartist-Bridge-Setup-….exe`**.
2. Double-click it. If Windows says *"Windows protected your PC"*, click **More info**, then **Run anyway** (the file
   is not signed yet; this happens only once).
3. A small window shows the progress, then the Bridge starts and your browser opens the dashboard, already signed in.

That is all: no admin password, nothing else to install (Node.js is inside the .exe). Next time, open
**Mr Chartist Bridge** from the Start menu or the Desktop. To remove it: **Settings → Apps → Installed apps →
Mr. Chartist API Bridge → Uninstall** (your settings and data are kept). Running a newer Setup.exe updates it.

---

## Ready-to-run download

Everything the Bridge needs is inside the ZIP, including its own copy of Node.js, so it works even without internet
while installing.

1. Open the [latest release](https://github.com/MrChartist/api-bridge-v2/releases/latest) and download the file for your
   computer:
   - Windows: `mr-chartist-bridge-…-windows-x64.zip`
   - Mac with Apple chip (M1, M2, M3, M4…): `…-macos-arm64.zip`; older Intel Mac: `…-macos-x64.zip`
     (Apple menu → About This Mac shows which)
   - Linux PC: `…-linux-x64.zip`; Raspberry Pi and other ARM boards: `…-linux-arm64.zip`
2. Unzip it (double-click the ZIP; on Windows choose **Extract all**). You get a folder called **Mr Chartist Bridge**.
   Put it anywhere you like, for example in Documents.
3. Open the folder and double-click the start file:
   - Windows: **`start-windows.bat`**. If Windows says *"Windows protected your PC"*, click **More info**, then
     **Run anyway**. This happens only the first time.
   - Mac: **`start-mac.command`**. The first time, macOS blocks it because it was downloaded from the internet:
     - macOS 15 (Sequoia) or newer: open **System Settings → Privacy & Security**, scroll down and click
       **Open Anyway**, then confirm.
     - macOS 14 or older: right-click the file, choose **Open**, then **Open** again.
   - Linux: **`start-linux.sh`** (or open a terminal in the folder and type `sh start-linux.sh`).
4. A small window opens and your browser shows the dashboard, already signed in. **Keep the small window open** while
   you use the Bridge. To stop the Bridge, close that window.

Next time, double-click the same start file again.

---

## Mac and Linux: one line

1. Open **Terminal** (Mac: press <kbd>⌘ Space</kbd>, type *Terminal*, press Enter; Linux: your applications menu).
2. Copy this line, paste it into Terminal and press Enter:

   ```sh
   curl -fsSL https://github.com/MrChartist/api-bridge-v2/releases/latest/download/install.sh | sh
   ```

3. Wait a minute or two. It downloads the Bridge (and its own Node.js if your computer does not have Node.js 22),
   sets it up and opens the dashboard, already signed in.

Next time, start it like any app:

- **Mac:** open **Mr Chartist Bridge** from Spotlight (<kbd>⌘ Space</kbd>, type *Mr Chartist*) or Launchpad.
- **Linux:** **Mr Chartist Bridge** in your applications menu, or the icon on your Desktop.

Want to try it with sample prices first, without any broker? Use:

```sh
curl -fsSL https://github.com/MrChartist/api-bridge-v2/releases/latest/download/install.sh | sh -s -- --demo
```

---

## Windows: one line

1. Click **Start**, type **PowerShell** and open **Windows PowerShell** (no need for "Run as administrator").
2. Copy this line, paste it (right-click pastes) and press Enter:

   ```powershell
   irm https://github.com/MrChartist/api-bridge-v2/releases/latest/download/install.ps1 | iex
   ```

3. Wait a minute or two. It downloads the Bridge (and its own Node.js if needed), sets it up, adds
   **Mr Chartist Bridge** to your Start menu and Desktop, and opens the dashboard, already signed in.

Next time, start it from the **Mr Chartist Bridge** shortcut on your Desktop or in the Start menu.

---

## Android (Termux)

The Bridge runs on an Android phone or tablet inside **Termux**, a free Linux terminal app. Its API and dashboard
are then on the phone itself, at `http://127.0.0.1:4300`.

1. Install **Termux** from [F-Droid](https://f-droid.org/packages/com.termux/) (the Play Store version is outdated).
   Optional: also install **Termux:Widget** from F-Droid for a home-screen shortcut.
2. Open Termux, paste this line and press Enter:

   ```sh
   pkg install -y curl && curl -fsSL https://github.com/MrChartist/api-bridge-v2/releases/latest/download/install.sh | sh
   ```

   It installs Node.js with Termux's own package manager (no root), sets up paper trading and opens the dashboard in
   your browser, already signed in.
3. Keep Termux open while you use the Bridge. Android may pause apps in the background: the Bridge asks for a Termux
   wake lock while it runs, and you can also set Termux to **Unrestricted** under Android Settings → Apps → Termux →
   Battery.

Next time, tap the **Mr Chartist Bridge** widget, or type `mc-bridge start --open` in Termux. Other devices on your
Wi-Fi cannot reach it unless you deliberately allow that in `bridge.config.json`; that is on purpose.

---

## After installing

- **Lost the dashboard tab?** Start the Bridge again from its shortcut (or double-click the start file). If it is
  already running, that simply opens the dashboard again, signed in.
- **Connect your broker:** on the dashboard, open **Accounts**.
- **Try everything with sample prices:** see [demo mode](quickstart.md).
- **Update to a new version:** run the same one line again (your settings and data are kept), or download the new ZIP
  and copy your `bridge.config.json` and `data` folder into the new folder. See [Updating safely](#updating-safely).

## Updating safely

Your settings, API keys, paper books and audit log live in the data folder, not in the program folder, so an update does
not touch them. Two things protect you anyway:

- **A copy before every version change.** The first time a new version starts, the Bridge copies your data to
  `backups/` inside the data folder (before it reads or changes anything) and prints one line with the file name. It
  keeps the newest five. If something looks wrong after an update, stop the Bridge and restore that file; see
  [backup.md](backup.md).
- **A backup you made yourself.** Before an update that matters to you, run `mc-bridge backup --out <file>` and keep the
  file on another disk.

To go back to an older version, install it by number and then restore the copy from before the update:

```sh
curl -fsSL https://github.com/MrChartist/api-bridge-v2/releases/latest/download/install.sh | sh -s -- --version 2.0.0
```

On Windows set the version first: `$env:MCB_VERSION = "2.0.0"` and then run the `irm` line. (A Bridge refuses to restore
a backup made by a newer version than itself, so install the version that made the backup first.)

## Checking that the download is genuine

The one-line installers do not take the newest code from the `main` branch. They download a released version (a file on
that release's page on GitHub) and its list of checksums, `SHA256SUMS.txt`, and check the download against that list
**before** installing anything. If the file does not match, nothing is installed, nothing on your computer changes and
the message says so. Choose a version with `--version 2.0.0` (Mac, Linux, Android) or `MCB_VERSION` (Windows).

What that protects against, in plain words: a download that was cut short or damaged, and one file on the release being
swapped for another. It does **not** protect you if the whole release page were replaced, because the list comes from
the same place. There is no code signature on releases today, so there is nothing more to check than the checksum. If
you want to be sure, take the checksum from a second place you trust (a copy someone sent you, an earlier release you
checked) and give it to the installer:

```sh
curl -fsSL https://github.com/MrChartist/api-bridge-v2/releases/latest/download/install.sh | sh -s -- --version 2.0.0 --sha256 <the 64 characters>
```

On Windows: `$env:MCB_SHA256 = "<the 64 characters>"`. The installer refuses to go on if the release lists a different
value.

**By hand, before you run anything.** Download the installer and the list from the release page, check, then run:

```sh
curl -fsSLO https://github.com/MrChartist/api-bridge-v2/releases/download/v2.0.0/install.sh
curl -fsSLO https://github.com/MrChartist/api-bridge-v2/releases/download/v2.0.0/SHA256SUMS.txt
sha256sum --ignore-missing -c SHA256SUMS.txt      # Mac: shasum -a 256 -c SHA256SUMS.txt (it reports the files it cannot find)
sh install.sh --version 2.0.0
```

On Windows PowerShell: `(Get-FileHash .\install.ps1 -Algorithm SHA256).Hash` and compare it by eye with the line for
`install.ps1` in `SHA256SUMS.txt`. The same works for the ready-to-run ZIP files and the Setup `.exe`: they are all
listed in `SHA256SUMS.txt`.

## Uninstalling

| How you installed | How to remove it |
|---|---|
| One line on Mac or Linux | `curl -fsSL https://github.com/MrChartist/api-bridge-v2/releases/latest/download/install.sh \| sh -s -- --uninstall` (your settings and data stay in `~/.mc-bridge`; add `--purge` to delete them too) |
| One line on Windows | `$env:MCB_UNINSTALL = "1"; irm https://github.com/MrChartist/api-bridge-v2/releases/latest/download/install.ps1 \| iex` (your settings and data stay in `%APPDATA%\MrChartist\Bridge`) |
| Setup.exe on Windows | **Settings → Apps → Installed apps → Mr. Chartist API Bridge → Uninstall** (your settings and data stay in `%APPDATA%\MrChartist\Bridge`) |
| Ready-to-run download | Delete the **Mr Chartist Bridge** folder. **This also deletes your settings and data** (keys, paper accounts, the audit log): the start file keeps `bridge.config.json` and the data folder next to itself. To keep them, copy `bridge.config.json` and the data folder out first, or make a backup with `mc-bridge backup` ([backup.md](backup.md)). |
| Android (Termux) | In Termux: `curl -fsSL https://github.com/MrChartist/api-bridge-v2/releases/latest/download/install.sh \| sh -s -- --uninstall` |

## If something goes wrong

| What you see | What to do |
|---|---|
| "Could not download …" | Check your internet connection and run it again. Office networks sometimes block downloads; try at home. |
| The one-line Windows command is blocked, or says it is disabled | PowerShell's execution policy applies to script files, not to `irm ... \| iex` typed in a window, so it normally does not stop this. A company proxy, antivirus or application-control rule can. Use the [ready-to-run download](#ready-to-run-download), which needs no PowerShell command. This has not been tried against every Windows policy, and no release exists yet to run it against. |
| "STOPPED: … does not match its published checksum" | The download was damaged or changed on the way. Nothing was installed. Run it again; if it fails again, do not install and [open an issue](https://github.com/MrChartist/api-bridge-v2/issues). |
| The browser does not open | Copy the link printed in the small window into your browser. It works once, for 10 minutes; start again for a new one. |
| "Port 4300 is already in use by another program" | Another program uses the Bridge's port. Close it, or change `server.port` in `bridge.config.json`. |
| "This sign-in link has expired or was already used" | Start the Bridge again from its shortcut; it opens a fresh link. |
| Anything else | Run `mc-bridge doctor` (or, in the download folder, the start file again) and [open an issue](https://github.com/MrChartist/api-bridge-v2/issues) with what it prints. Never paste your keys. |

For developers: `git clone`, `npm ci`, `npm run dev`; see the [quickstart](quickstart.md) and [CONTRIBUTING.md](../../CONTRIBUTING.md).
Docker: see the [README](../../README.md#docker).
