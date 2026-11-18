variable "subscription_id" {
  type        = string
  description = "Pixelbar's Azure subscription. Not a secret."
  default     = "d150e252-e2f0-47fb-8a4a-c3f29e9aebd4"
}

variable "recording_accepted" {
  type        = string
  description = "The accept recording's blob name in prod's media container."
  default     = "accepted.mp3"
}

variable "container_image" {
  type        = string
  description = "Seeds the first create only; the Release workflow owns the image afterwards."
  default     = "ghcr.io/pixelbar/pixel-phone:main"
}

variable "custom_domains" {
  type        = set(string)
  description = "Hostnames with a managed certificate. Add phone.pixelbar.nl only once its DNS records exist (README)."
  default     = []
}

variable "pixel_principal_id" {
  type        = string
  description = "Pixel prod's managed identity, which reads phone-events. Not a secret."
  default     = null
}

variable "telnyx_enabled" {
  type    = bool
  default = false
}

variable "home_assistant_url" {
  type    = string
  default = null
}

variable "accept_api_enabled" {
  type    = bool
  default = false
}

variable "sentry_enabled" {
  type    = bool
  default = false
}

variable "maintainer_principal_ids" {
  type        = map(string)
  description = "Maintainers who may push secrets and recordings to prod, as name => Entra ID user object ID. Not secrets."
  default     = {}
}
