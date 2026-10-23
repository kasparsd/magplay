// Vite imports a file's text with ?raw; the vanilla pages' markup comes in this way until they are components.
declare module '*.html?raw' {
  const html: string
  export default html
}
