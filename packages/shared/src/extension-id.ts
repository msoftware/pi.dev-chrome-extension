/** Fixed extension identity (EXT-04): the manifest "key" yields this ID in dev and release builds. */
export const EXTENSION_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAsLYyq8vILkfP345QodzO9ecu/0grmVybFOuHN2PXMYmdXU8HumRvEDZ8aUFCdhfwIW3EJQ4BUvciZw/l38p7CguLG1vvTBxqUJ9HhrM/LfQq+ynkrwbqgtiFLCDaKICBclS+FKJ2J6NNKxucs3q5MA7jl+imJCOZVj7jHfaPerVf60727C/mHCpten0moT84u6jWLmPkZtMUK4q3Xn25AIMStEY+Bhp44sSuFqTYt8u/lgcB0VTKdO7UxBFG4BUF1FxkZbzficf4ZZUXZIH61YwBBs0beXvymYfQ8lbzg76ydr0XpBr2hpwi8+pcR5ACRJ8rMOWAquzJV1N3CyG1HwIDAQAB";
export const EXTENSION_ID = "omfoefeoobddgdfoichknkcidfoippih";

/**
 * IDs the Chrome Web Store assigned to published builds (they differ from the development ID because the store removes
 * the manifest "key"). After the first store upload, add the ID here (or users add it as "extensionIds" in
 * ~/.pi/agent/browser-bridge.json) so the bridge accepts that build. See publish.md.
 */
export const STORE_EXTENSION_IDS: string[] = [];

export const KNOWN_EXTENSION_IDS: string[] = [EXTENSION_ID, ...STORE_EXTENSION_IDS];
