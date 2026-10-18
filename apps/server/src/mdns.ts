// `.local` (mDNS) names in source URLs. Alpine's musl libc has no NSS, so nss-mdns can't help, and mDNS multicast
// doesn't cross Docker's bridge network anyway. When the host's avahi-daemon socket is mounted into the container
// (see compose.yml), `.local` lookups ask it instead; everything else, and any failed answer, uses the normal resolver.
import dns, { type LookupAddress, type LookupOptions } from 'node:dns'
import fs from 'node:fs'
import net from 'node:net'

export const AVAHI_SOCKET = '/run/avahi-daemon/socket'

type Callback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void
type Lookup = (hostname: string, options: number | LookupOptions | Callback, callback?: Callback) => void

const isLocal = (hostname: string): boolean => /\.local\.?$/i.test(hostname)

/** One address for `name` from avahi-daemon's line protocol (the one nss-mdns speaks). */
export function avahiResolve (socketPath: string, name: string, family: 4 | 6, timeoutMs = 2000): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath)
    let reply = ''
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error(`avahi-daemon didn't answer for ${name}`)))
    socket.on('connect', () => socket.write(`RESOLVE-HOSTNAME-IPV${family} ${name.replace(/\.$/, '')}\n`))
    socket.on('data', chunk => {
      reply += chunk.toString()
      const end = reply.indexOf('\n')
      if (end === -1) return
      socket.end()
      // `+ <interface> <protocol> <name> <address>` or `-<code> <message>`
      const [status, , , , address = ''] = reply.slice(0, end).split(' ')
      if (status === '+' && net.isIP(address) === family) resolve(address)
      else reject(new Error(`avahi-daemon: ${reply.slice(0, end)}`))
    })
    socket.on('error', reject)
  })
}

/** A `dns.lookup` that sends `.local` names to avahi-daemon and falls back to `fallback`. */
export function createLookup (socketPath: string, fallback: Lookup): Lookup {
  return (hostname, options, callback) => {
    const cb = (typeof options === 'function' ? options : callback) as Callback
    const opts: LookupOptions = typeof options === 'object' ? options : { family: typeof options === 'number' ? options : 0 }
    const viaFallback = (): void => { typeof options === 'function' ? fallback(hostname, cb) : fallback(hostname, options, cb) }
    if (!isLocal(hostname)) return viaFallback()
    const family = opts.family === 6 || opts.family === 'IPv6' ? 6 : 4
    avahiResolve(socketPath, hostname, family).then(
      address => opts.all ? cb(null, [{ address, family }]) : cb(null, address, family),
      viaFallback
    )
  }
}

/**
 * Routes `.local` lookups through avahi-daemon when its socket is there. Node's `net` (and so `fetch`) reads
 * `dns.lookup` on every connection, so replacing it covers every outgoing request. Returns an undo function.
 */
export function installMdnsLookup (socketPath = AVAHI_SOCKET): (() => void) | null {
  if (!fs.existsSync(socketPath)) return null
  const original = dns.lookup
  dns.lookup = createLookup(socketPath, original as Lookup) as typeof dns.lookup
  return () => { dns.lookup = original }
}
