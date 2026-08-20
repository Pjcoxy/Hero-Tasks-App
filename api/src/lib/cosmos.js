const { CosmosClient } = require('@azure/cosmos');
const { DefaultAzureCredential } = require('@azure/identity');

const endpoint = process.env.COSMOS_ENDPOINT;
const databaseId = process.env.COSMOS_DATABASE_NAME || 'herotasks';

let client;

// Managed identity in Azure (no keys anywhere — Cosmos DB has disableLocalAuth: true).
// DefaultAzureCredential also picks up `az login` locally if this is ever run outside Azure.
function getClient() {
  if (!client) {
    client = new CosmosClient({ endpoint, aadCredentials: new DefaultAzureCredential() });
  }
  return client;
}

function container(name) {
  return getClient().database(databaseId).container(name);
}

module.exports = { container };
