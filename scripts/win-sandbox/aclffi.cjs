/**
 * STAGE 5D — shared Win32 DACL primitive (SetEntriesInAclW) with read-back
 * verification. icacls is banned as a WRITE primitive (it silently mangles
 * out-of-range subauthorities, skips propagation on large trees, and /remove
 * fails with ERROR_NONE_MAPPED/ERROR_INVALID_SID leaving widened ACLs) but
 * its READ output is fine — verification lists ACEs through it.
 * Both sandbox labs (lowbox, identity) consume this.
 */
const {execFileSync} = require('node:child_process');
const koffi = require('./koffi-loader.cjs');
const advapi32 = koffi.load('advapi32.dll');
const kernel32 = koffi.load('kernel32.dll');

const EXPLICIT_ACCESSW = koffi.struct('SBExplicitAccessW', {
  grfAccessPermissions: 'uint32', grfAccessMode: 'uint32', grfInheritance: 'uint32',
  Trustee: koffi.struct('SBTrusteeW', {
    pMultipleTrustee: 'void *', MultipleTrusteeOperation: 'uint32', TrusteeForm: 'uint32', TrusteeType: 'uint32', ptstrName: 'void *',
  }),
});

const getNamedSecurityInfo = advapi32.func('uint32 __stdcall GetNamedSecurityInfoW(str16 p, uint32 t, uint32 i, void *a, void *b, _Out_ void **d, void *c, _Out_ void **sd)');
const setNamedSecurityInfo = advapi32.func('uint32 __stdcall SetNamedSecurityInfoW(str16 p, uint32 t, uint32 i, void *a, void *b, void *d, void *c)');
const setEntriesInAcl = advapi32.func('uint32 __stdcall SetEntriesInAclW(uint32 n, void *e, void *old, _Out_ void **nw)');
const convertStringSid = advapi32.func('int __stdcall ConvertStringSidToSidW(str16 s, _Out_ void **sid)');
const localFree = kernel32.func('void * __stdcall LocalFree(void *m)');

const SE_FILE_OBJECT = 1;
const DACL_SEC_INFO = 4;
const GRANT_ACCESS = 1;
const REVOKE_ACCESS = 4;
const TRUSTEE_IS_SID = 0;
const INHERIT_CHILDREN = 3;
const FILE_ALL = 0x1F01FF;
const FILE_RX = 0x120089 | 0x1200A0;

/** ACE SIDs listed on a path (icacls READ output — writes stay on the FFI path). */
const daclSidsOf = (path) => {
  const out = execFileSync('icacls', [path], {encoding: 'utf8', timeout: 30_000});
  return [...out.matchAll(/(S-1-5-21-\d+(?:-\d+)+|S-1-15-2-\d+(?:-\d+)+|S-1-4-\d+(?:-\d+)+|S-1-1-0|S-1-5-32-\d+|S-1-5-18|S-1-5-19|S-1-5-20)/g)].map((m) => m[1]);
};

/**
 * Grant/revoke a SID's ACE on one path, then READ-BACK VERIFY the DACL
 * (grant: SID listed; revoke: SID gone). Throws on any mismatch — callers
 * additionally verify a known child leaf for inheritance propagation.
 */
const setAceVerified = (path, sidStr, kind, permsLabel, alias) => {
  const perms = permsLabel === 'full' ? FILE_ALL : permsLabel === 'rx' ? FILE_RX : 0;
  const sidOut = [koffi.NULL];
  if (!convertStringSid(sidStr, sidOut)) throw new Error('ConvertStringSidToSidW failed');
  const entry = koffi.alloc(EXPLICIT_ACCESSW, 1);
  koffi.encode(entry, EXPLICIT_ACCESSW, {
    grfAccessPermissions: kind === 'grant' ? perms : 0,
    grfAccessMode: kind === 'grant' ? GRANT_ACCESS : REVOKE_ACCESS,
    grfInheritance: kind === 'grant' ? INHERIT_CHILDREN : 0,
    Trustee: {pMultipleTrustee: koffi.NULL, MultipleTrusteeOperation: 0, TrusteeForm: TRUSTEE_IS_SID, TrusteeType: 0, ptstrName: sidOut[0]},
  });
  const oldDacl = [koffi.NULL];
  const secDesc = [koffi.NULL];
  const getErr = getNamedSecurityInfo(path, SE_FILE_OBJECT, DACL_SEC_INFO, koffi.NULL, koffi.NULL, oldDacl, koffi.NULL, secDesc);
  if (getErr !== 0) throw new Error(`GetNamedSecurityInfoW(${path}) err=${getErr}`);
  const newDacl = [koffi.NULL];
  const setErr = setEntriesInAcl(1, entry, oldDacl[0], newDacl);
  if (setErr !== 0) {
    if (secDesc[0] !== koffi.NULL) localFree(secDesc[0]);
    throw new Error(`SetEntriesInAclW(${path}) err=${setErr}`);
  }
  const writeErr = setNamedSecurityInfo(path, SE_FILE_OBJECT, DACL_SEC_INFO, koffi.NULL, koffi.NULL, newDacl[0], koffi.NULL);
  if (newDacl[0] !== koffi.NULL) localFree(newDacl[0]);
  if (secDesc[0] !== koffi.NULL) localFree(secDesc[0]);
  if (writeErr !== 0) throw new Error(`SetNamedSecurityInfoW(${path}) err=${writeErr}`);
  // icacls renders the ACE as either the raw SID or the resolved account
  // name — the read-back must accept both spellings.
  const listing = execFileSync('icacls', [path], {encoding: 'utf8', timeout: 30_000});
  const present = listing.includes(sidStr) || (alias !== undefined && listing.includes(alias));
  if (kind === 'grant' && !present) throw new Error(`grant read-back FAILED: ${sidStr} not listed on ${path}`);
  if (kind === 'revoke' && present) throw new Error(`revoke read-back FAILED: ${sidStr} still listed on ${path}`);
};

module.exports = {setAceVerified, daclSidsOf, FILE_ALL, FILE_RX, koffi};
