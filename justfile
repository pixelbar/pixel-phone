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
    pnpm exec tsx watch --env-file-if-exists=.env --import ./src/instrument.ts src/index.ts

# Compile TypeScript to dist/
[group('develop')]
build:
    rm -rf dist
    pnpm exec tsc -p tsconfig.build.json

# Run the compiled build (after `just build`)
[group('develop')]
start:
    node --env-file-if-exists=.env --import ./dist/instrument.js dist/index.js

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
secrets-pull env *args:
    pnpm exec tsx scripts/secrets-sync.ts pull {{env}} {{args}}

# Push .env.<env>'s app secrets to that env's Key Vault, after showing what changes (never deletes)
[group('config')]
secrets-push env *args:
    pnpm exec tsx scripts/secrets-sync.ts push {{env}} {{args}}

# Restart that env's Container App so it reads its secrets again
[group('config')]
restart env:
    #!/usr/bin/env bash
    set -euo pipefail
    case "{{env}}" in dev) rg=pixel-phone-dev ;; prod) rg=pixel-phone-prod ;; *) echo "env must be dev or prod" >&2; exit 1 ;; esac
    revision="$(az containerapp revision list -g "$rg" -n "$rg" --query "[?properties.active].name | [0]" -o tsv)"
    az containerapp revision restart -g "$rg" -n "$rg" --revision "$revision" --only-show-errors -o none
    echo "Restarted $revision."

# Build this working tree, push it to GHCR as :<sha> (or dev-dirty-<time>) and :dev, and roll
# pixel-phone-dev onto it. Needs Docker, `az login`, and `gh` with write:packages
# (gh auth refresh -s write:packages). Never prod: prod ships from the Release workflow.
[group('deploy')]
deploy env:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ "{{env}}" != dev ]; then echo "just deploy only does dev. Prod ships from the Release workflow." >&2; exit 1; fi
    image=ghcr.io/pixelbar/pixel-phone
    sha="$(git rev-parse HEAD)"
    tag="$sha"
    if [ -n "$(git status --porcelain)" ]; then tag="dev-dirty-$(date -u +%Y%m%d%H%M%S)"; fi
    # A throwaway Docker config, so the GHCR login never lands in a keychain or ~/.docker
    # (and works where the keychain can't prompt). Deleted on exit.
    export DOCKER_CONFIG="$(mktemp -d)"
    trap 'rm -rf "$DOCKER_CONFIG"' EXIT
    echo '{}' > "$DOCKER_CONFIG/config.json"
    gh auth token | docker login ghcr.io -u "$(gh api user --jq .login)" --password-stdin >/dev/null
    docker buildx build --platform linux/amd64 --push \
      --build-arg PIXEL_PHONE_VERSION="$tag" --build-arg PIXEL_PHONE_GIT_SHA="$sha" \
      -t "$image:$tag" -t "$image:dev" .
    if docker run --rm --platform linux/amd64 --entrypoint sh "$image:$tag" -c 'test -e /app/.env || ls /app/.env.* >/dev/null 2>&1'; then
      echo "Image $image:$tag contains an env file. Not deploying it." >&2; exit 1
    fi
    app="$(az containerapp show -g pixel-phone-dev -n pixel-phone-dev --query "properties.template.containers[0].env[?name=='PIXEL_PHONE_ENV'].value | [0]" -o tsv)"
    if [ "$app" != dev ]; then echo "pixel-phone-dev doesn't say PIXEL_PHONE_ENV=dev (got '$app'). Refusing." >&2; exit 1; fi
    az containerapp update -g pixel-phone-dev -n pixel-phone-dev --image "$image:$tag" --min-replicas 0 --max-replicas 1 --only-show-errors -o none
    fqdn="$(az containerapp show -g pixel-phone-dev -n pixel-phone-dev --query properties.configuration.ingress.fqdn -o tsv)"
    echo "Rolled pixel-phone-dev to $image:$tag"
    for i in $(seq 1 30); do
      if curl -fsS "https://$fqdn/version" | grep -q "\"$tag\""; then curl -fsS "https://$fqdn/version"; echo; exit 0; fi
      sleep 5
    done
    echo "pixel-phone-dev didn't report $tag within 150 s. Check the revision in the portal." >&2; exit 1

# Run the Deploy dev workflow for a branch, SHA or pull request number (default: this branch)
[group('deploy')]
deploy-remote env ref="":
    #!/usr/bin/env bash
    set -euo pipefail
    if [ "{{env}}" != dev ]; then echo "Only dev deploys from a branch." >&2; exit 1; fi
    ref="{{ref}}"; [ -n "$ref" ] || ref="$(git branch --show-current)"
    gh workflow run deploy-dev.yml --ref main -f ref="$ref"
    echo "Started Deploy dev for $ref: gh run list --workflow deploy-dev.yml"
