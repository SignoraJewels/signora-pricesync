#!/usr/bin/env node
/**
 * Signora Jewels — Ring Price Sync  (v2, matches your Manufacturing Cost Report)
 * ----------------------------------------------------------------------------
 * Computes every Metal x Carat variant price using your real costing formula
 * and writes the result (in USD) to the product's variants.
 *
 *   FORMULA (per variant), matching SignoraDb cost report:
 *     pure_gold_g   = alloy_weight_g[metal] * (touch%[karat] / 100)
 *     gold_cost_INR = pure_gold_g * gold_24k_rate_inr
 *     diamond_INR   = carat * diamond_usd_per_ct[carat] * usd_to_inr
 *     labor_INR     = (gold_cost_INR + diamond_INR) * (labor_pct / 100)
 *     total_cost    = gold_cost_INR + diamond_INR + labor_INR
 *     listing_INR   = total_cost * markup_multiplier      (per-product)
 *     price_USD     = round( listing_INR / usd_to_inr )
 *
 *   DATA SOURCES (all editable in Shopify admin):
 *     - Global rates  -> metaobject "signora_pricing_rates" (Content > Metaobjects)
 *     - Per metal wt  -> product metafield sjw.metal_weights (JSON keyed by exact metal value)
 *     - Markup        -> product metafield sjw.markup_multiplier
 *     - touch% per karat is in the rates metaobject (touch_9k/10k/14k/18k)
 *
 * SETUP + RUN: see sync-setup-guide.md.
 *   Preview:  node sync-prices.js --dry-run
 *   Apply:    node sync-prices.js
 * ----------------------------------------------------------------------------
 */

import 'dotenv/config';
import fetch from 'node-fetch';

// === CONFIG ===========================================================
const STORE = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_TOKEN;
const API_VERSION = '2025-07';
const DRY_RUN = process.argv.includes('--dry-run');

// Which products to price. Use the TEST product handle while verifying.
const PRODUCT_HANDLES = [
  'emerald-halo-ring-customizer-test',
  // 'emerald-cut-lab-grown-diamond-halo-engagement-ring-with-pave-band', // live (later)
];

// metal value -> karat key for touch% lookup
function karatKey(metalValue) {
  const v = String(metalValue).toLowerCase();
  if (v.includes('9k'))  return '9k';
  if (v.includes('10k')) return '10k';
  if (v.includes('14k')) return '14k';
  if (v.includes('18k')) return '18k';
  if (v.includes('22k')) return '22k';
  return null;
}

// carat number -> the rates field key, e.g. 1.5 -> "diamond_usd_1_5"
function caratRateKey(carat) {
  const oneDp = carat.toFixed(1);
  return 'diamond_usd_' + oneDp.replace('.', '_');
}
function caratOf(caratValue) {
  const m = String(caratValue).match(/[\d.]+/);
  return m ? parseFloat(m[0]) : null;
}
// ======================================================================

if (!STORE || !TOKEN) {
  console.error('Missing SHOPIFY_STORE or SHOPIFY_TOKEN. Create a .env file (see sync-setup-guide.md).');
  process.exit(1);
}
const ENDPOINT = `https://${STORE}/admin/api/${API_VERSION}/graphql.json`;

async function gql(query, variables = {}) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': TOKEN },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error('GraphQL error: ' + JSON.stringify(json.errors, null, 2));
  return json.data;
}

// --- 1. Global rates --------------------------------------------------
async function getRates() {
  const data = await gql(`
    query {
      metaobjectByHandle(handle: {type: "signora_pricing_rates", handle: "default"}) {
        fields { key value }
      }
    }`);
  if (!data.metaobjectByHandle) throw new Error('signora_pricing_rates metaobject not found.');
  const f = {};
  data.metaobjectByHandle.fields.forEach((x) => (f[x.key] = parseFloat(x.value)));
  return f;
}

