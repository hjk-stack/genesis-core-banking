# GENESIS ArtOfCards — Card issuing and acquiring foundation

This release provides development-only internal services, **not operating card issuance or merchant acquiring**.

Included:
- Customer-linked applications for physical and virtual debit/prepaid cards (pending review only).
- Merchant acquiring applications and merchant category codes (pending review only).
- Unverified processor event reports: authorization, capture, refund, chargeback.
- Idempotent application and acquiring event identifiers.
- Input rejection of common sensitive card data fields and validation tests.
- Review-only SQL migration (not applied in App Service).

Excluded:
- PAN/CVV/PIN/key storage; card personalization; issuer processing; card tokenization; network authorization; clearing and settlement; real merchant transactions; network certificates; chargeback workflows; 3DS, SCA and fraud decisioning.

Security and operational prerequisites:
- PCI DSS scope review, segmentation and an approved card processor/tokenization provider; client-facing APIs must not accept card credentials.
- Issuer BIN sponsorship/network membership and appropriate processor interfaces.
- Acquirer/merchant onboarding, KYB/KYC, sanctions/AML, monitoring, chargeback handling, dispute evidence, and settlement/reconciliation controls.
- Strong authentication, role-based permissions, maker/checker approvals and independent audit.
- Signed provider webhook verification, replay protection, processor-event lifecycle semantics.
- Azure managed identity, least-privilege database access, approved migrations and secrets held only in managed secret storage.

This foundation does not expose public card processing endpoints and should not be mistaken for a PCI-compliant production card system.
