/**
 * File transfer: the staging area a caller's bytes land in before Chrome
 * is asked to attach them, and the filename sanitiser plus containment
 * check that decide what may become a path component.
 *
 * `upload-store.ts`'s own module doc explains why staging exists at all
 * (the file has to be on the machine running Chrome, which is not the
 * machine holding it); `safe-name.ts`'s explains the path safety argument
 * end to end.
 */

export * from './safe-name.js';
export * from './upload-store.js';
