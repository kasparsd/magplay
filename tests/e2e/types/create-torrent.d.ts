// Only the local file/directory fixture API used by these tests; the dependency ships no types.
declare module 'create-torrent' {
  export default function createTorrent (
    input: string,
    options: { name: string, private: boolean, announceList: string[][], creationDate: number },
    callback: (error: Error | null, torrent: Uint8Array) => void
  ): void
}
