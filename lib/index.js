// dsh-orb package root. Mounted as its own row so the Loader ships the browser half (exports["./client"]);
// the Host behaviour lives in the subpath rows of cordis.patch.yml.
export const name = "dsh-orb";
/** Host plugin body: no Host-side behaviour for the root row. */
export function apply() {}
