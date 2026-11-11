variable "subscription_id" {
  type        = string
  description = "Pixelbar's Azure subscription. Not a secret."
  default     = "d150e252-e2f0-47fb-8a4a-c3f29e9aebd4"
}

variable "container_image" {
  type        = string
  description = "Seeds the first create only; deploys own the image afterwards. The placeholder listens on port 3000 (WHOAMI_PORT_NUMBER) until the first real deploy."
  default     = "docker.io/traefik/whoami:v1.11.0"
}

variable "pixel_principal_id" {
  type        = string
  description = "Pixel dev's managed identity (pixel-dev-app), which reads phone-events. Not a secret."
  default     = null
}
