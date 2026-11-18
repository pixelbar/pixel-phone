# `envs/prod`

The prod environment: module [`pixel-phone`](../../modules/pixel-phone) in resource group `pixel-phone-prod`, state in container `pixel-phone-prod` of `pixelbartfstate`. It answers the real doorbell.

```sh
just tf-plan prod
PIXEL_PHONE_APPLY_PROD=1 just tf-apply prod    # maintainers, from a laptop
```

CI validates this stack but doesn't plan it: Environment `prod` deploys from `main` only and needs an approval ([ADR 0011](../../docs/adr/0011-releases-and-prod.md)).

The Container App is created from `ghcr.io/pixelbar/pixel-phone:main`. After that the Release workflow owns the image and Terraform ignores it.

The whole order of setting prod up is in [Setting up from nothing](../../../docs/setup.md#5-prod).

prod rings the real siren's helper, `input_boolean.pixel_phone_ringing`, and its Key Vault has purge protection.

## `phone.pixelbar.nl`

DNS for `pixelbar.nl` is outside Azure, so the domain is added in two phases:

1. After the first apply, make these records in `pixelbar.nl`'s DNS, from `terraform -chdir=infra/envs/prod output`:

   | Type | Name | Value |
   | --- | --- | --- |
   | `CNAME` | `phone` | the `fqdn` output (`pixel-phone-prod.<something>.westeurope.azurecontainerapps.io`) |
   | `TXT` | `asuid.phone` | the `domain_verification_id` output |

2. When `dig +short CNAME phone.pixelbar.nl` and `dig +short TXT asuid.phone.pixelbar.nl` show them, set `custom_domains = ["phone.pixelbar.nl"]` in `terraform.example.tfvars` and apply again. The apply attaches the hostname, issues a managed certificate and binds it ([`domain.tf`](../../modules/pixel-phone/domain.tf)). It needs the az CLI, signed in.

Check: `curl -sS https://phone.pixelbar.nl/healthz` answers 200 with a valid certificate. Azure renews the certificate by itself while the CNAME stays.
