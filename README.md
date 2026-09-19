# IMDb

A desktop IMDb browser with a local video library. Videos open in VLC and
magnet links open in WebTorrent, which downloads them into the library folder.

## Requirements

These are outside programs the app runs; it does not install or bundle them,
and it refuses to start until all four are on the machine:

| Program | What it does | Install |
| --- | --- | --- |
| `ffmpeg` | grabs the scene shown on each tile | `brew install ffmpeg` |
| `ffprobe` | reads video length for the progress bar | ships with `ffmpeg` |
| VLC | plays the videos you click | `brew install --cask vlc` |
| WebTorrent | downloads the magnet links you open | `brew install --cask webtorrent` |

Installing by hand works just as well. `ffmpeg` and `ffprobe` are looked for on
`PATH` and in the usual Homebrew and system folders; VLC and WebTorrent in
`/Applications`, `~/Applications`, or wherever Launch Services knows them from.

If any are missing the app opens on a page listing them, with a **Check again**
button that starts the app once they are all installed.

## Install

Paste this into Terminal. It asks where to put the project, clones it there,
installs everything and leaves an **IMDb.command** launcher on your Desktop:

```sh
curl -fsSL https://raw.githubusercontent.com/mirmahathir1/media-player/master/install.command | bash
```

Node and git need to be present first; the script says so if they are not. It
also reports which of the four programs above are missing, but installing them
is up to you.

Already have a clone? Double-click `install.command` in the project folder
instead — it installs into that checkout rather than making a new one.

## Run

Double-click **IMDb.command** on the Desktop, or from the project folder:

```sh
npm start
```

Re-running `install.command` is safe at any point: it updates the checkout,
repairs a half-finished `npm install` and rewrites the Desktop launcher.
