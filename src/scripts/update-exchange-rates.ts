import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { convertToGbp, refreshExchangeRates } from "../config/exchange-rates.js";

// The runtime copy lives in dist/config and is rebuilt on every deploy, so the
// refreshed rates are also written back to the committed source file. Commit
// that file to keep CI runs from re-fetching rates on every execution.
const SOURCE_RATES_FILE = join(process.cwd(), "src", "config", "exchange-rates.json");

/**
 * Force-update exchange rates and display current rates
 */
async function main() {
  console.log("=== Exchange Rates Updater ===\n");

  const rates = await refreshExchangeRates();

  await writeFile(SOURCE_RATES_FILE, `${JSON.stringify(rates, null, 2)}\n`, "utf-8");
  console.log(`Wrote refreshed rates back to ${SOURCE_RATES_FILE}`);

  console.log("\n=== Current Exchange Rates ===");
  console.log(`Base: ${rates.base}`);
  console.log(`Last Updated: ${rates.lastUpdated}`);
  console.log("\nRates (to GBP):");

  const sortedCurrencies = Object.keys(rates.rates).sort();
  for (const currency of sortedCurrencies) {
    const rate = rates.rates[currency];
    console.log(`  ${currency}: ${rate.toFixed(4)}`);
  }

  // Example conversions
  console.log("\n=== Example Conversions ===");
  const examples = [
    { amount: 1000, currency: "USD" },
    { amount: 1000, currency: "EUR" },
    { amount: 1000, currency: "JPY" },
  ];

  for (const { amount, currency } of examples) {
    try {
      const gbp = convertToGbp(amount, currency, rates);
      console.log(`  ${amount} ${currency} = £${gbp.toFixed(2)}`);
    } catch (error) {
      console.log(`  ${amount} ${currency} = Error: ${error}`);
    }
  }

  console.log("\n✅ Rates updated successfully — remember to commit src/config/exchange-rates.json");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
