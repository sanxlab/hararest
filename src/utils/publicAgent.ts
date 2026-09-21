import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import type { LookupFunction } from 'node:net';
import * as dns from 'dns/promises';
import { isSafeIP } from '../middlewares/ssrf.middleware';

// Validate the addresses actually used by the socket, including on DNS changes.
export const publicLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { all: true, verbatim: true }).then((addresses) => {
    if (!addresses.length || addresses.some(({ address }) => !isSafeIP(address))) {
      callback(new Error('Target resolves to a restricted IP address.'), []);
      return;
    }
    const candidates = options.family ? addresses.filter((item) => item.family === options.family) : addresses;
    if (!candidates.length) {
      callback(new Error('No public address for the requested IP family.'), []);
    } else if (options.all) {
      callback(null, candidates);
    } else {
      callback(null, candidates[0].address, candidates[0].family);
    }
  }, (error: Error) => callback(error, []));
};

const agentOptions = {
  lookup: publicLookup,
  keepAlive: true,
  maxSockets: 64,
  maxTotalSockets: 128,
  maxFreeSockets: 16,
  timeout: 15000,
};

export const publicHttpAgent = new HttpAgent(agentOptions);
export const publicHttpsAgent = new HttpsAgent(agentOptions);
