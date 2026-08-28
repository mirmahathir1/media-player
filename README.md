# IMDb

A desktop IMDb browser with a local video library. Videos open in VLC and
magnet links open in WebTorrent, which downloads them into the library folder.
Both apps, along with ffmpeg and ffprobe, are kept inside the project and run
as outside programs, so nothing has to be installed on the machine separately.

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
