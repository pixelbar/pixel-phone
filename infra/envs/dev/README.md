# `envs/dev`

The dev environment: module [`pixel-phone`](../../modules/pixel-phone) in resource group `pixel-phone-dev`, state in container `pixel-phone-dev` of `pixelbartfstate`.

```sh
just tf-plan dev
just tf-apply dev    # maintainers, from a laptop; needs rights to write role assignments
```

The Container App is created with a placeholder image that answers on port 3000. After the first create, deploys own the image (`just deploy dev`, the Deploy dev workflow) and Terraform ignores it.

dev never touches the real siren: its Home Assistant entity is `input_boolean.pixel_phone_ringing_dev`.
