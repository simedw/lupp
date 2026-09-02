# Releasing Lupp

## First release

The first publish creates the npm package. Log in with `npm login`, enable
two-factor authentication on your npm account, then run from a clean checkout:

```sh
npm ci
npm run check
npm test
npm pack
npm publish ./lupp-0.1.0.tgz --access public
```

Inspect the tarball before publishing. Only compiled app code, its HTML/CSS,
package metadata, README, and license should be included. No credentials,
recordings, review notes, tests, or local configuration.

## Later releases

In the npm package's settings, add a **Trusted Publisher** for GitHub Actions:
user `simedw`, repository `lupp`, workflow filename `publish.yml`. Leave the
environment field blank. No npm token needs to be added to GitHub.

From a clean, tested `main` branch:

```sh
npm version patch
git push origin main --follow-tags
gh workflow run publish.yml --ref v0.1.1
```

Use the new version's tag in the last command. The action runs only when manually
dispatched on a tag matching `package.json`, tests and packs the app, installs
the tarball in a fresh directory, and publishes that same tarball. Use `minor`
instead of `patch` for a larger release. Published npm versions cannot be reused.

See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) for setup
and authentication requirements. Keep account 2FA enabled.
