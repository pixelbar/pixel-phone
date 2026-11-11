resource "azurerm_log_analytics_workspace" "this" {
  name                = "${local.name_prefix}-logs"
  location            = local.location
  resource_group_name = data.azurerm_resource_group.this.name
  sku                 = "PerGB2018"
  retention_in_days   = var.log_retention_days
  tags                = local.tags
}

resource "azurerm_container_app_environment" "this" {
  name                       = "${local.name_prefix}-cae"
  location                   = local.location
  resource_group_name        = data.azurerm_resource_group.this.name
  logs_destination           = "log-analytics"
  log_analytics_workspace_id = azurerm_log_analytics_workspace.this.id
  tags                       = local.tags
}

resource "azurerm_container_app" "this" {
  name                         = local.name_prefix
  container_app_environment_id = azurerm_container_app_environment.this.id
  resource_group_name          = data.azurerm_resource_group.this.name
  revision_mode                = "Single"
  max_inactive_revisions       = 3

  # Deploys own the running image (az containerapp update, ADR 0003).
  # var.container_image only seeds the first create.
  lifecycle {
    ignore_changes = [template[0].container[0].image]
  }

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.app.id]
  }

  template {
    # Scale to zero between calls (ADR 0003). Never more than one replica: the
    # accept window timer runs in the process.
    min_replicas                     = 0
    max_replicas                     = 1
    termination_grace_period_seconds = 30

    http_scale_rule {
      name                = "http"
      concurrent_requests = "50"
    }

    container {
      name   = "pixel-phone"
      image  = var.container_image
      cpu    = 0.25
      memory = "0.5Gi"

      # Process alive only: a slow dependency must never restart a replica
      # that is waking from zero to take a call.
      liveness_probe {
        transport               = "HTTP"
        port                    = local.port
        path                    = "/healthz"
        interval_seconds        = 30
        timeout                 = 5
        failure_count_threshold = 3
      }

      readiness_probe {
        transport               = "HTTP"
        port                    = local.port
        path                    = "/healthz"
        interval_seconds        = 10
        timeout                 = 3
        failure_count_threshold = 3
        success_count_threshold = 1
      }

      startup_probe {
        transport               = "HTTP"
        port                    = local.port
        path                    = "/healthz"
        interval_seconds        = 1
        timeout                 = 2
        failure_count_threshold = 30
      }

      dynamic "env" {
        for_each = local.app_plain_env
        content {
          name  = env.key
          value = env.value
        }
      }
    }
  }

  ingress {
    external_enabled = true
    target_port      = local.port
    transport        = "auto"

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  tags = local.tags
}
