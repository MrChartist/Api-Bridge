# Release process

For the maintainers. A release is a version tag; the Release workflow builds the downloads from that tag and publishes them. Nothing here is done by a contributor's pull request, and nothing publishes by itself when you merge.

No release exists yet: the first one has not been tagged. Until it is, the one-line installers and "latest release" links in [install.md](guides/install.md) lead nowhere, and that page says so in one place.

## Version rules

- **The server** follows [SemVer](https://semver.org/): `MAJOR.MINOR.PATCH`. The number lives in `package.json`; the Bridge reports it as `version` in `GET /v1/health`. A tag is that number with a `v`: `v2.1.0`.
- **The API** is versioned by its path: `/v1`. A breaking change to `/v1` waits for `/v2`; changes that need a migration window are written up in [API-DEPRECATIONS.md](API-DEPRECATIONS.md).
- **The documents** `docs/openapi.yaml` and `docs/asyncapi.yaml` carry the server version in `info.version`: they describe the release they ship with.
- **The SDKs** (`sdk/python`, `sdk/node`) are versioned on their own, because they can change without a server release. Each must agree with itself (manifest, `__version__`, User-Agent, README install line).
- `scripts/version-consistency.test.mjs` checks all of this, so a half-finished bump fails the test run.

## Cutting a release

1. **Pick the number** from what is under "Unreleased" in [CHANGELOG.md](../CHANGELOG.md): new features mean a minor bump, only fixes a patch bump. A break in `/v1` is not allowed.
2. **Move the changelog.** Put the lines that are under `## Unreleased` into a new `## X.Y.Z - YYYY-MM-DD` section, directly below an empty `## Unreleased`. Read it once for plain words; it becomes the text of the release page. Preview it:
   ```bash
   node scripts/release/release-notes.mjs vX.Y.Z
   ```
   The script stops with a message if the section is missing or empty, or if lines are still under "Unreleased".
3. **Bump the number** everywhere the test lists: `package.json`, the root entry of `package-lock.json` (name and version), `info.version` in `docs/openapi.yaml` and `docs/asyncapi.yaml`, and the examples in `docs/guides/install.md` and `docs/guides/quickstart.md`. Then `npm run docs:generate` (the Postman collection quotes the OpenAPI version).
4. **Check it all.** `TZ=UTC npx vitest run`, `npm run check:mjs`, `npm run typecheck`, `npm run docs:check`, `npm audit --omit=dev`, and the SDK tests listed in [CONTRIBUTING.md](../CONTRIBUTING.md).
5. **Merge to `main`** by pull request as usual.
6. **Try the build without releasing.** In GitHub: Actions, Release, Run workflow, on `main`. It builds every download, runs the installer against them, starts the Linux download, installs the Windows `.exe` on a real Windows runner, and keeps the files as a workflow artifact for 14 days. The tag-only steps (notes check, publishing) are skipped in this mode. Download the artifact and open it on at least one machine.
7. **Tag**, only after step 6 is green:
   ```bash
   git tag -a vX.Y.Z -m "Mr. Chartist API Bridge X.Y.Z"
   git push origin vX.Y.Z
   ```
   The workflow refuses a tag that does not equal `package.json` or whose notes are missing, builds again, and creates the release with the files, `SHA256SUMS.txt` and the notes from the changelog.
8. **Look at the release page.** The notes read well, `SHA256SUMS.txt` lists every file, `install.sh` and `install.ps1` are attached. Then run the one-line installer from [install.md](guides/install.md) on a clean machine, and remove the "no release yet" notice from that page.

## If something goes wrong

- The workflow failed before publishing: fix on `main`, delete the tag (`git push origin :refs/tags/vX.Y.Z` and `git tag -d vX.Y.Z`), and tag again.
- A release was published with a bad file: delete it on GitHub or mark it a pre-release, and publish a patch version. Do not replace files inside an existing release; people may already have checked them against its `SHA256SUMS.txt`.
- The installers fetch `releases/latest`. Do not publish a release you would not want every new user to install.

## What a release does not do

It does not publish to npm or PyPI: the package is `private` on purpose, and the guides never tell people to run it through `npx`. The Windows `.exe` is not code-signed, and a release carries no signature or provenance statement beyond `SHA256SUMS.txt`; [install.md](guides/install.md) says so.
