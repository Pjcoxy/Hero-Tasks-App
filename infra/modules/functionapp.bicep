@description('Deployment environment suffix (for example: dev or prod).')
param env string

@description('Azure region for the Function App and its hosting plan.')
param location string

@description('Storage account name backing the Function host runtime state.')
param storageAccountName string

@description('Function worker runtime value (for example node, dotnet-isolated, python).')
param workerRuntime string = 'node'

@description('Linux runtime stack for the Function App.')
param linuxFxVersion string = 'Node|20'

@description('Cosmos DB account endpoint the API reads/writes household data through.')
param cosmosEndpoint string

@description('Cosmos DB database name.')
param cosmosDatabaseName string = 'herotasks'

@description('Key Vault secret URI for the voice-intent LLM API key.')
param llmApiKeySecretUri string

var functionAppName = 'herotasks-func-${env}'
var hostingPlanName = 'herotasks-plan-${env}'

resource hostingPlan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: hostingPlanName
  location: location
  kind: 'linux'
  sku: {
    name: 'Y1'
    tier: 'Dynamic'
  }
  properties: {
    reserved: true
  }
}

resource functionApp 'Microsoft.Web/sites@2023-12-01' = {
  name: functionAppName
  location: location
  kind: 'functionapp,linux'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: hostingPlan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: linuxFxVersion
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      cors: {
        // Tightened to the real Static Web App hostname once known; '*' is fine while
        // the SWA-linked-backend wiring (below, in main.bicep) also covers auth passthrough.
        allowedOrigins: ['*']
      }
      appSettings: [
        {
          name: 'FUNCTIONS_EXTENSION_VERSION'
          value: '~4'
        }
        {
          name: 'FUNCTIONS_WORKER_RUNTIME'
          value: workerRuntime
        }
        {
          name: 'COSMOS_ENDPOINT'
          value: cosmosEndpoint
        }
        {
          name: 'COSMOS_DATABASE_NAME'
          value: cosmosDatabaseName
        }
        {
          name: 'LLM_API_KEY'
          value: '@Microsoft.KeyVault(SecretUri=${llmApiKeySecretUri})'
        }
        {
          name: 'AzureWebJobsStorage__accountName'
          value: storageAccountName
        }
        {
          name: 'AzureWebJobsStorage__credential'
          value: 'managedidentity'
        }
      ]
    }
  }
}

output functionAppId string = functionApp.id
output functionAppName string = functionApp.name
output functionPrincipalId string = functionApp.identity.principalId
output functionDefaultHostname string = functionApp.properties.defaultHostName
