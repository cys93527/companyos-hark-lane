// An environment flag is not approval to execute native scripts or to stop WSH
// processes. No native test can run before independently reviewed ownership,
// limits and shutdown controls are supplied under a separate Boss decision.
throw new Error('WINDOWS_SHELL_GATE_BLOCKED: explicit authorization and bounded native supervision not implemented');
export {};
