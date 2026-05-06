# setup-jfrog

Composite action that mints a short-lived JFrog access token via GitHub OIDC
and configures the local `~/.npmrc` to resolve packages through the internal
mirror at `databricks.jfrog.io/artifactory/api/npm/db-npm/`.

## Provenance

Vendored from the upstream copy at:

- Repo: `databricks-field-eng/pickling-cool-cucumbers`
- Path: `.github/actions/setup-jfrog/action.yml`
- Source commit: `797d93c8bdc546733f5f03e018e8f790b12280b6`

Vendored locally rather than referenced cross-org because the upstream is in a
different (private) org, which makes runtime resolution brittle and
introduces a cross-org dependency that any upstream refactor could break.

## Updating

When the upstream gets a meaningful change, update by:

1. Diffing this `action.yml` against the new upstream source.
2. Reviewing the diff with the same scrutiny as any other workflow change
   (CODEOWNERS gates this directory).
3. Updating the `Source commit:` SHA above.

Don't sync upstream changes blindly — the action runs with `id-token: write`
and the resulting token configures every `npm ci` in the repo.

## Usage

```yaml
- name: Configure JFrog npm registry (OIDC)
  uses: ./.github/actions/setup-jfrog
  with:
    configure-npm: 'true'
    configure-pip: 'false'
    configure-uv: 'false'
    configure-terraform: 'false'
```

Calling job must declare `permissions: id-token: write`.
