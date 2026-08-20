@description('Deployment environment suffix (for example: dev or prod).')
param env string

@description('Azure region for the Static Web App.')
param location string

@description('Azure Static Web App SKU. Free is sufficient at this scale. Note: linkedBackends (linking a separate Function App as this SWA\'s backend) requires the Standard tier — not used here on purpose, to stay on Free. The frontend calls the Function App directly by its own hostname instead; CORS on the Function App (see functionapp.bicep) covers this.')
@allowed(['Free'])
param sku string = 'Free'

var staticWebAppName = 'herotasks-swa-${env}'

resource staticWebApp 'Microsoft.Web/staticSites@2024-04-01' = {
  name: staticWebAppName
  location: location
  sku: {
    name: sku
    tier: sku
  }
  properties: {
    provider: 'None'
  }
}

@secure()
output staticWebAppDeploymentToken string = staticWebApp.listSecrets().properties.apiKey
output staticWebAppName string = staticWebAppName
output staticWebAppDefaultHostname string = staticWebApp.properties.defaultHostname
