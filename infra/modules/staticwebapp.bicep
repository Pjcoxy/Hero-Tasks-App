@description('Deployment environment suffix (for example: dev or prod).')
param env string

@description('Azure region for the Static Web App.')
param location string

@description('Azure Static Web App SKU. Free is sufficient at this scale.')
@allowed(['Free'])
param sku string = 'Free'

@description('Resource ID of the Function App to link as this Static Web App\'s backend (shares auth/CORS automatically, no manual CORS config needed on the frontend side).')
param linkedFunctionAppId string

@description('Region the linked Function App is deployed in.')
param linkedFunctionAppLocation string

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

resource linkedBackend 'Microsoft.Web/staticSites/linkedBackends@2024-04-01' = {
  parent: staticWebApp
  name: 'herotasks-api'
  properties: {
    backendResourceId: linkedFunctionAppId
    region: linkedFunctionAppLocation
  }
}

@secure()
output staticWebAppDeploymentToken string = staticWebApp.listSecrets().properties.apiKey
output staticWebAppName string = staticWebAppName
output staticWebAppDefaultHostname string = staticWebApp.properties.defaultHostname
