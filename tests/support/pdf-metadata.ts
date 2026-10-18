export function pdfMetadataTitle(bytes: Uint8Array | undefined): string | null {
  if (!bytes) return null;
  const text = Buffer.from(bytes).toString("latin1");
  return /<dc:title><rdf:Alt><rdf:li xml:lang="x-default">([^<]*)<\/rdf:li>/.exec(text)?.[1] ?? null;
}
