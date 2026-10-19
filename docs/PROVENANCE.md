# Project provenance

Causyne Agent is the renamed continuation of **Vanexa Agent**. It is not
presented as an unrelated project or as a way to bypass
security classification. Version 1.10.0 is the local source migration successor
to the 1.9.20 working tree. This does not assert a published release.

The previous npm identities were `@ikbal_fadilah_vanexa01/vanexa-agent` and
`@vanexalabs-ai/vanexa-agent`. The dispute at
[OpenSSF issue 1470](https://github.com/ossf/malicious-packages/issues/1470)
references MAL-2026-13364 and MAL-2026-13397. The issue remained open on
2026-10-19, but the advisory files have different current states:
MAL-2026-13397 is marked withdrawn and was moved to OpenSSF's `osv/withdrawn`
tree in merged pull request 1473; MAL-2026-13364 remained in `osv/malicious`.
Withdrawal of one record does not resolve the other. See
`docs/SECURITY_REVIEW.md` for package-specific evidence and links.

Historical remote-control sources, private operating documents, and unrelated
application code are excluded from this project. The repository begins with the
independent local CLI source rather than importing the unrelated application
history.

Current architecture changes do not prove historical packages harmless. A source
hash or a deterministic intermediate bundle also does not prove that an old
distributed V8 artifact is equivalent to source. Earlier reproducibility claims
must be checked against actual versioned artifacts before repeating them.

Do not republish old binaries as a Causyne release. Keep version-specific
evidence and clearly distinguish remediation from requests to correct history.
