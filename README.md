# FPA macOS

FPA macOS is an independent Mac edition of the FPA design workspace. It contains the same local-first material library, styling workspace, design canvas, generation history, and API settings as the source snapshot used to create it.

This repository is separate from the Windows project. It does not contain the Windows project's local assets, generation history, API keys, or `.env` file.

## Installers

- Apple Silicon (M1/M2/M3/M4 and newer): `FPA-macOS-arm64-<version>.dmg`
- Intel Mac: `FPA-macOS-x64-<version>.dmg`

The app launches a local service and opens FPA in the default browser. The menu bar item can reopen FPA, open its data directory, or stop the local service.

See [MACOS.md](MACOS.md) for build, release, data migration, signing, and notarization details.

## Reference

The two-architecture DMG workflow and user-data separation follow the distribution pattern demonstrated by [iLab CONJURE v0.9.1](https://github.com/kadevin/ilab-conjure/releases/tag/v0.9.1). The launcher and packaging implementation in this repository are purpose-built for FPA.
