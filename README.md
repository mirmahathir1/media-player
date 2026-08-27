# IMDb

A desktop IMDb browser with a local video library. Videos open in VLC, which
along with ffmpeg and ffprobe is kept inside the project, so nothing has to be
installed on the machine separately.

## Install

Paste this into Terminal. It asks where to put the project, clones it there,
installs everything and leaves an **IMDb.command** launcher on your Desktop:

```sh
curl -fsSL https://raw.githubusercontent.com/mirmahathir1/media-player/master/install.command | bash
```

Node and git need to be present first; the script says so if they are not.

Already have a clone? Double-click `install.command` in the project folder
instead — it installs into that checkout rather than making a new one.

## Run

Double-click **IMDb.command** on the Desktop, or from the project folder:

```sh
npm start
```

Re-running `install.command` is safe at any point: it updates the checkout,
repairs a half-finished `npm install` and rewrites the Desktop launcher.

## Building a .app

`npm run dist` produces a signed-ad-hoc `.app`, `.dmg` and `.zip` under `dist/`
for Apple Silicon. Because the build is not notarized, macOS refuses to open a
downloaded copy, which is why the installer above is the supported route.
