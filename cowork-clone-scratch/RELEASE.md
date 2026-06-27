# Release Readiness

This starter kit can build release installers from a version tag with `.github/workflows/release-build.yml`.

## Release Flow

1. Update `package.json` and `src-tauri/tauri.conf.json` to the same version.
2. Run the local checks:

```bash
npm run test:smoke
npm run release:check
npm test
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
```

3. Create and push a version tag:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The workflow builds macOS, Windows, and Linux installers, uploads CI artifacts, and creates a draft GitHub release for tagged builds.

For a local macOS bundle check, run `npm run tauri:build` from `cowork-clone-scratch`. DMG creation uses macOS `hdiutil`, so it may fail inside restricted command sandboxes even when the app and `.app` bundle compile correctly. Run the command in a normal local shell when verifying the DMG.

## Signing Secrets

Unsigned installers are useful for internal testing. Public distribution should configure platform signing secrets before making the draft release public.

Apple notarization:

- `APPLE_CERTIFICATE`
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_ID`
- `APPLE_PASSWORD`
- `APPLE_TEAM_ID`
- `APPLE_SIGNING_IDENTITY`

Windows signing:

- `WINDOWS_CERTIFICATE`
- `WINDOWS_CERTIFICATE_PASSWORD`

Tauri updater signing, when the updater plugin is added:

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

Keep signing credentials in GitHub Actions secrets only. Do not commit local certificates, private keys, or notarization passwords.

## Updater Strategy

The app does not enable auto-update yet. The recommended path is:

1. Ship manual GitHub release downloads first.
2. Add the Tauri updater plugin only after installer signing is green on macOS and Windows.
3. Host updater metadata from GitHub Releases or a small static endpoint.
4. Require signed updater manifests and keep rollback instructions in each release note.

This keeps the starter kit easy to understand while leaving a clean path to production updates.

## Sandbox Status

The current security model is local-first and in-process:

- folder ACLs gate file access
- destructive tools and MCP tools require confirmation by default
- audit logs redact secrets and file contents
- the desktop webview uses a restrictive CSP

This is not an OS-level sandbox. The optional Docker wrapper in `SANDBOX.md` provides a safer path for untrusted project commands and remote MCP experiments, but production isolation should still be reviewed for the target OS, Docker runtime, and threat model.
