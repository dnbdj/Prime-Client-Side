# Versions

## Version numbers and GitHub releases

Releases use whole numbers for majors and decimals for minors:

- first major release: **1**
- each minor change after it: **1.1**, **1.2**, …
- next major change: **2**, then **2.1**, …

`package.json` carries the semver equivalent (`1.0.0`, `1.1.0`, `2.0.0`) because npm
requires three parts; the tag and GitHub release drop the trailing `.0`.

Cut a release with one command; it bumps `package.json` and the lockfile,
commits, tags `v<version>`, pushes `main` and the tag, and opens the GitHub
release with notes taken from commits since the previous version tag:

```sh
npm run release:minor   # 1.0 -> 1.1
npm run release:major   # 1.1 -> 2
```

Major numbers are reserved for breaking or era-changing work. Everything else
that ships is a decimal bump. The `milestone-NN` tags below are the raw commit
history from before numbered releases existed; they stay in place for archaeology.

## Pre-versioning snapshots

This project originally had no package version bumps: `package.json` has read `0.1.0` since
the first commit, and there are no changelog or release files in the history.
To make each earlier build checkable on GitHub, every commit is tagged in
chronological order as `milestone-01` … `milestone-18`.

The scheme is deliberately not semver — no real version numbers were ever
declared. `milestone-NN` means "the NNth snapshot of the launcher", in commit
order. Check one out with `git checkout milestone-NN`. Work after
`milestone-18` is unreleased and carries no tag.

| Tag | Commit | Date | What changed |
| --- | --- | --- | --- |
| `milestone-01` | `2cc0462` | 2026-11-25 | Initial launcher: Mojang install pipeline, Electron shell, Modrinth-style UI |
| `milestone-02` | `1e396b4` | 2026-11-25 | Multiple launcher instances, per-version JVM flags, update checks |
| `milestone-03` | `bae0013` | 2026-11-25 | A real Minecraft launch works; version manifest is cached |
| `milestone-04` | `460be78` | 2026-11-25 | Fetches the exact Java runtime a version asks for |
| `milestone-05` | `3265ba9` | 2026-11-25 | Real Fabric and Forge profiles |
| `milestone-06` | `1fc33ad` | 2026-11-25 | Home shows recently played instances instead of latest releases |
| `milestone-07` | `690702a` | 2026-11-25 | Account chip widened into a pill with an account menu |
| `milestone-08` | `eac77ed` | 2026-11-25 | Versions list replaced by an Instances page with a drill-down mind map |
| `milestone-09` | `a1c73bc` | 2026-11-25 | Mind map root anchored to the first release family |
| `milestone-10` | `f4615a9` | 2026-11-25 | Five-step instance setup wizard with dot pagination |
| `milestone-11` | `e0de438` | 2026-11-25 | Chosen loader is installed during instance setup |
| `milestone-12` | `0335c22` | 2026-11-25 | Every loader listed in the setup picker |
| `milestone-13` | `3af015f` | 2026-11-25 | Settings gets horizontal tabs and a single-choice after-launch behaviour |
| `milestone-14` | `97bf9e8` | 2026-11-25 | Game stays alive when the launcher closes |
| `milestone-15` | `ed79f6d` | 2026-11-25 | Loader picker no longer reflows when hovered or touched |
| `milestone-16` | `464d0d3` | 2026-11-25 | Per-instance Play button and instance edit page |
| `milestone-17` | `bb7efc8` | 2026-11-25 | Each instance keeps its mods in its own game folder |
| `milestone-18` | `c2b574e` | 2026-11-25 | Instances keyed by record id, so same-version instances stay isolated |