// --- 2. Product + variants + per-product metafields -------------------
async function getProduct(handle) {
  const data = await gql(`
    query($handle: String!) {
      productByHandle(handle: $handle) {
        id title
        markup: metafield(namespace: "sjw", key: "markup_multiplier") { value }
        weights: metafield(namespace: "sjw", key: "metal_weights") { value }
        variants(first: 250) {
          edges { node { id selectedOptions { name value } } }
        }
      }
    }`, { handle });
  return data.productByHandle;
}

// --- 3. The formula ---------------------------------------------------
function computeUsd(rates, alloyG, karat, carat, markup) {
  const touch = rates['touch_' + karat];
  const dRate = rates[caratRateKey(carat)];
  if (touch == null || dRate == null) return null;
  const pureGold   = alloyG * (touch / 100);
  const goldInr    = pureGold * rates.gold_24k_rate_inr;
  const diamondInr = carat * dRate * rates.usd_to_inr;
  const laborInr   = (goldInr + diamondInr) * (rates.labor_pct / 100);
  const totalCost  = goldInr + diamondInr + laborInr;
  const listingInr = totalCost * markup;
  const usd        = listingInr / rates.usd_to_inr;
  return Math.round(usd * 100) / 100;
}

// --- 4. Write prices in batches of 100 --------------------------------
async function updatePrices(productId, updates) {
  const MUT = `
    mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        userErrors { field message }
      }
    }`;
  for (let i = 0; i < updates.length; i += 100) {
    const batch = updates.slice(i, i + 100);
    const data = await gql(MUT, { productId, variants: batch });
    const errs = data.productVariantsBulkUpdate.userErrors;
    if (errs.length) console.error('  ! Update errors:', JSON.stringify(errs));
  }
}

// --- main -------------------------------------------------------------
(async () => {
  console.log(DRY_RUN ? '== DRY RUN (no changes written) ==' : '== LIVE SYNC ==');
  const rates = await getRates();

  for (const handle of PRODUCT_HANDLES) {
    const p = await getProduct(handle);
    if (!p) { console.warn(`\nSKIP: not found: ${handle}`); continue; }

    const markup = p.markup ? parseFloat(p.markup.value) : null;
    let weights = {};
    try { weights = p.weights ? JSON.parse(p.weights.value) : {}; } catch (e) { weights = {}; }

    console.log(`\n${p.title}`);
    if (markup == null) { console.warn('  ! No sjw.markup_multiplier set — skipping.'); continue; }
    if (!Object.keys(weights).length) { console.warn('  ! No sjw.metal_weights JSON set — skipping.'); continue; }

    const updates = [];
    for (const { node } of p.variants.edges) {
      const opts = {};
      node.selectedOptions.forEach((o) => (opts[o.name.toLowerCase()] = o.value));
      const metalVal = opts['metal type - color & purity'] || opts['metal'] || Object.values(opts)[0];
      const caratVal = opts['carat'] || Object.values(opts)[1];

      const karat = karatKey(metalVal || '');
      const carat = caratOf(caratVal || '');
      const alloyG = weights[metalVal];
      if (!karat)         { console.warn(`  ? karat? "${metalVal}" — skipped`); continue; }
      if (carat == null)  { console.warn(`  ? carat? "${caratVal}" — skipped`); continue; }
      if (alloyG == null) { console.warn(`  ? no weight for "${metalVal}" in metal_weights — skipped`); continue; }

      const usd = computeUsd(rates, alloyG, karat, carat, markup);
      if (usd == null) { console.warn(`  ? missing rate for ${metalVal}/${carat}ct — skipped`); continue; }
      updates.push({ id: node.id, price: usd.toFixed(2) });
      console.log(`  ${metalVal} / ${carat}ct  ->  $${usd.toFixed(2)}`);
    }

    if (!DRY_RUN && updates.length) {
      await updatePrices(p.id, updates);
      console.log(`  Updated ${updates.length} variants.`);
    } else {
      console.log(`  ${updates.length} variants computed (dry run — not written).`);
    }
  }
  console.log('\nDone.');
})();
