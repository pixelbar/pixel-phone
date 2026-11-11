set dotenv-load

# List recipes
default:
    @just --list

# Install dependencies
[group('develop')]
install:
    pnpm install

# Run pixel-phone locally with hot reload
[group('develop')]
dev:
    pnpm exec tsx watch --env-file-if-exists=.env src/index.ts

# Compile TypeScript to dist/
[group('develop')]
build:
    rm -rf dist
    pnpm exec tsc -p tsconfig.build.json

# Run the compiled build (after `just build`)
[group('develop')]
start:
    node --env-file-if-exists=.env dist/index.js

# Run tests (pass extra args through, e.g. `just test --watch`)
[group('develop')]
test *args:
    pnpm exec vitest run {{args}}

# Run tests with coverage; fails below the thresholds in vitest.config.ts
[group('develop')]
coverage:
    pnpm exec vitest run --coverage

# Lint and check formatting
[group('develop')]
lint:
    pnpm exec biome check .

# Fix formatting and safe lint issues
[group('develop')]
fmt:
    pnpm exec biome check --write .
    -terraform fmt -recursive infra

# Type-check everything, including tests and scripts
[group('develop')]
typecheck:
    pnpm exec tsc --noEmit

# Everything CI runs for the Node app: lint, types, tests with coverage thresholds.
# GitHub skips it when no `check` path changed (.github/path-filters.yml).
[group('develop')]
[doc("Everything CI runs for the Node app: lint, types, tests with coverage thresholds")]
check: lint typecheck coverage

# Fail unless this branch updates CHANGELOG.md vs the base (default origin/main).
# CI sets SKIP_CHANGELOG when the PR has the skip-changelog label.
[group('release')]
[doc("Fail unless this branch updates CHANGELOG.md vs the base (default origin/main)")]
check-changelog *args:
    node scripts/check-changelog.ts {{args}}

# In a merge or rebase that stopped on CHANGELOG.md: keep both sides' [Unreleased]
# entries when that is clearly right, and stage the file. Says why when it won't.
[group('release')]
[doc("Resolve a CHANGELOG.md conflict by keeping both sides' [Unreleased] entries")]
changelog-merge:
    node scripts/merge-changelog.ts --git

# Let git do `just changelog-merge` by itself whenever CHANGELOG.md conflicts
# (this clone only; nothing is committed). Undo: git config --unset merge.changelog.driver
[group('release')]
[doc("Let git run `just changelog-merge` on CHANGELOG.md conflicts (this clone only)")]
changelog-merge-driver:
    git config merge.changelog.name "Keep both sides' CHANGELOG [Unreleased] entries"
    git config merge.changelog.driver "node scripts/merge-changelog.ts %O %A %B"
    grep -qxF 'CHANGELOG.md merge=changelog' "$(git rev-parse --git-path info/attributes)" 2>/dev/null || \
        echo 'CHANGELOG.md merge=changelog' >> "$(git rev-parse --git-path info/attributes)"

# Cut [Unreleased] into a dated version and bump package.json.
# Added → minor; Fixed/Changed → patch. Never major before 1.0.
# `--commit` also creates the release commit and tag (used by the Release workflow).
# `--notes-file PATH` writes the GitHub Release body for the cut (or current) version.
[group('release')]
[doc("Cut [Unreleased] into a dated version and bump package.json")]
bump *args:
    pnpm exec tsx scripts/bump-version.ts {{args}}

# Format-check and validate every Terraform stack (CI runs this when infra/ changes)
[group('terraform')]
tf-validate:
    #!/usr/bin/env bash
    set -euo pipefail
    terraform fmt -check -recursive infra
    for stack in infra/bootstrap infra/envs/*/; do
      [ -d "$stack" ] || continue
      terraform -chdir="$stack" init -backend=false -input=false >/dev/null
      terraform -chdir="$stack" validate
    done

# Run Terraform on the bootstrap stack, e.g. `just tf-bootstrap plan`. Owners only (infra/bootstrap/README.md).
[group('terraform')]
tf-bootstrap *args:
    terraform -chdir=infra/bootstrap init -backend-config=backend.azurerm.example.hcl -input=false >/dev/null
    terraform -chdir=infra/bootstrap {{args}}

# Plan an env stack (dev or prod). Needs Azure CLI signed in. Does not apply.
[group('terraform')]
tf-plan env *args:
    #!/usr/bin/env bash
    set -euo pipefail
    case "{{env}}" in dev|prod) ;; *) echo "env must be dev or prod" >&2; exit 1 ;; esac
    terraform -chdir=infra/envs/{{env}} init -backend-config=backend.azurerm.example.hcl -input=false >/dev/null
    terraform -chdir=infra/envs/{{env}} plan -input=false -var-file=terraform.example.tfvars {{args}}

# Apply an env stack. Maintainers only, from a laptop. Coding agents must not apply
# prod: it refuses unless PIXEL_PHONE_APPLY_PROD=1.
[group('terraform')]
[doc("Apply an env stack (maintainers only; prod needs PIXEL_PHONE_APPLY_PROD=1)")]
tf-apply env *args:
    #!/usr/bin/env bash
    set -euo pipefail
    case "{{env}}" in dev|prod) ;; *) echo "env must be dev or prod" >&2; exit 1 ;; esac
    if [ "{{env}}" = prod ] && [ "${PIXEL_PHONE_APPLY_PROD:-}" != 1 ]; then
      echo "Refusing to apply prod without PIXEL_PHONE_APPLY_PROD=1." >&2
      exit 1
    fi
    terraform -chdir=infra/envs/{{env}} init -backend-config=backend.azurerm.example.hcl -input=false >/dev/null
    terraform -chdir=infra/envs/{{env}} apply -input=false -var-file=terraform.example.tfvars {{args}}

# Validate infra/secrets.manifest.yaml (names only; no Azure login, no values)
[group('config')]
validate-secrets:
    pnpm exec tsx scripts/validate-secrets.ts

# Pull that env's app secrets from Key Vault into .env.<env>, after showing what changes
[group('config')]
secrets-pull env:
    pnpm exec tsx scripts/secrets-sync.ts pull {{env}}

# Push .env.<env>'s app secrets to that env's Key Vault, after showing what changes (never deletes)
[group('config')]
secrets-push env:
    pnpm exec tsx scripts/secrets-sync.ts push {{env}}

# Restart that env's Container App so it reads its secrets again
[group('config')]
restart env:
    #!/usr/bin/env bash
    set -euo pipefail
    case "{{env}}" in dev) rg=pixel-phone-dev ;; prod) rg=pixel-phone-prod ;; *) echo "env must be dev or prod" >&2; exit 1 ;; esac
    revision="$(az containerapp revision list -g "$rg" -n "$rg" --query "[?properties.active].name | [0]" -o tsv)"
    az containerapp revision restart -g "$rg" -n "$rg" --revision "$revision" --only-show-errors -o none
    echo "Restarted $revision."
