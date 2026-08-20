@description('Deployment environment. Supported values are dev and prod.')
@allowed(['dev', 'prod'])
param env string

@description('Azure region where all resources are deployed.')
param location string = resourceGroup().location

@description('Function worker runtime value (for example node, dotnet-isolated, python).')
param functionWorkerRuntime string = 'node'

@description('Function App Linux runtime stack value (for example Node|20).')
param functionLinuxFxVersion string = 'Node|20'

@description('Azure Static Web App SKU. Free (F1) is sufficient for this project.')
@allowed(['Free'])
param staticWebAppSku string = 'Free'

@description('Azure region for the Static Web App. Static Web Apps only runs in a small subset of regions (independent of where everything else is deployed) — allowed values are exactly the regions Azure currently supports for this resource type.')
@allowed(['centralus', 'eastus2', 'westus2', 'westeurope', 'eastasia'])
param staticWebAppLocation string = 'eastasia'

@description('Optional secure value for seeding the llm-api-key secret in Key Vault (the voice-note intent-validation LLM).')
@secure()
param llmApiKey string = ''

@description('Built-in Storage Blob Data Contributor role definition ID.')
param storageBlobDataContributorRoleDefinitionId string = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'

@description('Enable public network access to Key Vault. Defaults to false (security-by-default). Only enable if explicitly required; prefer private endpoints for production.')
param enableKeyVaultPublicAccess bool = false

@description('Shared throughput (RU/s) for the Cosmos DB database.')
param cosmosSharedThroughput int = 400

var storageAccountName = toLower(replace('herotasksstorage${env}', '-', ''))
var functionAppName = 'herotasks-func-${env}'
var keyVaultName = 'herotasks-kv-${env}'
var keyVaultDnsSuffix = environment().suffixes.keyvaultDns
var llmApiKeySecretUri = 'https://${keyVaultName}.${keyVaultDnsSuffix}/secrets/llm-api-key/'
var cosmosAccountName = toLower(replace('herotasks-cosmos-${env}', '-', ''))
var cosmosEndpoint = 'https://${cosmosAccountName}.documents.azure.com:443/'
var cosmosDatabaseName = 'herotasks'

module storage './modules/storage.bicep' = {
  name: 'storage-${env}'
  params: {
    env: env
    location: location
  }
}

module functionApp './modules/functionapp.bicep' = {
  name: 'function-${env}'
  params: {
    env: env
    location: location
    storageConnectionString: storage.outputs.connectionString
    workerRuntime: functionWorkerRuntime
    linuxFxVersion: functionLinuxFxVersion
    cosmosEndpoint: cosmosEndpoint
    cosmosDatabaseName: cosmosDatabaseName
    llmApiKeySecretUri: llmApiKeySecretUri
  }
}

module keyVault './modules/keyvault.bicep' = {
  name: 'keyvault-${env}'
  params: {
    env: env
    location: location
    functionPrincipalId: functionApp.outputs.functionPrincipalId
    llmApiKey: llmApiKey
    enablePublicNetworkAccess: enableKeyVaultPublicAccess
  }
}

module cosmos './modules/cosmosdb.bicep' = {
  name: 'cosmos-${env}'
  params: {
    env: env
    location: location
    functionPrincipalId: functionApp.outputs.functionPrincipalId
    databaseName: cosmosDatabaseName
    sharedThroughput: cosmosSharedThroughput
  }
}

module staticWebApp './modules/staticwebapp.bicep' = {
  name: 'staticwebapp-${env}'
  params: {
    env: env
    location: staticWebAppLocation
    sku: staticWebAppSku
  }
}

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}

// RBAC: also grant the Function App's managed identity "Storage Blob Data Contributor"
// on its own runtime storage account, alongside the connection string in
// AzureWebJobsStorage (see storage.bicep for why a real connection string is needed —
// func core tools' zip-deploy package upload requires one). Harmless belt-and-suspenders:
// any future binding that supports identity-based auth can use this instead of the key.
resource functionStorageBlobDataContributorRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storageAccountName, functionAppName, storageBlobDataContributorRoleDefinitionId)
  scope: storageAccount
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataContributorRoleDefinitionId)
    principalId: functionApp.outputs.functionPrincipalId
    principalType: 'ServicePrincipal'
  }
}

output storageAccountName string = storage.outputs.storageAccountName
output keyVaultName string = keyVault.outputs.keyVaultName
output functionAppName string = functionApp.outputs.functionAppName
output cosmosAccountName string = cosmos.outputs.cosmosAccountName
output cosmosEndpoint string = cosmosEndpoint
output cosmosDatabaseName string = cosmosDatabaseName
@secure()
output staticWebAppDeploymentToken string = staticWebApp.outputs.staticWebAppDeploymentToken
output staticWebAppName string = staticWebApp.outputs.staticWebAppName
output staticWebAppDefaultHostname string = staticWebApp.outputs.staticWebAppDefaultHostname
