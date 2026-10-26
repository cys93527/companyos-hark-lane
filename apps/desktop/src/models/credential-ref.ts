/**
 * Hark lane H15c — the ONE canonical credential reference for an env-held model key.
 *
 * The same operator credential was named two ways: the model profile / routing pool used
 * `vault://<ENV>/live`, while the embedded-kernel fallback admission binding used
 * `env:<ENV>`. The trusted budget compares credential references by exact identity, so
 * the real executor was refused (GOAL_ADMISSION_REFUSED, hark-live-goal 40263437730)
 * although it used the very credential the operator approved. Every producer of a
 * credential reference for an env-held key goes through this function.
 */
export const envCredentialRef = (apiKeyEnv: string): string => `vault://${apiKeyEnv}/live`;
