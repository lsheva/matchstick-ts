# Releasing

`matchstick-ts` and `hardhat-matchstick-ts` are independently versioned public npm packages.
Changesets prepares versions and changelogs; GitHub Actions validates packed artifacts and
publishes them.

## One-time npm bootstrap

npm requires a package to exist before its trusted publisher can be configured. The first
`0.4.2` release therefore uses a temporary granular npm token from GitHub Actions.

1. Push the repository and `.github/workflows/release.yml` to `lsheva/matchstick-ts` on GitHub.
2. In **Settings → Actions → General**, allow GitHub Actions to create pull requests.
3. Enable two-factor authentication on the npm account and create a **Granular Access Token**
   (profile → **Access Tokens** → **Generate New Token**). The defaults do not work from CI:

   - **Bypass two-factor authentication**: checked. It defaults to _off_; without it npm demands an
     interactive OTP for the write, which CI cannot provide, and the run fails with
     `ERR_PNPM_OTP_NON_INTERACTIVE`.
   - **Permissions**: **Read and write (publish and stage)**. _Stage only_ rejects a direct publish
     with `E_STAGE_REQUIRED`.
   - **Packages**: **All Packages**. The two names are not in the registry yet, so they cannot be
     selected individually.
   - A short expiry — the token is deleted in step 8.

   npm is deprecating direct publishing with bypass-2FA tokens. The trusted publisher configured in
   step 7 replaces it for every later release.

4. Add the token as the GitHub Actions secret `NPM_TOKEN`.
5. Confirm that both names are still available:

   ```sh
   npm view matchstick-ts
   npm view hardhat-matchstick-ts
   ```

   Both commands should return `E404` before the first publication.

6. In GitHub Actions, run the **Release** workflow manually with `bootstrap` enabled. It runs all
   checks, publishes both `0.4.2` packages with provenance, and pushes their tags.
7. On npmjs.com, open each package's settings and add the same trusted publisher:
   - Provider: GitHub Actions
   - Organization or user: `lsheva`
   - Repository: `matchstick-ts`
   - Workflow: `release.yml`
   - Allowed action: `npm publish`
8. Delete the `NPM_TOKEN` GitHub secret.
9. Add the GitHub Actions repository variable `NPM_TRUSTED_PUBLISHING` with the value `true`.

The release workflow ignores normal pushes until that variable is enabled, preventing an
unauthenticated publication attempt during bootstrap.

`hardhat-matchstick-ts` depends on `matchstick-ts`; changesets bumps that range automatically, and
the bootstrap publishes both packages in dependency order.

## Normal release

1. Add a changeset with the code change:

   ```sh
   pnpm changeset
   ```

   Select each affected package, choose `patch`, `minor`, or `major`, and describe the
   consumer-visible change. Documentation, tests, and internal tooling do not need a changeset.

2. Commit the generated `.changeset/*.md` file with the change and open a pull request.
3. Merge after CI passes.
4. The release workflow creates or updates the **Version packages** pull request. Review its version
   bumps and changelogs, then merge it.
5. The next release run builds and validates the packages, packs the exact tarballs, publishes
   through npm trusted publishing, and creates git tags and GitHub releases.

No npm token is used after bootstrap. npm attaches provenance automatically through GitHub's OIDC
identity.

## Troubleshooting

- `ERR_PNPM_OTP_NON_INTERACTIVE` during the bootstrap — the `NPM_TOKEN` token is missing
  **Bypass two-factor authentication**. Recreate it as described in step 3.
- `E_STAGE_REQUIRED` — the token is **stage only**. Regenerate it with **Read and write (publish and
  stage)**.

## Local verification

Run the same validation used before publication:

```sh
pnpm check
```

This covers type checking, package builds, `matchstick-ts` unit tests, and the `packages/example`
integration suite.
