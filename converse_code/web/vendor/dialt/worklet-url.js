// AudioWorklet modules are not part of the ordinary JavaScript import graph. Most hosts can load
// the sibling of the SDK entry, while CDN-transformed entries can still expose the package source
// tree. Try the normal URL first and use that source-tree path only when the normal module fails.
export function defaultWorkletModuleUrls(primaryUrl, filename, moduleUrl = import.meta.url) {
  return [
    primaryUrl,
    new URL(`./src/${filename}`, moduleUrl),
  ];
}

export async function addWorkletModule(audioWorklet, primaryUrl, fallbackUrl = null) {
  try {
    await audioWorklet.addModule(primaryUrl);
  } catch (error) {
    if (!fallbackUrl || fallbackUrl.href === primaryUrl.href) throw error;
    await audioWorklet.addModule(fallbackUrl);
  }
}
