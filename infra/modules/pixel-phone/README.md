# Module `pixel-phone`

One environment of pixel-phone: a Container App (0 to 1 replicas, public ingress on port 3000), its Container Apps environment and Log Analytics, a Key Vault, and a storage account holding the call tables, the `phone-events` queue and the `media` container. See [`docs/infra.md`](../../../docs/infra.md) for who can reach what.

Used by `infra/envs/dev` and, later, `infra/envs/prod`. It deploys into a resource group that `infra/bootstrap` created.
