# Integrations, build-versus-buy and cost-estimate inputs

Brief deliverables 6, 8 and 9. Vendor names are candidates to evaluate, not selections: pricing, licence status and current terms have **not** been checked and must be confirmed directly with each provider.

## 1. Recommended integrations

| Need | Approach | Candidates | What we evaluate |
|------|----------|------------|------------------|
| Collecting payments (card, transfer, USSD) | Two providers behind one internal interface, for failover | Paystack, Flutterwave, Interswitch | Lottery/gaming merchant acceptance, fees, settlement time, webhook reliability, refund API |
| Paying out winnings | Same providers' transfer APIs, with account-name lookup | As above | Name-enquiry accuracy, limits, failure handling |
| Identity (NIN/BVN, liveness, sanctions) | One primary, one fallback | Smile ID, Dojah, Prembly, VerifyMe | Match rates, cost per check, data-protection terms |
| SMS / OTP / WhatsApp | Primary plus fallback route | Termii, Africa's Talking | Delivery rates on Nigerian networks, sender-ID registration |
| Email and push | Commodity services | Cloud email service; Firebase Cloud Messaging | Deliverability |
| Draw randomness | Public beacon, or certified RNG if mandated | drand | Regulator acceptance |
| Game certification | Accredited test lab | To shortlist with counsel | Acceptance by the Niger State authority |
| Penetration test | Independent security firm | To shortlist | Gaming/fintech experience |
| Merchandise delivery | Logistics partners, tracked in our fulfilment module | Regional carriers | Coverage in Niger State, proof of delivery, insurance for high-value items |
| Cloud hosting | Regional cloud region with managed PostgreSQL, KMS/HSM, object storage with retention lock | To select | Latency to Nigeria, data-transfer terms, cost |

**Gaming merchant acceptance is the first thing to confirm** with payment providers: some restrict or separately approve lottery and gaming businesses and will ask for the licence.

## 2. Build internally versus license

| Build internally (our IP) | License or outsource |
|---------------------------|----------------------|
| Game engine, commitments, draw, verifier | Payment processing and transfers |
| Cycle management and approvals | Identity, liveness and sanctions checks |
| Ledger, reconciliation, financial reports | SMS, WhatsApp, email, push delivery |
| Player web app and admin dashboard | RNG/game certification and penetration testing |
| Merchandise inventory and fulfilment tracking | Physical delivery |
| Responsible-gaming and fraud rules | Cloud infrastructure, KMS/HSM |

## 3. Effort estimate (drives the development cost)

Based on the team in the implementation plan. Person-weeks are working estimates, ±30% at this stage.

| Phase | Calendar | Backend | Frontend | Design | QA | DevOps/Sec | Product/PM | Total person-weeks |
|-------|----------|---------|----------|--------|----|------------|------------|--------------------|
| 1. System design | 4 weeks | 4 | 2 | 4 | 1 | 2 | 4 | 17 |
| 2. Minimum viable platform | 12 weeks | 24 | 24 | 8 | 10 | 6 | 12 | 84 |
| 3. Security and certification | 10 weeks | 14 | 8 | 2 | 10 | 8 | 10 | 52 |
| 4. Controlled launch | 4 weeks | 6 | 4 | 1 | 4 | 3 | 4 | 22 |
| **To first live cycle** | **30 weeks** | **48** | **38** | **15** | **25** | **19** | **30** | **175** |

Development cost = person-weeks × the rates management agrees for in-house staff and contractors.

## 4. Cost lines to be priced

| Line | Type | Basis | Status |
|------|------|-------|--------|
| Development team | One-off (to launch), then ongoing at reduced size | Section 3 × rates | Needs rates |
| Cloud hosting (production + staging) | Monthly | Managed database with standby, 2–3 application instances, cache, object storage, CDN/WAF, KMS | Needs provider quote |
| Payment collection fees | Per transaction | Percentage and/or flat fee per ticket purchase; matters a lot at ₦200–₦500 per ticket | Needs provider quote |
| Payout transfer fees | Per payout | Flat fee per transfer; affects the minimum withdrawal amount | Needs provider quote |
| Identity checks | Per verification | NIN/BVN lookup, liveness, sanctions | Needs provider quote |
| SMS / WhatsApp | Per message | OTPs, win and draw notifications | Needs provider quote |
| Game/RNG certification | One-off, then per major change | Test-lab fee | Needs quote |
| Penetration test | Per release cycle (at least annually) | Security firm fee | Needs quote |
| Licence fees and regulatory levies | Per licence terms | Niger State authority | Needs counsel |
| Independent auditor | Per cycle or retainer | Appointed by the Company | Needs appointment |
| Escrow / trust arrangement | Set-up and ongoing | Bank or trustee fees | Needs quote |
| Legal and data-protection compliance | One-off and ongoing | Counsel, DPIA, registration | Needs counsel |
| Maintenance and support after launch | Monthly | Suggested 2–3 engineers plus support staff | Needs decision |

**Unit economics to model early:** with a ₦200 ticket, a flat per-transaction payment fee can consume a large share of the price. The purchase flow therefore encourages buying several cards in one payment, and Finance should model fees per order rather than per ticket.

## 5. What is needed to turn this into a budget

1. Day or monthly rates for in-house staff and contractors.
2. Quotes from two payment providers, one identity provider and one messaging provider (sandbox accounts opened at the same time).
3. Choice of cloud provider and region.
4. Fee schedules from the licensing authority, a test lab and a penetration-testing firm.
