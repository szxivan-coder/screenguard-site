#!/usr/bin/env node

const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');

const bundleId = 'com.screenautoon.app';
const productIds = [
  'com.screenguard.pro.annual',
  'com.screenguard.pro.monthly'
];

function readSecret(service) {
  return execFileSync(
    'security',
    ['find-generic-password', '-a', process.env.USER, '-s', service, '-w'],
    { encoding: 'utf8' }
  ).trim();
}

function base64url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function createJWT() {
  const keyId = readSecret('screenautoon.asc.key_id');
  const issuerId = readSecret('screenautoon.asc.issuer_id');
  const p8Path = readSecret('screenautoon.asc.p8_path');
  const privateKey = fs.readFileSync(p8Path, 'utf8');
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'ES256', kid: keyId, typ: 'JWT' };
  const payload = {
    iss: issuerId,
    iat: now,
    exp: now + 20 * 60,
    aud: 'appstoreconnect-v1'
  };
  const data = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = crypto.sign('SHA256', Buffer.from(data), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363'
  });
  return `${data}.${base64url(signature)}`;
}

const token = createJWT();

function appStoreConnectGET(urlPath) {
  return new Promise((resolve, reject) => {
    const request = https.request({
      hostname: 'api.appstoreconnect.apple.com',
      path: urlPath,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` }
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        body += chunk;
      });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`${response.statusCode} ${urlPath}\n${body.slice(0, 1000)}`));
          return;
        }
        resolve(JSON.parse(body));
      });
    });
    request.on('error', reject);
    request.end();
  });
}

async function getAll(urlPath) {
  const output = { data: [], included: [] };
  let next = urlPath;
  while (next) {
    const url = next.startsWith('https://') ? new URL(next) : null;
    const response = await appStoreConnectGET(url ? `${url.pathname}${url.search}` : next);
    output.data.push(...(response.data || []));
    output.included.push(...(response.included || []));
    next = response.links?.next || null;
  }
  return output;
}

function formatPrice(amount, currency) {
  const numericAmount = Number(amount);
  const fractionDigits = Number.isInteger(numericAmount)
    ? { minimumFractionDigits: 0, maximumFractionDigits: 0 }
    : { minimumFractionDigits: 2, maximumFractionDigits: 3 };

  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    currencyDisplay: 'narrowSymbol',
    ...fractionDigits
  })
    .format(numericAmount)
    .replace(/\u00a0/g, ' ');
}

function mapPrices(response) {
  const included = new Map((response.included || []).map(item => [`${item.type}:${item.id}`, item]));
  const prices = {};

  for (const row of response.data || []) {
    const territoryRef = row.relationships?.territory?.data;
    const pricePointRef = row.relationships?.subscriptionPricePoint?.data;
    const territory = territoryRef && included.get(`${territoryRef.type}:${territoryRef.id}`);
    const pricePoint = pricePointRef && included.get(`${pricePointRef.type}:${pricePointRef.id}`);
    const territoryCode = territory?.id || territory?.attributes?.territoryCode;
    const currency = territory?.attributes?.currency;
    const amount = pricePoint?.attributes?.customerPrice;

    if (!territoryCode || !currency || amount == null) {
      continue;
    }

    prices[territoryCode] = {
      currency,
      amount: String(amount),
      display: formatPrice(amount, currency)
    };
  }

  return prices;
}

async function main() {
  const apps = await appStoreConnectGET(`/v1/apps?filter%5BbundleId%5D=${bundleId}&limit=10`);
  const appId = apps.data?.[0]?.id;
  if (!appId) {
    throw new Error(`App not found for bundle id ${bundleId}`);
  }

  const groups = await getAll(`/v1/apps/${appId}/subscriptionGroups?include=subscriptions&limit=200`);
  const subscriptions = (groups.included || [])
    .filter(item => item.type === 'subscriptions')
    .filter(subscription => productIds.includes(subscription.attributes?.productId))
    .sort((a, b) => a.attributes.productId.localeCompare(b.attributes.productId));

  const catalog = {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: 'app-store-connect-api',
    appId,
    products: {}
  };

  for (const subscription of subscriptions) {
    const productId = subscription.attributes.productId;
    const currentPrices = mapPrices(await getAll(`/v1/subscriptions/${subscription.id}/prices?include=territory,subscriptionPricePoint&limit=200`));
    const introductoryOffers = mapPrices(await getAll(`/v1/subscriptions/${subscription.id}/introductoryOffers?include=territory,subscriptionPricePoint&limit=200`));
    const territories = {};

    for (const territoryCode of Array.from(new Set([
      ...Object.keys(currentPrices),
      ...Object.keys(introductoryOffers)
    ])).sort()) {
      territories[territoryCode] = {
        currency: currentPrices[territoryCode]?.currency || introductoryOffers[territoryCode]?.currency,
        current: currentPrices[territoryCode]
          ? {
              amount: currentPrices[territoryCode].amount,
              display: currentPrices[territoryCode].display
            }
          : null,
        introductoryOffer: introductoryOffers[territoryCode]
          ? {
              amount: introductoryOffers[territoryCode].amount,
              display: introductoryOffers[territoryCode].display
            }
          : null
      };
    }

    catalog.products[productId] = {
      subscriptionId: subscription.id,
      territories
    };
  }

  const outputPath = path.join(__dirname, '..', 'subscription-prices.json');
  fs.writeFileSync(outputPath, `${JSON.stringify(catalog, null, 2)}\n`);
  console.log(`Wrote ${outputPath}`);
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
