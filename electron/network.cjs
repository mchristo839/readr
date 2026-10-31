// Keeps links and webpages off this computer and the local network: the router, a NAS, a dev server, anything that
// trusts requests from inside. A webpage Readr turns into a PDF runs its own scripts, and a link can redirect anywhere.
const { BlockList, isIP } = require("node:net");

const LOCAL = new BlockList();
// "This" network, private networks, carrier-grade NAT (also Tailscale), loopback, link-local, multicast and reserved.
// (198.18.0.0/15 is left out: proxy tools hand out addresses from it for every site.)
for (const [address, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.168.0.0", 16], ["224.0.0.0", 3]]) LOCAL.addSubnet(address, prefix, "ipv4");
// Unspecified, loopback, unique local, link-local, multicast. IPv4-mapped addresses (::ffff:10.0.0.1) are checked as IPv4.
for (const [address, prefix] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]]) LOCAL.addSubnet(address, prefix, "ipv6");

const bare = (host) => host.replace(/^\[|\]$/g, "").toLowerCase();

/** Whether the IP address `address` is on this computer or a local network. */
function isLocalAddress(address) {
  const ip = bare(address);
  const version = isIP(ip);
  return version !== 0 && LOCAL.check(ip, version === 4 ? "ipv4" : "ipv6");
}

/**
 * Whether `hostname` is on this computer or a local network: written that way ("localhost", "nas.local", 192.168.1.1)
 * or a name that resolves there (127.0.0.1.nip.io). `resolver` is the session (or `net`) that would make the request.
 */
async function isLocalHost(hostname, resolver) {
  const host = bare(hostname);
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || isLocalAddress(host)) return true;
  if (isIP(host)) return false;
  try {
    return (await resolver.resolveHost(host)).endpoints.some((endpoint) => isLocalAddress(endpoint.address));
  } catch {
    return false; // can't be reached directly; through a proxy, it's the proxy's call
  }
}

/**
 * Lets `ses` make only web requests (and data:/blob: ones) and, unless `allowLocal`, none to this computer or the local
 * network. Each name is looked up before its request, and a response that comes from a local address anyway is refused:
 * a name can answer differently by the time Chromium connects (DNS rebinding). Returns a function that says whether a
 * request was refused for being local.
 */
function guardSession(ses, allowLocal) {
  let refused = false;
  const direct = new Set(); // requests that connect to the server itself rather than through a proxy
  ses.webRequest.onBeforeRequest((details, callback) => {
    let target;
    try { target = new URL(details.url); } catch { return callback({ cancel: true }); }
    if (target.protocol !== "http:" && target.protocol !== "https:") return callback({ cancel: target.protocol !== "data:" && target.protocol !== "blob:" });
    if (allowLocal) return callback({});
    Promise.all([isLocalHost(target.hostname, ses), ses.resolveProxy(details.url)]).then(([local, proxy]) => {
      if (proxy === "DIRECT") direct.add(details.id);
      else direct.delete(details.id);
      refused ||= local;
      callback({ cancel: local });
    }, () => callback({ cancel: true }));
  });
  if (!allowLocal) {
    ses.webRequest.onHeadersReceived((details, callback) => {
      // Through a proxy, the address is the proxy's.
      const local = direct.has(details.id) && !!details.ip && isLocalAddress(details.ip);
      refused ||= local;
      callback(local ? { cancel: true } : {});
    });
  }
  return () => refused;
}

module.exports = { guardSession, isLocalHost };
