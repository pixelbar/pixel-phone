variable "subscription_id" {
  type        = string
  description = "Pixelbar's Azure subscription. Not a secret."
  default     = "d150e252-e2f0-47fb-8a4a-c3f29e9aebd4"
}

variable "container_image" {
  type        = string
  description = "Seeds the first create only; deploys own the image afterwards (just deploy dev, Deploy dev)."
  default     = "docker.io/traefik/whoami:v1.11.0"
}

variable "pixel_principal_id" {
  type        = string
  description = "Pixel dev's managed identity (pixel-dev-app), which reads phone-events. Not a secret."
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
