@description('Deployment environment suffix (for example: dev or prod).')
param env string

@description('Azure region for the storage account.')
param location string

@description('Storage account SKU name.')
param storageSkuName string = 'Standard_LRS'

// Storage account names cannot include hyphens, so the conventional name is normalized.
// This account backs the Function App's own runtime state (AzureWebJobsStorage) only —
// application data lives in Cosmos DB, not here.
var storageAccountName = toLower(replace('herotasksstorage${env}', '-', ''))

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  kind: 'StorageV2'
  sku: {
    name: storageSkuName
  }
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
  }
}

output storageAccountId string = storageAccount.id
output storageAccountName string = storageAccount.name
