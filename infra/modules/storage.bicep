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
    // Shared key access is required here: func core tools' zip-deploy package upload
    // needs a real AzureWebJobsStorage connection string to stage the deployment
    // artifact, independent of how the Functions runtime itself authenticates
    // afterward. Confirmed by a real `func azure functionapp publish` failure
    // ("Error creating a Blob container reference... AzureWebJobsStorage is valid")
    // when this was false. This account only ever holds the Function host's own
    // runtime state, never application data (that's Cosmos DB, key-free).
    allowSharedKeyAccess: true
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
  }
}

output storageAccountId string = storageAccount.id
output storageAccountName string = storageAccount.name
@secure()
output connectionString string = 'DefaultEndpointsProtocol=https;AccountName=${storageAccount.name};AccountKey=${storageAccount.listKeys().keys[0].value};EndpointSuffix=${environment().suffixes.storage}'
