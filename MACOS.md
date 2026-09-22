# FPA macOS

This is an independent macOS snapshot of FPA. It does not read from or write to the Windows project directory.

## Outputs

The build matrix creates two installers:

- `FPA-macOS-arm64-<version>.dmg` for Apple Silicon Macs (M1 and newer)
- `FPA-macOS-x64-<version>.dmg` for Intel Macs

## Build with GitHub Actions

1. Create a new GitHub repository from this directory.
2. Open **Actions > Build FPA for macOS > Run workflow**.
3. Download both artifacts after the workflow finishes.

Pushing a tag such as `v1.0.0` builds both installers and attaches them to a GitHub Release.

## Build on a Mac

Requirements: macOS 12+, Xcode Command Line Tools, Node.js 22, and npm.

```bash
npm run verify:macos
bash packaging/macos/build-app.sh --version 1.0.0
```

The DMG and SHA-256 checksum are written to `dist-macos/`.

## Data and secrets

The installer never includes `.env`, API keys, assets, or generation history. Each Mac stores its own data at:

```text
~/Library/Application Support/FPA
```

To migrate an existing Windows library, copy only the contents of the old portable `data` directory into that directory while FPA is closed. API settings should be entered again in System Settings.

## Distribution status

The generated app is ad-hoc signed for local testing. Public distribution without Gatekeeper warnings requires an Apple Developer ID certificate and Apple notarization. Those credentials are intentionally not stored in this project.
