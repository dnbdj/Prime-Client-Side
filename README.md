# Prime

Prime is split into two repositories:

| Half | Repository | What it is |
| --- | --- | --- |
| Client side | [dnbdj/Prime-Client-Side](https://github.com/dnbdj/Prime-Client-Side) | This repo — the Electron launcher: instances, loaders, accounts, mods |
| Server side | [dnbdj/Prime-Server-Side](https://github.com/dnbdj/Prime-Server-Side) | The Fabric server mod that runs on a Prime server |

The launcher's instance setup offers a **Prime mod** option; the jar it installs is
built from the server-side repository.

## Run the launcher

```sh
npm install
npm run dev      # Vite renderer + Electron
npm start        # production build, then Electron
npm run typecheck
```

Releases are cut with `npm run release:minor` / `npm run release:major`; see
[VERSIONS.md](VERSIONS.md).
