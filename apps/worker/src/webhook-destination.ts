import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { publicAddress } from "../../../packages/shared/src/security.js";

type ResolveAddresses = (hostname: string) => Promise<LookupAddress[]>;

export async function resolveWebhookDestination(
  url: URL,
  allowedHosts: readonly string[],
  resolve: ResolveAddresses = (hostname) => lookup(hostname, { all: true }),
): Promise<LookupAddress> {
  if (url.protocol !== "https:" || !allowedHosts.includes(url.hostname))
    throw Error("WEBHOOK_HOST_NOT_ALLOWED");

  const addresses = await resolve(url.hostname);
  if (!addresses.length || addresses.some(({ address }) => !publicAddress(address)))
    throw Error("WEBHOOK_PRIVATE_ADDRESS");

  return addresses[0];
}
